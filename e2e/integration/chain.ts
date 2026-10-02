// Low-level helpers for the integration tests (all-ref §10.3.1): the shared dev chain, fresh deployments,
// funded accounts, notes and ciphertexts, real Groth16 proofs, the pool's tree rebuilt from events, and
// revert-name decoding for simulations.
import { groth16 } from 'snarkjs';
import {
  BaseError,
  ContractFunctionRevertedError,
  bytesToHex,
  createTestClient,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { poolAbi } from '../../packages/framework/src/modules/chain/index.ts';
import {
  MerkleTree,
  encryptNote,
  encryptionPublicKeyOf,
  randomFieldElement,
  toEvmProof,
  type CircuitInput,
  type EvmProof,
  type NotePreimage,
} from '../../packages/framework/src/shared/protocol/index.ts';
import { deployCalyptra, type Deployment } from '../../scripts/lib/deploy.ts';
import { DEVNODE_RPC, REPO, devChain, devPublicClient, devWalletClient } from '../../scripts/lib/devnode.ts';
import { deployTestToken } from '../../scripts/lib/test-token.ts';

export type Wallet = ReturnType<typeof devWalletClient>;
export type CircuitName = 'transfer' | 'finalize' | 'reclaim' | 'submit_state';

const ARTIFACTS = `${REPO}/packages/framework/artifacts`;

export const client = devPublicClient();
export const dev: Wallet = devWalletClient();
const testClient = createTestClient({ mode: 'anvil', chain: devChain, transport: http(DEVNODE_RPC) });

// The dev account sends one transaction at a time: a second one must wait for the first receipt.
let devQueue: Promise<unknown> = Promise.resolve();
export function devSend<T>(task: () => Promise<T>): Promise<T> {
  const next = devQueue.then(task, task);
  devQueue = next.catch(() => undefined);
  return next;
}

/** A new test stablecoin and a fresh set of contracts (short-window Disputes build) for one test file. */
export async function freshDeployment(): Promise<Deployment> {
  return devSend(async () => {
    const stablecoin = await deployTestToken(dev, client);
    return deployCalyptra(dev, client, stablecoin, { e2e: true });
  });
}

/** A new random account funded from the dev account. */
export async function fundedAccount(native = '1'): Promise<Wallet> {
  const wallet = devWalletClient(generatePrivateKey());
  await devSend(async () => {
    const hash = await dev.sendTransaction({ to: wallet.account.address, value: parseEther(native) });
    await client.waitForTransactionReceipt({ hash });
  });
  return wallet;
}

/** A random address with no history. */
export const freshAddress = (): Address => privateKeyToAccount(generatePrivateKey()).address;

export function encryptionKeys(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey, publicKey: encryptionPublicKeyOf(privateKey) };
}

export const ciphertextFor = (keys: { publicKey: Uint8Array }, n: NotePreimage): Hex => bytesToHex(encryptNote(keys.publicKey, n));

export const note = (amount: bigint, token: bigint, ownerTag: bigint): NotePreimage => ({
  amount,
  token,
  ownerTag,
  salt: randomFieldElement(),
});

/** A real Groth16 proof from the circuit's witness generator and proving key in packages/framework/artifacts. */
export async function prove(name: CircuitName, input: CircuitInput): Promise<{ proof: EvmProof; signals: bigint[] }> {
  const { proof, publicSignals } = await groth16.fullProve(input, `${ARTIFACTS}/${name}.wasm`, `${ARTIFACTS}/${name}.zkey`);
  return { proof: toEvmProof(proof), signals: publicSignals.map((s) => BigInt(s)) };
}

/** Rebuilds the pool's tree from its NewCommitment events, as a wallet does. */
export async function mirrorTree(pool: Address, fromBlock: bigint): Promise<MerkleTree> {
  const events = await client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewCommitment', fromBlock, toBlock: 'latest' });
  const sorted = events
    .map((e) => ({ commitment: e.args.commitment as bigint, leafIndex: e.args.leafIndex as bigint }))
    .sort((a, b) => Number(a.leafIndex - b.leafIndex));
  const tree = new MerkleTree();
  for (const { commitment } of sorted) tree.insert(commitment);
  return tree;
}

/** The dev account sends 0 to itself: a new block brings the chain clock up to wall-clock time. */
export async function mineBlock(): Promise<void> {
  await devSend(async () => {
    const hash = await dev.sendTransaction({ to: dev.account.address, value: 0n });
    await client.waitForTransactionReceipt({ hash });
  });
}

/** Moves the dev chain's clock forward and mines a block at the new time (anvil only): a dispute window
 *  passes at once instead of being slept through (the framework compares deadlines with the latest block). */
export async function warp(seconds: number): Promise<void> {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}

/** Mines `blocks` empty blocks at once (anvil only), e.g. to make event history span many query windows. */
export async function mineBlocks(blocks: number): Promise<void> {
  await testClient.mine({ blocks });
}

export interface SendRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export async function send(wallet: Wallet, request: SendRequest): Promise<TransactionReceipt> {
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('transaction reverted');
  return receipt;
}

/** The custom-error name a simulation reverts with. */
export async function revertName(simulation: Promise<unknown>): Promise<string> {
  try {
    await simulation;
  } catch (err) {
    if (err instanceof BaseError) {
      const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.shortMessage;
    }
    throw err;
  }
  throw new Error('expected the call to revert');
}

/** Cast helper for the fixed-size proof and signal tuples of the contract ABI. */
export const tuple = <T extends readonly unknown[]>(values: readonly unknown[]): T => values as unknown as T;
