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

/** Monad's reserve-balance rule: an account keeps 10 MON for the fees of transactions in flight, or its
 *  transactions can fail while still paying gas. Other chains (anvil) have no reserve. */
export const MONAD_RESERVE_BALANCE = 10n ** 19n;
const MONAD_CHAIN_IDS = new Set([10143, 143]);   // testnet, mainnet

/** The native balance an account of this chain must keep untouched. */
export const reserveBalanceOf = (chainId: number): bigint => (MONAD_CHAIN_IDS.has(chainId) ? MONAD_RESERVE_BALANCE : 0n);
