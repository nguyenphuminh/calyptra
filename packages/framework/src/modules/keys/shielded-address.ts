import { concat, hexToBytes, keccak256, toHex, type Hex } from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import { bytesToBigInt, fieldToBytes } from '../../shared/protocol/index.ts';
import type { PoolKeys } from './pool-keys.ts';

/** Where private payments go: the owner tag of the notes and the key their contents are encrypted to. */
export interface ShieldedAddress { ownerTag: bigint; encryptionPublicKey: Uint8Array }

/** "cal" + hex(ownerTag, 32 bytes) + hex(encryption public key, 32 bytes) + 4-byte keccak checksum. */
export function encodeShieldedAddress(address: ShieldedAddress): string {
  const body = concat([toHex(fieldToBytes(address.ownerTag)), toHex(address.encryptionPublicKey)]);
  return `cal${body.slice(2)}${keccak256(body).slice(2, 10)}`;
}

export function decodeShieldedAddress(text: string): ShieldedAddress {
  const value = text.trim();
  if (!/^cal[0-9a-f]{136}$/.test(value)) throw new AppError(400, 'INVALID_SHIELDED_ADDRESS', 'This is not a Calyptra shielded address');
  const body = `0x${value.slice(3, 131)}` as Hex;
  if (keccak256(body).slice(2, 10) !== value.slice(131)) {
    throw new AppError(400, 'INVALID_SHIELDED_ADDRESS', 'The shielded address has a typo (checksum mismatch)');
  }
  const bytes = hexToBytes(body);
  return { ownerTag: bytesToBigInt(bytes.slice(0, 32)), encryptionPublicKey: bytes.slice(32) };
}

export const shieldedAddressOf = (keys: PoolKeys): string =>
  encodeShieldedAddress({ ownerTag: keys.ownerTag, encryptionPublicKey: keys.encryption.publicKey });
