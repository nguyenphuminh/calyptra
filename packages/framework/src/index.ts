// Public API of the Calyptra framework. Hosts build on `Calyptra`; the module classes are exported for
// hosts that compose services themselves (the desktop client's relayer mode, tests).
export { Calyptra } from './calyptra.ts';
export type { CalyptraOptions } from './calyptra.ts';
export { AppError, isAppError } from './shared/errors/AppError.ts';
export { Prover, fileArtifacts, urlArtifacts } from './shared/integrations/prover.ts';
export type { ArtifactLoader, CircuitName, ProofResult, ProverPort } from './shared/integrations/prover.ts';
export * from './modules/chain/index.ts';
export * from './modules/channel/index.ts';
export * from './modules/dispute/index.ts';
export * from './modules/keys/index.ts';
export * from './modules/p2p/index.ts';
export * from './modules/pool/index.ts';
export * from './modules/relayer/index.ts';
export * from './modules/storage/index.ts';
export * from './modules/wallet/index.ts';
export * from './modules/subscription/index.ts';
export * from './modules/merchant/index.ts';
