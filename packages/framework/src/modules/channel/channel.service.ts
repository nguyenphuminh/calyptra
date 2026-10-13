import { bytesToHex, concatHex, zeroAddress } from 'viem';
import type { z } from 'zod';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import {
  FIELD_SIZE,
  MAX_AMOUNT,
  channelNullifierOf,
  channelPublicKeyOf,
  extDataHashOf,
  hash2,
  noteCommitment,
  nullifierOf,
  ownerTagOf,
  randomFieldElement,
  signStateHash,
  transferWitness,
  type ChannelState,
  type StateSignature,
} from '../../shared/protocol/index.ts';
import type { ChainAdapter } from '../chain/index.ts';
import { channelSecrets, decodeShieldedAddress, type KeyRing } from '../keys/index.ts';
import type { Invite, P2PService } from '../p2p/index.ts';
import type { PoolService } from '../pool/index.ts';
import { quotedFee, type RelayerPort } from '../relayer/index.ts';
import type { WalletService } from '../wallet/index.ts';
import type { ChannelRepository } from './channel.repository.ts';
import {
  ChannelMessageSchema,
  ConfirmReplySchema,
  OpenReplySchema,
  ProposeReplySchema,
  type ChannelRecord,
  type ConfirmMessage,
  type OpenMessage,
  type ProposeMessage,
  type SignedRecordState,
} from './channel.schema.ts';
import {
  MAX_NONCE,
  balanceOf,
  contributionCommitments,
  contributionNote,
  contributionsOf,
  hashOf,
  historyEntry,
  holdsState,
  nonceStep,
  openingState,
  payoutNote,
  publicKeyOf,
  settlement,
  sideOf,
  signedBy,
  stateFromEntry,
  successorProblem,
  winsTieBreak,
  type Side,
} from './channel.state.ts';

/** The invitee may cancel an opening only ten minutes after accepting it (the opener may still be funding). */
export const INVITEE_CANCEL_AFTER_MS = 10 * 60_000;
/** Re-proposals after losing a tie-break. */
const PROPOSE_ATTEMPTS = 5;
/** How long to wait for the winning state after CONFLICT. */
const CONFLICT_WAIT_MS = 15_000;
const CONFLICT_POLL_MS = 100;
const FINAL_REFUSALS = new Set(['PROPOSAL_REFUSED', 'STALE_STATE', 'BAD_SIGNATURE', 'BAD_MESSAGE', 'NOT_LIVE', 'CHANNEL_NOT_FOUND']);

export interface ChannelDeps {
  wallet: WalletService;
  keys: KeyRing;
  chain: ChainAdapter;
  pool: PoolService;
  prover: ProverPort;
  p2p: P2PService;
  repository: ChannelRepository;
  /** The relayer this side funds through: its fee counts when checking that this side can fund. */
  relayer: () => RelayerPort;
  /** Decides on channels peers propose. Without it, channels this side does not fund are accepted
   *  (it shared its invite for that) and channels that need its money are refused. */
  approveOpen?: (request: OpenRequest) => Promise<boolean>;
  /** Called once this side has joined a channel the other side proposed and saved it, before funding. */
  onJoined?: (channelId: string) => void;
  /** Asked before every outgoing payment; without it payments are signed automatically. */
  confirmPayment?: (payment: { channelId: string; token: bigint; amount: bigint }) => Promise<boolean>;
  /** Dispute window of new channels in seconds (default: the longest the contract accepts, 7 days). */
  window?: bigint;
}

/** What the host's `approveOpen` sees. */
export interface OpenRequest {
  channelId: string;
  peerId: string;
  token: bigint;
  /** What the opener funds. */
  amount: bigint;
  /** What the opener asks this side to fund. */
  peerAmount: bigint;
  window: bigint;
  closingFee: bigint;
}

export interface OpenOptions {
  token: bigint;
  amount: bigint;
  /** Default 0. */
  peerAmount?: bigint;
  /** Default `deps.window`, else the contract's maximum. */
  window?: bigint;
  relayer: RelayerPort;
  accountId?: string;
  /** After the other side accepted and the record is saved, before funding. */
  onAccepted?: (channelId: string) => void;
}

export interface TickProblem {
  channelId: string;
  error: unknown;
}

function parseReply<S extends z.ZodType>(schema: S, reply: unknown): z.output<S> {
  const parsed = schema.safeParse(reply);
  if (!parsed.success) throw new AppError(502, 'BAD_REPLY', 'The other party sent a malformed answer');
  return parsed.data;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Two-party payment channels inside the pool: opening, off-chain payments, cooperative close, cancellation, background progress. */
export class ChannelService {
  private readonly deps: ChannelDeps;
  /** One promise chain per channel id: every mutation of a record runs inside it. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: ChannelDeps) {
    this.deps = deps;
  }

  async listen(): Promise<void> {
    await this.deps.p2p.listen((from, message) => this.handle(from, message));
  }

  list(accountId?: string): ChannelRecord[] {
    return this.deps.repository.all(accountId);
  }

  get(id: string, accountId?: string): ChannelRecord {
    const record = this.deps.repository.get(id, accountId);
    if (!record) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'No such channel');
    return record;
  }

  /** Locked load-change-save; the record is saved even when `change` throws (partial changes persist). */
  update<T>(id: string, change: (r: ChannelRecord) => T | Promise<T>, accountId?: string): Promise<T> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    return this.locked(id, async () => {
      const record = this.get(id, account);
      try {
        return await change(record);
      } finally {
        await this.deps.repository.save(record, account);
      }
    });
  }

  // ---------------------------------------------------------------- opening (this side = A)

  async open(invite: Invite, o: OpenOptions): Promise<ChannelRecord> {
    const { wallet, keys, chain, pool, p2p, repository } = this.deps;
    const account = o.accountId ?? wallet.activeAccount().id;
    const peerAmount = o.peerAmount ?? 0n;
    const window = await this.checkWindow(o.window ?? this.deps.window);
    this.checkToken(o.token);
    const closingFee = quotedFee(await o.relayer.info(), o.token);
    if (o.amount <= closingFee || o.amount > MAX_AMOUNT || peerAmount < 0n || peerAmount > MAX_AMOUNT) {
      throw new AppError(400, 'INVALID_AMOUNT', 'The contribution must be larger than the closing fee and fit in a note');
    }
    // Funding is a transfer of its own and pays the relayer the same quote.
    await pool.sync(account);
    if ((pool.balances(account).get(o.token) ?? 0n) < o.amount + closingFee) {
      throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough shielded funds to fund this channel and pay the relayer fee');
    }

    const poolKeys = await keys.poolKeys(account);
    const { index, secrets } = await keys.newChannel(account, chain.network.id);
    const pkA = channelPublicKeyOf(secrets.signingKey);
    const tagA = ownerTagOf(secrets.tagSecret);
    const shareA = randomFieldElement();
    const contribA = { amount: o.amount, salt: randomFieldElement() };
    const nonce0 = nonceStep();
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
    const encPubA = bytesToHex(poolKeys.encryption.publicKey);
    // A must hold a relay reservation: B answers and later pays through these addresses.
    const addrsA = await p2p.waitForRelay();

    const message = {
      type: 'open', channelId: id, token: o.token, amountA: o.amount, amountB: peerAmount, window, closingFee, nonce0,
      shareA, pkA, tagA, encPubA, contribA, addrsA,
    };
    const reply = parseReply(OpenReplySchema, await p2p.request(invite, message));
    if (reply.contribB ? reply.contribB.amount !== peerAmount : peerAmount !== 0n) {
      throw new AppError(502, 'BAD_REPLY', 'The other party answered with a different contribution');
    }

    const params = { pkA, pkB: reply.pkB, channelSecret: hash2(shareA, reply.shareB), window };
    const cA = noteCommitment(contributionNote(params, o.token, contribA, tagA));
    const terms = { amountA: o.amount, tagA, tagB: reply.tagB, closingFee };
    const s0 = openingState({ ...terms, contribs: [cA, 0n], amountB: 0n, nonce: nonce0 });
    const record: ChannelRecord = {
      id, role: 'A', index, peer: { peerId: invite.peerId, addrs: invite.addrs }, token: o.token, status: 'opening', params,
      encPubA, encPubB: reply.encPubB, contribA, contribB: reply.contribB,
      state0: { state: s0, sigA: null, sigB: reply.sigB0 },
      latest: { state: s0, sigA: null, sigB: reply.sigB0 },
      pending: null, history: [], closeTx: null, createdAt: Date.now(),
    };
    if (!signedBy(record, 1, s0, reply.sigB0)) throw new AppError(502, 'BAD_SIGNATURE', 'The other party did not sign state 0');
    const sigA0 = signStateHash(secrets.signingKey, hashOf(record, s0));
    record.state0.sigA = sigA0;
    record.latest.sigA = sigA0;
    if (reply.contribB) {
      const cB = noteCommitment(contributionNote(params, o.token, reply.contribB, reply.tagB));
      const s1 = openingState({ ...terms, contribs: [cA, cB], amountB: peerAmount, nonce: nonce0 + nonceStep() });
      record.pending = { prevHash: hashOf(record, s0), state: s1, sig: signStateHash(secrets.signingKey, hashOf(record, s1)) };
    }
    await repository.save(record, account);
    o.onAccepted?.(id);

    // A funds only now that she holds state 0 signed by both sides: an ordinary private transfer whose
    // first output is the contribution note, encrypted to A's own key.
    const [contribution] = contributionsOf(record);
    await pool.spend({
      token: o.token, payment: { note: contribution, encryptTo: poolKeys.encryption.publicKey },
      publicAmount: 0n, recipient: zeroAddress, relayer: o.relayer, accountId: account,
    });
    // If B is unreachable now, the channel stays `opening` and tick() sends the confirmation later.
    await this.confirmOpening(id, account).catch(() => undefined);
    return this.get(id, account);
  }

  /** Whether the opener's contribution is in the pool (as of the last sync). */
  openerFunded(id: string, accountId?: string): boolean {
    return this.deps.pool.hasCommitment(contributionCommitments(this.get(id, accountId))[0]);
  }

  canCancel(id: string, accountId?: string): boolean {
    return this.cancelProblem(this.get(id, accountId)) === null;
  }

  /** Cancels an opening nobody funded; the other side is told (best effort). */
  async cancel(id: string, accountId?: string): Promise<ChannelRecord> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    await this.deps.pool.refreshChain();
    const record = await this.update(id, (r) => {
      const problem = this.cancelProblem(r);
      if (problem) throw new AppError(409, 'NOT_CANCELLABLE', problem);
      r.status = 'cancelled';
      return r;
    }, account);
    await this.deps.p2p.request(record.peer, { type: 'cancel', channelId: id }).catch(() => undefined);
    return this.get(id, account);
  }

  // ---------------------------------------------------------------- payments and close

  async pay(id: string, amount: bigint, accountId?: string): Promise<ChannelRecord> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    if (amount <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be positive');
    const { token } = this.get(id, account);
    if (this.deps.confirmPayment && !(await this.deps.confirmPayment({ channelId: id, token, amount }))) {
      throw new AppError(403, 'PAYMENT_DECLINED', 'The payment was not confirmed');
    }
    return this.propose(id, (r) => {
      const s = r.latest.state;
      const me = sideOf(r);
      if (balanceOf(s, me) < amount) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough balance in this channel');
      const sign = me === 0 ? -1n : 1n;
      return { ...s, balA: s.balA + sign * amount, balB: s.balB - sign * amount, nonce: s.nonce + nonceStep(), final: false };
    }, account);
  }

  /** Agrees a final state (if not already) and submits the cooperative close through `relayer`. */
  async close(id: string, relayer: RelayerPort, accountId?: string): Promise<ChannelRecord> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    const { token, latest } = this.get(id, account);
    if (!latest.state.final) {
      // The relayer's current quote becomes the closing fee; the proposer absorbs any change of the fee.
      const fee = quotedFee(await relayer.info(), token);
      await this.propose(id, (r) => {
        const s = r.latest.state;
        const me = sideOf(r);
        const mine = balanceOf(s, me) + s.closingFee - fee;
        if (mine < 0n) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'This side’s balance cannot cover the closing fee');
        return { ...s, balA: me === 0 ? mine : s.balA, balB: me === 1 ? mine : s.balB, closingFee: fee, nonce: s.nonce + nonceStep(), final: true };
      }, account);
    }
    await this.update(id, async (r) => {
      if (r.status !== 'closing') throw new AppError(409, 'NOT_CLOSING', 'The channel is not closing');
      await this.submitClose(r, relayer, account);
    }, account);
    return this.get(id, account);
  }

  // ---------------------------------------------------------------- background progress

  async tick(relayer: RelayerPort, accountId?: string): Promise<TickProblem[]> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    const { pool } = this.deps;
    const problems: TickProblem[] = [];
    await pool.refreshChain();
    for (const { id, status, role } of this.list(account)) {
      try {
        if (status === 'opening' && role === 'A') {
          // Retry the confirmation once A's contribution is in the pool.
          if (pool.hasCommitment(contributionCommitments(this.get(id, account))[0])) await this.confirmOpening(id, account);
        } else if (status === 'cancelled' && role === 'A') {
          // Late funding: the money is in the channel, so it goes on.
          if (pool.hasCommitment(contributionCommitments(this.get(id, account))[0])) {
            await this.update(id, (r) => {
              r.status = 'opening';
            }, account);
          }
        } else if (status === 'funding') {
          await this.update(id, (r) => this.advanceFunding(r, relayer, account), account);
        } else if (status === 'live' || status === 'closing') {
          await this.update(id, async (r) => {
            if ((await this.settledOnChain(r)) && r.status !== 'disputing') {
              if (r.latest.state.final) await this.closed(r, account); // a cooperative close of our final state
              else r.status = 'disputing'; // spent some other way: the dispute service settles it
            }
          }, account);
        }
      } catch (error) {
        problems.push({ channelId: id, error });
      }
    }
    return problems;
  }

  // ---------------------------------------------------------------- incoming messages

  /** The P2P request handler; `fromPeerId` is the Noise-authenticated remote peer. */
  async handle(fromPeerId: string, message: unknown): Promise<unknown> {
    const parsed = ChannelMessageSchema.safeParse(message);
    if (!parsed.success) throw new AppError(400, 'BAD_MESSAGE', 'Malformed channel message');
    const m = parsed.data;
    const account = this.deps.wallet.activeAccount().id; // WALLET_LOCKED while locked
    if (m.type === 'open') return this.locked(m.channelId, () => this.onOpen(fromPeerId, m, account));
    return this.locked(m.channelId, async () => {
      const r = this.deps.repository.get(m.channelId, account);
      if (!r || r.peer.peerId !== fromPeerId) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'No such channel with this peer');
      try {
        if (m.type === 'cancel') return await this.onCancel(r);
        if (m.type === 'confirm') return await this.onConfirm(r, m, account);
        return await this.onPropose(r, m, account);
      } finally {
        await this.deps.repository.save(r, account); // saved even when the handler refused
      }
    });
  }

  private async onOpen(from: string, m: OpenMessage, account: string): Promise<unknown> {
    const { keys, chain, pool, repository } = this.deps;
    if (repository.get(m.channelId, account)) throw new AppError(409, 'CHANNEL_EXISTS', 'This channel already exists');
    await this.checkWindow(m.window);
    this.checkToken(m.token);
    if (m.contribA.amount !== m.amountA || m.amountA <= m.closingFee || m.amountA > MAX_AMOUNT || m.amountB > MAX_AMOUNT) {
      throw new AppError(400, 'INVALID_AMOUNT', 'The proposed amounts are not valid');
    }
    if ([m.shareA, m.tagA, m.contribA.salt, m.pkA[0], m.pkA[1]].some((v) => v >= FIELD_SIZE) || m.nonce0 >= MAX_NONCE) {
      throw new AppError(400, 'BAD_MESSAGE', 'Malformed channel message');
    }
    // This side will only ever dial the authenticated sender.
    const addrs = m.addrsA.filter((a) => a.endsWith(`/p2p/${from}`));
    if (addrs.length === 0) throw new AppError(400, 'BAD_MESSAGE', 'The opener sent no address to reach it');

    const request: OpenRequest = {
      channelId: m.channelId, peerId: from, token: m.token, amount: m.amountA, peerAmount: m.amountB, window: m.window, closingFee: m.closingFee,
    };
    const approved = this.deps.approveOpen ? await this.deps.approveOpen(request) : m.amountB === 0n;
    if (!approved) throw new AppError(403, 'OPEN_DECLINED', 'The other party declined this channel');
    if (m.amountB > 0n) {
      const fee = quotedFee(await this.deps.relayer().info(), m.token);
      await pool.sync(account);
      if ((pool.balances(account).get(m.token) ?? 0n) < m.amountB + fee) {
        throw new AppError(409, 'INSUFFICIENT_FUNDS', 'The other party cannot fund its side and pay the relayer fee');
      }
    }

    const poolKeys = await keys.poolKeys(account);
    const { index, secrets } = await keys.newChannel(account, chain.network.id);
    const pkB = channelPublicKeyOf(secrets.signingKey);
    const tagB = ownerTagOf(secrets.tagSecret);
    const shareB = randomFieldElement();
    const params = { pkA: m.pkA, pkB, channelSecret: hash2(m.shareA, shareB), window: m.window };
    const contribB = m.amountB > 0n ? { amount: m.amountB, salt: randomFieldElement() } : null;
    const cA = noteCommitment(contributionNote(params, m.token, m.contribA, m.tagA));
    const s0 = openingState({ contribs: [cA, 0n], amountA: m.amountA, amountB: 0n, tagA: m.tagA, tagB, closingFee: m.closingFee, nonce: m.nonce0 });
    const encPubB = bytesToHex(poolKeys.encryption.publicKey);
    const record: ChannelRecord = {
      id: m.channelId, role: 'B', index, peer: { peerId: from, addrs }, token: m.token, status: 'opening', params,
      encPubA: m.encPubA, encPubB, contribA: m.contribA, contribB,
      state0: { state: s0, sigA: null, sigB: null },
      latest: { state: s0, sigA: null, sigB: null },
      pending: null, history: [], closeTx: null, createdAt: Date.now(),
    };
    const sigB0 = signStateHash(secrets.signingKey, hashOf(record, s0));
    record.state0.sigB = sigB0;
    record.latest.sigB = sigB0;
    await repository.save(record, account);
    this.deps.onJoined?.(m.channelId);
    return { shareB, pkB, tagB, encPubB, contribB, sigB0 };
  }

  /** A: sends the confirmation (signature of state 0, and state 1 when B contributes) once A has funded. */
  private async confirmOpening(id: string, account: string): Promise<void> {
    const current = this.get(id, account);
    const message = {
      type: 'confirm', channelId: id, sigA0: current.state0.sigA,
      state1: current.pending?.state ?? null, sigA1: current.pending?.sig ?? null,
    };
    const reply = parseReply(ConfirmReplySchema, await this.deps.p2p.request(current.peer, message)); // outside the lock
    await this.update(id, (r) => {
      if (r.status !== 'opening') return; // already confirmed (or cancelled meanwhile)
      if (r.pending) {
        if (!reply.sigB1 || !signedBy(r, 1, r.pending.state, reply.sigB1)) {
          throw new AppError(502, 'BAD_SIGNATURE', 'The other party did not sign state 1');
        }
        this.promote(r, r.pending.state, r.pending.sig, reply.sigB1);
      }
      r.status = 'funding';
    }, account);
  }

  private async onConfirm(r: ChannelRecord, m: ConfirmMessage, account: string): Promise<{ sigB1: StateSignature | null }> {
    if (r.role !== 'B') throw new AppError(400, 'BAD_MESSAGE', 'Unexpected confirmation');
    if (r.status === 'cancelled') throw new AppError(409, 'CANCELLED', 'This channel was cancelled');
    const [cA, cB] = contributionCommitments(r);
    let state1: ChannelState | null = null;
    let sigA1: StateSignature | null = null;
    if (r.contribB) {
      if (!m.state1 || !m.sigA1) throw new AppError(400, 'BAD_MESSAGE', 'State 1 is missing');
      const s0 = r.state0.state;
      const expected = openingState({
        contribs: [cA, cB], amountA: r.contribA.amount, amountB: r.contribB.amount,
        tagA: s0.payoutA, tagB: s0.payoutB, closingFee: s0.closingFee, nonce: m.state1.nonce,
      });
      if (hashOf(r, expected) !== hashOf(r, m.state1) || m.state1.nonce <= s0.nonce || m.state1.nonce > MAX_NONCE) {
        throw new AppError(409, 'PROPOSAL_REFUSED', 'State 1 does not match the agreed terms');
      }
      if (!signedBy(r, 0, m.state1, m.sigA1)) throw new AppError(400, 'BAD_SIGNATURE', 'Bad signature of state 1');
      state1 = m.state1;
      sigA1 = m.sigA1;
    } else if (m.state1) {
      throw new AppError(400, 'BAD_MESSAGE', 'No state 1 without a second contribution');
    }
    if (r.status !== 'opening') {
      // A repeated confirmation whose answer was lost: signatures are deterministic, so answer the same.
      const first = r.history[0];
      if (!state1) return { sigB1: null };
      if (first && hashOf(r, state1) === hashOf(r, stateFromEntry(r, first))) return { sigB1: await this.sign(r, state1, account) };
      throw new AppError(409, 'STALE_STATE', 'The channel is already confirmed');
    }
    if (!signedBy(r, 0, r.state0.state, m.sigA0)) throw new AppError(400, 'BAD_SIGNATURE', 'Bad signature of state 0');
    r.state0.sigA = m.sigA0;
    r.latest = { ...r.state0 };
    let sigB1: StateSignature | null = null;
    if (state1 && sigA1) {
      sigB1 = await this.sign(r, state1, account);
      this.promote(r, state1, sigB1, sigA1);
    }
    r.status = 'funding';
    return { sigB1 };
  }

  private async onCancel(r: ChannelRecord): Promise<Record<string, never>> {
    if (r.status === 'cancelled') return {};
    await this.deps.pool.refreshChain();
    if (r.status !== 'opening' || this.deps.pool.hasCommitment(contributionCommitments(r)[0])) {
      throw new AppError(409, 'NOT_CANCELLABLE', 'This channel can no longer be cancelled');
    }
    r.status = 'cancelled';
    return {};
  }

  // ---------------------------------------------------------------- proposals

  /** Proposes the state `build` makes on top of the latest one, resending an unanswered proposal of ours first
   *  (without `build`, only that resend). */
  private async propose(id: string, build: ((r: ChannelRecord) => ChannelState) | null, account: string): Promise<ChannelRecord> {
    let target: { hash: bigint; nonce: bigint } | null = null;
    for (let attempt = 0; attempt < PROPOSE_ATTEMPTS; ) {
      const step = await this.update(id, async (r) => {
        if (target && holdsState(r, target.hash, target.nonce)) return null; // our proposal is signed by both: done
        if (r.pending && r.pending.prevHash !== hashOf(r, r.latest.state)) r.pending = null; // superseded
        if (!r.pending) {
          if (!build) return null; // nothing of ours waits for an answer
          if (r.status === 'funding') await this.refreshLive(r);
          if (r.status !== 'live') throw new AppError(409, 'NOT_LIVE', 'The channel is not live');
          const state = build(r);
          r.pending = { prevHash: hashOf(r, r.latest.state), state, sig: await this.sign(r, state, account) };
          target = { hash: hashOf(r, state), nonce: state.nonce };
        }
        return { pending: r.pending, prevSig: this.ownSignature(r.latest, sideOf(r)), peer: r.peer };
      }, account);
      if (!step) return this.get(id, account);
      const { pending, prevSig, peer } = step;
      const message = {
        type: pending.state.final ? 'close' : 'pay', channelId: id, prevHash: pending.prevHash,
        state: pending.state, sig: pending.sig, prevSig,
      };
      let reply: z.output<typeof ProposeReplySchema>;
      try {
        reply = parseReply(ProposeReplySchema, await this.deps.p2p.request(peer, message)); // no lock held
      } catch (err) {
        // Lost a tie-break: once the winning state is ours too, propose again on top of it. A
        // losing proposal can also reach the winner after its own state completed (STALE_STATE).
        if (isAppError(err) && (err.code === 'CONFLICT' || err.code === 'STALE_STATE')) {
          if (err.code === 'CONFLICT') await this.waitForChange(id, pending.prevHash, account);
          const r = this.get(id, account);
          if (err.code === 'CONFLICT' || hashOf(r, r.latest.state) !== pending.prevHash) {
            attempt++;
            continue;
          }
        }
        if (isAppError(err) && FINAL_REFUSALS.has(err.code)) {
          await this.update(id, (r) => {
            if (r.pending && hashOf(r, r.pending.state) === hashOf(r, pending.state)) r.pending = null; // drop it
          }, account);
        }
        throw err;
      }
      await this.update(id, (r) => {
        const peerSide: Side = sideOf(r) === 0 ? 1 : 0;
        if (!signedBy(r, peerSide, pending.state, reply.sig)) throw new AppError(502, 'BAD_SIGNATURE', 'The other party’s signature is not valid');
        if (r.pending && hashOf(r, r.pending.state) === hashOf(r, pending.state)) this.promote(r, pending.state, pending.sig, reply.sig);
      }, account);
    }
    throw new AppError(409, 'CONFLICT', 'The other party kept proposing at the same time; try again');
  }

  private async onPropose(r: ChannelRecord, m: ProposeMessage, account: string): Promise<{ sig: StateSignature }> {
    const me = sideOf(r);
    const peer: Side = me === 0 ? 1 : 0;
    if (!signedBy(r, peer, m.state, m.sig)) throw new AppError(400, 'BAD_SIGNATURE', 'Bad signature of the proposed state');
    // Asked again after our answer was lost: we already countersigned exactly this state.
    if (hashOf(r, m.state) === hashOf(r, r.latest.state)) return { sig: this.ownSignature(r.latest, me) };
    // The peer countersigned our proposal but its answer never reached us: its signature completes it.
    if (r.pending && m.prevHash === hashOf(r, r.pending.state) && signedBy(r, peer, r.pending.state, m.prevSig)) {
      this.promote(r, r.pending.state, r.pending.sig, m.prevSig);
    }
    if (m.prevHash !== hashOf(r, r.latest.state)) throw new AppError(409, 'STALE_STATE', 'The proposal builds on a state this side does not hold');
    if (r.status === 'funding') await this.refreshLive(r);
    if (r.status !== 'live') throw new AppError(409, 'NOT_LIVE', 'The channel is not live');
    if (r.pending && r.pending.prevHash === m.prevHash) {
      // Rival proposals on the same state.
      const mine = { nonce: r.pending.state.nonce, proposer: publicKeyOf(r, me) };
      if (winsTieBreak(mine, { nonce: m.state.nonce, proposer: publicKeyOf(r, peer) })) {
        // The peer now waits for our proposal to countersign it, but the request that carried it may have
        // failed (our pay already gave up): send it again (it queues behind the channel lock this handler holds).
        void this.propose(r.id, null, account).catch(() => undefined);
        throw new AppError(409, 'CONFLICT', 'A rival proposal on the same state wins the tie-break');
      }
      r.pending = null; // ours loses: countersign theirs; our payment is proposed again on top of it
    }
    const problem = successorProblem(r.latest.state, m.state, m.type, me);
    if (problem) throw new AppError(409, 'PROPOSAL_REFUSED', problem);
    const sig = await this.sign(r, m.state, account);
    this.promote(r, m.state, sig, m.sig);
    return { sig };
  }

  /** Polls until the latest state is no longer `prevHash`, at most CONFLICT_WAIT_MS; returns either way. */
  private async waitForChange(id: string, prevHash: bigint, account: string): Promise<void> {
    const deadline = Date.now() + CONFLICT_WAIT_MS;
    while (Date.now() < deadline) {
      const r = this.get(id, account);
      if (hashOf(r, r.latest.state) !== prevHash) return;
      await sleep(CONFLICT_POLL_MS);
    }
  }

  // ---------------------------------------------------------------- funding, close, settlement

  private async advanceFunding(r: ChannelRecord, relayer: RelayerPort, account: string): Promise<void> {
    const { pool, keys } = this.deps;
    const [cA, cB] = contributionCommitments(r);
    const [, noteB] = contributionsOf(r);
    // A's contribution already spent: a dispute settled the channel (with state 0) before it went live.
    // Nothing is funded any more; the dispute service settles it (§6.11.8 A).
    if (await this.settledOnChain(r)) {
      r.status = 'disputing';
      return;
    }
    // B funds only after A's contribution is in the pool: otherwise no state could ever be disputed
    // (each lists A's contribution) and B's contribution could not be recovered.
    if (r.role === 'B' && noteB && pool.hasCommitment(cA) && !pool.hasCommitment(cB)) {
      const own = (await keys.poolKeys(account)).encryption.publicKey;
      await pool.spend({ token: r.token, payment: { note: noteB, encryptTo: own }, publicAmount: 0n, recipient: zeroAddress, relayer, accountId: account });
    }
    await this.refreshLive(r);
  }

  private async refreshLive(r: ChannelRecord): Promise<void> {
    const { pool } = this.deps;
    await pool.refreshChain();
    const [cA, cB] = contributionCommitments(r);
    if (r.status === 'funding' && pool.hasCommitment(cA) && (cB === 0n || pool.hasCommitment(cB))) r.status = 'live';
  }

  private async submitClose(r: ChannelRecord, relayer: RelayerPort, account: string): Promise<void> {
    const { pool, prover } = this.deps;
    const { state: s, sigA, sigB } = r.latest;
    if (!sigA || !sigB) throw new AppError(409, 'NOT_CLOSING', 'The final state is not signed by both sides');
    await pool.refreshChain();
    if (!(await this.settledOnChain(r))) {
      const info = await relayer.info();
      const { inputs, outputs, ciphertexts } = settlement(r, s, (c) => pool.proofOf(c), decodeShieldedAddress(info.shieldedAddress));
      const witness = transferWitness({
        root: pool.root, token: r.token, inputs, outputs, publicAmount: 0n,
        extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts }),
        channel: { params: r.params, state: s, sigA, sigB },
      });
      const { proof, signals } = await prover.prove('transfer', witness.input);
      const { txHash } = await relayer.submit({
        kind: 'transact', proof: proof.map(String), signals: signals.map(String), recipient: zeroAddress, ciphertexts: concatHex(ciphertexts),
      });
      r.closeTx = txHash;
    }
    if (r.status === 'closing') await this.closed(r, account);
  }

  /** Whether the contributions are already spent (marks the channel `disputing` when a dispute spent them). */
  private async settledOnChain(r: ChannelRecord): Promise<boolean> {
    const [cA] = contributionCommitments(r);
    if (!this.deps.pool.isSpent(nullifierOf(r.params.channelSecret, cA))) return false;
    if (await this.deps.chain.isFinalized(channelNullifierOf(r.params.channelSecret))) r.status = 'disputing';
    return true;
  }

  private async closed(r: ChannelRecord, account: string): Promise<void> {
    r.status = 'closed';
    await this.deps.pool.sync(account);
    await this.deps.pool.adopt(payoutNote(r, r.latest.state, sideOf(r)), { channel: r.index }, account); // no-op for a 0 payout
  }

  // ---------------------------------------------------------------- helpers

  private cancelProblem(r: ChannelRecord): string | null {
    if (r.status !== 'opening') return 'Only a channel that is still opening can be cancelled';
    if (this.deps.pool.hasCommitment(contributionCommitments(r)[0])) return 'The opener’s contribution is already in the pool, so the channel goes on';
    if (r.role === 'B' && Date.now() - (r.createdAt ?? 0) < INVITEE_CANCEL_AFTER_MS) {
      return 'The other side may still be funding it; it can be cancelled ten minutes after it was accepted';
    }
    return null;
  }

  private async checkWindow(window?: bigint): Promise<bigint> {
    const { min, max } = await this.deps.chain.windowBounds();
    const value = window ?? max;
    if (value < min || value > max) throw new AppError(400, 'INVALID_WINDOW', `The dispute window must be between ${min} and ${max} seconds`);
    return value;
  }

  private checkToken(token: bigint): void {
    if (token !== 0n && token !== BigInt(this.deps.chain.network.stablecoin)) {
      throw new AppError(400, 'TOKEN_NOT_SUPPORTED', 'Channels hold the native coin or the stablecoin');
    }
  }

  private async sign(r: ChannelRecord, s: ChannelState, account: string): Promise<StateSignature> {
    return signStateHash(channelSecrets(await this.deps.keys.poolKeys(account), r.index).signingKey, hashOf(r, s));
  }

  private ownSignature(signed: SignedRecordState, side: Side): StateSignature {
    const sig = side === 0 ? signed.sigA : signed.sigB;
    if (!sig) throw new AppError(409, 'NOT_SIGNED', 'This side has not signed the latest state');
    return sig;
  }

  /** Makes a fully signed state the latest. */
  private promote(r: ChannelRecord, state: ChannelState, mine: StateSignature, theirs: StateSignature): void {
    const me = sideOf(r);
    r.latest = { state, sigA: me === 0 ? mine : theirs, sigB: me === 1 ? mine : theirs };
    r.history.push(historyEntry(state));
    if (r.pending && hashOf(r, r.pending.state) === hashOf(r, state)) r.pending = null;
    if (state.final) r.status = 'closing';
  }

  /** Runs `run` after every earlier task of this channel (never nest for the same id: deadlock). */
  private locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(id) ?? Promise.resolve()).then(run);
    this.locks.set(id, result.catch(() => undefined));
    return result;
  }
}
