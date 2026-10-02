import type { NetworkConfig } from '@calyptra/framework';
import networkLogoAsset from './network-logo.svg';

/** Chain ids shown with the network's logo (Monad mainnet 143 and testnet 10143). */
const LOGO_CHAINS = new Set([143, 10143]);

/** The network's logo, if it has one; shown at its minimum brand size of 24px. */
export const networkLogo = (network: NetworkConfig): string | null => (LOGO_CHAINS.has(network.chainId) ? networkLogoAsset : null);
