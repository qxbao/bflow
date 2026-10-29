import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WebHttpContracts, WebConfigurationSaveSchema, WebProjectInitRequestSchema, WebProjectInitializationSchema } from '../src/web.js';
it('keeps additions strict and rejects foreign versions, paths and ambiguous config writes',()=>{
 const init={apiVersion:1,operationId:randomUUID(),acceptGitNexusLicense:true};
 expect(WebProjectInitRequestSchema.parse(init).update).toBe(false);
 for(const invalid of [{...init,apiVersion:2},{...init,path:'/foreign'},{...init,force:true}])expect(WebProjectInitRequestSchema.safeParse(invalid).success).toBe(false);
 const config={apiVersion:1,expectedRevision:'a'.repeat(64)};
 expect(WebConfigurationSaveSchema.safeParse(config).success).toBe(false);
 expect(WebConfigurationSaveSchema.safeParse({...config,values:{},yaml:'x: 1'}).success).toBe(false);
 expect(WebConfigurationSaveSchema.safeParse({...config,values:{environment:{roles:[{role:'conversation',cli:'claude'}]}}}).success).toBe(true);
});
it('does not change existing lifecycle or unregister shapes',()=>{
 expect(WebHttpContracts.unregisterProject.body.parse({apiVersion:1,confirmed:true})).toEqual({apiVersion:1,confirmed:true});
 expect(WebHttpContracts.startSession.body.parse({apiVersion:1,operationId:randomUUID()})).toHaveProperty('operationId');
 expect(WebProjectInitializationSchema.safeParse({apiVersion:1,projectId:'p',operationId:randomUUID(),state:'succeeded',message:'ready',updatedAt:new Date().toISOString(),sessionReady:true}).success).toBe(false);
});

it('requires a reviewed config revision for administrative Git commits',()=>{
 const init={apiVersion:1,operationId:randomUUID(),acceptGitNexusLicense:true,commitConfiguration:true};
 expect(WebProjectInitRequestSchema.safeParse(init).success).toBe(false);
 expect(WebProjectInitRequestSchema.safeParse({...init,expectedConfigurationRevision:'a'.repeat(64),update:true}).success).toBe(false);
 expect(WebProjectInitRequestSchema.safeParse({...init,expectedConfigurationRevision:'a'.repeat(64),update:false}).success).toBe(true);
});
