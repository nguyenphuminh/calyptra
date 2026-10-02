declare module 'snarkjs' {
  export interface Groth16Proof { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string }
  export interface MemFile { type: 'mem'; data?: Uint8Array }
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasm: string | Uint8Array, zkey: string | Uint8Array): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
  export const zKey: {
    newZKey(r1cs: string, ptau: string, zkey: string): Promise<unknown>;
    contribute(oldZkey: string, newZkey: string, name: string, entropy: string): Promise<unknown>;
    exportVerificationKey(zkey: string | Uint8Array): Promise<Record<string, unknown>>;
  };
  export const wtns: {
    calculate(input: Record<string, unknown>, wasm: string | Uint8Array, wtns: string | MemFile): Promise<void>;
    check(r1cs: string, wtns: string | MemFile): Promise<boolean>;
  };
}
