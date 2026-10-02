import { bytesToHex, concatHex, zeroAddress, type Hex } from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import {
  channelNullifierOf,
  dummyInput,
  encryptNote,
  extDataHashOf,
  finalizeWitness,
  noteCommitment,
  nullifierOf,
  randomFieldElement,
  reclaimWitness,
  submitStateWitness,
  type NotePreimage,
} from '../../shared/protocol/index.ts';
import type { ChainAdapter } from '../chain/index.ts';
import {
  contributionsOf,
  hashOf,
  payoutNote,
  settlement,
  sideOf,
  signedStates,
  type ChannelRecord,
  type ChannelService,
  type TickProblem,
} from '../channel/index.ts';
import { channelSecrets, decodeShieldedAddress, type KeyRing } from '../keys/index.ts';
import type { PoolService } from '../pool/index.ts';
import { quotedFee, type RelayerPort } from '../relayer/index.ts';
import type { WalletService } from '../wallet/index.ts';

/** An opening is watched too: once the opener has funded, it can close it with state 0 if the other side never confirms. */
const WATCHED: ReadonlySet<ChannelRecord['status']> = new Set(['opening', 'funding', 'live', 'closing', 'disputing']);

type SignedRecordState = ChannelRecord['latest'];

export interface DisputeDeps {
  wallet: WalletService;
  keys: KeyRing;
  chain: ChainAdapter;
  pool: PoolService;
  prover: ProverPort;
  channels: ChannelService;
}

/** Unilateral close: submit a state, answer a dispute, finalize after the deadline, adopt the payout, reclaim. */
export class DisputeService {
  private readonly deps: DisputeDeps;

  constructor(deps: DisputeDeps) {
    this.deps = deps;
  }

  /** Starts a dispute with this side's best provable state; returns the submit-state transaction hash. */
  start(id: string, relayer: RelayerPort, accountId?: string): Promise<Hex> {
    return this.deps.channels.update(id, async (r) => {
      if (!WATCHED.has(r.status)) throw new AppError(409, 'NOT_DISPUTABLE', 'This channel is already closed');
      const best = await this.bestState(r);
      if (!best) throw new AppError(409, 'NOT_DISPUTABLE', 'No state of this channel can be proven yet (its contributions are not in the pool)');
      const txHash = await this.submitState(r, best, relayer);
      r.status = 'disputing';
      return txHash;
    }, accountId);
  }

  /** One step of the watch loop: answers, finalizes and settles disputes of every watched channel. */
  async tick(relayer: RelayerPort, accountId?: string): Promise<TickProblem[]> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    const problems: TickProblem[] = [];
    const watched = this.deps.channels.list(account).filter((r) => WATCHED.has(r.status));
    // Catch up with the contract's events first, so that no channel stays locked while they download.
    if (watched.length > 0) await this.deps.chain.refreshDisputes();
    for (const { id } of watched) {
      try {
        await this.deps.channels.update(id, (r) => this.advance(r, relayer, account), account);
      } catch (error) {
        problems.push({ channelId: id, error });
      }
    }
    return problems;
  }

  private async advance(r: ChannelRecord, relayer: RelayerPort, account: string): Promise<void> {
    const { chain } = this.deps;
    const cn = channelNullifierOf(r.params.channelSecret);
    // Read from the local mirror of every dispute: the RPC provider is never asked about this channel.
    const dispute = await chain.disputeOf(cn);
    if (await chain.isFinalized(cn)) return this.settle(r, dispute.stateHash, relayer, account);
    if (!dispute.pending) return;
    r.status = 'disputing';
    const best = await this.bestState(r);
    if (best && best.state.nonce > dispute.nonce) {
      await this.submitState(r, best, relayer); // answer with a newer state
      return;
    }
    if ((await chain.blockTimestamp()) < dispute.deadline) return;
    // Without both signatures of the pending state (an old state the other side submitted), only
    // the other side can finalize; this side settles once it has.
    const pending = [r.latest, r.state0].find((x) => x.sigA && x.sigB && hashOf(r, x.state) === dispute.stateHash);
    if (!pending) return;
    await this.finalize(r, pending, relayer);
    await this.settle(r, dispute.stateHash, relayer, account);
  }

  /** The newest fully signed state whose listed contributions are all in the pool (only latest and state 0 keep signatures). */
  private async bestState(r: ChannelRecord): Promise<SignedRecordState | null> {
    const { pool } = this.deps;
    await pool.refreshChain();
    const candidates = [r.latest, r.state0].filter((x) => x.sigA && x.sigB && x.state.contribs.every((c) => c === 0n || pool.hasCommitment(c)));
    candidates.sort((a, b) => (a.state.nonce > b.state.nonce ? -1 : a.state.nonce < b.state.nonce ? 1 : 0));
    return candidates[0] ?? null;
  }

  private async submitState(r: ChannelRecord, signed: SignedRecordState, relayer: RelayerPort): Promise<Hex> {
    const { pool, prover } = this.deps;
    const { state, sigA, sigB } = signed;
    if (!sigA || !sigB) throw new AppError(409, 'NOT_SIGNED', 'The state is not signed by both sides');
    await pool.refreshChain();
    const proofOf = (c: bigint) => (c === 0n ? pool.emptyProof() : pool.proofOf(c));
    const witness = submitStateWitness({
      root: pool.root,
      channel: { params: r.params, state, sigA, sigB },
      contribProofs: [proofOf(state.contribs[0]), proofOf(state.contribs[1])],
    });
    const { proof, signals } = await prover.prove('submit_state', witness.input);
    // Public signals: [root, channelNullifier, nonce, stateHash, window]. No fee note: relayed for free.
    return (await relayer.submit({ kind: 'submitState', proof: proof.map(String), signals: signals.map(String) })).txHash;
  }

  private async finalize(r: ChannelRecord, signed: SignedRecordState, relayer: RelayerPort): Promise<void> {
    const { pool, prover } = this.deps;
    const { state, sigA, sigB } = signed;
    if (!sigA || !sigB) throw new AppError(409, 'NOT_SIGNED', 'The state is not signed by both sides');
    await pool.refreshChain();
    const info = await relayer.info();
    // The fee note (third output) carries the state's closing fee.
    const { inputs, outputs, ciphertexts } = settlement(r, state, (c) => pool.proofOf(c), decodeShieldedAddress(info.shieldedAddress));
    const witness = finalizeWitness({
      root: pool.root, token: r.token, inputs, outputs,
      extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts }),
      channel: { params: r.params, state, sigA, sigB },
    });
    const { proof, signals } = await prover.prove('finalize', witness.input);
    await relayer.submit({ kind: 'finalize', proof: proof.map(String), signals: signals.map(String), ciphertexts: concatHex(ciphertexts) });
  }

  /** After finalization (by anyone): adopt this side's payout and reclaim its contribution if the state left it out. */
  private async settle(r: ChannelRecord, stateHash: bigint, relayer: RelayerPort, account: string): Promise<void> {
    const { pool } = this.deps;
    await pool.sync(account);
    const settled = signedStates(r).reverse().find((s) => hashOf(r, s) === stateHash);
    if (settled) await pool.adopt(payoutNote(r, settled, sideOf(r)), { channel: r.index }, account);
    // Finalize spends every contribution the state lists, so one still unspent was left out.
    const own = contributionsOf(r)[sideOf(r)];
    if (own) {
      const c = noteCommitment(own);
      if (pool.hasCommitment(c) && !pool.isSpent(nullifierOf(r.params.channelSecret, c))) await this.reclaim(r, own, relayer, account);
    }
    r.status = 'settled';
  }

  private async reclaim(r: ChannelRecord, contribution: NotePreimage, relayer: RelayerPort, account: string): Promise<void> {
    const { keys, pool, prover } = this.deps;
    const poolKeys = await keys.poolKeys(account);
    const info = await relayer.info();
    const fee = quotedFee(info, r.token); // the relayer's current quote
    if (contribution.amount <= fee) {
      throw new AppError(409, 'FEE_EXCEEDS_CONTRIBUTION', 'The relayer fee is larger than the contribution to reclaim');
    }
    const feeTo = decodeShieldedAddress(info.shieldedAddress);
    const own = (amount: bigint): NotePreimage => ({ amount, token: r.token, ownerTag: poolKeys.ownerTag, salt: randomFieldElement() });
    const outputs: [NotePreimage, NotePreimage, NotePreimage] = [
      own(contribution.amount - fee),
      own(0n),
      { amount: fee, token: r.token, ownerTag: feeTo.ownerTag, salt: randomFieldElement() },
    ];
    const ownPub = poolKeys.encryption.publicKey;
    const ciphertexts: [Hex, Hex, Hex] = [
      bytesToHex(encryptNote(ownPub, outputs[0])),
      bytesToHex(encryptNote(ownPub, outputs[1])),
      bytesToHex(encryptNote(feeTo.encryptionPublicKey, outputs[2])),
    ];
    const witness = reclaimWitness({
      root: pool.root, token: r.token,
      contribution: { note: contribution, proof: pool.proofOf(noteCommitment(contribution)) },
      refundSecret: channelSecrets(poolKeys, r.index).tagSecret,
      extra: dummyInput(r.token), params: r.params, outputs,
      extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts }),
    });
    const { proof, signals } = await prover.prove('reclaim', witness.input);
    await relayer.submit({ kind: 'reclaim', proof: proof.map(String), signals: signals.map(String), ciphertexts: concatHex(ciphertexts) });
    await pool.sync(account);
  }
}
