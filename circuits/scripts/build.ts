// Compiles the four circuits, runs the Groth16 setup (phase 2 on top of the PSE powers of tau), publishes
// the proving files to packages/framework/artifacts/ and generates the on-chain verifier
// contracts/src/generated/Verifier.sol from the verifying keys. Usage: node circuits/scripts/build.ts [--fresh-setup]
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zKey } from 'snarkjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'circuits/src');
const BUILD = join(ROOT, 'circuits/build');
const ARTIFACTS = join(ROOT, 'packages/framework/artifacts');
const VERIFIER = join(ROOT, 'contracts/src/generated/Verifier.sol');

/** The order is the circuit id the on-chain verifier takes: 0 transfer, 1 finalize, 2 reclaim, 3 submit_state. */
const CIRCUITS = ['transfer', 'finalize', 'reclaim', 'submit_state'] as const;
const PTAU = process.env.CALYPTRA_PTAU ?? join(homedir(), '.local/share/calyptra-tools/ptau/ppot_0080_17.ptau');
const freshSetup = process.argv.includes('--fresh-setup');

/** Cache key of every circuit: all .circom sources (path and bytes) and the circomlib version. */
function sourcesHash(): string {
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.circom')) {
        h.update(path);
        h.update(readFileSync(path));
      }
    }
  };
  walk(SRC);
  const circomlib = JSON.parse(readFileSync(join(ROOT, 'node_modules/circomlib/package.json'), 'utf8')) as { version: string };
  h.update(circomlib.version);
  return h.digest('hex');
}

function compile(name: string, out: string): void {
  mkdirSync(out, { recursive: true });
  execFileSync(
    'circom',
    [`circuits/src/${name}.circom`, '--O2', '--r1cs', '--wasm', '--sym', '-l', join(ROOT, 'node_modules'), '-o', out],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  copyFileSync(join(out, `${name}_js`, `${name}.wasm`), join(out, `${name}.wasm`));
}

/** Groth16 phase 2: one contribution by the team with fresh entropy (test deployments only). */
async function setup(name: string, out: string): Promise<void> {
  const initial = join(out, `${name}_0000.zkey`);
  const final = join(out, `${name}.zkey`);
  await zKey.newZKey(join(out, `${name}.r1cs`), PTAU, initial);
  await zKey.contribute(initial, final, 'calyptra-team', randomBytes(64).toString('hex'));
  const vk = await zKey.exportVerificationKey(final);
  writeFileSync(join(out, `${name}.vkey.json`), JSON.stringify(vk, null, 2));
}

// ---------------------------------------------------------------------------------------------------
// On-chain verifier (Monad port): one contract holding the four verifying keys, dispatched by circuit id.

interface VerifyingKey {
  alpha: string[];
  beta: string[];
  gamma: string[];
  delta: string[];
  ic: string[][];
}

const isStrings = (v: unknown, length: number): v is string[] =>
  Array.isArray(v) && v.length >= length && v.every((x) => typeof x === 'string');

/** 32-byte big-endian word as a Solidity hex literal. */
const word = (v: string): string => `0x${BigInt(v).toString(16).padStart(64, '0')}`;

function g1(p: unknown, what: string): string[] {
  if (!isStrings(p, 2)) throw new Error(`${what} is not a G1 point`);
  return [word(p[0] as string), word(p[1] as string)];
}

/** EVM precompile order of a G2 point: x_c1, x_c0, y_c1, y_c0. */
function g2(p: unknown, what: string): string[] {
  if (!Array.isArray(p) || !isStrings(p[0], 2) || !isStrings(p[1], 2)) throw new Error(`${what} is not a G2 point`);
  const [x, y] = p as [string[], string[]];
  return [word(x[1] as string), word(x[0] as string), word(y[1] as string), word(y[0] as string)];
}

function readVerifyingKey(name: string): VerifyingKey {
  const path = join(BUILD, name, `${name}.vkey.json`);
  const vk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (vk.protocol !== 'groth16' || vk.curve !== 'bn128') throw new Error(`${path} is not a Groth16 BN254 key`);
  if (!Array.isArray(vk.IC) || vk.IC.length !== Number(vk.nPublic) + 1) throw new Error(`${path} has a malformed IC`);
  return {
    alpha: g1(vk.vk_alpha_1, `${name} alpha`),
    beta: g2(vk.vk_beta_2, `${name} beta`),
    gamma: g2(vk.vk_gamma_2, `${name} gamma`),
    delta: g2(vk.vk_delta_2, `${name} delta`),
    ic: vk.IC.map((p: unknown, i) => g1(p, `${name} IC[${i}]`)),
  };
}

function keyBranch(id: number, name: string, vk: VerifyingKey): string {
  const words = [...vk.alpha, ...vk.beta, ...vk.gamma, ...vk.delta];
  const ic = vk.ic.flat();
  const lines = [
    `if (circuit == ${id}) {`,
    `            // ${name}: ${vk.ic.length - 1} public signals`,
    ...words.map((w, i) => `            vk[${i}] = ${w};`),
    `            ic = new uint256[](${ic.length});`,
    ...ic.map((w, i) => `            ic[${i}] = ${w};`),
    '        }',
  ];
  return lines.join('\n');
}

function verifierSource(keys: readonly VerifyingKey[]): string {
  const branches = keys.map((vk, id) => keyBranch(id, CIRCUITS[id] as string, vk)).join(' else ');
  return `// SPDX-License-Identifier: MIT
// Generated by circuits/scripts/build.ts from circuits/build/<name>/<name>.vkey.json. Do not edit.
// Every new trusted setup changes every key: rerun \`npm run setup\` to regenerate this file.
pragma solidity ^0.8.24;

/// @title Groth16 verifier (BN254) for the four Calyptra circuits.
/// @notice Checks e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1 with the key of the circuit
///         id (0 transfer, 1 finalize, 2 reclaim, 3 submit_state). It never reverts on bad input: an unknown
///         id, a wrong signal count, a proof word >= q, a signal >= r or a failing precompile return false.
contract Verifier {
    /// @dev BN254 scalar field r: every public signal must be below it.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev BN254 base field q: every proof coordinate must be below it.
    uint256 internal constant BASE_FIELD =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @param circuit 0 transfer, 1 finalize, 2 reclaim, 3 submit_state.
    /// @param proof [A.x, A.y, B.x_c1, B.x_c0, B.y_c1, B.y_c0, C.x, C.y].
    /// @param signals The circuit's public signals in declaration order.
    function verify(uint8 circuit, uint256[8] calldata proof, uint256[] calldata signals) external view returns (bool) {
        (uint256[14] memory vk, uint256[] memory ic) = _key(circuit);
        if (ic.length == 0) return false;
        if (signals.length + 1 != ic.length / 2) return false;
        for (uint256 i = 0; i < 8; i++) {
            if (proof[i] >= BASE_FIELD) return false;
        }

        // vk_x = IC[0] + sum(signals[i] * IC[i + 1])
        uint256 accX = ic[0];
        uint256 accY = ic[1];
        for (uint256 i = 0; i < signals.length; i++) {
            if (signals[i] >= SNARK_SCALAR_FIELD) return false;
            (bool mulOk, uint256 termX, uint256 termY) = _ecMul(ic[2 * i + 2], ic[2 * i + 3], signals[i]);
            if (!mulOk) return false;
            bool addOk;
            (addOk, accX, accY) = _ecAdd(accX, accY, termX, termY);
            if (!addOk) return false;
        }

        uint256[24] memory input;
        // (-A, B)
        input[0] = proof[0];
        input[1] = proof[1] == 0 ? 0 : BASE_FIELD - proof[1];
        input[2] = proof[2];
        input[3] = proof[3];
        input[4] = proof[4];
        input[5] = proof[5];
        // (alpha, beta)
        for (uint256 i = 0; i < 6; i++) {
            input[6 + i] = vk[i];
        }
        // (vk_x, gamma)
        input[12] = accX;
        input[13] = accY;
        for (uint256 i = 0; i < 4; i++) {
            input[14 + i] = vk[6 + i];
        }
        // (C, delta)
        input[18] = proof[6];
        input[19] = proof[7];
        for (uint256 i = 0; i < 4; i++) {
            input[20 + i] = vk[10 + i];
        }

        // ecPairing (0x08): 4 pairs x 192 bytes; true only if the call succeeds and returns the word 1.
        bool ok;
        uint256 result;
        assembly ("memory-safe") {
            // Separate statements: Yul evaluates arguments right to left, so returndatasize() must come after the call.
            let success := staticcall(gas(), 0x08, input, 0x300, 0x00, 0x20)
            ok := and(success, eq(returndatasize(), 0x20))
            result := mload(0x00)
        }
        return ok && result == 1;
    }

    /// @dev ecMul (0x07): 96 bytes in, exactly 64 bytes back, otherwise not ok.
    function _ecMul(uint256 x, uint256 y, uint256 s) private view returns (bool ok, uint256 rx, uint256 ry) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, x)
            mstore(add(p, 0x20), y)
            mstore(add(p, 0x40), s)
            let success := staticcall(gas(), 0x07, p, 0x60, p, 0x40)
            ok := and(success, eq(returndatasize(), 0x40))
            rx := mload(p)
            ry := mload(add(p, 0x20))
        }
    }

    /// @dev ecAdd (0x06): 128 bytes in, exactly 64 bytes back, otherwise not ok.
    function _ecAdd(uint256 ax, uint256 ay, uint256 bx, uint256 by)
        private
        view
        returns (bool ok, uint256 rx, uint256 ry)
    {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, ax)
            mstore(add(p, 0x20), ay)
            mstore(add(p, 0x40), bx)
            mstore(add(p, 0x60), by)
            let success := staticcall(gas(), 0x06, p, 0x80, p, 0x40)
            ok := and(success, eq(returndatasize(), 0x40))
            rx := mload(p)
            ry := mload(add(p, 0x20))
        }
    }

    /// @dev vk = alpha (G1), beta, gamma, delta (G2, x_c1 x_c0 y_c1 y_c0); ic = IC points as x, y pairs.
    ///      An unknown circuit id returns an empty ic.
    function _key(uint8 circuit) private pure returns (uint256[14] memory vk, uint256[] memory ic) {
        ${branches}
    }
}
`;
}

function writeVerifier(): void {
  const keys = CIRCUITS.map((name) => readVerifyingKey(name));
  mkdirSync(dirname(VERIFIER), { recursive: true });
  writeFileSync(VERIFIER, verifierSource(keys));
}

async function main(): Promise<void> {
  if (!existsSync(PTAU)) throw new Error(`powers of tau not found at ${PTAU} (run scripts/setup-tools.sh)`);
  const hash = sourcesHash();
  for (const name of CIRCUITS) {
    const out = join(BUILD, name);
    const stamp = join(out, 'sources.sha256');
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === hash && existsSync(join(out, `${name}.zkey`)) && !freshSetup) {
      console.log(`${name}: up to date`);
      continue;
    }
    console.log(`${name}: compiling`);
    compile(name, out);
    console.log(`${name}: groth16 setup`);
    await setup(name, out);
    writeFileSync(stamp, hash);
  }
  mkdirSync(ARTIFACTS, { recursive: true });
  for (const name of CIRCUITS) {
    for (const ext of ['wasm', 'zkey', 'vkey.json']) {
      copyFileSync(join(BUILD, name, `${name}.${ext}`), join(ARTIFACTS, `${name}.${ext}`));
    }
  }
  writeVerifier();
  console.log('artifacts published');
  process.exit(0); // snarkjs keeps worker threads alive
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
