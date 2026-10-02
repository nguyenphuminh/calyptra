/**
 * The one error type the framework throws on purpose. `code` is machine-readable; `statusCode` is a
 * hint for hosts that expose the framework over HTTP (the desktop client's RPC server).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
export const isAppError = (err: unknown): err is AppError => err instanceof AppError;
