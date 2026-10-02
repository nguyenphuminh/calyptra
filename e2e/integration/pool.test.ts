// Deposit, private transfer and withdrawal against real contracts (all-ref §10.7.2, §10.7.9):
// INT-P1..P6 and the relayer refusals INT-P6b/P6c. Each test builds on the previous one.
import { parseEther, zeroAddress } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChainAdapter, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { shieldedAddressOf } from '../../packages/framework/src/modules/keys/index.ts';
import type { RelayerPort } from '../../packages/framework/src/modules/relayer/index.ts';
import { freshAddress, freshDeployment } from './chain.ts';
import { PASSWORD, devNetwork, newRelayer, newUser, type Relayer, type User } from './services.ts';

const FEE = 10n ** 14n;            // 0.0001 MON
const FEE_STABLE = 10_000n;        // 0.01 AUSD
const NATIVE = 0n;
const mon = (amount: string): bigint => parseEther(amount);

let network: NetworkConfig;
let chain: ChainAdapter;
let STABLE: bigint;
let relayer: Relayer;
let alice: User;
let bob: User;

const balance = (u: User, token: bigint): bigint => u.pool.balances().get(token) ?? 0n;
const addressOf = async (u: User): Promise<string> => shieldedAddressOf(await u.keys.poolKeys());

beforeAll(async () => {
  const d = await freshDeployment();
  network = devNetwork(d);
  chain = new ChainAdapter(network);
  STABLE = BigInt(d.stablecoin);
  relayer = await newRelayer(network, chain, { native: FEE, stable: FEE_STABLE });
  [alice, bob] = await Promise.all([newUser(network, chain, '2', 500_000_000n), newUser(network, chain)]);
});

describe('deposit, private transfer, withdraw', () => {
  it('INT-P1: deposits both tokens and finds its notes', async () => {
    await alice.pool.deposit(NATIVE, mon('0.1'));
    await alice.pool.deposit(STABLE, 100_000_000n);
    expect(balance(alice, NATIVE)).toBe(mon('0.1'));
    expect(balance(alice, STABLE)).toBe(100_000_000n);
    expect(await chain.publicBalance(alice.address, STABLE)).toBe(400_000_000n);
  });

  it('INT-P2: transfers both tokens privately; the payee finds them by trial decryption; the relayer earns its fee', async () => {
    const to = await addressOf(bob);
    await alice.pool.transfer(to, NATIVE, mon('0.03'), relayer.port);
    await alice.pool.transfer(to, STABLE, 25_000_000n, relayer.port);
    await bob.pool.sync();
    await relayer.user.pool.sync();
    expect(balance(bob, NATIVE)).toBe(mon('0.03'));
    expect(balance(bob, STABLE)).toBe(25_000_000n);
    expect(balance(alice, NATIVE)).toBe(mon('0.07') - FEE);
    expect(balance(alice, STABLE)).toBe(75_000_000n - FEE_STABLE);
    expect(balance(relayer.user, NATIVE)).toBe(FEE);
    expect(balance(relayer.user, STABLE)).toBe(FEE_STABLE);
  });

  it('INT-P3: withdraws exactly the public amount to an address with no history (it needs no gas of its own)', async () => {
    const exit = freshAddress();
    await bob.pool.withdraw(NATIVE, mon('0.02'), exit, relayer.port);
    await bob.pool.withdraw(STABLE, 10_000_000n, exit, relayer.port);
    expect(await chain.publicBalance(exit, NATIVE)).toBe(mon('0.02'));
    expect(await chain.publicBalance(exit, STABLE)).toBe(10_000_000n);
    expect(balance(bob, NATIVE)).toBe(mon('0.01') - FEE);
    expect(balance(bob, STABLE)).toBe(15_000_000n - FEE_STABLE);
  });

  it('INT-P4: merges notes first when no two of them cover amount + fee', async () => {
    const carol = await newUser(network, chain);
    for (let i = 0; i < 3; i++) await carol.pool.deposit(NATIVE, mon('0.01'));
    await carol.pool.transfer(await addressOf(bob), NATIVE, mon('0.025'), relayer.port);
    expect(balance(carol, NATIVE)).toBe(mon('0.005') - 2n * FEE); // one merge transfer, then the payment
  });

  it('INT-P5: runs concurrent spends one at a time (the one note is never picked twice)', async () => {
    const dave = await newUser(network, chain);
    await dave.pool.deposit(NATIVE, mon('0.05'));
    const exit = freshAddress();
    await Promise.all([
      dave.pool.transfer(await addressOf(bob), NATIVE, mon('0.01'), relayer.port),
      dave.pool.withdraw(NATIVE, mon('0.01'), exit, relayer.port),
    ]);
    expect(await chain.publicBalance(exit, NATIVE)).toBe(mon('0.01'));
    expect(balance(dave, NATIVE)).toBe(mon('0.03') - 2n * FEE);
  });

  it('INT-P6: refuses a transfer above the shielded balance, and a locked wallet signs nothing', async () => {
    const to = await addressOf(bob);
    const insufficient = alice.pool.transfer(to, NATIVE, mon('5'), relayer.port);
    await expect(insufficient).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS', message: 'Not enough shielded funds in this token (including the relayer fee)',
    });
    alice.wallet.lock();
    alice.keys.clear();
    const locked = alice.pool.transfer(to, NATIVE, mon('0.001'), relayer.port);
    await expect(locked).rejects.toMatchObject({ code: 'WALLET_LOCKED', message: 'The wallet is locked' });
    await alice.wallet.unlock(PASSWORD);
    expect(balance(alice, NATIVE)).toBe(mon('0.07') - FEE);
  });
});

describe('relayer fees (§10.7.9)', () => {
  it('INT-P6b: a relayer refuses a transfer whose fee note is for another relayer', async () => {
    const other = await newRelayer(network, chain, { native: FEE, stable: FEE_STABLE });
    const port: RelayerPort = { info: () => relayer.port.info(), submit: (request) => other.port.submit(request) };
    const before = balance(alice, NATIVE);
    const refused = alice.pool.transfer(await addressOf(bob), NATIVE, mon('0.001'), port);
    await expect(refused).rejects.toMatchObject({ code: 'NO_FEE_NOTE', message: 'The third output is not a fee note for this relayer' });
    await alice.pool.sync();
    expect(balance(alice, NATIVE)).toBe(before); // nothing was sent
  });

  it('INT-P6c: a relayer refuses a fee below its own quote, whatever it advertised', async () => {
    const required = 10n ** 16n; // 0.01 MON
    const greedy = await newRelayer(network, chain, { native: required, stable: FEE_STABLE });
    const port: RelayerPort = {
      info: async () => ({ ...(await greedy.port.info()), fees: { [zeroAddress]: '100000000000000' } }),
      submit: (request) => greedy.port.submit(request),
    };
    const before = balance(alice, NATIVE);
    const refused = alice.pool.transfer(await addressOf(bob), NATIVE, mon('0.001'), port);
    await expect(refused).rejects.toMatchObject({ code: 'FEE_TOO_LOW', message: `The fee is below this relayer's quote of ${required}` });
    await alice.pool.sync();
    expect(balance(alice, NATIVE)).toBe(before);
  });
});
