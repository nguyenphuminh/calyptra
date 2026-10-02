import { bytesToHex } from 'viem';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import { balanceOf, hashOf, sideOf, type ChannelDeps, type ChannelRecord, type ChannelService } from '../channel/index.ts';
import { MerchantMessageSchema, SERVICE_PROTOCOL, offerTokenOf, type MerchantCard, type MerchantMessage } from '../merchant/index.ts';
import { decodeInvite, type P2PService, type PeerSession } from '../p2p/index.ts';
import type { RelayerPort } from '../relayer/index.ts';
import type { SubscriptionRepository } from './subscription.repository.ts';
import type { Subscription } from './subscription.schema.ts';

/** The ticker pays every second while the session is active. */
export const TICK_MS = 1000;
/** Merchant refusals that mean it does not serve this session: paying on would buy nothing. */
const SESSION_REFUSALS = new Set(['BAD_MESSAGE', 'CHANNEL_NOT_FOUND', 'NOT_LIVE', 'NOT_STARTED', 'TOKEN_NOT_SUPPORTED']);

/** Why the ticker stopped paying. */
export type StopReason =
  | 'pause' // the user paused (or the session stopped)
  | 'cap' // the allowance is used up
  | 'timeout' // the merchant did not countersign within the peer timeout
  | 'error' // a payment failed for another reason
  | 'disconnected' // the merchant closed the service stream
  | 'end'; // the subscription is ending (cooperative close)

export interface SessionEvents {
  /** A message from the merchant: chunk, done, insufficient or error. */
  onMessage?: (message: MerchantMessage) => void;
  /** The ticker stopped, and with it the payments. */
  onStop?: (reason: StopReason, error?: unknown) => void;
}

export interface SubscriptionDeps {
  channels: Pick<ChannelService, 'open' | 'pay' | 'get' | 'close'>;
  p2p: Pick<P2PService, 'openSession'>;
  chain: { network: { stablecoin: string } };
  repository: SubscriptionRepository;
  /** The host's own confirmation, asked for every payment that is not covered by a subscription's allowance. */
  confirmPayment?: ChannelDeps['confirmPayment'];
}

export interface SubscribeOptions {
  accountId?: string;
  /** After the merchant accepted and the channel is saved, before funding. */
  onAccepted?: (channelId: string) => void;
}

/** One subscription's open service stream and its ticker. */
interface Live {
  readonly channelId: string;
  readonly accountId: string | undefined;
  readonly session: PeerSession;
  events: SessionEvents;
  ticker: ReturnType<typeof setInterval> | null;
  /** When the paid time ends: payments cover everything before it. */
  lastAck: number;
  busy: boolean;
  inFlight: Promise<void>;
}

/** What this side paid so far: its balance in state 0 minus its balance now. */
function paidOf(r: ChannelRecord): bigint {
  const me = sideOf(r);
  const paid = balanceOf(r.state0.state, me) - balanceOf(r.latest.state, me);
  return paid > 0n ? paid : 0n;
}

/** What our unanswered proposal pays (the channel resends it before anything new). */
function unansweredOf(r: ChannelRecord): bigint {
  if (!r.pending || r.pending.prevHash !== hashOf(r, r.latest.state)) return 0n;
  const me = sideOf(r);
  const amount = balanceOf(r.latest.state, me) - balanceOf(r.pending.state, me);
  return amount > 0n ? amount : 0n;
}

/**
 * The subscriber side of per-second subscriptions: the allowance registry, the service stream to the
 * merchant, and a ticker that pays every second while the session is active.
 */
export class SubscriptionService {
  private readonly deps: SubscriptionDeps;
  private readonly sessions = new Map<string, Live>();

  constructor(deps: SubscriptionDeps) {
    this.deps = deps;
  }

  list(accountId?: string): Subscription[] {
    return this.deps.repository.all(accountId);
  }

  get(channelId: string, accountId?: string): Subscription | undefined {
    return this.deps.repository.get(channelId, accountId);
  }

  /**
   * The node's payment confirmation: true without asking only for a registered subscription whose
   * allowance covers the payment; every other payment goes to the host's own confirmation.
   */
  async confirmPayment(payment: { channelId: string; token: bigint; amount: bigint }): Promise<boolean> {
    const entry = this.deps.repository.get(payment.channelId);
    if (entry && entry.paid + payment.amount <= entry.cap) return true;
    return this.deps.confirmPayment ? this.deps.confirmPayment(payment) : true;
  }

  /** Opens a channel to the merchant funded with the allowance (the merchant funds nothing) and registers it. */
  async subscribe(card: MerchantCard, allowance: bigint, relayer: RelayerPort, options: SubscribeOptions = {}): Promise<Subscription> {
    const { offer } = card;
    if (allowance < offer.minFunding) throw new AppError(400, 'INVALID_AMOUNT', 'The allowance is below this merchant’s minimum');
    const record = await this.deps.channels.open(decodeInvite(card.invite), {
      token: offerTokenOf(offer, this.deps.chain.network),
      amount: allowance,
      peerAmount: 0n,
      relayer,
      accountId: options.accountId,
      onAccepted: options.onAccepted,
    });
    const entry: Subscription = {
      channelId: record.id,
      merchant: card.name,
      ratePerSecond: offer.ratePerSecond,
      cap: balanceOf(record.state0.state, sideOf(record)),
      paid: 0n,
    };
    await this.deps.repository.save(entry, options.accountId);
    return entry;
  }

  /** Whether the ticker of this subscription is paying. */
  isActive(channelId: string): boolean {
    return this.sessions.get(channelId)?.ticker != null;
  }

  /** Starts (or resumes) the paid session: connects to the merchant, sends `start`, and pays every second. */
  async start(channelId: string, events: SessionEvents = {}, accountId?: string): Promise<void> {
    if (!this.deps.repository.get(channelId, accountId)) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'No such subscription');
    let live = this.sessions.get(channelId);
    if (live?.ticker) return;
    if (live) {
      live.events = events;
    } else {
      const { peer } = this.deps.channels.get(channelId, accountId);
      const session = await this.deps.p2p.openSession(peer, SERVICE_PROTOCOL);
      live = { channelId, accountId, session, events, ticker: null, lastAck: 0, busy: false, inFlight: Promise.resolve() };
      this.sessions.set(channelId, live);
      void this.read(live);
    }
    await live.session.send({ type: 'start', channelId });
    const current = live;
    current.lastAck = Date.now();
    current.ticker = setInterval(() => this.step(current), TICK_MS);
  }

  /** Asks the merchant; the reply arrives as `chunk` messages and a `done` with the returned id. */
  async prompt(channelId: string, text: string): Promise<string> {
    const live = this.sessions.get(channelId);
    if (!live) throw new AppError(409, 'NOT_STARTED', 'Start the subscription first');
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(8))).slice(2);
    await live.session.send({ type: 'prompt', id, text });
    return id;
  }

  /** Pauses: no more payments and no more service until `start` again; the channel stays open. */
  async pause(channelId: string): Promise<void> {
    const live = this.sessions.get(channelId);
    if (!live) return;
    this.halt(live, 'pause');
    await live.inFlight;
  }

  /** Ends the subscription: stops paying, closes the service stream, and closes the channel cooperatively. */
  async end(channelId: string, relayer: RelayerPort, accountId?: string): Promise<ChannelRecord> {
    const live = this.sessions.get(channelId);
    if (live) {
      this.halt(live, 'end');
      await live.inFlight;
      this.sessions.delete(channelId);
      await live.session.close();
    }
    return this.deps.channels.close(channelId, relayer, accountId);
  }

  /** Stops every ticker and stream (the node's session is ending); the channels stay open. */
  async stop(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    for (const live of all) this.halt(live, 'pause');
    await Promise.all(all.map(async (live) => {
      await live.inFlight;
      await live.session.close();
    }));
  }

  private async read(live: Live): Promise<void> {
    try {
      for await (const raw of live.session.messages()) {
        const parsed = MerchantMessageSchema.safeParse(raw);
        if (!parsed.success) continue;
        const message = parsed.data;
        live.events.onMessage?.(message);
        if (message.type === 'error' && SESSION_REFUSALS.has(message.code)) this.halt(live, 'error', new AppError(409, message.code, message.message));
      }
    } catch {
      // the stream failed: same as closed
    } finally {
      if (this.sessions.get(live.channelId) === live) this.sessions.delete(live.channelId);
      this.halt(live, 'disconnected');
    }
  }

  /** One tick: never more than one proposal in flight; pays every second since the last acknowledged one. */
  private step(live: Live): void {
    if (live.busy || !live.ticker) return;
    live.busy = true;
    live.inFlight = this.payDue(live).finally(() => {
      live.busy = false;
    });
  }

  private async payDue(live: Live): Promise<void> {
    try {
      const entry = this.deps.repository.get(live.channelId, live.accountId);
      if (!entry) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'No such subscription');
      const seconds = Math.floor((Date.now() - live.lastAck) / 1000);
      if (seconds <= 0) return;
      const left = entry.cap - entry.paid - unansweredOf(this.deps.channels.get(live.channelId, live.accountId));
      if (left <= 0n) return this.halt(live, 'cap');
      const due = entry.ratePerSecond * BigInt(seconds);
      const after = await this.deps.channels.pay(live.channelId, due < left ? due : left, live.accountId);
      live.lastAck += seconds * 1000;
      const paid = paidOf(after);
      await this.deps.repository.save({ ...entry, paid }, live.accountId);
      if (paid >= entry.cap) this.halt(live, 'cap');
    } catch (err) {
      const unanswered = isAppError(err) && (err.code === 'PEER_TIMEOUT' || err.code === 'PEER_UNREACHABLE');
      this.halt(live, unanswered ? 'timeout' : 'error', err);
    }
  }

  /** Stops the ticker (once) and tells the merchant to pause, unless the stream is gone. */
  private halt(live: Live, reason: StopReason, error?: unknown): void {
    if (!live.ticker) return;
    clearInterval(live.ticker);
    live.ticker = null;
    if (reason !== 'disconnected') void live.session.send({ type: 'stop' }).catch(() => undefined);
    live.events.onStop?.(reason, error);
  }
}
