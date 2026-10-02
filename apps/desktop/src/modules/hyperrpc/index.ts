import { HyperRpcAdapter } from './adapters/hyperrpc.adapter.ts';
import { HyperRpcService } from './hyperrpc.service.ts';

export { envioHyperRpcUrl } from './adapters/hyperrpc.adapter.ts';
export { hyperRpcRoutes } from './hyperrpc.routes.ts';
export { ALLOWED_METHODS } from './hyperrpc.service.ts';
export type { HyperRpcService } from './hyperrpc.service.ts';

/** The proxy for one upstream endpoint, serving the events of these contracts only. */
export function createHyperRpcService(options: { upstreamUrl: string; contracts: readonly string[] }): HyperRpcService {
  return new HyperRpcService(new HyperRpcAdapter(options.upstreamUrl), options.contracts);
}
