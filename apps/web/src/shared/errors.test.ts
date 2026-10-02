import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError } from '@calyptra/framework';
import { describe, expect, it } from 'vitest';
import { ERROR_COPY, friendlyError } from './errors.ts';

const FRAMEWORK = resolve(import.meta.dirname, '../../../../packages/framework/src');

/** Every AppError code the framework throws (or a merchant sends back), from its source. */
function frameworkCodes(): Set<string> {
  const codes = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        for (const match of readFileSync(path, 'utf8').matchAll(/(?:new AppError\(\d+, |\berror\()'([A-Z_]+)'/g)) codes.add(match[1] ?? '');
      }
    }
  };
  walk(FRAMEWORK);
  return codes;
}

/** Words the website's error copy never uses (§11.6; the RPC check keeps its own words in Advanced). */
const JARGON = /\b(shielded|relayer|libp2p|channels?|nullifiers?|commitments?|proofs?|notes?|pool|contributions?|on-chain|transactions?|tokens?)\b/i;

describe('friendlyError', () => {
  it('has copy for every code the framework can throw', () => {
    const missing = [...frameworkCodes()].filter((code) => !(code in ERROR_COPY));
    expect(missing).toEqual([]);
  });

  it('speaks in the website’s words', () => {
    const texts = Object.values(ERROR_COPY).flatMap((copy) => (copy === null ? [] : typeof copy === 'string' ? [copy] : Object.values(copy)));
    expect(texts.filter((text) => JARGON.test(text))).toEqual([]);
  });

  it('maps codes, and messages of codes that have several', () => {
    expect(friendlyError(new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough shielded funds in this token (including the relayer fee)')))
      .toBe('Not enough in your private balance for this amount plus the network fee');
    expect(friendlyError(new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough balance in this channel'))).toBe('Not enough left in this tab');
    expect(friendlyError(new AppError(400, 'INVALID_SHIELDED_ADDRESS', 'The shielded address has a typo (checksum mismatch)'))).toBe('This Calyptra ID has a typo');
    expect(friendlyError(new AppError(503, 'PEER_UNREACHABLE', 'The other party is not reachable right now'))).toBe('The other side is not reachable right now');
    expect(friendlyError(new AppError(503, 'NO_RELAYER', 'No transaction relayer is configured for this network')))
      .toBe('No privacy relay is set up for this network. Add one in Settings › Advanced.');
  });

  it('keeps plain messages, the 18.44 MON cap, unknown codes and other errors as they are', () => {
    expect(friendlyError(new AppError(401, 'WRONG_PASSWORD', 'Wrong password'))).toBe('Wrong password');
    expect(friendlyError(new AppError(403, 'PAYMENT_DECLINED', 'The payment was not confirmed'))).toBe('The payment was not confirmed');
    expect(friendlyError(new AppError(400, 'AMOUNT_TOO_LARGE', 'The most you can add at once is 18.44 MON'))).toBe('The most you can add at once is 18.44 MON');
    const reserve = 'Keep at least 10 MON in this account for network fees; add less, or top it up first';
    expect(friendlyError(new AppError(409, 'RESERVE_TOO_LOW', reserve))).toBe(reserve);
    expect(friendlyError(new AppError(500, 'SOMETHING_NEW', 'Something new happened'))).toBe('Something new happened');
    expect(friendlyError(new Error('could not load /artifacts/transfer.wasm'))).toBe('could not load /artifacts/transfer.wasm');
    expect(friendlyError('plain text')).toBe('plain text');
    expect(friendlyError(new Error('Could not build the proof: could not load x'))).toBe('Calyptra could not secure this payment privately. Reload the page and try again.');
  });
});
