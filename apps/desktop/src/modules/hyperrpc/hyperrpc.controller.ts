import type { Request, Response } from 'express';
import { jsonRpcRequestSchema } from './hyperrpc.schema.ts';
import type { HyperRpcService } from './hyperrpc.service.ts';

/** POST /hyperrpc — one JSON-RPC request in, the upstream's (or the refusal's) JSON-RPC answer out. */
export class HyperRpcController {
  private readonly service: HyperRpcService;

  constructor(service: HyperRpcService) {
    this.service = service;
  }

  forward = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.forward(jsonRpcRequestSchema.parse(req.body)));
  };
}
