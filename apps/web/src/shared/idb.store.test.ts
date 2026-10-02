import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStore } from './idb.store.ts';

describe('IdbStore', () => {
  it('round-trips a value, returns null for a missing key and deletes', async () => {
    const store = new IdbStore('calyptra-test-1');
    expect(await store.get('calyptra.wallet')).toBeNull();
    await store.set('calyptra.wallet', '{"format":"calyptra-wallet"}');
    expect(await store.get('calyptra.wallet')).toBe('{"format":"calyptra-wallet"}');
    await store.delete('calyptra.wallet');
    expect(await store.get('calyptra.wallet')).toBeNull();
  });

  it('applies concurrent writes in order, and a new instance reads the last one', async () => {
    const store = new IdbStore('calyptra-test-2');
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.set('k', `v${i}`)));
    expect(await store.get('k')).toBe('v24');
    expect(await new IdbStore('calyptra-test-2').get('k')).toBe('v24');
  });
});
