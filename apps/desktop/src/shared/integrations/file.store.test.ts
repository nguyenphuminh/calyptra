import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from './file.store.ts';

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'calyptra-store-'));
  dir = join(root, 'data');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileStore', () => {
  it('round-trips values; a missing or deleted key reads as null', async () => {
    const store = new FileStore(dir);
    expect(await store.get('calyptra.wallet')).toBeNull();
    await store.set('calyptra.wallet', '{"a":1}');
    expect(await store.get('calyptra.wallet')).toBe('{"a":1}');
    await store.delete('calyptra.wallet');
    expect(await store.get('calyptra.wallet')).toBeNull();
  });

  it('keeps the folder and its file private, without temporary files left behind', async () => {
    const store = new FileStore(dir);
    await store.set('calyptra.wallet', 'secret');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'calyptra.wallet.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['calyptra.wallet.json']);
  });

  it('applies concurrent writes in call order', async () => {
    const store = new FileStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set('calyptra.wallet', `v${i}`)));
    expect(await store.get('calyptra.wallet')).toBe('v19');
    expect(await readdir(dir)).toEqual(['calyptra.wallet.json']);
  });

  it('refuses keys that could leave the folder', async () => {
    const store = new FileStore(dir);
    await expect(store.set('../etc/passwd', 'x')).rejects.toThrow('Invalid storage key');
    await expect(store.get('../etc/passwd')).rejects.toThrow('Invalid storage key');
  });
});
