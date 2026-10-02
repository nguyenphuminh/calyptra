import type { Request, Response } from 'express';
import { runCommand } from './node.commands.ts';
import type { NodeService } from './node.service.ts';

/** POST /rpc/:command — the JSON body is the command's input; errors fall through to errorHandler. */
export class NodeController {
  private readonly node: NodeService;

  constructor(node: NodeService) {
    this.node = node;
  }

  run = async (req: Request<{ command: string }>, res: Response): Promise<void> => {
    res.json(await runCommand(this.node, req.params.command, req.body ?? {}));
  };
}
