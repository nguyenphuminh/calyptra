import { BUILT_IN_NETWORKS } from '@calyptra/framework';
import { describe, expect, it } from 'vitest';
import { shortAddress } from './addresses.ts';
import { networkLogo } from './networks.ts';

describe('addresses', () => {
  it('shortens addresses the way wallets show them', () => {
    expect(shortAddress('0x6412d4dc3b4bD2Eb3c0a3E0e2f6E1f9E8a4F3a9f')).toBe('0x6412…3a9f');
    expect(shortAddress(`cal0dc7f5d8${'ab'.repeat(60)}60ad8c91`)).toBe('cal0dc7f5d8…60ad8c91');
    expect(shortAddress('0x1234')).toBe('0x1234');
  });

  it('shows the network logo for the product networks only', () => {
    const builtIn = BUILT_IN_NETWORKS[0];
    if (!builtIn) throw new Error('no built-in network');
    expect(networkLogo(builtIn)).toMatch(/(network-logo[^/]*\.svg$)|(^data:image\/svg)/);
    expect(networkLogo({ ...builtIn, id: 'dev', chainId: 31337 })).toBeNull();
  });
});
