import { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';

export const InviteSchema = z.object({
  v: z.literal(1),
  peerId: z.string(),
  /** Relay circuit addresses only, never the inviter's own IP. */
  addrs: z.array(z.string().includes('/p2p-circuit')).min(1),
  shieldedAddress: z.string(),
});
export type Invite = z.infer<typeof InviteSchema>;

const toBase64Url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const fromBase64Url = (code: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(code.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)));

export function encodeInvite(invite: Invite): string {
  return toBase64Url(JSON.stringify(InviteSchema.parse(invite))); // throws ZodError if e.g. addrs is empty
}

/** Accepts the bare code or a full invite link (...#/invite/<code>), which is also what the QR code holds. */
export function decodeInvite(text: string): Invite {
  const code = text.trim().split('/invite/').pop() ?? '';
  try {
    return InviteSchema.parse(JSON.parse(fromBase64Url(code)));
  } catch {
    throw new AppError(400, 'INVALID_INVITE', 'This is not a valid Calyptra invite');
  }
}

export const inviteLink = (origin: string, invite: Invite): string => `${origin.replace(/\/+$/, '')}/#/invite/${encodeInvite(invite)}`;
