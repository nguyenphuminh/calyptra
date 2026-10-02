import { z } from 'zod';
import { TOKEN_NAMES } from '../../shared/utils/amounts.ts';

const token = z.enum(TOKEN_NAMES);
/** Amounts travel as decimal strings in the token's units; a JSON number is refused. */
const amount = z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal amount such as 0.01');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');

export const emptySchema = z.object({});
export const useAccountSchema = z.object({ account: z.string().min(1) });
export const importAccountSchema = z.object({ privateKey: z.string().min(1) });
export const useNetworkSchema = z.object({ network: z.string().min(1) });
export const depositSchema = z.object({ token, amount });
export const transferSchema = z.object({ to: z.string().min(1), token, amount });
export const withdrawSchema = z.object({ token, amount, to: address.optional() });
export const openChannelSchema = z.object({
  invite: z.string().min(1),
  token,
  amount,
  peerAmount: amount.optional(),
  /** Dispute window in seconds. */
  window: z.coerce.number().int().positive().optional(),
});
export const payChannelSchema = z.object({ channel: z.string().min(1), amount });
export const channelSchema = z.object({ channel: z.string().min(1) });
export const exportSchema = z.object({ path: z.string().min(1) });

export type UseAccountInput = z.output<typeof useAccountSchema>;
export type ImportAccountInput = z.output<typeof importAccountSchema>;
export type UseNetworkInput = z.output<typeof useNetworkSchema>;
export type DepositInput = z.output<typeof depositSchema>;
export type TransferInput = z.output<typeof transferSchema>;
export type WithdrawInput = z.output<typeof withdrawSchema>;
export type OpenChannelInput = z.output<typeof openChannelSchema>;
export type PayChannelInput = z.output<typeof payChannelSchema>;
export type ChannelInput = z.output<typeof channelSchema>;
export type ExportInput = z.output<typeof exportSchema>;
