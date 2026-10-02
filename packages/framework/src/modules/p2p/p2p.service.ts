import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { lpStream } from '@libp2p/utils';
import { multiaddr } from '@multiformats/multiaddr';
import { z } from 'zod';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import type { Invite } from './invite.ts';

export const CHANNEL_PROTOCOL = '/calyptra/channel/1.0.0';
const TIMEOUT_MS = 60_000;
const RELAY_POLL_MS = 200;
const noRelay = (): AppError => new AppError(503, 'NO_RELAY', 'No libp2p relay is reachable; add one in the network settings');

/** Handles one request from a peer; throw an AppError to refuse. */
export type RequestHandler = (fromPeerId: string, message: unknown) => Promise<unknown>;
export interface PeerTarget {
  peerId: string;
  addrs: string[];
}

/**
 * A long-lived, two-way stream of JSON messages with one peer, length-prefixed like the channel
 * protocol (used by the per-second service protocol, where replies arrive as several messages).
 */
export interface PeerSession {
  /** The Noise-authenticated remote peer. */
  readonly peerId: string;
  /** Sends one message; AppError PEER_UNREACHABLE once the stream is gone. */
  send(message: unknown): Promise<void>;
  /** The peer's messages in order, until the stream ends (raw JSON: callers parse with zod). */
  messages(): AsyncIterable<unknown>;
  /** Closes this side; the peer's `messages()` then ends. */
  close(): Promise<void>;
}
export type SessionHandler = (session: PeerSession) => Promise<void>;

const EnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
type Envelope = z.infer<typeof EnvelopeSchema>;

/** JSON with bigints as decimal strings (field elements, amounts and nonces travel this way). */
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

function sessionOf(stream: Stream, peerId: string): PeerSession {
  const lp = lpStream(stream);
  return {
    peerId,
    async send(message) {
      try {
        await lp.write(encode(message));
      } catch {
        throw new AppError(503, 'PEER_UNREACHABLE', 'The other party stopped answering');
      }
    },
    async *messages() {
      while (true) {
        let message: unknown;
        try {
          message = decode((await lp.read()).subarray());
        } catch {
          return; // the stream ended (or sent something that is not JSON)
        }
        yield message;
      }
    },
    async close() {
      await stream.close().catch(() => undefined);
    },
  };
}

/** Encrypted request/response messaging over libp2p, through circuit relays only. */
export class P2PService {
  readonly node: Libp2p;
  private readonly timeoutMs: number;
  private handler: RequestHandler | null = null;
  private stopped = false;
  private restoring: Promise<boolean> | null = null;

  constructor(node: Libp2p, options: { timeoutMs?: number } = {}) {
    this.node = node;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  get peerId(): string {
    return this.node.peerId.toString();
  }

  async listen(handler: RequestHandler): Promise<void> {
    this.handler = handler;
    await this.node.handle(CHANNEL_PROTOCOL, (stream, connection) => this.serve(stream, connection), { runOnLimitedConnection: true });
  }

  /** The addresses peers reach this node at: relay circuits only, never a direct IP. */
  relayAddresses(): string[] {
    return this.node
      .getMultiaddrs()
      .map((a) => a.toString())
      .filter((a) => a.includes('/p2p-circuit'));
  }

  async waitForRelay(timeoutMs = 30_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const addrs = this.relayAddresses();
      if (addrs.length > 0) return addrs;
      if (Date.now() >= deadline) throw noRelay();
      await new Promise((resolve) => setTimeout(resolve, RELAY_POLL_MS));
    }
  }

  /** An invite needs a relay address to be reached at: NO_RELAY while no relay is reachable. */
  invite(shieldedAddress: string): Invite {
    const addrs = this.relayAddresses();
    if (addrs.length === 0) throw noRelay();
    return { v: 1, peerId: this.peerId, addrs, shieldedAddress };
  }

  /**
   * Makes the relay reservations again when this node has none (a relay that was down when the node
   * started, or a reservation lost since; libp2p does not retry either). It restarts the libp2p node,
   * which keeps its identity and registered handlers; while any relay circuit address exists it does
   * nothing, so working relayed connections are never dropped. Never throws; returns whether the node
   * is reachable through a relay afterwards. Called on every background tick.
   */
  restoreRelays(): Promise<boolean> {
    this.restoring ??= this.restartWithoutRelay().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  private async restartWithoutRelay(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.relayAddresses().length > 0) return true;
    try {
      await this.node.stop();
      if (this.stopped) return false; // stopped meanwhile: the identity may already belong to a new node
      await this.node.start();
    } catch {
      // the next tick tries again
    }
    return this.relayAddresses().length > 0;
  }

  /** Sends one request and returns the peer's answer; one stream per request, one budget for dial, write and read. */
  async request(peer: PeerTarget, message: unknown): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let stream: Stream;
    try {
      stream = await this.node.dialProtocol(peer.addrs.map((a) => multiaddr(a)), CHANNEL_PROTOCOL, { runOnLimitedConnection: true, signal });
    } catch {
      throw new AppError(503, 'PEER_UNREACHABLE', 'The other party is not reachable right now');
    }
    const lp = lpStream(stream);
    let bytes: Uint8Array;
    try {
      await lp.write(encode(message), { signal });
      bytes = (await lp.read({ signal })).subarray();
    } catch {
      stream.abort(new Error('request failed'));
      if (signal.aborted) throw new AppError(504, 'PEER_TIMEOUT', 'The other party did not answer in time');
      throw new AppError(503, 'PEER_UNREACHABLE', 'The other party stopped answering');
    }
    let reply: Envelope;
    try {
      reply = EnvelopeSchema.parse(decode(bytes));
    } catch {
      throw new AppError(502, 'BAD_REPLY', 'The other party sent a malformed answer');
    } finally {
      await stream.close().catch(() => undefined);
    }
    if (!reply.ok) throw new AppError(409, reply.code, reply.message);
    return reply.result;
  }

  /** Accepts long-lived message sessions on `protocol` (e.g. the per-second service protocol). */
  async handleSessions(protocol: string, handler: SessionHandler): Promise<void> {
    await this.node.handle(
      protocol,
      async (stream, connection) => {
        const session = sessionOf(stream, connection.remotePeer.toString());
        try {
          await handler(session);
        } catch {
          // a failing session never affects the others
        } finally {
          await session.close();
        }
      },
      { runOnLimitedConnection: true },
    );
  }

  /** Opens a long-lived message session with a peer on `protocol`. */
  async openSession(peer: PeerTarget, protocol: string): Promise<PeerSession> {
    try {
      const stream = await this.node.dialProtocol(peer.addrs.map((a) => multiaddr(a)), protocol, {
        runOnLimitedConnection: true,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return sessionOf(stream, peer.peerId);
    } catch {
      throw new AppError(503, 'PEER_UNREACHABLE', 'The other party is not reachable right now');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.restoring;
    await this.node.stop();
  }

  private async serve(stream: Stream, connection: Connection): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const lp = lpStream(stream);
    let reply: Envelope;
    try {
      const message = decode((await lp.read({ signal })).subarray());
      if (!this.handler) throw new AppError(503, 'NOT_LISTENING', 'This node does not accept channel messages');
      reply = { ok: true, result: await this.handler(connection.remotePeer.toString(), message) };
    } catch (err) {
      reply = isAppError(err)
        ? { ok: false, code: err.code, message: err.message }
        : { ok: false, code: 'INTERNAL', message: 'The other party could not handle the message' };
    }
    await lp.write(encode(reply), { signal }).catch(() => undefined);
    await stream.close().catch(() => undefined);
  }
}
