import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { toField } from './field.ts';

/** Number of outputs of every pool transfer: two regular outputs and the relayer's fee note (BRD 2.2.3). */
export const OUTPUTS_PER_TRANSFER = 3;

/** Data the proof commits to but the circuit does not read: the withdrawal recipient and the encrypted outputs. */
export interface ExtData {
  /** Zero address for transfers that take nothing out of the pool. */
  recipient: Address;
  ciphertexts: readonly [Hex, Hex, Hex];
}

/** keccak256(abi.encode(recipient, keccak(ct0), keccak(ct1), keccak(ct2))) reduced into the field; the pool recomputes it. */
export function extDataHashOf(ext: ExtData): bigint {
  const encoded = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [ext.recipient, keccak256(ext.ciphertexts[0]), keccak256(ext.ciphertexts[1]), keccak256(ext.ciphertexts[2])],
  );
  return toField(BigInt(keccak256(encoded)));
}

export const NO_RECIPIENT: Address = zeroAddress;
