import type { Libp2p } from '@libp2p/interface';
import { concat, hexToBytes, keccak256, stringToHex } from 'viem';
import { BUILT_IN_NETWORKS, ChainAdapter, defaultRpcUrls, tokenAddress, type NetworkConfig } from './modules/chain/index.ts';
import { ChannelRepository, ChannelService, type ChannelDeps, type TickProblem } from './modules/channel/index.ts';
import { DisputeService } from './modules/dispute/index.ts';
import { KeyRing } from './modules/keys/index.ts';
import { MerchantService, type Offer, type ServicePort } from './modules/merchant/index.ts';
import { P2PService } from './modules/p2p/index.ts';
import { PoolRepository, PoolService } from './modules/pool/index.ts';
import { HttpRelayer, type RelayRequest, type RelayResult, type RelayerInfo, type RelayerPort } from './modules/relayer/index.ts';
import type { KeyValueStore } from './modules/storage/index.ts';
import { SubscriptionRepository, SubscriptionService } from './modules/subscription/index.ts';
import { WalletRepository, WalletService, type KdfParams } from './modules/wallet/index.ts';
import { AppError } from './shared/errors/AppError.ts';
import { Prover, type ArtifactLoader, type ProverPort } from './shared/integrations/prover.ts';

export interface CalyptraOptions {
  /** Where local data is stored (it only ever holds the encrypted wallet). */
  store: KeyValueStore;
  /** Where the circuits' proving files come from (files in Node.js, URLs in the browser). */
  artifacts: ArtifactLoader;
  /** Proves with this instead of snarkjs on the calling thread (the website proves in a Web Worker). */
  prover?: ProverPort;
  /** Creates the libp2p node: createPeerNode from "./libp2p-node" or createBrowserNode from "./libp2p-browser". */
  createNode: (options: { relays: string[]; seed: Uint8Array }) => Promise<Libp2p>;
  /** Chain configurations; the built-in one by default. A custom one is added here. */
  networks?: readonly NetworkConfig[];
  /** libp2p relays to use instead of the network's own list. */
  libp2pRelays?: string[];
  /** The user's own RPC endpoints, tried first and in order; default: the network's own. */
  rpcUrls?: string[];
  /** When the user's endpoints all fail, use the network's own too (default true; only `false` disables). */
  rpcFallback?: boolean;
  /** Transaction relayers to use instead of the network's own list (e.g. an in-process DirectRelayer). */
  relayers?: RelayerPort[];
  /** Highest relayer fee accepted per token (0n = native coin), in base units. Higher quotes are refused. */
  maxFee?: Map<bigint, bigint>;
  /** Dispute window of new channels in seconds, between 3 and 7 days (default: ChannelService's, the contract max). */
  disputeWindow?: bigint;
  /** Decides on channels peers propose. */
  approveOpen?: ChannelDeps['approveOpen'];
  /** After joining a proposed channel. */
  onJoined?: ChannelDeps['onJoined'];
  /** Asked before outgoing channel payments, except those a subscription's allowance covers (§11.5);
   *  without it, outgoing channel payments are signed automatically. */
  confirmPayment?: ChannelDeps['confirmPayment'];
  /** Merchant mode (§11.5): sell this service by the second on the service protocol. Needs a libp2p relay. */
  merchant?: { offer: Offer; service: ServicePort };
  /** Only lowered by tests. */
  kdf?: KdfParams;
}

type Configurable = Partial<Pick<CalyptraOptions, 'networks' | 'libp2pRelays' | 'relayers' | 'rpcUrls' | 'rpcFallback' | 'maxFee' | 'disputeWindow'>>;

/** Services bound to the active account on the current network, alive while the wallet is unlocked. */
interface Session {
  accountId: string;
  network: NetworkConfig;
  chain: ChainAdapter;
  pool: PoolService;
  p2p: P2PService | null;          // null when no libp2p relay is known
  channels: ChannelService | null;
  disputes: DisputeService | null;
  /** Per-second subscriptions this account pays (§11.5); null without P2P. */
  subscriptions: SubscriptionService | null;
  /** The service this node sells (merchant mode, §11.5); null otherwise. */
  merchant: MerchantService | null;
  /** Closed when the session ends, so its unfinished work cannot overwrite the next session's data. */
  stores: { close(): void }[];     // PoolRepository, ChannelRepository, SubscriptionRepository
}

/** Refuses relayers whose quote exceeds the configured maximum fee. */
class CappedRelayer implements RelayerPort {
  private readonly port: RelayerPort;
  private readonly maxFee: Map<bigint, bigint> | undefined;
  constructor(port: RelayerPort, maxFee: Map<bigint, bigint> | undefined) { this.port = port; this.maxFee = maxFee; }
  async info(): Promise<RelayerInfo> {
    const info = await this.port.info();
    for (const [token, max] of this.maxFee ?? []) {
      const quote = info.fees[tokenAddress(token).toLowerCase()];
      if (quote !== undefined && BigInt(quote) > max) throw new AppError(409, 'FEE_ABOVE_MAX', 'The relayer charges more than the maximum fee you accept');
    }
    return info;
  }
  submit(request: RelayRequest): Promise<RelayResult> { return this.port.submit(request); }
}

/**
 * The Calyptra node: the one class hosts build on. It owns the wallet and the key ring, and builds the
 * services of the active account on the selected network on `start()`. It runs no timers: hosts call
 * `tick()` periodically.
 */
export class Calyptra {
  readonly wallet: WalletService;   // lives as long as the node
  readonly keys: KeyRing;
  private options: CalyptraOptions;
  private readonly prover: ProverPort;
  private session: Session | null = null;

  constructor(options: CalyptraOptions) {
    this.options = options;
    this.wallet = new WalletService(new WalletRepository(options.store), options.kdf);
    this.keys = new KeyRing(this.wallet);
    this.prover = options.prover ?? new Prover(options.artifacts);
  }

  /** Changes settings. Relayers and the fee cap apply on the next relayer() call; the rest from the next start(). */
  configure(changes: Configurable): void {
    this.options = { ...this.options, ...changes };
  }

  networks(): readonly NetworkConfig[] {
    return this.options.networks ?? BUILT_IN_NETWORKS;
  }

  /** The selected network's configuration. */
  network(): NetworkConfig {
    const id = this.wallet.networkId();
    const network = this.networks().find((n) => n.id === id);
    if (!network) throw new AppError(404, 'UNKNOWN_NETWORK', `No configuration for network "${id}"`);
    return network;
  }

  /** Starts the services of the active account on the selected network (after unlocking, and after
   *  switching account or network or changing settings). It does not sync: the first tick() does. */
  async start(): Promise<void> {
    // The account's libp2p identity must be free before a new node takes it; until the new
    // services are ready, the previous ones stay reachable (their data stays on their own network).
    // Subscription tickers stop first: they pay through the old node.
    await this.session?.subscriptions?.stop();
    await this.session?.p2p?.stop();
    const { wallet, keys, prover, options } = this;
    const accountId = wallet.activeAccount().id;
    const network = this.network();
    const chain = new ChainAdapter(network, { rpcUrls: this.rpcUrls(), eventRpcUrls: this.eventRpcUrls() });
    const poolStore = new PoolRepository(wallet, network.id);
    const pool = new PoolService({ wallet, keys, chain, prover, repository: poolStore });
    const session: Session = {
      accountId, network, chain, pool, p2p: null, channels: null, disputes: null, subscriptions: null, merchant: null, stores: [poolStore],
    };
    const relays = options.libp2pRelays ?? network.libp2pRelays;
    if (relays.length > 0) {
      // A stable libp2p identity per account, so invites keep working across restarts.
      const seed = hexToBytes(keccak256(concat([(await keys.poolKeys(accountId)).seed, stringToHex('libp2p')])));
      const p2p = new P2PService(await options.createNode({ relays, seed }));
      const channelStore = new ChannelRepository(wallet, network.id);
      const subscriptionStore = new SubscriptionRepository(wallet, network.id);
      session.stores.push(channelStore, subscriptionStore);
      // Payments a subscription's allowance covers are signed without asking; the others go to the host (§11.5).
      const channels: ChannelService = new ChannelService({
        wallet, keys, chain, pool, prover, p2p, repository: channelStore,
        relayer: () => this.relayer(),
        approveOpen: options.approveOpen, onJoined: options.onJoined,
        confirmPayment: (payment): Promise<boolean> => subscriptions.confirmPayment(payment),
        window: options.disputeWindow,
      });
      const subscriptions: SubscriptionService = new SubscriptionService({ channels, p2p, chain, repository: subscriptionStore, confirmPayment: options.confirmPayment });
      await channels.listen();                                             // registers the channel protocol handler
      if (options.merchant) {
        session.merchant = new MerchantService({ p2p, channels, chain, ...options.merchant });
        await session.merchant.listen();                                   // registers the service protocol handler
      }
      session.p2p = p2p;
      session.channels = channels;
      session.disputes = new DisputeService({ wallet, keys, chain, pool, prover, channels });
      session.subscriptions = subscriptions;
    }
    const previous = this.session;
    this.session = session;
    for (const store of previous?.stores ?? []) store.close();
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.subscriptions?.stop();   // lets an in-flight subscription payment finish and save
    for (const store of session?.stores ?? []) store.close();
    await session?.p2p?.stop();
  }

  /** The selected network's endpoints in the order they are tried: the user's own first. */
  rpcUrls(): string[] {
    const own = this.options.rpcUrls ?? [];
    const defaults = defaultRpcUrls(this.network());
    if (own.length === 0) return defaults;
    return [...new Set(this.options.rpcFallback === false ? own : [...own, ...defaults])];
  }

  /** Where event scans (the wallet sync) go, in the order tried: the user's own endpoints, then the
   *  network's history endpoints (`logRpcUrls`), then its RPC endpoints. With the fallback off, only the
   *  user's own: the network's endpoints, history ones included, are never contacted. */
  eventRpcUrls(): string[] {
    const own = this.options.rpcUrls ?? [];
    const network = this.network();
    const networkOwn = [...(network.logRpcUrls ?? []), ...defaultRpcUrls(network)];
    if (own.length === 0) return [...new Set(networkOwn)];
    return [...new Set(this.options.rpcFallback === false ? own : [...own, ...networkOwn])];
  }

  async lock(): Promise<void> {
    await this.stop();
    this.wallet.lock();
    this.keys.clear();
  }

  get chain(): ChainAdapter { return this.current().chain; }
  get pool(): PoolService { return this.current().pool; }
  get p2p(): P2PService { return this.withP2P().p2p; }
  get channels(): ChannelService { return this.withP2P().channels; }
  get disputes(): DisputeService { return this.withP2P().disputes; }
  get subscriptions(): SubscriptionService { return this.withP2P().subscriptions; }
  /** The service this node sells, or null when it is not in merchant mode (or has no libp2p relay). */
  get merchant(): MerchantService | null { return this.current().merchant; }

  /** The first configured relayer, wrapped with the fee cap (no failover between relayers). */
  relayer(): RelayerPort {
    const ports = this.options.relayers ?? this.current().network.relayers.map((url) => new HttpRelayer(url));
    const port = ports[0];
    if (!port) throw new AppError(503, 'NO_RELAYER', 'No transaction relayer is configured for this network');
    return new CappedRelayer(port, this.options.maxFee);
  }

  /** Background work, to call periodically: pool sync, then channel progress, then dispute watching.
   *  Per-channel failures are returned instead of thrown. */
  async tick(): Promise<TickProblem[]> {
    const session = this.current();
    await session.pool.sync(session.accountId);
    if (!session.channels || !session.disputes) return [];
    const relayer = this.relayer();
    return [
      ...(await session.channels.tick(relayer, session.accountId)),
      ...(await session.disputes.tick(relayer, session.accountId)),
    ];
  }

  private current(): Session {
    if (!this.session) throw new AppError(409, 'NOT_STARTED', 'Unlock the wallet and start Calyptra first');
    return this.session;
  }

  private withP2P(): { p2p: P2PService; channels: ChannelService; disputes: DisputeService; subscriptions: SubscriptionService } {
    const { p2p, channels, disputes, subscriptions } = this.current();
    if (!p2p || !channels || !disputes || !subscriptions) {
      throw new AppError(503, 'NO_RELAY', 'Channels need a libp2p relay; add one in the network settings');
    }
    return { p2p, channels, disputes, subscriptions };
  }
}
