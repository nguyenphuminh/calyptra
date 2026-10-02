import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const NetworkConfigSchema = z.object({
  id: z.string(),                                   // stable id stored in the wallet, e.g. 'monad-testnet'
  name: z.string(),                                 // display name, used in error messages
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),                         // main public endpoint
  /** More public endpoints, tried after `rpcUrl` when it does not answer. */
  backupRpcUrls: z.array(z.string().url()).optional(),
  /** Endpoints for event history only (eth_getLogs), tried before the others for event scans: Envio
   *  HyperRPC behind the relay host's /hyperrpc proxy (§11.3). Every other read and write uses the RPC endpoints. */
  logRpcUrls: z.array(z.string().url()).optional(),
  explorerUrl: z.string().url().optional(),
  stablecoin: address,                              // the ERC-20 the pool supports
  /** Absent until Calyptra is deployed on this chain. */
  contracts: z.object({
    pool: address,
    disputes: address,
    /** First block to scan for pool events. */
    deployBlock: z.coerce.bigint(),
  }).optional(),
  /** Transaction relayers (HTTP endpoints). Users can add their own. */
  relayers: z.array(z.string().url()),
  /** libp2p relays (multiaddrs) that make peers reachable without exposing their IP. */
  libp2pRelays: z.array(z.string()),
  /** Merchants listed in the app without a link (§11.5): merchant-card codes, decoded by the subscription module. */
  merchants: z.array(z.string()).optional(),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

/**
 * The built-in network. Values that only exist after the Stage 2 deployment (§11.10, §13.2) are left
 * out until then, so the network stays valid and simply reports "not deployed" (no contracts) and runs
 * without channels (no libp2p relay). At deployment, fill in:
 *   logRpcUrls:   ['https://relay.<DOMAIN>/hyperrpc'],
 *   contracts:    { pool: '<after deploy>', disputes: '<after deploy>', deployBlock: <after deploy> },
 *                 (printed by `npm run deploy:network -- --network monad-testnet`)
 *   relayers:     ['https://relay.<DOMAIN>'],
 *   libp2pRelays: ['/dns4/relay.<DOMAIN>/tcp/443/wss/p2p/<relay peer id>'],
 *   merchants:    [<merchant-card code of the demo merchant>] (§11.5),
 * where <DOMAIN> is the product owner's domain (deferred) and <relay peer id> the relay host's peer id.
 */
export const BUILT_IN_NETWORKS: readonly NetworkConfig[] = [
  {
    id: 'monad-testnet',
    name: 'Monad Testnet',
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',                    // official, about 50 requests/s
    backupRpcUrls: ['https://rpc.ankr.com/monad_testnet'],
    explorerUrl: 'https://testnet.monadvision.com',
    stablecoin: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc', // AUSD, 6 decimals (checked on chain 2026-10-11)
    relayers: [],
    libp2pRelays: [],
    merchants: [],
  },
];
