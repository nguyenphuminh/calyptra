import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRecord } from '../channel/index.ts';
import type { PeerSession } from '../p2p/index.ts';
import { ServedClock, gateOpen, paidSecondsOf } from './merchant.gate.ts';
import { EchoServicePort } from './merchant.port.ts';
import { MerchantService } from './merchant.service.ts';
import { OfferSchema, decodeMerchantCard, encodeMerchantCard, merchantLink, type MerchantCard } from './merchant.schema.ts';

/** One direction of an in-memory stream. */
class Inbox {
  private readonly items: unknown[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  push(message: unknown): void {
    this.items.push(JSON.parse(JSON.stringify(message, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))));
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async *read(): AsyncGenerator<unknown> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift();
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

/** Two connected in-memory sessions: `subscriber` talks to `merchant`. */
function pipe(): { subscriber: PeerSession; merchant: PeerSession } {
  const toMerchant = new Inbox();
  const toSubscriber = new Inbox();
  const side = (peerId: string, inbox: Inbox, outbox: Inbox): PeerSession => ({
    peerId,
    send: async (m) => outbox.push(m),
    messages: () => inbox.read(),
    close: async () => outbox.end(),
  });
  return { subscriber: side('merchant-peer', toSubscriber, toMerchant), merchant: side('subscriber-peer', toMerchant, toSubscriber) };
}

const STABLECOIN = '0x00000000000000000000000000000000000000aa';
const CHANNEL = 'ab'.repeat(16);
const offer = OfferSchema.parse({ kind: 'ai-chat', title: 'Calyptra AI · powered by Qwen', token: 'stablecoin', ratePerSecond: '1000', minFunding: '1000000' });

function setup(overrides: Partial<{ peerId: string; token: bigint; status: string }> = {}, service = new EchoServicePort()) {
  const channel = {
    id: CHANNEL, role: 'B', status: overrides.status ?? 'live', token: overrides.token ?? BigInt(STABLECOIN),
    peer: { peerId: overrides.peerId ?? 'subscriber-peer', addrs: [] },
    latest: { state: { balA: 0n, balB: 0n } },
  };
  const get = (id: string): ChannelRecord => {
    if (id !== CHANNEL) throw new Error('No such channel');
    return channel as unknown as ChannelRecord;
  };
  const merchant = new MerchantService({
    p2p: { handleSessions: async () => undefined },
    channels: { get },
    chain: { network: { stablecoin: STABLECOIN } },
    service,
    offer,
  });
  const { subscriber, merchant: end } = pipe();
  const received: Record<string, unknown>[] = [];
  const serving = merchant.serve(end);
  const reading = (async () => {
    for await (const m of subscriber.messages()) received.push(m as Record<string, unknown>);
  })();
  const pay = (seconds: bigint) => {
    channel.latest.state.balB = seconds * offer.ratePerSecond;
  };
  return { merchant, subscriber, received, serving, reading, pay };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('payment gate math', () => {
  it('counts whole paid seconds', () => {
    expect(paidSecondsOf(0n, 2000n)).toBe(0n);
    expect(paidSecondsOf(5999n, 2000n)).toBe(2n);
    expect(paidSecondsOf(6000n, 2000n)).toBe(3n);
  });
  it('serves while paid seconds >= served seconds - grace', () => {
    expect(gateOpen(0n, 3n, 3)).toBe(true);
    expect(gateOpen(0n, 4n, 3)).toBe(false);
    expect(gateOpen(7n, 10n, 3)).toBe(true);
    expect(gateOpen(7n, 11n, 3)).toBe(false);
    expect(gateOpen(5n, 5n, 0)).toBe(true);
    expect(gateOpen(4n, 5n, 0)).toBe(false);
  });
  it('counts only active time, across pauses, and ignores a stale session’s stop', () => {
    const clock = new ServedClock();
    const first = {};
    const second = {};
    clock.start(0, first);
    expect(clock.seconds(2_500)).toBe(2n);
    clock.stop(2_500, first);
    expect(clock.active).toBe(false);
    expect(clock.seconds(100_000)).toBe(2n);
    clock.start(100_000, first);
    clock.start(100_000, second);
    clock.stop(101_000, first); // the older session ending does not pause the newer one
    expect(clock.active).toBe(true);
    expect(clock.seconds(101_600)).toBe(4n);
  });
});

describe('merchant cards', () => {
  it('round-trip as a code and as a link, amounts as decimal strings', () => {
    const invite = 'eyJ2IjoxLCJwZWVySWQiOiJwIiwiYWRkcnMiOlsiL3AycC1jaXJjdWl0L3AycC9wIl0sInNoaWVsZGVkQWRkcmVzcyI6ImNhbCJ9';
    const card: MerchantCard = { v: 1, name: 'Calyptra AI', invite, offer };
    expect(decodeMerchantCard(encodeMerchantCard(card))).toEqual(card);
    expect(decodeMerchantCard(merchantLink('https://example.org', card))).toEqual(card);
    expect(offer.graceSeconds).toBe(3);
    expect(() => decodeMerchantCard('nonsense')).toThrow('This is not a valid Calyptra merchant card');
    expect(() => decodeMerchantCard(encodeMerchantCard({ ...card, invite: 'bad' }))).toThrow('not a valid Calyptra merchant card');
  });
});

describe('MerchantService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses malformed messages, prompts before start, and channels of other peers or tokens', async () => {
    const { subscriber, received } = setup({ peerId: 'someone-else' });
    await subscriber.send({ type: 'hello' });
    await subscriber.send({ type: 'prompt', id: 'p1', text: 'hi' });
    await subscriber.send({ type: 'start', channelId: CHANNEL });
    await subscriber.send({ type: 'start', channelId: 'cd'.repeat(16) });
    await settle();
    expect(received.map((m) => m.code)).toEqual(['BAD_MESSAGE', 'NOT_STARTED', 'CHANNEL_NOT_FOUND', 'CHANNEL_NOT_FOUND']);
    const other = setup({ token: 0n });
    await other.subscriber.send({ type: 'start', channelId: CHANNEL });
    await settle();
    expect(other.received.map((m) => m.code)).toEqual(['TOKEN_NOT_SUPPORTED']);
  });

  it('streams the service’s reply while payments keep up', async () => {
    const { subscriber, received } = setup();
    await subscriber.send({ type: 'start', channelId: CHANNEL });
    await subscriber.send({ type: 'prompt', id: 'p1', text: 'hello there world' });
    await settle();
    expect(received).toEqual([
      { type: 'chunk', id: 'p1', text: 'hello ' },
      { type: 'chunk', id: 'p1', text: 'there ' },
      { type: 'chunk', id: 'p1', text: 'world' },
      { type: 'done', id: 'p1' },
    ]);
  });

  it('sends insufficient and pauses output once served time runs ahead of paid time plus grace', async () => {
    const { merchant, subscriber, received, pay } = setup();
    await subscriber.send({ type: 'start', channelId: CHANNEL });
    pay(2n);
    await vi.advanceTimersByTimeAsync(5_000); // served 5, paid 2, grace 3: still open
    expect(merchant.gate(CHANNEL)).toEqual({ paidSeconds: 2n, servedSeconds: 5n, open: true });
    await vi.advanceTimersByTimeAsync(1_000); // served 6: closed
    await subscriber.send({ type: 'prompt', id: 'p2', text: 'are you there' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(received).toEqual([{ type: 'insufficient', paidSeconds: 2, servedSeconds: 6 }]);
    pay(5n); // paid catches up: 5 >= 7 - 3
    await vi.advanceTimersByTimeAsync(250);
    expect(received.slice(1).map((m) => m.type)).toEqual(['chunk', 'chunk', 'chunk', 'done']);
  });

  it('counts no served time while the subscriber paused', async () => {
    const { merchant, subscriber, received } = setup();
    await subscriber.send({ type: 'start', channelId: CHANNEL });
    await vi.advanceTimersByTimeAsync(2_000);
    await subscriber.send({ type: 'stop' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(merchant.gate(CHANNEL).servedSeconds).toBe(2n);
    await subscriber.send({ type: 'prompt', id: 'p3', text: 'wait' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(received).toEqual([]); // paused: nothing generated, no shortfall reported
    await subscriber.send({ type: 'start', channelId: CHANNEL });
    await vi.advanceTimersByTimeAsync(250);
    expect(received).toEqual([{ type: 'chunk', id: 'p3', text: 'wait' }, { type: 'done', id: 'p3' }]);
    expect(merchant.gate(CHANNEL).servedSeconds).toBe(2n);
  });

  it('ends the session and the conversation when the subscriber closes the stream', async () => {
    const service = new EchoServicePort();
    const ended: string[] = [];
    service.end = (id) => ended.push(id);
    const { subscriber, serving } = setup({}, service);
    await subscriber.send({ type: 'start', channelId: CHANNEL });
    await subscriber.close();
    await settle();
    await serving;
    expect(ended).toEqual([CHANNEL]);
  });
});
