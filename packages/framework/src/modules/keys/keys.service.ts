import { z } from 'zod';
import { ownerTagOf } from '../../shared/protocol/index.ts';
import type { WalletService } from '../wallet/index.ts';
import { channelSecrets, derivePoolKeys, type ChannelSecrets, type PoolKeys } from './pool-keys.ts';

const KeysSectionSchema = z.object({ channelCount: z.number().int().nonnegative() });
const SECTION = 'keys';
/** Channel indices beyond the counter whose payout tags a sync still recognises (restored wallets). */
const TAG_MARGIN = 16;

/** Pool keys of the wallet's accounts, derived on demand while unlocked (never stored), plus the
 *  per-account, per-network channel counter. */
export class KeyRing {
  private readonly wallet: WalletService;
  private readonly cache = new Map<string, Promise<PoolKeys>>();   // by signer address

  constructor(wallet: WalletService) {
    this.wallet = wallet;
  }

  /** Throws WALLET_LOCKED synchronously while locked; concurrent callers share one derivation. */
  poolKeys(accountId: string = this.wallet.activeAccount().id): Promise<PoolKeys> {
    const signer = this.wallet.signer(accountId);
    let keys = this.cache.get(signer.address);
    if (!keys) {
      keys = derivePoolKeys(signer);
      this.cache.set(signer.address, keys);
    }
    return keys;
  }

  /** Forgets every derived key (on lock). */
  clear(): void {
    this.cache.clear();
  }

  channelCount(accountId?: string, networkId?: string): number {
    return this.wallet.readSection(SECTION, KeysSectionSchema, accountId, networkId)?.channelCount ?? 0;
  }

  /** Reserves the next channel index atomically (read and in-memory write in the same tick). */
  async newChannel(accountId?: string, networkId?: string): Promise<{ index: number; secrets: ChannelSecrets }> {
    const index = this.channelCount(accountId, networkId);
    await this.wallet.writeSection(SECTION, { channelCount: index + 1 }, accountId, networkId);
    return { index, secrets: channelSecrets(await this.poolKeys(accountId), index) };
  }

  /** Owner tag -> channel index, for every channel so far plus a margin (payouts after a restore). */
  async channelTags(accountId?: string, networkId?: string, margin = TAG_MARGIN): Promise<Map<bigint, number>> {
    const keys = await this.poolKeys(accountId);
    const tags = new Map<bigint, number>();
    const end = this.channelCount(accountId, networkId) + margin;
    for (let i = 0; i < end; i++) tags.set(ownerTagOf(channelSecrets(keys, i).tagSecret), i);
    return tags;
  }
}
