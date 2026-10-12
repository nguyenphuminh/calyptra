import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import type { ChannelRecord, ChannelService, OpenOptions } from '../channel/index.ts';
import { OfferSchema, type MerchantCard } from '../merchant/index.ts';
import { encodeInvite, type PeerSession, type PeerTarget } from '../p2p/index.ts';
import type { RelayerPort } from '../relayer/index.ts';
import { SubscriptionRepository } from './subscription.repository.ts';
import { SubscriptionService, type StopReason } from './subscription.service.ts';

const STABLECOIN = '0x00000000000000000000000000000000000000aa';
const CHANNEL = 'ab'.repeat(16);
const RATE = 2000n;
const relayer = {} as RelayerPort;

/** The wallet's section storage, in memory. */
function sections() {
  const values = new Map<string, unknown>();
  return {
    readSection: <T>(section: string, schema: z.ZodType<T>): T | undefined => {
      const value = values.get(section);
      return value === undefined ? undefined : schema.parse(value);
    },
    writeSection: async (section: string, value: unknown) => {
      values.set(section, value);
    },
  };
}

/** The merchant's end of the service stream: records what the subscriber sends. */
function merchantEnd() {
  const sent: Record<string, unknown>[] = [];
  let push: ((m: unknown) => void) | null = null;
  let finish: (() => void) | null = null;
  const queue: unknown[] = [];
  let ended = false;
  const session: PeerSession = {
    peerId: 'merchant-peer',
    send: async (m) => {
      sent.push(JSON.parse(JSON.stringify(m)) as Record<string, unknown>);
    },
    async *messages() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          push = (m) => {
            queue.push(m);
            resolve();
          };
          finish = resolve;
        });
      }
    },
    close: async () => {
      ended = true;
      finish?.();
    },
  };
  return {
    session, sent,
    reply: (m: unknown) => push?.(m),
    disconnect: () => {
      ended = true;
      finish?.();
    },
  };
}

/** A subscription channel whose payments the test resolves by hand. */
function fakeChannels(allowance: bigint, closingFee: bigint) {
  const state0 = { balA: allowance - closingFee, balB: 0n };
  const record = { id: CHANNEL, role: 'A', peer: { peerId: 'merchant-peer', addrs: [] }, pending: null, state0: { state: state0 }, latest: { state: { ...state0 } } };
  const payments: bigint[] = [];
  let nextPay: ((r: ChannelRecord) => void) | null = null;
  let failNext: AppError | null = null;
  let manual = false;
  const asRecord = () => record as unknown as ChannelRecord;
  const channels: Pick<ChannelService, 'open' | 'pay' | 'get' | 'close'> = {
    open: vi.fn(async (_invite: unknown, _o: OpenOptions) => asRecord()),
    get: () => asRecord(),
    close: vi.fn(async () => asRecord()),
    pay: (_id: string, amount: bigint) => {
      payments.push(amount);
      if (failNext) {
        const err = failNext;
        failNext = null;
        return Promise.reject(err);
      }
      const apply = () => {
        record.latest.state.balA -= amount;
        record.latest.state.balB += amount;
        return asRecord();
      };
      if (!manual) return Promise.resolve(apply());
      return new Promise<ChannelRecord>((resolve) => {
        nextPay = () => resolve(apply());
      });
    },
  };
  return {
    channels, record, payments,
    holdPayments: () => {
      manual = true;
    },
    answer: () => {
      const run = nextPay;
      nextPay = null;
      run?.(asRecord());
    },
    failWith: (err: AppError) => {
      failNext = err;
    },
  };
}

function setup(options: { allowance?: bigint; closingFee?: bigint; hostConfirm?: (p: { channelId: string; amount: bigint }) => Promise<boolean> } = {}) {
  const fake = fakeChannels(options.allowance ?? 1_000_000n, options.closingFee ?? 10_000n);
  const merchant = merchantEnd();
  const opened: PeerTarget[] = [];
  const repository = new SubscriptionRepository(sections());
  const service = new SubscriptionService({
    channels: fake.channels,
    p2p: { openSession: async (peer) => { opened.push(peer); return merchant.session; } },
    chain: { network: { stablecoin: STABLECOIN } },
    repository,
    confirmPayment: options.hostConfirm,
  });
  const stops: { reason: StopReason; error?: unknown }[] = [];
  const events = { onStop: (reason: StopReason, error?: unknown) => stops.push({ reason, error }), onMessage: vi.fn() };
  return { ...fake, merchant, service, repository, stops, events, opened };
}

const card: MerchantCard = {
  v: 1,
  name: 'Calyptra AI',
  invite: encodeInvite({ v: 1, peerId: 'merchant-peer', addrs: ['/ip4/1.2.3.4/tcp/1/ws/p2p/relay/p2p-circuit/p2p/merchant-peer'], shieldedAddress: 'cal' }),
  offer: OfferSchema.parse({ kind: 'ai-chat', title: 'Calyptra AI · powered by Gemini', token: 'stablecoin', ratePerSecond: RATE, minFunding: '1000000' }),
};

describe('SubscriptionService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a channel funded with the allowance and registers what it can pay', async () => {
    const t = setup();
    await expect(t.service.subscribe(card, 999_999n, relayer)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    const entry = await t.service.subscribe(card, 1_000_000n, relayer);
    expect(t.channels.open).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'merchant-peer' }),
      expect.objectContaining({ token: BigInt(STABLECOIN), amount: 1_000_000n, peerAmount: 0n, relayer }),
    );
    expect(entry).toEqual({ channelId: CHANNEL, merchant: 'Calyptra AI', ratePerSecond: RATE, cap: 990_000n, paid: 0n });
    expect(t.service.list()).toEqual([entry]);
  });

  it('signs automatically only for registered subscriptions within their allowance', async () => {
    const host = vi.fn(async () => false);
    const t = setup({ hostConfirm: host });
    await t.service.subscribe(card, 1_000_000n, relayer);
    await expect(t.service.confirmPayment({ channelId: CHANNEL, token: 1n, amount: 990_000n })).resolves.toBe(true);
    expect(host).not.toHaveBeenCalled();
    await expect(t.service.confirmPayment({ channelId: CHANNEL, token: 1n, amount: 990_001n })).resolves.toBe(false);
    await expect(t.service.confirmPayment({ channelId: 'cd'.repeat(16), token: 1n, amount: 1n })).resolves.toBe(false);
    expect(host).toHaveBeenCalledTimes(2);
    const noHost = setup();
    await expect(noHost.service.confirmPayment({ channelId: 'cd'.repeat(16), token: 1n, amount: 1n })).resolves.toBe(true);
  });

  it('pays the rate every second while active, and nothing while paused', async () => {
    const t = setup();
    await t.service.subscribe(card, 1_000_000n, relayer);
    await t.service.start(CHANNEL, t.events);
    expect(t.opened).toEqual([{ peerId: 'merchant-peer', addrs: [] }]);
    expect(t.merchant.sent).toEqual([{ type: 'start', channelId: CHANNEL }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.payments).toEqual(Array(10).fill(RATE));
    expect(t.service.get(CHANNEL)?.paid).toBe(10n * RATE);
    await t.service.pause(CHANNEL);
    expect(t.service.isActive(CHANNEL)).toBe(false);
    expect(t.merchant.sent.at(-1)).toEqual({ type: 'stop' });
    expect(t.stops).toEqual([{ reason: 'pause', error: undefined }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.payments).toHaveLength(10);
    await t.service.start(CHANNEL, t.events); // resume on the same stream, paused time is not paid
    expect(t.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.payments).toEqual(Array(12).fill(RATE));
  });

  it('keeps one proposal in flight and catches up after a slow round trip', async () => {
    const t = setup();
    await t.service.subscribe(card, 1_000_000n, relayer);
    t.holdPayments();
    await t.service.start(CHANNEL, t.events);
    await vi.advanceTimersByTimeAsync(1_000); // first tick: pays 1 s, the answer is slow
    await vi.advanceTimersByTimeAsync(1_500); // two ticks pass while it is in flight
    expect(t.payments).toEqual([RATE]);
    t.answer(); // acknowledged at 2.5 s: paid until 1 s
    await vi.advanceTimersByTimeAsync(500); // tick at 3 s: 2 s since the last acknowledged second
    expect(t.payments).toEqual([RATE, 2n * RATE]);
    t.answer();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.payments).toEqual([RATE, 2n * RATE, RATE]);
  });

  it('stops at the cap, paying only what is left', async () => {
    const t = setup({ allowance: 15_000n, closingFee: 10_000n }); // cap 5000 = 2.5 s
    await t.service.subscribe({ ...card, offer: { ...card.offer, minFunding: 0n } }, 15_000n, relayer);
    await t.service.start(CHANNEL, t.events);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.payments).toEqual([RATE, RATE, 1000n]);
    expect(t.service.get(CHANNEL)?.paid).toBe(5000n);
    expect(t.stops).toEqual([{ reason: 'cap', error: undefined }]);
    expect(t.merchant.sent.at(-1)).toEqual({ type: 'stop' });
    expect(t.service.isActive(CHANNEL)).toBe(false);
  });

  it('stops when the merchant does not countersign in time, or another payment failure', async () => {
    const t = setup();
    await t.service.subscribe(card, 1_000_000n, relayer);
    await t.service.start(CHANNEL, t.events);
    t.failWith(new AppError(504, 'PEER_TIMEOUT', 'The other party did not answer in time'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.payments).toHaveLength(1);
    expect(t.stops.map((s) => s.reason)).toEqual(['timeout']);
    await t.service.start(CHANNEL, t.events);
    t.failWith(new AppError(423, 'WALLET_LOCKED', 'The wallet is locked'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.stops.map((s) => s.reason)).toEqual(['timeout', 'error']);
  });

  it('relays merchant messages, and stops when the merchant goes away', async () => {
    const t = setup();
    await t.service.subscribe(card, 1_000_000n, relayer);
    await t.service.start(CHANNEL, t.events);
    const id = await t.service.prompt(CHANNEL, 'hello');
    expect(t.merchant.sent.at(-1)).toEqual({ type: 'prompt', id, text: 'hello' });
    t.merchant.reply({ type: 'chunk', id, text: 'hello' });
    t.merchant.reply({ type: 'nonsense' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events.onMessage).toHaveBeenCalledWith({ type: 'chunk', id, text: 'hello' });
    expect(t.events.onMessage).toHaveBeenCalledTimes(1);
    t.merchant.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops.map((s) => s.reason)).toEqual(['disconnected']);
    await expect(t.service.prompt(CHANNEL, 'again')).rejects.toMatchObject({ code: 'NOT_STARTED' });
  });

  it('stops paying when the merchant refuses to serve the session', async () => {
    const t = setup();
    await t.service.subscribe(card, 1_000_000n, relayer);
    await t.service.start(CHANNEL, t.events);
    t.merchant.reply({ type: 'error', code: 'UPSTREAM_ERROR', message: 'The model is busy' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.service.isActive(CHANNEL)).toBe(true); // a failed reply does not end the session
    t.merchant.reply({ type: 'error', code: 'NOT_LIVE', message: 'The channel is not live' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops.map((s) => [s.reason, (s.error as AppError).code])).toEqual([['error', 'NOT_LIVE']]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.payments).toEqual([]);
  });

  it('ends with a cooperative close', async () => {
    const t = setup();
    await t.service.subscribe(card, 1_000_000n, relayer);
    await t.service.start(CHANNEL, t.events);
    await vi.advanceTimersByTimeAsync(1_000);
    await t.service.end(CHANNEL, relayer);
    expect(t.channels.close).toHaveBeenCalledWith(CHANNEL, relayer, undefined);
    expect(t.stops.map((s) => s.reason)).toEqual(['end']);
    expect(t.merchant.sent.at(-1)).toEqual({ type: 'stop' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.payments).toHaveLength(1);
  });
});
