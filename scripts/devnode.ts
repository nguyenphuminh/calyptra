// npm run devnode -- start | stop | status | reset   (default: status)
import { DEVNODE_RPC, isUp, resetDevnode, startDevnode, stopDevnode } from './lib/devnode.ts';

const command = process.argv[2] ?? 'status';
switch (command) {
  case 'start':
    await startDevnode();
    console.log(`dev node running at ${DEVNODE_RPC}`);
    break;
  case 'stop':
    await stopDevnode();
    console.log('dev node stopped');
    break;
  case 'reset':
    await resetDevnode();
    console.log('dev node stopped and its data deleted');
    break;
  case 'status':
    console.log((await isUp()) ? `running at ${DEVNODE_RPC}` : 'not running');
    break;
  default:
    console.error('usage: npm run devnode -- start | stop | status | reset');
    process.exit(1);
}
