import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import { ChannelRepository, type SectionStore } from './channel.repository.ts';
import type { ChannelRecord } from './channel.schema.ts';

/** The wallet's section storage, in memory. */
function sections(): SectionStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const keyOf = (section: string, accountId?: string, networkId?: string) => `${accountId ?? 'me'}/${networkId ?? 'net'}/${section}`;
  return {
    values,
    readSection: <T>(section: string, schema: z.ZodType<T>, accountId?: string, networkId?: string): T | undefined => {
      const value = values.get(keyOf(section, accountId, networkId));
      return value === undefined ? undefined : schema.parse(value);
    },
    writeSection: async (section: string, value: unknown, accountId?: string, networkId?: string) => {
      values.set(keyOf(section, accountId, networkId), value);
    },
  } as SectionStore & { values: Map<string, unknown> };
}

const record = (id: string): ChannelRecord => {
  const state = { contribs: [1n, 0n] as const, balA: 9n, balB: 0n, payoutA: 2n, payoutB: 3n, closingFee: 1n, nonce: 5n, final: false };
  return {
    id, role: 'A', index: 0, peer: { peerId: 'peer', addrs: [] }, token: 0n, status: 'opening',
    params: { pkA: [1n, 2n], pkB: [3n, 4n], channelSecret: 5n, window: 6n },
    encPubA: `0x${'11'.repeat(32)}`, encPubB: `0x${'22'.repeat(32)}`, contribA: { amount: 10n, salt: 7n }, contribB: null,
    state0: { state, sigA: null, sigB: null }, latest: { state, sigA: null, sigB: null },
    pending: null, history: [[8n, 1n, 1n, 9n, false]], closeTx: null, createdAt: 1,
  };
};

describe('ChannelRepository', () => {
  it('stores records as JSON and reads them back with bigints', async () => {
    const store = sections();
    const repository = new ChannelRepository(store, 'net');
    await repository.save(record('a'));
    await repository.save({ ...record('b'), status: 'live' });
    await repository.save({ ...record('a'), status: 'funding' });
    expect(repository.all().map((r) => [r.id, r.status])).toEqual([['b', 'live'], ['a', 'funding']]);
    expect(repository.get('a')?.history).toEqual([[8n, 1n, 1n, 9n, false]]);
    expect(JSON.stringify(store.values.get('me/net/channels'))).toContain('"balA":"9"');
  });

  it('refuses to save once its session stopped, and stores nothing', async () => {
    const store = sections();
    const repository = new ChannelRepository(store, 'net');
    repository.close();
    const saving = repository.save(record('a'));
    await expect(saving).rejects.toBeInstanceOf(AppError);
    await expect(saving).rejects.toMatchObject({ code: 'SESSION_STOPPED', message: 'This session has stopped; its changes are not saved' });
    expect(repository.all()).toEqual([]);
    expect(store.values.size).toBe(0);
  });
});
