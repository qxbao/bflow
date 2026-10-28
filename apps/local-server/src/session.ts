import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WEB_LIMITS, WebSessionSummarySchema, type WebSessionSummary } from '@bflow/contracts/web';
import { HttpError } from './errors.js';
import { uniqueHeader } from './security.js';
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string,b: string) => {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
export class BrowserSessions {
  private bootstraps = new Map<string,number>();
  private sessions = new Map<string,WebSessionSummary>();
  issue(): string {
    this.prune();
    if(this.bootstraps.size>=100) throw new HttpError('unavailable');
    const secret=token();this.bootstraps.set(hash(secret),Date.now()+WEB_LIMITS.bootstrapSeconds*1000);return secret;
  }
  private prune(): void {
    for(const [id,expiry] of this.bootstraps) if(expiry<=Date.now()) this.bootstraps.delete(id);
    for(const [id,value] of this.sessions) if(Date.parse(value.expiresAt)<=Date.now()) this.sessions.delete(id);
  }
  bootstrap(secret: string,res: ServerResponse): WebSessionSummary {
    this.prune();const key=hash(secret),expiry=this.bootstraps.get(key);
    if(!expiry || expiry<=Date.now()) throw new HttpError('session_required');
    this.bootstraps.delete(key);
    if(this.sessions.size>=100) throw new HttpError('unavailable');
    const cookie=token();const summary=WebSessionSummarySchema.parse({apiVersion:1,sessionId:randomUUID(),csrfToken:token(),expiresAt:new Date(Date.now()+WEB_LIMITS.sessionSeconds*1000).toISOString()});
    this.sessions.set(hash(cookie),summary);
    res.setHeader('Set-Cookie',`bflow_session=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEB_LIMITS.sessionSeconds}`);
    return summary;
  }
  authenticate(req:IncomingMessage):WebSessionSummary {
    this.prune();const cookies=uniqueHeader(req,'cookie')?.split(';').map(s=>s.trim()).filter(s=>s.startsWith('bflow_session=')) ?? [];
    if(cookies.length!==1) throw new HttpError('session_required');
    const value=cookies[0]!.slice('bflow_session='.length);
    if(!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError('session_required');
    const session=this.sessions.get(hash(value));if(!session)throw new HttpError('session_required');
    if(req.method!=='GET' && req.method!=='HEAD' && !equal(uniqueHeader(req,'x-bflow-csrf') ?? '',session.csrfToken)) throw new HttpError('forbidden');
    return session;
  }
}
