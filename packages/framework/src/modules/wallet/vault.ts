import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { AppError } from '../../shared/errors/AppError.ts';
import { EnvelopeSchema, WalletDocumentSchema, type Envelope, type WalletDocument } from './wallet.schema.ts';

export interface KdfParams { N: number; r: number; p: number }

/** scrypt cost for real wallets (tests pass a cheaper one). */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

/** Opens a vault: a password (scrypt), or the raw 32-byte vault key of a passkey wallet (§11.4). */
export type VaultSecret = string | Uint8Array;

/** The key that seals the wallet document; kept in memory only, while unlocked. */
export type VaultKey =
  | { unlock: 'password'; key: Uint8Array; kdf: KdfParams; salt: Uint8Array }
  | { unlock: 'passkey'; key: Uint8Array };

const VAULT_KEY_SIZE = 32;

const random = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));

/** The vault key of a passkey wallet: HKDF-SHA256 over the passkey's PRF output (§11.4). */
export function passkeyVaultKey(prfOutput: Uint8Array): Uint8Array {
  return hkdf(sha256, prfOutput, utf8ToBytes('calyptra'), utf8ToBytes('calyptra/vault/v1'), VAULT_KEY_SIZE);
}

export async function deriveVaultKey(password: string, kdf: KdfParams = DEFAULT_KDF, salt = random(16)): Promise<VaultKey> {
  const key = await scryptAsync(utf8ToBytes(password), salt, { ...kdf, dkLen: VAULT_KEY_SIZE });
  return { unlock: 'password', key, kdf, salt };
}

/** Wraps a raw vault key (a passkey wallet's); anything but 32 bytes is refused. */
export function rawVaultKey(key: Uint8Array): VaultKey {
  if (key.length !== VAULT_KEY_SIZE) throw new AppError(400, 'INVALID_VAULT_KEY', 'The vault key must be 32 bytes');
  return { unlock: 'passkey', key: Uint8Array.from(key) };
}

/** Encrypts the whole document with a fresh nonce; the result is the stored envelope and the export file. */
export function seal(vaultKey: VaultKey, doc: WalletDocument): string {
  const nonce = random(24);
  const plaintext = utf8ToBytes(JSON.stringify(doc));
  const header = vaultKey.unlock === 'passkey'
    ? { format: 'calyptra-wallet', version: 1, unlock: 'passkey' }
    : { format: 'calyptra-wallet', version: 1, unlock: 'password',
        kdf: { name: 'scrypt', ...vaultKey.kdf, salt: `0x${bytesToHex(vaultKey.salt)}` } };
  return JSON.stringify({
    ...header,
    nonce: `0x${bytesToHex(nonce)}`,
    ciphertext: `0x${bytesToHex(xchacha20poly1305(vaultKey.key, nonce).encrypt(plaintext))}`,
  });
}

export function parseEnvelope(content: string): Envelope {
  try { return EnvelopeSchema.parse(JSON.parse(content)); }
  catch { throw new AppError(400, 'INVALID_WALLET_FILE', 'This is not a Calyptra wallet file'); }
}

/** Decrypts an envelope; a wrong password or passkey fails authentication (WRONG_PASSWORD / WRONG_PASSKEY). */
export async function open(content: string, secret: VaultSecret): Promise<{ doc: WalletDocument; vaultKey: VaultKey }> {
  const envelope = parseEnvelope(content);
  let vaultKey: VaultKey;
  if (envelope.unlock === 'passkey') {
    if (typeof secret === 'string') throw new AppError(400, 'UNLOCK_MISMATCH', 'This wallet unlocks with a passkey');
    vaultKey = rawVaultKey(secret);
  } else {
    if (typeof secret !== 'string') throw new AppError(400, 'UNLOCK_MISMATCH', 'This wallet unlocks with a password');
    const { name: _name, salt, ...kdf } = envelope.kdf;
    vaultKey = await deriveVaultKey(secret, kdf, hexToBytes(salt.slice(2)));
  }
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(vaultKey.key, hexToBytes(envelope.nonce.slice(2))).decrypt(hexToBytes(envelope.ciphertext.slice(2)));
  } catch {
    throw envelope.unlock === 'passkey'
      ? new AppError(401, 'WRONG_PASSKEY', 'This passkey does not unlock this wallet')
      : new AppError(401, 'WRONG_PASSWORD', 'Wrong password');
  }
  return { doc: WalletDocumentSchema.parse(JSON.parse(new TextDecoder().decode(plaintext))), vaultKey };
}

/** Which secret opens a stored envelope. */
export const unlockOf = (content: string): VaultKey['unlock'] => parseEnvelope(content).unlock;
