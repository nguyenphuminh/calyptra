import { z } from 'zod';

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>;

export const AccountSchema = z.object({
  id: z.string(),                                  // = the checksummed address
  label: z.string(),                               // "Account N" (derived) or "Imported N"
  kind: z.enum(['derived', 'imported']),
  /** Derivation index under m/44'/60'/0'/0 for derived accounts. */
  index: z.number().int().nonnegative().optional(),
  /** Only imported accounts keep their key; derived ones are re-derived from the phrase. */
  privateKey: hex.optional(),
  address,
  /** Never handed out as a fresh exit address once used. */
  used: z.boolean(),
});

/** Everything the wallet holds; stored only inside the encrypted envelope. */
export const WalletDocumentSchema = z.object({
  version: z.literal(1),
  mnemonic: z.string().nullable(),                 // normalized phrase, or null for key-only wallets
  accounts: z.array(AccountSchema).min(1),
  activeAccountId: z.string(),
  networkId: z.string(),                           // the selected network
  lastExportAt: z.number().nullable(),             // ms since epoch of the last export
  /** Per account and network data owned by other modules, keyed `${accountId}/${networkId}/${section}`. */
  sections: z.record(z.string(), z.unknown()),
});

const envelopeHeader = { format: z.literal('calyptra-wallet'), version: z.literal(1) };

/** A vault opened with a password: the key comes from scrypt over the password (baseline). Envelopes
 *  written before the passkey unlock existed carry no `unlock` field and are password vaults. */
const PasswordEnvelopeSchema = z.object({
  ...envelopeHeader,
  unlock: z.literal('password').default('password'),
  kdf: z.object({ name: z.literal('scrypt'), N: z.number().int(), r: z.number().int(), p: z.number().int(), salt: hex }),
  nonce: hex,
  ciphertext: hex,
});

/** A vault opened with a passkey (§11.4): the 32-byte key is derived from the passkey's PRF output. */
const PasskeyEnvelopeSchema = z.object({
  ...envelopeHeader,
  unlock: z.literal('passkey'),
  nonce: hex,
  ciphertext: hex,
});

/** The encrypted vault: stored by hosts and handed out as the export file. */
export const EnvelopeSchema = z.union([PasswordEnvelopeSchema, PasskeyEnvelopeSchema]);

export type Account = z.infer<typeof AccountSchema>;
export type WalletDocument = z.infer<typeof WalletDocumentSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
