import type { RelayerService } from '@calyptra/framework';
import type { Request, Response } from 'express';

/** The public transaction-relayer API; the framework's RelayerService validates and checks everything. */
export class RelayerController {
  private readonly relayer: RelayerService;

  constructor(relayer: RelayerService) {
    this.relayer = relayer;
  }

  info = (_req: Request, res: Response): void => {
    res.json(this.relayer.info());
  };

  submit = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.relayer.relay(req.body));
  };
}
