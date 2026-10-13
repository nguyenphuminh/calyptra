import { BUILT_IN_NETWORKS } from '@calyptra/framework';
import { describe, expect, it } from 'vitest';
import { formatAmount, formatBalance, formatDollars, formatDollarsExact, formatMoney, parseAmount, tokenId, tokenName } from './amounts.ts';

const builtIn = BUILT_IN_NETWORKS;

describe('amounts', () => {
  it('parses decimal text into base units and rejects anything else', () => {
    expect(parseAmount('native', '0.01')).toBe(10n ** 16n);
    expect(parseAmount('stablecoin', ' 12.5 ')).toBe(12_500_000n);
    for (const bad of ['', '0', '-1', '1e3', 'abc', '1.', '0.0000001']) expect(parseAmount('stablecoin', bad)).toBeNull();
  });

  it('formats amounts and maps token names', () => {
    expect(formatAmount('native', 1500000000000000000n)).toBe('1.5 MON');
    const first = builtIn[0];
    if (!first) throw new Error('no built-in network');
    expect(tokenId('stablecoin', first)).toBe(BigInt(first.stablecoin));
    expect(tokenName(0n)).toBe('native');
  });

  it('cuts balances to 6 decimals without rounding up', () => {
    expect(formatBalance('native', 15614519814900763n)).toBe('0.015614 MON');
    expect(formatBalance('native', 16000000000000000n)).toBe('0.016 MON');
    expect(formatBalance('native', 999999999999n)).toBe('< 0.000001 MON');
    expect(formatBalance('native', 0n)).toBe('0 MON');
    expect(formatBalance('stablecoin', 88_770_001n)).toBe('88.770001 AUSD');
  });

  it('shows the stablecoin as dollars with 2 decimals, cut, never rounded up', () => {
    expect(formatDollars(7_490_000n)).toBe('$7.49');
    expect(formatDollars(7_499_999n)).toBe('$7.49');
    expect(formatDollars(0n)).toBe('$0.00');
    expect(formatDollars(9_999n)).toBe('< $0.01');
    expect(formatDollars(1_234_567_890_000n)).toBe('$1,234,567.89');
    expect(formatDollarsExact(2_000n)).toBe('$0.002');
    expect(formatDollarsExact(7_200_000n)).toBe('$7.20');
    expect(formatMoney('stablecoin', 100_000_000n)).toBe('$100.00');
    expect(formatMoney('native', 10n ** 17n)).toBe('0.1 MON');
  });
});
