import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, isAppError } from '@calyptra/framework';
import type { Logger } from '../../shared/logger.ts';
import type { JsonRpcAdapter } from './adapters/json-rpc.adapter.ts';
import { quantitySchema, upstreamLogSchema } from './hyperrpc.schema.ts';
import type { UpstreamLog } from './hyperrpc.schema.ts';

/** Blocks per upstream eth_getLogs; halved when the upstream refuses the range, down to MIN_LOG_WINDOW. */
export const LOG_WINDOW = 100_000n;
export const MIN_LOG_WINDOW = 500n;
/** Monad finality margin: the cache stops this many blocks below the head. */
export const FINALITY_BLOCKS = 3n;
/** Upstream calls start at least this far apart: at most 4 a minute (Envio's free tier allows 5). */
export const UPSTREAM_SPACING_MS = 15_000;
/** Pause between two polls once the cache has caught up, and after a failure. */
export const POLL_INTERVAL_MS = 20_000;

/** A cached log: the upstream's object as it came, and the fields the filters read (lowercase). */
export interface CachedLog {
  log: UpstreamLog;
  address: string;
  topics: string[];
  blockNumber: bigint;
  logIndex: bigint;
}

export interface LogCacheOptions {
  contracts: { pool: string; disputes: string; deployBlock: bigint };
  /** Envio HyperRPC: eth_getLogs only, never more often than `upstreamSpacingMs`. */
  upstream: JsonRpcAdapter;
  /** The network's public RPC endpoints, in order: the head is read there (free of Envio's quota). */
  heads: readonly JsonRpcAdapter[];
  logger: Logger;
  upstreamSpacingMs?: number;
  pollIntervalMs?: number;
}

/**
 * Every log of the Pool and Disputes contracts, from the deploy block up to `cachedTo` (head - 3), in
 * memory and sorted by (blockNumber, logIndex). One background loop fills it: one upstream eth_getLogs
 * per window for both contracts until it reaches the head (the backfill), then one per poll. A failure
 * only delays the next step. Only its own progress is logged.
 */
export class LogCacheService {
  private readonly contracts: LogCacheOptions['contracts'];
  private readonly upstream: JsonRpcAdapter;
  private readonly heads: readonly JsonRpcAdapter[];
  private readonly logger: Logger;
  private readonly upstreamSpacingMs: number;
  private readonly pollIntervalMs: number;
  private readonly stopper = new AbortController();
  private readonly cached: CachedLog[] = [];
  private cachedTo: bigint;
  private backfilled = false;
  private window = LOG_WINDOW;
  private lastUpstreamAt = -Infinity;
  private running: Promise<void> | null = null;

  constructor(options: LogCacheOptions) {
    this.contracts = options.contracts;
    this.upstream = options.upstream;
    this.heads = options.heads;
    this.logger = options.logger;
    this.upstreamSpacingMs = options.upstreamSpacingMs ?? UPSTREAM_SPACING_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.cachedTo = options.contracts.deployBlock - 1n;
  }

  /** The last cached block, or null until the backfill has completed. */
  getCachedTo(): bigint | null {
    return this.backfilled ? this.cachedTo : null;
  }

  /** The cached logs, sorted by (blockNumber, logIndex). */
  getLogs(): readonly CachedLog[] {
    return this.cached;
  }

  start(): void {
    this.running ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopper.abort();
    await this.running;
  }

  private async run(): Promise<void> {
    const { signal } = this.stopper;
    while (!signal.aborted) {
      let wait = this.pollIntervalMs;
      try {
        wait = await this.step(signal);
      } catch (err) {
        if (signal.aborted) return;
        const reason = isAppError(err) ? { code: err.code, reason: err.message } : { err }; // AppError messages never hold the URL
        this.logger.warn({ module: 'hyperrpc', ...reason }, 'event cache update failed; retrying later');
      }
      try {
        await sleep(wait, undefined, { signal });
      } catch {
        return; // stopped
      }
    }
  }

  /** One upstream window towards head - 3; returns how long to wait before the next step. */
  private async step(signal: AbortSignal): Promise<number> {
    const target = (await this.head(signal)) - FINALITY_BLOCKS;
    if (target <= this.cachedTo) {
      if (!this.backfilled) this.progress(0);
      return this.pollIntervalMs;
    }
    const from = this.cachedTo + 1n;
    const to = target < from + this.window - 1n ? target : from + this.window - 1n;
    let result: unknown;
    try {
      result = await this.upstreamLogs(from, to, signal);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'RANGE_REFUSED' || this.window <= MIN_LOG_WINDOW) throw err;
      this.window /= 2n; // smaller windows from now on; the same start again
      return 0;
    }
    const parsed = upstreamLogSchema.array().safeParse(result);
    if (!parsed.success) throw new AppError(502, 'UPSTREAM_ERROR', 'The log endpoint sent malformed logs');
    const logs = parsed.data
      .map((log) => ({ log, address: log.address.toLowerCase(), topics: log.topics.map((t) => t.toLowerCase()), blockNumber: BigInt(log.blockNumber), logIndex: BigInt(log.logIndex) }))
      .sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex - b.logIndex) : a.blockNumber < b.blockNumber ? -1 : 1));
    for (const log of logs) this.cached.push(log); // all after cachedTo: the cache stays sorted
    this.cachedTo = to;
    if (to < target) {
      if (!this.backfilled) this.logger.info({ module: 'hyperrpc', cachedTo: Number(to), events: this.cached.length }, 'event cache backfilling');
      return 0; // the next window as soon as the spacing allows
    }
    this.progress(logs.length);
    return this.pollIntervalMs;
  }

  private progress(newEvents: number): void {
    const fields = { module: 'hyperrpc', cachedTo: Number(this.cachedTo), events: this.cached.length };
    if (this.backfilled) {
      this.logger.info({ ...fields, newEvents }, 'event cache polled');
    } else {
      this.backfilled = true;
      this.logger.info(fields, 'event cache backfilled');
    }
  }

  /** The head from the network's public RPC endpoints, the first that answers. */
  private async head(signal: AbortSignal): Promise<bigint> {
    for (const endpoint of this.heads) {
      try {
        return BigInt(quantitySchema.parse(await endpoint.call('eth_blockNumber', [], signal)));
      } catch {
        if (signal.aborted) break;
      }
    }
    throw new AppError(503, 'RPC_UNAVAILABLE', 'No public RPC endpoint of the network answered');
  }

  /** The one kind of upstream call: all logs of both contracts in [from, to], spaced as a simple queue. */
  private async upstreamLogs(from: bigint, to: bigint, signal: AbortSignal): Promise<unknown> {
    const wait = this.lastUpstreamAt + this.upstreamSpacingMs - Date.now();
    if (wait > 0) await sleep(wait, undefined, { signal });
    this.lastUpstreamAt = Date.now();
    const filter = { address: [this.contracts.pool, this.contracts.disputes], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
    return this.upstream.call('eth_getLogs', [filter], signal);
  }
}
