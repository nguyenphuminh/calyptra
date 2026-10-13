// The test stablecoin for local chains: a plain 6-decimal ERC-20 that anyone can
// mint, compiled at test time with solc-js from e2e/contracts/TestStablecoin.sol. Never for a public network.
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import type { DeployWallet } from './deploy.ts';
import { REPO } from './devnode.ts';

const SOURCE = `${REPO}/e2e/contracts/TestStablecoin.sol`;

const OutputSchema = z.object({
  errors: z.array(z.object({ severity: z.string(), formattedMessage: z.string() })).optional(),
  contracts: z
    .record(z.string(), z.record(z.string(), z.object({
      abi: z.array(z.record(z.string(), z.unknown())),
      evm: z.object({ bytecode: z.object({ object: z.string().regex(/^[0-9a-fA-F]*$/) }) }),
    })))
    .optional(),
});

export function compileTestToken(): { abi: Abi; bytecode: Hex } {
  const input = {
    language: 'Solidity',
    sources: { 'TestStablecoin.sol': { content: readFileSync(SOURCE, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const compile = solc.compile as (input: string) => string;
  const output = OutputSchema.parse(JSON.parse(compile(JSON.stringify(input))));
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const contract = output.contracts?.['TestStablecoin.sol']?.['TestStablecoin'];
  if (!contract) throw new Error('TestStablecoin missing from the compiler output');
  return { abi: contract.abi as unknown as Abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

export async function deployTestToken(wallet: DeployWallet, client: PublicClient): Promise<Address> {
  const { abi, bytecode } = compileTestToken();
  const hash = await wallet.deployContract({ abi, bytecode });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('test token deployment failed');
  return receipt.contractAddress;
}
