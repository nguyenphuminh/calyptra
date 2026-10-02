import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AppError, isAppError } from '@calyptra/framework';
import { z } from 'zod';
import { COMMANDS, findCommand, runCommand } from '../node/index.ts';
import type { Command, NodeService } from '../node/index.ts';

/** Splits a shell line into words, keeping "quoted text" together. */
export function tokenize(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** `<arg>` when required, `[arg]` when optional; 'no arguments' when the command takes none. */
function usageOf(command: Command, empty = 'no arguments'): string {
  if (command.args.length === 0) return empty;
  const shape = command.schema.shape as Record<string, z.ZodType | undefined>;
  return command.args.map((a) => (shape[a]?.safeParse(undefined).success ? `[${a}]` : `<${a}>`)).join(' ');
}

/** Names a command's positional words after its arguments. */
export function inputOf(command: Command, words: readonly string[]): Record<string, string> {
  if (words.length > command.args.length) throw new AppError(400, 'TOO_MANY_ARGUMENTS', `${command.name} takes ${usageOf(command)}`);
  return Object.fromEntries(words.map((w, i) => [command.args[i] as string, w]));
}

export function helpText(): string {
  const rows = COMMANDS.map((c) => `  ${`${c.name} ${usageOf(c, '')}`.padEnd(58)}${c.summary}`);
  return ['Commands (amounts in native-coin or stablecoin units, e.g. 0.01):', ...rows, '  help', '  exit'].join('\n');
}

/** One line per error, the same format for the shell and for fatal errors of `main`. */
export function formatError(err: unknown): string {
  if (isAppError(err)) return `error ${err.code}: ${err.message}`;
  if (err instanceof z.core.$ZodError) {
    return `error INVALID_INPUT: ${err.issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ')}`;
  }
  return `error: ${err instanceof Error ? err.message : String(err)}`;
}

/** The interactive shell over the node's commands. */
export class ShellService {
  private readonly node: NodeService;

  constructor(node: NodeService) {
    this.node = node;
  }

  /** Runs one line; never throws (errors become their formatted line). */
  async execute(line: string): Promise<string> {
    const [name, ...words] = tokenize(line);
    if (name === undefined) return '';
    if (name === 'help') return helpText();
    try {
      const result = await runCommand(this.node, name, inputOf(findCommand(name), words));
      return typeof result === 'string' ? result : JSON.stringify(result, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
    } catch (err) {
      return formatError(err);
    }
  }

  /** Reads lines until `exit` or end of input; lines run strictly one after another. */
  run(input: Readable, output: Writable): Promise<void> {
    const rl = createInterface({ input, output, prompt: 'calyptra> ' });
    let queue: Promise<void> = Promise.resolve();
    let closed = false;
    output.write('Type "help" for the list of commands.\n');
    rl.prompt();
    rl.on('line', (line) => {
      if (line.trim() === 'exit') {
        rl.close();
        return;
      }
      queue = queue.then(async () => {
        const out = await this.execute(line);
        if (out !== '') output.write(`${out}\n`);
        if (!closed) rl.prompt();
      });
    });
    return new Promise((resolve) => {
      rl.on('close', () => {
        closed = true;
        void queue.then(resolve);
      });
    });
  }
}
