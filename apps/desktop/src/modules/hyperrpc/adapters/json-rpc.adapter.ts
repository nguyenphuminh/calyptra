import { AppError } from '@calyptra/framework';

/** Envio HyperRPC for a chain; the API token is part of the URL, so the URL itself is a secret. */
export const envioHyperRpcUrl = (chainId: number, token: string): string => `https://${chainId}.rpc.hypersync.xyz/${token}`;

const TIMEOUT_MS = 30_000;

/** A refusal for spanning too many blocks or returning too many events, as RPC providers word it... */
const RANGE_REFUSAL = /range|blocks|too (many|large)|exceed|limit|more than/i;
/** ...unless it is a rate limit ("rate limit exceeded", "too many requests"). */
const RATE_LIMIT = /rate|too many requests|quota|credit|throttl/i;

/**
 * Sends JSON-RPC requests to one endpoint (Envio HyperRPC, or a public RPC of the network) and returns
 * the `result`. Every failure is an AppError whose message is written here: it never carries the URL
 * (the Envio URL holds the token) nor the endpoint's own error text.
 * - RANGE_REFUSED: the endpoint refused the block range of an eth_getLogs;
 * - UPSTREAM_REFUSED: any other JSON-RPC error;
 * - UPSTREAM_ERROR: no answer, an HTTP error status (such as 429) or an invalid answer.
 */
export class JsonRpcAdapter {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async call(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AppError(502, 'UPSTREAM_ERROR', 'The endpoint did not answer');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(502, 'UPSTREAM_ERROR', `The endpoint answered with status ${response.status}`);
    }
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = null;
    }
    if (typeof body !== 'object' || body === null) throw new AppError(502, 'UPSTREAM_ERROR', 'The endpoint sent an invalid answer');
    if (body.error) {
      const message = typeof body.error.message === 'string' ? body.error.message : '';
      if (RANGE_REFUSAL.test(message) && !RATE_LIMIT.test(message)) throw new AppError(502, 'RANGE_REFUSED', 'The endpoint refused the block range');
      throw new AppError(502, 'UPSTREAM_REFUSED', `The endpoint refused the request (error ${String(body.error.code)})`);
    }
    return body.result;
  }
}
