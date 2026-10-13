// Contract test fixtures with REAL Groth16 proofs: writes circuits/build/fixtures/pool.json
// and dispute.json from the proving artifacts in packages/framework/artifacts. Run it after every circuit
// setup (`npm run setup` does), because the verifying keys and the proofs belong to one trusted setup.
// Deposits are mirrored with the same commitments the pool computes, so every proof is built against the
// root the contract will have. Numbers are decimal strings, bytes are 0x hex.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groth16 } from 'snarkjs';
import { bytesToHex, zeroAddress, type Address, type Hex } from 'viem';
import {
  MerkleTree,
  channelPublicKeyOf,
  channelTagOf,
  dummyInput,
  extDataHashOf,
  finalizeWitness,
  noteCommitment,
  noteInner,
  ownerTagOf,
  paramsHashOf,
  payoutSaltOf,
  reclaimWitness,
  signStateHash,
  stateHashOf,
  submitStateWitness,
  toEvmProof,
  transferWitness,
  type ChannelParams,
  type ChannelState,
  type CircuitInput,
  type NotePreimage,
  type SignedState,
} from '@calyptra/framework/protocol';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACTS = `${REPO}/packages/framework/artifacts`;
const OUT = `${REPO}/circuits/build/fixtures`;
const CIRCUITS = ['transfer', 'finalize', 'reclaim', 'submit_state'] as const;
type Circuit = (typeof CIRCUITS)[number];
const NATIVE = 0n;
const RELAYER = ownerTagOf(1003n);

/** A recognisable 168-byte ciphertext filled with one tag byte; contracts only hash ciphertexts. */
const ciphertext = (tag: number): Hex => bytesToHex(new Uint8Array(168).fill(tag));
const ciphertexts = (base: number): [Hex, Hex, Hex] => [ciphertext(base), ciphertext(base + 1), ciphertext(base + 2)];
const concat = (parts: readonly Hex[]): Hex => `0x${parts.map((p) => p.slice(2)).join('')}`;
const decimal = (values: readonly bigint[]): string[] => values.map((v) => v.toString());
const tokenAddress = (token: bigint): Address => `0x${token.toString(16).padStart(40, '0')}`;
const note = (amount: bigint, ownerTag: bigint, salt: bigint): NotePreimage => ({ amount, token: NATIVE, ownerTag, salt });

async function prove(circuit: Circuit, input: CircuitInput, expected: readonly bigint[]) {
  const { proof, publicSignals } = await groth16.fullProve(input, `${ARTIFACTS}/${circuit}.wasm`, `${ARTIFACTS}/${circuit}.zkey`);
  const signals = publicSignals.map((s) => BigInt(s));
  if (signals.length !== expected.length || signals.some((s, i) => s !== expected[i])) {
    throw new Error(`${circuit}: the proof's public signals differ from the witness builder's`);
  }
  return { proof: decimal(toEvmProof(proof)), signals: decimal(signals) };
}

/** Inserts a deposit into the mirror tree exactly as the pool will: commitment = H(pack(token, amount), inner). */
function deposit(tree: MerkleTree, n: NotePreimage, tag: number) {
  const commitment = noteCommitment(n);
  tree.insert(commitment);
  return {
    token: tokenAddress(n.token),
    amount: n.amount.toString(),
    inner: noteInner(n.ownerTag, n.salt).toString(),
    commitment: commitment.toString(),
    ciphertext: ciphertext(tag),
  };
}

async function poolFixture() {
  const tree = new MerkleTree();
  const [alice, bob] = [1001n, 1002n];

  // Alice deposits 100 native.
  const aliceNote = note(100n, ownerTagOf(alice), 11n);
  const deposits = [deposit(tree, aliceNote, 1)];

  // Alice pays Bob 30, keeps 69, pays the relayer 1. Second input dummy; nothing leaves the pool.
  const bobNote = note(30n, ownerTagOf(bob), 12n);
  const transferExt = { recipient: zeroAddress, ciphertexts: ciphertexts(10) };
  const t = transferWitness({
    root: tree.root,
    token: NATIVE,
    inputs: [{ note: aliceNote, unlock: { kind: 'personal', secret: alice }, proof: tree.proof(0) }, dummyInput(NATIVE)],
    outputs: [bobNote, note(69n, ownerTagOf(alice), 13n), note(1n, RELAYER, 14n)],
    publicAmount: 0n,
    extDataHash: extDataHashOf(transferExt),
  });
  const transfer = { ...(await prove('transfer', t.input, t.publicSignals)), recipient: zeroAddress, ciphertexts: concat(transferExt.ciphertexts) };
  for (const c of t.commitments) tree.insert(c);

  // Bob withdraws 20 publicly, keeps 9, adds an empty note and pays the relayer 1.
  const withdrawalExt = { recipient: '0x1111111111111111111111111111111111111111' as Address, ciphertexts: ciphertexts(20) };
  const w = transferWitness({
    root: tree.root,
    token: NATIVE,
    inputs: [
      { note: bobNote, unlock: { kind: 'personal', secret: bob }, proof: tree.proof(tree.indexOf(noteCommitment(bobNote))) },
      dummyInput(NATIVE),
    ],
    outputs: [note(9n, ownerTagOf(bob), 15n), note(0n, ownerTagOf(bob), 16n), note(1n, RELAYER, 17n)],
    publicAmount: 20n,
    extDataHash: extDataHashOf(withdrawalExt),
  });
  const withdrawal = {
    ...(await prove('transfer', w.input, w.publicSignals)),
    recipient: withdrawalExt.recipient,
    ciphertexts: concat(withdrawalExt.ciphertexts),
  };
  for (const c of w.commitments) tree.insert(c);

  return { deposits, transfer, withdrawal, finalRoot: tree.root.toString() };
}

async function disputeFixture() {
  const tree = new MerkleTree();
  const WINDOW = 259200n; // 3 days
  const keyA = new Uint8Array(32).fill(41);
  const keyB = new Uint8Array(32).fill(42);
  const pkA = channelPublicKeyOf(keyA);
  const pkB = channelPublicKeyOf(keyB);

  const channel = (channelSecret: bigint, refundSecretA: bigint, refundSecretB: bigint) => {
    const params: ChannelParams = { pkA, pkB, channelSecret, window: WINDOW };
    const paramsHash = paramsHashOf(params);
    const refundTagA = ownerTagOf(refundSecretA);
    const refundTagB = ownerTagOf(refundSecretB);
    return {
      params,
      paramsHash,
      refundTagA,
      refundTagB,
      contribution: (amount: bigint, side: 'A' | 'B', salt: bigint) =>
        note(amount, channelTagOf(paramsHash, side === 'A' ? refundTagA : refundTagB), salt),
    };
  };
  const sign = (params: ChannelParams, state: ChannelState): SignedState => {
    const hash = stateHashOf(paramsHashOf(params), state);
    return { params, state, sigA: signStateHash(keyA, hash), sigB: signStateHash(keyB, hash) };
  };

  // Channel 1 (A 60 / B 40) and channel 2 (A 60 / B 40) contributions, all deposited before any proof.
  const ch1 = channel(777n, 2001n, 2002n);
  const ch2 = channel(888n, 3001n, 3002n);
  const c1A = ch1.contribution(60n, 'A', 21n);
  const c1B = ch1.contribution(40n, 'B', 22n);
  const c2A = ch2.contribution(60n, 'A', 23n);
  const c2B = ch2.contribution(40n, 'B', 24n);
  const deposits = [deposit(tree, c1A, 30), deposit(tree, c1B, 31), deposit(tree, c2A, 50), deposit(tree, c2B, 51)];
  const root = tree.root;
  const proofOf = (n: NotePreimage) => tree.proof(tree.indexOf(noteCommitment(n)));

  // Channel 1: an old state (nonce 100) answered by the latest (nonce 200), which is finalized.
  const ch1State = (balA: bigint, balB: bigint, closingFee: bigint, nonce: bigint): ChannelState => ({
    contribs: [noteCommitment(c1A), noteCommitment(c1B)],
    balA,
    balB,
    payoutA: ch1.refundTagA,
    payoutB: ch1.refundTagB,
    closingFee,
    nonce,
    final: false,
  });
  const submit = async (signed: SignedState, contribProofs: Parameters<typeof submitStateWitness>[0]['contribProofs']) => {
    const s = submitStateWitness({ root, channel: signed, contribProofs });
    return prove('submit_state', s.input, s.publicSignals);
  };
  const oldSigned = sign(ch1.params, ch1State(60n, 40n, 0n, 100n));
  const latestSigned = sign(ch1.params, ch1State(45n, 54n, 1n, 200n));
  const submitOld = await submit(oldSigned, [proofOf(c1A), proofOf(c1B)]);
  const submitLatest = await submit(latestSigned, [proofOf(c1A), proofOf(c1B)]);

  const latestHash = stateHashOf(ch1.paramsHash, latestSigned.state);
  const finalizeExt = { recipient: zeroAddress, ciphertexts: ciphertexts(40) };
  const f = finalizeWitness({
    root,
    token: NATIVE,
    inputs: [
      { note: c1A, unlock: { kind: 'channel', refundTag: ch1.refundTagA }, proof: proofOf(c1A) },
      { note: c1B, unlock: { kind: 'channel', refundTag: ch1.refundTagB }, proof: proofOf(c1B) },
    ],
    outputs: [
      note(45n, ch1.refundTagA, payoutSaltOf(777n, latestHash, 0)),
      note(54n, ch1.refundTagB, payoutSaltOf(777n, latestHash, 1)),
      note(1n, RELAYER, 99n),
    ],
    extDataHash: extDataHashOf(finalizeExt),
    channel: latestSigned,
  });
  const finalize = { ...(await prove('finalize', f.input, f.publicSignals)), ciphertexts: concat(finalizeExt.ciphertexts) };

  // Channel 2: state 0 lists only A's contribution; it is finalized, then B reclaims its 40.
  const state0Signed = sign(ch2.params, {
    contribs: [noteCommitment(c2A), 0n],
    balA: 59n,
    balB: 0n,
    payoutA: ch2.refundTagA,
    payoutB: ch2.refundTagB,
    closingFee: 1n,
    nonce: 5n,
    final: false,
  });
  const submitState0 = await submit(state0Signed, [proofOf(c2A), tree.emptyProof()]);
  const state0Hash = stateHashOf(ch2.paramsHash, state0Signed.state);
  const finalize0Ext = { recipient: zeroAddress, ciphertexts: ciphertexts(60) };
  const f0 = finalizeWitness({
    root,
    token: NATIVE,
    inputs: [{ note: c2A, unlock: { kind: 'channel', refundTag: ch2.refundTagA }, proof: proofOf(c2A) }, dummyInput(NATIVE)],
    outputs: [
      note(59n, ch2.refundTagA, payoutSaltOf(888n, state0Hash, 0)),
      note(0n, ch2.refundTagB, payoutSaltOf(888n, state0Hash, 1)),
      note(1n, RELAYER, 98n),
    ],
    extDataHash: extDataHashOf(finalize0Ext),
    channel: state0Signed,
  });
  const finalizeState0 = { ...(await prove('finalize', f0.input, f0.publicSignals)), ciphertexts: concat(finalize0Ext.ciphertexts) };

  const reclaimExt = { recipient: zeroAddress, ciphertexts: ciphertexts(70) };
  const r = reclaimWitness({
    root,
    token: NATIVE,
    contribution: { note: c2B, proof: proofOf(c2B) },
    refundSecret: 3002n,
    extra: dummyInput(NATIVE),
    params: ch2.params,
    outputs: [note(39n, ownerTagOf(3002n), 25n), note(0n, ownerTagOf(3002n), 26n), note(1n, RELAYER, 27n)],
    extDataHash: extDataHashOf(reclaimExt),
  });
  const reclaim = { ...(await prove('reclaim', r.input, r.publicSignals)), ciphertexts: concat(reclaimExt.ciphertexts) };

  return { deposits, window: WINDOW.toString(), submitOld, submitLatest, finalize, submitState0, finalizeState0, reclaim };
}

const missing = CIRCUITS.flatMap((c) => [`${c}.wasm`, `${c}.zkey`]).filter((f) => !existsSync(`${ARTIFACTS}/${f}`));
if (missing.length > 0) throw new Error(`missing ${missing.join(', ')} in ${ARTIFACTS} (build the circuits first)`);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/pool.json`, `${JSON.stringify(await poolFixture(), null, 2)}\n`);
console.log(`wrote ${OUT}/pool.json`);
writeFileSync(`${OUT}/dispute.json`, `${JSON.stringify(await disputeFixture(), null, 2)}\n`);
console.log(`wrote ${OUT}/dispute.json`);
process.exit(0); // snarkjs keeps worker threads alive
