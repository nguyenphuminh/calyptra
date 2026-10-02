import {
  channelNullifierOf,
  channelTagOf,
  paramsHashOf,
  stateHashOf,
  type ChannelParams,
  type ChannelState,
} from './channel.ts';
import type { StateSignature } from './eddsa.ts';
import { randomFieldElement } from './field.ts';
import { TREE_DEPTH, zeroValues, type MerkleProof } from './merkle.ts';
import { noteCommitment, nullifierOf, ownerTagOf, type NotePreimage } from './note.ts';

// Builds the private and public inputs of each circuit from structured values. The public signals
// come out in the order the circuits declare them, which is the order the pool contract verifies.

export type CircuitInput = Record<string, bigint | bigint[] | bigint[][]>;

export type Unlock = { kind: 'personal'; secret: bigint } | { kind: 'channel'; refundTag: bigint };

export interface SpendInput {
  note: NotePreimage;
  unlock: Unlock;
  /** Ignored for zero-amount dummy inputs, whose membership is not checked. */
  proof: MerkleProof;
}

export interface SignedState {
  params: ChannelParams;
  state: ChannelState;
  sigA: StateSignature;
  sigB: StateSignature;
}

export interface TransferWitnessInput {
  root: bigint;
  token: bigint;
  inputs: readonly [SpendInput, SpendInput];
  /** Two regular outputs and the relayer's fee note. */
  outputs: readonly [NotePreimage, NotePreimage, NotePreimage];
  publicAmount: bigint;
  extDataHash: bigint;
  /** Present when an input is unlocked through a channel (cooperative close). */
  channel?: SignedState;
}

export interface BuiltWitness {
  input: CircuitInput;
  publicSignals: bigint[];
  nullifiers: [bigint, bigint];
  commitments: [bigint, bigint, bigint];
}

const emptyPath = (): bigint[] => zeroValues(TREE_DEPTH).slice(0, TREE_DEPTH) as bigint[];

/** A zero-amount input that fills an unused slot; its random secret makes its nullifier unique. */
export function dummyInput(token: bigint): SpendInput {
  const secret = randomFieldElement();
  return {
    note: { amount: 0n, token, ownerTag: ownerTagOf(secret), salt: randomFieldElement() },
    unlock: { kind: 'personal', secret },
    proof: { leafIndex: 0, pathElements: emptyPath() },
  };
}

const NO_CHANNEL = {
  pk: [
    [0n, 0n],
    [0n, 0n],
  ],
  channelSecret: 0n,
  window: 0n,
  stateContribs: [0n, 0n],
  stateBal: [0n, 0n],
  statePayout: [0n, 0n],
  stateClosingFee: 0n,
  stateNonce: 0n,
  stateFinal: 0n,
  sigR8: [
    [0n, 0n],
    [0n, 0n],
  ],
  sigS: [0n, 0n],
};

function channelInputs(signed: SignedState | undefined): CircuitInput {
  if (!signed) return NO_CHANNEL;
  const { params: p, state: s, sigA, sigB } = signed;
  return {
    pk: [
      [p.pkA[0], p.pkA[1]],
      [p.pkB[0], p.pkB[1]],
    ],
    channelSecret: p.channelSecret,
    window: p.window,
    stateContribs: [s.contribs[0], s.contribs[1]],
    stateBal: [s.balA, s.balB],
    statePayout: [s.payoutA, s.payoutB],
    stateClosingFee: s.closingFee,
    stateNonce: s.nonce,
    stateFinal: s.final ? 1n : 0n,
    sigR8: [
      [sigA.R8x, sigA.R8y],
      [sigB.R8x, sigB.R8y],
    ],
    sigS: [sigA.S, sigB.S],
  };
}

function ownerOf(spend: SpendInput, paramsHash: bigint): bigint {
  return spend.unlock.kind === 'personal' ? ownerTagOf(spend.unlock.secret) : channelTagOf(paramsHash, spend.unlock.refundTag);
}

function spendSide(inputs: readonly [SpendInput, SpendInput], outputs: readonly NotePreimage[], channelSecret: bigint) {
  const nullifiers = inputs.map((spend) => {
    const secret = spend.unlock.kind === 'personal' ? spend.unlock.secret : channelSecret;
    return nullifierOf(secret, noteCommitment(spend.note));
  }) as [bigint, bigint];
  const commitments = outputs.map((o) => noteCommitment(o)) as [bigint, bigint, bigint];
  const input: CircuitInput = {
    inAmount: inputs.map((s) => s.note.amount),
    inSalt: inputs.map((s) => s.note.salt),
    inLeafIndex: inputs.map((s) => BigInt(s.proof.leafIndex)),
    inPathElements: inputs.map((s) => [...s.proof.pathElements]),
    inMode: inputs.map((s) => (s.unlock.kind === 'channel' ? 1n : 0n)),
    inSecret: inputs.map((s) => (s.unlock.kind === 'personal' ? s.unlock.secret : 0n)),
    inRefundTag: inputs.map((s) => (s.unlock.kind === 'channel' ? s.unlock.refundTag : 0n)),
    outAmount: outputs.map((o) => o.amount),
    outOwner: outputs.map((o) => o.ownerTag),
    outSalt: outputs.map((o) => o.salt),
  };
  return { input, nullifiers, commitments };
}

/** Transfer circuit: private transfer, withdrawal, channel funding, cooperative close. */
export function transferWitness(w: TransferWitnessInput): BuiltWitness {
  const channelSecret = w.channel?.params.channelSecret ?? 0n;
  const paramsHash = w.channel ? paramsHashOf(w.channel.params) : 0n;
  for (const spend of w.inputs) {
    if (spend.unlock.kind === 'channel' && !w.channel) throw new Error('channel unlock needs a signed state');
    if (ownerOf(spend, paramsHash) !== spend.note.ownerTag) throw new Error('input owner does not match its unlock');
  }
  const side = spendSide(w.inputs, w.outputs, channelSecret);
  const publicToken = w.publicAmount === 0n ? 0n : w.token;
  const input: CircuitInput = {
    root: w.root,
    publicAmount: w.publicAmount,
    publicToken,
    extDataHash: w.extDataHash,
    inNullifier: side.nullifiers,
    outCommitment: side.commitments,
    token: w.token,
    ...side.input,
    ...channelInputs(w.channel),
  };
  return {
    input,
    publicSignals: [w.root, w.publicAmount, publicToken, w.extDataHash, ...side.nullifiers, ...side.commitments],
    nullifiers: side.nullifiers,
    commitments: side.commitments,
  };
}

export interface FinalizeWitnessInput {
  root: bigint;
  token: bigint;
  inputs: readonly [SpendInput, SpendInput];
  outputs: readonly [NotePreimage, NotePreimage, NotePreimage];
  extDataHash: bigint;
  channel: SignedState;
}

/** Finalize circuit: settles the pending state of a dispute after its deadline. */
export function finalizeWitness(w: FinalizeWitnessInput): BuiltWitness {
  const paramsHash = paramsHashOf(w.channel.params);
  const stateHash = stateHashOf(paramsHash, w.channel.state);
  const channelNullifier = channelNullifierOf(w.channel.params.channelSecret);
  const side = spendSide(w.inputs, w.outputs, w.channel.params.channelSecret);
  const input: CircuitInput = {
    root: w.root,
    extDataHash: w.extDataHash,
    inNullifier: side.nullifiers,
    outCommitment: side.commitments,
    channelNullifier,
    stateHash,
    token: w.token,
    ...side.input,
    ...channelInputs(w.channel),
  };
  return {
    input,
    publicSignals: [w.root, w.extDataHash, ...side.nullifiers, ...side.commitments, channelNullifier, stateHash],
    nullifiers: side.nullifiers,
    commitments: side.commitments,
  };
}

export interface ReclaimWitnessInput {
  root: bigint;
  token: bigint;
  /** The contribution to reclaim and its position in the tree. */
  contribution: { note: NotePreimage; proof: MerkleProof };
  refundSecret: bigint;
  /** A personal note added to the transaction, or a dummy. */
  extra: SpendInput;
  params: ChannelParams;
  outputs: readonly [NotePreimage, NotePreimage, NotePreimage];
  extDataHash: bigint;
}

/** Reclaim circuit: returns a contribution the finalized state did not include. */
export function reclaimWitness(w: ReclaimWitnessInput): BuiltWitness {
  if (w.extra.unlock.kind !== 'personal') throw new Error('the second reclaim input must be a personal note');
  const channelSecret = w.params.channelSecret;
  const nullifiers: [bigint, bigint] = [
    nullifierOf(channelSecret, noteCommitment(w.contribution.note)),
    nullifierOf(w.extra.unlock.secret, noteCommitment(w.extra.note)),
  ];
  const commitments = w.outputs.map((o) => noteCommitment(o)) as [bigint, bigint, bigint];
  const channelNullifier = channelNullifierOf(channelSecret);
  const input: CircuitInput = {
    root: w.root,
    extDataHash: w.extDataHash,
    inNullifier: nullifiers,
    outCommitment: commitments,
    channelNullifier,
    token: w.token,
    inAmount: [w.contribution.note.amount, w.extra.note.amount],
    inSalt: [w.contribution.note.salt, w.extra.note.salt],
    inLeafIndex: [BigInt(w.contribution.proof.leafIndex), BigInt(w.extra.proof.leafIndex)],
    inPathElements: [[...w.contribution.proof.pathElements], [...w.extra.proof.pathElements]],
    refundSecret: w.refundSecret,
    personalSecret: w.extra.unlock.secret,
    pk: [
      [w.params.pkA[0], w.params.pkA[1]],
      [w.params.pkB[0], w.params.pkB[1]],
    ],
    channelSecret,
    window: w.params.window,
    outAmount: w.outputs.map((o) => o.amount),
    outOwner: w.outputs.map((o) => o.ownerTag),
    outSalt: w.outputs.map((o) => o.salt),
  };
  return {
    input,
    publicSignals: [w.root, w.extDataHash, ...nullifiers, ...commitments, channelNullifier],
    nullifiers,
    commitments,
  };
}

export interface SubmitStateWitnessInput {
  root: bigint;
  channel: SignedState;
  /** Tree positions of the listed contributions (ignored for empty slots). */
  contribProofs: readonly [MerkleProof, MerkleProof];
}

export interface SubmitStateWitness {
  input: CircuitInput;
  publicSignals: bigint[];
  channelNullifier: bigint;
  stateHash: bigint;
}

/** Submit-state circuit: starts or answers a dispute. */
export function submitStateWitness(w: SubmitStateWitnessInput): SubmitStateWitness {
  const { params, state } = w.channel;
  const stateHash = stateHashOf(paramsHashOf(params), state);
  const channelNullifier = channelNullifierOf(params.channelSecret);
  const ch = channelInputs(w.channel);
  const input: CircuitInput = {
    root: w.root,
    channelNullifier,
    nonce: state.nonce,
    stateHash,
    window: params.window,
    pk: ch.pk as bigint[][],
    channelSecret: params.channelSecret,
    stateContribs: ch.stateContribs as bigint[],
    stateBal: ch.stateBal as bigint[],
    statePayout: ch.statePayout as bigint[],
    stateClosingFee: state.closingFee,
    stateFinal: state.final ? 1n : 0n,
    sigR8: ch.sigR8 as bigint[][],
    sigS: ch.sigS as bigint[],
    contribLeafIndex: w.contribProofs.map((p) => BigInt(p.leafIndex)),
    contribPathElements: w.contribProofs.map((p) => [...p.pathElements]),
  };
  return {
    input,
    publicSignals: [w.root, channelNullifier, state.nonce, stateHash, params.window],
    channelNullifier,
    stateHash,
  };
}
