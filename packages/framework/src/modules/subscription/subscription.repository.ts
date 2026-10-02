import { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import { jsonSafe } from '../../shared/utils/json.ts';
import type { WalletService } from '../wallet/index.ts';
import { SubscriptionSchema, type Subscription } from './subscription.schema.ts';

const SECTION = 'subscriptions';
const EntriesSchema = z.array(SubscriptionSchema);

/** The allowance registry, kept as one section of the encrypted wallet document per network. */
export class SubscriptionRepository {
  private readonly wallet: Pick<WalletService, 'readSection' | 'writeSection'>;
  private readonly networkId: string | undefined;
  private closed = false;

  constructor(wallet: Pick<WalletService, 'readSection' | 'writeSection'>, networkId?: string) {
    this.wallet = wallet;
    this.networkId = networkId;
  }

  all(accountId?: string): Subscription[] {
    return this.wallet.readSection(SECTION, EntriesSchema, accountId, this.networkId) ?? [];
  }

  get(channelId: string, accountId?: string): Subscription | undefined {
    return this.all(accountId).find((s) => s.channelId === channelId);
  }

  /** Marks the session stopped: later saves fail, so an old session cannot overwrite a new one's data. */
  close(): void {
    this.closed = true;
  }

  async save(entry: Subscription, accountId?: string): Promise<void> {
    if (this.closed) throw new AppError(409, 'SESSION_STOPPED', 'This session has stopped; its changes are not saved');
    const others = this.all(accountId).filter((s) => s.channelId !== entry.channelId);
    await this.wallet.writeSection(SECTION, jsonSafe([...others, entry]), accountId, this.networkId);
  }
}
