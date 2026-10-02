import { readFileSync } from 'node:fs';
import { groth16 } from 'snarkjs';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_DOMAIN,
  CLOSE_DOMAIN,
  channelNullifierOf,
  dummyInput,
  finalizeWitness,
  generateChannelKey,
  noteCommitment,
  randomFieldElement,
  reclaimWitness,
  submitStateWitness,
  type ChannelState,
  type CircuitInput,
} from '@calyptra/framework/protocol';
import { forceOutputs, prove, publicSignalNames, satisfies, scalar, verificationKey, type CircuitName } from './helpers.ts';
import { EXT, STABLE, TestChannel, World, note, person } from './world.ts';

/** Alice 60 / Bob 40 stablecoin contributions in the pool. */
function fundedChannel() {
  const world = new World();
  const ch = new TestChannel();
  const relayer = person();
  const contribA = world.addContribution(ch.contributionNote(60n, STABLE, 'A'), ch.alice.tag);
  const cB = world.addContribution(ch.contributionNote(40n, STABLE, 'B'), ch.bob.tag);
  const cA = world.refresh(contribA);
  return { world, ch, relayer, cA, cB, cmA: noteCommitment(cA.note), cmB: noteCommitment(cB.note) };
}

/** Finalizes the non-final pending state 45 / 54 / fee 1, nonce 77,000. */
function finalizeCase(keys: { a?: Uint8Array; b?: Uint8Array } = {}) {
  const f = fundedChannel();
  const state = f.ch.state({ contribs: [f.cmA, f.cmB], balA: 45n, balB: 54n, closingFee: 1n, nonce: 77_000n, final: false });
  const signed = f.ch.sign(state, keys);
  const w = finalizeWitness({
    root: f.world.root,
    token: STABLE,
    inputs: [f.cA, f.cB],
    outputs: f.ch.closeOutputs(signed, STABLE, f.relayer.tag),
    extDataHash: EXT,
    channel: signed,
  });
  return { ...f, signed, w };
}

type Funded = ReturnType<typeof fundedChannel>;

/** Bob reclaims his 40 into 39 (Bob) / 0 / 1 (relayer), with a dummy second input. */
function reclaimCase(refundSecret: (f: Funded) => bigint = (f) => f.ch.bob.secret) {
  const f = fundedChannel();
  const w = reclaimWitness({
    root: f.world.root,
    token: STABLE,
    contribution: { note: f.cB.note, proof: f.cB.proof },
    refundSecret: refundSecret(f),
    extra: dummyInput(STABLE),
    params: f.ch.params,
    outputs: [note(39n, STABLE, f.ch.bob.tag), note(0n, STABLE, f.ch.bob.tag), note(1n, STABLE, f.relayer.tag)],
    extDataHash: EXT,
  });
  return { ...f, w };
}

/** A state listing both contributions (nonce 4,000,000,123) or only A's (59 / 0 / fee 1, nonce 7). */
function submitCase(
  listBoth: boolean,
  overrides: { contribs?: (f: Funded) => ChannelState['contribs']; keys?: { a?: Uint8Array; b?: Uint8Array } } = {},
) {
  const f = fundedChannel();
  const state = listBoth
    ? f.ch.state({ contribs: [f.cmA, f.cmB], balA: 45n, balB: 54n, closingFee: 1n, nonce: 4_000_000_123n })
    : f.ch.state({ contribs: [f.cmA, 0n], balA: 59n, balB: 0n, closingFee: 1n, nonce: 7n });
  const signed = f.ch.sign(overrides.contribs ? { ...state, contribs: overrides.contribs(f) } : state, overrides.keys);
  return submitStateWitness({
    root: f.world.root,
    channel: signed,
    contribProofs: [f.cA.proof, listBoth ? f.cB.proof : f.world.tree.emptyProof()],
  });
}

const OTHER_CHANNEL = (): bigint => channelNullifierOf(randomFieldElement());

describe('constants', () => {
  it('circuit domain constants equal the protocol ones', () => {
    const source = readFileSync(new URL('../src/lib/constants.circom', import.meta.url), 'utf8');
    const valueOf = (fn: string): bigint => {
      const match = new RegExp(`function ${fn}\\(\\)\\s*\\{\\s*return\\s+(\\d+);`).exec(source);
      if (!match?.[1]) throw new Error(`${fn} not found in constants.circom`);
      return BigInt(match[1]);
    };
    expect(valueOf('CHANNEL_DOMAIN')).toBe(CHANNEL_DOMAIN);
    expect(valueOf('CLOSE_DOMAIN')).toBe(CLOSE_DOMAIN);
  });
});

describe('finalize circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('finalize')).toEqual([
      'root',
      'extDataHash',
      'inNullifier[0]',
      'inNullifier[1]',
      'outCommitment[0]',
      'outCommitment[1]',
      'outCommitment[2]',
      'channelNullifier',
      'stateHash',
    ]);
  });

  it('settles a non-final pending state', async () => {
    expect(await satisfies('finalize', finalizeCase().w.input)).toBe(true);
  });

  it('settles state 0 when only Alice funded (60 -> 59 / 0 / 1, dummy second input)', async () => {
    const world = new World();
    const ch = new TestChannel();
    const cA = world.addContribution(ch.contributionNote(60n, STABLE, 'A'), ch.alice.tag);
    const signed = ch.sign(ch.state({ contribs: [noteCommitment(cA.note), 0n], balA: 59n, balB: 0n, closingFee: 1n, nonce: 5n }));
    const w = finalizeWitness({
      root: world.root,
      token: STABLE,
      inputs: [cA, dummyInput(STABLE)],
      outputs: ch.closeOutputs(signed, STABLE, person().tag),
      extDataHash: EXT,
      channel: signed,
    });
    expect(await satisfies('finalize', w.input)).toBe(true);
  });

  it('rejects a state hash other than the pending one (+1)', async () => {
    const { input } = finalizeCase().w;
    expect(await satisfies('finalize', { ...input, stateHash: scalar(input, 'stateHash') + 1n })).toBe(false);
  });

  it('rejects a channel nullifier from another channel', async () => {
    expect(await satisfies('finalize', { ...finalizeCase().w.input, channelNullifier: OTHER_CHANNEL() })).toBe(false);
  });

  it('rejects outputs not following the pending state (55 / 44)', async () => {
    expect(await satisfies('finalize', forceOutputs(finalizeCase().w.input, [55n, 44n, 1n]))).toBe(false);
  });

  it('rejects settling with personal notes instead of the listed contributions', async () => {
    const f = finalizeCase();
    const alicePersonal = f.world.addPersonal(note(60n, STABLE, f.ch.alice.tag), f.ch.alice);
    const bobPersonal = f.world.addPersonal(note(40n, STABLE, f.ch.bob.tag), f.ch.bob);
    const w = finalizeWitness({
      root: f.world.root,
      token: STABLE,
      inputs: [f.world.refresh(alicePersonal), bobPersonal],
      outputs: f.ch.closeOutputs(f.signed, STABLE, f.relayer.tag),
      extDataHash: EXT,
      channel: f.signed,
    });
    expect(await satisfies('finalize', w.input)).toBe(false);
  });

  it("rejects a state signed by a stranger (A's key replaced)", async () => {
    expect(await satisfies('finalize', finalizeCase({ a: generateChannelKey() }).w.input)).toBe(false);
  });
});

describe('reclaim circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('reclaim')).toEqual([
      'root',
      'extDataHash',
      'inNullifier[0]',
      'inNullifier[1]',
      'outCommitment[0]',
      'outCommitment[1]',
      'outCommitment[2]',
      'channelNullifier',
    ]);
  });

  it('returns a contribution to the owner of its refund tag', async () => {
    expect(await satisfies('reclaim', reclaimCase().w.input)).toBe(true);
  });

  it('rejects anyone without the refund secret, including the counterparty', async () => {
    expect(await satisfies('reclaim', reclaimCase((f) => f.ch.alice.secret).w.input)).toBe(false);
    expect(await satisfies('reclaim', reclaimCase(() => randomFieldElement()).w.input)).toBe(false);
  });

  it('rejects a channel nullifier of another channel', async () => {
    expect(await satisfies('reclaim', { ...reclaimCase().w.input, channelNullifier: OTHER_CHANNEL() })).toBe(false);
  });

  it('rejects taking more than the contribution (40 + 0 + 1 from 40)', async () => {
    expect(await satisfies('reclaim', forceOutputs(reclaimCase().w.input, [40n, 0n, 1n]))).toBe(false);
  });
});

describe('submit-state circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('submit_state')).toEqual(['root', 'channelNullifier', 'nonce', 'stateHash', 'window']);
  });

  it('accepts a signed state whose listed contributions are all in the pool', async () => {
    expect(await satisfies('submit_state', submitCase(true).input)).toBe(true);
    expect(await satisfies('submit_state', submitCase(false).input)).toBe(true);
  });

  it('rejects a state listing a contribution that was never funded', async () => {
    const w = submitCase(false, { contribs: (f) => [f.cmA, 123_456_789n] });
    expect(await satisfies('submit_state', w.input)).toBe(false);
  });

  it('rejects a forged signature, a wrong nonce and a wrong window', async () => {
    const forged = submitCase(true, { keys: { b: generateChannelKey() } }).input;
    const { input } = submitCase(true);
    expect(await satisfies('submit_state', forged)).toBe(false);
    expect(await satisfies('submit_state', { ...input, nonce: scalar(input, 'nonce') + 1n })).toBe(false);
    expect(await satisfies('submit_state', { ...input, window: 60n })).toBe(false);
  });
});

describe('Groth16 proofs of the dispute circuits', () => {
  const cases: [CircuitName, () => { input: CircuitInput; publicSignals: bigint[] }][] = [
    ['finalize', () => finalizeCase().w],
    ['reclaim', () => reclaimCase().w],
    ['submit_state', () => submitCase(true)],
  ];
  for (const [name, build] of cases) {
    it(`${name}: the proof verifies, matches the builder and binds the last public signal`, async () => {
      const w = build();
      const { proof, publicSignals } = await prove(name, w.input);
      expect(publicSignals.map(BigInt)).toEqual(w.publicSignals);
      const vk = verificationKey(name);
      expect(await groth16.verify(vk, publicSignals, proof)).toBe(true);
      const tampered = [...publicSignals];
      const last = tampered.length - 1;
      tampered[last] = (BigInt(tampered[last] as string) + 1n).toString();
      expect(await groth16.verify(vk, tampered, proof)).toBe(false);
    });
  }
});
