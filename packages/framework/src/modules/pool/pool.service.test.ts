import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT } from '../../shared/protocol/index.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import { BUILT_IN_NETWORKS, ChainAdapter } from '../chain/index.ts';
import { KeyRing } from '../keys/index.ts';
import { MemoryStore } from '../storage/index.ts';
import { WalletRepository, WalletService } from '../wallet/index.ts';
import { NATIVE_PRESETS, PoolRepository, PoolService, STABLECOIN_PRESETS, isRoundAmount, selectInputs, type SpendableNote } from './index.ts';

const notes = (...amounts: number[]): SpendableNote[] =>
  amounts.map((amount, i) => ({
    commitment: BigInt(i + 1), leafIndex: i, amount: BigInt(amount), token: 0n, ownerTag: 1n, salt: 2n,
    secret: 'spending', spent: false, unlockSecret: 3n,
  }));
const amounts = (picked: SpendableNote[] | string): bigint[] | string =>
  typeof picked === 'string' ? picked : picked.map((n) => n.amount);

describe('selectInputs', () => {
  it('prefers the smallest single note that covers the amount', () => {
    expect(amounts(selectInputs(notes(50, 200, 120), 100n))).toEqual([120n]);
  });
  it('otherwise picks the cheapest covering pair', () => {
    expect(amounts(selectInputs(notes(40, 70, 65, 10), 100n))).toEqual([40n, 65n]);
  });
  it('reports fragmented notes', () => {
    expect(selectInputs(notes(40, 40, 40), 100n)).toBe('fragmented');
  });
  it('reports insufficient funds', () => {
    expect(selectInputs(notes(40, 50), 100n)).toBe('insufficient');
    expect(selectInputs([], 1n)).toBe('insufficient');
  });
});

describe('amounts', () => {
  it('presets are round; other amounts are not', () => {
    for (const preset of [...NATIVE_PRESETS, ...STABLECOIN_PRESETS]) expect(isRoundAmount(preset)).toBe(true);
    expect(isRoundAmount(1n)).toBe(true);
    expect(isRoundAmount(1_000_000n)).toBe(true);
    expect(isRoundAmount(1_500_000n)).toBe(false);
    expect(isRoundAmount(30n)).toBe(false);
    expect(isRoundAmount(0n)).toBe(false);
  });
  it('every preset fits the 64-bit amount range', () => {
    for (const preset of [...NATIVE_PRESETS, ...STABLECOIN_PRESETS]) expect(preset < 2n ** 64n).toBe(true);
  });
});

describe('PoolService.deposit', () => {
  it('refuses a native deposit above the 64-bit note cap (about 18.44 MON) before touching the chain', async () => {
    const wallet = new WalletService(new WalletRepository(new MemoryStore()), { N: 2 ** 10, r: 8, p: 1 });
    await wallet.importPrivateKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'password123');
    const network = { ...(BUILT_IN_NETWORKS[0] as (typeof BUILT_IN_NETWORKS)[number]), rpcUrl: 'http://127.0.0.1:9', backupRpcUrls: [] };
    const prover: ProverPort = { prove: () => Promise.reject(new Error('no proofs here')) };
    const pool = new PoolService({ wallet, keys: new KeyRing(wallet), chain: new ChainAdapter(network), prover, repository: new PoolRepository(wallet) });
    await expect(pool.deposit(0n, MAX_AMOUNT + 1n)).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', message: 'The most you can add at once is 18.44 MON' });
    // Up to the cap the deposit goes on to the chain (here: an endpoint that does not answer).
    await expect(pool.deposit(0n, MAX_AMOUNT)).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });
});
