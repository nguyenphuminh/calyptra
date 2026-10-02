import { MAX_AMOUNT, MAX_TOKEN, assertField } from './field.ts';
import { hash1, hash2 } from './poseidon.ts';

/** The private contents of a note: amount, token (address as number, 0 = the native coin), owner tag and salt. */
export interface NotePreimage {
  amount: bigint;
  token: bigint;
  ownerTag: bigint;
  salt: bigint;
}

/** Packs amount and token into one field element: token * 2^64 + amount (both range-checked in the proofs). */
export function packAmountToken(amount: bigint, token: bigint): bigint {
  if (amount < 0n || amount > MAX_AMOUNT) throw new RangeError('amount must be between 0 and 2^64 - 1');
  if (token < 0n || token > MAX_TOKEN) throw new RangeError('token must be a 160-bit address');
  return (token << 64n) + amount;
}

/** What a depositor sends: H(ownerTag, salt). The contract hashes it with the amount it actually received. */
export function noteInner(ownerTag: bigint, salt: bigint): bigint {
  assertField(ownerTag, 'ownerTag');
  assertField(salt, 'salt');
  return hash2(ownerTag, salt);
}

export function noteCommitment(note: NotePreimage): bigint {
  return hash2(packAmountToken(note.amount, note.token), noteInner(note.ownerTag, note.salt));
}

export function ownerTagOf(secret: bigint): bigint {
  assertField(secret, 'secret');
  return hash1(secret);
}

/** Nullifier of a note: H(secret, commitment), where the secret is the spending secret or the channel secret. */
export function nullifierOf(secret: bigint, commitment: bigint): bigint {
  return hash2(secret, commitment);
}
