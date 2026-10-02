import type { HyperRpcAdapter } from './adapters/hyperrpc.adapter.ts';
import { logFilterSchema } from './hyperrpc.schema.ts';
import type { JsonRpcRequest } from './hyperrpc.schema.ts';

/** The only methods the proxy forwards: enough for the wallet's event history, nothing else. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set(['eth_getLogs', 'eth_blockNumber', 'eth_chainId']);

const METHOD_NOT_FOUND = -32601;

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

/**
 * Wallet sync through Envio HyperRPC (§11.3): forwards the event queries of the Calyptra contracts
 * and refuses everything else with JSON-RPC error -32601, so the token cannot be used for anything
 * else. Every forwarded query is "all events of the pool (or disputes) contract in a block range",
 * never a filter on a user's notes. Nothing is logged.
 */
export class HyperRpcService {
  private readonly upstream: HyperRpcAdapter;
  private readonly contracts: ReadonlySet<string>;

  constructor(upstream: HyperRpcAdapter, contracts: readonly string[]) {
    this.upstream = upstream;
    this.contracts = new Set(contracts.map((c) => c.toLowerCase()));
  }

  forward(request: JsonRpcRequest): Promise<unknown> {
    const refusal = this.refusal(request);
    if (refusal) return Promise.resolve<JsonRpcError>({ jsonrpc: '2.0', id: request.id ?? null, error: { code: METHOD_NOT_FOUND, message: refusal } });
    return this.upstream.call(request);
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
}
