import { z } from 'zod';

const big = z.string().regex(/^\d+$/).transform(BigInt);

/** A note the account owns. `secret` says what unlocks it: the spending secret or a channel's tag secret. */
export const StoredNoteSchema = z.object({
  commitment: big,
  leafIndex: z.number().int().nonnegative(),
  amount: big,
  token: big,
  ownerTag: big,
  salt: big,
  secret: z.union([z.literal('spending'), z.object({ channel: z.number().int().nonnegative() })]),
  spent: z.boolean(),
});

export const PoolSectionSchema = z.object({
  /** Last block whose events were decrypted for this account; -1 before the first sync. */
  syncedBlock: z.string().regex(/^-?\d+$/).transform(BigInt),
  notes: z.array(StoredNoteSchema),
});

export type StoredNote = z.output<typeof StoredNoteSchema>;    // bigint fields
export type PoolSection = z.output<typeof PoolSectionSchema>;
