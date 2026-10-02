import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { poseidon6 } from 'poseidon-lite/poseidon6';
import { poseidon10 } from 'poseidon-lite/poseidon10';

// circomlib-compatible Poseidon over BN254. The contracts implement exactly the 2-input variant.
export const hash1 = (a: bigint): bigint => poseidon1([a]);
export const hash2 = (a: bigint, b: bigint): bigint => poseidon2([a, b]);
export const hash3 = (a: bigint, b: bigint, c: bigint): bigint => poseidon3([a, b, c]);
export const hash6 = (inputs: readonly bigint[]): bigint => poseidon6([...inputs]);
export const hash10 = (inputs: readonly bigint[]): bigint => poseidon10([...inputs]);
