import { concat, hexToBytes, keccak256, stringToHex, toHex, type Hex, type LocalAccount } from 'viem';
import {
  PAYOUT_DOMAIN, encryptionPublicKeyOf, hash3, ownerTagOf, toField, type EncryptionKeyPair,
} from '../../shared/protocol/index.ts';

/** The fixed message whose signature seeds an account's pool keys. */
export const POOL_KEY_MESSAGE = 'Calyptra pool keys v1\n\nThis signature derives your private Calyptra keys. Only Calyptra itself ever signs it.';

export interface PoolKeys {
  spendingSecret: bigint;            // proves ownership of notes and computes their nullifiers
  ownerTag: bigint;                  // Poseidon1(spendingSecret)
  encryption: EncryptionKeyPair;     // X25519 { privateKey: 32 bytes, publicKey: 32 bytes }
  seed: Hex;                         // seed for per-channel keys; never leaves the device
}

/** Derives an account's pool keys from its own signature of the fixed message. The wallet signs
 *  deterministically (RFC 6979), so the same account key always gives the same pool keys. */
export async function derivePoolKeys(account: LocalAccount): Promise<PoolKeys> {
  const signature = await account.signMessage({ message: POOL_KEY_MESSAGE });   // EIP-191 personal_sign, 65 bytes r||s||v
  const seed = keccak256(signature);                                             // keccak of the 65 signature bytes
  const spendingSecret = toField(BigInt(keccak256(concat([seed, stringToHex('spend')]))));
  const privateKey = hexToBytes(keccak256(concat([seed, stringToHex('encrypt')])));
  return {
    spendingSecret,
    ownerTag: ownerTagOf(spendingSecret),
    encryption: { privateKey, publicKey: encryptionPublicKeyOf(privateKey) },
    seed,
  };
}

/** Fresh per-channel material, derived from the account so it survives a reset. */
export interface ChannelSecrets {
  tagSecret: bigint;        // its owner tag is both the payout tag and the refund tag of this channel
  signingKey: Uint8Array;   // EdDSA (BabyJubJub) key that signs this channel's states (32 bytes)
}

export function channelSecrets(keys: PoolKeys, index: number): ChannelSecrets {
  return {
    tagSecret: hash3(PAYOUT_DOMAIN, keys.spendingSecret, BigInt(index)),
    signingKey: hexToBytes(keccak256(concat([keys.seed, stringToHex('channel'), toHex(index, { size: 4 })]))),   // uint32 big-endian index
  };
}
