// npm run build:contracts [-- --e2e]: builds the four contracts and checks each one's deployed code size
// against Monad's limit. --e2e builds the Disputes contract in its short-window test variant (10 s minimum).
import { MAX_CODE_SIZE, buildContracts } from './lib/deploy.ts';

const built = buildContracts({ e2e: process.argv.includes('--e2e') });
for (const [name, contract] of Object.entries(built)) {
  console.log(`${name.padEnd(9)} ${String(contract.size).padStart(6)} bytes (limit ${MAX_CODE_SIZE})`);
}
