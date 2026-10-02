import { BUILT_IN_NETWORKS } from '@calyptra/framework';
import type { NetworkConfig } from '@calyptra/framework';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, tokenId, tokenName } from './amounts.ts';

const network = BUILT_IN_NETWORKS[0] as NetworkConfig;

describe('amounts', () => {
  it('parses decimal amounts into base units', () => {
    expect(parseAmount('native', '0.01')).toBe(10n ** 16n);
    expect(parseAmount('stablecoin', '1.5')).toBe(1_500_000n);
  });

  it('formats base units with the symbol', () => {
    expect(formatAmount('stablecoin', 1_500_000n)).toBe('1.5 AUSD');
    expect(formatAmount('native', 10n ** 18n)).toBe('1 MON');
  });

  it('refuses zero', () => {
    expect(() => parseAmount('native', '0')).toThrow(/positive/);
    expect(() => parseAmount('stablecoin', '0.0000001')).toThrow(/positive/);
  });

  it('maps token names to the network token ids and back', () => {
    expect(tokenId('native', network)).toBe(0n);
    expect(tokenId('stablecoin', network)).toBe(BigInt(network.stablecoin));
    expect(tokenName(0n, network)).toBe('native');
    expect(tokenName(BigInt(network.stablecoin), network)).toBe('stablecoin');
    expect(() => tokenName(123n, network)).toThrow(/Only the native coin and the stablecoin/);
  });
});
