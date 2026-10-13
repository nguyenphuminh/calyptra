import type { Calyptra } from '@calyptra/framework';
import { z } from 'zod';

// Names the user gives to channel peers, keyed by libp2p peer id. Local labels: never sent
// to the peer. Kept in the encrypted wallet per account and network, so the export file carries them.
const SECTION = 'web-nicknames';
const NicknamesSchema = z.record(z.string(), z.string());
export const MAX_NICKNAME = 40;

export function nicknames(calyptra: Calyptra): Record<string, string> {
  return calyptra.wallet.readSection(SECTION, NicknamesSchema) ?? {};
}

/** Sets a peer's nickname; an empty name removes it. */
export async function setNickname(calyptra: Calyptra, peerId: string, name: string): Promise<void> {
  const next = { ...nicknames(calyptra) };
  const trimmed = name.trim().slice(0, MAX_NICKNAME);
  if (trimmed) next[peerId] = trimmed;
  else delete next[peerId];
  await calyptra.wallet.writeSection(SECTION, next);
}
