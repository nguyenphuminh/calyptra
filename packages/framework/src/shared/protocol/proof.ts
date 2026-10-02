import type { Groth16Proof } from 'snarkjs';

/** EVM ordering of a Groth16 proof: [A.x, A.y, B.x_c1, B.x_c0, B.y_c1, B.y_c0, C.x, C.y]. */
export type EvmProof = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

export function toEvmProof(proof: Groth16Proof): EvmProof {
  const [ax, ay] = proof.pi_a as [string, string];
  const [[bx0, bx1], [by0, by1]] = proof.pi_b as [[string, string], [string, string]];
  const [cx, cy] = proof.pi_c as [string, string];
  return [ax, ay, bx1, bx0, by1, by0, cx, cy].map((v) => BigInt(v)) as unknown as EvmProof;
}
