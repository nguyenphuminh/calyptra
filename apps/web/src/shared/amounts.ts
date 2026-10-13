import type { NetworkConfig } from '@calyptra/framework';
import { formatUnits, parseUnits } from 'viem';

export const TOKENS = ['native', 'stablecoin'] as const;
export type TokenName = (typeof TOKENS)[number];
const DECIMALS: Record<TokenName, number> = { native: 18, stablecoin: 6 };
export const SYMBOL: Record<TokenName, string> = { native: 'MON', stablecoin: 'AUSD' };

/** Dollars first: forms list the stablecoin first and start on it (AUSD is the main currency). */
export const TOKEN_CHOICES: readonly TokenName[] = ['stablecoin', 'native'];
export const DEFAULT_TOKEN: TokenName = 'stablecoin';
/** How a token is named on screen: the stablecoin is shown as dollars, the native coin by its symbol. */
export const DISPLAY_SYMBOL: Record<TokenName, string> = { native: 'MON', stablecoin: '$' };
export const TOKEN_LABEL: Record<TokenName, string> = { native: 'MON', stablecoin: 'Dollars (AUSD)' };

/** Notes hold 64-bit amounts, so one native-coin deposit holds at most 2^64 - 1 wei, about 18.44 MON. */
export const MAX_NOTE_AMOUNT = (1n << 64n) - 1n;

/** The token as the framework numbers it: 0 for the native coin, the network's stablecoin contract otherwise. */
export const tokenId = (name: TokenName, network: NetworkConfig): bigint => (name === 'native' ? 0n : BigInt(network.stablecoin));
export const tokenName = (token: bigint): TokenName => (token === 0n ? 'native' : 'stablecoin');

/** The user's text as base units, or null when it is not a positive amount with at most the token's decimals. */
export function parseAmount(name: TokenName, text: string): bigint | null {
  const value = text.trim();
  if (!/^\d+(\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > DECIMALS[name]) return null;
  const units = parseUnits(value, DECIMALS[name]);
  return units > 0n ? units : null;
}

export const formatAmount = (name: TokenName, value: bigint): string => `${formatUnits(value, DECIMALS[name])} ${SYMBOL[name]}`;

/** A balance cut, never rounded up, to at most 6 decimals; a non-zero balance below that shows as "< 0.000001". */
export function formatBalance(name: TokenName, value: bigint): string {
  const step = 10n ** BigInt(Math.max(DECIMALS[name] - 6, 0));
  const shown = (value / step) * step;
  return shown === 0n && value > 0n ? `< ${formatAmount(name, step)}` : formatAmount(name, shown);
}
export const toDecimal = (name: TokenName, value: bigint): string => formatUnits(value, DECIMALS[name]);

const grouped = (whole: bigint): string => whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Stablecoin base units as dollars with 2 decimals, cut (never rounded up); a non-zero amount below a cent is "< $0.01". */
export function formatDollars(value: bigint): string {
  const cents = value / 10n ** BigInt(DECIMALS.stablecoin - 2);
  if (cents === 0n && value > 0n) return '< $0.01';
  return `$${grouped(cents / 100n)}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Stablecoin base units as dollars with every decimal kept (at least 2), for small rates such as $0.002 per second. */
export function formatDollarsExact(value: bigint): string {
  const [whole = '0', fraction = ''] = formatUnits(value, DECIMALS.stablecoin).split('.');
  return `$${grouped(BigInt(whole))}.${fraction.padEnd(2, '0')}`;
}

/** The typed amount with its currency, as a confirmation repeats it. */
export const typedAmount = (name: TokenName, text: string): string => (name === 'stablecoin' ? `$${text.trim()}` : `${text.trim()} MON`);

/**
 * An amount as the main screens show it: the stablecoin as dollars, the native coin exactly.
 * The exact amount, as `formatAmount` prints it, belongs in the element's title.
 */
export const formatMoney = (name: TokenName, value: bigint): string => (name === 'stablecoin' ? formatDollars(value) : formatAmount(name, value));
