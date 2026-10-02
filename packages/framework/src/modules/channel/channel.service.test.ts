// ChannelService and DisputeService between two in-process nodes, with the real protocol rules and
// signatures but an in-memory pool, chain, relayer and P2P link (proofs are not computed).
import { zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import { noteCommitment, nullifierOf, signStateHash, type CircuitInput, type NotePreimage } from '../../shared/protocol/index.ts';
import { DisputeService, type DisputeDeps } from '../dispute/index.ts';
import { channelSecrets, derivePoolKeys, shieldedAddressOf, type PoolKeys } from '../keys/index.ts';
import type { Invite, PeerTarget, RequestHandler } from '../p2p/index.ts';
import type { RelayRequest, RelayerPort } from '../relayer/index.ts';
import { ChannelRepository } from './channel.repository.ts';
import type { ChannelRecord } from './channel.schema.ts';
import { ChannelService, type ChannelDeps, type TickProblem } from './channel.service.ts';
import { contributionCommitments, hashOf } from './channel.state.ts';

const STABLECOIN = '0x00000000000000000000000000000000000000aa';
const FEE = 10n;

const wire = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
const revert = (name: string) => new AppError(422, 'WOULD_REVERT', `The transaction would fail on-chain: ${name}`);

/** The pool and dispute contracts, reduced to their sets. */
class Ledger {
  readonly commitments = new Set<bigint>();
  readonly nullifiers = new Set<bigint>();
  readonly disputes = new Map<bigint, { pending: boolean; nonce: bigint; stateHash: bigint; deadline: bigint }>();
  readonly finalized = new Set<bigint>();
  now = 1_000n;

  settle(nullifiers: bigint[], outputs: bigint[]): void {
    if (nullifiers.some((n) => this.nullifiers.has(n))) throw revert('NullifierAlreadySpent');
    for (const n of nullifiers) this.nullifiers.add(n);
    for (const c of outputs) this.commitments.add(c);
  }
}

/** Public signals as the circuits order them, read back from the witness. */
const prover: ProverPort = {
  async prove(circuit, input: CircuitInput) {
    const one = (k: string) => input[k] as bigint;
    const many = (k: string) => input[k] as bigint[];
    const signals =
      circuit === 'transfer' ? [one('root'), one('publicAmount'), one('publicToken'), one('extDataHash'), ...many('inNullifier'), ...many('outCommitment')]
      : circuit === 'finalize' ? [one('root'), one('extDataHash'), ...many('inNullifier'), ...many('outCommitment'), one('channelNullifier'), one('stateHash')]
      : circuit === 'reclaim' ? [one('root'), one('extDataHash'), ...many('inNullifier'), ...many('outCommitment'), one('channelNullifier')]
      : [one('root'), one('channelNullifier'), one('nonce'), one('stateHash'), one('window')];
    return { proof: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], signals };
  },
};

function relayerOf(ledger: Ledger, keys: PoolKeys): RelayerPort & { submitted: RelayRequest['kind'][] } {
  const submitted: RelayRequest['kind'][] = [];
  return {
    submitted,
    info: async () => ({ chainId: 31337, shieldedAddress: shieldedAddressOf(keys), fees: { [zeroAddress]: FEE.toString(), [STABLECOIN]: '1000' } }),
    async submit(request) {
      const s = request.signals.map(BigInt);
      if (request.kind === 'transact') ledger.settle(s.slice(4, 6), s.slice(6, 9));
      if (request.kind === 'submitState') {
        const [, cn, nonce, stateHash, window] = s as [bigint, bigint, bigint, bigint, bigint];
        const d = ledger.disputes.get(cn);
        if (ledger.finalized.has(cn)) throw revert('ChannelAlreadyFinalized');
        if (d?.pending && nonce <= d.nonce) throw revert('StaleState');
        ledger.disputes.set(cn, { pending: true, nonce, stateHash, deadline: d?.pending ? d.deadline : ledger.now + window });
      }
      if (request.kind === 'finalize') {
        const [cn, stateHash] = s.slice(7) as [bigint, bigint];
        const d = ledger.disputes.get(cn);
        if (!d?.pending) throw revert('NoPendingDispute');
        if (ledger.now < d.deadline) throw revert('DeadlineNotReached');
        if (d.stateHash !== stateHash) throw revert('StateMismatch');
        ledger.settle(s.slice(2, 4), s.slice(4, 7));
        ledger.finalized.add(cn);
        d.pending = false;
      }
      if (request.kind === 'reclaim') {
        if (!ledger.finalized.has(s[7] as bigint)) throw revert('ChannelNotFinalized');
        ledger.settle(s.slice(2, 4), s.slice(4, 7));
      }
      submitted.push(request.kind);
      return { txHash: `0x${'00'.repeat(32)}` };
    },
  };
}

class FakePool {
  readonly balance = new Map<bigint, bigint>();
  private readonly adopted = new Set<bigint>();
  spendFails: AppError | null = null;
  private readonly ledger: Ledger;
  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }
  async refreshChain(): Promise<void> {}
  async sync(): Promise<void> {}
  get root(): bigint {
    return 0n;
  }
  balances(): Map<bigint, bigint> {
    return new Map(this.balance);
  }
  hasCommitment(c: bigint): boolean {
    return this.ledger.commitments.has(c);
  }
  isSpent(n: bigint): boolean {
    return this.ledger.nullifiers.has(n);
  }
  proofOf(c: bigint) {
    if (!this.hasCommitment(c)) throw new AppError(409, 'NOT_IN_POOL', 'This note is not in the pool yet');
    return { leafIndex: 0, pathElements: [] };
  }
  emptyProof() {
    return { leafIndex: 0, pathElements: [] };
  }
  async spend(args: { token: bigint; payment?: { note: NotePreimage } }): Promise<string> {
    if (this.spendFails) throw this.spendFails;
    const amount = args.payment?.note.amount ?? 0n;
    this.balance.set(args.token, (this.balance.get(args.token) ?? 0n) - amount - FEE);
    if (args.payment) this.ledger.commitments.add(noteCommitment(args.payment.note));
    return '0x';
  }
  async adopt(note: NotePreimage): Promise<boolean> {
    const c = noteCommitment(note);
    if (note.amount === 0n || !this.hasCommitment(c)) return false;
    if (!this.adopted.has(c)) this.balance.set(note.token, (this.balance.get(note.token) ?? 0n) + note.amount);
    this.adopted.add(c);
    return true;
  }
}

class FakeWallet {
  locked = false;
  private readonly sections = new Map<string, unknown>();
  private readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  activeAccount() {
    if (this.locked) throw new AppError(423, 'WALLET_LOCKED', 'The wallet is locked');
    return { id: this.id };
  }
  readSection<T>(section: string, schema: z.ZodType<T>): T | undefined {
    const value = this.sections.get(section);
    return value === undefined ? undefined : schema.parse(value);
  }
  async writeSection(section: string, value: unknown): Promise<void> {
    this.sections.set(section, value);
  }
}

function world() {
  const ledger = new Ledger();
  const handlers = new Map<string, RequestHandler>();
  const chain = {
    network: { id: 'test', chainId: 31337, stablecoin: STABLECOIN },
    windowBounds: async () => ({ min: 10n, max: 604_800n }),
    isFinalized: async (cn: bigint) => ledger.finalized.has(cn),
    disputeOf: async (cn: bigint) => ledger.disputes.get(cn) ?? { pending: false, nonce: 0n, stateHash: 0n, deadline: 0n },
    refreshDisputes: async () => undefined,
    blockTimestamp: async () => ledger.now,
  };
  const p2pOf = (peerId: string) => ({
    peerId,
    waitForRelay: async () => [`/relay/p2p-circuit/p2p/${peerId}`],
    listen: async (handler: RequestHandler) => {
      handlers.set(peerId, handler);
    },
    request: async (peer: PeerTarget, message: unknown) => {
      const handler = handlers.get(peer.peerId);
      if (!handler) throw new AppError(503, 'PEER_UNREACHABLE', 'The other party is not reachable right now');
      try {
        return wire(await handler(peerId, wire(message)));
      } catch (err) {
        if (isAppError(err)) throw new AppError(409, err.code, err.message);
        throw new AppError(409, 'INTERNAL', 'The other party could not handle the message');
      }
    },
  });
  return { ledger, chain, p2pOf, handlers };
}
type World = ReturnType<typeof world>;

async function node(w: World, name: string, deposit: bigint, options: Partial<Pick<ChannelDeps, 'approveOpen' | 'onJoined' | 'confirmPayment'>> = {}) {
  const keys = await derivePoolKeys(privateKeyToAccount(generatePrivateKey()));
  let count = 0;
  const keyRing = { poolKeys: async () => keys, newChannel: async () => ({ index: count, secrets: channelSecrets(keys, count++) }) };
  const wallet = new FakeWallet(name);
  const pool = new FakePool(w.ledger);
  pool.balance.set(0n, deposit);
  const relayer = relayerOf(w.ledger, await derivePoolKeys(privateKeyToAccount(generatePrivateKey())));
  const deps = { wallet, keys: keyRing, chain: w.chain, pool, prover, p2p: w.p2pOf(name), repository: new ChannelRepository(wallet), relayer: () => relayer, ...options };
  const channels = new ChannelService(deps as unknown as ChannelDeps);
  await channels.listen();
  const disputes = new DisputeService({ wallet, keys: keyRing, chain: w.chain, pool, prover, channels } as unknown as DisputeDeps);
  const invite: Invite = { v: 1, peerId: name, addrs: [`/relay/p2p-circuit/p2p/${name}`], shieldedAddress: shieldedAddressOf(keys) };
  return { name, keys, wallet, pool, channels, disputes, relayer, invite, balance: () => pool.balance.get(0n) ?? 0n };
}
type Node = Awaited<ReturnType<typeof node>>;

const codes = (problems: TickProblem[]) => problems.map((p) => (isAppError(p.error) ? p.error.code : String(p.error)));

/** Alice opens to Bob (who approves everything) and both tick until the channel is live. */
async function openLive(amount = 100n, peerAmount = 50n, window = 600n) {
  const w = world();
  const joined: [string, string][] = [];
  const alice = await node(w, 'alice', 1_000n);
  const bob: Node = await node(w, 'bob', 1_000n, { approveOpen: async () => true, onJoined: (id) => joined.push([id, bob.channels.get(id).status]) });
  let accepted: unknown = null;
  const opened = await alice.channels.open(bob.invite, {
    token: 0n, amount, peerAmount, window, relayer: alice.relayer,
    onAccepted: (id) => {
      accepted = { id, status: alice.channels.get(id).status, balance: alice.balance() };
    },
  });
  expect(accepted).toEqual({ id: opened.id, status: 'opening', balance: 1_000n });
  expect(joined).toEqual([[opened.id, 'opening']]);
  return { w, alice, bob, id: opened.id, opened };
}

async function live() {
  const t = await openLive();
  expect(await bob(t).channels.tick(t.bob.relayer)).toEqual([]); // Bob funds once Alice's contribution is in
  expect(await t.alice.channels.tick(t.alice.relayer)).toEqual([]);
  return t;
}
const bob = (t: { bob: Node }) => t.bob;
const sameLatest = (t: { alice: Node; bob: Node; id: string }) => {
  const a = t.alice.channels.get(t.id);
  const b = t.bob.channels.get(t.id);
  expect(hashOf(a, a.latest.state)).toBe(hashOf(b, b.latest.state));
  return a.latest.state;
};

describe('ChannelService between two nodes', () => {
  it('opens a channel both fund; it is live once both contributions are in the pool', async () => {
    const t = await live();
    expect(t.opened.status).toBe('funding');
    expect(t.alice.channels.get(t.id).status).toBe('live');
    expect(t.bob.channels.get(t.id).status).toBe('live');
    const latest = sameLatest(t);
    expect(latest).toMatchObject({ balA: 90n, balB: 50n, closingFee: FEE, final: false });
    expect(latest.nonce > t.alice.channels.get(t.id).state0.state.nonce).toBe(true);
    expect(t.alice.balance()).toBe(1_000n - 100n - FEE);
    expect(t.bob.balance()).toBe(1_000n - 50n - FEE);
  });

  it('pays both ways off-chain and refuses overspending', async () => {
    const t = await live();
    const before = t.w.ledger.commitments.size;
    await t.alice.channels.pay(t.id, 10n);
    await t.bob.channels.pay(t.id, 3n);
    await t.alice.channels.pay(t.id, 2n);
    expect(sameLatest(t)).toMatchObject({ balA: 81n, balB: 59n });
    expect(t.w.ledger.commitments.size).toBe(before);
    await expect(t.alice.channels.pay(t.id, 1_000n)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', message: 'Not enough balance in this channel' });
  });

  it('lets both simultaneous payments through', async () => {
    const t = await live();
    const historyA = t.alice.channels.get(t.id).history.length;
    const historyB = t.bob.channels.get(t.id).history.length;
    await Promise.all([t.alice.channels.pay(t.id, 1n), t.bob.channels.pay(t.id, 2n)]);
    expect(sameLatest(t)).toMatchObject({ balA: 91n, balB: 49n });
    expect(t.alice.channels.get(t.id).history.length).toBe(historyA + 2);
    expect(t.bob.channels.get(t.id).history.length).toBe(historyB + 2);
  });

  it('refuses forged proposals', async () => {
    const t = await live();
    const r = t.alice.channels.get(t.id);
    const key = channelSecrets(t.alice.keys, r.index).signingKey;
    const sign = (s: typeof r.latest.state) => signStateHash(key, hashOf(r, s));
    const latest = r.latest.state;
    const steal = { ...latest, balA: latest.balA + 1n, balB: latest.balB - 1n, nonce: latest.nonce + 1n };
    const message = (state: typeof latest, prev: typeof latest) => wire({ type: 'pay', channelId: t.id, prevHash: hashOf(r, prev), state, sig: sign(state), prevSig: sign(prev) });
    await expect(t.bob.channels.handle('alice', message(steal, latest))).rejects.toMatchObject({ code: 'PROPOSAL_REFUSED' });
    const old = { ...r.state0.state, nonce: latest.nonce + 1n };
    await expect(t.bob.channels.handle('alice', message(old, r.state0.state))).rejects.toMatchObject({
      code: 'STALE_STATE', message: 'The proposal builds on a state this side does not hold',
    });
    await expect(t.bob.channels.handle('carol', message(steal, latest))).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND', message: 'No such channel with this peer' });
    expect(sameLatest(t)).toEqual(latest);
  });

  it('keeps a payment a locked receiver did not answer and sends it first next time', async () => {
    const t = await live();
    t.bob.wallet.locked = true;
    await expect(t.alice.channels.pay(t.id, 5n)).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    expect(t.alice.channels.get(t.id).pending).not.toBeNull();
    t.bob.wallet.locked = false;
    await t.alice.channels.pay(t.id, 7n);
    expect(sameLatest(t)).toMatchObject({ balB: 62n });
    expect(t.alice.channels.get(t.id).pending).toBeNull();
  });

  it('closes cooperatively with one transfer; the other side sees it on its tick', async () => {
    const t = await live();
    await t.alice.channels.pay(t.id, 20n);
    const [a, b] = [t.alice.balance(), t.bob.balance()];
    const closed = await t.alice.channels.close(t.id, t.alice.relayer);
    expect(closed.status).toBe('closed');
    expect(closed.latest.state).toMatchObject({ final: true, balA: 70n, balB: 70n, closingFee: FEE });
    expect(t.alice.relayer.submitted).toEqual(['transact']);
    expect(await t.bob.channels.tick(t.bob.relayer)).toEqual([]);
    expect(t.bob.channels.get(t.id).status).toBe('closed');
    expect(t.alice.balance()).toBe(a + 70n);
    expect(t.bob.balance()).toBe(b + 70n);
    await expect(t.alice.channels.pay(t.id, 1n)).rejects.toMatchObject({ code: 'NOT_LIVE', message: 'The channel is not live' });
  });

  it('enforces the window bounds, the invitee’s approval and both sides’ funds', async () => {
    const w = world();
    const alice = await node(w, 'alice', 1_000n);
    const carol = await node(w, 'carol', 100n);
    const dave = await node(w, 'dave', 1_000n, { approveOpen: async () => true });
    await expect(alice.channels.open(carol.invite, { token: 0n, amount: 100n, window: 8n * 86_400n, relayer: alice.relayer })).rejects.toMatchObject({ code: 'INVALID_WINDOW' });
    await expect(alice.channels.open(carol.invite, { token: 0n, amount: 100n, peerAmount: 1n, relayer: alice.relayer })).rejects.toMatchObject({
      code: 'OPEN_DECLINED', message: 'The other party declined this channel',
    });
    await expect(carol.channels.open(dave.invite, { token: 0n, amount: 100n, relayer: carol.relayer })).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS', message: 'Not enough shielded funds to fund this channel and pay the relayer fee',
    });
    await expect(alice.channels.open(dave.invite, { token: 0n, amount: 100n, peerAmount: 1_000n, relayer: alice.relayer })).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS', message: 'The other party cannot fund its side and pay the relayer fee',
    });
    await expect(alice.channels.open(carol.invite, { token: 7n, amount: 100n, relayer: alice.relayer })).rejects.toMatchObject({ code: 'TOKEN_NOT_SUPPORTED' });
    expect(carol.channels.list()).toEqual([]);
    expect(dave.channels.list()).toEqual([]);
  });
});

describe('cancelling an unfunded opening', () => {
  async function unfunded() {
    const w = world();
    const alice = await node(w, 'alice', 1_000n);
    const bob = await node(w, 'bob', 1_000n, { approveOpen: async () => true });
    alice.pool.spendFails = new AppError(503, 'RELAYER_DOWN', 'The relayer is down');
    let id = '';
    await expect(alice.channels.open(bob.invite, { token: 0n, amount: 20n, peerAmount: 10n, window: 10n, relayer: alice.relayer, onAccepted: (c) => { id = c; } }))
      .rejects.toMatchObject({ code: 'RELAYER_DOWN' });
    return { w, alice, bob, id };
  }

  it('lets the opener cancel at once, tells the invitee, and moves no funds', async () => {
    const t = await unfunded();
    expect([t.alice.channels.get(t.id).status, t.bob.channels.get(t.id).status]).toEqual(['opening', 'opening']);
    expect(await t.alice.channels.tick(t.alice.relayer)).toEqual([]);
    expect(t.alice.channels.openerFunded(t.id)).toBe(false);
    expect(t.bob.channels.canCancel(t.id)).toBe(false);
    await expect(t.bob.channels.cancel(t.id)).rejects.toMatchObject({ code: 'NOT_CANCELLABLE' });
    expect(t.alice.channels.canCancel(t.id)).toBe(true);
    await t.alice.channels.cancel(t.id);
    expect([t.alice.channels.get(t.id).status, t.bob.channels.get(t.id).status]).toEqual(['cancelled', 'cancelled']);
    expect(t.alice.channels.canCancel(t.id)).toBe(false);
    expect([t.alice.balance(), t.bob.balance()]).toEqual([1_000n, 1_000n]);
  });

  it('lets the invitee cancel ten minutes after accepting', async () => {
    const t = await unfunded();
    await t.bob.channels.update(t.id, (r) => {
      r.createdAt = Date.now() - 11 * 60_000;
    });
    expect(t.bob.channels.canCancel(t.id)).toBe(true);
    await t.bob.channels.cancel(t.id);
    expect([t.alice.channels.get(t.id).status, t.bob.channels.get(t.id).status]).toEqual(['cancelled', 'cancelled']);
  });

  it('never makes the invitee fund before the opener’s contribution is in the pool', async () => {
    const t = await unfunded();
    await (t.alice.channels as unknown as { confirmOpening(id: string, account: string): Promise<void> }).confirmOpening(t.id, 'alice');
    expect(t.bob.channels.get(t.id).status).toBe('funding');
    expect(await t.bob.channels.tick(t.bob.relayer)).toEqual([]);
    expect(t.bob.channels.get(t.id).status).toBe('funding');
    expect(t.bob.balance()).toBe(1_000n);
  });

  it('revives a channel whose funding landed after the cancel; refused by the invitee, it is recovered with state 0', async () => {
    const t = await unfunded();
    await t.alice.channels.cancel(t.id);
    const record = t.alice.channels.get(t.id);
    t.w.ledger.commitments.add(contributionCommitments(record)[0]); // the funding lands late
    expect(await t.alice.channels.tick(t.alice.relayer)).toEqual([]);
    expect(t.alice.channels.get(t.id).status).toBe('opening');
    expect(t.alice.channels.canCancel(t.id)).toBe(false);
    expect(codes(await t.alice.channels.tick(t.alice.relayer))).toEqual(['CANCELLED']);
    await t.alice.disputes.start(t.id, t.alice.relayer);
    expect(t.alice.channels.get(t.id).status).toBe('disputing');
    t.w.ledger.now += 11n;
    expect(await t.alice.disputes.tick(t.alice.relayer)).toEqual([]);
    expect(t.alice.channels.get(t.id).status).toBe('settled');
    expect(t.alice.balance()).toBe(1_000n + 20n - FEE); // the fake pool never debited the failed funding
  });
});

describe('DisputeService', () => {
  it('A: refunds the opener with state 0 when the invitee never funds', async () => {
    const t = await openLive(20n, 10n, 10n);
    expect(t.opened.status).toBe('funding');
    const before = t.alice.balance();
    await t.alice.disputes.start(t.id, t.alice.relayer);
    expect(t.alice.channels.get(t.id).status).toBe('disputing');
    expect(await t.alice.disputes.tick(t.alice.relayer)).toEqual([]);
    expect(t.alice.channels.get(t.id).status).toBe('disputing');
    t.w.ledger.now += 10n;
    expect(await t.alice.disputes.tick(t.alice.relayer)).toEqual([]);
    expect(t.alice.channels.get(t.id).status).toBe('settled');
    expect(t.alice.balance()).toBe(before + 20n - FEE);
    expect(await t.bob.channels.tick(t.bob.relayer)).toEqual([]); // as a host ticks: channels, then disputes
    expect(await t.bob.disputes.tick(t.bob.relayer)).toEqual([]);
    expect(t.bob.channels.get(t.id).status).toBe('settled');
    expect(t.bob.relayer.submitted).toEqual([]); // he never funds a channel a dispute already settled
  });

  it('B: answers an old state with the latest; the side holding both signatures finalizes, the other adopts its payout', async () => {
    const t = await live();
    await t.alice.channels.pay(t.id, 40n);
    const latest = sameLatest(t);
    const [a, b] = [t.alice.balance(), t.bob.balance()];
    await t.alice.channels.update(t.id, (r) => {
      r.latest = { ...r.state0 }; // Alice cheats with state 0
    });
    await t.alice.disputes.start(t.id, t.alice.relayer);
    expect(await t.bob.disputes.tick(t.bob.relayer)).toEqual([]);
    expect(t.bob.channels.get(t.id).status).toBe('disputing');
    const cn = [...t.w.ledger.disputes.keys()][0] as bigint;
    expect(t.w.ledger.disputes.get(cn)?.nonce).toBe(latest.nonce);
    t.w.ledger.now += 600n;
    expect(await t.alice.disputes.tick(t.alice.relayer)).toEqual([]); // cannot finalize Bob's state, need not
    expect(t.alice.channels.get(t.id).status).toBe('disputing');
    expect(await t.bob.disputes.tick(t.bob.relayer)).toEqual([]);
    expect(t.bob.channels.get(t.id).status).toBe('settled');
    expect(await t.alice.disputes.tick(t.alice.relayer)).toEqual([]);
    expect(t.alice.channels.get(t.id).status).toBe('settled');
    expect(t.alice.balance()).toBe(a + latest.balA);
    expect(t.bob.balance()).toBe(b + latest.balB);
  });

  it('C: a missed window settles state 0; the invitee reclaims its left-out contribution', async () => {
    const t = await live();
    await t.alice.channels.pay(t.id, 10n);
    const a = t.alice.balance();
    await t.alice.channels.update(t.id, (r) => {
      r.latest = { ...r.state0 };
    });
    await t.alice.disputes.start(t.id, t.alice.relayer);
    t.w.ledger.now += 600n;
    expect(await t.alice.disputes.tick(t.alice.relayer)).toEqual([]);
    expect(t.alice.channels.get(t.id).status).toBe('settled');
    expect(t.alice.balance()).toBe(a + 90n);
    expect(await t.bob.disputes.tick(t.bob.relayer)).toEqual([]);
    const r: ChannelRecord = t.bob.channels.get(t.id);
    expect(r.status).toBe('settled');
    expect(t.bob.relayer.submitted).toEqual(['reclaim']);
    expect(t.w.ledger.nullifiers.has(nullifierOf(r.params.channelSecret, contributionCommitments(r)[1]))).toBe(true);
  });
});
