import { z } from 'zod';
import type { Hex } from 'viem';

/** A non-negative bigint carried as a decimal string (or already a bigint): negative values are impossible on the wire. */
const big = z.union([z.bigint(), z.string().regex(/^\d+$/)]).transform((v) => BigInt(v));
const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((v) => v as Hex);

const pk = z.tuple([big, big]).readonly();
/** 32-byte X25519 public key, 0x-hex. */
const encryptionKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const SignatureSchema = z.object({ R8x: big, R8y: big, S: big });
export const StateSchema = z.object({
  contribs: z.tuple([big, big]).readonly(),
  balA: big,
  balB: big,
  payoutA: big,
  payoutB: big,
  closingFee: big,
  nonce: big,
  final: z.boolean(),
});
const ParamsSchema = z.object({ pkA: pk, pkB: pk, channelSecret: big, window: big });
const ContributionSchema = z.object({ amount: big, salt: big });
const SignedSchema = z.object({ state: StateSchema, sigA: SignatureSchema.nullable(), sigB: SignatureSchema.nullable() });

export const CHANNEL_STATUSES = ['opening', 'funding', 'live', 'closing', 'closed', 'disputing', 'settled', 'cancelled'] as const;

export const ChannelRecordSchema = z.object({
  id: z.string(),
  role: z.enum(['A', 'B']),
  index: z.number().int().nonnegative(),
  peer: z.object({ peerId: z.string(), addrs: z.array(z.string()) }),
  token: big,
  status: z.enum(CHANNEL_STATUSES),
  params: ParamsSchema,
  encPubA: encryptionKey,
  encPubB: encryptionKey,
  contribA: ContributionSchema,
  contribB: ContributionSchema.nullable(),
  state0: SignedSchema,
  latest: SignedSchema,
  pending: z.object({ prevHash: big, state: StateSchema, sig: SignatureSchema }).nullable(),
  history: z.array(z.tuple([big, big, big, big, z.boolean()])),
  closeTx: hexString.nullable(),
  createdAt: z.number().int().nonnegative().optional(),
});

// Channel wire messages (protocol /calyptra/channel/1.0.0): one request and one response per stream.

export const OpenMessageSchema = z.object({
  type: z.literal('open'),
  channelId: z.string().regex(/^[0-9a-f]{32}$/),
  token: big,
  amountA: big,
  amountB: big,
  window: big,
  closingFee: big,
  nonce0: big,
  shareA: big,
  pkA: pk,
  tagA: big,
  encPubA: encryptionKey,
  /** `{ amount, salt }` of A's contribution, so B can rebuild its commitment. */
  contribA: ContributionSchema,
  /** How A is reached later (A's own relay circuit addresses). */
  addrsA: z.array(z.string()),
});
export const OpenReplySchema = z.object({
  shareB: big,
  pkB: pk,
  tagB: big,
  encPubB: encryptionKey,
  contribB: ContributionSchema.nullable(),
  sigB0: SignatureSchema,
});
export const ConfirmMessageSchema = z.object({
  type: z.literal('confirm'),
  channelId: z.string(),
  sigA0: SignatureSchema,
  /** Absent (null) when B contributes nothing. */
  state1: StateSchema.nullable(),
  sigA1: SignatureSchema.nullable(),
});
export const ConfirmReplySchema = z.object({ sigB1: SignatureSchema.nullable() });
export const ProposeMessageSchema = z.object({
  type: z.enum(['pay', 'close']),
  channelId: z.string(),
  /** Hash of the state the proposal builds on. */
  prevHash: big,
  state: StateSchema,
  /** The proposer's signature of `state`. */
  sig: SignatureSchema,
  /** The proposer's signature of the state it builds on. */
  prevSig: SignatureSchema,
});
export const ProposeReplySchema = z.object({ sig: SignatureSchema });
/** Either side cancels an opening nobody funded. */
export const CancelMessageSchema = z.object({ type: z.literal('cancel'), channelId: z.string() });
export const ChannelMessageSchema = z.discriminatedUnion('type', [OpenMessageSchema, ConfirmMessageSchema, ProposeMessageSchema, CancelMessageSchema]);

export type ChannelRecord = z.output<typeof ChannelRecordSchema>;
export type ChannelStatus = ChannelRecord['status'];
export type OpenMessage = z.output<typeof OpenMessageSchema>;
export type ConfirmMessage = z.output<typeof ConfirmMessageSchema>;
export type ProposeMessage = z.output<typeof ProposeMessageSchema>;
export type SignedRecordState = ChannelRecord['latest'];
