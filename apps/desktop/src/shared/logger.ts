import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger };

/** Structured JSON logs on stderr; stdout carries only command results and the ready line. */
export function createLogger(level: string): Logger {
  return pino({ level, base: { app: 'calyptra-desktop' } }, pino.destination({ dest: 2, sync: true }));
}
