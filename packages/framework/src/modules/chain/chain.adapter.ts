import {
  BaseError, ContractFunctionRevertedError, ExecutionRevertedError, HttpRequestError, RpcRequestError, TimeoutError,
  createPublicClient, createWalletClient, defineChain, http, zeroAddress,
  type Address, type Chain, type Hex, type LocalAccount, type PublicClient,
} from 'viem';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import { disputesAbi, erc20Abi, poolAbi } from './chain.abi.ts';
import type { NetworkConfig } from './chain.config.ts';
import { APPROVE_GAS_LIMIT, DEPOSIT_GAS_LIMIT, MONAD_RESERVE_BLOCKS, reserveBalanceOf } from './chain.gas.ts';

export interface CommitmentEvent { commitment: bigint; leafIndex: number; ciphertext: Hex; blockNumber: bigint }
export interface Dispute { pending: boolean; nonce: bigint; stateHash: bigint; deadline: bigint }

/** Event scans on the RPC endpoints ask for this many blocks at a time: Monad's public RPCs refuse
 *  eth_getLogs over 100 blocks (§11.2, §11.3). Halving stops once the window is <= the minimum. */
const LOG_WINDOW = 100n;
const MIN_LOG_WINDOW = 100n;
/** Event scans on the network's history endpoints (`logRpcUrls`, Envio HyperRPC) start much larger and halve on refusal. */
const LOG_RPC_WINDOW = 100_000n;
const MIN_LOG_RPC_WINDOW = 500n;
/** An endpoint that failed is passed over this long before the more preferred ones are tried again. */
const RETRY_AFTER_MS = 60_000;
/** A native deposit below Monad's reserve waits, polling this often and at most this long, until the
 *  account's previous transaction is MONAD_RESERVE_BLOCKS blocks old (the emptying exception). */
const EMPTYING_POLL_MS = 300;
const EMPTYING_WAIT_MS = 10_000;

/** The network's own RPC endpoints, in order: the main one, then the others it lists. */
export const defaultRpcUrls = (network: NetworkConfig): string[] => [network.rpcUrl, ...(network.backupRpcUrls ?? [])];

/** The chain ID an RPC endpoint answers with, for checking an endpoint before it is saved (settings UI). */
export async function chainIdAt(url: string): Promise<number> {
  try { return await createPublicClient({ transport: http(url, { retryCount: 0, timeout: 10_000 }) }).getChainId(); }
  catch { throw new AppError(503, 'RPC_UNREACHABLE', 'This RPC endpoint does not answer'); }
}

/** Token id (uint160 as bigint; 0 = native coin) -> address. Always lowercase hex. */
export const tokenAddress = (token: bigint): Address =>
  token === 0n ? zeroAddress : (`0x${token.toString(16).padStart(40, '0')}` as Address);

export interface ChainAdapterOptions {
  rpcUrls?: readonly string[];  // endpoints in order of preference (default: defaultRpcUrls(network))
  /** Endpoints for event scans, in order of preference (default: the network's `logRpcUrls`, then `rpcUrls`).
   *  The network's `logRpcUrls` among them scan in large windows, every other one in RPC windows. */
  eventRpcUrls?: readonly string[];
  retryAfterMs?: number;        // default 60_000
  logWindow?: bigint;           // initial blocks per event query on the RPC endpoints, default 100n
  minLogWindow?: bigint;        // halving stops once the window is <= this, default 100n
}

interface Endpoint {
  url: string;
  client: PublicClient;
  logWindow: bigint;           // per endpoint; halved when the endpoint refuses a range; never grows back
  minLogWindow: bigint;
  failedAt: number;            // ms timestamp of last failure; initially -Infinity
  checked: boolean;            // chain id verified
  wrongChain: boolean;         // serves another chain: never used again
}

type Scan<T> = (client: PublicClient, from: bigint, to: bigint) => Promise<T[]>;

/** A failure of the endpoint itself (down, overloaded, timed out, of another chain), not an answer such as a revert. */
function endpointFailed(err: unknown): boolean {
  if (isAppError(err)) return err.code === 'WRONG_CHAIN';
  if (!(err instanceof BaseError)) return err instanceof TypeError;        // fetch failed
  if (err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError)) return false;
  return Boolean(err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError));
}

/** An endpoint refusing an event query for spanning too many blocks or returning too many events. */
const rangeRefused = (err: unknown): boolean =>
  err instanceof BaseError && /range|blocks|too (many|large)|exceed|limit|more than/i.test(err.details ?? err.message);

/**
 * Reads the chain through the network's RPC endpoints with failover (a read runs on one endpoint from
 * start to finish; a transaction is never re-sent through another endpoint), scans events in windows
 * the endpoint accepts, mirrors every dispute locally, and sends the deposit (the only transaction the
 * user's own address sends).
 */
export class ChainAdapter {
  readonly network: NetworkConfig;
  readonly chain: Chain;
  private readonly retryAfterMs: number;
  /** Every read and transaction. */
  private readonly endpoints: Endpoint[];
  /** Event scans (an endpoint listed in both is the same object: one health record per URL). */
  private readonly eventEndpoints: Endpoint[];
  private readonly disputeMirror = { scannedTo: -1n, disputes: new Map<bigint, Dispute>(), finalized: new Set<bigint>() };
  private mirroring: Promise<void> | null = null;
  /** Per sending address (lowercase), the block of the receipt of the last transaction it sent here. */
  private readonly lastSent = new Map<string, bigint>();

  constructor(network: NetworkConfig, options: ChainAdapterOptions = {}) {
    this.network = network;
    this.chain = defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl] } },
      blockTime: 400,   // ms; Monad makes ~300 ms blocks, so receipts are polled at viem's 500 ms floor
    });
    this.retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
    const history = new Set(network.logRpcUrls ?? []);
    const byUrl = new Map<string, Endpoint>();
    const endpointOf = (url: string): Endpoint => {
      let endpoint = byUrl.get(url);
      if (!endpoint) {
        const client = createPublicClient({ chain: this.chain, transport: http(url, { retryCount: 1, timeout: 15_000 }) });
        const [logWindow, minLogWindow] = history.has(url)
          ? [LOG_RPC_WINDOW, MIN_LOG_RPC_WINDOW]
          : [options.logWindow ?? LOG_WINDOW, options.minLogWindow ?? MIN_LOG_WINDOW];
        endpoint = { url, client, logWindow, minLogWindow, failedAt: -Infinity, checked: false, wrongChain: false };
        byUrl.set(url, endpoint);
      }
      return endpoint;
    };
    const urls = [...new Set(options.rpcUrls?.length ? options.rpcUrls : defaultRpcUrls(network))];
    const eventUrls = [...new Set(options.eventRpcUrls?.length ? options.eventRpcUrls : [...history, ...urls])];
    this.endpoints = urls.map(endpointOf);
    this.eventEndpoints = eventUrls.map(endpointOf);
  }

  /** The URL a read would use now. */
  get rpcUrl(): string {
    return this.current().url;
  }

  /** The viem client of the endpoint a read would use now. */
  get client(): PublicClient {
    return this.current().client;
  }

  private current(): Endpoint {
    return this.order(this.endpoints)[0] ?? (this.endpoints[0] as Endpoint);
  }

  contracts(): { pool: Address; disputes: Address; deployBlock: bigint } {
    const contracts = this.network.contracts;
    if (!contracts) throw new AppError(409, 'NOT_DEPLOYED', `Calyptra is not deployed on ${this.network.name} yet`);
    return { pool: contracts.pool as Address, disputes: contracts.disputes as Address, deployBlock: contracts.deployBlock };
  }

  // --- failover ---------------------------------------------------------------------------------

  /** Endpoints to try, in order: those that did not fail lately as listed, then the ones that failed longest ago. */
  private order(endpoints: readonly Endpoint[]): Endpoint[] {
    const now = Date.now();
    const usable = endpoints.filter((e) => !e.wrongChain);
    const fresh = usable.filter((e) => now - e.failedAt >= this.retryAfterMs);
    const failed = usable.filter((e) => now - e.failedAt < this.retryAfterMs).sort((a, b) => a.failedAt - b.failedAt);
    return [...fresh, ...failed];
  }

  private async check(endpoint: Endpoint): Promise<void> {           // once per endpoint
    if (endpoint.checked) return;
    const chainId = await endpoint.client.getChainId();
    if (chainId !== this.network.chainId) {
      endpoint.wrongChain = true;
      throw new AppError(502, 'WRONG_CHAIN', `${endpoint.url} serves chain ${chainId}, not ${this.network.name}`);
    }
    endpoint.checked = true;
  }

  /** Runs one read on one endpoint from start to finish, failing over to the next endpoint as a whole. */
  private async read<T>(run: (endpoint: Endpoint) => Promise<T>, endpoints: readonly Endpoint[] = this.order(this.endpoints)): Promise<T> {
    for (const endpoint of endpoints) {
      try {
        await this.check(endpoint);
        return await run(endpoint);
      } catch (err) {
        if (!endpointFailed(err)) throw err;    // an answer (revert, app error): no failover
        endpoint.failedAt = Date.now();
      }
    }
    throw new AppError(503, 'RPC_UNAVAILABLE', `No RPC endpoint of ${this.network.name} is answering`);
  }

  /** Event scans: on the event endpoints, in their order (one endpoint from start to finish). */
  private readLogs<T>(run: (endpoint: Endpoint) => Promise<T>): Promise<T> {
    return this.read(run, this.order(this.eventEndpoints));
  }

  /** The first endpoint that passes the chain-id check; a whole transaction then stays on it. */
  private forTransaction(): Promise<Endpoint> {
    return this.read(async (endpoint) => endpoint);
  }

  // --- event scans ------------------------------------------------------------------------------

  /** Runs an event query over [from, to] in windows the endpoint accepts. */
  private async windows<T>(endpoint: Endpoint, from: bigint, to: bigint, scan: Scan<T>): Promise<T[]> {
    const out: T[] = [];
    for (let start = from; start <= to; ) {
      const end = start + endpoint.logWindow - 1n < to ? start + endpoint.logWindow - 1n : to;
      try {
        out.push(...(await scan(endpoint.client, start, end)));
        start = end + 1n;
      } catch (err) {
        if (!rangeRefused(err) || endpoint.logWindow <= endpoint.minLogWindow) throw err;
        endpoint.logWindow /= 2n;        // smaller queries from now on, for this endpoint; retry same start
      }
    }
    return out;
  }

  /** The pool's new notes and spent nullifiers from `fromBlock` to the latest block, all from one endpoint. */
  async poolEvents(fromBlock: bigint): Promise<{ toBlock: bigint; commitments: CommitmentEvent[]; nullifiers: bigint[] }> {
    const { pool } = this.contracts();
    return this.readLogs(async (endpoint) => {
      const toBlock = await endpoint.client.getBlockNumber({ cacheTime: 0 });
      if (fromBlock > toBlock) return { toBlock, commitments: [], nullifiers: [] };
      const [created, spent] = await Promise.all([
        this.windows(endpoint, fromBlock, toBlock, (client, from, to) =>
          client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewCommitment', fromBlock: from, toBlock: to, strict: true })),
        this.windows(endpoint, fromBlock, toBlock, (client, from, to) =>
          client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewNullifier', fromBlock: from, toBlock: to, strict: true })),
      ]);
      const commitments = created
        .map((e) => ({ commitment: e.args.commitment, leafIndex: Number(e.args.leafIndex), ciphertext: e.args.ciphertext, blockNumber: e.blockNumber }))
        .sort((a, b) => a.leafIndex - b.leafIndex);
      return { toBlock, commitments, nullifiers: spent.map((e) => e.args.nullifier) };
    });
  }

  // --- dispute mirror (reads every dispute, so the RPC provider never learns which channels are ours) ---

  /** Brings the local dispute mirror up to the latest block; concurrent callers share one scan. */
  refreshDisputes(): Promise<void> {
    this.mirroring ??= this.scanDisputes().finally(() => { this.mirroring = null; });
    return this.mirroring;
  }

  private async scanDisputes(): Promise<void> {
    const { disputes, deployBlock } = this.contracts();
    const mirror = this.disputeMirror;
    const from = mirror.scannedTo < 0n ? deployBlock : mirror.scannedTo + 1n;
    const scan = await this.readLogs(async (endpoint) => {
      const to = await endpoint.client.getBlockNumber({ cacheTime: 0 });
      if (from > to) return null;
      const [submitted, finalized] = await Promise.all([
        this.windows(endpoint, from, to, (client, start, end) =>
          client.getContractEvents({ address: disputes, abi: disputesAbi, eventName: 'DisputeSubmitted', fromBlock: start, toBlock: end, strict: true })),
        this.windows(endpoint, from, to, (client, start, end) =>
          client.getContractEvents({ address: disputes, abi: disputesAbi, eventName: 'ChannelFinalized', fromBlock: start, toBlock: end, strict: true })),
      ]);
      return { to, submitted, finalized };
    });
    if (!scan) return;
    for (const e of scan.submitted) {            // chain order: the latest submission for a channel wins
      mirror.disputes.set(e.args.channelNullifier, { pending: true, nonce: e.args.nonce, stateHash: e.args.stateHash, deadline: e.args.deadline });
    }
    for (const e of scan.finalized) {
      mirror.finalized.add(e.args.channelNullifier);
      const dispute = mirror.disputes.get(e.args.channelNullifier);
      if (dispute) dispute.pending = false;
    }
    mirror.scannedTo = scan.to;
  }

  async disputeOf(channelNullifier: bigint): Promise<Dispute> {
    await this.refreshDisputes();
    return this.disputeMirror.disputes.get(channelNullifier) ?? { pending: false, nonce: 0n, stateHash: 0n, deadline: 0n };
  }

  async isFinalized(channelNullifier: bigint): Promise<boolean> {
    await this.refreshDisputes();
    return this.disputeMirror.finalized.has(channelNullifier);
  }

  // --- other reads ------------------------------------------------------------------------------

  /** Uncached, so a sync right after a transaction sees its block. */
  latestBlock(): Promise<bigint> {
    return this.read((e) => e.client.getBlockNumber({ cacheTime: 0 }));
  }

  isKnownRoot(root: bigint): Promise<boolean> {
    const { pool } = this.contracts();
    return this.read((e) => e.client.readContract({ address: pool, abi: poolAbi, functionName: 'isKnownRoot', args: [root] }));
  }

  /** The dispute windows the contract accepts, in seconds. */
  async windowBounds(): Promise<{ min: bigint; max: bigint }> {
    const { disputes } = this.contracts();
    const [min, max] = await this.read((e) => e.client.readContract({ address: disputes, abi: disputesAbi, functionName: 'windowBounds' }));
    return { min, max };
  }

  /** The latest block's timestamp (seconds). */
  async blockTimestamp(): Promise<bigint> {
    return (await this.read((e) => e.client.getBlock())).timestamp;
  }

  publicBalance(owner: Address, token: bigint): Promise<bigint> {
    return this.read((e) => token === 0n
      ? e.client.getBalance({ address: owner })
      : e.client.readContract({ address: tokenAddress(token), abi: erc20Abi, functionName: 'balanceOf', args: [owner] }));
  }

  // --- the deposit (the only transaction the user's own address sends) ---------------------------

  private async confirm(endpoint: Endpoint, sender: Address, hash: Hex): Promise<Hex> {
    const receipt = await endpoint.client.waitForTransactionReceipt({ hash });
    this.lastSent.set(sender.toLowerCase(), receipt.blockNumber);     // sent, even if it reverted
    if (receipt.status !== 'success') throw new AppError(502, 'TRANSACTION_FAILED', `Transaction ${hash} failed`);
    return hash;
  }

  /** Waits until the sender's last transaction here is MONAD_RESERVE_BLOCKS blocks old (the emptying exception). */
  private async lastSentSettled(endpoint: Endpoint, sender: Address): Promise<void> {
    const last = this.lastSent.get(sender.toLowerCase());
    if (last === undefined) return;
    const deadline = Date.now() + EMPTYING_WAIT_MS;
    while ((await endpoint.client.getBlockNumber({ cacheTime: 0 })) < last + MONAD_RESERVE_BLOCKS) {
      if (Date.now() >= deadline) throw new AppError(503, 'CHAIN_STALLED', 'The network has not moved on since this account’s last transaction; try again in a moment');
      await new Promise((resolve) => setTimeout(resolve, EMPTYING_POLL_MS));
    }
  }

  /** The account deposits; the stablecoin is approved first (exactly `amount`), the native coin is sent with the deposit. */
  async deposit(account: LocalAccount, token: bigint, amount: bigint, inner: bigint, ciphertext: Hex): Promise<Hex> {
    const endpoint = await this.forTransaction();
    const wallet = createWalletClient({ account, chain: this.chain, transport: http(endpoint.url) });
    const { pool } = this.contracts();
    if (token !== 0n) {
      const allowance = await endpoint.client.readContract({ address: tokenAddress(token), abi: erc20Abi, functionName: 'allowance', args: [account.address, pool] });
      if (allowance < amount) {
        await this.confirm(endpoint, account.address, await wallet.writeContract({
          account, chain: this.chain, address: tokenAddress(token), abi: erc20Abi, functionName: 'approve', args: [pool, amount],
          gas: APPROVE_GAS_LIMIT,
        }));
      }
    }
    // A native deposit needs the coin sent plus the fee budget (the declared limit; §5 porting notes).
    // The fees checked are the fees sent. A stablecoin deposit sends no MON: Monad's reserve never applies.
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;
    if (token === 0n) {
      const { maxFeePerGas, maxPriorityFeePerGas } = await endpoint.client.estimateFeesPerGas();
      fees = { maxFeePerGas, maxPriorityFeePerGas };
      const left = (await endpoint.client.getBalance({ address: account.address })) - amount - DEPOSIT_GAS_LIMIT * maxFeePerGas;
      if (left < 0n) throw new AppError(409, 'INSUFFICIENT_PUBLIC_FUNDS', 'This account does not have enough MON for this amount plus the network fee');
      // Below Monad's reserve the deposit relies on the emptying exception: no other transaction from the account in the last 3 blocks.
      if (left < reserveBalanceOf(this.network.chainId)) await this.lastSentSettled(endpoint, account.address);
    }
    const call = {
      account, address: pool, abi: poolAbi, functionName: 'deposit', args: [tokenAddress(token), amount, inner, ciphertext],
      value: token === 0n ? amount : 0n,
    } as const;
    // With an explicit gas limit nothing is estimated, and Monad charges the whole limit of a reverted
    // transaction: simulate first, so a deposit that would revert fails here (viem error) and costs nothing.
    await endpoint.client.simulateContract(call);
    return this.confirm(endpoint, account.address, await wallet.writeContract({ ...call, chain: this.chain, gas: DEPOSIT_GAS_LIMIT, ...fees }));
  }
}
