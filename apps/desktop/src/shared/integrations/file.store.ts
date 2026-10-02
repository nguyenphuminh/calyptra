import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '@calyptra/framework';
import type { KeyValueStore } from '@calyptra/framework';

/**
 * The framework's key-value port on disk: one `<key>.json` file per key in a private folder. The
 * framework only ever stores its encrypted vault here, so the folder never holds unencrypted data.
 */
export class FileStore implements KeyValueStore {
  private readonly dir: string;
  /** Writes run in call order (the last call wins); a failed write does not block later ones. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.pathOf(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const path = this.pathOf(key);
    return this.queue(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, value, { mode: 0o600 });
      await rename(temp, path); // atomic: readers see the old or the new content, never a mix
    });
  }

  async delete(key: string): Promise<void> {
    const path = this.pathOf(key);
    return this.queue(() => rm(path, { force: true }));
  }

  pathOf(key: string): string {
    if (!/^[a-z0-9.-]+$/i.test(key)) throw new AppError(400, 'INVALID_KEY', 'Invalid storage key');
    return join(this.dir, `${key}.json`);
  }

  private queue(write: () => Promise<void>): Promise<void> {
    const run = this.writes.then(write);
    this.writes = run.catch(() => undefined);
    return run;
  }
}
