import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { FIELD_SIZE, decryptNote, encryptNote, ownerTagOf, randomFieldElement } from '../../shared/protocol/index.ts';
import { MemoryStore } from '../storage/index.ts';
import { WalletRepository, WalletService } from '../wallet/index.ts';
import {
  KeyRing, POOL_KEY_MESSAGE, channelSecrets, decodeShieldedAddress, derivePoolKeys, encodeShieldedAddress, shieldedAddressOf,
} from './index.ts';

const KEY_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY_B = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('pool keys', () => {
  it('are deterministic per account and differ between accounts', async () => {
    const a1 = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const a2 = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const b = await derivePoolKeys(privateKeyToAccount(KEY_B));
    expect(a1.spendingSecret).toBe(a2.spendingSecret);
    expect(a1.encryption.publicKey).toEqual(a2.encryption.publicKey);
    expect(b.spendingSecret).not.toBe(a1.spendingSecret);
    expect(b.encryption.publicKey).not.toEqual(a1.encryption.publicKey);
    expect(a1.spendingSecret < FIELD_SIZE).toBe(true);
    expect(a1.ownerTag).toBe(ownerTagOf(a1.spendingSecret));
    expect(POOL_KEY_MESSAGE).toBe('Calyptra pool keys v1\n\nThis signature derives your private Calyptra keys. Only Calyptra itself ever signs it.');
  });

  it('decrypt a note encrypted to the account', async () => {
    const keys = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const note = { amount: 123n, token: 0n, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    expect(decryptNote(keys.encryption, encryptNote(keys.encryption.publicKey, note))).toEqual(note);
  });

  it('give deterministic, distinct channel secrets per index', async () => {
    const keys = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const c0 = channelSecrets(keys, 0);
    expect(channelSecrets(keys, 0)).toEqual(c0);
    const c1 = channelSecrets(keys, 1);
    expect(c1.tagSecret).not.toBe(c0.tagSecret);
    expect(c1.signingKey).not.toEqual(c0.signingKey);
    expect(c0.signingKey).toHaveLength(32);
    expect(ownerTagOf(c0.tagSecret)).not.toBe(keys.ownerTag);
  });
});

describe('shielded address', () => {
  it('round-trips and rejects typos and other strings', async () => {
    const keys = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const address = shieldedAddressOf(keys);
    expect(address).toMatch(/^cal[0-9a-f]{136}$/);
    const decoded = decodeShieldedAddress(` ${address} `);
    expect(decoded.ownerTag).toBe(keys.ownerTag);
    expect(decoded.encryptionPublicKey).toEqual(keys.encryption.publicKey);
    expect(encodeShieldedAddress(decoded)).toBe(address);
    const typo = `${address.slice(0, 10)}${address[10] === '0' ? '1' : '0'}${address.slice(11)}`;
    expect(() => decodeShieldedAddress(typo)).toThrow(/typo/);
    expect(() => decodeShieldedAddress('0x1234')).toThrow('This is not a Calyptra shielded address');
    expect(() => decodeShieldedAddress(address.toUpperCase())).toThrow('This is not a Calyptra shielded address');
  });
});

describe('KeyRing', () => {
  async function ring(): Promise<{ wallet: WalletService; keys: KeyRing }> {
    const wallet = new WalletService(new WalletRepository(new MemoryStore()), { N: 2 ** 10, r: 8, p: 1 });
    await wallet.importPrivateKey(KEY_A, 'password123');
    return { wallet, keys: new KeyRing(wallet) };
  }

  it('derives pool keys from the active account, once, and forgets them on clear', async () => {
    const { wallet, keys } = await ring();
    const first = keys.poolKeys();
    expect(keys.poolKeys()).toBe(first);
    expect((await first).spendingSecret).toBe((await derivePoolKeys(privateKeyToAccount(KEY_A))).spendingSecret);
    keys.clear();
    expect(keys.poolKeys()).not.toBe(first);
    wallet.lock();
    expect(() => keys.poolKeys()).toThrow(/locked/);
  });

  it('reserves channel indices per account and network and recognises their tags', async () => {
    const { wallet, keys } = await ring();
    expect(keys.channelCount()).toBe(0);
    const [a, b] = await Promise.all([keys.newChannel(), keys.newChannel()]);
    expect([a.index, b.index].sort()).toEqual([0, 1]);
    expect(keys.channelCount()).toBe(2);
    expect(keys.channelCount(undefined, 'other')).toBe(0);
    const pool = await keys.poolKeys();
    expect(a.secrets).toEqual(channelSecrets(pool, a.index));
    const tags = await keys.channelTags();
    expect(tags.size).toBe(2 + 16);
    expect(tags.get(ownerTagOf(channelSecrets(pool, 17).tagSecret))).toBe(17);
    expect(tags.has(pool.ownerTag)).toBe(false);
    await wallet.setNetwork('other');
    expect(keys.channelCount()).toBe(0);
  });
});
