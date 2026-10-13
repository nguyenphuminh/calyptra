// Per-second subscriptions against real contracts: a subscriber and a merchant built
// as hosts build them (the `Calyptra` facade; the merchant sells EchoServicePort, a fake service that
// echoes each prompt), one in-process relayer and one libp2p relay. Covered: subscribe, ten paid ticks,
// pause, resume, end (the cooperative close); the allowance running out; the merchant going offline
// mid-session. Tests run in order and share both nodes.
import type { Libp2p } from '@libp2p/interface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Calyptra } from '../../packages/framework/src/calyptra.ts';
import { createRelayNode } from '../../packages/framework/src/libp2p.node.ts';
import { ChainAdapter, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { balanceOf, hashOf } from '../../packages/framework/src/modules/channel/index.ts';
import { shieldedAddressOf } from '../../packages/framework/src/modules/keys/index.ts';
import {
  EchoServicePort,
  MerchantMessageSchema,
  OfferSchema,
  SERVICE_PROTOCOL,
  decodeMerchantCard,
  encodeMerchantCard,
  type MerchantCard,
  type MerchantMessage,
} from '../../packages/framework/src/modules/merchant/index.ts';
import { encodeInvite } from '../../packages/framework/src/modules/p2p/index.ts';
import type { SessionEvents, StopReason } from '../../packages/framework/src/modules/subscription/index.ts';
import { freshDeployment, warp } from './chain.ts';
import { devNetwork, newCalyptra, newRelayer, until, type Relayer } from './services.ts';

const FEE_STABLE = 10_000n;                 // 0.01 AUSD relayer fee
const RATE = 100_000n;                      // test price: 0.10 AUSD per second
const offer = OfferSchema.parse({ kind: 'ai-chat', title: 'Echo test service', token: 'stablecoin', ratePerSecond: '100000', minFunding: '1000000', graceSeconds: 3 });

let network: NetworkConfig;
let STABLE: bigint;
let relayer: Relayer;
let relay: Libp2p;
let merchant: Calyptra;
let subscriber: Calyptra;
let card: MerchantCard;
/** Payments the subscriber's host was asked to confirm (it declines all of them). */
const asked: { channelId: string; token: bigint; amount: bigint }[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const stableOf = (node: Calyptra): bigint => node.pool.balances().get(STABLE) ?? 0n;

/** What the subscriber's app hears in one session. */
interface Heard { messages: MerchantMessage[]; stops: { reason: StopReason; error?: unknown }[] }
const heard = (): Heard => ({ messages: [], stops: [] });
const listener = (h: Heard): SessionEvents => ({
  onMessage: (m) => h.messages.push(m),
  onStop: (reason, error) => h.stops.push({ reason, error }),
});
const replyTo = (h: Heard, id: string): string => h.messages.map((m) => (m.type === 'chunk' && m.id === id ? m.text : '')).join('');
const answered = (h: Heard, id: string): boolean => h.messages.some((m) => m.type === 'done' && m.id === id);
const paidSoFar = (id: string): bigint => subscriber.subscriptions.get(id)?.paid ?? 0n;
const historyOf = (id: string): number => subscriber.channels.get(id).history.length;
const sameLatest = (id: string): void => {
  const [s, m] = [subscriber.channels.get(id), merchant.channels.get(id)];
  expect(hashOf(m, m.latest.state)).toBe(hashOf(s, s.latest.state));
};

beforeAll(async () => {
  const d = await freshDeployment();
  network = devNetwork(d);
  STABLE = BigInt(d.stablecoin);
  relayer = await newRelayer(network, new ChainAdapter(network), { native: 10n ** 14n, stable: FEE_STABLE });
  relay = await createRelayNode({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] });
  const libp2pRelays = [String(relay.getMultiaddrs()[0])];
  [merchant, subscriber] = await Promise.all([
    newCalyptra(network, { libp2pRelays, relayers: [relayer.port], merchant: { offer, service: new EchoServicePort() } }),
    newCalyptra(network, {
      native: '1', stable: 20_000_000n, libp2pRelays, relayers: [relayer.port],
      confirmPayment: async (payment) => {
        asked.push(payment);
        return false;
      },
    }),
  ]);
  await subscriber.pool.deposit(STABLE, 20_000_000n);
  // The merchant's card, as the desktop client's merchant mode hands it out.
  await merchant.p2p.waitForRelay();
  const invite = encodeInvite(merchant.p2p.invite(shieldedAddressOf(await merchant.keys.poolKeys())));
  card = decodeMerchantCard(encodeMerchantCard({ v: 1, name: offer.title, invite, offer }));
  await subscriber.p2p.waitForRelay();
});

afterAll(async () => {
  await Promise.all([merchant?.stop(), subscriber?.stop()]);
  await relay?.stop();
});

describe('per-second subscriptions', () => {
  it('subscribe, 10 paid ticks, pause, resume, end', async () => {
    await subscriber.pool.sync();
    const before = stableOf(subscriber);
    const sub = await subscriber.subscriptions.subscribe(card, 5_000_000n, subscriber.relayer());
    const id = sub.channelId;
    // The subscriber funds the allowance (its closing fee included); the merchant funds nothing.
    expect(sub).toEqual({ channelId: id, merchant: offer.title, ratePerSecond: RATE, cap: 5_000_000n - FEE_STABLE, paid: 0n });
    expect(stableOf(subscriber)).toBe(before - 5_000_000n - FEE_STABLE);
    expect(merchant.channels.get(id)).toMatchObject({ role: 'B', contribB: null });

    const h = heard();
    await subscriber.subscriptions.start(id, listener(h));
    expect(subscriber.subscriptions.isActive(id)).toBe(true);
    const start = historyOf(id);
    const first = await subscriber.subscriptions.prompt(id, 'hello paid world');
    await until(() => answered(h, first), 30_000, 'the reply');
    expect(replyTo(h, first)).toBe('hello paid world');
    await until(() => historyOf(id) - start >= 10, 60_000, 'ten paid ticks');

    await subscriber.subscriptions.pause(id);
    expect(subscriber.subscriptions.isActive(id)).toBe(false);
    expect(h.stops.map((s) => s.reason)).toEqual(['pause']);
    const paid = paidSoFar(id);
    const latest = subscriber.channels.get(id).latest.state;
    expect(paid).toBe(balanceOf(subscriber.channels.get(id).state0.state, 0) - latest.balA);
    expect(paid).toBeGreaterThanOrEqual(10n * RATE); // every second paid, catching up after a slow round trip
    expect(paid % RATE).toBe(0n);
    sameLatest(id);
    expect(merchant.merchant?.gate(id).paidSeconds).toBe(paid / RATE);
    expect(asked).toEqual([]); // every tick was signed without asking: the allowance covers it

    // Paused: no payments, and no service.
    const pausedHistory = historyOf(id);
    const second = await subscriber.subscriptions.prompt(id, 'asked while paused');
    await sleep(2500);
    expect(historyOf(id)).toBe(pausedHistory);
    expect(paidSoFar(id)).toBe(paid);
    expect(replyTo(h, second)).toBe('');

    // Resumed: payments go on and the waiting prompt is answered.
    await subscriber.subscriptions.start(id, listener(h));
    await until(() => answered(h, second), 30_000, 'the reply after resuming');
    expect(replyTo(h, second)).toBe('asked while paused');
    await until(() => historyOf(id) - pausedHistory >= 2, 30_000, 'payments after resuming');

    // End: the baseline cooperative close, with its closing fee.
    await Promise.all([merchant.pool.sync(), relayer.user.pool.sync()]);
    const [merchantBefore, relayerBefore] = [stableOf(merchant), relayer.user.pool.balances().get(STABLE) ?? 0n];
    const closed = await subscriber.subscriptions.end(id, subscriber.relayer());
    expect(closed.status).toBe('closed');
    expect(h.stops.map((s) => s.reason)).toEqual(['pause', 'end']);
    const final = closed.latest.state;
    expect(final.balB).toBe(paidSoFar(id));
    expect(await merchant.tick()).toEqual([]);
    expect(merchant.channels.get(id).status).toBe('closed');
    await relayer.user.pool.sync();
    expect(stableOf(subscriber)).toBe(before - 5_000_000n - FEE_STABLE + final.balA);
    expect(stableOf(merchant)).toBe(merchantBefore + final.balB);
    expect(relayer.user.pool.balances().get(STABLE)).toBe(relayerBefore + final.closingFee);
  });

  it('allowance exhausted: the ticker stops at the cap; the merchant serves unpaid time only within the grace', async () => {
    await subscriber.pool.sync();
    const before = stableOf(subscriber);
    const sub = await subscriber.subscriptions.subscribe(card, 1_000_000n, subscriber.relayer());
    const id = sub.channelId;
    expect(sub.cap).toBe(990_000n); // 9.9 seconds at the test price
    const h = heard();
    await subscriber.subscriptions.start(id, listener(h));
    await until(() => h.stops.length > 0, 60_000, 'the allowance to run out');
    expect(h.stops.map((s) => s.reason)).toEqual(['cap']);
    expect(paidSoFar(id)).toBe(sub.cap);
    expect(subscriber.channels.get(id).latest.state).toMatchObject({ balA: 0n, balB: sub.cap });
    sameLatest(id);
    expect(merchant.merchant?.gate(id).paidSeconds).toBe(9n);

    // Past the allowance nothing is signed without asking: the host is asked, and declines.
    await expect(subscriber.channels.pay(id, 1n)).rejects.toMatchObject({ code: 'PAYMENT_DECLINED', message: 'The payment was not confirmed' });
    expect(asked).toEqual([{ channelId: id, token: STABLE, amount: 1n }]);

    // A session that keeps going without paying gets the grace seconds, then `insufficient` and no output.
    const raw = await subscriber.p2p.openSession(subscriber.channels.get(id).peer, SERVICE_PROTOCOL);
    const rawHeard: MerchantMessage[] = [];
    void (async () => {
      for await (const m of raw.messages()) rawHeard.push(MerchantMessageSchema.parse(m));
    })();
    await raw.send({ type: 'start', channelId: id });
    await sleep(4000); // served time passes paid time + grace
    await raw.send({ type: 'prompt', id: 'unpaid', text: 'serve me for free' });
    await until(() => rawHeard.some((m) => m.type === 'insufficient'), 30_000, 'the payment gate to close');
    const shortfall = rawHeard.find((m): m is Extract<MerchantMessage, { type: 'insufficient' }> => m.type === 'insufficient');
    expect(shortfall?.paidSeconds).toBe(9);
    expect(shortfall?.servedSeconds).toBeGreaterThan(9 + offer.graceSeconds); // paid < served - grace
    await sleep(1000);
    expect(rawHeard.filter((m) => m.type === 'chunk')).toEqual([]);
    await raw.close();

    // "Add more" starts by closing this one: the subscriber gets nothing back, the merchant the whole cap.
    await merchant.pool.sync();
    const merchantBefore = stableOf(merchant);
    const closed = await subscriber.subscriptions.end(id, subscriber.relayer());
    expect(closed.latest.state).toMatchObject({ balA: 0n, balB: sub.cap, final: true });
    expect(await merchant.tick()).toEqual([]);
    expect(stableOf(subscriber)).toBe(before - 1_000_000n - FEE_STABLE);
    expect(stableOf(merchant)).toBe(merchantBefore + sub.cap);
  });

  it('merchant offline mid-session: the ticker stops; each side settles alone with what was paid', async () => {
    await merchant.pool.sync();
    const merchantBefore = stableOf(merchant);
    const sub = await subscriber.subscriptions.subscribe(card, 5_000_000n, subscriber.relayer());
    const id = sub.channelId;
    const h = heard();
    await subscriber.subscriptions.start(id, listener(h));
    await until(() => paidSoFar(id) >= 2n * RATE, 30_000, 'two paid seconds');
    await merchant.stop(); // the merchant vanishes
    await until(() => h.stops.length > 0, 90_000, 'the ticker to stop');
    expect(['disconnected', 'timeout']).toContain(h.stops[0]?.reason);
    expect(subscriber.subscriptions.isActive(id)).toBe(false);
    const paid = paidSoFar(id);
    await sleep(2000);
    expect(paidSoFar(id)).toBe(paid); // no more payments

    // The subscriber closes without the merchant and loses nothing beyond what it paid.
    const latest = subscriber.channels.get(id).latest.state;
    expect(latest.balA).toBe(sub.cap - paid);
    await subscriber.pool.sync();
    const before = stableOf(subscriber);
    await subscriber.disputes.start(id, subscriber.relayer());
    await warp(Number(subscriber.channels.get(id).params.window) + 2);
    expect(await subscriber.tick()).toEqual([]);
    expect(subscriber.channels.get(id).status).toBe('settled');
    expect(stableOf(subscriber)).toBe(before + latest.balA);

    // The merchant comes back and collects what it was paid.
    await merchant.start();
    expect(await merchant.tick()).toEqual([]);
    expect(merchant.channels.get(id).status).toBe('settled');
    expect(stableOf(merchant)).toBe(merchantBefore + latest.balB);
    expect(latest.balB).toBe(paid);
  });
});
