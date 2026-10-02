import { PassThrough, Readable } from 'node:stream';
import { Calyptra, MemoryStore } from '@calyptra/framework';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { NodeService, findCommand } from '../node/index.ts';
import { ShellService, helpText, inputOf, tokenize } from './shell.service.ts';

/** An offline node: memory storage, no proofs, no libp2p, no relayers. */
async function offlineNode(): Promise<NodeService> {
  const calyptra = new Calyptra({
    store: new MemoryStore(),
    artifacts: async () => ({ wasm: '', zkey: '' }),
    createNode: () => Promise.reject(new Error('offline')),
    kdf: { N: 2 ** 10, r: 8, p: 1 },
    relayers: [],
    libp2pRelays: [],
  });
  await calyptra.wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
  await calyptra.start();
  return new NodeService(calyptra, { roles: () => ({ relayer: null, libp2pRelay: null }) });
}

describe('shell parsing', () => {
  it('splits words and keeps quoted text together', () => {
    expect(tokenize('transfer cal00 native 0.5')).toEqual(['transfer', 'cal00', 'native', '0.5']);
    expect(tokenize(`export "/tmp/my wallet.json" 'single quoted'`)).toEqual(['export', '/tmp/my wallet.json', 'single quoted']);
    expect(tokenize('   ')).toEqual([]);
  });

  it('names positional words after the command arguments', () => {
    expect(inputOf(findCommand('channel.pay'), ['abc', '0.01'])).toEqual({ channel: 'abc', amount: '0.01' });
    expect(inputOf(findCommand('withdraw'), ['native', '1'])).toEqual({ token: 'native', amount: '1' });
    expect(() => inputOf(findCommand('channel.pay'), ['abc', '0.01', 'extra'])).toThrow('takes <channel> <amount>');
  });

  it('lists required and optional arguments in the help', () => {
    const help = helpText();
    expect(help).toContain('withdraw <token> <amount> [to]');
    expect(help).toContain('channel.open <invite> <token> <amount> [peerAmount] [window]');
    expect(help.split('\n')[0]).toBe('Commands (amounts in native-coin or stablecoin units, e.g. 0.01):');
    expect(help.endsWith('  help\n  exit')).toBe(true);
  });
});

describe('ShellService', () => {
  let shell: ShellService;
  let node: NodeService;
  beforeAll(async () => {
    node = await offlineNode();
    shell = new ShellService(node);
  });

  it('runs commands and prints every error in one format', async () => {
    expect(await shell.execute('frobnicate')).toBe('error UNKNOWN_COMMAND: Unknown command "frobnicate"');
    expect(await shell.execute('deposit native')).toMatch(/^error INVALID_INPUT: amount/);
    expect(await shell.execute('channels')).toMatch(/^error NO_RELAY: /);
    expect(await shell.execute('')).toBe('');
    expect(await shell.execute('address')).toMatch(/^cal[0-9a-f]{136}$/);
    expect(await shell.execute('help')).toBe(helpText());
  });

  it('reads lines from a stream until exit', async () => {
    const input = Readable.from(['account.add\naccounts\nexit\n']);
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    await new ShellService(node).run(input, output);
    expect(text).toContain('Type "help" for the list of commands.');
    expect(text).toContain('"label": "Account 2"');
    expect(text.match(/"label"/g)).toHaveLength(3);
  });
});
