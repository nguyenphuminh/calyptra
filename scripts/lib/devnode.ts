// The local dev chain: an anvil node started detached and reused by tests, the
// demo and the deploy scripts. Chain data, the pid file, the log, deployment.json and gas-report.json
// live in .devnode/. Anvil mines one block per transaction, so the latest block's timestamp stands still
// while nothing happens; tests mine an empty transaction to bring it up to wall-clock time.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** `CALYPTRA_DEVNODE_PORT` runs a second, independent dev chain (its own data folder), e.g. for two test
 *  tiers at once; the default chain is port 8545 in .devnode/. */
const PORT = Number(process.env.CALYPTRA_DEVNODE_PORT ?? 8545);
export const DEVNODE_DIR = PORT === 8545 ? `${REPO}/.devnode` : `${REPO}/.devnode-${PORT}`;
export const DEVNODE_RPC = `http://127.0.0.1:${PORT}`;
/** anvil's public, pre-funded account #0 (from its well-known test mnemonic). */
export const DEV_PRIVATE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const PID_FILE = `${DEVNODE_DIR}/anvil.pid`;
const LOG_FILE = `${DEVNODE_DIR}/anvil.log`;
const STATE_FILE = `${DEVNODE_DIR}/anvil-state.json`;
/** Monad's contract code-size limit (128 KB) instead of EIP-170's 24 KB. */
const CODE_SIZE_LIMIT = 128 * 1024;

export const devChain = defineChain({
  id: CHAIN_ID,
  name: 'Calyptra dev node',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [DEVNODE_RPC] } },
});

// Anvil answers at once; a short polling interval keeps receipt waits fast.
export const devPublicClient = () => createPublicClient({ chain: devChain, transport: http(DEVNODE_RPC), pollingInterval: 100 });

export const devWalletClient = (key: Hex = DEV_PRIVATE_KEY) =>
  createWalletClient({ account: privateKeyToAccount(key), chain: devChain, transport: http(DEVNODE_RPC), pollingInterval: 100 });

export async function isUp(): Promise<boolean> {
  try {
    await createPublicClient({ transport: http(DEVNODE_RPC, { retryCount: 0, timeout: 2_000 }) }).getChainId();
    return true;
  } catch {
    return false;
  }
}

/** Starts the dev node detached (it outlives this process), or reuses one that already answers. */
export async function startDevnode(): Promise<void> {
  if (await isUp()) return;
  mkdirSync(DEVNODE_DIR, { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const args = ['--host', '127.0.0.1', '--port', String(PORT), '--chain-id', String(CHAIN_ID), '--state', STATE_FILE,
    '--code-size-limit', String(CODE_SIZE_LIMIT)];
  const child = spawn('anvil', args, { detached: true, stdio: ['ignore', log, log] });
  let failed = false;
  child.on('error', (err) => {
    failed = true;
    writeFileSync(LOG_FILE, `could not start anvil: ${err.message}\n`, { flag: 'a' });
  });
  child.unref();
  if (child.pid !== undefined) writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 120 && !failed; i++) {
    if (await isUp()) return;
    await sleep(500);
  }
  throw new Error(`dev node did not start, see ${LOG_FILE}`);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function stopDevnode(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 60 && alive(pid); i++) await sleep(250);
  }
  rmSync(PID_FILE, { force: true });
}

/** Stops the node and deletes its chain data, deployment and demo state. */
export async function resetDevnode(): Promise<void> {
  await stopDevnode();
  rmSync(DEVNODE_DIR, { recursive: true, force: true });
}
