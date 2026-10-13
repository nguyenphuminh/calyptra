// What the website says when something fails. The framework's messages are
// pinned by the desktop client and the framework's tests, so they stay as they are; this one table turns
// each AppError code into the words of the website: private balance, Calyptra ID, tab, network fee,
// privacy relay, message relay, settle. Plain messages pass through; unknown codes and errors that are
// not AppErrors keep their own message, except raw network errors (viem's), which say only their gist.
import { isAppError } from '@calyptra/framework';
import { BaseError } from 'viem';

/**
 * The copy for a code: one text, or one per framework message (with a fallback under `*`); an empty text
 * in such a table keeps the framework's message.
 */
type Copy = string | Readonly<Record<string, string>>;

const TRY_AGAIN = 'Try again in a moment.';
const RELAY_REFUSED = `The privacy relay refused this payment. ${TRY_AGAIN}`;
const NOT_READABLE = 'The other side sent something Calyptra cannot read.';
const PASS = null;

/**
 * Consumer copy by AppError code. `PASS` keeps the framework's message, which is already plain. A code
 * with several framework messages maps each message (exact text) and falls back to `*`.
 */
export const ERROR_COPY: Readonly<Record<string, Copy | typeof PASS>> = {
  // Wallet, passkeys, accounts
  WEAK_PASSWORD: PASS,
  INVALID_PHRASE: PASS,
  INVALID_PRIVATE_KEY: PASS,
  NO_WALLET: PASS,
  WRONG_PASSWORD: PASS,
  WRONG_PASSKEY: PASS,
  UNLOCK_MISMATCH: PASS,
  INVALID_VAULT_KEY: 'This passkey could not unlock the wallet. Try again, or use your recovery phrase.',
  INVALID_WALLET_FILE: 'This is not a Calyptra export file',
  WALLET_LOCKED: PASS,
  NO_ACCOUNT: 'This account is not in your wallet',
  NO_RECOVERY_PHRASE: PASS,
  ACCOUNT_EXISTS: PASS,
  DERIVATION_FAILED: 'Could not create the account. Try again.',
  INVALID_SHIELDED_ADDRESS: {
    'The shielded address has a typo (checksum mismatch)': 'This Calyptra ID has a typo',
    '*': 'This is not a Calyptra ID',
  },
  // Network and chain; the RPC endpoint check happens in Settings › Advanced, where its own words stay.
  RPC_UNREACHABLE: PASS,
  RPC_UNAVAILABLE: 'Calyptra cannot reach the network right now. Try again in a moment, or check Settings › Advanced.',
  WRONG_CHAIN: 'An endpoint in Settings › Advanced answers for another network.',
  NOT_DEPLOYED: 'Calyptra is not available on this network yet.',
  UNKNOWN_NETWORK: 'This network is not available in Calyptra.',
  TRANSACTION_FAILED: `The network refused this. ${TRY_AGAIN}`,
  WOULD_REVERT: 'The network would refuse this, so nothing was sent. Refresh and try again.',
  RESERVE_TOO_LOW: 'The privacy relay cannot pay network fees right now. Try again later.',
  INSUFFICIENT_PUBLIC_FUNDS: PASS,
  CHAIN_STALLED: `The network is slow right now. ${TRY_AGAIN}`,
  AMOUNT_TOO_LARGE: 'The most you can add at once is 18.44 MON',
  SESSION_STOPPED: 'You switched account or network before this finished, so it was not saved.',
  NOT_STARTED: {
    'Start the subscription first': 'Start the session first.',
    '*': 'Unlock your wallet first.',
  },
  // Private balance
  NOT_IN_POOL: `This money has not arrived in your private balance yet. ${TRY_AGAIN}`,
  INVALID_AMOUNT: {
    'The amount must be positive': 'Enter an amount above zero.',
    'The allowance is below this merchant’s minimum': 'The allowance is below this service’s minimum.',
    'The contribution must be larger than the closing fee and fit in a note': 'Put in more than the fee to settle the tab, and at most 18.44 MON.',
    'The proposed amounts are not valid': 'The other side proposed amounts that are not valid.',
    '*': 'This amount is not valid.',
  },
  NOTES_FRAGMENTED: 'Your private balance is split into too many small amounts to pay this at once. Try a smaller amount.',
  INSUFFICIENT_FUNDS: {
    'Not enough shielded funds in this token (including the relayer fee)': 'Not enough in your private balance for this amount plus the network fee',
    'Not enough shielded funds to fund this channel and pay the relayer fee': 'Not enough in your private balance to put this into the tab and pay the network fee',
    'The other party cannot fund its side and pay the relayer fee': 'The other side cannot put in what you asked plus the network fee',
    'Not enough balance in this channel': 'Not enough left in this tab',
    'This side’s balance cannot cover the closing fee': 'Your balance in this tab cannot cover the fee to settle it',
    '*': 'Not enough money for this, including the network fee',
  },
  // Privacy relays: the transaction relayer and its quote
  NO_RELAYER: 'No privacy relay is set up for this network. Add one in Settings › Advanced.',
  FEE_ABOVE_MAX: 'The network fee is higher than the most you accept.',
  TOKEN_NOT_ACCEPTED: 'The privacy relay does not take fees in this currency.',
  RELAYER_UNREACHABLE: `The privacy relay is not reachable right now. ${TRY_AGAIN}`,
  RELAYER_DOWN: `The privacy relay is not reachable right now. ${TRY_AGAIN}`,
  RELAYER_ERROR: RELAY_REFUSED,
  FEE_TOO_LOW: 'The network fee went up. Try again.',
  NO_FEE_NOTE: RELAY_REFUSED,
  FEE_NOTE_MISMATCH: RELAY_REFUSED,
  BAD_CIPHERTEXTS: RELAY_REFUSED,
  FEE_EXCEEDS_CONTRIBUTION: 'The network fee is larger than the amount to take back.',
  // Message relays and the other side
  NO_RELAY: {
    'No libp2p relay is reachable; add one in the network settings': 'No message relay answers right now. Try again, or add one in Settings › Advanced.',
    '*': 'Tabs and subscriptions need a message relay. Add one in Settings › Advanced.',
  },
  PEER_UNREACHABLE: {
    'The other party stopped answering': 'The other side stopped answering.',
    '*': 'The other side is not reachable right now',
  },
  PEER_TIMEOUT: 'The other side did not answer in time.',
  NOT_LISTENING: 'The other side cannot take tabs right now.',
  INTERNAL: 'The other side could not handle this. Try again later.',
  INVALID_INVITE: PASS,
  INVALID_MERCHANT_CARD: 'This is not a valid Calyptra service link',
  // Tabs: opening, paying, settling, cancelling
  OPEN_DECLINED: 'The other side declined this tab',
  PAYMENT_DECLINED: PASS,
  CHANNEL_NOT_FOUND: 'This tab is not in this wallet.',
  CHANNEL_EXISTS: 'This tab already exists.',
  CANCELLED: 'This tab was cancelled.',
  CONFLICT: 'The other side paid at the same moment. Try again.',
  NOT_CANCELLABLE: {
    'Only a channel that is still opening can be cancelled': 'Only a tab that is still starting can be cancelled.',
    'The opener’s contribution is already in the pool, so the channel goes on': 'The money for this tab has already arrived, so the tab goes on.',
    'The other side may still be funding it; it can be cancelled ten minutes after it was accepted': 'The other side may still be paying in. You can cancel ten minutes after the tab was accepted.',
    '*': 'This tab can no longer be cancelled.',
  },
  NOT_CLOSING: {
    'The final state is not signed by both sides': 'Both sides have not agreed on the final balances yet.',
    '*': 'This tab is not settling.',
  },
  NOT_DISPUTABLE: {
    'This channel is already closed': 'This tab is already settled.',
    '*': 'This tab cannot be settled without the other side yet: its money has not arrived.',
  },
  NOT_LIVE: 'This tab is not live yet.',
  NOT_SIGNED: 'Both sides have not agreed on this balance yet.',
  PROPOSAL_REFUSED: 'The other side refused this payment.',
  STALE_STATE: 'The other side has a different latest balance. Refresh and try again.',
  BAD_SIGNATURE: 'The other side’s answer could not be verified.',
  BAD_MESSAGE: NOT_READABLE,
  BAD_REPLY: 'The other side sent an unexpected answer.',
  INVALID_WINDOW: 'This tab’s waiting period for settling without the other side is not allowed.',
  TOKEN_NOT_SUPPORTED: {
    'This service is paid in another token': 'This service is paid in another currency.',
    '*': 'Tabs hold dollars or MON only.',
  },
  // Subscriptions
  SUBSCRIPTION_NOT_FOUND: 'This subscription is not in this wallet.',
  SERVICE_ERROR: PASS,
  // The merchant's own refusal when its upstream service fails (the desktop merchant's AI adapter).
  UPSTREAM_ERROR: `The service is busy or not answering right now. ${TRY_AGAIN}`,
};

/**
 * The website's own errors that would name the proof: the Web Worker prover's (worker-prover.ts), shown
 * by their prefix. The cause stays on the error object.
 */
const PROVER_FAILURES = ['Could not build the proof:', 'The prover stopped:'];
const PROVER_COPY = 'Calyptra could not secure this payment privately. Reload the page and try again.';

/** A raw network error (viem's) names endpoints and transaction data, so only its gist is shown. */
const NO_MON_FOR_FEES = /insufficient (balance|funds)/i;
const networkErrorText = (err: BaseError): string =>
  NO_MON_FOR_FEES.test(err.message) ? 'Your account balance does not have enough MON for the network fee.' : `The network refused this. ${TRY_AGAIN}`;

/** The words the website shows for an error. */
export function friendlyError(err: unknown): string {
  if (isAppError(err)) {
    const copy = ERROR_COPY[err.code];
    if (typeof copy === 'string') return copy;
    if (copy) {
      const text = copy[err.message] ?? copy['*'];
      return text ? text : err.message;
    }
    return err.message;
  }
  if (err instanceof BaseError) return networkErrorText(err);
  if (err instanceof Error) return PROVER_FAILURES.some((prefix) => err.message.startsWith(prefix)) ? PROVER_COPY : err.message;
  return String(err);
}
