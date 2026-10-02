import { sha512 } from '@noble/hashes/sha2.js';
import { Base8, addPoint, inCurve, mulPointEscalar, subOrder, type Point } from '@zk-kit/baby-jubjub';
import { poseidon5 } from 'poseidon-lite/poseidon5';
import type { PublicKey } from './channel.ts';
import { bytesToBigInt, fieldToBytes } from './field.ts';

/**
 * EdDSA over BabyJubJub with Poseidon, as checked by circomlib's EdDSAPoseidonVerifier:
 * S * B8 == R8 + 8 * H(R8, A, M) * A. Used for the per-channel signing keys (BRD 2.2.7).
 */
export interface StateSignature {
  R8x: bigint;
  R8y: bigint;
  S: bigint;
}

export function generateChannelKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

function secretScalarOf(privateKey: Uint8Array): bigint {
  const scalar = bytesToBigInt(sha512(privateKey).slice(0, 32)) % subOrder;
  if (scalar === 0n) throw new RangeError('invalid channel key');
  return scalar;
}

export function channelPublicKeyOf(privateKey: Uint8Array): PublicKey {
  const [x, y] = mulPointEscalar(Base8, secretScalarOf(privateKey));
  return [x, y];
}

/** Deterministic signature: the nonce is derived from the key and the message, never reused across messages. */
export function signStateHash(privateKey: Uint8Array, stateHash: bigint): StateSignature {
  const k = secretScalarOf(privateKey);
  const [ax, ay] = mulPointEscalar(Base8, k);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(sha512(privateKey).slice(32), 0);
  nonceInput.set(fieldToBytes(stateHash), 32);
  const r = bytesToBigInt(sha512(nonceInput)) % subOrder;
  const [rx, ry] = mulPointEscalar(Base8, r);
  const h = poseidon5([rx, ry, ax, ay, stateHash]);
  return { R8x: rx, R8y: ry, S: (r + h * 8n * k) % subOrder };
}

export function verifyStateSignature(publicKey: PublicKey, stateHash: bigint, sig: StateSignature): boolean {
  const a: Point<bigint> = [publicKey[0], publicKey[1]];
  const r8: Point<bigint> = [sig.R8x, sig.R8y];
  if (sig.S < 0n || sig.S >= subOrder || !inCurve(a) || !inCurve(r8)) return false;
  const h = poseidon5([sig.R8x, sig.R8y, a[0], a[1], stateHash]);
  const left = mulPointEscalar(Base8, sig.S);
  const right = addPoint(r8, mulPointEscalar(a, 8n * h));
  return left[0] === right[0] && left[1] === right[1];
}
