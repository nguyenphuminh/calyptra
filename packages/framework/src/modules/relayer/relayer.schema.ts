import { z } from 'zod';
import type { Address, Hex } from 'viem';

const uint = z.string().regex(/^\d+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((v) => v as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v as Address);

/** What a user's app sends a relayer: a proven transaction it cannot alter. */
export const RelayRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transact'), proof: z.array(uint).length(8), signals: z.array(uint).length(9), recipient: address, ciphertexts: hex }),
  z.object({ kind: z.literal('finalize'), proof: z.array(uint).length(8), signals: z.array(uint).length(9), ciphertexts: hex }),
  z.object({ kind: z.literal('reclaim'), proof: z.array(uint).length(8), signals: z.array(uint).length(8), ciphertexts: hex }),
  z.object({ kind: z.literal('submitState'), proof: z.array(uint).length(8), signals: z.array(uint).length(5) }),
]);

export const RelayerInfoSchema = z.object({
  chainId: z.number().int(),
  /** Where fee notes go. */
  shieldedAddress: z.string(),
  /** Quoted fee per accepted token, by lowercase token address (zero address = native coin). */
  fees: z.record(z.string(), uint),
});

export const RelayResultSchema = z.object({ txHash: hex });

export type RelayRequest = z.output<typeof RelayRequestSchema>;
export type RelayKind = RelayRequest['kind'];
export type RelayerInfo = z.output<typeof RelayerInfoSchema>;
export type RelayResult = z.output<typeof RelayResultSchema>;

/** How transactions are relayed: over HTTP, in-process, or through a capped wrapper. */
export interface RelayerPort {
  info(): Promise<RelayerInfo>;
  submit(request: RelayRequest): Promise<RelayResult>;
}
