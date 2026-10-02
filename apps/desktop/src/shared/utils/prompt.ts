import { AppError } from '@calyptra/framework';

/**
 * A secret from the environment, or typed on the terminal without echo. Prompts go to stderr so
 * stdout stays machine-readable; without a terminal the environment variable is required.
 */
export function readSecret(envName: string, question: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv !== '') return Promise.resolve(fromEnv);
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    return Promise.reject(
      new AppError(400, 'SECRET_REQUIRED', `${question.replace(/[:\s]+$/, '')} is needed: set ${envName} or run in a terminal`),
    );
  }
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new AppError(400, 'CANCELLED', 'Cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
