import { BUILT_IN_NETWORKS, NetworkConfigSchema, Calyptra, urlArtifacts, type NetworkConfig } from '@calyptra/framework';
import { createBrowserNode } from '@calyptra/framework/libp2p-browser';
import { IdbStore } from '../shared/idb.store.ts';
import type { Prompts } from './prompts.ts';
import type { WorkerProver } from './worker-prover.ts';

/** How long a peer waits for an answer before its channel proposal fails (the P2P request timeout is 60 s). */
const APPROVAL_TIMEOUT_MS = 50_000;

/** Where the proving files are served: always the origin root. */
export const artifactsBase = (): string => `${location.origin}/artifacts`;

/** Extra chains given to the dev server (one or a list), e.g. the local dev node in UI tests. Absent in normal builds. */
function devNetworks(): NetworkConfig[] {
  const raw = import.meta.env.VITE_CALYPTRA_DEV_NETWORK as string | undefined;
  return raw ? [JSON.parse(raw) as unknown].flat().map((n) => NetworkConfigSchema.parse(n)) : [];
}

/**
 * The website's composition root: the framework node with the browser's storage, proving files and libp2p.
 * The prover is created by the shell, which also asks it whether a proof is running (§11.6, proof wait).
 */
export function createCalyptra(prompts: Prompts, prover: WorkerProver, onChanged: () => void): Calyptra {
  return new Calyptra({
    store: new IdbStore(),
    artifacts: urlArtifacts(artifactsBase()),
    prover,
    createNode: createBrowserNode,
    networks: [...BUILT_IN_NETWORKS, ...devNetworks()],
    // BRD 2.2.7: a channel that needs none of the user's money opens without asking.
    approveOpen: (request) => (request.peerAmount === 0n ? Promise.resolve(true) : prompts.ask({ kind: 'approve-open', request }, APPROVAL_TIMEOUT_MS)),
    // The channel of an accepted request takes its place in the channel list (BRD 2.2.14.9).
    onJoined: (channelId) => prompts.joined(channelId),
    // A payment the other side made shows at once, not on the next background tick.
    onChanged: () => onChanged(),
    // BRD 2.2.8: no outgoing payment is signed without the user's confirmation in the wallet's dialog.
    confirmPayment: (payment) => prompts.ask({ kind: 'confirm-payment', ...payment }),
  });
}
