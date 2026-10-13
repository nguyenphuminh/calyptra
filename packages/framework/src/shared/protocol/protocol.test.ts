import { toHex, zeroAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_DOMAIN,
  CIPHERTEXT_SIZE,
  CLOSE_DOMAIN,
  FIELD_SIZE,
  MAX_AMOUNT,
  MAX_TOKEN,
  MerkleTree,
  PAYOUT_DOMAIN,
  bytesToBigInt,
  channelNullifierOf,
  channelPublicKeyOf,
  channelTagOf,
  decryptNote,
  encryptNote,
  encryptionPublicKeyOf,
  extDataHashOf,
  fieldToBytes,
  fieldToHex,
  generateChannelKey,
  hash2,
  noteCommitment,
  noteInner,
  nullifierOf,
  ownerTagOf,
  packAmountToken,
  paramsHashOf,
  payoutSaltOf,
  randomFieldElement,
  signStateHash,
  stateHashOf,
  toEvmProof,
  toField,
  verifyStateSignature,
  zeroValues,
  type NotePreimage,
} from './index.ts';

const keyPair = () => {
  const privateKey = new Uint8Array(32);
  crypto.getRandomValues(privateKey);
  return { privateKey, publicKey: encryptionPublicKeyOf(privateKey) };
};

/** Folds a Merkle proof back to the root it proves membership under. */
function foldProof(leaf: bigint, leafIndex: number, pathElements: readonly bigint[]): bigint {
  let node = leaf;
  let i = leafIndex;
  for (const sibling of pathElements) {
    node = i % 2 === 1 ? hash2(sibling, node) : hash2(node, sibling);
    i >>= 1;
  }
  return node;
}

describe('field', () => {
  it('reduces into the field and keeps random values in range', () => {
    expect(fieldToBytes(0n)).toHaveLength(32);
    expect(FIELD_SIZE).toBe(BigInt('0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001'));
    expect(toField(FIELD_SIZE + 5n)).toBe(5n);
    expect(toField(-1n)).toBe(FIELD_SIZE - 1n);
    for (let i = 0; i < 50; i++) {
      const v = randomFieldElement();
      expect(v >= 0n && v < FIELD_SIZE).toBe(true);
    }
  });

  it('round-trips field elements through 32 bytes', () => {
    for (const v of [0n, 1n, FIELD_SIZE - 1n, randomFieldElement()]) {
      expect(bytesToBigInt(fieldToBytes(v))).toBe(v);
      expect(BigInt(fieldToHex(v))).toBe(v);
    }
    expect(bytesToBigInt(new Uint8Array())).toBe(0n);
  });
});

describe('poseidon', () => {
  it('matches the circomlib reference vector for H(1, 2)', () => {
    expect(hash2(1n, 2n)).toBe(7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  });

  it('domain constants are distinct field elements', () => {
    const domains = [CHANNEL_DOMAIN, CLOSE_DOMAIN, PAYOUT_DOMAIN];
    expect(new Set(domains).size).toBe(3);
    for (const d of domains) expect(d >= 0n && d < FIELD_SIZE).toBe(true);
  });
});

describe('note', () => {
  it('packs token above the 64 amount bits', () => {
    expect(packAmountToken(5n, 1n)).toBe((1n << 64n) + 5n);
    expect(() => packAmountToken(1n << 64n, 0n)).toThrow(RangeError);
    expect(() => packAmountToken(-1n, 0n)).toThrow(RangeError);
    expect(() => packAmountToken(0n, 1n << 160n)).toThrow(RangeError);
    expect(packAmountToken(MAX_AMOUNT, MAX_TOKEN)).toBeLessThan(FIELD_SIZE);
  });

  it('commitment is H(packed, H(ownerTag, salt)) and depends on every field', () => {
    const note: NotePreimage = { amount: 100n, token: 7n, ownerTag: ownerTagOf(9n), salt: 11n };
    const cm = noteCommitment(note);
    expect(cm).toBe(hash2(packAmountToken(100n, 7n), noteInner(note.ownerTag, note.salt)));
    expect(noteCommitment({ ...note, amount: 101n })).not.toBe(cm);
    expect(noteCommitment({ ...note, token: 8n })).not.toBe(cm);
    expect(noteCommitment({ ...note, ownerTag: ownerTagOf(10n) })).not.toBe(cm);
    expect(noteCommitment({ ...note, salt: 12n })).not.toBe(cm);
  });

  it('nullifier needs the secret and differs per note', () => {
    const cm = noteCommitment({ amount: 1n, token: 0n, ownerTag: ownerTagOf(3n), salt: 4n });
    const other = noteCommitment({ amount: 1n, token: 0n, ownerTag: ownerTagOf(3n), salt: 5n });
    expect(nullifierOf(3n, cm)).not.toBe(nullifierOf(4n, cm));
    expect(nullifierOf(3n, cm)).not.toBe(nullifierOf(3n, other));
    expect(nullifierOf(3n, cm)).not.toBe(cm);
  });
});

describe('merkle', () => {
  it('empty root is the top zero value', () => {
    expect(new MerkleTree().root).toBe(zeroValues()[20]);
  });

  it('proofs recompute the root for every leaf', () => {
    const tree = new MerkleTree();
    for (let i = 0; i < 13; i++) tree.insert(BigInt(i + 1) * 1000n);
    for (let i = 0; i < 13; i++) {
      const proof = tree.proof(i);
      expect(proof.pathElements).toHaveLength(20);
      expect(foldProof(tree.leaves()[i] as bigint, proof.leafIndex, proof.pathElements)).toBe(tree.root);
    }
  });

  it('incremental inserts match a tree rebuilt from scratch', () => {
    const tree = new MerkleTree(5);
    const leaves: bigint[] = [];
    for (let i = 0; i < 9; i++) {
      const leaf = randomFieldElement();
      leaves.push(leaf);
      tree.insert(leaf);
      expect(tree.root).toBe(new MerkleTree(5, leaves).root);
    }
  });

  it('rejects inserts beyond capacity', () => {
    const tree = new MerkleTree(2, [1n, 2n, 3n, 4n]);
    expect(() => tree.insert(5n)).toThrow(RangeError);
  });
});

describe('ext data hash', () => {
  it('binds the recipient and every ciphertext', () => {
    const cts: [Hex, Hex, Hex] = ['0x01', '0x02', '0x03'];
    const base = extDataHashOf({ recipient: zeroAddress, ciphertexts: cts });
    expect(base < FIELD_SIZE).toBe(true);
    expect(extDataHashOf({ recipient: '0x0000000000000000000000000000000000000001', ciphertexts: cts })).not.toBe(base);
    expect(extDataHashOf({ recipient: zeroAddress, ciphertexts: ['0x04', '0x02', '0x03'] })).not.toBe(base);
    expect(extDataHashOf({ recipient: zeroAddress, ciphertexts: ['0x01', '0x04', '0x03'] })).not.toBe(base);
    expect(extDataHashOf({ recipient: zeroAddress, ciphertexts: ['0x01', '0x02', '0x04'] })).not.toBe(base);
  });
});

describe('note encryption', () => {
  it('round-trips and always has the same size', () => {
    const keys = keyPair();
    const note: NotePreimage = { amount: MAX_AMOUNT, token: MAX_TOKEN, ownerTag: randomFieldElement(), salt: randomFieldElement() };
    const ct = encryptNote(keys.publicKey, note);
    expect(ct).toHaveLength(CIPHERTEXT_SIZE);
    expect(CIPHERTEXT_SIZE).toBe(168);
    expect(decryptNote(keys, ct)).toEqual(note);
    const zero: NotePreimage = { amount: 0n, token: 0n, ownerTag: 1n, salt: 2n };
    const zeroCt = encryptNote(keys.publicKey, zero);
    expect(zeroCt).toHaveLength(168);
    expect(decryptNote(keys, zeroCt)).toEqual(zero);
  });

  it('returns null for someone else or for tampered bytes', () => {
    const keys = keyPair();
    const note: NotePreimage = { amount: 5n, token: 0n, ownerTag: 1n, salt: 2n };
    const ct = encryptNote(keys.publicKey, note);
    expect(decryptNote(keyPair(), ct)).toBeNull();
    const tampered = ct.slice();
    tampered[100] = (tampered[100] as number) ^ 1;
    expect(decryptNote(keys, tampered)).toBeNull();
    expect(decryptNote(keys, new Uint8Array(10))).toBeNull();
  });
});

describe('channel signatures', () => {
  it('verify only for the signed hash and key', () => {
    const key = generateChannelKey();
    const pk = channelPublicKeyOf(key);
    const sig = signStateHash(key, 42n);
    expect(verifyStateSignature(pk, 42n, sig)).toBe(true);
    expect(verifyStateSignature(pk, 43n, sig)).toBe(false);
    expect(verifyStateSignature(channelPublicKeyOf(generateChannelKey()), 42n, sig)).toBe(false);
  });
});

describe('proof', () => {
  it('orders a snarkjs proof for the EVM (G2 imaginary part first)', () => {
    const proof = { pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'], protocol: 'groth16', curve: 'bn128' };
    expect(toEvmProof(proof)).toEqual([1n, 2n, 4n, 3n, 6n, 5n, 7n, 8n]);
  });
});

// Test vectors computed with the Calyptra domains (also the oracles of the Foundry tests).
describe('test vectors', () => {
  const ot = ownerTagOf(123n);
  const cm = noteCommitment({ amount: 100n, token: 0n, ownerTag: ot, salt: 456n });
  const paramsHash = paramsHashOf({ pkA: [1n, 2n], pkB: [3n, 4n], channelSecret: 5n, window: 259200n });
  const stateHash = stateHashOf(paramsHash, {
    contribs: [7n, 8n], balA: 45n, balB: 54n, payoutA: 11n, payoutB: 12n, closingFee: 1n, nonce: 9n, final: true,
  });
  const key = new Uint8Array(32).fill(1);

  it('domain constants', () => {
    expect(CHANNEL_DOMAIN).toBe(19444392464985891166336980080482921842534438747332189832040398549112078928479n);
    expect(CLOSE_DOMAIN).toBe(14862831906136877886271730850391152831600765235773996590097070805882575013204n);
    expect(PAYOUT_DOMAIN).toBe(641984763644806825325323127802147721037611754259482495554473977097964589230n);
    expect(fieldToHex(CHANNEL_DOMAIN)).toBe('0x2afd22d9466a36905d660d2abfd8e277ec1919e4c2d2a1ea71c3a5e577a30a5f');
    expect(fieldToHex(CLOSE_DOMAIN)).toBe('0x20dc10933a901e8ed913e2658aa009a5bf986db7927e44162bcf940664884554');
    expect(fieldToHex(PAYOUT_DOMAIN)).toBe('0x016b59ba56ef52b16f41b679cd62eb9b0cd8ae3791a83e7bee2babb0dba190ae');
  });

  it('notes and nullifiers', () => {
    expect(ot).toBe(9904028930859697121695025471312564917337032846528014134060777877259199866166n);
    expect(cm).toBe(4471268795867455478905333125006733293455371295218544824249173648673293864323n);
    expect(nullifierOf(123n, cm)).toBe(14002068206769235152670731366983955330630462999799310659717759014849645104887n);
    expect(noteCommitment({ amount: 5n, token: 0x1234n, ownerTag: ot, salt: 456n })).toBe(
      16483339816057846820191073573595236141968289176103948572127621346628013928406n,
    );
  });

  it('channel hashes', () => {
    expect(channelTagOf(1n, 2n)).toBe(10238559081507109885233158479519976388328709088957016217412549624816756017725n);
    expect(channelNullifierOf(5n)).toBe(21010935611886044258036948048864651058490389392711741784667292174565877481295n);
    expect(paramsHash).toBe(2264431690528055795851110328014092647689610874904715384774173063764365263369n);
    expect(stateHash).toBe(15581006276150695042781080149596799565397398334909344570553851914513659356722n);
    expect(payoutSaltOf(5n, stateHash, 0)).toBe(13632500725793473329336379338029111901700613069931336768319788986272923396451n);
  });

  it('ext data hashes', () => {
    expect(extDataHashOf({ recipient: zeroAddress, ciphertexts: ['0x01', '0x02', '0x03'] })).toBe(
      13480713791112597098013319520673722043167148681402578682221522036526891314740n,
    );
    const empty = toHex(new Uint8Array(168));
    expect(extDataHashOf({ recipient: '0x0000000000000000000000000000000000000001', ciphertexts: [empty, empty, empty] })).toBe(
      10472773345416213608939933309650111419917463049876096415424922068459820375380n,
    );
  });

  it('channel keys and signatures', () => {
    expect(channelPublicKeyOf(key)).toEqual([
      16970849896269773724025528523250329257317140930938020603041819847803817178632n,
      3473667139940712726519522097945362980996832375565310790676566667608533927829n,
    ]);
    expect(signStateHash(key, 42n)).toEqual({
      R8x: 17045730657296280501604750318987957148771655470401617128315906988932412239264n,
      R8y: 14416069619875984208827690033213592822862464412547012391422744599944400478147n,
      S: 1323436334169852229266479672059176419203063473137302238550728394081664085901n,
    });
  });

  it('empty tree values', () => {
    const zeros = zeroValues();
    expect(zeros[20]).toBe(15019797232609675441998260052101280400536945603062888308240081994073687793470n);
    expect(fieldToHex(zeros[1] as bigint)).toBe('0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864');
    for (let i = 0; i < 20; i++) expect(hash2(zeros[i] as bigint, zeros[i] as bigint)).toBe(zeros[i + 1]);
  });
});
