import { writeFile } from 'node:fs/promises';
import {
  AppError,
  ChannelRepository,
  balanceOf,
  decodeInvite,
  encodeInvite,
  shieldedAddressOf,
  sideOf,
} from '@calyptra/framework';
import type { Account, Calyptra, ChannelRecord, NetworkConfig, RelayerInfo } from '@calyptra/framework';
import type { Address, Hex } from 'viem';
import { formatAmount, parseAmount, tokenId, tokenName } from '../../shared/utils/amounts.ts';
import type {
  ChannelInput,
  DepositInput,
  ExportInput,
  ImportAccountInput,
  OpenChannelInput,
  PayChannelInput,
  TransferInput,
  UseAccountInput,
  UseNetworkInput,
  WithdrawInput,
} from './node.schema.ts';
import type { AccountView, Balances, ChannelView, NodeOptions, Roles } from './node.types.ts';

/** Every user operation of the desktop node, on the framework facade. */
export class NodeService {
  private readonly calyptra: Calyptra;
  private readonly options: NodeOptions;

  constructor(calyptra: Calyptra, options: NodeOptions) {
    this.calyptra = calyptra;
    this.options = options;
  }

  async getStatus(): Promise<{
    account: AccountView;
    network: { id: string; name: string; deployed: boolean };
    shieldedAddress: string;
    shieldedBalance: Balances;
    lastExportAt: string | null;
    roles: Roles;
  }> {
    const network = this.calyptra.network();
    const lastExportAt = this.calyptra.wallet.lastExportAt();
    return {
      account: this.view(this.calyptra.wallet.activeAccount()),
      network: { id: network.id, name: network.name, deployed: Boolean(network.contracts) },
      shieldedAddress: await this.getAddress(),
      shieldedBalance: this.balances(network),
      lastExportAt: lastExportAt === null ? null : new Date(lastExportAt).toISOString(),
      roles: this.options.roles(),
    };
  }

  getAccounts(): AccountView[] {
    return this.calyptra.wallet.accounts().map((a) => this.view(a));
  }

  async createAccount(): Promise<AccountView> {
    return this.view(await this.calyptra.wallet.addAccount());
  }

  async importAccount(input: ImportAccountInput): Promise<AccountView> {
    return this.view(await this.calyptra.wallet.importAccount(input.privateKey));
  }

  async useAccount(input: UseAccountInput): Promise<AccountView> {
    const account = this.findAccount(input.account);
    await this.calyptra.wallet.setActiveAccount(account.id);
    await this.calyptra.start();
    return this.view(this.calyptra.wallet.activeAccount());
  }

  getNetworks(): { id: string; name: string; chainId: number; deployed: boolean; active: boolean }[] {
    const active = this.calyptra.wallet.networkId();
    return this.calyptra.networks().map((n) => ({ id: n.id, name: n.name, chainId: n.chainId, deployed: Boolean(n.contracts), active: n.id === active }));
  }

  async useNetwork(input: UseNetworkInput): Promise<{ network: string }> {
    if (!this.calyptra.networks().some((n) => n.id === input.network)) {
      throw new AppError(404, 'UNKNOWN_NETWORK', `No network "${input.network}"`);
    }
    await this.calyptra.wallet.setNetwork(input.network);
    await this.calyptra.start();
    return { network: input.network };
  }

  /** Read-only: the desktop client never sends public funds. */
  async getPublicBalance(): Promise<{ address: string; native: string; stablecoin: string }> {
    const network = this.calyptra.network();
    const { address } = this.calyptra.wallet.activeAccount();
    const [native, stablecoin] = await Promise.all([
      this.calyptra.chain.publicBalance(address, tokenId('native', network)),
      this.calyptra.chain.publicBalance(address, tokenId('stablecoin', network)),
    ]);
    return { address, native: formatAmount('native', native), stablecoin: formatAmount('stablecoin', stablecoin) };
  }

  async getAddress(): Promise<string> {
    return shieldedAddressOf(await this.calyptra.keys.poolKeys());
  }

  async getBalance(): Promise<Balances> {
    await this.calyptra.pool.sync();
    return this.balances(this.calyptra.network());
  }

  getNotes(): { amount: string; leafIndex: number; channel: string | null }[] {
    const network = this.calyptra.network();
    const channels = new ChannelRepository(this.calyptra.wallet, network.id).all();
    return this.calyptra.pool
      .notes()
      .filter((n) => !n.spent)
      .map((n) => {
        const index = n.secret === 'spending' ? null : n.secret.channel;
        return {
          amount: formatAmount(tokenName(n.token, network), n.amount),
          leafIndex: n.leafIndex,
          channel: index === null ? null : (channels.find((c) => c.index === index)?.id ?? null),
        };
      });
  }

  async deposit(input: DepositInput): Promise<{ txHash: Hex }> {
    if (this.isRelayerAccount(this.calyptra.wallet.activeAccount().id)) {
      throw new AppError(409, 'RELAYER_ACCOUNT', 'The relayer account never makes deposits; switch to another account');
    }
    const network = this.calyptra.network();
    return { txHash: await this.calyptra.pool.deposit(tokenId(input.token, network), parseAmount(input.token, input.amount)) };
  }

  async transfer(input: TransferInput): Promise<{ txHash: Hex }> {
    const network = this.calyptra.network();
    const txHash = await this.calyptra.pool.transfer(input.to, tokenId(input.token, network), parseAmount(input.token, input.amount), this.calyptra.relayer());
    return { txHash };
  }

  /** Without `to`, cashes out to an account never linked to the pool (a new one if needed). */
  async withdraw(input: WithdrawInput): Promise<{ txHash: Hex; to: Address }> {
    const network = this.calyptra.network();
    const amount = parseAmount(input.token, input.amount);
    const to = (input.to as Address | undefined) ?? (await this.freshExitAddress());
    const txHash = await this.calyptra.pool.withdraw(tokenId(input.token, network), amount, to, this.calyptra.relayer());
    return { txHash, to };
  }

  async createInvite(): Promise<{ invite: string }> {
    const p2p = this.calyptra.p2p;
    await p2p.waitForRelay(); // an invite needs the relay's circuit address
    return { invite: encodeInvite(p2p.invite(await this.getAddress())) };
  }

  getChannels(): ChannelView[] {
    return this.calyptra.channels.list().map((r) => this.channelView(r));
  }

  async openChannel(input: OpenChannelInput): Promise<ChannelView> {
    const network = this.calyptra.network();
    const record = await this.calyptra.channels.open(decodeInvite(input.invite), {
      token: tokenId(input.token, network),
      amount: parseAmount(input.token, input.amount),
      peerAmount: input.peerAmount === undefined ? 0n : parseAmount(input.token, input.peerAmount),
      window: input.window === undefined ? undefined : BigInt(input.window),
      relayer: this.calyptra.relayer(),
    });
    return this.channelView(record);
  }

  async payChannel(input: PayChannelInput): Promise<ChannelView> {
    const channels = this.calyptra.channels;
    const token = tokenName(channels.get(input.channel).token, this.calyptra.network());
    return this.channelView(await channels.pay(input.channel, parseAmount(token, input.amount)));
  }

  async closeChannel(input: ChannelInput): Promise<ChannelView> {
    return this.channelView(await this.calyptra.channels.close(input.channel, this.calyptra.relayer()));
  }

  async cancelChannel(input: ChannelInput): Promise<ChannelView> {
    return this.channelView(await this.calyptra.channels.cancel(input.channel));
  }

  async startDispute(input: ChannelInput): Promise<{ txHash: Hex }> {
    return { txHash: await this.calyptra.disputes.start(input.channel, this.calyptra.relayer()) };
  }

  async tick(): Promise<{ channel: string; error: string }[]> {
    const problems = await this.calyptra.tick();
    return problems.map((p) => ({ channel: p.channelId, error: p.error instanceof Error ? p.error.message : String(p.error) }));
  }

  /** Writes the encrypted export file, readable only by the user. */
  async exportWallet(input: ExportInput): Promise<{ path: string; exportedAt: string }> {
    const content = await this.calyptra.wallet.exportFile();
    await writeFile(input.path, content, { mode: 0o600 });
    return { path: input.path, exportedAt: new Date(this.calyptra.wallet.lastExportAt() ?? Date.now()).toISOString() };
  }

  async getRelayerInfo(): Promise<RelayerInfo> {
    return this.calyptra.relayer().info();
  }

  private view(account: Account): AccountView {
    return {
      id: account.id,
      label: account.label,
      kind: account.kind,
      used: account.used,
      active: account.id === this.calyptra.wallet.activeAccount().id,
      relayer: this.isRelayerAccount(account.id),
    };
  }

  private channelView(r: ChannelRecord): ChannelView {
    const name = tokenName(r.token, this.calyptra.network());
    const me = sideOf(r);
    const state = r.latest.state;
    return {
      id: r.id,
      status: r.status,
      role: r.role === 'A' ? 'opener' : 'invitee',
      balance: formatAmount(name, balanceOf(state, me)),
      peerBalance: formatAmount(name, balanceOf(state, me === 0 ? 1 : 0)),
      closingFee: formatAmount(name, state.closingFee),
      windowSeconds: Number(r.params.window),
      peer: r.peer.peerId,
    };
  }

  private balances(network: NetworkConfig): Balances {
    const balances = this.calyptra.pool.balances();
    return {
      native: formatAmount('native', balances.get(tokenId('native', network)) ?? 0n),
      stablecoin: formatAmount('stablecoin', balances.get(tokenId('stablecoin', network)) ?? 0n),
    };
  }

  private findAccount(id: string): Account {
    const account = this.calyptra.wallet.accounts().find((a) => a.id.toLowerCase() === id.toLowerCase());
    if (!account) throw new AppError(404, 'UNKNOWN_ACCOUNT', `No account ${id} in this wallet`);
    return account;
  }

  private isRelayerAccount(id: string): boolean {
    return this.options.relayerAccountId !== undefined && id.toLowerCase() === this.options.relayerAccountId.toLowerCase();
  }

  /** The first account that is unused, not active and not the relayer account; otherwise a new one. */
  private async freshExitAddress(): Promise<Address> {
    const active = this.calyptra.wallet.activeAccount().id;
    const free = this.calyptra.wallet.accounts().find((a) => !a.used && a.id !== active && !this.isRelayerAccount(a.id));
    return (free ?? (await this.calyptra.wallet.addAccount())).address;
  }
}
