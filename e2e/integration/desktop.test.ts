// The real desktop client as child processes (all-ref §10.7.8): init and the encrypted data folder,
// the local RPC and its token, the relayer and libp2p relay roles serving a website-style framework
// user, the relayer account's limits, and export/import in both directions (INT-D1..D6). Then the
// startup refusals of merchant mode (§11.5): it always sells the Qwen chat, so only its error paths
// run here; the paid service itself is covered with EchoServicePort in subscription.test.ts.
// Tests run in order and share the data folder.
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatEther, parseEther, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChainAdapter, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { ChannelRepository } from '../../packages/framework/src/modules/channel/index.ts';
import { shieldedAddressOf } from '../../packages/framework/src/modules/keys/index.ts';
import { encodeInvite } from '../../packages/framework/src/modules/p2p/index.ts';
import { HttpRelayer } from '../../packages/framework/src/modules/relayer/index.ts';
import { MemoryStore } from '../../packages/framework/src/modules/storage/index.ts';
import { WalletRepository, WalletService } from '../../packages/framework/src/modules/wallet/index.ts';
import { desktopRpc, freePort, runDesktop, startDesktop, stopDesktop, type Ready } from '../../scripts/lib/desktop-process.ts';
import { freshDeployment } from './chain.ts';
import { closeProxies, proxy } from './rpc-proxy.ts';
import { FAST_KDF, PASSWORD, devNetwork, fund, newChannelNode, newPhrase, newUser, type ChannelNode, type User } from './services.ts';

interface Rpc { url: string; token: string }
interface ChannelView { id: string; status: string; balance: string; peerBalance: string; closingFee: string }

const NATIVE = 0n;
const WALLET_FILE = 'calyptra.wallet.json';

let network: NetworkConfig;
let tmp: string;
let data: string;
let tokenFile: string;
let networkFile: string;
const phrase = newPhrase();
const env = { CALYPTRA_PASSWORD: PASSWORD, CALYPTRA_SECRET: phrase };
const children: ChildProcess[] = [];
let firstAccount: string;
let relayerAccount: string;
let previousToken: string;
// Set by INT-D3 and used by the tests after it.
let desktop: ChildProcess;
let ready: Ready;
let rpc: Rpc;
let web: User;
let webNode: ChannelNode | undefined;
let channelId: string;

const base = (): string[] => [
  'start', '--data-dir', data, '--network-file', networkFile, '--network', network.id, '--no-shell', '--tick', '3600', '--rpc', '--rpc-token-file', tokenFile,
];
const shielded = (u: User): bigint => u.pool.balances().get(NATIVE) ?? 0n;
const readToken = async (file: string): Promise<Rpc> => JSON.parse(await readFile(file, 'utf8')) as Rpc;
async function start(args: string[], extraEnv: Record<string, string> = env): Promise<{ child: ChildProcess; ready: Ready }> {
  const started = await startDesktop(args, extraEnv);
  children.push(started.child);
  return started;
}

beforeAll(async () => {
  const d = await freshDeployment();
  network = devNetwork(d);
  tmp = await mkdtemp(join(tmpdir(), 'calyptra-desktop-'));
  data = join(tmp, 'data');
  tokenFile = join(tmp, 'rpc.json');
  networkFile = join(tmp, 'devnode.json');
  await writeFile(networkFile, JSON.stringify({ ...network, contracts: { ...network.contracts, deployBlock: d.deployBlock } })); // deployBlock as a string
});

afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await webNode?.p2p.stop();
  await closeProxies();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('desktop client', () => {
  it('INT-D1: init writes one encrypted file in the export format, refuses a second init and a wrong password', async () => {
    const init = await runDesktop(['init', '--phrase', '--data-dir', data], env);
    expect(init.code).toBe(0);
    const out = JSON.parse(init.stdout) as { accounts: { id: string }[] };
    expect(out).toMatchObject({ accounts: [{ id: expect.any(String) }] });
    expect(out.accounts).toHaveLength(1);
    firstAccount = out.accounts[0]?.id ?? '';
    expect(await readdir(data)).toEqual([WALLET_FILE]);
    const content = await readFile(join(data, WALLET_FILE), 'utf8');
    expect(JSON.parse(content)).toMatchObject({ format: 'calyptra-wallet', version: 1 });
    const words = phrase.split(' ');
    expect(content).not.toContain(`${words[0]} ${words[1]}`);
    expect(content.toLowerCase()).not.toContain(firstAccount.slice(2).toLowerCase());

    const again = await runDesktop(['init', '--phrase', '--data-dir', data], env);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('ALREADY_INITIALIZED');
    const wrong = await runDesktop([...base(), '--rpc-port', String(await freePort())], { ...env, CALYPTRA_PASSWORD: 'not the password' });
    expect(wrong.code).toBe(1);
  });

  it('INT-D2: the RPC needs the token; the token file is removed at stop', async () => {
    const { child, ready: started } = await start([...base(), '--rpc-port', String(await freePort())]);
    const file = await readToken(tokenFile);
    expect(file).toEqual({ url: started.rpc?.url, token: expect.any(String) });
    const anonymous = await fetch(`${file.url}/rpc/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(anonymous.status).toBe(401);
    expect(await desktopRpc(file, 'status')).toMatchObject({ account: { id: firstAccount }, network: { id: network.id } });
    const added = await desktopRpc<{ id: string }>(file, 'account.add');
    expect(added).toMatchObject({ id: expect.any(String) });
    relayerAccount = added.id;
    previousToken = file.token;
    expect(await stopDesktop(child)).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it('INT-D3: relays transactions and connections for web users, countersigns on its own, closes a channel', async () => {
    await fund(network, firstAccount as Address, '1');
    await fund(network, relayerAccount as Address, '1');
    const [rpcPort, relayerPort, relayPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const started = await start([
      ...base(), '--rpc-port', String(rpcPort),
      '--relayer', '--relayer-account', relayerAccount, '--relayer-fee-native', '0.0001', '--relayer-fee-stablecoin', '0.01',
      '--relayer-host', '127.0.0.1', '--relayer-port', String(relayerPort),
      '--libp2p-relay', '--libp2p-relay-host', '127.0.0.1', '--libp2p-relay-port', String(relayPort),
    ]);
    desktop = started.child;
    ready = started.ready;
    rpc = await readToken(tokenFile);
    expect(rpc.token).not.toBe(previousToken); // a new token at every start
    expect(await readdir(data)).toEqual([WALLET_FILE]);
    expect(await readFile(join(data, WALLET_FILE), 'utf8')).not.toContain(rpc.token);
    expect(ready.relayer).toBe(`http://127.0.0.1:${relayerPort}`);
    const relayAddr = ready.libp2pRelay?.[0] ?? '';
    expect(relayAddr).toMatch(new RegExp(`^/ip4/127.0.0.1/tcp/${relayPort}/ws/p2p/`));

    await desktopRpc(rpc, 'deposit', { token: 'native', amount: '0.2' });
    // A website-style user: the framework in this process, with the desktop as its relayer and relay.
    const relayer = new HttpRelayer(ready.relayer ?? '');
    const webChain = new ChainAdapter(network);
    web = await newUser(network, webChain);
    await web.pool.deposit(NATIVE, parseEther('0.1'));
    await web.pool.transfer(await desktopRpc<string>(rpc, 'address'), NATIVE, parseEther('0.01'), relayer);
    expect(await desktopRpc(rpc, 'balance')).toMatchObject({ native: '0.21 MON' });

    webNode = await newChannelNode(web, webChain, relayAddr, relayer);
    const invite = encodeInvite(webNode.p2p.invite(shieldedAddressOf(await web.keys.poolKeys())));
    const opened = await desktopRpc<ChannelView>(rpc, 'channel.open', { invite, token: 'native', amount: '0.05' });
    expect(opened).toMatchObject({ status: 'funding' });
    channelId = opened.id;
    expect(await webNode.channels.tick(relayer)).toEqual([]);
    expect(await desktopRpc(rpc, 'tick')).toEqual([]);
    expect((await desktopRpc<ChannelView[]>(rpc, 'channels'))[0]?.status).toBe('live');
    await desktopRpc(rpc, 'channel.pay', { channel: channelId, amount: '0.01' });
    await webNode.channels.pay(channelId, parseEther('0.002'));
    expect((await desktopRpc<ChannelView[]>(rpc, 'channels'))[0]).toMatchObject({
      balance: '0.0419 MON', peerBalance: '0.008 MON', closingFee: '0.0001 MON',
    });
    await web.pool.sync();
    const before = shielded(web);
    expect(await desktopRpc(rpc, 'channel.close', { channel: channelId })).toMatchObject({ status: 'closed' });
    expect(await webNode.channels.tick(relayer)).toEqual([]);
    expect(shielded(web)).toBe(before + parseEther('0.008'));
  });

  it('INT-D4: the relayer account never deposits; there is no public send', async () => {
    await desktopRpc(rpc, 'account.use', { account: relayerAccount });
    await expect(desktopRpc(rpc, 'deposit', { token: 'native', amount: '0.01' })).rejects.toMatchObject({
      code: 'RELAYER_ACCOUNT', message: 'The relayer account never makes deposits; switch to another account',
    });
    await expect(desktopRpc(rpc, 'public.send', {})).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND', message: 'Unknown command "public.send"' });
    const earned = await desktopRpc<{ native: string }>(rpc, 'balance');
    expect(parseEther(earned.native.replace(/ MON$/, ''))).toBeGreaterThan(0n); // the fee notes it earned
    await desktopRpc(rpc, 'account.use', { account: firstAccount });
  });

  it('INT-D5: a desktop export opens in the website’s wallet core', async () => {
    const path = join(tmp, 'desktop-export.json');
    await desktopRpc(rpc, 'export', { path });
    const wallet = new WalletService(new WalletRepository(new MemoryStore()), FAST_KDF);
    await wallet.importFile(await readFile(path, 'utf8'), PASSWORD);
    expect(wallet.accounts().map((a) => a.id)).toEqual([firstAccount, relayerAccount]);
    expect(wallet.networkId()).toBe(network.id);
    expect(new ChannelRepository(wallet).all().map((r) => [r.id, r.status])).toEqual([[channelId, 'closed']]);
  });

  it('INT-D6: a website export becomes a desktop data folder with its accounts, notes and channels', async () => {
    const file = join(tmp, 'web-export.json');
    await writeFile(file, await web.wallet.exportFile());
    const webData = join(tmp, 'web-data');
    const init = await runDesktop(['init', '--import-file', file, '--data-dir', webData], env);
    expect(init.code).toBe(0);
    const webTokenFile = join(tmp, 'web-rpc.json');
    const second = await start([
      'start', '--data-dir', webData, '--network-file', networkFile, '--network', network.id, '--no-shell', '--tick', '3600',
      '--rpc', '--rpc-port', String(await freePort()), '--rpc-token-file', webTokenFile,
      '--libp2p-relays', ready.libp2pRelay?.[0] ?? '', '--relayers', ready.relayer ?? '',
    ]);
    const webRpc = await readToken(webTokenFile);
    expect((await desktopRpc<{ id: string }[]>(webRpc, 'accounts')).map((a) => a.id)).toEqual(web.wallet.accounts().map((a) => a.id));
    await web.pool.sync();
    expect(await desktopRpc(webRpc, 'balance')).toMatchObject({ native: `${formatEther(shielded(web))} MON` });
    expect((await desktopRpc<ChannelView[]>(webRpc, 'channels')).map((c) => [c.id, c.status])).toEqual([[channelId, 'closed']]);
    expect(await stopDesktop(second.child)).toBe(0);
    expect(await stopDesktop(desktop)).toBe(0);
  });

  it('own RPC endpoints first, then the network’s history endpoint; with the fallback off, only its own (§11.3)', async () => {
    const [own, networkRpc, history] = [await proxy({ mode: 'down' }), await proxy(), await proxy()];
    const file = join(tmp, 'devnode-logs.json');
    await writeFile(file, JSON.stringify({
      ...network, rpcUrl: networkRpc.url, logRpcUrls: [history.url], contracts: { ...network.contracts, deployBlock: network.contracts?.deployBlock.toString() },
    }));
    const args = async (...extra: string[]): Promise<string[]> => [
      'start', '--data-dir', data, '--network-file', file, '--network', network.id, '--no-shell', '--tick', '3600',
      '--rpc', '--rpc-port', String(await freePort()), '--rpc-token-file', tokenFile, '--chain-rpcs', own.url, ...extra,
    ];
    const fallback = await start(await args());
    await desktopRpc(await readToken(tokenFile), 'balance'); // syncs: its own endpoint is down, the history endpoint answers
    expect(own.methods.length).toBeGreaterThan(0);
    expect(history.methods).toContain('eth_getLogs');
    expect(networkRpc.methods).toEqual([]);
    expect(await stopDesktop(fallback.child)).toBe(0);

    for (const p of [own, networkRpc, history]) p.clear();
    const strict = await start(await args('--no-chain-rpc-fallback'));
    await expect(desktopRpc(await readToken(tokenFile), 'balance')).rejects.toMatchObject({
      code: 'RPC_UNAVAILABLE', message: `No RPC endpoint of ${network.name} is answering`,
    });
    expect(own.methods.length).toBeGreaterThan(0);
    expect([history.methods, networkRpc.methods]).toEqual([[], []]); // the network's endpoints are never asked
    expect(await stopDesktop(strict.child)).toBe(0);
  });
});

describe('desktop startup refusals', () => {
  /** Never sent anywhere: every run below exits before the merchant's service is ever called. */
  const PLACEHOLDER_KEY = 'placeholder-never-used';
  const offer = { kind: 'ai-chat', title: 'Calyptra AI · powered by Qwen', token: 'stablecoin', ratePerSecond: '2000', minFunding: '1000000', graceSeconds: 3 };
  const startArgs = async (...extra: string[]): Promise<string[]> => [...base(), '--rpc-port', String(await freePort()), ...extra];

  it('merchant mode needs an offer file and DASHSCOPE_API_KEY', async () => {
    const offerFile = join(tmp, 'offer.json');
    await writeFile(offerFile, JSON.stringify(offer));
    const noOffer = await runDesktop(await startArgs('--merchant'), { ...env, DASHSCOPE_API_KEY: '' });
    expect(noOffer.code).toBe(1);
    expect(noOffer.stderr).toContain('--merchant needs --merchant-offer <offer.json>');
    const noKey = await runDesktop(await startArgs('--merchant', '--merchant-offer', offerFile), { ...env, DASHSCOPE_API_KEY: '' });
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain('--merchant needs the DASHSCOPE_API_KEY environment variable');
  });

  it('merchant mode refuses an invalid offer, and a node no subscriber could reach (no libp2p relay)', async () => {
    const badFile = join(tmp, 'bad-offer.json');
    await writeFile(badFile, JSON.stringify({ ...offer, token: 'native', ratePerSecond: '0' }));
    const bad = await runDesktop(await startArgs('--merchant', '--merchant-offer', badFile), { ...env, DASHSCOPE_API_KEY: PLACEHOLDER_KEY });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('error INVALID_INPUT');
    const offerFile = join(tmp, 'offer.json');
    const unreachable = await runDesktop(await startArgs('--merchant', '--merchant-offer', offerFile), { ...env, DASHSCOPE_API_KEY: PLACEHOLDER_KEY });
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain('error NO_RELAY');
    expect(existsSync(tokenFile)).toBe(false);
  });

  it('the relayer role refuses the active account', async () => {
    const run = await runDesktop(await startArgs('--relayer', '--relayer-account', firstAccount, '--relayer-fee-native', '0.0001'), env);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('error RELAYER_ACCOUNT: The relayer account cannot be the active account');
  });
});
