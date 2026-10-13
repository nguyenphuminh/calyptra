// Live deployment from the current commit: the website on the CDN at https://calyptra.space
// and the relay host relay.calyptra.space (desktop client as transaction relayer, libp2p relay, /hyperrpc
// wallet-sync proxy and, with a Gemini key, the Gemini merchant) behind Caddy. Idempotent.
//   npm run deploy:live [-- --project <cloud project id>]
// Needs the operator's domain, cloud project and credentials.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_NETWORKS, P2PService } from '@calyptra/framework';
import type { NetworkConfig } from '@calyptra/framework';
import { createPeerNode } from '@calyptra/framework/libp2p-node';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther } from 'viem';
import type { Address, Hex } from 'viem';
import { english, generateMnemonic, privateKeyToAccount } from 'viem/accounts';
import { desktopRpc, freePort, runDesktop, startDesktop, stopDesktop } from './lib/desktop-process.ts';
import { sendValueSpaced } from './lib/value-sends.ts';

/** The domain the website and the relay host are served from. */
const DOMAIN = 'calyptra.space';
const RELAY_HOST = `relay.${DOMAIN}`;
const RELAYER_URL = `https://${RELAY_HOST}`;
const NETWORK_ID = 'monad-testnet';
/** Reference VM: 2 shared vCPU / 2 GB, Debian 12, 20 GB disk, static external IP. */
const VM = { name: 'calyptra-relay', region: 'us-central1', zone: 'us-central1-a', machine: 'e2-small', tag: 'calyptra-relay' };
/**
 * The relayer account only pays gas, billed on the declared limit: about 0.31 MON per relayed
 * transfer (3.0M gas at ~102 gwei). Relayed calls send no MON, so Monad's 10 MON reserve does not apply.
 * Below 2 MON (about 6 transfers) it is topped up to 5 MON.
 */
const RELAYER_MIN = parseEther('2');
const RELAYER_TARGET = parseEther('5');
/** The cloud CLI (Google Cloud); its path can be overridden. */
const CLOUD_CLI = process.env.CALYPTRA_CLOUD_CLI ?? 'gcloud';

const REPO = join(import.meta.dirname, '..');
const LIVE = join(REPO, '.calyptra', 'live');
const SECRETS = join(homedir(), '.calyptra-secrets');
const DNS_TOKEN_FILE = join(SECRETS, 'cloudflare.token');
const FUNDER_KEY_FILE = join(SECRETS, 'funder.key');
const MERCHANT_OFFER = join(REPO, 'scripts', 'live', 'merchant-offer.json');

const relayAddress = (peerId: string): string => `/dns4/${RELAY_HOST}/tcp/443/wss/p2p/${peerId}`;

interface RelayWallet {
  password: string;
  phrase: string;
  relayerAccount: Address;
  relayPeerId: string;
}

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function cloud(args: readonly string[], options: { quiet?: boolean } = {}): string {
  return execFileSync(CLOUD_CLI, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', options.quiet ? 'pipe' : 'inherit'] }).trim();
}
function cloudOk(args: readonly string[]): boolean {
  return spawnSync(CLOUD_CLI, [...args], { stdio: 'ignore' }).status === 0;
}

function network(): NetworkConfig {
  const found = BUILT_IN_NETWORKS.find((n) => n.id === NETWORK_ID);
  if (!found) throw new Error(`no built-in network ${NETWORK_ID}`);
  return found;
}

/** 1. The relay's wallet, created once locally: its first account decides the relay's peer id. */
async function relayWallet(): Promise<RelayWallet> {
  const file = join(LIVE, 'wallet.json');
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8')) as RelayWallet;
  await mkdir(LIVE, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString('hex');
  const phrase = generateMnemonic(english, 128);
  const dataDir = join(LIVE, 'node');
  const env = { CALYPTRA_PASSWORD: password, CALYPTRA_SECRET: phrase };
  const init = await runDesktop(['init', '--phrase', '--data-dir', dataDir], env);
  if (init.code !== 0) throw new Error(init.stderr);
  const tokenFile = join(LIVE, 'rpc.json');
  const node = await startDesktop(
    ['start', '--data-dir', dataDir, '--network', NETWORK_ID, '--no-shell', '--log-level', 'warn', '--rpc', '--rpc-port', String(await freePort()),
      '--rpc-token-file', tokenFile, '--libp2p-relay', '--libp2p-relay-host', '127.0.0.1', '--libp2p-relay-port', String(await freePort())],
    env,
  );
  try {
    const rpc = JSON.parse(await readFile(tokenFile, 'utf8')) as { url: string; token: string };
    const relayerAccount = (await desktopRpc<{ id: Address }>(rpc, 'account.add')).id;
    const relayPeerId = node.ready.libp2pRelay?.[0]?.split('/p2p/')[1] ?? '';
    const wallet = { password, phrase, relayerAccount, relayPeerId };
    await writeFile(file, JSON.stringify(wallet, null, 2), { mode: 0o600 });
    return wallet;
  } finally {
    await stopDesktop(node.child);
  }
}

/** 2. The built-in network must already list this relay host (and its /hyperrpc proxy), so the deployed website finds it. */
function checkNetworkConfig(wallet: RelayWallet): void {
  const n = network();
  const relay = relayAddress(wallet.relayPeerId);
  const hyperRpc = `${RELAYER_URL}/hyperrpc`;
  const needsLogRpc = Boolean(process.env.CALYPTRA_ENVIO_TOKEN);
  if (!n.relayers.includes(RELAYER_URL) || !n.libp2pRelays.includes(relay) || (needsLogRpc && !(n.logRpcUrls ?? []).includes(hyperRpc))) {
    throw new Error(
      `the built-in network ${NETWORK_ID} (packages/framework/src/modules/chain/chain.config.ts) must contain:\n` +
        `  relayers: ['${RELAYER_URL}'],\n  libp2pRelays: ['${relay}'],\n` +
        (needsLogRpc ? `  logRpcUrls: ['${hyperRpc}'],\n` : '') +
        'Update it, commit, and run this again.',
    );
  }
}

/** 4. The cloud project: --project, else the CLI's configured one, else the only one. */
function projectId(): string {
  const given = option('project');
  if (given) return given;
  const configured = cloud(['config', 'get-value', 'project'], { quiet: true });
  if (configured && configured !== '(unset)') return configured;
  const ids = cloud(['projects', 'list', '--format=value(projectId)'], { quiet: true }).split('\n').filter(Boolean);
  if (ids.length === 1 && ids[0]) return ids[0];
  throw new Error(`choose the cloud project: npm run deploy:live -- --project <id> (${ids.join(', ')})`);
}

/** 5. The relayer account pays the gas of relayed transactions. */
async function fundRelayer(wallet: RelayWallet): Promise<void> {
  const n = network();
  const chain = defineChain({ id: n.chainId, name: n.name, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [n.rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(n.rpcUrl) });
  const balance = await client.getBalance({ address: wallet.relayerAccount });
  console.log(`relayer account ${wallet.relayerAccount}: ${formatEther(balance)} MON`);
  if (balance >= RELAYER_MIN) return;
  if (!existsSync(FUNDER_KEY_FILE)) {
    console.log(`⚠ send some ${n.name} MON to ${wallet.relayerAccount}: it pays the gas of relayed transactions`);
    return;
  }
  const key = (await readFile(FUNDER_KEY_FILE, 'utf8')).trim();
  const funder = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  const value = RELAYER_TARGET - balance;
  const hash = await sendValueSpaced(createWalletClient({ account: funder, chain, transport: http(n.rpcUrl) }), client, wallet.relayerAccount, value);
  console.log(`topped up to ${formatEther(RELAYER_TARGET)} MON with ${formatEther(value)} MON from ${funder.address} (${hash})`);
}

/** 6. Compute API, static IP, firewall for 80 (ACME) and 443 (HTTPS + WSS), the VM. Returns its IP. */
function ensureVm(project: string): string {
  const p = ['--project', project];
  cloud(['services', 'enable', 'compute.googleapis.com', ...p]);
  if (!cloudOk(['compute', 'addresses', 'describe', VM.name, '--region', VM.region, ...p])) {
    cloud(['compute', 'addresses', 'create', VM.name, '--region', VM.region, ...p]);
  }
  const ip = cloud(['compute', 'addresses', 'describe', VM.name, '--region', VM.region, '--format=value(address)', ...p], { quiet: true });
  if (!cloudOk(['compute', 'firewall-rules', 'describe', 'calyptra-relay-web', ...p])) {
    cloud(['compute', 'firewall-rules', 'create', 'calyptra-relay-web', '--allow', 'tcp:80,tcp:443', '--target-tags', VM.tag, ...p]);
  }
  if (!cloudOk(['compute', 'instances', 'describe', VM.name, '--zone', VM.zone, ...p])) {
    cloud(['compute', 'instances', 'create', VM.name, '--zone', VM.zone, '--machine-type', VM.machine, '--image-family', 'debian-12',
      '--image-project', 'debian-cloud', '--boot-disk-size', '20GB', '--address', ip, '--tags', VM.tag, ...p]);
  }
  return ip;
}

/** The DNS/CDN API token: the operator's token file, else the zone token of the CDN's local login certificate. */
async function dnsToken(): Promise<string> {
  if (existsSync(DNS_TOKEN_FILE)) return (await readFile(DNS_TOKEN_FILE, 'utf8')).trim();
  const cert = join(homedir(), '.cloudflared', 'cert.pem');
  if (existsSync(cert)) {
    const body = (await readFile(cert, 'utf8')).match(/-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]+?)-----END ARGO TUNNEL TOKEN-----/)?.[1];
    const token = body ? (JSON.parse(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')) as { apiToken?: string }).apiToken : undefined;
    if (token) return token;
  }
  throw new Error(`no DNS token: put an API token in ${DNS_TOKEN_FILE} or log in with the CDN's CLI`);
}

async function cdn<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const payload = (await res.json()) as { success: boolean; errors: unknown[]; result: T };
  if (!payload.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(payload.errors)}`);
  return payload.result;
}

async function zoneOf(token: string): Promise<{ id: string; account: { id: string } }> {
  const [zone] = await cdn<{ id: string; account: { id: string } }[]>(token, `/zones?name=${DOMAIN}`);
  if (!zone) throw new Error(`this login cannot see the zone ${DOMAIN}`);
  return zone;
}

/** 7. A record relay.calyptra.space -> IP, DNS only (not proxied), before the proxy asks for its certificate. */
async function pointDns(token: string, ip: string): Promise<void> {
  const zone = await zoneOf(token);
  const records = await cdn<{ id: string; content: string }[]>(token, `/zones/${zone.id}/dns_records?type=A&name=${RELAY_HOST}`);
  const record = { type: 'A', name: RELAY_HOST, content: ip, ttl: 300, proxied: false };
  const existing = records[0];
  if (existing?.content === ip) return;
  if (existing) await cdn(token, `/zones/${zone.id}/dns_records/${existing.id}`, { method: 'PUT', body: record });
  else await cdn(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: record });
  console.log(`DNS: ${RELAY_HOST} -> ${ip}`);
}

/** 8. Ships the commit, the relay's data folder and its secrets, then runs install-relay.sh as root. */
async function installRelay(project: string, wallet: RelayWallet): Promise<void> {
  const upload = join(LIVE, 'upload');
  await rm(upload, { recursive: true, force: true });
  await mkdir(upload, { recursive: true, mode: 0o700 });
  execFileSync('git', ['archive', '--format=tar.gz', '-o', join(upload, 'release.tgz'), 'HEAD'], { cwd: REPO });
  execFileSync('tar', ['-czf', join(upload, 'node-data.tgz'), '-C', LIVE, 'node']);
  // Server-side secrets come from the operator's environment and are never committed.
  const secrets = [`CALYPTRA_PASSWORD=${wallet.password}`];
  if (process.env.CALYPTRA_ENVIO_TOKEN) secrets.push(`CALYPTRA_ENVIO_TOKEN=${process.env.CALYPTRA_ENVIO_TOKEN}`);
  else console.log('⚠ CALYPTRA_ENVIO_TOKEN is not set: the relay host will not serve /hyperrpc (wallets fall back to the public RPC)');
  const merchant = Boolean(process.env.GEMINI_API_KEY);
  if (merchant) secrets.push(`GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
  else console.log('⚠ GEMINI_API_KEY is not set: the relay host will not run the Gemini merchant');
  await writeFile(join(upload, 'node.env'), `${secrets.join('\n')}\n`, { mode: 0o600 });
  await copyFile(join(REPO, 'scripts', 'live', 'install-relay.sh'), join(upload, 'install-relay.sh'));
  const files = ['release.tgz', 'node-data.tgz', 'node.env', 'install-relay.sh'];
  if (merchant) {
    await copyFile(MERCHANT_OFFER, join(upload, 'merchant-offer.json'));
    // A merchant proves its own disputes, so it needs the proving files (generated, not committed).
    execFileSync('tar', ['-czf', join(upload, 'artifacts.tgz'), '-C', join(REPO, 'packages', 'framework', 'artifacts'), '.']);
    files.push('merchant-offer.json', 'artifacts.tgz');
  }
  const where = ['--zone', VM.zone, '--project', project];
  for (let attempt = 1; ; attempt++) {
    // A new VM needs a moment before it accepts SSH.
    if (cloudOk(['compute', 'ssh', VM.name, ...where, '--command', 'rm -rf /tmp/calyptra-deploy && mkdir -p /tmp/calyptra-deploy'])) break;
    if (attempt >= 20) throw new Error(`cannot reach ${VM.name} over SSH`);
    await sleep(10_000);
  }
  cloud(['compute', 'scp', ...files.map((f) => join(upload, f)), `${VM.name}:/tmp/calyptra-deploy/`, ...where]);
  const args = [process.version, RELAY_HOST, wallet.relayerAccount, NETWORK_ID, ...(merchant ? ['merchant-offer.json'] : [])];
  cloud(['compute', 'ssh', VM.name, ...where, '--command', `sudo bash /tmp/calyptra-deploy/install-relay.sh ${args.join(' ')}; rm -rf /tmp/calyptra-deploy`]);
}

/** 9. Builds the website and deploys its static files to the CDN. */
async function deployWebsite(token: string): Promise<void> {
  const zone = await zoneOf(token);
  execFileSync('npm', ['run', 'build', '-w', 'apps/web'], { cwd: REPO, stdio: 'inherit' });
  execFileSync('npx', ['wrangler', 'deploy'], {
    cwd: join(REPO, 'apps', 'web'),
    stdio: 'inherit',
    // wrangler deploys with its own login (`npx wrangler login`) unless the operator exports CLOUDFLARE_API_TOKEN;
    // the DNS token is zone-scoped and may lack the Workers permissions.
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: zone.account.id },
  });
}

/** 10. The relayer answers over HTTPS, and a peer outside gets a reservation with the public address. */
async function waitForRelay(wallet: RelayWallet): Promise<void> {
  const deadline = Date.now() + 70 * 60_000; // certificate issuance can be rate-limited
  for (;;) {
    try {
      const res = await fetch(`${RELAYER_URL}/relayer/info`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        console.log(`relayer: ${JSON.stringify(await res.json())}`);
        break;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${RELAYER_URL} did not answer`);
    await sleep(5_000);
  }
  const relay = relayAddress(wallet.relayPeerId);
  const p2p = new P2PService(await createPeerNode({ relays: [relay] }));
  try {
    await p2p.waitForRelay(60_000);
    const addrs = p2p.invite('check').addrs;
    if (!addrs.every((a) => a.startsWith(`${relay}/p2p-circuit/`))) throw new Error(`invite addresses are not public: ${addrs.join(', ')}`);
  } finally {
    await p2p.stop();
  }
}

async function main(): Promise<void> {
  if (DOMAIN.startsWith('<')) throw new Error('set DOMAIN in scripts/deploy-live.ts to your domain first');
  const wallet = await relayWallet();
  checkNetworkConfig(wallet);
  if (execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim() !== '') {
    throw new Error('commit your changes first: the live deployment ships the current commit');
  }
  const project = projectId();
  await fundRelayer(wallet);
  const ip = ensureVm(project);
  const token = await dnsToken();
  await pointDns(token, ip);
  await installRelay(project, wallet);
  await deployWebsite(token);
  await waitForRelay(wallet);
  if (process.env.GEMINI_API_KEY) {
    console.log("merchant card: on the relay host's ready line (sudo journalctl -u calyptra-node | grep 'calyptra ready'); list it in the network's merchants");
  }
  console.log(`\nLive: https://${DOMAIN} · relayer ${RELAYER_URL} · relay ${relayAddress(wallet.relayPeerId)}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
