// Framework services as a host app builds them: users with an in-memory wallet, a
// pool service and real proofs; in-process relayers; channel nodes reachable through a local libp2p
// relay; and whole `Calyptra` nodes (the facade the website and the desktop client build on).
import { parseAbi, parseEther, zeroAddress, type Address } from 'viem';
import { Calyptra, type CalyptraOptions } from '../../packages/framework/src/calyptra.ts';
import { createPeerNode } from '../../packages/framework/src/libp2p.node.ts';
import type { ChainAdapter, NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { ChannelRepository, ChannelService, type ChannelDeps } from '../../packages/framework/src/modules/channel/index.ts';
import { DisputeService } from '../../packages/framework/src/modules/dispute/index.ts';
import { KeyRing } from '../../packages/framework/src/modules/keys/index.ts';
import { P2PService } from '../../packages/framework/src/modules/p2p/index.ts';
import { PoolRepository, PoolService } from '../../packages/framework/src/modules/pool/index.ts';
import { DirectRelayer, RelayerService, type RelayerPort } from '../../packages/framework/src/modules/relayer/index.ts';
import { MemoryStore } from '../../packages/framework/src/modules/storage/index.ts';
import { WalletRepository, WalletService, type KdfParams } from '../../packages/framework/src/modules/wallet/index.ts';
import { Prover, fileArtifacts } from '../../packages/framework/src/shared/integrations/prover.ts';
import type { Deployment } from '../../scripts/lib/deploy.ts';
import { DEVNODE_RPC, REPO } from '../../scripts/lib/devnode.ts';
import { client, dev, devSend } from './chain.ts';

export const PASSWORD = 'password123';
const ARTIFACTS = `${REPO}/packages/framework/artifacts`;
export const prover = new Prover(fileArtifacts(ARTIFACTS));
/** scrypt lowered for test speed. */
export const FAST_KDF: KdfParams = { N: 2 ** 10, r: 8, p: 1 };
const mintAbi = parseAbi(['function mint(address to, uint256 value)']);

export function devNetwork(d: Deployment): NetworkConfig {
  return {
    id: 'devnode',
    name: 'Dev node',
    chainId: d.chainId,
    rpcUrl: DEVNODE_RPC,
    stablecoin: d.stablecoin,
    contracts: { pool: d.pool, disputes: d.disputes, deployBlock: BigInt(d.deployBlock) },
    relayers: [],
    libp2pRelays: [],
  };
}

/** The dev account sends `native` coin and mints `stable` test stablecoin units to `to`, each receipt awaited. */
export async function fund(network: NetworkConfig, to: Address, native: string, stable = 0n): Promise<void> {
  await devSend(async () => {
    const hash = await dev.sendTransaction({ to, value: parseEther(native) });
    await client.waitForTransactionReceipt({ hash });
  });
  if (stable > 0n) {
    await devSend(async () => {
      const hash = await dev.writeContract({ address: network.stablecoin as Address, abi: mintAbi, functionName: 'mint', args: [to, stable] });
      await client.waitForTransactionReceipt({ hash });
    });
  }
}

/** A new 12-word recovery phrase (the wallet's own generator: 128 bits of entropy, English words). */
export const newPhrase = (): string => new WalletService(new WalletRepository(new MemoryStore())).generatePhrase();

export interface User {
  wallet: WalletService;
  keys: KeyRing;
  pool: PoolService;
  address: Address;
}

export async function newUser(network: NetworkConfig, chain: ChainAdapter, native = '1', stable = 0n): Promise<User> {
  const wallet = new WalletService(new WalletRepository(new MemoryStore()), FAST_KDF);
  const account = await wallet.createFromPhrase(newPhrase(), PASSWORD);
  await wallet.setNetwork(network.id);
  const keys = new KeyRing(wallet);
  const pool = new PoolService({ wallet, keys, chain, prover, repository: new PoolRepository(wallet) });
  await fund(network, account.address, native, stable);
  return { wallet, keys, pool, address: account.address };
}

export interface Relayer {
  user: User;
  service: RelayerService;
  port: RelayerPort;
}

/** A relayer whose account holds 5 native coin; its port calls the service in-process (no HTTP). */
export async function newRelayer(network: NetworkConfig, chain: ChainAdapter, fees: { native: bigint; stable: bigint }): Promise<Relayer> {
  const user = await newUser(network, chain, '5');
  const service = new RelayerService(chain, {
    account: user.wallet.signer(),
    keys: await user.keys.poolKeys(),
    fees: { [zeroAddress]: fees.native, [network.stablecoin]: fees.stable },
  });
  return { user, service, port: new DirectRelayer(service) };
}

export interface ChannelNode {
  p2p: P2PService;
  channels: ChannelService;
  disputes: DisputeService;
}

export async function newChannelNode(
  user: User,
  chain: ChainAdapter,
  relayAddr: string,
  relayer: RelayerPort,
  options: Pick<ChannelDeps, 'approveOpen' | 'onJoined' | 'confirmPayment'> = {},
  p2pOptions: { timeoutMs?: number } = {},
): Promise<ChannelNode> {
  const { wallet, keys, pool } = user;
  const p2p = new P2PService(await createPeerNode({ relays: [relayAddr] }), p2pOptions);
  const channels = new ChannelService({
    wallet, keys, chain, pool, prover, p2p, repository: new ChannelRepository(wallet), relayer: () => relayer, ...options,
  });
  await channels.listen();
  await p2p.waitForRelay();
  const disputes = new DisputeService({ wallet, keys, chain, pool, prover, channels });
  return { p2p, channels, disputes };
}

/**
 * A whole node as the website and the desktop client build it: the `Calyptra` facade with an in-memory
 * store, the dev network selected, a new wallet from `phrase` (default: a new one) whose first account
 * holds `native` coin and `stable` stablecoin units, and its services started.
 */
export async function newCalyptra(
  network: NetworkConfig,
  options: Partial<CalyptraOptions> & { phrase?: string; native?: string; stable?: bigint } = {},
): Promise<Calyptra> {
  const { phrase = newPhrase(), native = '0', stable = 0n, ...rest } = options;
  const node = new Calyptra({
    store: new MemoryStore(),
    artifacts: fileArtifacts(ARTIFACTS),
    prover,
    createNode: createPeerNode,
    networks: [network],
    kdf: FAST_KDF,
    ...rest,
  });
  const account = await node.wallet.createFromPhrase(phrase, PASSWORD);
  await node.wallet.setNetwork(network.id);
  if (native !== '0' || stable > 0n) await fund(network, account.address, native, stable);
  await node.start();
  return node;
}

/** `code(p)`: the code a rejection carries (or its text); throws if `p` resolves. */
export async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const coded = err as { code?: unknown };
    return typeof coded.code === 'string' ? coded.code : String(err);
  }
  throw new Error('expected a rejection');
}

/** Polls `check` every 100 ms until it returns true, at most `timeoutMs`. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
