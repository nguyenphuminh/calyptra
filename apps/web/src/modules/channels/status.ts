import type { ChannelStatus } from '@calyptra/framework';

// Consumer wording (§11.6): a channel with a person is a "tab"; a cooperative close is "settling";
// a dispute is "settling without the other side".
export const STATUS_TEXT: Record<ChannelStatus, string> = {
  opening: 'Starting', // accepted; contributions not yet confirmed
  funding: 'Setting up', // opener funded; waiting for the second contribution or for it to be seen
  live: 'Live', // payments are possible
  closing: 'Settling', // a final state was agreed; the close is being submitted
  closed: 'Settled', // closed cooperatively; payouts are in the private balance
  disputing: 'Settling without them', // a dispute is open
  settled: 'Settled', // settled after a dispute
  cancelled: 'Cancelled', // opening cancelled before funding
};

export type PendingState = 'waiting' | 'declined' | 'failed';
export const PENDING_TEXT: Record<PendingState, string> = { waiting: 'Pending', declined: 'Declined', failed: 'Not started' };
export const PENDING_CLASS: Record<PendingState, string> = { waiting: 'status-pending', declined: 'status-declined', failed: 'status-failed' };

/** The name shown for a peer: the user's nickname, else "Contact" and the last 6 characters of its peer id. */
export const peerName = (peerId: string, names: Record<string, string>): string => names[peerId] ?? `Contact ${peerId.slice(-6)}`;
