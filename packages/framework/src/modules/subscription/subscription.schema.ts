import { z } from 'zod';

const big = z.union([z.bigint(), z.string().regex(/^\d+$/)]).transform((v) => BigInt(v));

/** An entry of the allowance registry: a subscription channel and how much of its allowance went out. */
export const SubscriptionSchema = z.object({
  channelId: z.string(),
  /** The merchant's name, from its card. */
  merchant: z.string(),
  /** Base units per second. */
  ratePerSecond: big,
  /** Most this subscription may pay automatically: this side's balance in state 0 (the allowance minus the closing fee). */
  cap: big,
  /** Paid so far. */
  paid: big,
});
export type Subscription = z.output<typeof SubscriptionSchema>;
