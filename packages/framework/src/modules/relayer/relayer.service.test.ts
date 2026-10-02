import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bytesToHex, concatHex, defineChain, keccak256, parseTransaction, toHex, zeroAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptNote, noteCommitment, randomFieldElement, type NotePreimage } from '../../shared/protocol/index.ts';
import { MONAD_RESERVE_BALANCE, type ChainAdapter } from '../chain/index.ts';
import { derivePoolKeys, shieldedAddressOf, type PoolKeys } from '../keys/index.ts';
import { DirectRelayer, quotedFee } from './relayer.client.ts';
import type { RelayRequest } from './relayer.schema.ts';
import { DEFAULT_GAS_LIMITS, RelayerService } from './relayer.service.ts';

const STABLECOIN = '0x00000000000000000000000000000000000000AA';
const POOL = '0x1111111111111111111111111111111111111111';
const DISPUTES = '0x2222222222222222222222222222222222222222';
const MAX_FEE_PER_GAS = 100n;

/** A JSON-RPC endpoint that accepts raw transactions and remembers them. */
let server: Server;
let rpcUrl = '';
const sent: { nonce: number | undefined; gas: bigint | undefined; to: string | null | undefined }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      let result: unknown;
      if (method === 'eth_chainId') result = toHex(31337);
      if (method === 'eth_sendRawTransaction') {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        sent.push({ nonce: tx.nonce, gas: tx.gas, to: tx.to });
        result = keccak256(raw);
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } } : { jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

function chainOf(options: { chainId?: number; balance?: bigint } = {}) {
  const calls = { simulated: [] as { functionName: string; gas: bigint }[], nonceReads: 0 };
  const client = {
    simulateContract: async (call: { functionName: string; gas: bigint }) => {
      calls.simulated.push({ functionName: call.functionName, gas: call.gas });
      return { result: undefined };
    },
    estimateFeesPerGas: async () => ({ maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 1n }),
    getBalance: async () => options.balance ?? 10n ** 20n,
    getTransactionCount: async () => {
      calls.nonceReads++;
      return 7;
    },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };
  const chainId = options.chainId ?? 31337;
  const chain = {
    network: { chainId, stablecoin: STABLECOIN },
    contracts: () => ({ pool: POOL, disputes: DISPUTES, deployBlock: 0n }),
    client,
    rpcUrl,
    chain: defineChain({ id: chainId, name: 'Test', nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }),
  };
  return { chain: chain as unknown as ChainAdapter, calls };
}

let keys: PoolKeys;
beforeAll(async () => {
  keys = await derivePoolKeys(privateKeyToAccount(generatePrivateKey()));
});

const fees = { [zeroAddress]: 100n, [STABLECOIN]: 10_000n };
const filler = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(168)));

/** A transact request whose third output is `fee`, encrypted to `to`. */
function transact(fee: NotePreimage, to: Uint8Array, commitment = noteCommitment(fee)): RelayRequest {
  return {
    kind: 'transact',
    proof: Array(8).fill('1'),
    signals: [...Array(8).fill('1'), commitment.toString()],
    recipient: zeroAddress,
    ciphertexts: concatHex([filler(), filler(), bytesToHex(encryptNote(to, fee))]),
  };
}
const feeNote = (amount: bigint, token = 0n): NotePreimage => ({ amount, token, ownerTag: keys.ownerTag, salt: randomFieldElement() });

describe('RelayerService', () => {
  it('publishes its chain, shielded address and fees by lowercase token address', async () => {
    const { chain } = chainOf();
    const relayer = new DirectRelayer(new RelayerService(chain, { account: privateKeyToAccount(generatePrivateKey()), keys, fees }));
    const info = await relayer.info();
    expect(info).toEqual({ chainId: 31337, shieldedAddress: shieldedAddressOf(keys), fees: { [zeroAddress]: '100', [STABLECOIN.toLowerCase()]: '10000' } });
    expect(quotedFee(info, BigInt(STABLECOIN))).toBe(10_000n);
    expect(() => quotedFee(info, 5n)).toThrow('This relayer does not accept fees in that token');
  });

  it('checks the fee note before submitting anything', async () => {
    const { chain, calls } = chainOf();
    const service = new RelayerService(chain, { account: privateKeyToAccount(generatePrivateKey()), keys, fees });
    const other = await derivePoolKeys(privateKeyToAccount(generatePrivateKey()));
    await expect(service.relay({ ...transact(feeNote(100n), keys.encryption.publicKey), ciphertexts: filler() })).rejects.toMatchObject({ code: 'BAD_CIPHERTEXTS' });
    await expect(service.relay(transact(feeNote(100n), other.encryption.publicKey))).rejects.toMatchObject({
      code: 'NO_FEE_NOTE', message: 'The third output is not a fee note for this relayer',
    });
    await expect(service.relay(transact(feeNote(100n), keys.encryption.publicKey, 1n))).rejects.toMatchObject({ code: 'FEE_NOTE_MISMATCH' });
    await expect(service.relay(transact(feeNote(100n, 5n), keys.encryption.publicKey))).rejects.toMatchObject({ code: 'TOKEN_NOT_ACCEPTED' });
    await expect(service.relay(transact(feeNote(99n), keys.encryption.publicKey))).rejects.toMatchObject({
      code: 'FEE_TOO_LOW', message: "The fee is below this relayer's quote of 100",
    });
    await expect(service.relay({ kind: 'transact', proof: [] })).rejects.toThrow();
    expect(calls.simulated).toEqual([]);
  });

  it('declares an explicit gas limit per kind and tracks its nonce locally', async () => {
    const { chain, calls } = chainOf();
    const service = new RelayerService(chain, { account: privateKeyToAccount(generatePrivateKey()), keys, fees, gasLimits: { submitState: 1_234_567n } });
    sent.length = 0;
    await service.relay(transact(feeNote(100n), keys.encryption.publicKey));
    await service.relay({ kind: 'submitState', proof: Array(8).fill('1'), signals: Array(5).fill('2') });
    expect(calls.simulated).toEqual([
      { functionName: 'transact', gas: DEFAULT_GAS_LIMITS.transact },
      { functionName: 'submitState', gas: 1_234_567n },
    ]);
    expect(sent).toEqual([
      { nonce: 7, gas: DEFAULT_GAS_LIMITS.transact, to: POOL },
      { nonce: 8, gas: 1_234_567n, to: DISPUTES },
    ]);
    expect(calls.nonceReads).toBe(1);
  });

  it('refuses to submit when the account would fall below its reserve', async () => {
    const gasCost = DEFAULT_GAS_LIMITS.transact * MAX_FEE_PER_GAS;
    const low = chainOf({ balance: 10n ** 18n + gasCost - 1n });
    const service = new RelayerService(low.chain, { account: privateKeyToAccount(generatePrivateKey()), keys, fees, reserve: 10n ** 18n });
    await expect(service.relay(transact(feeNote(100n), keys.encryption.publicKey))).rejects.toMatchObject({ code: 'RESERVE_TOO_LOW', statusCode: 503 });
    const monad = chainOf({ chainId: 10143, balance: MONAD_RESERVE_BALANCE });
    const onMonad = new RelayerService(monad.chain, { account: privateKeyToAccount(generatePrivateKey()), keys, fees });
    await expect(onMonad.relay(transact(feeNote(100n), keys.encryption.publicKey))).rejects.toMatchObject({ code: 'RESERVE_TOO_LOW' });
    const enough = chainOf({ balance: gasCost });
    sent.length = 0;
    await new RelayerService(enough.chain, { account: privateKeyToAccount(generatePrivateKey()), keys, fees }).relay(transact(feeNote(100n), keys.encryption.publicKey));
    expect(sent).toHaveLength(1);
  });
});
