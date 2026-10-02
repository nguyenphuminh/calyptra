import { describe, expect, it } from 'vitest';
import { clockText, durationText, paidSeconds } from './merchants.ts';

describe('subscription figures', () => {
  it('counts the seconds a subscription paid for', () => {
    expect(paidSeconds({ channelId: 'c', merchant: 'm', ratePerSecond: 2_000n, cap: 5_000_000n, paid: 624_000n })).toBe(312);
    expect(paidSeconds({ channelId: 'c', merchant: 'm', ratePerSecond: 2_000n, cap: 5_000_000n, paid: 1_999n })).toBe(0);
  });

  it('writes durations for activity rows and the session meter', () => {
    expect(durationText(312)).toBe('5 min 12 s');
    expect(durationText(42)).toBe('42 s');
    expect(durationText(3_725)).toBe('1 h 2 min');
    expect(clockText(312)).toBe('05:12');
    expect(clockText(3_725)).toBe('1:02:05');
  });
});
