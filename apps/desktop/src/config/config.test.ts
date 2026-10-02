import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.ts';

const noEnv = {};

describe('loadConfig', () => {
  it('has safe defaults: no RPC, no relayer, no libp2p relay, shell on, tick 15', () => {
    const config = loadConfig(['start'], noEnv);
    expect(config.command).toBe('start');
    expect(config.rpc).toMatchObject({ enabled: false, port: 8645 });
    expect(config.relayer).toMatchObject({ enabled: false, host: '0.0.0.0', port: 8646 });
    expect(config.libp2pRelay).toMatchObject({ enabled: false, host: '0.0.0.0', port: 8647 });
    expect(config.merchant.enabled).toBe(false);
    expect(config.envioToken).toBeUndefined();
    expect(config.chainRpcFallback).toBe(true);
    expect(config.shell).toBe(true);
    expect(config.tickSeconds).toBe(15);
    expect(config.logLevel).toBe('info');
    expect(loadConfig([], noEnv).command).toBe('help');
    expect(loadConfig(['start', '--help'], noEnv).command).toBe('help');
  });

  it('reads every role and list option', () => {
    const config = loadConfig(
      [
        'start', '--rpc', '--rpc-port', '9000', '--rpc-token-file', '/tmp/t.json',
        '--relayer', '--relayer-account', '0xabc', '--relayer-fee-native', '0.001', '--relayer-fee-stablecoin', '0.02', '--relayer-host', '127.0.0.1',
        '--libp2p-relay', '--libp2p-relay-port', '9001', '--libp2p-relay-announce', '/dns4/relay.example/tcp/443/wss',
        '--relayers', ' https://a.example , https://b.example ,', '--libp2p-relays', '/ip4/1.2.3.4/tcp/1/ws/p2p/x',
        '--chain-rpcs', 'http://127.0.0.1:8545', '--no-chain-rpc-fallback', '--no-shell', '--tick', '5',
        '--max-fee-native', '0.5', '--max-fee-stablecoin', '0.05', '--network', 'devnode', '--network-file', 'n.json', '--log-level', 'warn',
      ],
      noEnv,
    );
    expect(config.rpc).toEqual({ enabled: true, port: 9000, tokenFile: '/tmp/t.json' });
    expect(config.relayer).toEqual({ enabled: true, host: '127.0.0.1', port: 8646, account: '0xabc', feeNative: '0.001', feeStable: '0.02' });
    expect(config.libp2pRelay).toEqual({ enabled: true, host: '0.0.0.0', port: 9001, announce: ['/dns4/relay.example/tcp/443/wss'] });
    expect(config.relayers).toEqual(['https://a.example', 'https://b.example']);
    expect(config.libp2pRelays).toEqual(['/ip4/1.2.3.4/tcp/1/ws/p2p/x']);
    expect(config.chainRpcs).toEqual(['http://127.0.0.1:8545']);
    expect(config.chainRpcFallback).toBe(false);
    expect(config.shell).toBe(false);
    expect(config.tickSeconds).toBe(5);
    expect(config.maxFee).toEqual({ native: '0.5', stablecoin: '0.05' });
    expect(config).toMatchObject({ network: 'devnode', networkFile: 'n.json', logLevel: 'warn' });
  });

  it('quotes the default relayer fees (0.25 MON, 0.01 AUSD) when none are given', () => {
    const config = loadConfig(['start', '--relayer', '--relayer-account', '0xabc'], noEnv);
    expect(config.relayer).toMatchObject({ enabled: true, feeNative: '0.25', feeStable: '0.01' });
  });

  it('reads merchant mode and the server-side secrets from the environment', () => {
    const env = { DASHSCOPE_API_KEY: 'k', CALYPTRA_ENVIO_TOKEN: 't' };
    const config = loadConfig(['start', '--merchant', '--merchant-offer', 'offer.json'], env);
    expect(config.merchant).toEqual({ enabled: true, offerFile: 'offer.json', apiKey: 'k' });
    expect(config.envioToken).toBe('t');
  });

  it('fails fast', () => {
    expect(() => loadConfig(['init'], noEnv)).toThrow(/init needs --phrase, --private-key or --import-file/);
    expect(() => loadConfig(['start', '--relayer'], noEnv)).toThrow(/--relayer needs --relayer-account/);
    expect(() => loadConfig(['start', '--relayer', '--relayer-account', '0xabc', '--relayer-fee-native', 'lots'], noEnv)).toThrow(/decimal amount/);
    expect(() => loadConfig(['start', '--rpc-port', '70000'], noEnv)).toThrow();
    expect(() => loadConfig(['start', '--relayers', 'not a url'], noEnv)).toThrow();
    expect(() => loadConfig(['launch'], noEnv)).toThrow();
    expect(() => loadConfig(['start', '--frobnicate'], noEnv)).toThrow();
    expect(() => loadConfig(['help', '--frobnicate'], noEnv)).toThrow();
    expect(() => loadConfig(['start', '--merchant', '--merchant-offer', 'o.json'], noEnv)).toThrow(/DASHSCOPE_API_KEY/);
    expect(() => loadConfig(['start', '--merchant'], { DASHSCOPE_API_KEY: 'k' })).toThrow(/--merchant-offer/);
  });

  it('maps the init source', () => {
    expect(loadConfig(['init', '--phrase'], noEnv).init.source).toBe('phrase');
    expect(loadConfig(['init', '--private-key'], noEnv).init).toEqual({ source: 'private-key' });
    expect(loadConfig(['init', '--import-file', 'w.json'], noEnv).init).toEqual({ source: 'import-file', importFile: 'w.json' });
  });
});
