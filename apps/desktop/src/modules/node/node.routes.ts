import { Router } from 'express';
import { NodeController } from './node.controller.ts';
import type { NodeService } from './node.service.ts';

export function nodeRoutes(node: NodeService): Router {
  const controller = new NodeController(node);
  const router = Router();
  router.post('/rpc/:command', controller.run);
  return router;
}
