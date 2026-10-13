import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesToBigInt, fieldToBytes } from './field.ts';
import type { NotePreimage } from './note.ts';

// Every note's contents are padded to the same size, so every ciphertext has the same size.
const VERSION = 1;
const PLAINTEXT_SIZE = 96;
const KEY_INFO = utf8ToBytes('calyptra-note-v1');
const NONCE_SIZE = 24;
/** ephemeral public key (32) + nonce (24) + sealed plaintext (96 + 16-byte tag). */
export const CIPHERTEXT_SIZE = 32 + NONCE_SIZE + PLAINTEXT_SIZE + 16;

export interface EncryptionKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function encryptionPublicKeyOf(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

function noteKey(shared: Uint8Array, ephemeralPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(ephemeralPub, 0);
  salt.set(recipientPub, 32);
  return hkdf(sha256, shared, salt, KEY_INFO, 32);
}

function encodeNote(note: NotePreimage): Uint8Array {
  const out = new Uint8Array(PLAINTEXT_SIZE);
  out[0] = VERSION;
  out.set(fieldToBytes(note.amount).slice(24), 1); // 8 bytes
  out.set(fieldToBytes(note.token).slice(12), 9); // 20 bytes
  out.set(fieldToBytes(note.salt), 29);
  out.set(fieldToBytes(note.ownerTag), 61);
  return out;
}

function decodeNote(bytes: Uint8Array): NotePreimage | null {
  if (bytes.length !== PLAINTEXT_SIZE || bytes[0] !== VERSION) return null;
  return {
    amount: bytesToBigInt(bytes.slice(1, 9)),
    token: bytesToBigInt(bytes.slice(9, 29)),
    salt: bytesToBigInt(bytes.slice(29, 61)),
    ownerTag: bytesToBigInt(bytes.slice(61, 93)),
  };
}

/** Encrypts a note's contents to its owner's encryption public key (X25519 + XChaCha20-Poly1305). */
export function encryptNote(recipientPub: Uint8Array, note: NotePreimage): Uint8Array {
  const ephemeralPriv = x25519.utils.randomSecretKey();
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const key = noteKey(x25519.getSharedSecret(ephemeralPriv, recipientPub), ephemeralPub, recipientPub);
  const nonce = new Uint8Array(NONCE_SIZE);
  crypto.getRandomValues(nonce);
  const sealed = xchacha20poly1305(key, nonce).encrypt(encodeNote(note));
  const out = new Uint8Array(CIPHERTEXT_SIZE);
  out.set(ephemeralPub, 0);
  out.set(nonce, 32);
  out.set(sealed, 32 + NONCE_SIZE);
  return out;
}

/** Trial decryption: returns the note if this ciphertext was meant for the key pair, otherwise null. */
export function decryptNote(keys: EncryptionKeyPair, ciphertext: Uint8Array): NotePreimage | null {
  if (ciphertext.length !== CIPHERTEXT_SIZE) return null;
  const ephemeralPub = ciphertext.slice(0, 32);
  const nonce = ciphertext.slice(32, 32 + NONCE_SIZE);
  try {
    const key = noteKey(x25519.getSharedSecret(keys.privateKey, ephemeralPub), ephemeralPub, keys.publicKey);
    return decodeNote(xchacha20poly1305(key, nonce).decrypt(ciphertext.slice(32 + NONCE_SIZE)));
  } catch {
    return null;
  }
}
