// A framework node in the test process (UI tier): the counterparty of the dispute tests,
// which need a dispute window shorter than the website's fixed 7 days, and the echo merchant of the
// subscription test. It reaches web users through the desktop client's libp2p relay and relayer.
import './port.ts';
import { english, generateMnemonic } from 'viem/accounts';
import {
  Calyptra,
  MemoryStore,
  encodeInvite,
  encodeMerchantCard,
  fileArtifacts,
  shieldedAddressOf,
  type NetworkConfig,
  type Offer,
  type ServicePort,
} from '../../packages/framework/src/index.ts';
import { createPeerNode } from '../../packages/framework/src/libp2p.node.ts';
import { REPO } from '../../scripts/lib/devnode.ts';

/** scrypt lowered for test speed. */
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'password123';

export interface PeerOptions {
  /** Dispute window of the channels this node opens, in seconds (the test contracts accept 10 s and up). */
  disputeWindow?: bigint;
  /** Merchant mode: sell this offer by the second through this service. */
  merchant?: { offer: Offer; service: ServicePort };
}

/** A node on `network` (its relayers and libp2p relays are the desktop client's), unlocked and reachable. */
export async function startPeer(network: NetworkConfig, options: PeerOptions = {}): Promise<Calyptra> {
  const calyptra = new Calyptra({
    store: new MemoryStore(),
    artifacts: fileArtifacts(`${REPO}/packages/framework/artifacts`),
    createNode: createPeerNode,
    networks: [network],
    kdf: FAST_KDF,
    ...(options.disputeWindow === undefined ? {} : { disputeWindow: options.disputeWindow }),
    ...(options.merchant ? { merchant: options.merchant } : {}),
  });
  await calyptra.wallet.createFromPhrase(generateMnemonic(english, 128), PASSWORD);
  await calyptra.wallet.setNetwork(network.id);
  await calyptra.start();
  await calyptra.p2p.waitForRelay();
  return calyptra;
}

/** The node's invite code, as the website's invite dialog encodes it. */
export async function inviteOf(calyptra: Calyptra): Promise<string> {
  return encodeInvite(calyptra.p2p.invite(shieldedAddressOf(await calyptra.keys.poolKeys())));
}

/** The merchant card code `{ v: 1, name, invite, offer }` of a node in merchant mode (as the desktop client makes it). */
export async function merchantCardOf(calyptra: Calyptra, offer: Offer): Promise<string> {
  return encodeMerchantCard({ v: 1, name: offer.title, invite: await inviteOf(calyptra), offer });
}

/** Calls `tick()` every `ms` while the node runs (a tick still running skips the next); returns the stopper. */
export function keepTicking(calyptra: Calyptra, ms = 1_500): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    calyptra.tick().catch(() => undefined).finally(() => { running = false; });
  }, ms);
  return () => clearInterval(timer);
}
