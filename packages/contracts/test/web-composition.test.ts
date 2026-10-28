import { expect, it } from 'vitest';
import * as codecs from '../src/web-host.js';
it('validates server-only construction and rejects remote bind/relative directories/extra fields',()=>{
 expect(codecs).toHaveProperty('LocalWebServerConfigSchema');
 const schema=Reflect.get(codecs,'LocalWebServerConfigSchema');
 const value={host:'127.0.0.1',port:4317,stateDirectory:'/state/web',assetsDirectory:'/app/dist/client'};
 expect(schema.parse(value)).toEqual(value);
 for(const change of [{host:'0.0.0.0'},{port:65536},{stateDirectory:'relative'},{assetsDirectory:'../dist'},{token:'private'}])expect(schema.safeParse({...value,...change}).success).toBe(false);
});
it('passes only authenticated server-issued browser identity, with no csrf or host tokens',()=>{
 expect(codecs).toHaveProperty('WebAuthenticatedContextSchema');
 const schema=Reflect.get(codecs,'WebAuthenticatedContextSchema');
 const value={principalId:'stable-ledger-principal',browserSessionId:'browser-session',expiresAt:new Date().toISOString()};
 expect(schema.parse(value)).toEqual(value);
 expect(schema.safeParse({...value,csrfToken:'x'.repeat(43)}).success).toBe(false);
});
