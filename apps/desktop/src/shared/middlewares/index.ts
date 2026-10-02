import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError, isAppError } from '@calyptra/framework';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import type { Logger } from '../logger.ts';

/** Takes `x-request-id` from the request (or makes one) and echoes it in the response. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const id = req.get('x-request-id') ?? randomUUID();
    res.locals.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  };
}

/** One log line per request when it finishes: method, path, status and duration, never the client's IP. */
export function requestLog(logger: Logger, module: string): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      logger.info(
        { module, requestId: res.locals.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(performance.now() - start) },
        'request',
      );
    });
    next();
  };
}

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Refuses every connection that does not come from this machine. */
export function localOnly(): RequestHandler {
  return (req, _res, next) => {
    if (!LOCAL_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      throw new AppError(403, 'NOT_LOCAL', 'The RPC server only accepts local connections');
    }
    next();
  };
}

/** Requires `Authorization: Bearer <token>`, compared in constant time. */
export function bearerToken(token: string): RequestHandler {
  const expected = Buffer.from(token);
  return (req, _res, next) => {
    const given = Buffer.from(/^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or wrong access token');
    }
    next();
  };
}

/** Lets any website call the public relayer API. */
export function openCors(): RequestHandler {
  return (req, res, next) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Every path no route claims. */
export const notFound: RequestHandler = () => {
  throw new AppError(404, 'NOT_FOUND', 'No such endpoint');
};

const bodyParserType = (err: unknown): unknown => (typeof err === 'object' && err !== null && 'type' in err ? err.type : undefined);

/** The only place that formats error responses: always `{ code, message }`, never a stack trace. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (isAppError(err)) {
      res.status(err.statusCode).json({ code: err.code, message: err.message });
      return;
    }
    if (err instanceof z.core.$ZodError) {
      const message = err.issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');
      res.status(400).json({ code: 'INVALID_INPUT', message });
      return;
    }
    if (bodyParserType(err) === 'entity.parse.failed') {
      res.status(400).json({ code: 'INVALID_JSON', message: 'The request body is not valid JSON' });
      return;
    }
    logger.error({ err, requestId: res.locals.requestId }, 'unexpected error');
    res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong' });
  };
}
