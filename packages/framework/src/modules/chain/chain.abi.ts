import { parseAbi } from 'viem';

// The client decodes with exactly these signatures; the contracts expose exactly them.

export const poolAbi = parseAbi([
  'function initialize(address stablecoin, address verifier, address hasher, address disputes)',
  'function deposit(address token, uint256 amount, uint256 inner, bytes ciphertext) payable',
  'function transact(uint256[8] proof, uint256[9] signals, address recipient, bytes ciphertexts)',
  'function settle(uint256 root, uint256 nf0, uint256 nf1, uint256[3] outputs, bytes ciphertexts)',
  'function root() view returns (uint256)',
  'function isKnownRoot(uint256 root) view returns (bool)',
  'function isSpent(uint256 nullifier) view returns (bool)',
  'event NewCommitment(uint256 indexed commitment, uint256 leafIndex, bytes ciphertext)',
  'event NewNullifier(uint256 indexed nullifier)',
  'error NotInitialized()', 'error AlreadyInitialized()', 'error Unauthorized()', 'error UnknownRoot()',
  'error NullifierAlreadySpent()', 'error DuplicateNullifier()', 'error InvalidProof()', 'error InvalidAmount()',
  'error InvalidField()', 'error TokenNotAllowed()', 'error InvalidValue()', 'error InvalidCiphertext()',
  'error InvalidExtData()', 'error InvalidRecipient()', 'error TreeFull()', 'error TransferFailed()',
]);

export const disputesAbi = parseAbi([
  'function initialize(address pool, address verifier)',
  'function submitState(uint256[8] proof, uint256[5] signals)',
  'function finalize(uint256[8] proof, uint256[9] signals, bytes ciphertexts)',
  'function reclaim(uint256[8] proof, uint256[8] signals, bytes ciphertexts)',
  'function disputeOf(uint256 channelNullifier) view returns (bool pending, uint256 nonce, uint256 stateHash, uint256 deadline)',
  'function isFinalized(uint256 channelNullifier) view returns (bool)',
  'function windowBounds() view returns (uint64 min, uint64 max)',
  'event DisputeSubmitted(uint256 indexed channelNullifier, uint256 nonce, uint256 stateHash, uint256 deadline)',
  'event ChannelFinalized(uint256 indexed channelNullifier)',
  'error NotInitialized()', 'error AlreadyInitialized()', 'error UnknownRoot()', 'error InvalidProof()',
  'error InvalidExtData()', 'error InvalidWindow()', 'error ChannelAlreadyFinalized()', 'error StaleState()',
  'error NoPendingDispute()', 'error StateMismatch()', 'error DeadlineNotReached()', 'error ChannelNotFinalized()',
  'error SettlementFailed()',
]);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
]);
