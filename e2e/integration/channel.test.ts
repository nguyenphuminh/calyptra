// Channels against real contracts (all-ref §10.7.3-§10.7.6, §6.11.7-6.11.8): opening, payments,
// cooperative close, failed fundings and cancellation, and the dispute scenarios A, B, C plus the
// privacy rule of dispute watching. Alice opens (side A), Bob joins (side B, approves everything),
// Carol joins only channels that ask nothing of her. Tests run in order and share the three users.
// Dispute windows pass by moving the dev chain's clock (§10 porting notes), not by sleeping.
import type { Libp2p } from '@libp2p/interface';
import { parseEther } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRelayNode } from '../../packages/framework/src/libp2p.node.ts';
import { ChainAdapter, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { balanceOf, hashOf, type TickProblem } from '../../packages/framework/src/modules/channel/index.ts';
import { channelSecrets, shieldedAddressOf } from '../../packages/framework/src/modules/keys/index.ts';
import { decodeInvite, encodeInvite, type Invite } from '../../packages/framework/src/modules/p2p/index.ts';
import type { RelayRequest, RelayerPort } from '../../packages/framework/src/modules/relayer/index.ts';
import { AppError } from '../../packages/framework/src/shared/errors/AppError.ts';
import { channelNullifierOf, signStateHash, type ChannelState } from '../../packages/framework/src/shared/protocol/index.ts';
import { freshDeployment, warp } from './chain.ts';
import { PASSWORD, code, devNetwork, newChannelNode, newRelayer, newUser, until, type ChannelNode, type Relayer, type User } from './services.ts';

const FEE = 10n ** 14n;            // 0.0001 MON
const FEE_STABLE = 10_000n;        // 0.01 AUSD
const NATIVE = 0n;
const mon = (amount: string): bigint => parseEther(amount);

let network: NetworkConfig;
let chain: ChainAdapter;
let relayer: Relayer;
let relay: Libp2p;
let relayAddr: string;
let alice: User;
let bob: User;
let carol: User;
let a: ChannelNode;
let b: ChannelNode;
let c: ChannelNode;
const bobJoins: { channelId: string; status: string }[] = [];

const shielded = (u: User): bigint => u.pool.balances().get(NATIVE) ?? 0n;
const inviteOf = async (node: ChannelNode, user: User): Promise<Invite> =>
  decodeInvite(encodeInvite(node.p2p.invite(shieldedAddressOf(await user.keys.poolKeys()))));
const latestHash = (node: ChannelNode, id: string): bigint => {
  const r = node.channels.get(id);
  return hashOf(r, r.latest.state);
};
const sameLatest = (id: string): void => expect(latestHash(a, id)).toBe(latestHash(b, id));
/** The window passes: the chain's clock moves past the deadline and a block is mined at the new time. */
const passDeadline = (window: bigint): Promise<void> => warp(Number(window) + 2);
/** One background step as a host runs it: channel progress, then dispute watching. */
const tick = async (node: ChannelNode): Promise<TickProblem[]> => [
  ...(await node.channels.tick(relayer.port)),
  ...(await node.disputes.tick(relayer.port)),
];
const problemsFor = (problems: TickProblem[], id: string): TickProblem[] => problems.filter((p) => p.channelId === id);
const codes = (problems: TickProblem[]): string[] => problems.map((p) => (p.error instanceof AppError ? p.error.code : String(p.error)));

/** Alice opens a channel to Bob, Bob funds on his tick, both become live (§10.7.3 `openLive`). */
async function openLive(window: bigint, amount = mon('0.1'), peerAmount = mon('0.05')): Promise<string> {
  const before = shielded(alice);
  let accepted: { channelId: string; status: string; balance: bigint } | null = null;
  const record = await a.channels.open(await inviteOf(b, bob), {
    token: NATIVE, amount, peerAmount, window, relayer: relayer.port,
    onAccepted: (channelId) => {
      accepted = { channelId, status: a.channels.get(channelId).status, balance: shielded(alice) };
    },
  });
  const id = record.id;
  // A hears of the acceptance once the channel is saved, before funding.
  expect(accepted).toEqual({ channelId: id, status: 'opening', balance: before });
  expect(bobJoins.at(-1)).toEqual({ channelId: id, status: 'opening' });
  expect(await b.channels.tick(relayer.port)).toEqual([]); // Bob funds
  expect(await a.channels.tick(relayer.port)).toEqual([]);
  expect(a.channels.get(id).status).toBe('live');
  expect(b.channels.get(id).status).toBe('live');
  return id;
}

beforeAll(async () => {
  const d = await freshDeployment();
  network = devNetwork(d);
  chain = new ChainAdapter(network);
  // The relayer is another host: its own chain adapter, so the users' RPC traffic is theirs alone (INT-DW).
  relayer = await newRelayer(network, new ChainAdapter(network), { native: FEE, stable: FEE_STABLE });
  relay = await createRelayNode({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] });
  relayAddr = String(relay.getMultiaddrs()[0]);
  [alice, bob, carol] = await Promise.all([newUser(network, chain, '3'), newUser(network, chain, '2'), newUser(network, chain, '1')]);
  await alice.pool.deposit(NATIVE, mon('1'));
  await bob.pool.deposit(NATIVE, mon('0.5'));
  await carol.pool.deposit(NATIVE, mon('0.2'));
  [a, b, c] = await Promise.all([
    newChannelNode(alice, chain, relayAddr, relayer.port),
    newChannelNode(bob, chain, relayAddr, relayer.port, {
      approveOpen: async () => true,
      onJoined: (channelId) => bobJoins.push({ channelId, status: b.channels.get(channelId).status }),
    }),
    newChannelNode(carol, chain, relayAddr, relayer.port),
  ]);
});

afterAll(async () => {
  await Promise.all([a, b, c].filter(Boolean).map((node) => node.p2p.stop()));
  await relay?.stop();
});

describe('a channel from opening to cooperative close', () => {
  let id: string;

  it('INT-C1: both fund; the channel goes live only after both contributions; funding pays a relayer fee', async () => {
    await bob.pool.sync();
    const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
    id = await openLive(600n);
    const ra = a.channels.get(id);
    expect(ra.latest.state.nonce).toBeGreaterThan(ra.state0.state.nonce);
    expect(ra.latest.state).toMatchObject({ balA: mon('0.1') - FEE, balB: mon('0.05'), closingFee: FEE, final: false });
    sameLatest(id);
    expect(shielded(alice)).toBe(aliceBefore - mon('0.1') - FEE);
    await bob.pool.sync();
    expect(shielded(bob)).toBe(bobBefore - mon('0.05') - FEE);
  });

  it('INT-C2: payments go both ways off-chain only; overspending is refused', async () => {
    const block = await chain.latestBlock();
    await a.channels.pay(id, mon('0.01'));
    await b.channels.pay(id, mon('0.003'));
    await a.channels.pay(id, mon('0.002'));
    sameLatest(id);
    expect(a.channels.get(id).latest.state).toMatchObject({ balA: mon('0.1') - FEE - mon('0.009'), balB: mon('0.059') });
    expect(await chain.latestBlock()).toBe(block); // no transaction
    await expect(a.channels.pay(id, mon('5'))).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', message: 'Not enough balance in this channel' });
  });

  it('INT-C3: simultaneous proposals on the same state both go through', async () => {
    const [ra, rb] = [a.channels.get(id), b.channels.get(id)];
    await Promise.all([a.channels.pay(id, 1000n), b.channels.pay(id, 2500n)]);
    sameLatest(id);
    expect(b.channels.get(id).latest.state.balB - rb.latest.state.balB).toBe(-1500n);
    expect(a.channels.get(id).history.length - ra.history.length).toBe(2);
    expect(b.channels.get(id).history.length - rb.history.length).toBe(2);
  });

  it('INT-C4: refuses lowering proposals, proposals on an old state and messages from another peer', async () => {
    const r = a.channels.get(id);
    const key = channelSecrets(await alice.keys.poolKeys(), r.index).signingKey;
    const proposal = (prev: ChannelState, state: ChannelState, prevSig: unknown) => ({
      type: 'pay', channelId: id, prevHash: hashOf(r, prev), state, sig: signStateHash(key, hashOf(r, state)), prevSig,
    });
    const latest = r.latest.state;
    const steal = proposal(latest, { ...latest, balA: latest.balA + 1n, balB: latest.balB - 1n, nonce: latest.nonce + 1n }, r.latest.sigA);
    const stale = proposal(r.state0.state, { ...r.state0.state, nonce: latest.nonce + 1n }, r.state0.sigA);
    const [beforeA, beforeB] = [latestHash(a, id), latestHash(b, id)];
    expect(await code(b.channels.handle(a.p2p.peerId, steal))).toBe('PROPOSAL_REFUSED');
    await expect(b.channels.handle(a.p2p.peerId, stale)).rejects.toMatchObject({
      code: 'STALE_STATE', message: 'The proposal builds on a state this side does not hold',
    });
    await expect(b.channels.handle(c.p2p.peerId, steal)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND', message: 'No such channel with this peer' });
    expect([latestHash(a, id), latestHash(b, id)]).toEqual([beforeA, beforeB]);
  });

  it('INT-C5: a locked receiver signs nothing; the unanswered proposal is re-sent before the next one', async () => {
    const balB = b.channels.get(id).latest.state.balB;
    bob.wallet.lock();
    bob.keys.clear();
    expect(await code(a.channels.pay(id, 500n))).toBe('WALLET_LOCKED');
    expect(a.channels.get(id).pending).not.toBeNull();
    await bob.wallet.unlock(PASSWORD);
    await a.channels.pay(id, 700n);
    expect(b.channels.get(id).latest.state.balB).toBe(balB + 1200n);
    expect(a.channels.get(id).pending).toBeNull();
    sameLatest(id);
  });

  it('INT-C6: one transfer pays both sides and exactly the closing fee to the relayer; both find their payouts', async () => {
    await Promise.all([alice.pool.sync(), bob.pool.sync(), relayer.user.pool.sync()]);
    const [aliceBefore, bobBefore, relayerBefore] = [shielded(alice), shielded(bob), shielded(relayer.user)];
    const closed = await a.channels.close(id, relayer.port);
    expect(closed.status).toBe('closed');
    expect(closed.latest.state.final).toBe(true);
    expect(await b.channels.tick(relayer.port)).toEqual([]);
    expect(b.channels.get(id).status).toBe('closed');
    await relayer.user.pool.sync();
    const { balA, balB, closingFee } = closed.latest.state;
    expect(shielded(alice)).toBe(aliceBefore + balA);
    expect(shielded(bob)).toBe(bobBefore + balB);
    expect(shielded(relayer.user)).toBe(relayerBefore + closingFee);
    await expect(a.channels.pay(id, 1n)).rejects.toMatchObject({ code: 'NOT_LIVE', message: 'The channel is not live' });
  });
});

describe('opening refusals', () => {
  it('INT-C7: the window must be within the contract bounds; the default policy declines channels asking for funds', async () => {
    const tooLong = a.channels.open(await inviteOf(b, bob), { token: NATIVE, amount: mon('0.01'), window: 8n * 86_400n, relayer: relayer.port });
    expect(await code(tooLong)).toBe('INVALID_WINDOW');
    const asking = a.channels.open(await inviteOf(c, carol), { token: NATIVE, amount: mon('0.01'), peerAmount: 1n, relayer: relayer.port });
    await expect(asking).rejects.toMatchObject({ code: 'OPEN_DECLINED', message: 'The other party declined this channel' });
  });

  it('INT-C8: a side opens or joins only if it can also pay the funding fee; the invitee saves nothing otherwise', async () => {
    await Promise.all([bob.pool.sync(), carol.pool.sync()]);
    const count = b.channels.list().length;
    const all = c.channels.open(await inviteOf(b, bob), { token: NATIVE, amount: shielded(carol), relayer: relayer.port });
    await expect(all).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS', message: 'Not enough shielded funds to fund this channel and pay the relayer fee',
    });
    expect(b.channels.list()).toHaveLength(count); // Bob never heard of it
    const asking = a.channels.open(await inviteOf(b, bob), { token: NATIVE, amount: mon('0.01'), peerAmount: shielded(bob), relayer: relayer.port });
    await expect(asking).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS', message: 'The other party cannot fund its side and pay the relayer fee',
    });
    expect(b.channels.list()).toHaveLength(count);
  });

  it('an approval that comes too late: the opener times out having saved nothing; the invitee may cancel its record after ten minutes', async () => {
    // §6: the approval must come within the P2P timeout (60 s; shortened here, as the P2P tests do).
    const [dan, erin] = await Promise.all([newUser(network, chain), newUser(network, chain)]);
    await dan.pool.deposit(NATIVE, mon('0.1'));
    const approvals: string[] = [];
    const [d, e] = await Promise.all([
      newChannelNode(dan, chain, relayAddr, relayer.port, {}, { timeoutMs: 2_000 }),
      newChannelNode(erin, chain, relayAddr, relayer.port, {
        approveOpen: async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          approvals.push(request.channelId);
          return true;
        },
      }),
    ]);
    try {
      const before = shielded(dan);
      const opening = d.channels.open(await inviteOf(e, erin), { token: NATIVE, amount: mon('0.01'), window: 10n, relayer: relayer.port });
      await expect(opening).rejects.toMatchObject({ code: 'PEER_TIMEOUT', message: 'The other party did not answer in time' });
      expect(d.channels.list()).toEqual([]);
      await until(() => approvals.length === 1 && e.channels.list().length === 1, 15_000, 'the late approval');
      const late = e.channels.get(approvals[0] ?? '');
      expect(late.status).toBe('opening');
      expect(e.channels.canCancel(late.id)).toBe(false);
      await e.channels.update(late.id, (r) => {
        r.createdAt = Date.now() - 11 * 60_000;
      });
      await e.channels.cancel(late.id);
      expect(e.channels.get(late.id).status).toBe('cancelled');
      await dan.pool.sync();
      expect(shielded(dan)).toBe(before);
    } finally {
      await Promise.all([d.p2p.stop(), e.p2p.stop()]);
    }
  });
});

describe('fundings that fail, and cancellation', () => {
  const down: RelayerPort = {
    info: () => relayer.port.info(),
    submit: () => Promise.reject(new AppError(503, 'RELAYER_DOWN', 'The relayer is down')),
  };

  /** Alice opens (0.02, Bob 0.01, window 10) but her funding fails: both sides are stuck in `opening`. */
  async function openUnfunded(port: RelayerPort): Promise<string> {
    let id = '';
    const opening = a.channels.open(await inviteOf(b, bob), {
      token: NATIVE, amount: mon('0.02'), peerAmount: mon('0.01'), window: 10n, relayer: port,
      onAccepted: (channelId) => { id = channelId; },
    });
    expect(await code(opening)).toBe('RELAYER_DOWN');
    expect(a.channels.get(id).status).toBe('opening');
    expect(b.channels.get(id).status).toBe('opening');
    return id;
  }

  it('INT-F1: the opener may cancel a stuck opening at once, the invitee is told, nothing left any balance', async () => {
    await Promise.all([alice.pool.sync(), bob.pool.sync()]);
    const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
    const id = await openUnfunded(down);
    expect(problemsFor(await a.channels.tick(relayer.port), id)).toEqual([]);
    expect(a.channels.openerFunded(id)).toBe(false);
    expect(b.channels.canCancel(id)).toBe(false);
    expect(await code(b.channels.cancel(id))).toBe('NOT_CANCELLABLE');
    expect(a.channels.canCancel(id)).toBe(true);
    await a.channels.cancel(id);
    expect(a.channels.get(id).status).toBe('cancelled');
    expect(b.channels.get(id).status).toBe('cancelled');
    expect(a.channels.canCancel(id)).toBe(false);
    await Promise.all([alice.pool.sync(), bob.pool.sync()]);
    expect([shielded(alice), shielded(bob)]).toEqual([aliceBefore, bobBefore]);
  });

  it('INT-F2: the invitee never funds before the opener’s contribution is in the pool, even if told otherwise', async () => {
    await bob.pool.sync();
    const bobBefore = shielded(bob);
    const id = await openUnfunded(down);
    const misbehaving = a.channels as unknown as { confirmOpening(id: string, accountId: string): Promise<void> };
    await misbehaving.confirmOpening(id, alice.wallet.activeAccount().id);
    expect(b.channels.get(id).status).toBe('funding');
    expect(problemsFor(await tick(b), id)).toEqual([]);
    await bob.pool.sync();
    expect(shielded(bob)).toBe(bobBefore);
    expect(b.channels.get(id).status).toBe('funding');
  });

  it('INT-F3: the invitee may cancel ten minutes after accepting; the opener is told', async () => {
    const id = await openUnfunded(down);
    await b.channels.update(id, (r) => {
      r.createdAt = Date.now() - 11 * 60_000;
    });
    expect(b.channels.canCancel(id)).toBe(true);
    await b.channels.cancel(id);
    expect(b.channels.get(id).status).toBe('cancelled');
    expect(a.channels.get(id).status).toBe('cancelled');
  });

  it('INT-F4: a funding that lands after the cancel brings the channel back; refused by the peer, it is recovered with state 0', async () => {
    await alice.pool.sync();
    const before = shielded(alice);
    let captured: RelayRequest | null = null;
    const lossy: RelayerPort = {
      info: () => relayer.port.info(),
      submit: async (request) => {
        captured = request;
        throw new AppError(503, 'RELAYER_DOWN', 'The relayer is down'); // the answer is lost
      },
    };
    let id = '';
    const opening = a.channels.open(await inviteOf(b, bob), {
      token: NATIVE, amount: mon('0.02'), window: 10n, relayer: lossy, onAccepted: (channelId) => { id = channelId; },
    });
    expect(await code(opening)).toBe('RELAYER_DOWN');
    await a.channels.cancel(id);
    expect(b.channels.get(id).status).toBe('cancelled');
    if (!captured) throw new Error('the funding request was not captured');
    await relayer.port.submit(captured); // the funding lands after all

    expect(problemsFor(await a.channels.tick(relayer.port), id)).toEqual([]);
    expect(a.channels.get(id).status).toBe('opening');
    expect(a.channels.openerFunded(id)).toBe(true);
    expect(a.channels.canCancel(id)).toBe(false);
    expect(await code(a.channels.cancel(id))).toBe('NOT_CANCELLABLE');
    const refused = problemsFor(await a.channels.tick(relayer.port), id);
    expect(codes(refused)).toEqual(['CANCELLED']);
    expect(refused[0]?.error).toMatchObject({ message: 'This channel was cancelled' });

    await a.disputes.start(id, relayer.port);
    expect(a.channels.get(id).status).toBe('disputing');
    await passDeadline(10n);
    expect(await tick(a)).toEqual([]);
    expect(a.channels.get(id).status).toBe('settled');
    await alice.pool.sync();
    expect(shielded(alice)).toBe(before - 2n * FEE); // the funding fee and the closing fee
  });
});

describe('unilateral close', () => {
  it('INT-DA: the invitee never funds; the opener recovers its contribution with state 0 after the window', async () => {
    await bob.pool.sync();
    const bobBefore = shielded(bob);
    const opened = await a.channels.open(await inviteOf(b, bob), {
      token: NATIVE, amount: mon('0.02'), peerAmount: mon('0.01'), window: 10n, relayer: relayer.port,
    });
    const id = opened.id;
    expect(opened.status).toBe('funding');
    const before = shielded(alice);
    await a.disputes.start(id, relayer.port);
    expect(a.channels.get(id).status).toBe('disputing');
    expect(await tick(a)).toEqual([]);
    expect(a.channels.get(id).status).toBe('disputing');
    await passDeadline(10n);
    expect(await tick(a)).toEqual([]);
    expect(a.channels.get(id).status).toBe('settled');
    expect(shielded(alice)).toBe(before + mon('0.02') - FEE); // submitting the state is free; the closing fee is not
    expect(await tick(b)).toEqual([]);
    expect(b.channels.get(id).status).toBe('settled');
    await bob.pool.sync();
    expect(shielded(bob)).toBe(bobBefore); // nothing of Bob's was ever in the channel
  });

  it('INT-DB: an old state is answered with the latest; the side holding both signatures finalizes, the other adds its payout', async () => {
    const id = await openLive(25n);
    await a.channels.pay(id, mon('0.04'));
    const latest = b.channels.get(id).latest.state;
    await Promise.all([alice.pool.sync(), bob.pool.sync()]);
    const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
    await a.channels.update(id, (r) => {
      r.latest = r.state0; // Alice cheats with state 0
    });
    await a.disputes.start(id, relayer.port);
    expect(await tick(b)).toEqual([]); // Bob answers with the latest state
    expect(b.channels.get(id).status).toBe('disputing');
    await passDeadline(25n);
    expect(await tick(a)).toEqual([]); // Alice cannot finalize Bob's state, and need not
    expect(a.channels.get(id).status).toBe('disputing');
    expect(await tick(b)).toEqual([]);
    expect(b.channels.get(id).status).toBe('settled');
    expect(await tick(a)).toEqual([]);
    expect(a.channels.get(id).status).toBe('settled');
    await Promise.all([alice.pool.sync(), bob.pool.sync()]);
    expect(shielded(alice)).toBe(aliceBefore + latest.balA);
    expect(shielded(bob)).toBe(bobBefore + latest.balB);
  });

  it('INT-DC: the other side misses the window; it later reclaims its contribution, losing what it was paid', async () => {
    const id = await openLive(10n, mon('0.03'), mon('0.02'));
    await a.channels.pay(id, mon('0.01'));
    await Promise.all([alice.pool.sync(), bob.pool.sync()]);
    const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
    await a.channels.update(id, (r) => {
      r.latest = r.state0;
    });
    await a.disputes.start(id, relayer.port);
    await passDeadline(10n); // Bob is away the whole window
    expect(await tick(a)).toEqual([]);
    expect(a.channels.get(id).status).toBe('settled');
    expect(shielded(alice)).toBe(aliceBefore + mon('0.03') - FEE);
    expect(await tick(b)).toEqual([]); // Bob comes back
    const rb = b.channels.get(id);
    expect(rb.status).toBe('settled');
    await bob.pool.sync();
    expect(shielded(bob)).toBe(bobBefore + mon('0.02') - FEE); // his contribution minus the reclaim fee
    expect(balanceOf(rb.latest.state, 1)).toBe(mon('0.03')); // the 0.01 he was owed is lost
  });

  it('INT-DW: dispute watching never names the channel to the RPC provider', async () => {
    const id = await openLive(10n);
    const nullifier = channelNullifierOf(a.channels.get(id).params.channelSecret).toString();
    const watched = ['readContract', 'getContractEvents', 'getLogs', 'getBlockNumber', 'getBlock', 'call'] as const;
    const serialized = (args: unknown[]): string => JSON.stringify(args, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    async function spiedTicks(): Promise<string[]> {
      const spies = watched.map((method) => vi.spyOn(chain.client, method));
      try {
        for (const step of [() => a.channels.tick(relayer.port), () => a.disputes.tick(relayer.port), () => b.channels.tick(relayer.port), () => b.disputes.tick(relayer.port)]) {
          expect(await step()).toEqual([]);
        }
        return spies.flatMap((spy) => spy.mock.calls.map((args) => serialized(args)));
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }
    const quiet = await spiedTicks();
    await b.disputes.start(id, relayer.port);
    const pending = await spiedTicks();
    expect(quiet.length).toBeGreaterThan(0);
    expect(pending.length).toBeGreaterThan(0);
    for (const args of [...quiet, ...pending]) expect(args).not.toContain(nullifier);
    expect(a.channels.get(id).status).toBe('disputing');
    expect(b.channels.get(id).status).toBe('disputing');
    await passDeadline(10n);
    expect(await tick(a)).toEqual([]);
    expect(await tick(b)).toEqual([]);
    expect(a.channels.get(id).status).toBe('settled');
    expect(b.channels.get(id).status).toBe('settled');
  });
});
