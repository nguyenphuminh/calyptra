import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  channelPublicKeyOf,
  decryptNote,
  encryptionPublicKeyOf,
  generateChannelKey,
  hash2,
  noteCommitment,
  ownerTagOf,
  payoutSaltOf,
  randomFieldElement,
  signStateHash,
  type ChannelState,
  type EncryptionKeyPair,
  type PublicKey,
} from '../../shared/protocol/index.ts';
import type { ChannelRecord } from './channel.schema.ts';
import {
  MAX_NONCE,
  balanceOf,
  contributionCommitments,
  contributionNote,
  hashOf,
  historyEntry,
  holdsState,
  nonceStep,
  openingState,
  payoutNote,
  settlement,
  signedStates,
  successorProblem,
  winsTieBreak,
  type Rival,
} from './channel.state.ts';

const keyPair = (): EncryptionKeyPair => {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey, publicKey: encryptionPublicKeyOf(privateKey) };
};

/** A channel where A funds 60 and B 40, closing fee 1, with state 0 and state 1 signed by both. */
function fixture(contributesB = true) {
  const keyA = generateChannelKey();
  const keyB = generateChannelKey();
  const encA = keyPair();
  const encB = keyPair();
  const tagA = ownerTagOf(randomFieldElement());
  const tagB = ownerTagOf(randomFieldElement());
  const params = { pkA: channelPublicKeyOf(keyA), pkB: channelPublicKeyOf(keyB), channelSecret: hash2(randomFieldElement(), randomFieldElement()), window: 604_800n };
  const token = 0n;
  const contribA = { amount: 60n, salt: randomFieldElement() };
  const contribB = contributesB ? { amount: 40n, salt: randomFieldElement() } : null;
  const cA = noteCommitment(contributionNote(params, token, contribA, tagA));
  const cB = contribB ? noteCommitment(contributionNote(params, token, contribB, tagB)) : 0n;
  const s0 = openingState({ contribs: [cA, 0n], amountA: 60n, amountB: 0n, tagA, tagB, closingFee: 1n, nonce: 100n });
  const record: ChannelRecord = {
    id: '0'.repeat(32), role: 'A', index: 0, peer: { peerId: 'peer', addrs: [] }, token, status: 'live', params,
    encPubA: bytesToHex(encA.publicKey), encPubB: bytesToHex(encB.publicKey), contribA, contribB,
    state0: { state: s0, sigA: null, sigB: null }, latest: { state: s0, sigA: null, sigB: null },
    pending: null, history: [], closeTx: null, createdAt: 0,
  };
  const sign = (s: ChannelState) => ({ sigA: signStateHash(keyA, hashOf(record, s)), sigB: signStateHash(keyB, hashOf(record, s)) });
  record.state0 = { state: s0, ...sign(s0) };
  record.latest = record.state0;
  const s1 = openingState({ contribs: [cA, cB], amountA: 60n, amountB: contribB ? 40n : 0n, tagA, tagB, closingFee: 1n, nonce: 200n });
  if (contribB) {
    record.latest = { state: s1, ...sign(s1) };
    record.history.push(historyEntry(s1));
  }
  return { record, s0, s1, encA, encB, sign, cA, cB };
}

const pay = (s: ChannelState, toB: bigint, step = 10n): ChannelState => ({ ...s, balA: s.balA - toB, balB: s.balB + toB, nonce: s.nonce + step });
const key = (x: bigint, y: bigint): PublicKey => [x, y];

describe('nonceStep', () => {
  it('returns random values between 1 and 2^32', () => {
    const values = Array.from({ length: 500 }, () => nonceStep());
    for (const v of values) {
      expect(v >= 1n && v <= 2n ** 32n).toBe(true);
    }
    expect(new Set(values).size).toBeGreaterThan(490);
  });
});

describe('successorProblem', () => {
  const { s1 } = fixture();
  it('accepts a payment that does not lower the receiver', () => {
    expect(successorProblem(s1, pay(s1, 5n), 'pay', 1)).toBeNull();
  });
  it('refuses lowering, equal or out-of-range nonces, changed totals, fees, flags, contributions and tags', () => {
    expect(successorProblem(s1, pay(s1, 5n), 'pay', 0)).toBe('The proposal lowers this side’s balance');
    expect(successorProblem(s1, pay(s1, 5n, 0n), 'pay', 1)).toBe('The nonce does not increase');
    expect(successorProblem(s1, { ...pay(s1, 5n), nonce: MAX_NONCE + 1n }, 'pay', 1)).toBe('The nonce does not increase');
    expect(successorProblem(s1, { ...pay(s1, 5n), balB: s1.balB + 6n }, 'pay', 1)).toBe('The total does not match the contributions');
    expect(successorProblem(s1, { ...pay(s1, 5n), closingFee: 2n, balA: s1.balA - 6n }, 'pay', 1)).toBe('A payment cannot change the closing fee');
    expect(successorProblem(s1, { ...pay(s1, 5n), final: true }, 'pay', 1)).toBe('Only a closing proposal may be final');
    expect(successorProblem(s1, { ...pay(s1, 5n), contribs: [s1.contribs[0], 0n] }, 'pay', 1)).toBe('The contributions changed');
    expect(successorProblem(s1, { ...pay(s1, 5n), payoutB: 7n }, 'pay', 1)).toBe('The payout tags changed');
    const closing = { ...pay(s1, 5n), final: true };
    expect(successorProblem(closing, pay(closing, 1n), 'pay', 1)).toBe('The channel is already closing');
  });
  it('lets a closing proposal change the fee when its proposer absorbs it', () => {
    const close = { ...s1, closingFee: 3n, balA: s1.balA - 2n, nonce: s1.nonce + 1n, final: true };
    expect(successorProblem(s1, close, 'close', 1)).toBeNull();
    const shifted = { ...s1, closingFee: 3n, balB: s1.balB - 2n, nonce: s1.nonce + 1n, final: true };
    expect(successorProblem(s1, shifted, 'close', 1)).toBe('The proposal lowers this side’s balance');
    expect(successorProblem(s1, { ...close, final: false }, 'close', 1)).toBe('Only a closing proposal may be final');
  });
});

describe('winsTieBreak', () => {
  it('lets the higher nonce win regardless of keys', () => {
    expect(winsTieBreak({ nonce: 5n, proposer: key(9n, 9n) }, { nonce: 4n, proposer: key(1n, 1n) })).toBe(true);
    expect(winsTieBreak({ nonce: 4n, proposer: key(1n, 1n) }, { nonce: 5n, proposer: key(9n, 9n) })).toBe(false);
  });
  it('lets the smaller key win on equal nonces, comparing x then y', () => {
    expect(winsTieBreak({ nonce: 5n, proposer: key(1n, 9n) }, { nonce: 5n, proposer: key(2n, 1n) })).toBe(true);
    expect(winsTieBreak({ nonce: 5n, proposer: key(2n, 1n) }, { nonce: 5n, proposer: key(1n, 9n) })).toBe(false);
    expect(winsTieBreak({ nonce: 5n, proposer: key(3n, 1n) }, { nonce: 5n, proposer: key(3n, 2n) })).toBe(true);
  });
  it('picks exactly one winner whose nonce is never below the loser’s', () => {
    const pkA = channelPublicKeyOf(generateChannelKey());
    const pkB = channelPublicKeyOf(generateChannelKey());
    for (let i = 0; i < 500; i++) {
      const nA = BigInt(Math.floor(Math.random() * 20));
      const nB = i % 3 === 0 ? nA : BigInt(Math.floor(Math.random() * 20));
      const a: Rival = { nonce: nA, proposer: pkA };
      const b: Rival = { nonce: nB, proposer: pkB };
      const aWins = winsTieBreak(a, b);
      expect(winsTieBreak(b, a)).toBe(!aWins);
      const [winner, loser] = aWins ? [a, b] : [b, a];
      expect(loser.nonce <= winner.nonce).toBe(true);
    }
  });
});

describe('compact history', () => {
  it('rebuilds every signed state, state 0 listing only A’s contribution', () => {
    const { record, s0, s1, sign } = fixture();
    const s2 = pay(s1, 7n);
    record.latest = { state: s2, ...sign(s2) };
    record.history.push(historyEntry(s2));
    const states = signedStates(record);
    expect(states.map((s) => hashOf(record, s))).toEqual([s0, s1, s2].map((s) => hashOf(record, s)));
    expect(states[0]?.contribs[1]).toBe(0n);
  });
  it('finds states by hash and nonce, and not a different state at the same nonce', () => {
    const { record, s1 } = fixture();
    expect(holdsState(record, hashOf(record, s1), s1.nonce)).toBe(true);
    expect(holdsState(record, hashOf(record, pay(s1, 0n, 0n)), s1.nonce + 1n)).toBe(false);
    expect(holdsState(record, hashOf(record, { ...s1, balA: s1.balA - 1n, balB: s1.balB + 1n }), s1.nonce)).toBe(false);
  });
});

describe('settlement', () => {
  const relayer = keyPair();
  const feeTo = { ownerTag: ownerTagOf(randomFieldElement()), encryptionPublicKey: relayer.publicKey };
  const proof = (commitment: bigint) => ({ leafIndex: Number(commitment % 1000n), pathElements: [] });

  it('pays both sides with state-fixed salts and the relayer the closing fee', () => {
    const { record, cA, cB, encA, encB } = fixture();
    const final = { ...pay(record.latest.state, 15n), nonce: record.latest.state.nonce + 1n, final: true };
    const { inputs, outputs, ciphertexts } = settlement(record, final, proof, feeTo);
    expect(inputs.map((i) => noteCommitment(i.note))).toEqual([cA, cB]);
    expect(inputs.map((i) => i.unlock.kind)).toEqual(['channel', 'channel']);
    expect(outputs[0]).toEqual({ amount: 44n, token: 0n, ownerTag: final.payoutA, salt: payoutSaltOf(record.params.channelSecret, hashOf(record, final), 0) });
    expect(outputs[1]).toEqual({ amount: 55n, token: 0n, ownerTag: final.payoutB, salt: payoutSaltOf(record.params.channelSecret, hashOf(record, final), 1) });
    expect(outputs[0]).toEqual(payoutNote(record, final, 0));
    expect(outputs[2].amount).toBe(1n);
    expect(outputs[2].ownerTag).toBe(feeTo.ownerTag);
    const open = (keys: EncryptionKeyPair, ct: Hex) => decryptNote(keys, hexToBytes(ct));
    expect(open(encA, ciphertexts[0])).toEqual(outputs[0]);
    expect(open(encB, ciphertexts[1])).toEqual(outputs[1]);
    expect(open(relayer, ciphertexts[2])).toEqual(outputs[2]);
  });

  it('settles state 0 with a zero-amount personal dummy in B’s slot and nothing for B', () => {
    const { record, s0, cA } = fixture();
    const { inputs, outputs } = settlement(record, s0, proof, feeTo);
    expect(noteCommitment(inputs[0].note)).toBe(cA);
    expect(inputs[1].unlock.kind).toBe('personal');
    expect(inputs[1].note.amount).toBe(0n);
    expect(outputs.map((o) => o.amount)).toEqual([59n, 0n, 1n]);
    expect(balanceOf(s0, 1)).toBe(0n);
  });

  it('lists only A’s contribution when B funds nothing', () => {
    const { record } = fixture(false);
    const [, cB] = contributionCommitments(record);
    expect(cB).toBe(0n);
    expect(signedStates(record)).toHaveLength(1);
  });
});
