import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { BadRequestError } from './validators.js';

export function corsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
}

/**
 * Wrap an async route handler so unhandled rejections route through Express's
 * error pipeline instead of leaking as unhandled promise warnings (and a
 * stuck connection on the client).
 */
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Final error middleware. Distinguishes typed `BadRequestError` (400, surfaced
 * to the client) from anything else (500, message logged but not echoed back
 * verbatim — avoids leaking stack details from native modules).
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error('[network-stats] unhandled error in request handler:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal server error' });
}
