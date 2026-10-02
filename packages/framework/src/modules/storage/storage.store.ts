/**
 * Where a host keeps the framework's data: the browser's IndexedDB on the website, a data folder on
 * the desktop client, memory in tests. Values are opaque strings; the wallet only ever stores its
 * encrypted vault through this interface (nothing is stored unencrypted).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store for tests and throwaway nodes. */
export class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
