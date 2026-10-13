import * as snarkjs from 'snarkjs';

/** A proof to build, or (`prefetch`) only the circuit's proving files to load ahead of time. */
export interface ProveRequest { id: number; base: string; circuit: string; input: Record<string, unknown>; prefetch?: boolean; }
export type ProveReply = { id: number; proof: snarkjs.Groth16Proof; publicSignals: string[] } | { id: number; error: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<ProveRequest>) => void) | null; postMessage: (reply: ProveReply) => void };
const files = new Map<string, Promise<Uint8Array>>();

function load(url: string): Promise<Uint8Array> {
  let bytes = files.get(url);
  if (!bytes) {
    bytes = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`could not load ${url}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    files.set(url, bytes);
  }
  return bytes;
}

scope.onmessage = (event) => {
  const { id, base, circuit, input, prefetch } = event.data;
  if (prefetch) {
    // Warms the cache only; a failed prefetch is forgotten so the real proof can try again.
    for (const url of [`${base}/${circuit}.wasm`, `${base}/${circuit}.zkey`]) load(url).catch(() => files.delete(url));
    return;
  }
  void Promise.all([load(`${base}/${circuit}.wasm`), load(`${base}/${circuit}.zkey`)])
    .then(([wasm, zkey]) => snarkjs.groth16.fullProve(input, wasm, zkey))
    .then(
      ({ proof, publicSignals }) => scope.postMessage({ id, proof, publicSignals }),
      (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
    );
};
