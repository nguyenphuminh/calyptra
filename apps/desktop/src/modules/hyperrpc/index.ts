import { AppError, defaultRpcUrls } from '@calyptra/framework';
import type { NetworkConfig } from '@calyptra/framework';
import type { Logger } from '../../shared/logger.ts';
import { JsonRpcAdapter } from './adapters/json-rpc.adapter.ts';
import { HyperRpcService } from './hyperrpc.service.ts';
import { LogCacheService } from './log-cache.service.ts';

export { envioHyperRpcUrl } from './adapters/json-rpc.adapter.ts';
export { hyperRpcRoutes } from './hyperrpc.routes.ts';
export { ALLOWED_METHODS } from './hyperrpc.service.ts';
export type { HyperRpcService } from './hyperrpc.service.ts';

/**
 * The proxy of a network's Calyptra contracts, answering from an event cache that one upstream
 * endpoint (Envio HyperRPC) fills; the head is read on the network's public RPC endpoints.
 * The cache runs once `start()` is called. The intervals are for tests.
 */
export function createHyperRpcService(options: {
  network: NetworkConfig;
  upstreamUrl: string;
  logger: Logger;
  upstreamSpacingMs?: number;
  pollIntervalMs?: number;
}): HyperRpcService {
  const { network, upstreamUrl, logger, upstreamSpacingMs, pollIntervalMs } = options;
  const contracts = network.contracts;
  if (!contracts) throw new AppError(409, 'NOT_DEPLOYED', `Calyptra is not deployed on ${network.name} yet`);
  const cache = new LogCacheService({
    contracts,
    upstream: new JsonRpcAdapter(upstreamUrl),
    heads: defaultRpcUrls(network).map((url) => new JsonRpcAdapter(url)),
    logger,
    upstreamSpacingMs,
    pollIntervalMs,
  });
  return new HyperRpcService(cache, network.chainId, [contracts.pool, contracts.disputes]);
}
