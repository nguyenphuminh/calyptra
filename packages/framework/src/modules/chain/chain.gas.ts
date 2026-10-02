// Monad charges the declared gas LIMIT, not the gas used (§11.2), so every transaction the wallet sends
// from the user's own address carries an explicit limit: the measured worst case plus 10-15 %.
// Source: contracts/test/Gas.t.sol (Foundry's Monad gas schedule), which asserts these figures:
//   deposit worst case = the first deposit into the empty tree, 1,161,092 (stablecoin) / 1,096,164 (native);
//   later deposits ~753k / ~821k. A TestStablecoin approve measured 46,115 on anvil.
// Re-measure on Monad testnet (§13.1 V3) and update these two values; nothing else needs to change.

/** ERC-20 `approve` of the pool before a stablecoin deposit. Generous because the real AUSD (an
 *  upgradeable token) has not been measured; the test stablecoin needs ~46k. */
export const APPROVE_GAS_LIMIT = 100_000n;
/** `Pool.deposit` (native coin or stablecoin): one Poseidon commitment plus a depth-20 tree insert
 *  (Gas.t.sol DEPOSIT_GAS_LIMIT). */
export const DEPOSIT_GAS_LIMIT = 1_350_000n;

/** Monad's reserve balance (docs.monad.xyz/developer-essentials/reserve-balance): a transaction that sends
 *  MON reverts, still paying its gas, when it leaves the sender below min(its balance, 10 MON) less the
 *  transaction's own gas, unless the sender sent no other transaction in the last 3 blocks (the emptying
 *  exception). A transaction that sends no MON never reverts because of it. Other chains (anvil) have none. */
export const MONAD_RESERVE_BALANCE = 10n ** 19n;
/** The emptying exception's window, k = 3 blocks (about 1.2 s). */
export const MONAD_RESERVE_BLOCKS = 3n;
const MONAD_CHAIN_IDS = new Set([10143, 143]);   // testnet, mainnet

/** The reserve balance of this chain: 10 MON on Monad, none elsewhere. */
export const reserveBalanceOf = (chainId: number): bigint => (MONAD_CHAIN_IDS.has(chainId) ? MONAD_RESERVE_BALANCE : 0n);
