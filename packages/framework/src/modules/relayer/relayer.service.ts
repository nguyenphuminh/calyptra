import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  hexToBytes,
  http,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import { CIPHERTEXT_SIZE, decryptNote, noteCommitment } from '../../shared/protocol/index.ts';
import { disputesAbi, poolAbi, tokenAddress, type ChainAdapter } from '../chain/index.ts';
import { shieldedAddressOf, type PoolKeys } from '../keys/index.ts';
import { RelayRequestSchema, type RelayKind, type RelayRequest, type RelayResult, type RelayerInfo } from './relayer.schema.ts';

/** Position of the fee note's commitment in each kind of public signals. */
const FEE_SIGNAL = { transact: 8, finalize: 6, reclaim: 6 } as const;

/**
 * Gas limit declared for each kind of relayed call. Monad charges the declared limit, not the gas used,
 * so every transaction carries an explicit limit: the worst case measured on the Solidity contracts
 * with real proofs under Foundry's Monad gas schedule (a 3-leaf tree insert at the worst alignment)
 * plus 12-15 %, as recommended by contracts/test/Gas.t.sol. Operators can override them through
 * `RelayerOptions.gasLimits` once measured on Monad testnet.
 */
export const DEFAULT_GAS_LIMITS: Readonly<Record<RelayKind, bigint>> = {
  transact: 3_000_000n,
  finalize: 3_000_000n,
  reclaim: 2_950_000n,
  submitState: 1_380_000n,
};

/** Monad produces a block about every 300 ms, so receipts are polled often. */
const RECEIPT_POLLING_MS = 250;

export interface RelayerOptions {
  /** Pays gas; signs transactions. */
  account: LocalAccount;
  /** Its pool keys receive (and decrypt) the fee notes. */
  keys: PoolKeys;
  /** Minimum fee per accepted token (zero address = native coin), base units. */
  fees: Record<string, bigint>;
  /** Gas limit per kind of call (default DEFAULT_GAS_LIMITS). */
  gasLimits?: Partial<Record<RelayKind, bigint>>;
  /** Native balance the account keeps on top of each transaction's gas, as the operator's margin (default 0:
   *  relayed calls send no MON, so Monad's 10 MON reserve never makes them revert). */
  reserve?: bigint;
}

interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** The server side of a relayer: checks the fee note, simulates, and submits from its own account. */
export class RelayerService {
  private readonly chain: ChainAdapter;
  private readonly options: RelayerOptions;
  private readonly gasLimits: Readonly<Record<RelayKind, bigint>>;
  private readonly reserve: bigint;
  /** One transaction at a time: nonces never collide. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The next nonce of the account, tracked locally (on Monad `pending` behaves like `latest`); null = read it from the chain. */
  private nonce: number | null = null;

  constructor(chain: ChainAdapter, options: RelayerOptions) {
    this.chain = chain;
    this.options = options;
    this.gasLimits = { ...DEFAULT_GAS_LIMITS, ...options.gasLimits };
    this.reserve = options.reserve ?? 0n;
  }

  info(): RelayerInfo {
    return {
      chainId: this.chain.network.chainId,
      shieldedAddress: shieldedAddressOf(this.options.keys),
      fees: Object.fromEntries(Object.entries(this.options.fees).map(([token, fee]) => [token.toLowerCase(), fee.toString()])),
    };
  }

  async relay(input: unknown): Promise<RelayResult> {
    const request = RelayRequestSchema.parse(input);
    if (request.kind !== 'submitState') {
      this.checkFeeNote(request.ciphertexts, BigInt(request.signals[FEE_SIGNAL[request.kind]] as string));
    }
    const run = this.queue.then(() => this.send(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkFeeNote(ciphertexts: Hex, commitment: bigint): void {
    const { keys, fees } = this.options;
    const bytes = hexToBytes(ciphertexts);
    if (bytes.length !== 3 * CIPHERTEXT_SIZE) throw new AppError(400, 'BAD_CIPHERTEXTS', 'Expected three note ciphertexts');
    const note = decryptNote(keys.encryption, bytes.slice(2 * CIPHERTEXT_SIZE));
    if (!note || note.ownerTag !== keys.ownerTag) throw new AppError(402, 'NO_FEE_NOTE', 'The third output is not a fee note for this relayer');
    if (noteCommitment(note) !== commitment) throw new AppError(402, 'FEE_NOTE_MISMATCH', 'The fee note does not match its commitment in the proof');
    const required = Object.entries(fees).find(([token]) => token.toLowerCase() === tokenAddress(note.token).toLowerCase())?.[1];
    if (required === undefined) throw new AppError(402, 'TOKEN_NOT_ACCEPTED', 'This relayer does not accept fees in that token');
    if (note.amount < required) throw new AppError(402, 'FEE_TOO_LOW', `The fee is below this relayer's quote of ${required}`);
  }

  private callOf(request: RelayRequest): ContractCall {
    const { pool, disputes } = this.chain.contracts();
    const proof = request.proof.map(BigInt);
    const signals = request.signals.map(BigInt);
    if (request.kind === 'transact') {
      return { address: pool, abi: poolAbi, functionName: 'transact', args: [proof, signals, request.recipient, request.ciphertexts] };
    }
    if (request.kind === 'submitState') {
      return { address: disputes, abi: disputesAbi, functionName: 'submitState', args: [proof, signals] };
    }
    return { address: disputes, abi: disputesAbi, functionName: request.kind, args: [proof, signals, request.ciphertexts] };
  }

  private async send(request: RelayRequest): Promise<RelayResult> {
    const call = this.callOf(request);
    const gas = this.gasLimits[request.kind];
    const { account } = this.options;
    // One endpoint for the whole submission: sent again through another, it could go through twice.
    const { client, rpcUrl } = this.chain;
    try {
      // Simulated with the declared limit, so a limit that is too low is refused before it costs anything.
      await client.simulateContract({ ...call, account, gas });
    } catch (err) {
      const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
      const reason = reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? reverted.shortMessage) : 'unknown reason';
      throw new AppError(422, 'WOULD_REVERT', `The transaction would fail on-chain: ${reason}`);
    }
    // Monad bills the declared gas limit: the balance pays it, plus the operator's reserve if one is set.
    const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
    const balance = await client.getBalance({ address: account.address });
    if (balance < this.reserve + gas * maxFeePerGas) {
      throw new AppError(503, 'RESERVE_TOO_LOW', 'The relayer’s balance cannot pay for gas right now; try again later');
    }
    const nonce = this.nonce ?? (await client.getTransactionCount({ address: account.address, blockTag: 'latest' }));
    const wallet = createWalletClient({ account, chain: this.chain.chain, transport: http(rpcUrl) });
    let txHash: Hex;
    try {
      txHash = await wallet.writeContract({ ...call, account, chain: this.chain.chain, gas, maxFeePerGas, maxPriorityFeePerGas, nonce });
    } catch (err) {
      this.nonce = null; // unknown whether it was sent: read the nonce from the chain next time
      throw err;
    }
    this.nonce = nonce + 1;
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: txHash, pollingInterval: RECEIPT_POLLING_MS });
      if (receipt.status !== 'success') throw new AppError(502, 'TRANSACTION_FAILED', `Transaction ${txHash} failed`);
    } catch (err) {
      if (!(err instanceof AppError)) this.nonce = null;
      throw err;
    }
    return { txHash };
  }
}
