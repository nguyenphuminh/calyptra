import { bytesToHex, hexToBytes, type Hex } from 'viem';
import {
  channelTagOf,
  dummyInput,
  encryptNote,
  noteCommitment,
  paramsHashOf,
  payoutSaltOf,
  randomFieldElement,
  stateHashOf,
  verifyStateSignature,
  type ChannelParams,
  type ChannelState,
  type MerkleProof,
  type NotePreimage,
  type PublicKey,
  type SpendInput,
  type StateSignature,
} from '../../shared/protocol/index.ts';
import type { ShieldedAddress } from '../keys/index.ts';
import type { ChannelRecord } from './channel.schema.ts';

// Every rule about channel states, with no I/O: shared by ChannelService and DisputeService.

/** The submit-state circuit range-checks nonces to 128 bits. */
export const MAX_NONCE = (1n << 128n) - 1n;

/** A random nonce step between 1 and 2^32, so a nonce never reveals the number of payments. */
export function nonceStep(): bigint {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return BigInt(value[0] as number) + 1n;
}

/** A = 0 (the opener), B = 1 (the invitee). */
export type Side = 0 | 1;
export const sideOf = (r: Pick<ChannelRecord, 'role'>): Side => (r.role === 'A' ? 0 : 1);
export const balanceOf = (s: ChannelState, side: Side): bigint => (side === 0 ? s.balA : s.balB);
export const publicKeyOf = (r: ChannelRecord, side: Side): PublicKey => (side === 0 ? r.params.pkA : r.params.pkB);

/** A contribution note: owned by the channel, with the contributor's refund tag inside its channel tag. */
export function contributionNote(params: ChannelParams, token: bigint, c: { amount: bigint; salt: bigint }, refundTag: bigint): NotePreimage {
  return { amount: c.amount, token, ownerTag: channelTagOf(paramsHashOf(params), refundTag), salt: c.salt };
}

/** Each side's refund tag is also its payout tag: one fresh tag per side and channel. */
export const tagOf = (r: ChannelRecord, side: Side): bigint => (side === 0 ? r.state0.state.payoutA : r.state0.state.payoutB);

export function contributionsOf(r: ChannelRecord): [NotePreimage, NotePreimage | null] {
  return [
    contributionNote(r.params, r.token, r.contribA, tagOf(r, 0)),
    r.contribB ? contributionNote(r.params, r.token, r.contribB, tagOf(r, 1)) : null,
  ];
}

/** Commitments of both contributions, 0 for a side that contributes nothing. */
export function contributionCommitments(r: ChannelRecord): [bigint, bigint] {
  const [a, b] = contributionsOf(r);
  return [noteCommitment(a), b ? noteCommitment(b) : 0n];
}

/** State 0 lists only A's contribution; state 1 adds B's. A pays the closing fee in both. */
export function openingState(o: {
  contribs: readonly [bigint, bigint];
  amountA: bigint;
  amountB: bigint;
  tagA: bigint;
  tagB: bigint;
  closingFee: bigint;
  nonce: bigint;
}): ChannelState {
  return {
    contribs: o.contribs,
    balA: o.amountA - o.closingFee,
    balB: o.amountB,
    payoutA: o.tagA,
    payoutB: o.tagB,
    closingFee: o.closingFee,
    nonce: o.nonce,
    final: false,
  };
}

export const hashOf = (r: ChannelRecord, s: ChannelState): bigint => stateHashOf(paramsHashOf(r.params), s);
export const signedBy = (r: ChannelRecord, side: Side, s: ChannelState, sig: StateSignature): boolean =>
  verifyStateSignature(publicKeyOf(r, side), hashOf(r, s), sig);

/** The payout note a state gives one side when the channel closes with it (salt fixed by the state). */
export function payoutNote(r: ChannelRecord, s: ChannelState, side: Side): NotePreimage {
  return {
    amount: balanceOf(s, side),
    token: r.token,
    ownerTag: side === 0 ? s.payoutA : s.payoutB,
    salt: payoutSaltOf(r.params.channelSecret, hashOf(r, s), side),
  };
}

/** A fully signed state after state 0, compacted: contributions and payout tags never change after state 1. */
export type HistoryEntry = [balA: bigint, balB: bigint, closingFee: bigint, nonce: bigint, final: boolean];
export const historyEntry = (s: ChannelState): HistoryEntry => [s.balA, s.balB, s.closingFee, s.nonce, s.final];

export function stateFromEntry(r: ChannelRecord, [balA, balB, closingFee, nonce, final]: HistoryEntry): ChannelState {
  return { ...r.state0.state, contribs: contributionCommitments(r), balA, balB, closingFee, nonce, final };
}

/** Every state signed by both sides, oldest first. */
export function signedStates(r: ChannelRecord): ChannelState[] {
  const later = r.history.map((e) => stateFromEntry(r, e));
  return r.state0.sigA && r.state0.sigB ? [r.state0.state, ...later] : later;
}

/** Whether a state with this hash and nonce was signed by both sides (searching from the newest). */
export function holdsState(r: ChannelRecord, hash: bigint, nonce: bigint): boolean {
  for (let i = r.history.length - 1; i >= 0; i--) {
    const entry = r.history[i] as HistoryEntry;
    if (entry[3] < nonce) return false; // history nonces strictly increase
    if (entry[3] === nonce && hashOf(r, stateFromEntry(r, entry)) === hash) return true;
  }
  return false;
}

export interface Settlement {
  inputs: [SpendInput, SpendInput];
  outputs: [NotePreimage, NotePreimage, NotePreimage];
  ciphertexts: [Hex, Hex, Hex];
}

/**
 * The transfer that settles a channel with state `s` (cooperative close and finalize): the listed
 * contributions in, both payouts and the relayer's fee note (the state's closing fee) out.
 */
export function settlement(r: ChannelRecord, s: ChannelState, proofOf: (commitment: bigint) => MerkleProof, feeTo: ShieldedAddress): Settlement {
  const [noteA, noteB] = contributionsOf(r);
  const channelInput = (note: NotePreimage, side: Side): SpendInput => ({
    note,
    unlock: { kind: 'channel', refundTag: tagOf(r, side) },
    proof: proofOf(noteCommitment(note)),
  });
  const listsB = noteB !== null && s.contribs[1] !== 0n;
  const inputs: [SpendInput, SpendInput] = [channelInput(noteA, 0), listsB ? channelInput(noteB, 1) : dummyInput(r.token)];
  const fee: NotePreimage = { amount: s.closingFee, token: r.token, ownerTag: feeTo.ownerTag, salt: randomFieldElement() };
  const outputs: [NotePreimage, NotePreimage, NotePreimage] = [payoutNote(r, s, 0), payoutNote(r, s, 1), fee];
  const ciphertexts: [Hex, Hex, Hex] = [
    bytesToHex(encryptNote(hexToBytes(r.encPubA as Hex), outputs[0])),
    bytesToHex(encryptNote(hexToBytes(r.encPubB as Hex), outputs[1])),
    bytesToHex(encryptNote(feeTo.encryptionPublicKey, fee)),
  ];
  return { inputs, outputs, ciphertexts };
}

/**
 * Checks a proposed next state against the latest one: same contributions and payout tags, a
 * higher nonce, the same total, and a balance for `me` that does not go down.
 * Payments keep the closing fee; only a closing proposal may change it (its proposer absorbs it).
 * Returns why the proposal is refused, or null.
 */
export function successorProblem(prev: ChannelState, next: ChannelState, kind: 'pay' | 'close', me: Side): string | null {
  if (prev.final) return 'The channel is already closing';
  if (next.contribs[0] !== prev.contribs[0] || next.contribs[1] !== prev.contribs[1]) return 'The contributions changed';
  if (next.payoutA !== prev.payoutA || next.payoutB !== prev.payoutB) return 'The payout tags changed';
  if (next.nonce <= prev.nonce || next.nonce > MAX_NONCE) return 'The nonce does not increase';
  if (next.final !== (kind === 'close')) return 'Only a closing proposal may be final';
  if (kind === 'pay' && next.closingFee !== prev.closingFee) return 'A payment cannot change the closing fee';
  if (next.balA + next.balB + next.closingFee !== prev.balA + prev.balB + prev.closingFee) return 'The total does not match the contributions';
  if (balanceOf(next, me) < balanceOf(prev, me)) return 'The proposal lowers this side’s balance';
  return null;
}

export interface Rival {
  nonce: bigint;
  proposer: PublicKey;
}

/**
 * When both sides propose on the same state, the proposal with the higher nonce wins.
 * A higher nonce is also what wins a dispute, so the losing proposal can never beat the agreed
 * state, even if someone countersigns it later. Equal nonces: the smaller channel key wins.
 */
export function winsTieBreak(mine: Rival, theirs: Rival): boolean {
  if (mine.nonce !== theirs.nonce) return mine.nonce > theirs.nonce;
  const [a, b] = [mine.proposer, theirs.proposer];
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}
