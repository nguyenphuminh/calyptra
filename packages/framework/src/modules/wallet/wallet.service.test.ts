import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../storage/index.ts';
import { CONFIRMATION_WORDS, DEFAULT_NETWORK, WalletRepository, WalletService, passkeyVaultKey } from './index.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PHRASE = 'test test test test test test test test test test test junk';
const PASSWORD = 'correct horse';
const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const VAULT = 'calyptra.wallet';

function wallet(store = new MemoryStore()): { store: MemoryStore; wallet: WalletService } {
  return { store, wallet: new WalletService(new WalletRepository(store), FAST_KDF) };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (err) { return (err as { code?: string }).code ?? String(err); }
  throw new Error('expected a rejection');
}

const Counter = z.object({ n: z.number() });

describe('WalletService', () => {
  it('generates a 12-word phrase and checks three confirmation words', () => {
    const { wallet: w } = wallet();
    const phrase = w.generatePhrase();
    const words = phrase.split(' ');
    expect(words).toHaveLength(12);
    const positions = w.pickConfirmationWords();
    expect(positions).toHaveLength(CONFIRMATION_WORDS);
    expect(new Set(positions).size).toBe(3);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(positions.every((p) => p >= 0 && p < 12)).toBe(true);
    const answers = Object.fromEntries(positions.map((p) => [p, ` ${(words[p] as string).toUpperCase()} `]));
    expect(w.confirmWords(phrase, answers)).toBe(true);
    const wrong = { ...answers, [positions[0] as number]: 'wrong' };
    expect(w.confirmWords(phrase, wrong)).toBe(false);
    expect(w.confirmWords(phrase, { [positions[0] as number]: words[positions[0] as number] as string })).toBe(false);
  });

  it('derives the same addresses as other standard wallets, in the same order', async () => {
    const { wallet: w } = wallet();
    const first = await w.createFromPhrase(PHRASE, PASSWORD);
    expect(first.address).toBe(ACCOUNT_0);
    expect(first.id).toBe(ACCOUNT_0);
    expect(first.label).toBe('Account 1');
    const second = await w.addAccount();
    expect(second.address).toBe(ACCOUNT_1);
    expect(second.label).toBe('Account 2');
    expect(w.signer(first.id).address).toBe(ACCOUNT_0);
    expect(w.signer(second.id).address).toBe(ACCOUNT_1);
  });

  it('rejects a short password, an invalid phrase and an invalid key, and stores nothing', async () => {
    const { store, wallet: w } = wallet();
    expect(await code(w.createFromPhrase(PHRASE, 'short'))).toBe('WEAK_PASSWORD');
    expect(await code(w.createFromPhrase('not a valid phrase at all', PASSWORD))).toBe('INVALID_PHRASE');
    expect(await code(w.importPrivateKey('0x1234', PASSWORD))).toBe('INVALID_PRIVATE_KEY');
    expect(await store.get(VAULT)).toBeNull();
    expect(await w.exists()).toBe(false);
  });

  it('stores nothing unencrypted, locks, and refuses a wrong password', async () => {
    const { store, wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, PASSWORD);
    const stored = (await store.get(VAULT)) as string;
    expect(stored).toContain('calyptra-wallet');
    expect(stored).not.toContain('junk');
    expect(stored.toLowerCase()).not.toContain(ACCOUNT_0.slice(2).toLowerCase());
    expect(JSON.parse(stored)).toMatchObject({ format: 'calyptra-wallet', version: 1, unlock: 'password', kdf: { name: 'scrypt' } });
    w.lock();
    expect(w.isUnlocked).toBe(false);
    expect(() => w.signer()).toThrow(/locked/);
    expect(await code(w.unlock('wrong password'))).toBe('WRONG_PASSWORD');
    await w.unlock(PASSWORD);
    expect(w.activeAccount().id).toBe(ACCOUNT_0);
  });

  it('handles key-only wallets', async () => {
    const { wallet: w } = wallet();
    const first = await w.importPrivateKey(KEY_1.slice(2), PASSWORD);   // without 0x
    expect(first).toMatchObject({ id: ACCOUNT_1, label: 'Imported 1', kind: 'imported' });
    expect(w.hasRecoveryPhrase()).toBe(false);
    expect(await code(w.addAccount())).toBe('NO_RECOVERY_PHRASE');
    const second = await w.importAccount(KEY_0);
    expect(second).toMatchObject({ id: ACCOUNT_0, label: 'Imported 2' });
    expect(await code(w.importAccount(KEY_0))).toBe('ACCOUNT_EXISTS');
    expect(w.signer(ACCOUNT_0).address).toBe(ACCOUNT_0);
    expect(w.accounts().every((a) => a.privateKey === undefined)).toBe(true);
    expect(JSON.stringify(w.accounts())).not.toContain(KEY_0.slice(2));
    expect(w.activeAccount().privateKey).toBeUndefined();
  });

  it('keeps sections apart per account and network', async () => {
    const { wallet: w } = wallet();
    const first = await w.createFromPhrase(PHRASE, PASSWORD);
    const second = await w.addAccount();
    await w.writeSection('counter', { n: 1 });
    await w.writeSection('counter', { n: 2 }, second.id);
    expect(w.readSection('counter', Counter)).toEqual({ n: 1 });
    expect(w.readSection('counter', Counter, second.id)).toEqual({ n: 2 });
    await w.setNetwork('other');
    expect(w.readSection('counter', Counter)).toBeUndefined();
    expect(w.readSection('counter', Counter, second.id)).toBeUndefined();
    await w.setNetwork(DEFAULT_NETWORK);
    expect(w.readSection('counter', Counter)).toEqual({ n: 1 });
    expect(w.readSection('counter', Counter, second.id)).toEqual({ n: 2 });
    expect(w.activeAccount().id).toBe(first.id);
  });

  it('starts a new wallet on the default network', async () => {
    const { wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, PASSWORD);
    expect(w.networkId()).toBe(DEFAULT_NETWORK);
    expect(DEFAULT_NETWORK).toBe('monad-testnet');
  });

  it('exports and imports the encrypted wallet file', async () => {
    const { wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, PASSWORD);
    await w.addAccount();
    await w.writeSection('counter', { n: 7 });
    const file = await w.exportFile();
    expect(typeof w.lastExportAt()).toBe('number');

    const { wallet: fresh } = wallet();
    expect(await code(fresh.importFile(file, 'wrong password'))).toBe('WRONG_PASSWORD');
    expect(await code(fresh.importFile('{"hello":1}', PASSWORD))).toBe('INVALID_WALLET_FILE');
    await fresh.importFile(file, PASSWORD);
    expect(fresh.accounts().map((a) => a.id)).toEqual([ACCOUNT_0, ACCOUNT_1]);
    expect(fresh.readSection('counter', Counter)).toEqual({ n: 7 });
    fresh.lock();
    await fresh.unlock(PASSWORD);
    expect(fresh.hasRecoveryPhrase()).toBe(true);
    expect(typeof fresh.lastExportAt()).toBe('number');
  });

  it('resets with the phrase and a new password', async () => {
    const { wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, PASSWORD);
    await w.addAccount();
    await w.writeSection('channels', [{ id: 'x' }]);
    w.lock();
    expect(await code(w.reset(PHRASE, 'short'))).toBe('WEAK_PASSWORD');
    expect(await w.exists()).toBe(true);                       // validated before anything is deleted
    const first = await w.reset(PHRASE, 'a new password');
    expect(first.id).toBe(ACCOUNT_0);
    expect(w.accounts()).toHaveLength(1);
    expect(w.readSection('channels', z.unknown())).toBeUndefined();
    w.lock();
    expect(await code(w.unlock(PASSWORD))).toBe('WRONG_PASSWORD');
    await w.unlock('a new password');
    expect(w.activeAccount().id).toBe(ACCOUNT_0);
  });

  it('marks an account used once', async () => {
    const { store, wallet: w } = wallet();
    const first = await w.createFromPhrase(PHRASE, PASSWORD);
    await w.markUsed(first.id);
    expect(w.activeAccount().used).toBe(true);
    const stored = await store.get(VAULT);
    await w.markUsed(first.id);
    expect(await store.get(VAULT)).toBe(stored);                // no re-save
    expect(await code(w.setActiveAccount('0x0000000000000000000000000000000000000001'))).toBe('NO_ACCOUNT');
  });
});

describe('WalletService with a passkey (§11.4)', () => {
  const prf = new Uint8Array(32).fill(7);

  it('derives the vault key from the PRF output with HKDF-SHA256', () => {
    const key = passkeyVaultKey(prf);
    expect(key).toHaveLength(32);
    expect(passkeyVaultKey(prf)).toEqual(key);
    expect(passkeyVaultKey(new Uint8Array(32).fill(8))).not.toEqual(key);
  });

  it('creates, locks and unlocks a vault with the raw key; the record says unlock: passkey', async () => {
    const { store, wallet: w } = wallet();
    expect(await w.unlockMethod()).toBeNull();
    const first = await w.createFromPhrase(PHRASE, passkeyVaultKey(prf));
    expect(first.id).toBe(ACCOUNT_0);
    const stored = JSON.parse((await store.get(VAULT)) as string) as Record<string, unknown>;
    expect(stored).toMatchObject({ format: 'calyptra-wallet', version: 1, unlock: 'passkey' });
    expect(stored.kdf).toBeUndefined();
    expect(await w.unlockMethod()).toBe('passkey');
    w.lock();
    expect(await code(w.unlock(passkeyVaultKey(new Uint8Array(32))))).toBe('WRONG_PASSKEY');
    expect(await code(w.unlock(PASSWORD))).toBe('UNLOCK_MISMATCH');
    expect(await code(w.unlock(new Uint8Array(16)))).toBe('INVALID_VAULT_KEY');
    await w.unlock(passkeyVaultKey(prf));
    expect(w.activeAccount().id).toBe(ACCOUNT_0);
  });

  it('a password vault reports unlock: password and refuses a raw key', async () => {
    const { wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, PASSWORD);
    expect(await w.unlockMethod()).toBe('password');
    w.lock();
    expect(await code(w.unlock(passkeyVaultKey(prf)))).toBe('UNLOCK_MISMATCH');
  });

  it('accepts a 24-word phrase (the passkey path derives one from the 32-byte PRF output)', async () => {
    const { wallet: w } = wallet();
    const phrase24 = `${'abandon '.repeat(23)}art`;
    const first = await w.createFromPhrase(phrase24, passkeyVaultKey(prf));
    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.hasRecoveryPhrase()).toBe(true);
  });

  it('exports a passkey wallet with an export password; restoring it gives a password wallet', async () => {
    const { store, wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, passkeyVaultKey(prf));
    await w.addAccount();
    await w.writeSection('counter', { n: 5 });
    expect(await code(w.exportFile())).toBe('WEAK_PASSWORD');
    expect(await code(w.exportFile('short'))).toBe('WEAK_PASSWORD');
    const file = await w.exportFile('export password');
    expect(JSON.parse(file)).toMatchObject({ format: 'calyptra-wallet', version: 1, unlock: 'password', kdf: { name: 'scrypt' } });
    expect(file).not.toContain('junk');
    expect(typeof w.lastExportAt()).toBe('number');
    expect(await w.unlockMethod()).toBe('passkey');                          // the stored vault still opens with the passkey
    expect(JSON.parse((await store.get(VAULT)) as string)).toMatchObject({ unlock: 'passkey' });

    const { store: freshStore, wallet: fresh } = wallet();
    expect(await code(fresh.importFile(file, 'wrong password'))).toBe('WRONG_PASSWORD');
    await fresh.importFile(file, 'export password');
    expect(fresh.accounts().map((a) => a.id)).toEqual([ACCOUNT_0, ACCOUNT_1]);
    expect(fresh.readSection('counter', Counter)).toEqual({ n: 5 });
    expect(await fresh.unlockMethod()).toBe('password');
    expect(JSON.parse((await freshStore.get(VAULT)) as string)).toMatchObject({ unlock: 'password' });
    fresh.lock();
    await fresh.unlock('export password');
    expect(fresh.activeAccount().id).toBe(ACCOUNT_0);
    expect(fresh.hasRecoveryPhrase()).toBe(true);
  });

  it('exports a password wallet with its own password only', async () => {
    const { store, wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, PASSWORD);
    expect(await code(w.exportFile('another password'))).toBe('WRONG_PASSWORD');
    const file = await w.exportFile(PASSWORD);
    expect(file).toBe(await store.get(VAULT));                               // the export file is the stored envelope
    expect(await w.exportFile()).toBe(await store.get(VAULT));
  });

  it('opens envelopes written without an unlock field as password vaults', async () => {
    const { store, wallet: w } = wallet();
    await w.createFromPhrase(PHRASE, PASSWORD);
    const { unlock: _unlock, ...baseline } = JSON.parse((await store.get(VAULT)) as string) as Record<string, unknown>;
    await store.set(VAULT, JSON.stringify(baseline));
    w.lock();
    expect(await w.unlockMethod()).toBe('password');
    await w.unlock(PASSWORD);
    expect(w.activeAccount().id).toBe(ACCOUNT_0);
  });
});
