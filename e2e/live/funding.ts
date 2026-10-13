// Test money for the live tier: a funder key outside the
// repository pays the test wallets on Monad testnet, one transaction at a time, and gets back what a run
// leaves in their accounts. Monad bills the declared gas limit, so funding and sweeping price gas on the
// limit. MON goes out through sendValueSpaced (scripts/lib/value-sends.ts): a send that leaves the sender
// below Monad's 10 MON reserve (a sweep, or a funder running low) goes through only when the sender sent
// nothing else in the last 3 blocks, so every other transaction of these accounts is recorded too.
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  createPublicClient, createWalletClient, defineChain, http, parseEther, parseUnits, formatEther, type Address, type Hex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { BUILT_IN_NETWORKS } from '../../packages/framework/src/index.ts';
import { REPO } from '../../scripts/lib/devnode.ts';
import { TRANSFER_GAS, confirmSent, sendValueSpaced } from '../../scripts/lib/value-sends.ts';

const found = BUILT_IN_NETWORKS.find((n) => n.id === 'monad-testnet');
if (!found) throw new Error('the built-in network monad-testnet is missing');
export const network = found;
export const stablecoin = network.stablecoin as Address;

const chain = defineChain({
  id: network.chainId,
  name: network.name,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } },
});
export const client = createPublicClient({ chain, transport: http(network.rpcUrl) });

/** The AUSD faucet contract: `requestFunds(address)` pays testnet AUSD. */
const AUSD_FAUCET: Address = '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C';

const ERC20_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;
const FAUCET_ABI = [{ type: 'function', name: 'requestFunds', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }], outputs: [] }] as const;

/** The funder's key, read when first needed from ~/.calyptra-secrets/funder.key (never from the repository). */
function funderKey(): Hex {
  const key = readFileSync(`${homedir()}/.calyptra-secrets/funder.key`, 'utf8').trim();
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}
export const funder = (): Address => privateKeyToAccount(funderKey()).address;
const funderWallet = () => createWalletClient({ account: privateKeyToAccount(funderKey()), chain, transport: http(network.rpcUrl) });

let queue: Promise<unknown> = Promise.resolve();
/** One funder transaction at a time: Monad's `pending` nonce behaves like `latest`. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

let decimals: number | null = null;
/** AUSD's decimals, read from the token rather than assumed. */
export async function stablecoinDecimals(): Promise<number> {
  decimals ??= await client.readContract({ address: stablecoin, abi: ERC20_ABI, functionName: 'decimals' });
  return decimals;
}

export const stablecoinBalance = (owner: Address): Promise<bigint> =>
  client.readContract({ address: stablecoin, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });

/** Gas limit with a 20 % margin over the estimate, as the funder's ERC-20 calls declare it. */
const withMargin = (gas: bigint): bigint => (gas * 12n) / 10n;

/** The funder sends `native` MON, then (if given) `stable` AUSD; each waits for its receipt. */
export async function fund(to: Address, native: string, stable?: string): Promise<void> {
  const wallet = funderWallet();
  await serial(() => sendValueSpaced(wallet, client, to, parseEther(native)));
  if (!stable) return;
  const value = parseUnits(stable, await stablecoinDecimals());
  await serial(async () => {
    const gas = withMargin(await client.estimateContractGas({ address: stablecoin, abi: ERC20_ABI, functionName: 'transfer', args: [to, value], account: wallet.account }));
    await confirmSent(client, wallet.account.address, await wallet.writeContract({ address: stablecoin, abi: ERC20_ABI, functionName: 'transfer', args: [to, value], gas }));
  });
}

/** Tops the funder up from the AUSD faucet. */
export async function faucetStablecoin(): Promise<void> {
  const wallet = funderWallet();
  await serial(async () => {
    const gas = withMargin(await client.estimateContractGas({ address: AUSD_FAUCET, abi: FAUCET_ABI, functionName: 'requestFunds', args: [wallet.account.address], account: wallet.account }));
    await confirmSent(client, wallet.account.address, await wallet.writeContract({ address: AUSD_FAUCET, abi: FAUCET_ABI, functionName: 'requestFunds', args: [wallet.account.address], gas }));
  });
}

/** Keeps a test wallet's phrase (git-ignored, owner-only), so money a failed run leaves behind can be recovered. */
export function rememberWallet(name: string, phrase: string): void {
  const dir = `${REPO}/.calyptra/live`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${dir}/test-wallets.jsonl`;
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), name, phrase })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Returns the public money of the phrase's first account to the funder: all its AUSD, then its MON less
 * exactly the transfer's gas (billed on the limit). The MON transfer goes below Monad's reserve, so
 * sendValueSpaced sends it once the account's latest transaction is 3 blocks old (the emptying exception).
 */
export async function sweepPublic(phrase: string): Promise<string> {
  const account = mnemonicToAccount(phrase);
  const wallet = createWalletClient({ account, chain, transport: http(network.rpcUrl) });
  const to = funder();
  const stable = await stablecoinBalance(account.address);
  if (stable > 0n) {
    const gas = withMargin(await client.estimateContractGas({ address: stablecoin, abi: ERC20_ABI, functionName: 'transfer', args: [to, stable], account }));
    await confirmSent(client, account.address, await wallet.writeContract({ address: stablecoin, abi: ERC20_ABI, functionName: 'transfer', args: [to, stable], gas }));
  }
  const balance = await client.getBalance({ address: account.address });
  const maxFeePerGas = (await client.estimateFeesPerGas()).maxFeePerGas * 2n;
  const value = balance - TRANSFER_GAS * maxFeePerGas;
  if (value <= parseEther('0.0001')) return `${account.address}: ${formatEther(balance)} MON left (dust)`;
  await sendValueSpaced(wallet, client, to, value, { maxFeePerGas, maxPriorityFeePerGas: 0n });
  return `${account.address}: returned ${formatEther(value)} MON`;
}
