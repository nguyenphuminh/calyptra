import { bytesToHex, hexToBigInt, type Hex } from 'viem';

/** Order of the BN254 scalar field: every value inside a proof lives below it. */
export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Amounts are 64-bit inside the proofs (every amount is between 0 and 2^64). */
export const AMOUNT_BITS = 64n;
export const MAX_AMOUNT = (1n << AMOUNT_BITS) - 1n;

/** Tokens are encoded as their 160-bit address; the native coin is the zero address. */
export const MAX_TOKEN = (1n << 160n) - 1n;

export function toField(value: bigint): bigint {
  const reduced = value % FIELD_SIZE;
  return reduced < 0n ? reduced + FIELD_SIZE : reduced;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : hexToBigInt(bytesToHex(bytes));
}

/** A uniformly random value below 2^248, which is always a valid field element. */
export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return bytesToBigInt(bytes);
}

export function fieldToHex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

export function fieldToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function assertField(value: bigint, name: string): void {
  if (value < 0n || value >= FIELD_SIZE) {
    throw new RangeError(`${name} is not a field element`);
  }
}
