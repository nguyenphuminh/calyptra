import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

/** Printed verbatim by `calyptra help`. */
export const USAGE = `Usage:
  calyptra init (--phrase | --private-key | --import-file <path>)   Create the encrypted data folder
  calyptra start [options]                                           Run the node (interactive shell on a terminal)
  calyptra help

Secrets: CALYPTRA_PASSWORD (data password) and CALYPTRA_SECRET (phrase or private key for init),
otherwise asked for on the terminal.

Options:
  --data-dir <dir>              Data folder (default ~/.calyptra)
  --network <id>                Network to use (built-in id or the custom one)
  --network-file <path>         Custom chain configuration (JSON)
  --libp2p-relays <a,b>         libp2p relays for this node's channels
  --relayers <url,url>          Transaction relayers to use
  --chain-rpcs <url,url>        Your own RPC endpoints of the chain, tried first
  --no-chain-rpc-fallback       Never use the network's public endpoints, even when yours fail
  --max-fee-native <amount>     Highest relayer fee to accept in the native coin
  --max-fee-stablecoin <amount>     Highest relayer fee to accept in the stablecoin
  --rpc                         Serve the local RPC API (127.0.0.1 only, access token)
  --rpc-port <port>             (default 8645)
  --rpc-token-file <path>       Where the access token is written (default ~/.config/calyptra/rpc.json)
  --relayer                     Act as a transaction relayer
  --relayer-account <account>   Account that submits relayed transactions (never one with deposits)
  --relayer-fee-native <amount> Quoted fee in the native coin (default 0.35)
  --relayer-fee-stablecoin <amount> Quoted fee in the stablecoin (default 0.01)
  --relayer-host <host>         (default 0.0.0.0)
  --relayer-port <port>         (default 8646)
  --libp2p-relay                Act as a libp2p relay for other users
  --libp2p-relay-host <host>    (default 0.0.0.0)
  --libp2p-relay-port <port>    (default 8647)
  --libp2p-relay-announce <a,b> Public addresses to give peers instead of the listen address,
                                e.g. /dns4/relay.example/tcp/443/wss behind a TLS proxy
  --merchant                    Sell a service paid by the second (needs DASHSCOPE_API_KEY)
  --merchant-offer <path>       The merchant's offer (JSON)
  --no-shell                    Do not open the interactive shell
  --tick <seconds>              Background sync and channel watching interval (default 15)
  --log-level <level>           (default info)`;

/** Relayer fees quoted when the operator sets none: 0.35 MON (covers a 3.0M gas limit at ~102 gwei), 0.01 AUSD. */
export const DEFAULT_RELAYER_FEES = { native: '0.35', stablecoin: '0.01' } as const;

const port = z.coerce.number().int().min(1).max(65535);
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal amount such as 0.001');

export const ConfigSchema = z
  .object({
    command: z.enum(['init', 'start', 'help']),
    dataDir: z.string().min(1),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    init: z.object({ source: z.enum(['phrase', 'private-key', 'import-file']).nullable(), importFile: z.string().optional() }),
    network: z.string().optional(),
    networkFile: z.string().optional(),
    libp2pRelays: z.array(z.string()).optional(),
    relayers: z.array(z.url()).optional(),
    chainRpcs: z.array(z.url()).optional(),
    chainRpcFallback: z.boolean(),
    maxFee: z.object({ native: decimal.optional(), stablecoin: decimal.optional() }),
    rpc: z.object({ enabled: z.boolean(), port, tokenFile: z.string() }),
    relayer: z.object({
      enabled: z.boolean(),
      host: z.string(),
      port,
      account: z.string().optional(),
      feeNative: decimal.optional(),
      feeStable: decimal.optional(),
    }),
    libp2pRelay: z.object({ enabled: z.boolean(), host: z.string(), port, announce: z.array(z.string()).optional() }),
    merchant: z.object({ enabled: z.boolean(), offerFile: z.string().optional(), apiKey: z.string().min(1).optional() }),
    /** Envio HyperRPC token of the relay host's POST /hyperrpc proxy (§11.3); the proxy is off without it. */
    envioToken: z.string().min(1).optional(),
    shell: z.boolean(),
    tickSeconds: z.coerce.number().int().min(1),
  })
  .superRefine((c, ctx) => {
    if (c.command === 'init' && !c.init.source) {
      ctx.addIssue({ code: 'custom', message: 'init needs --phrase, --private-key or --import-file <path>' });
    }
    // The fees have defaults (§11.2), so only the account must be named.
    if (c.relayer.enabled && (!c.relayer.account || !c.relayer.feeNative || !c.relayer.feeStable)) {
      ctx.addIssue({ code: 'custom', message: '--relayer needs --relayer-account <account>' });
    }
    if (c.merchant.enabled && !c.merchant.offerFile) {
      ctx.addIssue({ code: 'custom', message: '--merchant needs --merchant-offer <offer.json>' });
    }
    if (c.merchant.enabled && !c.merchant.apiKey) {
      ctx.addIssue({ code: 'custom', message: '--merchant needs the DASHSCOPE_API_KEY environment variable' });
    }
  });

export type Config = z.output<typeof ConfigSchema>;

const list = (v: string | undefined): string[] | undefined =>
  v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** Reads the command line (and the server-side secrets from the environment) and validates it once. */
export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Config {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      'log-level': { type: 'string' },
      'import-file': { type: 'string' },
      network: { type: 'string' },
      'network-file': { type: 'string' },
      'libp2p-relays': { type: 'string' },
      relayers: { type: 'string' },
      'chain-rpcs': { type: 'string' },
      'max-fee-native': { type: 'string' },
      'max-fee-stablecoin': { type: 'string' },
      'rpc-port': { type: 'string' },
      'rpc-token-file': { type: 'string' },
      'relayer-host': { type: 'string' },
      'relayer-port': { type: 'string' },
      'relayer-account': { type: 'string' },
      'relayer-fee-native': { type: 'string' },
      'relayer-fee-stablecoin': { type: 'string' },
      'libp2p-relay-host': { type: 'string' },
      'libp2p-relay-port': { type: 'string' },
      'libp2p-relay-announce': { type: 'string' },
      'merchant-offer': { type: 'string' },
      tick: { type: 'string' },
      phrase: { type: 'boolean' },
      'private-key': { type: 'boolean' },
      'chain-rpc-fallback': { type: 'boolean' },
      rpc: { type: 'boolean' },
      relayer: { type: 'boolean' },
      'libp2p-relay': { type: 'boolean' },
      merchant: { type: 'boolean' },
      shell: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const importFile = values['import-file'];
  return ConfigSchema.parse({
    command: values.help ? 'help' : (positionals[0] ?? 'help'),
    dataDir: values['data-dir'] ?? join(homedir(), '.calyptra'),
    logLevel: values['log-level'] ?? 'info',
    init: {
      source: values.phrase ? 'phrase' : values['private-key'] ? 'private-key' : importFile ? 'import-file' : null,
      importFile,
    },
    network: values.network,
    networkFile: values['network-file'],
    libp2pRelays: list(values['libp2p-relays']),
    relayers: list(values.relayers),
    chainRpcs: list(values['chain-rpcs']),
    chainRpcFallback: values['chain-rpc-fallback'] ?? true,
    maxFee: { native: values['max-fee-native'], stablecoin: values['max-fee-stablecoin'] },
    rpc: {
      enabled: values.rpc ?? false,
      port: values['rpc-port'] ?? 8645,
      tokenFile: values['rpc-token-file'] ?? join(homedir(), '.config', 'calyptra', 'rpc.json'),
    },
    relayer: {
      enabled: values.relayer ?? false,
      host: values['relayer-host'] ?? '0.0.0.0',
      port: values['relayer-port'] ?? 8646,
      account: values['relayer-account'],
      feeNative: values['relayer-fee-native'] ?? DEFAULT_RELAYER_FEES.native,
      feeStable: values['relayer-fee-stablecoin'] ?? DEFAULT_RELAYER_FEES.stablecoin,
    },
    libp2pRelay: {
      enabled: values['libp2p-relay'] ?? false,
      host: values['libp2p-relay-host'] ?? '0.0.0.0',
      port: values['libp2p-relay-port'] ?? 8647,
      announce: list(values['libp2p-relay-announce']),
    },
    merchant: {
      enabled: values.merchant ?? false,
      offerFile: values['merchant-offer'],
      apiKey: nonEmpty(env.DASHSCOPE_API_KEY),
    },
    envioToken: nonEmpty(env.CALYPTRA_ENVIO_TOKEN),
    shell: values.shell ?? true,
    tickSeconds: values.tick ?? 15,
  });
}
