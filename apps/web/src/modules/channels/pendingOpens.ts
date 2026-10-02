import { isAppError, type ChannelRecord } from '@calyptra/framework';
import { errorText } from '../../shared/ui.tsx';

/** A channel this tab is opening, shown while the other side decides (BRD 2.2.14.8). In memory only. */
export interface PendingOpen {
  id: string; // local id and address: #/channels/<id>
  accountId: string;
  networkId: string;
  peerId: string;
  token: bigint;
  amount: bigint;
  peerAmount: bigint;
  state: 'waiting' | 'declined' | 'failed';
  error: string | null; // why it failed; null for waiting and declined
}
export type PendingOpenStart = Pick<PendingOpen, 'accountId' | 'networkId' | 'peerId' | 'token' | 'amount' | 'peerAmount'>;

let counter = 0;

/**
 * Opens in progress from this tab. An open cannot continue after a reload or a lock, so nothing here is
 * persisted; once the other side accepts, the saved channel record takes the item's place.
 */
export class PendingOpens {
  private items: PendingOpen[] = [];
  private readonly fundingErrors = new Map<string, string>();
  private readonly funding = new Set<string>(); // accepted channels this tab is still funding
  private readonly handedOver = new Map<string, string>(); // pending id -> channel id
  private readonly listeners = new Set<() => void>();

  /**
   * Starts an open in the background and returns its pending id at once. `open` runs the framework's
   * open with the `onAccepted` callback it is given; `onOpened` hears when the pending item became a channel.
   */
  start(entry: PendingOpenStart, open: (onAccepted: (channelId: string) => void) => Promise<ChannelRecord>, onOpened: (pendingId: string, channelId: string) => void): string {
    const id = `pending-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    let channelId: string | null = null;
    const handOver = (channel: string): void => {
      if (channelId !== null || !this.items.some((i) => i.id === id)) return;
      channelId = channel;
      this.funding.add(channel);
      this.handedOver.set(id, channel);
      this.items = this.items.filter((i) => i.id !== id);
      this.emit();
      onOpened(id, channel);
    };
    this.items = [...this.items, { ...entry, id, state: 'waiting', error: null }];
    this.emit();
    open(handOver).then(
      (record) => {
        if (channelId === null) handOver(record.id);
        this.funding.delete(record.id);
        this.emit();
      },
      (err: unknown) => {
        const message = errorText(err);
        if (channelId !== null) {
          this.funding.delete(channelId);
          this.fundingErrors.set(channelId, message);
          this.emit();
          return;
        }
        if (!this.items.some((i) => i.id === id)) return; // dismissed or cleared: ignore late answers
        const declined = isAppError(err) && err.code === 'OPEN_DECLINED';
        this.items = this.items.map((i) => (i.id === id ? { ...i, state: declined ? 'declined' : 'failed', error: declined ? null : message } : i));
        this.emit();
      },
    );
    return id;
  }

  channelFor(pendingId: string): string | null {
    return this.handedOver.get(pendingId) ?? null;
  }

  isFunding(channelId: string): boolean {
    return this.funding.has(channelId);
  }

  fundingError(channelId: string): string | null {
    return this.fundingErrors.get(channelId) ?? null;
  }

  list(accountId: string, networkId: string): PendingOpen[] {
    return this.items.filter((i) => i.accountId === accountId && i.networkId === networkId);
  }

  get(id: string): PendingOpen | undefined {
    return this.items.find((i) => i.id === id);
  }

  dismiss(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }

  clear(): void {
    this.items = [];
    this.fundingErrors.clear();
    this.funding.clear();
    this.handedOver.clear();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
