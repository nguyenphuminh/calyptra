import { CHANNEL_DOMAIN, CLOSE_DOMAIN } from './domains.ts';
import { hash2, hash3, hash6, hash10 } from './poseidon.ts';

export type PublicKey = readonly [bigint, bigint];

/** Channel parameters agreed off-chain (BRD 2.2.7). */
export interface ChannelParams {
  pkA: PublicKey;
  pkB: PublicKey;
  channelSecret: bigint;
  /** Dispute window in seconds. */
  window: bigint;
}

/** A channel state as both parties sign it (BRD 2.2.7 "Channel state"). Unused contribution slots are 0. */
export interface ChannelState {
  contribs: readonly [bigint, bigint];
  balA: bigint;
  balB: bigint;
  payoutA: bigint;
  payoutB: bigint;
  closingFee: bigint;
  nonce: bigint;
  final: boolean;
}

export function paramsHashOf(p: ChannelParams): bigint {
  return hash6([p.pkA[0], p.pkA[1], p.pkB[0], p.pkB[1], p.channelSecret, p.window]);
}

/** Owner slot of a contribution note: H(CHANNEL_DOMAIN, H(P), refundTag). */
export function channelTagOf(paramsHash: bigint, refundTag: bigint): bigint {
  return hash3(CHANNEL_DOMAIN, paramsHash, refundTag);
}

/** Channel nullifier, revealed only when a dispute starts. */
export function channelNullifierOf(channelSecret: bigint): bigint {
  return hash2(channelSecret, CLOSE_DOMAIN);
}

export function stateHashOf(paramsHash: bigint, s: ChannelState): bigint {
  return hash10([
    paramsHash,
    s.contribs[0],
    s.contribs[1],
    s.balA,
    s.balB,
    s.payoutA,
    s.payoutB,
    s.closingFee,
    s.nonce,
    s.final ? 1n : 0n,
  ]);
}

/**
 * Salt of a payout note when a channel closes. It is fixed by the state, so each party can always
 * rebuild its payout note even if the submitter encrypted its contents wrongly.
 */
export function payoutSaltOf(channelSecret: bigint, stateHash: bigint, side: 0 | 1): bigint {
  return hash3(channelSecret, stateHash, BigInt(side));
}
