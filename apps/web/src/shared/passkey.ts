// Passkey accounts with Mera. A passkey's WebAuthn PRF output (32 secret bytes) becomes the
// wallet's recovery phrase and the key of its encrypted vault, so there is no password to type.
//
// Mera lets the caller choose the PRF salt of each evaluation, so each key namespace
// gets its own evaluation: one salt for the phrase's entropy, another for the vault key. A phrase alone
// therefore never opens a stored vault, and the vault key alone never yields the phrase.
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError, type PasskeyCredentialMetadata } from '@category-labs/mera';
import { passkeyVaultKey } from '@calyptra/framework';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256, stringToBytes } from 'viem';
import { friendlyError } from './errors.ts';

/** Credential metadata (no key material) of this browser's passkey, so unlock asks for that passkey only. */
const CREDENTIAL_KEY = 'calyptra.credential';
const PHRASE_SALT = sha256(stringToBytes('calyptra/phrase/v1'), 'bytes');
const VAULT_SALT = sha256(stringToBytes('calyptra/vault/v1'), 'bytes');
const RP_NAME = 'Calyptra';

/** What a passkey yields: the 24-word recovery phrase and the vault key. */
export interface PasskeySecrets { mnemonic: string; vaultKey: Uint8Array }

const rpId = (): string => location.hostname;

function savedCredential(): PasskeyCredentialMetadata | undefined {
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as { credentialId?: unknown; transports?: unknown };
    if (typeof value.credentialId !== 'string') return undefined;
    const transports = Array.isArray(value.transports) ? value.transports.filter((t): t is string => typeof t === 'string') : undefined;
    return transports ? { credentialId: value.credentialId, transports } : { credentialId: value.credentialId };
  } catch {
    return undefined;
  }
}

function saveCredential(credential: PasskeyCredentialMetadata): void {
  try {
    localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ credentialId: credential.credentialId, transports: credential.transports ?? [] }));
  } catch {
    /* storage refused: unlock then lets the browser offer every passkey of this site */
  }
}

async function vaultKeyOf(credential: PasskeyCredentialMetadata | undefined): Promise<{ credentialId: string; vaultKey: Uint8Array }> {
  const { credentialId, prfOutput } = await getPasskeyPrfOutput({ rpId: rpId(), prfSalt: VAULT_SALT, ...(credential ? { credential } : {}) });
  return { credentialId, vaultKey: passkeyVaultKey(prfOutput) };
}

/** Creates a passkey and derives the new wallet's secrets from it (two prompts: one per key namespace). */
export async function createPasskeySecrets(name: string): Promise<PasskeySecrets> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: rpId(), name: RP_NAME },
    user: { name, displayName: name },
    prfSalt: PHRASE_SALT,
  });
  const credential: PasskeyCredentialMetadata = created.transports
    ? { credentialId: created.credentialId, transports: created.transports }
    : { credentialId: created.credentialId };
  saveCredential(credential);
  const mnemonic = entropyToMnemonic(created.prfOutput, wordlist);
  const { vaultKey } = await vaultKeyOf(credential);
  return { mnemonic, vaultKey };
}

/** Rebuilds the wallet's secrets from a passkey the user already has (a new device or browser). */
export async function restorePasskeySecrets(): Promise<PasskeySecrets> {
  const phrase = await getPasskeyPrfOutput({ rpId: rpId(), prfSalt: PHRASE_SALT });
  const credential = { credentialId: phrase.credentialId };
  saveCredential(credential);
  const { vaultKey } = await vaultKeyOf(credential);
  return { mnemonic: entropyToMnemonic(phrase.prfOutput, wordlist), vaultKey };
}

/** The vault key, from this browser's passkey (or any passkey of this site the user picks). */
export async function passkeyUnlockKey(): Promise<Uint8Array> {
  const { credentialId, vaultKey } = await vaultKeyOf(savedCredential());
  if (!savedCredential()) saveCredential({ credentialId });
  return vaultKey;
}

/** The recovery phrase of a passkey wallet, after the user confirms with the passkey again. */
export async function passkeyPhrase(): Promise<string> {
  const credential = savedCredential();
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: rpId(), prfSalt: PHRASE_SALT, ...(credential ? { credential } : {}) });
  return entropyToMnemonic(prfOutput, wordlist);
}

/** Asks the user to confirm with this browser's passkey (Face ID, Touch ID…), e.g. once per subscription. */
export async function confirmWithPasskey(): Promise<void> {
  await passkeyUnlockKey();
}

/** Whether the user cancelled (or let time out) the passkey prompt: the screen then goes back silently. */
export function isPasskeyCancelled(err: unknown): boolean {
  if (!isMeraError(err) || err.code !== 'PASSKEY_OPERATION_FAILED') return false;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'AbortError');
}

/** What to tell the user when a passkey cannot be used. */
export function passkeyErrorText(err: unknown): string {
  if (isMeraError(err) && err.code === 'PRF_UNAVAILABLE') {
    return "This passkey can't unlock Calyptra on this browser. Save it to iCloud Keychain, Google Password Manager or 1Password, or continue with a recovery phrase.";
  }
  if (isMeraError(err) && err.code === 'PASSKEY_OPERATION_FAILED') {
    return 'Passkeys are not available in this browser. Continue with a recovery phrase instead.';
  }
  return friendlyError(err);
}

/** Whether this browser can create passkeys at all (WebAuthn present). */
export const passkeysSupported = (): boolean => typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
