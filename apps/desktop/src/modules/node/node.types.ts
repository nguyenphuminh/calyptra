/** An account as the CLI and RPC show it (`id` is its address). */
export interface AccountView {
  id: string;
  label: string;
  kind: 'derived' | 'imported';
  used: boolean;
  active: boolean;
  /** The account that submits relayed transactions while this node relays. */
  relayer: boolean;
}

/** A channel as the CLI and RPC show it; amounts are formatted (e.g. "0.05 MON"). */
export interface ChannelView {
  id: string;
  status: string;
  role: 'opener' | 'invitee';
  balance: string;
  peerBalance: string;
  closingFee: string;
  windowSeconds: number;
  peer: string;
}

export interface Balances {
  native: string;
  stablecoin: string;
}

/** The roles this node plays for others, as reported by `status`. */
export interface Roles {
  relayer: { url: string; account: string } | null;
  libp2pRelay: string[] | null;
}

export interface NodeOptions {
  /** Set while this node relays: that account never deposits and is never offered as an exit address. */
  relayerAccountId?: string;
  roles: () => Roles;
}
