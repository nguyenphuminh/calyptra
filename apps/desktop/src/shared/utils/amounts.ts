import { AppError } from '@calyptra/framework';
import type { NetworkConfig } from '@calyptra/framework';
import { formatUnits, parseUnits } from 'viem';

/** Token names typed on the CLI and sent over RPC. */
export const TOKEN_NAMES = ['native', 'stablecoin'] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

/** AUSD, the stablecoin on Monad, has 6 decimals (checked on chain). */
const DECIMALS: Record<TokenName, number> = { native: 18, stablecoin: 6 };
const SYMBOL: Record<TokenName, string> = { native: 'MON', stablecoin: 'AUSD' };

/** The framework's token id: 0 for the native coin, the stablecoin's address as an integer otherwise. */
export const tokenId = (name: TokenName, network: NetworkConfig): bigint => (name === 'native' ? 0n : BigInt(network.stablecoin));

export function tokenName(token: bigint, network: NetworkConfig): TokenName {
  if (token === 0n) return 'native';
  if (token === BigInt(network.stablecoin)) return 'stablecoin';
  throw new AppError(400, 'TOKEN_NOT_SUPPORTED', 'Only the native coin and the stablecoin are supported');
}

/** A decimal amount in the token's units, as base units; zero (or rounding to zero) is refused. */
export function parseAmount(name: TokenName, text: string): bigint {
  const value = parseUnits(text, DECIMALS[name]);
  if (value <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be positive');
  return value;
}

/** Base units as the displayed amount, e.g. "1 MON" or "1.5 AUSD". */
export const formatAmount = (name: TokenName, value: bigint): string => `${formatUnits(value, DECIMALS[name])} ${SYMBOL[name]}`;
