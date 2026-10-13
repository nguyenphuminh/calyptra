import { HttpRelayer, type Calyptra } from '@calyptra/framework';
import { z } from 'zod';

// User-editable network settings, stored inside the encrypted wallet vault.
// They apply to every account on the selected network.
const WebSettingsSchema = z.object({
  relayers: z.array(z.string()), // transaction relayer base URLs (HTTP)
  libp2pRelays: z.array(z.string()), // libp2p relay multiaddrs (WebSocket relays)
  rpcUrls: z.array(z.string()).default([]), // RPC endpoints tried before the network's own
  rpcFallback: z.boolean().default(true), // keep using the network's own RPCs after the user's
});
export type WebSettings = z.infer<typeof WebSettingsSchema>;
const SECTION = 'web-settings';
const ALL_ACCOUNTS = '*'; // network-wide data is kept under this account id instead of a real one

export function readSettings(calyptra: Calyptra): WebSettings {
  return calyptra.wallet.readSection(SECTION, WebSettingsSchema, ALL_ACCOUNTS)
    ?? { relayers: [], libp2pRelays: [], rpcUrls: [], rpcFallback: true };
}

export async function writeSettings(calyptra: Calyptra, settings: WebSettings): Promise<void> {
  const previous = readSettings(calyptra);
  await calyptra.wallet.writeSection(SECTION, settings, ALL_ACCOUNTS);
  try {
    await startNode(calyptra); // settings take effect immediately
  } catch (err) {
    // A change the node cannot start with is not kept: saved, it would fail every unlock after it.
    await calyptra.wallet.writeSection(SECTION, previous, ALL_ACCOUNTS);
    await startNode(calyptra);
    throw new Error('Calyptra could not start with this setting, so it was not saved.', { cause: err });
  }
}

/** (Re)starts the node with the network's relays and relayers, the user's own first. */
export async function startNode(calyptra: Calyptra): Promise<void> {
  const own = readSettings(calyptra);
  const network = calyptra.network();
  calyptra.configure({
    relayers: [...own.relayers, ...network.relayers].map((url) => new HttpRelayer(url)),
    libp2pRelays: [...own.libp2pRelays, ...network.libp2pRelays],
    rpcUrls: own.rpcUrls,
    rpcFallback: own.rpcFallback,
  });
  await calyptra.start();
}
