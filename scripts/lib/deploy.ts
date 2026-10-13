// Contract build and deployment helpers. Contracts are built with Foundry
// (contracts/) and deployed as plain creation transactions, strictly one after another, each awaited:
// a public RPC can hand out a stale nonce, and Monad's `pending` nonce behaves like `latest`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  encodeDeployData,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { z } from 'zod';
import { REPO } from './devnode.ts';

/** Monad's contract code-size limit. */
export const MAX_CODE_SIZE = 128 * 1024;
const CONTRACTS_DIR = `${REPO}/contracts`;
/** Margin over the node's gas estimate for the one-off deployment transactions (Monad bills the limit). */
const GAS_MARGIN_PERCENT = 120n;

export interface Deployment {
  chainId: number;
  pool: Address;
  disputes: Address;
  verifier: Address;
  hasher: Address;
  stablecoin: Address;
  /** First block to scan for pool events: the block number read before the first deployment. */
  deployBlock: string;
}

export interface BuiltContract {
  abi: Abi;
  bytecode: Hex;
  /** Deployed (runtime) code size in bytes. */
  size: number;
}

export interface BuiltContracts {
  verifier: BuiltContract;
  hasher: BuiltContract;
  pool: BuiltContract;
  disputes: BuiltContract;
}

export type DeployWallet = WalletClient<Transport, Chain, Account>;

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const ArtifactSchema = z.object({
  abi: z.array(z.record(z.string(), z.unknown())),
  bytecode: z.object({ object: hex }),
  deployedBytecode: z.object({ object: hex }),
});

function artifact(path: string, name: string): BuiltContract {
  const parsed = ArtifactSchema.parse(JSON.parse(readFileSync(`${CONTRACTS_DIR}/out/${path}`, 'utf8')));
  const size = (parsed.deployedBytecode.object.length - 2) / 2;
  if (size > MAX_CODE_SIZE) throw new Error(`${name}: ${size} bytes exceeds the ${MAX_CODE_SIZE}-byte limit`);
  return { abi: parsed.abi as unknown as Abi, bytecode: parsed.bytecode.object as Hex, size };
}

/**
 * Builds the four contracts with Foundry and checks each runtime size against Monad's limit. With
 * `e2e`, the Disputes contract is the short-window test build (minimum dispute window 10 s).
 */
export function buildContracts({ e2e = false }: { e2e?: boolean } = {}): BuiltContracts {
  execFileSync('forge', ['build'], { cwd: CONTRACTS_DIR, stdio: ['ignore', 'ignore', 'pipe'] });
  return {
    verifier: artifact('Verifier.sol/Verifier.json', 'verifier'),
    hasher: artifact('Hasher.sol/Hasher.json', 'hasher'),
    pool: artifact('Pool.sol/Pool.json', 'pool'),
    disputes: artifact(e2e ? 'Disputes.sol/DisputesShortWindow.json' : 'Disputes.sol/Disputes.json', 'disputes'),
  };
}

const withMargin = (gas: bigint): bigint => (gas * GAS_MARGIN_PERCENT) / 100n;

async function deploy(wallet: DeployWallet, client: PublicClient, contract: BuiltContract): Promise<Address> {
  const data = encodeDeployData({ abi: contract.abi, bytecode: contract.bytecode });
  const gas = withMargin(await client.estimateGas({ account: wallet.account, data }));
  const hash = await wallet.deployContract({ abi: contract.abi, bytecode: contract.bytecode, gas });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('contract deployment failed');
  return receipt.contractAddress;
}

async function initialize(wallet: DeployWallet, client: PublicClient, address: Address, abi: Abi, args: readonly Address[]) {
  const failed = new Error('initialization failed: someone else may have initialized first; redeploy');
  let gas: bigint;
  try {
    gas = withMargin(await client.estimateContractGas({ address, abi, functionName: 'initialize', args, account: wallet.account }));
  } catch {
    throw failed; // the call would revert: already initialized
  }
  const hash = await wallet.writeContract({ address, abi, functionName: 'initialize', args, gas });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw failed;
}

/**
 * Deploys Verifier, Hasher, Pool and Disputes, then wires them: `Pool.initialize(stablecoin, verifier,
 * hasher, disputes)` and `Disputes.initialize(pool, verifier)`, each waited for. `initialize` is
 * permissionless and one-shot, so a deployment someone else initialized first is abandoned.
 */
export async function deployCalyptra(
  wallet: DeployWallet,
  client: PublicClient,
  stablecoin: Address,
  { e2e = false }: { e2e?: boolean } = {},
): Promise<Deployment> {
  const built = buildContracts({ e2e });
  const deployBlock = await client.getBlockNumber();
  const verifier = await deploy(wallet, client, built.verifier);
  const hasher = await deploy(wallet, client, built.hasher);
  const pool = await deploy(wallet, client, built.pool);
  const disputes = await deploy(wallet, client, built.disputes);
  await initialize(wallet, client, pool, built.pool.abi, [stablecoin, verifier, hasher, disputes]);
  await initialize(wallet, client, disputes, built.disputes.abi, [pool, verifier]);
  return { chainId: await client.getChainId(), pool, disputes, verifier, hasher, stablecoin, deployBlock: deployBlock.toString() };
}
