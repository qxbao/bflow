// Synthetic data for component tests only; never imported by production.
import { vi } from 'vitest';
import { WebRunViewSchema, WebDecisionSchema } from '@bflow/contracts/web';
export const now='2026-10-29T00:00:00Z';
export const projects=[{apiVersion:1,projectId:'p',displayName:'Vườn sách',canonicalPath:'/work/books',registrationState:'registered'},{apiVersion:1,projectId:'q',displayName:'Kho phim',canonicalPath:'/work/films',registrationState:'registered'}];
export const decision=WebDecisionSchema.parse({decisionId:'decision',runId:'run',kind:'approval',status:'pending',question:'Xem xét thiết kế tìm kiếm',options:[],expectedVersion:{revisionToken:'v1',approvalId:'decision',target:{type:'specification',specId:'spec'},revision:1,generation:0,evidenceDigest:'a'.repeat(64)},evidence:[]});
export const run=WebRunViewSchema.parse({apiVersion:1,runId:'run',sessionId:'host-session',revisionToken:'v1',title:'Tìm sách nhanh hơn',originRunId:'run',currentRunId:'run',sdlcStatus:'implementing',coreStatus:'running',transportSummary:{states:['unknown','done'],observedAt:now},tasks:[{taskId:'task',title:'Thêm bộ lọc sách',status:'running'}],blockers:[],decisions:[decision],clarifications:[],availableActions:[],updatedAt:now});
export const session={apiVersion:1,projectId:'p',state:'unavailable',pendingIntakes:[],blockers:[],updatedAt:now};
export const preview={apiVersion:1,projectId:'p',available:false,summary:'Chưa có phiên hoạt động.',blockers:[],observedAt:now};
export function installApi(overrides:Record<string,unknown>={}) {
  const handlers=new Map<string,EventListener>();
  class Source { constructor(){ } addEventListener(kind:string,fn:EventListener){handlers.set(kind,fn);}close=vi.fn(); }
  vi.stubGlobal('EventSource',Source);
  const responses:Record<string,unknown>={
    '/api/v1/session':{apiVersion:1,sessionId:'browser',expiresAt:'2026-10-30T00:00:00Z',csrfToken:'csrf'},
    '/api/v1/projects':{apiVersion:1,items:projects},
    '/api/v1/projects/p/session':session,'/api/v1/projects/p/preview':preview,
    '/api/v1/projects/p/runs?limit=25':{apiVersion:1,items:[run]},
    '/api/v1/projects/p/runs/run':run,'/api/v1/projects/p/decisions':{apiVersion:1,items:[decision]},...overrides,
  };
  const fetcher=vi.fn(async(path:string)=>new Response(JSON.stringify(responses[path]??{apiVersion:1,code:'not_found',message:'missing',retryable:false,correlationId:'test'}),{status:responses[path]?200:404}));
  vi.stubGlobal('fetch',fetcher); return {fetcher,handlers};
}
