import { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import { decodeInvite } from '../p2p/index.ts';

/** The per-second service protocol, on the same relay-routed connection as the channel protocol. */
export const SERVICE_PROTOCOL = '/calyptra/service/1.0.0';
/** Longest prompt a merchant accepts, in characters. */
export const MAX_PROMPT_LENGTH = 8_000;

const big = z.union([z.bigint(), z.string().regex(/^\d+$/)]).transform((v) => BigInt(v));

/** What a merchant charges for its service. */
export const OfferSchema = z.object({
  kind: z.literal('ai-chat'),
  title: z.string().min(1),
  token: z.literal('stablecoin'),
  /** Base units per second. */
  ratePerSecond: big.refine((v) => v > 0n, 'The rate must be positive'),
  /** Smallest allowance a subscriber may fund, base units. */
  minFunding: big,
  /** Seconds of service given ahead of payment. */
  graceSeconds: z.number().int().nonnegative().default(3),
});
export type Offer = z.output<typeof OfferSchema>;

/** A merchant card `{ v: 1, name, invite, offer }`: shared as a link or QR code, or listed in the network config. */
export const MerchantCardSchema = z.object({
  v: z.literal(1),
  name: z.string().min(1),
  /** The merchant's baseline invite code. */
  invite: z.string().min(1),
  offer: OfferSchema,
});
export type MerchantCard = z.output<typeof MerchantCardSchema>;

const toBase64Url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const fromBase64Url = (code: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(code.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)));

/** Encodes a card like an invite: base64url (no padding) of its JSON, amounts as decimal strings. */
export function encodeMerchantCard(card: MerchantCard): string {
  const parsed = MerchantCardSchema.parse(card);
  return toBase64Url(JSON.stringify(parsed, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Accepts the bare code or a full merchant link (...#/merchant/<code>). */
export function decodeMerchantCard(text: string): MerchantCard {
  const code = text.trim().split('/merchant/').pop() ?? '';
  try {
    const card = MerchantCardSchema.parse(JSON.parse(fromBase64Url(code)));
    decodeInvite(card.invite);
    return card;
  } catch {
    throw new AppError(400, 'INVALID_MERCHANT_CARD', 'This is not a valid Calyptra merchant card');
  }
}

export const merchantLink = (origin: string, card: MerchantCard): string =>
  `${origin.replace(/\/+$/, '')}/#/merchant/${encodeMerchantCard(card)}`;

/** The channel token an offer is paid in: the network's stablecoin. */
export const offerTokenOf = (_offer: Offer, network: { stablecoin: string }): bigint => BigInt(network.stablecoin);

// Service protocol messages: length-prefixed JSON like the channel protocol, many per stream.

const channelId = z.string().regex(/^[0-9a-f]{32}$/);
const promptId = z.string().min(1).max(64);

/** Subscriber -> merchant: start (or resume) paid time, ask, stop (pause). */
export const SubscriberMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), channelId }),
  z.object({ type: z.literal('prompt'), id: promptId, text: z.string().min(1).max(MAX_PROMPT_LENGTH) }),
  z.object({ type: z.literal('stop') }),
]);
export type SubscriberMessage = z.output<typeof SubscriberMessageSchema>;

/** Merchant -> subscriber: a piece of a reply, its end, a payment shortfall, or a refusal. */
export const MerchantMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chunk'), id: promptId, text: z.string() }),
  z.object({ type: z.literal('done'), id: promptId }),
  z.object({ type: z.literal('insufficient'), paidSeconds: z.number().int().nonnegative(), servedSeconds: z.number().int().nonnegative() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type MerchantMessage = z.output<typeof MerchantMessageSchema>;
