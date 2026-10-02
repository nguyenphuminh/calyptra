import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groth16, wtns, type Groth16Proof, type MemFile } from 'snarkjs';
import { hash2, toField, type CircuitInput } from '@calyptra/framework/protocol';

// Runs the compiled circuits from circuits/build (run `npm run build:circuits` first).

export type CircuitName = 'transfer' | 'finalize' | 'reclaim' | 'submit_state';

const BUILD = resolve(dirname(fileURLToPath(import.meta.url)), '../build');

export const artifact = (name: CircuitName, ext: string): string => join(BUILD, name, `${name}.${ext}`);

/** True when the input yields a witness that satisfies every constraint of the circuit. */
export async function satisfies(name: CircuitName, input: CircuitInput): Promise<boolean> {
  const witness: MemFile = { type: 'mem' };
  try {
    await wtns.calculate(input, artifact(name, 'wasm'), witness);
  } catch {
    return false;
  }
  return wtns.check(artifact(name, 'r1cs'), witness);
}

export function prove(name: CircuitName, input: CircuitInput): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
  return groth16.fullProve(input, artifact(name, 'wasm'), artifact(name, 'zkey'));
}

export function verificationKey(name: CircuitName): { nPublic: number } & Record<string, unknown> {
  return JSON.parse(readFileSync(artifact(name, 'vkey.json'), 'utf8')) as { nPublic: number } & Record<string, unknown>;
}

/** Names of the public signals in wire order (wire 0 is the constant 1), read from the .sym file. */
export function publicSignalNames(name: CircuitName): string[] {
  const nPublic = verificationKey(name).nPublic;
  const byWire = new Map<number, string>();
  for (const line of readFileSync(artifact(name, 'sym'), 'utf8').split('\n')) {
    const [, wire, , symbol] = line.split(',');
    if (!symbol?.startsWith('main.')) continue;
    const local = symbol.slice('main.'.length);
    if (!local.includes('.')) byWire.set(Number(wire), local);
  }
  return Array.from({ length: nPublic }, (_, i) => byWire.get(i + 1) ?? `<wire ${i + 1}>`);
}

// ---------------------------------------------------------------------------------------------------
// Witness tampering: what an attacker who controls the private inputs could submit.

export function scalar(input: CircuitInput, key: string): bigint {
  const value = input[key];
  if (typeof value !== 'bigint') throw new Error(`${key} is not a scalar signal`);
  return value;
}

export function vector(input: CircuitInput, key: string): bigint[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'bigint')) throw new Error(`${key} is not a vector signal`);
  return value as bigint[];
}

/** A copy of `input` with one element of a vector signal replaced. */
export function withAt(input: CircuitInput, key: string, index: number, value: bigint): CircuitInput {
  const next = [...vector(input, key)];
  next[index] = value;
  return { ...input, [key]: next };
}

/** Note commitment without the range checks of `noteCommitment`, computed like the circuit does (in the field). */
export function rawCommitment(amount: bigint, token: bigint, owner: bigint, salt: bigint): bigint {
  return hash2(toField(token * 2n ** 64n + amount), hash2(owner, salt));
}

/** Rewrites one output (amount, owner or salt) and recomputes its commitment so the commitment check still holds. */
export function forceOutput(
  input: CircuitInput,
  k: number,
  change: { amount?: bigint; owner?: bigint; salt?: bigint },
): CircuitInput {
  const amount = change.amount ?? (vector(input, 'outAmount')[k] as bigint);
  const owner = change.owner ?? (vector(input, 'outOwner')[k] as bigint);
  const salt = change.salt ?? (vector(input, 'outSalt')[k] as bigint);
  let next = withAt(input, 'outAmount', k, amount);
  next = withAt(next, 'outOwner', k, owner);
  next = withAt(next, 'outSalt', k, salt);
  return withAt(next, 'outCommitment', k, rawCommitment(amount, scalar(input, 'token'), owner, salt));
}

/** Rewrites every output amount and recomputes the matching commitments. */
export function forceOutputs(input: CircuitInput, amounts: readonly bigint[]): CircuitInput {
  return amounts.reduce((next, amount, k) => forceOutput(next, k, { amount }), input);
}
