// Runs the real desktop client (apps/desktop/src/main.ts) from scripts and tests. Children get no
// stdin (no terminal), so they never open the shell and take their secrets from the environment.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../../apps/desktop/src/main.ts', import.meta.url));

/** What the client prints on its `calyptra ready {…}` line. */
export interface Ready {
  account: string;
  network: string;
  rpc: { url: string; tokenFile: string } | null;
  relayer: string | null;
  libp2pRelay: string[] | null;
  /** The merchant card code in merchant mode (§11.5), else null. */
  merchant?: string | null;
}

/** A TCP port that is free right now on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function spawnDesktop(args: readonly string[], env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** For commands that exit by themselves (init, help). */
export function runDesktop(args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnDesktop(args, env);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Starts the node and resolves at its readiness line; rejects if the process exits first. */
export function startDesktop(args: readonly string[], env: Record<string, string> = {}): Promise<{ child: ChildProcess; ready: Ready }> {
  return new Promise((resolve, reject) => {
    const child = spawnDesktop(args, env);
    let stdout = '';
    let stderr = '';
    let done = false;
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (done) return;
      stdout += chunk.toString();
      const line = stdout.split('\n').find((l) => l.startsWith('calyptra ready '));
      if (line === undefined || !stdout.includes(`${line}\n`)) return;
      done = true;
      resolve({ child, ready: JSON.parse(line.slice('calyptra ready '.length)) as Ready });
    });
    child.once('error', (err) => {
      if (!done) reject(err);
      done = true;
    });
    child.once('exit', (code) => {
      if (!done) reject(new Error(`node exited with ${code}: ${stderr}`));
      done = true;
    });
  });
}

/** SIGTERM, then the exit code (immediately if the process already exited). */
export function stopDesktop(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
}

/** POST <url>/rpc/<command> with the access token; a non-2xx answer throws its message with `code` and `status`. */
export async function desktopRpc<T>(rpc: { url: string; token: string }, command: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${rpc.url}/rpc/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rpc.token}` },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!res.ok) throw Object.assign(new Error(payload.message ?? `HTTP ${res.status}`), { code: payload.code, status: res.status });
  return payload as T;
}
