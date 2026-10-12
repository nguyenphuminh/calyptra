import { isAppError } from '../../shared/errors/AppError.ts';
import { balanceOf, sideOf, type ChannelService } from '../channel/index.ts';
import type { P2PService, PeerSession } from '../p2p/index.ts';
import { ServedClock, gateOpen, paidSecondsOf } from './merchant.gate.ts';
import type { ServicePort } from './merchant.port.ts';
import {
  SERVICE_PROTOCOL,
  SubscriberMessageSchema,
  offerTokenOf,
  type MerchantMessage,
  type Offer,
  type SubscriberMessage,
} from './merchant.schema.ts';

/** How often a paused reply checks whether payments caught up. */
const GATE_POLL_MS = 250;

export interface MerchantDeps {
  p2p: Pick<P2PService, 'handleSessions'>;
  channels: Pick<ChannelService, 'get'>;
  chain: { network: { stablecoin: string } };
  /** The service sold by the second (e.g. the Gemini chat, or EchoServicePort in tests). */
  service: ServicePort;
  offer: Offer;
}

/** Where a subscription stands against the payment gate. */
export interface GateStatus {
  paidSeconds: bigint;
  servedSeconds: bigint;
  open: boolean;
}

/** One subscriber's stream on the service protocol. */
interface SessionContext {
  channelId: string | null;
  closed: boolean;
  readonly abort: AbortController;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const error = (code: string, message: string): MerchantMessage => ({ type: 'error', code, message });

/**
 * The merchant side of per-second subscriptions: serves the service protocol and forwards the
 * service's output only while the subscriber's payments keep up (paid >= served - grace).
 */
export class MerchantService {
  private readonly deps: MerchantDeps;
  /** Served time per subscription channel (in memory: a restart only favours subscribers). */
  private readonly clocks = new Map<string, ServedClock>();

  constructor(deps: MerchantDeps) {
    this.deps = deps;
  }

  async listen(): Promise<void> {
    await this.deps.p2p.handleSessions(SERVICE_PROTOCOL, (session) => this.serve(session));
  }

  /** The gate of a subscription channel now. */
  gate(channelId: string, now = Date.now()): GateStatus {
    const r = this.deps.channels.get(channelId);
    const paidSeconds = paidSecondsOf(balanceOf(r.latest.state, sideOf(r)), this.deps.offer.ratePerSecond);
    const servedSeconds = this.clock(channelId).seconds(now);
    return { paidSeconds, servedSeconds, open: gateOpen(paidSeconds, servedSeconds, this.deps.offer.graceSeconds) };
  }

  /** Serves one subscriber stream until it ends (public so tests can drive it without libp2p). */
  async serve(session: PeerSession): Promise<void> {
    const ctx: SessionContext = { channelId: null, closed: false, abort: new AbortController() };
    let work: Promise<void> = Promise.resolve(); // prompts are answered one after another
    try {
      for await (const raw of session.messages()) {
        const parsed = SubscriberMessageSchema.safeParse(raw);
        if (!parsed.success) {
          await session.send(error('BAD_MESSAGE', 'Malformed service message'));
          continue;
        }
        const m = parsed.data;
        if (m.type === 'start') {
          const refusal = this.startRefusal(session.peerId, m.channelId, ctx.channelId);
          if (refusal) {
            await session.send(refusal);
            continue;
          }
          ctx.channelId = m.channelId;
          this.clock(m.channelId).start(Date.now(), ctx);
        } else if (m.type === 'stop') {
          if (ctx.channelId) this.clock(ctx.channelId).stop(Date.now(), ctx);
        } else if (!ctx.channelId) {
          await session.send(error('NOT_STARTED', 'Start the session before asking'));
        } else {
          const channelId = ctx.channelId;
          work = work.then(() => this.answer(session, channelId, m, ctx));
        }
      }
    } finally {
      ctx.closed = true;
      ctx.abort.abort();
      await work.catch(() => undefined);
      if (ctx.channelId) {
        this.clock(ctx.channelId).stop(Date.now(), ctx);
        this.deps.service.end(ctx.channelId);
      }
    }
  }

  private startRefusal(peerId: string, channelId: string, current: string | null): MerchantMessage | null {
    if (current && current !== channelId) return error('BAD_MESSAGE', 'This session already serves another channel');
    let r;
    try {
      r = this.deps.channels.get(channelId);
    } catch {
      return error('CHANNEL_NOT_FOUND', 'No such channel with this peer');
    }
    if (r.peer.peerId !== peerId) return error('CHANNEL_NOT_FOUND', 'No such channel with this peer');
    if (r.token !== offerTokenOf(this.deps.offer, this.deps.chain.network)) return error('TOKEN_NOT_SUPPORTED', 'This service is paid in another token');
    if (r.status !== 'funding' && r.status !== 'live') return error('NOT_LIVE', 'The channel is not live');
    return null;
  }

  private async answer(session: PeerSession, channelId: string, m: Extract<SubscriberMessage, { type: 'prompt' }>, ctx: SessionContext): Promise<void> {
    try {
      const chunks = this.deps.service.reply(channelId, m.text, ctx.abort.signal)[Symbol.asyncIterator]();
      try {
        for (;;) {
          if (!(await this.waitForGate(session, channelId, ctx))) return; // the subscriber went away
          const next = await chunks.next();
          if (next.done) break;
          await session.send({ type: 'chunk', id: m.id, text: next.value });
        }
      } finally {
        await chunks.return?.();
      }
      await session.send({ type: 'done', id: m.id });
    } catch (err) {
      if (ctx.closed) return;
      const refusal = isAppError(err) ? error(err.code, err.message) : error('SERVICE_ERROR', 'The service could not answer');
      await session.send(refusal).catch(() => undefined);
    }
  }

  /**
   * Waits until the subscription is active and its payments keep up; tells the subscriber once per
   * shortfall. Returns false when the session ended meanwhile.
   */
  private async waitForGate(session: PeerSession, channelId: string, ctx: SessionContext): Promise<boolean> {
    let told = false;
    for (;;) {
      if (ctx.closed) return false;
      if (this.clock(channelId).active) {
        const gate = this.gate(channelId);
        if (gate.open) return true;
        if (!told) {
          told = true;
          await session.send({ type: 'insufficient', paidSeconds: Number(gate.paidSeconds), servedSeconds: Number(gate.servedSeconds) });
        }
      }
      await sleep(GATE_POLL_MS);
    }
  }

  private clock(channelId: string): ServedClock {
    let clock = this.clocks.get(channelId);
    if (!clock) {
      clock = new ServedClock();
      this.clocks.set(channelId, clock);
    }
    return clock;
  }
}
