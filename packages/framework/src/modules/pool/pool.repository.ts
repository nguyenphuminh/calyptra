import { AppError } from '../../shared/errors/AppError.ts';
import type { WalletService } from '../wallet/index.ts';
import { PoolSectionSchema, type PoolSection } from './pool.schema.ts';

const SECTION = 'pool';

/** Decimal strings for every bigint, as the section is stored inside the encrypted wallet document. */
function toJson(section: PoolSection): unknown {
  return {
    syncedBlock: section.syncedBlock.toString(),
    notes: section.notes.map((n) => ({
      ...n,
      commitment: n.commitment.toString(),
      amount: n.amount.toString(),
      token: n.token.toString(),
      ownerTag: n.ownerTag.toString(),
      salt: n.salt.toString(),
    })),
  };
}

/** An account's notes on one network, stored as a section of the encrypted wallet. */
export class PoolRepository {
  private readonly wallet: WalletService;
  /** Bound network; undefined = the selected network at call time. */
  private readonly networkId: string | undefined;
  private closed = false;

  constructor(wallet: WalletService, networkId?: string) {
    this.wallet = wallet;
    this.networkId = networkId;
  }

  load(accountId?: string): PoolSection {
    return this.wallet.readSection(SECTION, PoolSectionSchema, accountId, this.networkId) ?? { syncedBlock: -1n, notes: [] };
  }

  /** The session ended: later saves are refused so they cannot overwrite the next session's data. */
  close(): void {
    this.closed = true;
  }

  async save(section: PoolSection, accountId?: string): Promise<void> {
    if (this.closed) throw new AppError(409, 'SESSION_STOPPED', 'This session has stopped; its changes are not saved');
    await this.wallet.writeSection(SECTION, toJson(section), accountId, this.networkId);
  }
}
