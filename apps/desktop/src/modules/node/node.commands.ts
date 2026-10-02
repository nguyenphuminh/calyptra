import { AppError } from '@calyptra/framework';
import type { z } from 'zod';
import {
  channelSchema,
  depositSchema,
  emptySchema,
  exportSchema,
  importAccountSchema,
  openChannelSchema,
  payChannelSchema,
  transferSchema,
  useAccountSchema,
  useNetworkSchema,
  withdrawSchema,
} from './node.schema.ts';
import type { NodeService } from './node.service.ts';

/** One operation, served both over RPC (`POST /rpc/<name>`) and by the interactive shell. */
export interface Command {
  name: string;
  /** Shell positional words, in order; they become the JSON fields of the input. */
  args: readonly string[];
  summary: string;
  schema: z.ZodObject;
  /** Runs with input already parsed by `schema` (see runCommand). */
  run(node: NodeService, input: unknown): Promise<unknown>;
}

function command<S extends z.ZodObject>(spec: {
  name: string;
  args?: readonly string[];
  summary: string;
  schema: S;
  run: (node: NodeService, input: z.output<S>) => unknown;
}): Command {
  return {
    name: spec.name,
    args: spec.args ?? [],
    summary: spec.summary,
    schema: spec.schema,
    run: async (node, input) => spec.run(node, input as z.output<S>),
  };
}

export const COMMANDS: readonly Command[] = [
  command({ name: 'status', summary: 'Active account, network, shielded address and balance', schema: emptySchema, run: (n) => n.getStatus() }),
  command({ name: 'accounts', summary: "List the wallet's accounts", schema: emptySchema, run: (n) => n.getAccounts() }),
  command({ name: 'account.add', summary: 'Derive the next account from the recovery phrase', schema: emptySchema, run: (n) => n.createAccount() }),
  command({ name: 'account.import', args: ['privateKey'], summary: 'Add an account from a private key', schema: importAccountSchema, run: (n, i) => n.importAccount(i) }),
  command({ name: 'account.use', args: ['account'], summary: 'Switch the active account', schema: useAccountSchema, run: (n, i) => n.useAccount(i) }),
  command({ name: 'networks', summary: 'List the networks', schema: emptySchema, run: (n) => n.getNetworks() }),
  command({ name: 'network.use', args: ['network'], summary: 'Switch network', schema: useNetworkSchema, run: (n, i) => n.useNetwork(i) }),
  command({ name: 'public.balance', summary: 'Public native coin and stablecoin of the active account', schema: emptySchema, run: (n) => n.getPublicBalance() }),
  command({ name: 'address', summary: 'Shielded address to get paid privately', schema: emptySchema, run: (n) => n.getAddress() }),
  command({ name: 'balance', summary: 'Sync and show the shielded balance', schema: emptySchema, run: (n) => n.getBalance() }),
  command({ name: 'notes', summary: 'Unspent notes', schema: emptySchema, run: (n) => n.getNotes() }),
  command({ name: 'deposit', args: ['token', 'amount'], summary: 'Move public funds into the pool', schema: depositSchema, run: (n, i) => n.deposit(i) }),
  command({ name: 'transfer', args: ['to', 'token', 'amount'], summary: 'Pay a shielded address privately', schema: transferSchema, run: (n, i) => n.transfer(i) }),
  command({
    name: 'withdraw',
    args: ['token', 'amount', 'to'],
    summary: 'Take funds out of the pool (default: to a new account)',
    schema: withdrawSchema,
    run: (n, i) => n.withdraw(i),
  }),
  command({ name: 'invite', summary: 'Create an invite for a channel', schema: emptySchema, run: (n) => n.createInvite() }),
  command({ name: 'channels', summary: 'List channels', schema: emptySchema, run: (n) => n.getChannels() }),
  command({
    name: 'channel.open',
    args: ['invite', 'token', 'amount', 'peerAmount', 'window'],
    summary: 'Open and fund a channel with an invite',
    schema: openChannelSchema,
    run: (n, i) => n.openChannel(i),
  }),
  command({ name: 'channel.pay', args: ['channel', 'amount'], summary: 'Pay in a channel', schema: payChannelSchema, run: (n, i) => n.payChannel(i) }),
  command({ name: 'channel.close', args: ['channel'], summary: 'Close a channel cooperatively', schema: channelSchema, run: (n, i) => n.closeChannel(i) }),
  command({ name: 'channel.cancel', args: ['channel'], summary: 'Cancel an opening nobody funded', schema: channelSchema, run: (n, i) => n.cancelChannel(i) }),
  command({ name: 'dispute.start', args: ['channel'], summary: 'Close a channel unilaterally', schema: channelSchema, run: (n, i) => n.startDispute(i) }),
  command({ name: 'tick', summary: 'Sync and move channels and disputes forward now', schema: emptySchema, run: (n) => n.tick() }),
  command({ name: 'export', args: ['path'], summary: 'Write the encrypted export file', schema: exportSchema, run: (n, i) => n.exportWallet(i) }),
  command({ name: 'relayer.info', summary: 'The transaction relayer this node uses and its fees', schema: emptySchema, run: (n) => n.getRelayerInfo() }),
];

export function findCommand(name: string): Command {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new AppError(404, 'UNKNOWN_COMMAND', `Unknown command "${name}"`);
  return found;
}

/** Validates the input with the command's schema (ZodError -> INVALID_INPUT), then runs it. */
export function runCommand(node: NodeService, name: string, input: unknown): Promise<unknown> {
  const found = findCommand(name);
  return found.run(node, found.schema.parse(input));
}
