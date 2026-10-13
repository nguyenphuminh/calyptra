import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const NetworkConfigSchema = z.object({
  id: z.string(),                                   // stable id stored in the wallet, e.g. 'monad-testnet'
  name: z.string(),                                 // display name, used in error messages
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),                         // main public endpoint
  /** More public endpoints, tried after `rpcUrl` when it does not answer. */
  backupRpcUrls: z.array(z.string().url()).optional(),
  /** Endpoints for event history only (eth_getLogs), tried before the others for event scans: Envio
   *  HyperRPC behind the relay host's /hyperrpc proxy. Every other read and write uses the RPC endpoints. */
  logRpcUrls: z.array(z.string().url()).optional(),
  explorerUrl: z.string().url().optional(),
  stablecoin: address,                              // the ERC-20 the pool supports
  /** Absent until Calyptra is deployed on this chain. */
  contracts: z.object({
    pool: address,
    disputes: address,
    /** First block to scan for pool events. */
    deployBlock: z.coerce.bigint(),
  }).optional(),
  /** Transaction relayers (HTTP endpoints). Users can add their own. */
  relayers: z.array(z.string().url()),
  /** libp2p relays (multiaddrs) that make peers reachable without exposing their IP. */
  libp2pRelays: z.array(z.string()),
  /** Merchants listed in the app without a link: merchant-card codes, decoded by the subscription module. */
  merchants: z.array(z.string()).optional(),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

/**
 * The built-in network: contracts deployed 2026-10-12 (`npm run deploy:network -- --network monad-testnet`),
 * relay host relay.calyptra.space with its Envio HyperRPC proxy and the demo merchant (`npm run deploy:live`;
 * the merchant card is on the relay host's ready line).
 */
export const BUILT_IN_NETWORKS: readonly NetworkConfig[] = [
  {
    id: 'monad-testnet',
    name: 'Monad Testnet',
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',                    // official, about 50 requests/s
    backupRpcUrls: ['https://rpc.ankr.com/monad_testnet'],
    logRpcUrls: ['https://relay.calyptra.space/hyperrpc'],     // Envio HyperRPC behind the relay host
    explorerUrl: 'https://testnet.monadvision.com',
    stablecoin: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc', // AUSD, 6 decimals (checked on chain 2026-10-11)
    contracts: {
      pool: '0x949a9e04fa9a0a619855c1cbf79da25d73152c13',
      disputes: '0xe33b1144efd35596a5cca72fc52941a442436145',
      deployBlock: 70436926n,
    },
    relayers: ['https://relay.calyptra.space'],
    libp2pRelays: ['/dns4/relay.calyptra.space/tcp/443/wss/p2p/12D3KooWBgwLiqUc7CPFsurgxx2AjFjZEYHNx1GjTSWPr4brvHok'],
    merchants: [
      // Calyptra AI · powered by Gemini ($0.002/s, from $1), served by the relay host
      'eyJ2IjoxLCJuYW1lIjoiQ2FseXB0cmEgQUkgwrcgcG93ZXJlZCBieSBHZW1pbmkiLCJpbnZpdGUiOiJleUoySWpveExDSndaV1Z5U1dRaU9pSXhNa1F6UzI5dlYxTmxNME5IWmpWYVUxQnVZVTFYVURGdlRGbEdXa0prUjJ0aVlXMVJVVGgyYW5KblMwMTZZVWRIYTNsbUlpd2lZV1JrY25NaU9sc2lMMmx3TkM4eE1qY3VNQzR3TGpFdmRHTndMemcyTkRjdmQzTXZjREp3THpFeVJETkxiMjlYUW1kM1RHbHhWV00zUTFCR2MzVnlaM2g0TWtGcVJtcGFSVmxJVG5neFIycFVVMWRRY2pSaWNuWkliMnN2Y0RKd0xXTnBjbU4xYVhRdmNESndMekV5UkROTGIyOVhVMlV6UTBkbU5WcFRVRzVoVFZkUU1XOU1XVVphUW1SSGEySmhiVkZST0hacWNtZExUWHBoUjBkcmVXWWlMQ0l2Wkc1ek5DOXlaV3hoZVM1allXeDVjSFJ5WVM1emNHRmpaUzkwWTNBdk5EUXpMM2R6Y3k5d01uQXZNVEpFTTB0dmIxZENaM2RNYVhGVll6ZERVRVp6ZFhKbmVIZ3lRV3BHYWxwRldVaE9lREZIYWxSVFYxQnlOR0p5ZGtodmF5OXdNbkF0WTJseVkzVnBkQzl3TW5Bdk1USkVNMHR2YjFkVFpUTkRSMlkxV2xOUWJtRk5WMUF4YjB4WlJscENaRWRyWW1GdFVWRTRkbXB5WjB0TmVtRkhSMnQ1WmlKZExDSnphR2xsYkdSbFpFRmtaSEpsYzNNaU9pSmpZV3d3T1RabE9HWTJNVEV6WWpsbVlUQmxNek16TldObFpqazJPVFl5Wm1WaE0yWTBPVE0zT0RobU1XWmhZalkxWlRjME56TTJZVEJtT0RsbVpqZGpNemxpT0dJM1lUbGtaREU0TmpnNU1UTmxNekppTldReU5UY3pOREV4WW1ZNFpUSmxNRGhpT0RFNU0yVXlOMkZoWlRjd1lUZGhOamM1TjJJM09EYzBPV0V6TW1FeFkyWmlPR05pSW4wIiwib2ZmZXIiOnsia2luZCI6ImFpLWNoYXQiLCJ0aXRsZSI6IkNhbHlwdHJhIEFJIMK3IHBvd2VyZWQgYnkgR2VtaW5pIiwidG9rZW4iOiJzdGFibGVjb2luIiwicmF0ZVBlclNlY29uZCI6IjIwMDAiLCJtaW5GdW5kaW5nIjoiMTAwMDAwMCIsImdyYWNlU2Vjb25kcyI6M319',
    ],
  },
];
