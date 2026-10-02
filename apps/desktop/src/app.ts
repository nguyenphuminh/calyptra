import type { RelayerService } from '@calyptra/framework';
import express from 'express';
import type { Express } from 'express';
import type { HyperRpcService } from './modules/hyperrpc/index.ts';
import { hyperRpcRoutes } from './modules/hyperrpc/index.ts';
import type { NodeService } from './modules/node/index.ts';
import { nodeRoutes } from './modules/node/index.ts';
import { relayerRoutes } from './modules/relayer/index.ts';
import type { Logger } from './shared/logger.ts';
import { bearerToken, errorHandler, localOnly, notFound, openCors, requestId, requestLog } from './shared/middlewares/index.ts';

/** The local RPC API: 127.0.0.1 only, every call but /healthz needs the access token. */
export function createRpcApp(options: { node: NodeService; token: string; logger: Logger; ready: () => boolean }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  app.use(requestId(), requestLog(options.logger, 'rpc'), localOnly());
  app.get('/healthz', (_req, res) => {
    res.status(options.ready() ? 200 : 503).json({ ok: options.ready() });
  });
  app.use(bearerToken(options.token), express.json({ limit: '1mb' })); // the body is parsed only after auth
  app.use(nodeRoutes(options.node));
  app.use(notFound);
  app.use(errorHandler(options.logger));
  return app;
}

/**
 * The public transaction-relayer API, open to anyone. On the relay host it also serves the wallet-sync
 * proxy POST /hyperrpc (§11.3), mounted before the request log so its traffic leaves no log line.
 */
export function createRelayerApp(options: { relayer: RelayerService; logger: Logger; hyperRpc?: HyperRpcService }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId());
  if (options.hyperRpc) {
    app.use('/hyperrpc', openCors(), express.json({ limit: '64kb' }));
    app.use(hyperRpcRoutes(options.hyperRpc)); // POST /hyperrpc only; everything else goes on below
  }
  app.use(requestLog(options.logger, 'relayer'), openCors(), express.json({ limit: '64kb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(relayerRoutes(options.relayer));
  app.use(notFound);
  app.use(errorHandler(options.logger));
  return app;
}
