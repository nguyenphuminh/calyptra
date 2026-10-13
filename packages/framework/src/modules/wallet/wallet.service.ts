import { equalBytes } from '@noble/ciphers/utils.js';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { isHex, toHex, type Hex, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import { DEFAULT_KDF, deriveVaultKey, open, rawVaultKey, seal, unlockOf, type KdfParams, type VaultKey, type VaultSecret } from './vault.ts';
import type { WalletRepository } from './wallet.repository.ts';
import type { Account, WalletDocument } from './wallet.schema.ts';

/** Shorter passwords are rejected (WEAK_PASSWORD). */
export const MIN_PASSWORD_LENGTH = 8;
/** A new wallet starts on the built-in network. */
export const DEFAULT_NETWORK = 'monad-testnet';
/** Words of a new phrase the user must re-enter. */
export const CONFIRMATION_WORDS = 3;
/** Words of a generated phrase (128 bits of entropy). */
const PHRASE_WORDS = 12;

/** The standard EVM BIP-44 path, so other wallets derive the same addresses. */
const pathOf = (index: number): string => `m/44'/60'/0'/0/${index}`;

const locked = (): AppError => new AppError(423, 'WALLET_LOCKED', 'The wallet is locked');

function normalizePhrase(phrase: string): string {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(normalized, english)) throw new AppError(400, 'INVALID_PHRASE', 'This is not a valid recovery phrase');
  return normalized;
}

function normalizeKey(privateKey: string): Hex {
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!isHex(key) || key.length !== 66) throw new AppError(400, 'INVALID_PRIVATE_KEY', 'This is not a valid private key');
  return key;
}

function derivedKey(mnemonic: string, index: number): Hex {
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(pathOf(index)).privateKey;
  if (!key) throw new AppError(500, 'DERIVATION_FAILED', 'Could not derive the account');
  return toHex(key);
}

function derivedAccount(mnemonic: string, index: number): Account {
  const { address } = privateKeyToAccount(derivedKey(mnemonic, index));
  return { id: address, label: `Account ${index + 1}`, kind: 'derived', index, address, used: false };
}

function importedAccount(privateKey: Hex, label: string): Account {
  const { address } = privateKeyToAccount(privateKey);
  return { id: address, label, kind: 'imported', privateKey, address, used: false };
}

/** Keys never leave the service. */
function publicAccount(account: Account): Account {
  const { privateKey: _privateKey, ...rest } = account;
  return rest;
}

/** A short password is refused (WEAK_PASSWORD), and a passkey's vault key must be 32 bytes. */
function checkSecret(secret: VaultSecret): void {
  if (typeof secret !== 'string') rawVaultKey(secret);
  else if (secret.length < MIN_PASSWORD_LENGTH) throw new AppError(400, 'WEAK_PASSWORD', 'The password needs at least 8 characters');
}

/** Turns a password (scrypt) or a passkey's raw vault key into the key that seals a new vault. */
async function vaultKeyFor(secret: VaultSecret, kdf: KdfParams): Promise<VaultKey> {
  checkSecret(secret);
  return typeof secret === 'string' ? deriveVaultKey(secret, kdf) : rawVaultKey(secret);
}

/**
 * The built-in wallet: recovery phrase or imported keys, accounts, the selected network, and the
 * encrypted vault that holds everything (including other modules' sections). The vault opens with a
 * password, or with the raw 32-byte key a passkey yields (`passkeyVaultKey(prfOutput)`).
 */
export class WalletService {
  private readonly repository: WalletRepository;
  private readonly kdf: KdfParams;
  private doc: WalletDocument | null = null;
  private vaultKey: VaultKey | null = null;

  constructor(repository: WalletRepository, kdf: KdfParams = DEFAULT_KDF) {
    this.repository = repository;
    this.kdf = kdf;
  }

  // --- creating / importing -------------------------------------------------------------------

  generatePhrase(): string {
    return generateMnemonic(english, 128);
  }

  /** Three distinct word positions of a new phrase, ascending, uniformly random (rejection sampling). */
  pickConfirmationWords(): number[] {
    const picked = new Set<number>();
    const byte = new Uint8Array(1);
    while (picked.size < CONFIRMATION_WORDS) {
      crypto.getRandomValues(byte);
      const value = byte[0] as number;
      if (value < 252) picked.add(value % PHRASE_WORDS);   // 252 = 21 x 12 keeps positions uniform
    }
    return [...picked].sort((a, b) => a - b);
  }

  confirmWords(phrase: string, answers: Record<number, string>): boolean {
    const words = phrase.trim().split(/\s+/);
    const entries = Object.entries(answers);
    return entries.length === CONFIRMATION_WORDS && entries.every(([i, word]) => words[Number(i)] === word.trim().toLowerCase());
  }

  async exists(): Promise<boolean> {
    return (await this.repository.load()) !== null;
  }

  /** What opens the stored vault: a password or a passkey; null when no wallet is stored. */
  async unlockMethod(): Promise<VaultKey['unlock'] | null> {
    const content = await this.repository.load();
    return content === null ? null : unlockOf(content);
  }

  /** Creates a wallet from a phrase (overwrites any stored wallet; hosts guard this). */
  async createFromPhrase(phrase: string, secret: VaultSecret): Promise<Account> {
    const mnemonic = normalizePhrase(phrase);
    return this.start(mnemonic, [derivedAccount(mnemonic, 0)], secret);
  }

  /** A key-only wallet with one imported account. */
  async importPrivateKey(privateKey: string, secret: VaultSecret): Promise<Account> {
    const account = importedAccount(normalizeKey(privateKey), 'Imported 1');
    return this.start(null, [account], secret);
  }

  /** Forgotten password: a new wallet from the phrase. Every section is dropped (notes come back with the next sync). */
  async reset(phrase: string, secret: VaultSecret): Promise<Account> {
    normalizePhrase(phrase);   // validate first: the stored wallet is deleted next
    checkSecret(secret);
    await this.repository.remove();
    this.lock();
    return this.createFromPhrase(phrase, secret);
  }

  private async start(mnemonic: string | null, accounts: Account[], secret: VaultSecret): Promise<Account> {
    const vaultKey = await vaultKeyFor(secret, this.kdf);
    const first = accounts[0] as Account;
    this.doc = { version: 1, mnemonic, accounts, activeAccountId: first.id, networkId: DEFAULT_NETWORK, lastExportAt: null, sections: {} };
    this.vaultKey = vaultKey;
    await this.persist();
    return publicAccount(first);
  }

  // --- unlock / lock ----------------------------------------------------------------------------

  async unlock(secret: VaultSecret): Promise<void> {
    const content = await this.repository.load();
    if (content === null) throw new AppError(404, 'NO_WALLET', 'No wallet exists yet');
    const { doc, vaultKey } = await open(content, secret);
    this.doc = doc;
    this.vaultKey = vaultKey;
  }

  /** A locked wallet signs nothing. */
  lock(): void {
    this.doc = null;
    this.vaultKey = null;
  }

  get isUnlocked(): boolean {
    return this.doc !== null;
  }

  // --- accounts ---------------------------------------------------------------------------------

  accounts(): Account[] {
    return this.unlocked().accounts.map(publicAccount);
  }

  activeAccount(): Account {
    const doc = this.unlocked();
    return publicAccount(this.find(doc, doc.activeAccountId));
  }

  hasRecoveryPhrase(): boolean {
    return this.unlocked().mnemonic !== null;
  }

  async addAccount(): Promise<Account> {
    const doc = this.unlocked();
    if (doc.mnemonic === null) {
      throw new AppError(409, 'NO_RECOVERY_PHRASE', 'This wallet has no recovery phrase; import another private key instead');
    }
    const next = Math.max(-1, ...doc.accounts.filter((a) => a.kind === 'derived').map((a) => a.index ?? -1)) + 1;
    const account = derivedAccount(doc.mnemonic, next);
    doc.accounts.push(account);
    await this.persist();
    return publicAccount(account);
  }

  async importAccount(privateKey: string): Promise<Account> {
    const doc = this.unlocked();
    const account = importedAccount(normalizeKey(privateKey), `Imported ${doc.accounts.length + 1}`);
    if (doc.accounts.some((a) => a.address === account.address)) {
      throw new AppError(409, 'ACCOUNT_EXISTS', 'This account is already in the wallet');
    }
    doc.accounts.push(account);
    await this.persist();
    return publicAccount(account);
  }

  async setActiveAccount(id: string): Promise<void> {
    const doc = this.unlocked();
    this.find(doc, id);
    doc.activeAccountId = id;
    await this.persist();
  }

  /** The account's local signer. Derived accounts are re-derived from the phrase on every call. */
  signer(accountId?: string): PrivateKeyAccount {
    const doc = this.unlocked();
    const account = this.find(doc, accountId ?? doc.activeAccountId);
    if (account.kind === 'imported' && account.privateKey) return privateKeyToAccount(account.privateKey as Hex);
    if (account.kind === 'derived' && doc.mnemonic !== null && account.index !== undefined) {
      return privateKeyToAccount(derivedKey(doc.mnemonic, account.index));
    }
    throw new AppError(500, 'DERIVATION_FAILED', 'Could not derive the account');
  }

  /** After a deposit: the account is linked to the pool and never offered as a fresh exit address. */
  async markUsed(accountId: string): Promise<void> {
    const account = this.find(this.unlocked(), accountId);
    if (account.used) return;
    account.used = true;
    await this.persist();
  }

  // --- networks ---------------------------------------------------------------------------------

  networkId(): string {
    return this.unlocked().networkId;
  }

  /** Not validated here; the facade checks the id on start(). */
  async setNetwork(networkId: string): Promise<void> {
    this.unlocked().networkId = networkId;
    await this.persist();
  }

  // --- export / import --------------------------------------------------------------------------

  /**
   * The export file, always opened with a password. A password wallet exports its stored envelope (its
   * wallet password opens it; a `password` given here must be that password). A passkey wallet has no
   * password, so the user chooses one for the file (`password`, at least 8 characters): the file is sealed
   * with it in the same password format, and restoring it (importFile) gives a password wallet.
   */
  async exportFile(password?: string): Promise<string> {
    const vaultKey = this.vaultKey;
    if (!vaultKey) throw locked();
    let fileKey: VaultKey | null = null;
    if (vaultKey.unlock === 'passkey') {
      checkSecret(password ?? '');
      fileKey = await deriveVaultKey(password ?? '', this.kdf);
    } else if (password !== undefined) {
      const given = await deriveVaultKey(password, vaultKey.kdf, vaultKey.salt);
      if (!equalBytes(given.key, vaultKey.key)) throw new AppError(401, 'WRONG_PASSWORD', 'Wrong password');
    }
    const doc = this.unlocked();
    doc.lastExportAt = Date.now();
    const file = fileKey ? seal(fileKey, doc) : null;
    const stored = await this.persist();
    return file ?? stored;
  }

  lastExportAt(): number | null {
    return this.unlocked().lastExportAt;
  }

  /** Restores an export file with its password: a password wallet (the file's salt and KDF parameters
   *  too) that overwrites the stored one. */
  async importFile(content: string, password: string): Promise<void> {
    const { doc, vaultKey } = await open(content, password);
    this.doc = doc;
    this.vaultKey = vaultKey;
    await this.persist();
  }

  // --- sections ---------------------------------------------------------------------------------

  /** Another module's data for an account on a network (defaults: the active account, the selected network). */
  readSection<T>(section: string, schema: z.ZodType<T>, accountId?: string, networkId?: string): T | undefined {
    const doc = this.unlocked();
    const value = doc.sections[this.sectionKey(doc, section, accountId, networkId)];
    return value === undefined ? undefined : schema.parse(value);
  }

  /** Assigns synchronously (before the first await), then persists: load-mutate-save stays atomic. */
  async writeSection(section: string, value: unknown, accountId?: string, networkId?: string): Promise<void> {
    const doc = this.unlocked();
    doc.sections[this.sectionKey(doc, section, accountId, networkId)] = value;
    await this.persist();
  }

  // --- internals --------------------------------------------------------------------------------

  private sectionKey(doc: WalletDocument, section: string, accountId?: string, networkId?: string): string {
    return `${accountId ?? doc.activeAccountId}/${networkId ?? doc.networkId}/${section}`;
  }

  private unlocked(): WalletDocument {
    if (!this.doc) throw locked();
    return this.doc;
  }

  private find(doc: WalletDocument, id: string): Account {
    const account = doc.accounts.find((a) => a.id === id);
    if (!account) throw new AppError(404, 'NO_ACCOUNT', 'No such account');
    return account;
  }

  /** Re-encrypts the whole document (fresh nonce) and stores it; returns the envelope. */
  private async persist(): Promise<string> {
    if (!this.doc || !this.vaultKey) throw locked();
    const envelope = seal(this.vaultKey, this.doc);
    await this.repository.save(envelope);
    return envelope;
  }
}
