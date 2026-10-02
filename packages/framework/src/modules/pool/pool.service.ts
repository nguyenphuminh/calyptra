import { concatHex, hexToBytes, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import {
  MAX_AMOUNT, MerkleTree, decryptNote, dummyInput, encryptNote, extDataHashOf, noteCommitment, noteInner, nullifierOf,
  randomFieldElement, transferWitness, type MerkleProof, type NotePreimage, type SpendInput,
} from '../../shared/protocol/index.ts';
import { tokenAddress, type ChainAdapter, type CommitmentEvent } from '../chain/index.ts';
import { channelSecrets, decodeShieldedAddress, type KeyRing, type PoolKeys } from '../keys/index.ts';
import type { RelayerPort } from '../relayer/index.ts';
import type { WalletService } from '../wallet/index.ts';
import type { PoolRepository } from './pool.repository.ts';
import type { StoredNote } from './pool.schema.ts';

/** How many merges a payment may need before giving up (each merge = one relayed transfer). */
const MAX_MERGES = 20;

export interface PoolDeps { wallet: WalletService; keys: KeyRing; chain: ChainAdapter; prover: ProverPort; repository: PoolRepository }
export interface SpendableNote extends StoredNote { unlockSecret: bigint }

/** What unlocks a stored note: the account's spending secret, or the tag secret of one of its channels. */
export type NoteSecret = StoredNote['secret'];

export interface SpendArgs {
  token: bigint;
  payment?: { note: NotePreimage; encryptTo: Uint8Array };   // absent for a plain withdrawal
  publicAmount: bigint;                                       // amount leaving the pool (0 for transfers)
  recipient: Address;                                         // zero address unless withdrawing
  relayer: RelayerPort;
  accountId?: string;
}

const fragmented = (): AppError => new AppError(409, 'NOTES_FRAGMENTED', 'Too many small notes to cover this amount');

/** A decrypted note counts only if it re-hashes to the on-chain commitment (a sender cannot lie in the ciphertext). */
function matches(note: NotePreimage, commitment: bigint): boolean {
  try { return noteCommitment(note) === commitment; } catch { return false; }
}

function secretOf(note: StoredNote, keys: PoolKeys): bigint {
  return note.secret === 'spending' ? keys.spendingSecret : channelSecrets(keys, note.secret.channel).tagSecret;
}

/** Picks one note, else the cheapest pair of notes, that covers `need` (transfers have two inputs). */
export function selectInputs(notes: readonly SpendableNote[], need: bigint): SpendableNote[] | 'fragmented' | 'insufficient' {
  const total = notes.reduce((s, n) => s + n.amount, 0n);
  if (total < need) return 'insufficient';
  const ascending = [...notes].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  const single = ascending.find((n) => n.amount >= need);
  if (single) return [single];
  let best: [SpendableNote, SpendableNote] | null = null;
  for (let i = 0; i < ascending.length; i++) {
    for (let j = i + 1; j < ascending.length; j++) {
      const a = ascending[i] as SpendableNote;
      const b = ascending[j] as SpendableNote;
      if (a.amount + b.amount >= need && (!best || a.amount + b.amount < best[0].amount + best[1].amount)) best = [a, b];
    }
  }
  return best ?? 'fragmented';
}

/**
 * The shielded-pool client: mirrors the pool's commitment tree and nullifier set (in memory, per session),
 * discovers the account's notes by trial decryption, and builds, proves and relays deposits, private
 * transfers and withdrawals. Spends run one at a time.
 */
export class PoolService {
  private readonly deps: PoolDeps;
  private tree = new MerkleTree();               // depth 20, Poseidon2, mirrors the on-chain tree
  private events: CommitmentEvent[] = [];        // every NewCommitment since deployBlock, by leaf index
  private nullifiers = new Set<bigint>();        // every NewNullifier since deployBlock
  private scannedTo = -1n;                       // last block mirrored
  private spending: Promise<unknown> = Promise.resolve();   // spend serialization chain

  constructor(deps: PoolDeps) {
    this.deps = deps;
  }

  // --- mirroring the chain ----------------------------------------------------------------------

  /** Downloads every pool event since the last refresh; a gap in leaf indices rebuilds the mirror. */
  async refreshChain(): Promise<void> {
    const { deployBlock } = this.deps.chain.contracts();
    const from = this.scannedTo < deployBlock ? deployBlock : this.scannedTo + 1n;
    const { toBlock: latest, commitments, nullifiers } = await this.deps.chain.poolEvents(from);
    if (from > latest) return;
    for (const event of commitments) {
      if (event.leafIndex !== this.tree.size) {
        // The mirror is out of step (RPC hiccup, or two refreshes raced): rebuild from scratch.
        this.tree = new MerkleTree();
        this.events = [];
        this.nullifiers = new Set();
        this.scannedTo = -1n;
        return this.refreshChain();
      }
      this.tree.insert(event.commitment);
      this.events.push(event);
    }
    for (const n of nullifiers) this.nullifiers.add(n);
    this.scannedTo = latest;
  }

  get root(): bigint {
    return this.tree.root;
  }

  proofOf(commitment: bigint): MerkleProof {
    const index = this.tree.indexOf(commitment);
    if (index < 0) throw new AppError(409, 'NOT_IN_POOL', 'This note is not in the pool yet');
    return this.tree.proof(index);
  }

  /** Leaf index 0 with a zero path, for dummy inputs. */
  emptyProof(): MerkleProof {
    return this.tree.emptyProof();
  }

  hasCommitment(commitment: bigint): boolean {
    return this.tree.indexOf(commitment) >= 0;
  }

  isSpent(nullifier: bigint): boolean {
    return this.nullifiers.has(nullifier);
  }

  // --- note discovery ---------------------------------------------------------------------------

  /** Trial-decrypts every new pool event for the account and marks its spent notes. */
  async sync(accountId?: string): Promise<void> {
    const { wallet, keys: keyring, chain, repository } = this.deps;
    const account = accountId ?? wallet.activeAccount().id;      // fixed once: the user may switch account meanwhile
    await this.refreshChain();
    const keys = await keyring.poolKeys(account);
    const channelTags = await keyring.channelTags(account, chain.network.id);
    const section = repository.load(account);
    const known = new Set(section.notes.map((n) => n.commitment));
    for (const event of this.events) {
      if (event.blockNumber <= section.syncedBlock || known.has(event.commitment)) continue;
      const note = decryptNote(keys.encryption, hexToBytes(event.ciphertext));   // null if not for us
      if (!note || note.amount === 0n || !matches(note, event.commitment)) continue;
      const channel = channelTags.get(note.ownerTag);
      const secret: NoteSecret | null = note.ownerTag === keys.ownerTag ? 'spending' : channel !== undefined ? { channel } : null;
      if (!secret) continue;   // e.g. our own channel contribution (owned by a channel tag): tracked by the channel module
      section.notes.push({ ...note, commitment: event.commitment, leafIndex: event.leafIndex, secret, spent: false });
      known.add(event.commitment);
    }
    this.markSpent(section.notes, keys);
    section.syncedBlock = this.scannedTo;
    await repository.save(section, account);
  }

  private markSpent(notes: StoredNote[], keys: PoolKeys): void {
    for (const n of notes) if (!n.spent && this.nullifiers.has(nullifierOf(secretOf(n, keys), n.commitment))) n.spent = true;
  }

  // --- notes, balances, adoption ----------------------------------------------------------------

  notes(accountId?: string): StoredNote[] {
    return this.deps.repository.load(accountId).notes;
  }

  /** Unspent amount per token (no sync: call after sync/tick). */
  balances(accountId?: string): Map<bigint, bigint> {
    const out = new Map<bigint, bigint>();
    for (const n of this.notes(accountId)) if (!n.spent) out.set(n.token, (out.get(n.token) ?? 0n) + n.amount);
    return out;
  }

  async spendable(token: bigint, accountId?: string): Promise<SpendableNote[]> {
    const keys = await this.deps.keys.poolKeys(accountId);
    return this.notes(accountId)
      .filter((n) => !n.spent && n.token === token)
      .map((n) => ({ ...n, unlockSecret: secretOf(n, keys) }));
  }

  /** Records a note the account can rebuild without decrypting anything (a channel payout), once it is in the pool. */
  async adopt(note: NotePreimage, secret: NoteSecret, accountId?: string): Promise<boolean> {
    const commitment = noteCommitment(note);
    if (note.amount === 0n || !this.hasCommitment(commitment)) return false;
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    const keys = await this.deps.keys.poolKeys(account);
    const section = this.deps.repository.load(account);
    if (section.notes.some((n) => n.commitment === commitment)) return true;
    section.notes.push({
      amount: note.amount, token: note.token, ownerTag: note.ownerTag, salt: note.salt,
      commitment, leafIndex: this.tree.indexOf(commitment), secret, spent: false,
    });
    this.markSpent(section.notes, keys);
    await this.deps.repository.save(section, account);
    return true;
  }

  // --- deposit ----------------------------------------------------------------------------------

  /** Adds money from the account's public address (the only pool operation it pays for itself). */
  async deposit(token: bigint, amount: bigint, accountId?: string): Promise<Hex> {
    // Notes hold 64-bit amounts: at most 2^64 - 1 wei of the native coin (§11.2).
    if (token === 0n && amount > MAX_AMOUNT) throw new AppError(400, 'AMOUNT_TOO_LARGE', 'The most you can add at once is 18.44 MON');
    const { wallet, keys: keyring, chain } = this.deps;
    const account = accountId ?? wallet.activeAccount().id;
    const keys = await keyring.poolKeys(account);
    const note = { amount, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    const ciphertext = toHex(encryptNote(keys.encryption.publicKey, note));                // to self
    const txHash = await chain.deposit(wallet.signer(account), token, amount, noteInner(note.ownerTag, note.salt), ciphertext);
    await wallet.markUsed(account);          // the account is now linked to the pool
    await this.sync(account);                // discovers the new note
    return txHash;
  }

  // --- private transfer and withdrawal ----------------------------------------------------------

  /** Pays `amount` of `token` to a shielded address inside the pool. */
  async transfer(to: string, token: bigint, amount: bigint, relayer: RelayerPort, accountId?: string): Promise<Hex> {
    const payee = decodeShieldedAddress(to);
    const payment = { amount, token, ownerTag: payee.ownerTag, salt: randomFieldElement() };
    return this.spend({ token, payment: { note: payment, encryptTo: payee.encryptionPublicKey }, publicAmount: 0n, recipient: zeroAddress, relayer, accountId });
  }

  /** Takes `amount` of `token` out of the pool to `recipient` (ideally a fresh address). */
  async withdraw(token: bigint, amount: bigint, recipient: Address, relayer: RelayerPort, accountId?: string): Promise<Hex> {
    if (amount <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be positive');
    return this.spend({ token, publicAmount: amount, recipient, relayer, accountId });
  }

  /** Spends run one after another: two at once could pick the same notes. Channel funding uses it too. */
  spend(args: SpendArgs): Promise<Hex> {
    const run = this.spending.then(() => this.spendNow(args));
    this.spending = run.catch(() => undefined);    // a failed spend does not block the next
    return run;
  }

  /** Builds, proves and relays one transfer with outputs [payment or change, change or empty, fee note]. */
  private async spendNow(args: SpendArgs): Promise<Hex> {
    const { wallet, keys: keyring, prover } = this.deps;
    const { token, payment, publicAmount, recipient, relayer } = args;
    const accountId = args.accountId ?? wallet.activeAccount().id;
    await this.sync(accountId);
    const keys = await keyring.poolKeys(accountId);
    const info = await relayer.info();
    const fee = BigInt(info.fees[tokenAddress(token).toLowerCase()] ?? NaN);   // RangeError if the relayer has no quote for this token
    const relayerAddress = decodeShieldedAddress(info.shieldedAddress);
    const need = (payment?.note.amount ?? 0n) + publicAmount + fee;

    let inputs = selectInputs(await this.spendable(token, accountId), need);
    for (let merges = 0; inputs === 'fragmented'; merges++) {
      if (merges === MAX_MERGES) throw fragmented();
      await this.mergeTwoLargest(token, fee, relayer, keys, accountId);
      inputs = selectInputs(await this.spendable(token, accountId), need);
    }
    if (inputs === 'insufficient') {
      throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough shielded funds in this token (including the relayer fee)');
    }

    const total = inputs.reduce((s, n) => s + n.amount, 0n);
    const change = { amount: total - need, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    const empty = { amount: 0n, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    const feeNote = { amount: fee, token, ownerTag: relayerAddress.ownerTag, salt: randomFieldElement() };
    const outputs: [NotePreimage, NotePreimage, NotePreimage] = payment ? [payment.note, change, feeNote] : [change, empty, feeNote];
    const ciphertexts: [Hex, Hex, Hex] = [
      toHex(encryptNote(payment ? payment.encryptTo : keys.encryption.publicKey, outputs[0])),
      toHex(encryptNote(keys.encryption.publicKey, outputs[1])),
      toHex(encryptNote(relayerAddress.encryptionPublicKey, feeNote)),
    ];
    const spendInputs: SpendInput[] = inputs.map((n) => ({
      note: n, unlock: { kind: 'personal', secret: n.unlockSecret }, proof: this.tree.proof(n.leafIndex),
    }));
    const witness = transferWitness({
      root: this.tree.root,
      token,
      inputs: [spendInputs[0] as SpendInput, spendInputs[1] ?? dummyInput(token)],   // dummy: amount 0, random secret, zero path
      outputs,
      publicAmount,
      extDataHash: extDataHashOf({ recipient, ciphertexts }),
    });
    const { proof, signals } = await prover.prove('transfer', witness.input);
    const { txHash } = await relayer.submit({
      kind: 'transact',
      proof: proof.map(String),            // 8 decimal strings (EVM order)
      signals: signals.map(String),        // 9 decimal strings
      recipient,
      ciphertexts: concatHex(ciphertexts), // 3 x 168 bytes
    });
    await this.sync(accountId);            // the relayer returns after the tx is mined: mark inputs spent, find change
    return txHash as Hex;
  }

  /** Combines the two largest notes of a token into one (a private transfer to oneself). */
  private async mergeTwoLargest(token: bigint, fee: bigint, relayer: RelayerPort, keys: PoolKeys, accountId?: string): Promise<void> {
    const notes = (await this.spendable(token, accountId)).sort((a, b) => (a.amount > b.amount ? -1 : 1)).slice(0, 2);
    const total = notes.reduce((s, n) => s + n.amount, 0n);
    if (notes.length < 2 || total <= fee) throw fragmented();
    const self = { amount: total - fee, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    // spendNow directly: this already runs inside the spend chain (spend() would deadlock).
    await this.spendNow({ token, payment: { note: self, encryptTo: keys.encryption.publicKey }, publicAmount: 0n, recipient: zeroAddress, relayer, accountId });
  }
}
