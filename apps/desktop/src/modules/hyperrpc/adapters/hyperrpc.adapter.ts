import { AppError } from '@calyptra/framework';
import type { JsonRpcRequest } from '../hyperrpc.schema.ts';

/** Envio HyperRPC for a chain; the API token is part of the URL, so the URL itself is a secret. */
export const envioHyperRpcUrl = (chainId: number, token: string): string => `https://${chainId}.rpc.hypersync.xyz/${token}`;

const TIMEOUT_MS = 30_000;

/** Sends one JSON-RPC request to the upstream endpoint. Errors never carry the URL (it holds the token). */
export class HyperRpcAdapter {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async call(request: JsonRpcRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AppError(502, 'UPSTREAM_ERROR', 'The log endpoint did not answer');
    }
    if (!response.ok) throw new AppError(502, 'UPSTREAM_ERROR', `The log endpoint answered with status ${response.status}`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new AppError(502, 'UPSTREAM_ERROR', 'The log endpoint sent an invalid answer');
    }
  }
}
