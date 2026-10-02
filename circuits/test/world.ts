import { zeroAddress } from 'viem';
import {
  MerkleTree,
  TREE_DEPTH,
  channelPublicKeyOf,
  channelTagOf,
  extDataHashOf,
  generateChannelKey,
  noteCommitment,
  ownerTagOf,
  paramsHashOf,
  payoutSaltOf,
  randomFieldElement,
  signStateHash,
  stateHashOf,
  type ChannelParams,
  type ChannelState,
  type NotePreimage,
  type SignedState,
  type SpendInput,
} from '@calyptra/framework/protocol';

// Test fixtures shared by the circuit tests: people, notes, a pool tree and a two-party channel.

export const NATIVE = 0n;
/** Any non-zero 160-bit address works as the stablecoin; this is AUSD on Monad testnet. */
export const STABLE = 0xa9012a055bd4e0edff8ce09f960291c09d5322dcn;
export const EXT = extDataHashOf({ recipient: zeroAddress, ciphertexts: ['0x01', '0x02', '0x03'] });

export interface Person {
  secret: bigint;
  tag: bigint;
}

export function person(): Person {
  const secret = randomFieldElement();
  return { secret, tag: ownerTagOf(secret) };
}

export function note(amount: bigint, token: bigint, ownerTag: bigint, salt = randomFieldElement()): NotePreimage {
  return { amount, token, ownerTag, salt };
}

/** The pool's commitment tree as the circuits see it. */
export class World {
  readonly tree = new MerkleTree(TREE_DEPTH);

  get root(): bigint {
    return this.tree.root;
  }

  addPersonal(n: NotePreimage, owner: Person): SpendInput {
    const leafIndex = this.tree.insert(noteCommitment(n));
    return { note: n, unlock: { kind: 'personal', secret: owner.secret }, proof: this.tree.proof(leafIndex) };
  }

  addContribution(n: NotePreimage, refundTag: bigint): SpendInput {
    const leafIndex = this.tree.insert(noteCommitment(n));
    return { note: n, unlock: { kind: 'channel', refundTag }, proof: this.tree.proof(leafIndex) };
  }

  /** Re-reads the Merkle proof after later inserts; dummies (amount 0) are left unchanged. */
  refresh(spend: SpendInput): SpendInput {
    if (spend.note.amount === 0n) return spend;
    return { ...spend, proof: this.tree.proof(spend.proof.leafIndex) };
  }
}

export type Side = 'A' | 'B';

/** A channel between Alice (A) and Bob (B); each side's tag is both its payout and its refund tag. */
export class TestChannel {
  readonly keyA = generateChannelKey();
  readonly keyB = generateChannelKey();
  readonly alice = person();
  readonly bob = person();
  readonly params: ChannelParams;
  readonly paramsHash: bigint;

  constructor(window = 259_200n) {
    this.params = {
      pkA: channelPublicKeyOf(this.keyA),
      pkB: channelPublicKeyOf(this.keyB),
      channelSecret: randomFieldElement(),
      window,
    };
    this.paramsHash = paramsHashOf(this.params);
  }

  refundTag(side: Side): bigint {
    return side === 'A' ? this.alice.tag : this.bob.tag;
  }

  /** A contribution note owned by the channel tag with that side's refund tag. */
  contributionNote(amount: bigint, token: bigint, side: Side): NotePreimage {
    return note(amount, token, channelTagOf(this.paramsHash, this.refundTag(side)));
  }

  state(fields: Partial<ChannelState> & Pick<ChannelState, 'contribs' | 'balA' | 'balB'>): ChannelState {
    return { payoutA: this.alice.tag, payoutB: this.bob.tag, closingFee: 0n, nonce: 1n, final: false, ...fields };
  }

  /** Both signatures, optionally made with substitute keys. */
  sign(state: ChannelState, keys: { a?: Uint8Array; b?: Uint8Array } = {}): SignedState {
    const stateHash = stateHashOf(this.paramsHash, state);
    return {
      params: this.params,
      state,
      sigA: signStateHash(keys.a ?? this.keyA, stateHash),
      sigB: signStateHash(keys.b ?? this.keyB, stateHash),
    };
  }

  /** The outputs a close of `signed` must have: both payouts with state-derived salts, then the fee note. */
  closeOutputs(signed: SignedState, token: bigint, relayerTag: bigint): [NotePreimage, NotePreimage, NotePreimage] {
    const { state } = signed;
    const stateHash = stateHashOf(this.paramsHash, state);
    const secret = this.params.channelSecret;
    return [
      note(state.balA, token, state.payoutA, payoutSaltOf(secret, stateHash, 0)),
      note(state.balB, token, state.payoutB, payoutSaltOf(secret, stateHash, 1)),
      note(state.closingFee, token, relayerTag),
    ];
  }
}
