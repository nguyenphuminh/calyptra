import type { Request, Response } from 'express';
import { jsonRpcRequestSchema } from './hyperrpc.schema.ts';
import type { HyperRpcService } from './hyperrpc.service.ts';

/** POST /hyperrpc — one JSON-RPC request in, its JSON-RPC answer (from the event cache, or the refusal) out. */
export class HyperRpcController {
  private readonly service: HyperRpcService;

  constructor(service: HyperRpcService) {
    this.service = service;
  }

  answer = (req: Request, res: Response): void => {
    res.json(this.service.answer(jsonRpcRequestSchema.parse(req.body)));
  };
}
