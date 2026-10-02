import { AppError, type ChannelRecord } from '@calyptra/framework';
import { describe, expect, it, vi } from 'vitest';
import { PendingOpens, type PendingOpenStart } from './pendingOpens.ts';

const entry: PendingOpenStart = { accountId: 'acc', networkId: 'net', peerId: 'peer', token: 0n, amount: 5n, peerAmount: 2n };
const record = (id: string) => ({ id }) as unknown as ChannelRecord;

/** An open the test settles by hand. */
function controlled() {
  let accepted: (channelId: string) => void = () => undefined;
  let resolve: (r: ChannelRecord) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const open = (onAccepted: (channelId: string) => void) => {
    accepted = onAccepted;
    return new Promise<ChannelRecord>((res, rej) => { resolve = res; reject = rej; });
  };
  return { open, accepted: (id: string) => accepted(id), resolve: (r: ChannelRecord) => resolve(r), reject: (e: unknown) => reject(e) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('PendingOpens', () => {
  it('shows a request at once and hands it over when the other side accepts', async () => {
    const store = new PendingOpens();
    const emits = vi.fn();
    store.subscribe(emits);
    const onOpened = vi.fn();
    const c = controlled();
    const id = store.start(entry, c.open, onOpened);
    expect(store.list('acc', 'net')).toMatchObject([{ id, state: 'waiting' }]);
    expect(emits).toHaveBeenCalledTimes(1);
    c.accepted('channel-1');
    expect(store.list('acc', 'net')).toHaveLength(0);
    expect(onOpened).toHaveBeenCalledWith(id, 'channel-1');
    expect(emits).toHaveBeenCalledTimes(2);
    expect(store.channelFor(id)).toBe('channel-1');
    expect(store.isFunding('channel-1')).toBe(true);
    c.resolve(record('channel-1'));
    await settle();
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(emits).toHaveBeenCalledTimes(3);
    expect(store.fundingError('channel-1')).toBeNull();
    expect(store.isFunding('channel-1')).toBe(false);
  });

  it('hands over when the open resolves without the acceptance callback', async () => {
    const store = new PendingOpens();
    const onOpened = vi.fn();
    const c = controlled();
    const id = store.start(entry, c.open, onOpened);
    c.resolve(record('channel-2'));
    await settle();
    expect(onOpened).toHaveBeenCalledWith(id, 'channel-2');
    expect(store.channelFor(id)).toBe('channel-2');
  });

  it('keeps a funding error after acceptance until cleared', async () => {
    const store = new PendingOpens();
    const c = controlled();
    store.start(entry, c.open, () => undefined);
    c.accepted('channel-1');
    c.reject(new AppError(503, 'RELAYER_UNREACHABLE', 'The relayer is not reachable'));
    await settle();
    expect(store.fundingError('channel-1')).toBe('The relayer is not reachable');
    store.clear();
    expect(store.fundingError('channel-1')).toBeNull();
  });

  it('marks a declined open, kept until dismissed, and a failed one with its message', async () => {
    const store = new PendingOpens();
    const declined = controlled();
    const failed = controlled();
    const a = store.start(entry, declined.open, () => undefined);
    const b = store.start(entry, failed.open, () => undefined);
    declined.reject(new AppError(409, 'OPEN_DECLINED', 'The other party declined this channel'));
    failed.reject(new AppError(503, 'PEER_UNREACHABLE', 'The other party is not reachable right now'));
    await settle();
    expect(store.get(a)).toMatchObject({ state: 'declined', error: null });
    expect(store.get(b)).toMatchObject({ state: 'failed', error: 'The other party is not reachable right now' });
    store.dismiss(a);
    expect(store.get(a)).toBeUndefined();
  });

  it('lists only the account and network asked for, and clears everything', () => {
    const store = new PendingOpens();
    store.start(entry, controlled().open, () => undefined);
    store.start({ ...entry, accountId: 'other' }, controlled().open, () => undefined);
    store.start({ ...entry, networkId: 'other' }, controlled().open, () => undefined);
    expect(store.list('acc', 'net')).toHaveLength(1);
    store.clear();
    expect(store.list('acc', 'net')).toHaveLength(0);
  });

  it('ignores an answer that arrives after dismiss', async () => {
    const store = new PendingOpens();
    const onOpened = vi.fn();
    const c = controlled();
    const id = store.start(entry, c.open, onOpened);
    store.dismiss(id);
    c.accepted('channel-3');
    c.resolve(record('channel-3'));
    await settle();
    expect(onOpened).not.toHaveBeenCalled();
    expect(store.list('acc', 'net')).toHaveLength(0);
  });
});
