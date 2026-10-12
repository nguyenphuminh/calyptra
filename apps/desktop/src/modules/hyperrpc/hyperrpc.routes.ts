import { Router } from 'express';
import { HyperRpcController } from './hyperrpc.controller.ts';
import type { HyperRpcService } from './hyperrpc.service.ts';

export function hyperRpcRoutes(service: HyperRpcService): Router {
  const controller = new HyperRpcController(service);
  const router = Router();
  router.post('/hyperrpc', controller.answer);
  return router;
}
