// The contracts on a local chain with real proofs (all-ref §4.11, §10.7.10): freshly deployed contracts
// with the short-window Disputes build, a 15-second channel window, and accounts relayer / Alice / Bob.
// Every receipt's gasUsed is recorded under a label and written to <DEVNODE_DIR>/gas-report.json.
// Each test depends on the previous one.
import { writeFileSync } from 'node:fs';
import { createTestClient, hexToBytes, http, parseAbi, parseEther, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disputesAbi, erc20Abi, poolAbi } from '../../packages/framework/src/modules/chain/index.ts';
import {
  channelNullifierOf,
  channelPublicKeyOf,
  channelTagOf,
  decryptNote,
  dummyInput,
  extDataHashOf,
  finalizeWitness,
  generateChannelKey,
  noteCommitment,
  noteInner,
  nullifierOf,
  ownerTagOf,
  paramsHashOf,
  payoutSaltOf,
  randomFieldElement,
  reclaimWitness,
  signStateHash,
  stateHashOf,
  submitStateWitness,
  transferWitness,
  type ChannelParams,
  type ChannelState,
  type MerkleTree,
  type NotePreimage,
  type SignedState,
  type SpendInput,
} from '../../packages/framework/src/shared/protocol/index.ts';
import type { Deployment } from '../../scripts/lib/deploy.ts';
import { DEVNODE_DIR, DEVNODE_RPC, devChain } from '../../scripts/lib/devnode.ts';
import {
  ciphertextFor,
  client,
  encryptionKeys,
  freshAddress,
  freshDeployment,
  fundedAccount,
  mirrorTree,
  note,
  prove,
  revertName,
  send,
  tuple,
  type Wallet,
} from './chain.ts';

type P8 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
type S9 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
type S8 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
type S5 = readonly [bigint, bigint, bigint, bigint, bigint];
type Keys = ReturnType<typeof encryptionKeys>;
interface Party { secret: bigint; tag: bigint; keys: Keys }
type TransactArgs = readonly [P8, S9, Address, Hex];

const WINDOW = 15n;
const NATIVE = 0n;
const mintAbi = parseAbi(['function mint(address to, uint256 value)']);
const party = (): Party => {
  const secret = randomFieldElement();
  return { secret, tag: ownerTagOf(secret), keys: encryptionKeys() };
};
const concat = (parts: readonly Hex[]): Hex => `0x${parts.map((p) => p.slice(2)).join('')}`;

let d: Deployment;
let relayer: Wallet;
let aliceWallet: Wallet;
let stable: bigint;
const alice = party();
const bob = party();
const relayerParty = party();
const gas: Record<string, string> = {};
/** Keeps the largest gasUsed seen per label. */
const record = (label: string, receipt: TransactionReceipt): void => {
  const previous = BigInt(gas[label] ?? '0');
  gas[label] = (receipt.gasUsed > previous ? receipt.gasUsed : previous).toString();
};

const tree = (): Promise<MerkleTree> => mirrorTree(d.pool, BigInt(d.deployBlock));
const personal = (t: MerkleTree, n: NotePreimage, secret: bigint): SpendInput => ({
  note: n,
  unlock: { kind: 'personal', secret },
  proof: t.proof(t.indexOf(noteCommitment(n))),
});

/** Proves and submits a transfer-circuit transaction through the relayer account. */
async function transact(
  label: string,
  t: MerkleTree,
  w: {
    token: bigint;
    inputs: readonly [SpendInput, SpendInput];
    outputs: readonly [NotePreimage, NotePreimage, NotePreimage];
    to: readonly [Keys, Keys, Keys];
    publicAmount?: bigint;
    recipient?: Address;
    channel?: SignedState;
  },
) {
  const cts = w.outputs.map((o, i) => ciphertextFor(w.to[i] as Keys, o)) as [Hex, Hex, Hex];
  const recipient = w.recipient ?? zeroAddress;
  const witness = transferWitness({
    root: t.root,
    token: w.token,
    inputs: w.inputs,
    outputs: w.outputs,
    publicAmount: w.publicAmount ?? 0n,
    extDataHash: extDataHashOf({ recipient, ciphertexts: cts }),
    channel: w.channel,
  });
  const { proof, signals } = await prove('transfer', witness.input);
  expect(signals).toEqual(witness.publicSignals);
  const args: TransactArgs = [tuple<P8>(proof), tuple<S9>(signals), recipient, concat(cts)];
  record(label, await send(relayer, { address: d.pool, abi: poolAbi, functionName: 'transact', args }));
  return { args, witness };
}

const isSpent = (nf: bigint) => client.readContract({ address: d.pool, abi: poolAbi, functionName: 'isSpent', args: [nf] });
const stableBalance = (owner: Address) =>
  client.readContract({ address: d.stablecoin, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });

beforeAll(async () => {
  d = await freshDeployment();
  stable = BigInt(d.stablecoin);
  relayer = await fundedAccount('1');
  aliceWallet = await fundedAccount('2');
});

afterAll(() => {
  writeFileSync(`${DEVNODE_DIR}/gas-report.json`, `${JSON.stringify(gas, null, 2)}\n`);
});

describe('contracts with real proofs', () => {
  let aliceNative: NotePreimage;
  let aliceStable: NotePreimage;
  let aliceChange: NotePreimage;
  let bobNote: NotePreimage;
  let bobChange: NotePreimage;
  let transferArgs: TransactArgs;
  let lastArgs: TransactArgs;

  it('computes deposit commitments on-chain from what was received', async () => {
    aliceNative = note(parseEther('0.01'), NATIVE, alice.tag);
    record('deposit native', await send(aliceWallet, {
      address: d.pool, abi: poolAbi, functionName: 'deposit', value: aliceNative.amount,
      args: [zeroAddress, aliceNative.amount, noteInner(alice.tag, aliceNative.salt), ciphertextFor(alice.keys, aliceNative)],
    }));

    aliceStable = note(100_000_000n, stable, alice.tag);
    await send(aliceWallet, { address: d.stablecoin, abi: mintAbi, functionName: 'mint', args: [aliceWallet.account.address, aliceStable.amount] });
    record('approve stablecoin', await send(aliceWallet, {
      address: d.stablecoin, abi: erc20Abi, functionName: 'approve', args: [d.pool, aliceStable.amount],
    }));
    record('deposit stablecoin', await send(aliceWallet, {
      address: d.pool, abi: poolAbi, functionName: 'deposit',
      args: [d.stablecoin, aliceStable.amount, noteInner(alice.tag, aliceStable.salt), ciphertextFor(alice.keys, aliceStable)],
    }));

    const t = await tree();
    expect(t.leaves()).toEqual([noteCommitment(aliceNative), noteCommitment(aliceStable)]);
    expect(await client.readContract({ address: d.pool, abi: poolAbi, functionName: 'root' })).toBe(t.root);
    expect(await stableBalance(d.pool)).toBe(100_000_000n);
  });

  it('makes a private transfer through the relayer', async () => {
    const t = await tree();
    bobNote = note(parseEther('0.004'), NATIVE, bob.tag);
    aliceChange = note(parseEther('0.00599'), NATIVE, alice.tag);
    const { args, witness } = await transact('transact: private transfer', t, {
      token: NATIVE,
      inputs: [personal(t, aliceNative, alice.secret), dummyInput(NATIVE)],
      outputs: [bobNote, aliceChange, note(parseEther('0.00001'), NATIVE, relayerParty.tag)],
      to: [bob.keys, alice.keys, relayerParty.keys],
    });
    transferArgs = args;
    expect(await isSpent(witness.nullifiers[0])).toBe(true);
    expect(await isSpent(witness.nullifiers[1])).toBe(true);

    const events = await client.getContractEvents({ address: d.pool, abi: poolAbi, eventName: 'NewCommitment', fromBlock: BigInt(d.deployBlock) });
    const found = events
      .map((e) => decryptNote(bob.keys, hexToBytes(e.args.ciphertext as Hex)))
      .filter((n): n is NotePreimage => n !== null);
    expect(found).toEqual([bobNote]);
  });

  it('pays withdrawals exactly the public amount', async () => {
    let t = await tree();
    const bobAddress = freshAddress();
    bobChange = note(parseEther('0.00099'), NATIVE, bob.tag);
    await transact('transact: withdrawal, native', t, {
      token: NATIVE,
      inputs: [personal(t, bobNote, bob.secret), dummyInput(NATIVE)],
      outputs: [bobChange, note(0n, NATIVE, bob.tag), note(parseEther('0.00001'), NATIVE, relayerParty.tag)],
      to: [bob.keys, bob.keys, relayerParty.keys],
      publicAmount: parseEther('0.003'),
      recipient: bobAddress,
    });
    expect(await client.getBalance({ address: bobAddress })).toBe(3_000_000_000_000_000n);

    t = await tree();
    const aliceAddress = freshAddress();
    const { args } = await transact('transact: withdrawal, stablecoin', t, {
      token: stable,
      inputs: [personal(t, aliceStable, alice.secret), dummyInput(stable)],
      outputs: [note(59_990_000n, stable, alice.tag), note(0n, stable, alice.tag), note(10_000n, stable, relayerParty.tag)],
      to: [alice.keys, alice.keys, relayerParty.keys],
      publicAmount: 40_000_000n,
      recipient: aliceAddress,
    });
    lastArgs = args;
    expect(await stableBalance(aliceAddress)).toBe(40_000_000n);
    expect(await stableBalance(d.pool)).toBe(60_000_000n);
  });

  it('rejects replays, changed recipients, forged proofs and unknown roots', async () => {
    const simulate = (args: TransactArgs) =>
      client.simulateContract({ address: d.pool, abi: poolAbi, functionName: 'transact', args, account: relayer.account });
    expect(await revertName(simulate(lastArgs))).toBe('NullifierAlreadySpent');

    const [proof, signals, recipient, cts] = transferArgs;
    const fresh = [...signals] as bigint[];
    fresh[4] = randomFieldElement();
    fresh[5] = randomFieldElement();
    expect(await revertName(simulate([proof, tuple<S9>(fresh), freshAddress(), cts]))).toBe('InvalidExtData');
    const forged = [...proof] as bigint[];
    forged[0] = (forged[0] as bigint) + 1n;
    expect(await revertName(simulate([tuple<P8>(forged), tuple<S9>(fresh), recipient, cts]))).toBe('InvalidProof');
    const unknownRoot = [...fresh];
    unknownRoot[0] = randomFieldElement();
    expect(await revertName(simulate([proof, tuple<S9>(unknownRoot), recipient, cts]))).toBe('UnknownRoot');
  });

  /** A channel between Alice (A) and Bob (B) with fresh keys, secret and per-channel tags. */
  function channel() {
    const keyA = generateChannelKey();
    const keyB = generateChannelKey();
    const params: ChannelParams = { pkA: channelPublicKeyOf(keyA), pkB: channelPublicKeyOf(keyB), channelSecret: randomFieldElement(), window: WINDOW };
    const paramsHash = paramsHashOf(params);
    const tagSecretA = randomFieldElement();
    const tagSecretB = randomFieldElement();
    const refundTagA = ownerTagOf(tagSecretA);
    const refundTagB = ownerTagOf(tagSecretB);
    return {
      params,
      paramsHash,
      tagSecretB,
      refundTagA,
      refundTagB,
      contribA: note(60_000n, NATIVE, channelTagOf(paramsHash, refundTagA)),
      contribB: note(40_000n, NATIVE, channelTagOf(paramsHash, refundTagB)),
      sign: (state: ChannelState): SignedState => {
        const hash = stateHashOf(paramsHash, state);
        return { params, state, sigA: signStateHash(keyA, hash), sigB: signStateHash(keyB, hash) };
      },
    };
  }
  type Channel = ReturnType<typeof channel>;

  /** Funds a contribution with an ordinary transfer: contribution, change and a 100 fee. */
  async function fund(label: string, owner: Party, change: NotePreimage, contribution: NotePreimage): Promise<NotePreimage> {
    const t = await tree();
    const next = note(change.amount - contribution.amount - 100n, NATIVE, owner.tag);
    await transact(label, t, {
      token: NATIVE,
      inputs: [personal(t, change, owner.secret), dummyInput(NATIVE)],
      outputs: [contribution, next, note(100n, NATIVE, relayerParty.tag)],
      to: [owner.keys, owner.keys, relayerParty.keys],
    });
    return next;
  }

  const channelInput = (t: MerkleTree, n: NotePreimage, refundTag: bigint): SpendInput => ({
    note: n,
    unlock: { kind: 'channel', refundTag },
    proof: t.proof(t.indexOf(noteCommitment(n))),
  });

  /** The payout notes of a state: fixed by the state, so each side can rebuild its own. */
  const payouts = (ch: Channel, state: ChannelState): [NotePreimage, NotePreimage, NotePreimage] => {
    const hash = stateHashOf(ch.paramsHash, state);
    return [
      { amount: state.balA, token: NATIVE, ownerTag: state.payoutA, salt: payoutSaltOf(ch.params.channelSecret, hash, 0) },
      { amount: state.balB, token: NATIVE, ownerTag: state.payoutB, salt: payoutSaltOf(ch.params.channelSecret, hash, 1) },
      note(state.closingFee, NATIVE, relayerParty.tag),
    ];
  };

  it('funds a channel and closes it cooperatively with ordinary transfers', async () => {
    const ch = channel();
    aliceChange = await fund('transact: channel funding (A)', alice, aliceChange, ch.contribA);
    bobChange = await fund('transact: channel funding (B)', bob, bobChange, ch.contribB);

    const state: ChannelState = {
      contribs: [noteCommitment(ch.contribA), noteCommitment(ch.contribB)],
      balA: 45_000n, balB: 54_000n, payoutA: ch.refundTagA, payoutB: ch.refundTagB, closingFee: 1_000n, nonce: 3n, final: true,
    };
    const outputs = payouts(ch, state);
    const t = await tree();
    await transact('transact: cooperative close', t, {
      token: NATIVE,
      inputs: [channelInput(t, ch.contribA, ch.refundTagA), channelInput(t, ch.contribB, ch.refundTagB)],
      outputs,
      to: [alice.keys, bob.keys, relayerParty.keys],
      channel: ch.sign(state),
    });

    const after = await tree();
    expect(after.indexOf(noteCommitment(outputs[0]))).toBeGreaterThanOrEqual(0);
    expect(after.indexOf(noteCommitment(outputs[1]))).toBeGreaterThanOrEqual(0);
    expect(await isSpent(nullifierOf(ch.params.channelSecret, noteCommitment(ch.contribA)))).toBe(true);
    expect(await isSpent(nullifierOf(ch.params.channelSecret, noteCommitment(ch.contribB)))).toBe(true);
  });

  it('runs a full dispute: answer, deadline, finalize, finalize state 0, reclaim', async () => {
    const ch1 = channel();
    const ch2 = channel();
    aliceChange = await fund('transact: channel funding (A)', alice, aliceChange, ch1.contribA);
    bobChange = await fund('transact: channel funding (B)', bob, bobChange, ch1.contribB);
    aliceChange = await fund('transact: channel funding (A)', alice, aliceChange, ch2.contribA);
    bobChange = await fund('transact: channel funding (B)', bob, bobChange, ch2.contribB);

    // Every proof is built before the first submission, against the root after the funding.
    const t = await tree();
    const contribProof = (n: NotePreimage) => t.proof(t.indexOf(noteCommitment(n)));
    const ch1State = (balA: bigint, balB: bigint, closingFee: bigint, nonce: bigint): ChannelState => ({
      contribs: [noteCommitment(ch1.contribA), noteCommitment(ch1.contribB)],
      balA, balB, payoutA: ch1.refundTagA, payoutB: ch1.refundTagB, closingFee, nonce, final: false,
    });
    const old = ch1.sign(ch1State(60_000n, 40_000n, 0n, 100n));
    const latest = ch1.sign(ch1State(45_000n, 54_000n, 1_000n, 4_000_000_200n));
    const state0 = ch2.sign({
      contribs: [noteCommitment(ch2.contribA), 0n],
      balA: 59_000n, balB: 0n, payoutA: ch2.refundTagA, payoutB: ch2.refundTagB, closingFee: 1_000n, nonce: 1n, final: false,
    });
    const submitProof = async (signed: SignedState, proofs: Parameters<typeof submitStateWitness>[0]['contribProofs']) => {
      const w = submitStateWitness({ root: t.root, channel: signed, contribProofs: proofs });
      const { proof, signals } = await prove('submit_state', w.input);
      expect(signals).toEqual(w.publicSignals);
      return [tuple<P8>(proof), tuple<S5>(signals)] as const;
    };
    const submitOld = await submitProof(old, [contribProof(ch1.contribA), contribProof(ch1.contribB)]);
    const submitLatest = await submitProof(latest, [contribProof(ch1.contribA), contribProof(ch1.contribB)]);
    const submitState0 = await submitProof(state0, [contribProof(ch2.contribA), t.emptyProof()]);

    const finalizeProof = async (ch: Channel, signed: SignedState, inputs: readonly [SpendInput, SpendInput], to: readonly [Keys, Keys, Keys]) => {
      const outputs = payouts(ch, signed.state);
      const cts = outputs.map((o, i) => ciphertextFor(to[i] as Keys, o));
      const w = finalizeWitness({
        root: t.root, token: NATIVE, inputs, outputs, channel: signed,
        extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts: cts as [Hex, Hex, Hex] }),
      });
      const { proof, signals } = await prove('finalize', w.input);
      expect(signals).toEqual(w.publicSignals);
      return { args: [tuple<P8>(proof), tuple<S9>(signals), concat(cts)] as const, outputs };
    };
    const finalize1 = await finalizeProof(ch1, latest,
      [channelInput(t, ch1.contribA, ch1.refundTagA), channelInput(t, ch1.contribB, ch1.refundTagB)],
      [alice.keys, bob.keys, relayerParty.keys]);
    const finalize2 = await finalizeProof(ch2, state0,
      [channelInput(t, ch2.contribA, ch2.refundTagA), dummyInput(NATIVE)],
      [alice.keys, bob.keys, relayerParty.keys]);

    const returned = note(39_000n, NATIVE, bob.tag);
    const reclaimOutputs = [returned, note(0n, NATIVE, bob.tag), note(1_000n, NATIVE, relayerParty.tag)] as const;
    const reclaimCts = reclaimOutputs.map((o, i) => ciphertextFor([bob.keys, bob.keys, relayerParty.keys][i] as Keys, o));
    const rw = reclaimWitness({
      root: t.root, token: NATIVE, contribution: { note: ch2.contribB, proof: contribProof(ch2.contribB) },
      refundSecret: ch2.tagSecretB, extra: dummyInput(NATIVE), params: ch2.params, outputs: reclaimOutputs,
      extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts: reclaimCts as [Hex, Hex, Hex] }),
    });
    const reclaimProof = await prove('reclaim', rw.input);
    expect(reclaimProof.signals).toEqual(rw.publicSignals);

    // Channel 1: the old state is answered by the latest; the deadline does not move.
    const cn1 = channelNullifierOf(ch1.params.channelSecret);
    const disputeOf = (cn: bigint) => client.readContract({ address: d.disputes, abi: disputesAbi, functionName: 'disputeOf', args: [cn] });
    record('submitState: start a dispute', await send(relayer, { address: d.disputes, abi: disputesAbi, functionName: 'submitState', args: submitOld }));
    const [, , , deadline] = await disputeOf(cn1);
    record('submitState: answer', await send(relayer, { address: d.disputes, abi: disputesAbi, functionName: 'submitState', args: submitLatest }));
    expect(await disputeOf(cn1)).toEqual([true, 4_000_000_200n, stateHashOf(ch1.paramsHash, latest.state), deadline]);
    // Channel 2: state 0, which lists only Alice's contribution.
    record('submitState: start a dispute (state 0)', await send(relayer, { address: d.disputes, abi: disputesAbi, functionName: 'submitState', args: submitState0 }));

    const simulateFinalize = client.simulateContract({
      address: d.disputes, abi: disputesAbi, functionName: 'finalize', args: finalize1.args, account: relayer.account,
    });
    expect(await revertName(simulateFinalize)).toBe('DeadlineNotReached');

    // anvil: move the chain clock past the window instead of waiting in real time.
    const testClient = createTestClient({ mode: 'anvil', chain: devChain, transport: http(DEVNODE_RPC) });
    await testClient.increaseTime({ seconds: Number(WINDOW) + 2 });
    await testClient.mine({ blocks: 1 });

    record('finalize', await send(relayer, { address: d.disputes, abi: disputesAbi, functionName: 'finalize', args: finalize1.args }));
    expect(await client.readContract({ address: d.disputes, abi: disputesAbi, functionName: 'isFinalized', args: [cn1] })).toBe(true);
    let after = await tree();
    expect(after.indexOf(noteCommitment(finalize1.outputs[0]))).toBeGreaterThanOrEqual(0);
    expect(after.indexOf(noteCommitment(finalize1.outputs[1]))).toBeGreaterThanOrEqual(0);

    record('finalize (state 0)', await send(relayer, { address: d.disputes, abi: disputesAbi, functionName: 'finalize', args: finalize2.args }));
    const reclaimArgs = [tuple<P8>(reclaimProof.proof), tuple<S8>(reclaimProof.signals), concat(reclaimCts)] as const;
    record('reclaim', await send(relayer, { address: d.disputes, abi: disputesAbi, functionName: 'reclaim', args: reclaimArgs }));
    after = await tree();
    expect(after.indexOf(noteCommitment(returned))).toBeGreaterThanOrEqual(0);
  });
});
