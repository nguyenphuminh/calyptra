import { groth16 } from 'snarkjs';
import { describe, expect, it } from 'vitest';
import {
  FIELD_SIZE,
  MAX_AMOUNT,
  dummyInput,
  generateChannelKey,
  hash1,
  noteCommitment,
  nullifierOf,
  transferWitness,
  type ChannelState,
  type CircuitInput,
  type SpendInput,
} from '@calyptra/framework/protocol';
import {
  forceOutput,
  forceOutputs,
  prove,
  publicSignalNames,
  rawCommitment,
  satisfies,
  scalar,
  vector,
  verificationKey,
  withAt,
} from './helpers.ts';
import { EXT, NATIVE, STABLE, TestChannel, World, note, person } from './world.ts';

/** Alice spends a 100 native-coin note and a dummy into 30 (Bob) / 69 (Alice) / 1 (relayer). */
function simpleTransfer() {
  const world = new World();
  const alice = person();
  const bob = person();
  const relayer = person();
  const spend = world.addPersonal(note(100n, NATIVE, alice.tag), alice);
  const w = transferWitness({
    root: world.root,
    token: NATIVE,
    inputs: [spend, dummyInput(NATIVE)],
    outputs: [note(30n, NATIVE, bob.tag), note(69n, NATIVE, alice.tag), note(1n, NATIVE, relayer.tag)],
    publicAmount: 0n,
    extDataHash: EXT,
  });
  return { world, alice, bob, relayer, spend, w };
}

/** Alice withdraws `publicAmount` of a 100 native note, keeping the rest. */
function nativeWithdrawal() {
  const world = new World();
  const alice = person();
  const relayer = person();
  const spend = world.addPersonal(note(100n, NATIVE, alice.tag), alice);
  return transferWitness({
    root: world.root,
    token: NATIVE,
    inputs: [spend, dummyInput(NATIVE)],
    outputs: [note(40n, NATIVE, alice.tag), note(0n, NATIVE, alice.tag), note(1n, NATIVE, relayer.tag)],
    publicAmount: 59n,
    extDataHash: EXT,
  });
}

interface CloseOverrides {
  state?: Partial<ChannelState>;
  keys?: { a?: Uint8Array; b?: Uint8Array };
}

/** Alice 60 / Bob 40 stablecoin contributions, closed with the final state 45 / 54, closing fee 1. */
function cooperativeClose(overrides: CloseOverrides = {}) {
  const world = new World();
  const ch = new TestChannel();
  const relayer = person();
  const contribA = world.addContribution(ch.contributionNote(60n, STABLE, 'A'), ch.alice.tag);
  const contribB = world.addContribution(ch.contributionNote(40n, STABLE, 'B'), ch.bob.tag);
  const cA = world.refresh(contribA);
  const state = ch.state({
    contribs: [noteCommitment(cA.note), noteCommitment(contribB.note)],
    balA: 45n,
    balB: 54n,
    closingFee: 1n,
    nonce: 9_123_456n,
    final: true,
    ...overrides.state,
  });
  const signed = ch.sign(state, overrides.keys);
  const w = transferWitness({
    root: world.root,
    token: STABLE,
    inputs: [cA, contribB],
    outputs: ch.closeOutputs(signed, STABLE, relayer.tag),
    publicAmount: 0n,
    extDataHash: EXT,
    channel: signed,
  });
  return { world, ch, relayer, cA, cB: contribB, signed, w };
}

/** Moves a whole input to another token and recomputes everything that depends on it. */
function retoken(input: CircuitInput, token: bigint): CircuitInput {
  let next: CircuitInput = { ...input, token };
  for (let i = 0; i < 2; i++) {
    const secret = vector(input, 'inSecret')[i] as bigint;
    const cm = rawCommitment(vector(input, 'inAmount')[i] as bigint, token, hash1(secret), vector(input, 'inSalt')[i] as bigint);
    next = withAt(next, 'inNullifier', i, nullifierOf(secret, cm));
  }
  for (let k = 0; k < 3; k++) next = forceOutput(next, k, {});
  return next;
}

describe('transfer circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('transfer')).toEqual([
      'root',
      'publicAmount',
      'publicToken',
      'extDataHash',
      'inNullifier[0]',
      'inNullifier[1]',
      'outCommitment[0]',
      'outCommitment[1]',
      'outCommitment[2]',
    ]);
  });

  it('accepts a private transfer with one real input and one dummy', async () => {
    expect(await satisfies('transfer', simpleTransfer().w.input)).toBe(true);
  });

  it('accepts two real inputs (70 + 50 -> 100 / 19 / 1)', async () => {
    const world = new World();
    const alice = person();
    const bob = person();
    const first = world.addPersonal(note(70n, NATIVE, alice.tag), alice);
    const second = world.addPersonal(note(50n, NATIVE, alice.tag), alice);
    const w = transferWitness({
      root: world.root,
      token: NATIVE,
      inputs: [world.refresh(first), second],
      outputs: [note(100n, NATIVE, bob.tag), note(19n, NATIVE, alice.tag), note(1n, NATIVE, person().tag)],
      publicAmount: 0n,
      extDataHash: EXT,
    });
    expect(await satisfies('transfer', w.input)).toBe(true);
  });

  it('accepts a withdrawal that reveals the token and the public amount (59 out, 40 / 0 / 1 notes)', async () => {
    const w = nativeWithdrawal();
    expect(w.publicSignals[1]).toBe(59n);
    expect(w.publicSignals[2]).toBe(NATIVE);
    expect(await satisfies('transfer', w.input)).toBe(true);
  });

  it('accepts a stablecoin withdrawal (1,000,000 -> 0 / 0 / 5 + publicAmount 999,995)', async () => {
    const world = new World();
    const alice = person();
    const spend = world.addPersonal(note(1_000_000n, STABLE, alice.tag), alice);
    const w = transferWitness({
      root: world.root,
      token: STABLE,
      inputs: [spend, dummyInput(STABLE)],
      outputs: [note(0n, STABLE, alice.tag), note(0n, STABLE, alice.tag), note(5n, STABLE, person().tag)],
      publicAmount: 999_995n,
      extDataHash: EXT,
    });
    expect(w.publicSignals[2]).toBe(STABLE);
    expect(await satisfies('transfer', w.input)).toBe(true);
  });

  it('accepts a cooperative close with both contributions', async () => {
    expect(await satisfies('transfer', cooperativeClose().w.input)).toBe(true);
  });

  it('accepts a cooperative close of a state listing only one contribution (60 -> 59 / 0 / fee 1, second input dummy)', async () => {
    const world = new World();
    const ch = new TestChannel();
    const cA = world.addContribution(ch.contributionNote(60n, STABLE, 'A'), ch.alice.tag);
    const signed = ch.sign(ch.state({ contribs: [noteCommitment(cA.note), 0n], balA: 59n, balB: 0n, closingFee: 1n, final: true }));
    const w = transferWitness({
      root: world.root,
      token: STABLE,
      inputs: [cA, dummyInput(STABLE)],
      outputs: ch.closeOutputs(signed, STABLE, person().tag),
      publicAmount: 0n,
      extDataHash: EXT,
      channel: signed,
    });
    expect(await satisfies('transfer', w.input)).toBe(true);
  });

  it('the tampering helper itself keeps an honest witness valid', async () => {
    expect(await satisfies('transfer', forceOutputs(simpleTransfer().w.input, [30n, 69n, 1n]))).toBe(true);
  });

  it('rejects a negative amount that wraps around the field', async () => {
    // 101 + (r - 2) + 1 = 100 (mod r): balanced in the field, so only the 64-bit range check stops it.
    expect(await satisfies('transfer', forceOutputs(simpleTransfer().w.input, [101n, FIELD_SIZE - 2n, 1n]))).toBe(false);
  });

  it('rejects an amount at 2^64', async () => {
    // Two inputs (2^64 - 1) + 1: the honest split is valid, an output of exactly 2^64 is not.
    const world = new World();
    const alice = person();
    const big = world.addPersonal(note(MAX_AMOUNT, NATIVE, alice.tag), alice);
    const one = world.addPersonal(note(1n, NATIVE, alice.tag), alice);
    const w = transferWitness({
      root: world.root,
      token: NATIVE,
      inputs: [world.refresh(big), one],
      outputs: [note(MAX_AMOUNT, NATIVE, alice.tag), note(1n, NATIVE, alice.tag), note(0n, NATIVE, alice.tag)],
      publicAmount: 0n,
      extDataHash: EXT,
    });
    expect(await satisfies('transfer', w.input)).toBe(true);
    expect(await satisfies('transfer', forceOutputs(w.input, [1n << 64n, 0n, 0n]))).toBe(false);
  });

  it('rejects unbalanced sums (31 + 69 + 1 from 100)', async () => {
    expect(await satisfies('transfer', forceOutputs(simpleTransfer().w.input, [31n, 69n, 1n]))).toBe(false);
  });

  it('rejects a fake nullifier (+1)', async () => {
    const { input } = simpleTransfer().w;
    expect(await satisfies('transfer', withAt(input, 'inNullifier', 0, (vector(input, 'inNullifier')[0] as bigint) + 1n))).toBe(false);
  });

  it('rejects an input not in the tree under the root (root + 1)', async () => {
    const { input } = simpleTransfer().w;
    expect(await satisfies('transfer', { ...input, root: scalar(input, 'root') + 1n })).toBe(false);
  });

  it("rejects spending without the owner secret (another person's secret)", async () => {
    const { w, spend } = simpleTransfer();
    const mallory = person();
    // The attacker's own owner tag changes the commitment, so the note is no longer the one in the tree.
    const forged = { ...spend.note, ownerTag: mallory.tag };
    let input = withAt(w.input, 'inSecret', 0, mallory.secret);
    input = withAt(input, 'inNullifier', 0, nullifierOf(mallory.secret, noteCommitment(forged)));
    expect(await satisfies('transfer', input)).toBe(false);
  });

  it('rejects a public token on an internal transfer, or a wrong token on a withdrawal', async () => {
    expect(await satisfies('transfer', { ...simpleTransfer().w.input, publicToken: STABLE })).toBe(false);
    expect(await satisfies('transfer', { ...nativeWithdrawal().input, publicToken: STABLE })).toBe(false);
  });

  it('rejects mixing tokens between inputs and outputs', async () => {
    const world = new World();
    const alice = person();
    const spend = world.addPersonal(note(100n, NATIVE, alice.tag), alice);
    const w = transferWitness({
      root: world.root,
      token: NATIVE,
      inputs: [spend, dummyInput(NATIVE)],
      outputs: [note(30n, STABLE, person().tag), note(69n, STABLE, alice.tag), note(1n, STABLE, person().tag)],
      publicAmount: 0n,
      extDataHash: EXT,
    });
    expect(await satisfies('transfer', w.input)).toBe(false);
  });

  it('rejects a token outside 160 bits (2^160)', async () => {
    // Two dummies into three empty notes: nothing but the token range check can fail.
    const w = transferWitness({
      root: new World().root,
      token: NATIVE,
      inputs: [dummyInput(NATIVE), dummyInput(NATIVE)],
      outputs: [note(0n, NATIVE, 1n), note(0n, NATIVE, 2n), note(0n, NATIVE, 3n)],
      publicAmount: 0n,
      extDataHash: EXT,
    });
    expect(await satisfies('transfer', retoken(w.input, 5n))).toBe(true);
    expect(await satisfies('transfer', retoken(w.input, 1n << 160n))).toBe(false);
  });

  it('rejects close outputs not matching the state', async () => {
    const { w } = cooperativeClose();
    const swapped = forceOutputs(w.input, [54n, 45n, 1n]);
    const stolenPayout = forceOutput(w.input, 0, { owner: person().tag });
    const greedyFee = forceOutputs(w.input, [44n, 54n, 2n]);
    expect(await satisfies('transfer', swapped)).toBe(false);
    expect(await satisfies('transfer', stolenPayout)).toBe(false);
    expect(await satisfies('transfer', greedyFee)).toBe(false);
  });

  it('rejects a payout salt not derived from the state (salt + 1)', async () => {
    const { w } = cooperativeClose();
    const salt = vector(w.input, 'outSalt')[0] as bigint;
    expect(await satisfies('transfer', forceOutput(w.input, 0, { salt: salt + 1n }))).toBe(false);
  });

  it("rejects a forged signature (B's signature by a stranger key)", async () => {
    expect(await satisfies('transfer', cooperativeClose({ keys: { b: generateChannelKey() } }).w.input)).toBe(false);
  });

  it('rejects a state that is not final', async () => {
    expect(await satisfies('transfer', cooperativeClose({ state: { final: false } }).w.input)).toBe(false);
  });

  it('rejects a channel input that the state does not list', async () => {
    // The state lists only A's 60; B's 40 is spent too and leaves as a public amount so the sums balance.
    const world = new World();
    const ch = new TestChannel();
    const cA = world.addContribution(ch.contributionNote(60n, STABLE, 'A'), ch.alice.tag);
    const cB = world.addContribution(ch.contributionNote(40n, STABLE, 'B'), ch.bob.tag);
    const signed = ch.sign(ch.state({ contribs: [noteCommitment(cA.note), 0n], balA: 59n, balB: 0n, closingFee: 1n, final: true }));
    const w = transferWitness({
      root: world.root,
      token: STABLE,
      inputs: [world.refresh(cA), cB],
      outputs: ch.closeOutputs(signed, STABLE, person().tag),
      publicAmount: 40n,
      extDataHash: EXT,
      channel: signed,
    });
    expect(await satisfies('transfer', w.input)).toBe(false);
  });

  it("rejects leaving a listed contribution unspent (A's contribution + a 40 personal note instead of B's)", async () => {
    const { world, ch, cA, signed, relayer } = cooperativeClose();
    const bobPersonal = world.addPersonal(note(40n, STABLE, ch.bob.tag), ch.bob);
    const inputs: [SpendInput, SpendInput] = [world.refresh(cA), bobPersonal];
    const w = transferWitness({
      root: world.root,
      token: STABLE,
      inputs,
      outputs: ch.closeOutputs(signed, STABLE, relayer.tag),
      publicAmount: 0n,
      extDataHash: EXT,
      channel: signed,
    });
    expect(await satisfies('transfer', w.input)).toBe(false);
  });

  it('rejects a mode flag that is not a bit (inMode[1] = 2)', async () => {
    expect(await satisfies('transfer', withAt(cooperativeClose().w.input, 'inMode', 1, 2n))).toBe(false);
  });

  it('Groth16: the proof verifies, matches the builder and binds every public signal', async () => {
    const { w } = simpleTransfer();
    const { proof, publicSignals } = await prove('transfer', w.input);
    expect(publicSignals.map(BigInt)).toEqual(w.publicSignals);
    const vk = verificationKey('transfer');
    expect(await groth16.verify(vk, publicSignals, proof)).toBe(true);
    for (let i = 0; i < publicSignals.length; i++) {
      const tampered = [...publicSignals];
      tampered[i] = (BigInt(publicSignals[i] as string) + 1n).toString();
      expect(await groth16.verify(vk, tampered, proof)).toBe(false);
    }
  });
});
