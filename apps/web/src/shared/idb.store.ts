import type { KeyValueStore } from '@calyptra/framework';

const STORE = 'kv';

/** The framework's storage port on IndexedDB: one database, one object store of string values. */
export class IdbStore implements KeyValueStore {
  private readonly name: string;
  private db: Promise<IDBDatabase> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(name = 'calyptra') {
    this.name = name;
  }

  async get(key: string): Promise<string | null> {
    const value = await this.request('readonly', (s) => s.get(key));
    return typeof value === 'string' ? value : null;
  }

  set(key: string, value: string): Promise<void> {
    return this.queue(() => this.request('readwrite', (s) => s.put(value, key)));
  }

  delete(key: string): Promise<void> {
    return this.queue(() => this.request('readwrite', (s) => s.delete(key)));
  }

  /** Opens the database lazily, once. */
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE); // out-of-line keys
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  /** One transaction per call; resolves when it completes, with the request's result. */
  private async request(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** Writes are applied strictly in call order; a failed write does not block later ones. */
  private queue(write: () => Promise<unknown>): Promise<void> {
    const run = this.writes.then(write).then(() => undefined);
    this.writes = run.catch(() => undefined);
    return run;
  }
}
