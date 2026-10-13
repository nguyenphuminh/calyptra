import { getLogsFilterSchema, logFilterSchema } from './hyperrpc.schema.ts';
import type { GetLogsFilter, JsonRpcRequest } from './hyperrpc.schema.ts';
import type { CachedLog, LogCacheService } from './log-cache.service.ts';

/** The only methods the proxy answers: enough for the wallet's event history, nothing else. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set(['eth_getLogs', 'eth_blockNumber', 'eth_chainId']);

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** Before the backfill completes: a plain endpoint failure, so clients use their next endpoint at once. */
const WARMING_UP = -32000;

type Id = string | number | null;

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: Id;
  error: { code: number; message: string };
}
export type JsonRpcResponse = { jsonrpc: '2.0'; id: Id; result: unknown } | JsonRpcError;

const hex = (n: bigint | number): string => `0x${n.toString(16)}`;

/** A filter's block: a hex number, or a tag; a missing block and "latest" (pending, safe, finalized) are the cache's last block. */
function blockOf(block: GetLogsFilter['fromBlock'], cachedTo: bigint): bigint {
  if (block === undefined) return cachedTo;
  if (block === 'earliest') return 0n;
  return block.startsWith('0x') ? BigInt(block) : cachedTo;
}

/** Per position: null matches any topic, else one of these (lowercase). */
const topicRules = (topics: GetLogsFilter['topics']): (string[] | null)[] =>
  (topics ?? []).map((t) => {
    if (t === null) return null;
    if (typeof t === 'string') return [t.toLowerCase()];
    return t.length === 0 || t.includes(null) ? null : t.map((x) => (x ?? '').toLowerCase());
  });

/** Standard topic matching: a log with fewer topics than the filter has positions never matches. */
const topicsMatch = (log: CachedLog, rules: readonly (string[] | null)[]): boolean =>
  rules.length <= log.topics.length && rules.every((rule, i) => rule === null || rule.includes(log.topics[i] ?? ''));

/**
 * Wallet sync through Envio HyperRPC, served from the relay host's event cache: answers the
 * event queries of the Calyptra contracts and refuses everything else with JSON-RPC error -32601, so the
 * token cannot be used for anything else. Clients never reach Envio: only the cache does, within the
 * free tier's quota. Every query is "all events of the pool (or disputes) contract in a block range",
 * never a filter on a user's notes. Nothing is logged.
 */
export class HyperRpcService {
  private readonly cache: LogCacheService;
  private readonly chainId: number;
  private readonly contracts: ReadonlySet<string>;

  constructor(cache: LogCacheService, chainId: number, contracts: readonly string[]) {
    this.cache = cache;
    this.chainId = chainId;
    this.contracts = new Set(contracts.map((c) => c.toLowerCase()));
  }

  /** Starts filling the event cache in the background. */
  start(): void {
    this.cache.start();
  }

  stop(): Promise<void> {
    return this.cache.stop();
  }

  answer(request: JsonRpcRequest): JsonRpcResponse {
    const id = request.id ?? null;
    const error = (code: number, message: string): JsonRpcError => ({ jsonrpc: '2.0', id, error: { code, message } });
    const refusal = this.refusal(request);
    if (refusal) return error(METHOD_NOT_FOUND, refusal);
    const cachedTo = this.cache.getCachedTo();
    if (cachedTo === null) return error(WARMING_UP, 'warming up');
    if (request.method === 'eth_chainId') return { jsonrpc: '2.0', id, result: hex(this.chainId) };
    if (request.method === 'eth_blockNumber') return { jsonrpc: '2.0', id, result: hex(cachedTo) };
    const parsed = getLogsFilterSchema.safeParse(request.params?.[0]);
    if (!parsed.success) return error(INVALID_PARAMS, 'Invalid params');
    if (parsed.data.blockHash !== undefined) return error(INVALID_PARAMS, 'blockHash filters are not supported');
    return { jsonrpc: '2.0', id, result: this.logs(parsed.data, cachedTo) };
  }

  private refusal(request: JsonRpcRequest): string | null {
    if (!ALLOWED_METHODS.has(request.method)) return 'Method not found';
    if (request.method !== 'eth_getLogs') return null;
    const filter = logFilterSchema.safeParse(request.params?.[0]);
    const address = filter.success ? filter.data.address : undefined;
    const addresses = typeof address === 'string' ? [address] : (address ?? []);
    if (addresses.length === 0 || !addresses.every((a) => this.contracts.has(a.toLowerCase()))) {
      return 'Only events of the Calyptra contracts are served';
    }
    return null;
  }

  /** The cached logs a filter selects, in chain order; the range ends at the cache's last block. */
  private logs(filter: GetLogsFilter, cachedTo: bigint): unknown[] {
    const from = blockOf(filter.fromBlock, cachedTo);
    const requestedTo = blockOf(filter.toBlock, cachedTo);
    const to = requestedTo < cachedTo ? requestedTo : cachedTo;
    if (from > to) return [];
    const addresses = new Set((typeof filter.address === 'string' ? [filter.address] : filter.address).map((a) => a.toLowerCase()));
    const rules = topicRules(filter.topics);
    return this.cache
      .getLogs()
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to && addresses.has(l.address) && topicsMatch(l, rules))
      .map((l) => l.log);
  }
}
