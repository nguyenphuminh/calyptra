import type { RelayerService } from '@calyptra/framework';
import { Router } from 'express';
import { RelayerController } from './relayer.controller.ts';

export function relayerRoutes(relayer: RelayerService): Router {
  const controller = new RelayerController(relayer);
  const router = Router();
  router.get('/relayer/info', controller.info);
  router.post('/relayer/submit', controller.submit);
  return router;
}
