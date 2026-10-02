import { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import { jsonSafe } from '../../shared/utils/json.ts';
import type { WalletService } from '../wallet/index.ts';
import { ChannelRecordSchema, type ChannelRecord } from './channel.schema.ts';

const SECTION = 'channels';
const RecordsSchema = z.array(ChannelRecordSchema);

/** The part of the wallet a repository uses: its encrypted per-account, per-network sections. */
export type SectionStore = Pick<WalletService, 'readSection' | 'writeSection'>;

/** The account's channels, kept as one section of the encrypted wallet document per network. */
export class ChannelRepository {
  private readonly wallet: SectionStore;
  private readonly networkId: string | undefined;
  private closed = false;

  constructor(wallet: SectionStore, networkId?: string) {
    this.wallet = wallet;
    this.networkId = networkId;
  }

  all(accountId?: string): ChannelRecord[] {
    return this.wallet.readSection(SECTION, RecordsSchema, accountId, this.networkId) ?? [];
  }

  get(id: string, accountId?: string): ChannelRecord | undefined {
    return this.all(accountId).find((c) => c.id === id);
  }

  /** Marks the session stopped: later saves fail, so an old session cannot overwrite a new one's data. */
  close(): void {
    this.closed = true;
  }

  async save(record: ChannelRecord, accountId?: string): Promise<void> {
    if (this.closed) throw new AppError(409, 'SESSION_STOPPED', 'This session has stopped; its changes are not saved');
    const others = this.all(accountId).filter((c) => c.id !== record.id);
    await this.wallet.writeSection(SECTION, jsonSafe([...others, record]), accountId, this.networkId);
  }
}
