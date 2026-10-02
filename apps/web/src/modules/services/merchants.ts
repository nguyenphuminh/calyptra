import { decodeMerchantCard, type Calyptra, type MerchantCard, type Subscription } from '@calyptra/framework';
import { z } from 'zod';

// Merchants the Services tab lists (§11.5): the network's own (its config's `merchants`), then those the
// user opened through a merchant link, kept in the encrypted wallet per account and network.
const SECTION = 'web-merchants';
const SavedSchema = z.array(z.string());

export interface ListedMerchant { code: string; card: MerchantCard }

const codeOf = (text: string): string => text.trim().split('/merchant/').pop() ?? '';

function decoded(code: string): ListedMerchant | null {
  try {
    return { code: codeOf(code), card: decodeMerchantCard(code) };
  } catch {
    return null;
  }
}

/** Every merchant to show, without duplicates (one entry per merchant invite). */
export function merchantsOf(calyptra: Calyptra): ListedMerchant[] {
  const network = calyptra.network();
  const saved = calyptra.wallet.readSection(SECTION, SavedSchema) ?? [];
  const seen = new Set<string>();
  const out: ListedMerchant[] = [];
  for (const code of [...(network.merchants ?? []), ...saved]) {
    const entry = decoded(code);
    if (!entry || seen.has(entry.card.invite)) continue;
    seen.add(entry.card.invite);
    out.push(entry);
  }
  return out;
}

/** Remembers a merchant link the user opened, so the merchant stays in the list. */
export async function rememberMerchant(calyptra: Calyptra, code: string): Promise<void> {
  const entry = decoded(code);
  if (!entry) return;
  if (merchantsOf(calyptra).some((m) => m.card.invite === entry.card.invite)) return;
  const saved = calyptra.wallet.readSection(SECTION, SavedSchema) ?? [];
  await calyptra.wallet.writeSection(SECTION, [...saved, entry.code]);
}

/** The merchant link's card, or null when the code does not decode. */
export const cardOf = (code: string): MerchantCard | null => decoded(code)?.card ?? null;

/** The account's subscriptions, or none when the node runs without a message relay. */
export function subscriptionsOf(calyptra: Calyptra): Subscription[] {
  try {
    return calyptra.subscriptions.list();
  } catch {
    return [];
  }
}

/** Ids of the channels that are subscriptions (the Tabs list leaves them to the Services tab). */
export const subscriptionChannelIds = (calyptra: Calyptra): Set<string> => new Set(subscriptionsOf(calyptra).map((s) => s.channelId));

/** Seconds a subscription paid for so far. */
export const paidSeconds = (s: Subscription): number => (s.ratePerSecond > 0n ? Number(s.paid / s.ratePerSecond) : 0);

/** A duration as "5 min 12 s" (activity rows). */
export function durationText(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

/** A duration as a clock, "05:12" or "1:05:12" (the session meter). */
export function clockText(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
