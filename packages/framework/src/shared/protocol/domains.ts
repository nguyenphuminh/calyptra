import { keccak256, stringToBytes } from 'viem';
import { toField } from './field.ts';

const domain = (label: string): bigint => toField(BigInt(keccak256(stringToBytes(label))));

/** Separates channel tags from every other hash (circuits/src/lib/constants.circom holds the same values). */
export const CHANNEL_DOMAIN = domain('calyptra.channel.v1');
/** Channel nullifier label: H(channelSecret, CLOSE_DOMAIN) identifies a channel only during a dispute. */
export const CLOSE_DOMAIN = domain('calyptra.close.v1');
/** Wallet-side derivation of the fresh per-channel payout and refund secrets. */
export const PAYOUT_DOMAIN = domain('calyptra.payout.v1');
