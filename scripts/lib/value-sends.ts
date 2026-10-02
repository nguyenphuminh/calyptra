// MON sent from one account several times in a row (funder top-ups, test-wallet sweeps). Monad's reserve
// balance (docs.monad.xyz/developer-essentials/reserve-balance): a transaction that sends MON and leaves its
// sender below 10 MON reverts, still paying its gas, unless the sender sent no other transaction in the last
// 3 blocks (the emptying exception). So on Monad each such send waits until the sender's previous
// transaction is MONAD_RESERVE_BLOCKS old. Other chains (anvil, which mines a block only per transaction)
// send at once.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Address, Hash, PublicClient } from 'viem';
import { MONAD_RESERVE_BLOCKS, reserveBalanceOf } from '../../packages/framework/src/modules/chain/index.ts';
import type { DeployWallet } from './deploy.ts';

/** A plain MON transfer uses exactly this much gas; Monad bills the declared limit, so it is set exactly. */
export const TRANSFER_GAS = 21_000n;

/** Per sender (lowercase), the block of its last transaction this process saw confirmed. */
const lastSent = new Map<string, bigint>();

/** Waits for the receipt of any transaction from `from` (with or without MON) and remembers its block. */
export async function confirmSent(client: PublicClient, from: Address, hash: Hash): Promise<void> {
  lastSent.set(from.toLowerCase(), (await client.waitForTransactionReceipt({ hash })).blockNumber);
}

/**
 * Sends `value` MON to `to` and waits for the receipt. On Monad it first waits until the sender's previous
 * transaction is MONAD_RESERVE_BLOCKS old; a sender this process has not seen yet counts as having sent
 * one in the latest block, since another process may have.
 */
export async function sendValueSpaced(
  wallet: DeployWallet,
  client: PublicClient,
  to: Address,
  value: bigint,
  fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {},
): Promise<Hash> {
  const from = wallet.account.address;
  if (reserveBalanceOf(wallet.chain.id) > 0n) {
    const last = lastSent.get(from.toLowerCase()) ?? (await client.getBlockNumber({ cacheTime: 0 }));
    while ((await client.getBlockNumber({ cacheTime: 0 })) < last + MONAD_RESERVE_BLOCKS) await sleep(300);
  }
  const hash = await wallet.sendTransaction({ to, value, gas: TRANSFER_GAS, ...fees });
  await confirmSent(client, from, hash);
  return hash;
}
