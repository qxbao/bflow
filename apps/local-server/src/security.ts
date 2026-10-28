import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors.js';

function uniqueHeader(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i=0;i<req.rawHeaders.length;i+=2) if (req.rawHeaders[i]!.toLowerCase() === name) values.push(req.rawHeaders[i+1]!);
  if (values.length > 1) throw new HttpError('forbidden');
  return values[0];
}
export function secureRequest(req: IncomingMessage, origin: string): void {
  if (uniqueHeader(req,'host') !== new URL(origin).host) throw new HttpError('forbidden');
  const supplied = uniqueHeader(req,'origin');
  if (supplied !== undefined && supplied !== origin) throw new HttpError('forbidden');
  const site = uniqueHeader(req,'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError('forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD' && supplied !== origin) throw new HttpError('forbidden');
}
export function securityHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
export { uniqueHeader };
