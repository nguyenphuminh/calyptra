import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../storage/index.ts';
import { WalletRepository, WalletService } from '../wallet/index.ts';
import { PoolRepository } from './index.ts';

describe('PoolRepository', () => {
  it('stays on its network and account after the user switches both', async () => {
    const wallet = new WalletService(new WalletRepository(new MemoryStore()), { N: 2 ** 10, r: 8, p: 1 });
    const a = await wallet.createFromPhrase('test test test test test test test test test test test junk', 'password123');
    const b = await wallet.addAccount();
    const network = wallet.networkId();
    const bound = new PoolRepository(wallet, network);
    const note = { commitment: 11n, leafIndex: 0, amount: 1000n, token: 0n, ownerTag: 12n, salt: 13n, secret: { channel: 2 }, spent: false };
    await bound.save({ syncedBlock: 42n, notes: [note] }, a.id);

    await wallet.setNetwork('elsewhere');
    await wallet.setActiveAccount(b.id);
    await bound.save({ syncedBlock: 43n, notes: [note] }, a.id);
    expect(bound.load(a.id)).toEqual({ syncedBlock: 43n, notes: [note] });

    const unbound = new PoolRepository(wallet);
    expect(unbound.load(a.id)).toEqual({ syncedBlock: -1n, notes: [] });   // selected network: elsewhere
    expect(bound.load(b.id)).toEqual({ syncedBlock: -1n, notes: [] });     // account B on the bound network
  });

  it('round-trips a never-synced section and refuses saves once closed', async () => {
    const wallet = new WalletService(new WalletRepository(new MemoryStore()), { N: 2 ** 10, r: 8, p: 1 });
    await wallet.createFromPhrase('test test test test test test test test test test test junk', 'password123');
    const repository = new PoolRepository(wallet, wallet.networkId());
    await repository.save(repository.load());
    expect(repository.load()).toEqual({ syncedBlock: -1n, notes: [] });
    repository.close();
    await expect(repository.save(repository.load())).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
  });
});
