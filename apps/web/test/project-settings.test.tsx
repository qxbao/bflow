import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Settings } from '../src/features/settings';
import { ApiClient } from '../src/api/client';
import { installApi } from './fixtures';
const p={apiVersion:1 as const,projectId:'p',displayName:'Sample',canonicalPath:'/work/sample',registrationState:'registered' as const};
const config={apiVersion:1,projectId:'p',revision:'a'.repeat(64),yaml:'projectName: Sample\nenvironment: {}\n',values:{projectName:'Sample',environment:{roles:[{role:'conversation',cli:'claude',required:true}],verification:{maxIterations:3,regressionScope:'affected'},permissions:{trustedWorkspace:true}}}};
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
it('saves role models through forms and surfaces server validation errors',async()=>{
 const {fetcher}=installApi({'/api/v1/projects/p/configuration':config});const api=new ApiClient();const save=vi.spyOn(api,'saveConfiguration').mockResolvedValue(config as any);
 render(<MemoryRouter><Settings api={api} project={p}/></MemoryRouter>);
 const model=await screen.findByLabelText('Model (conversation)');await userEvent.type(model,'haiku');await userEvent.click(screen.getByRole('button',{name:'Lưu cấu hình'}));
 expect(save).toHaveBeenCalledWith('p',expect.objectContaining({expectedRevision:config.revision,values:expect.objectContaining({environment:expect.objectContaining({roles:[expect.objectContaining({model:'haiku'})]})})}));
 expect(await screen.findByText(/Đã lưu cấu hình/)).toBeTruthy();expect(fetcher.mock.calls.some(([path])=>path.includes('/start'))).toBe(false);
});
it('requires GitNexus approval and submits a durable ID',async()=>{
 installApi({'/api/v1/projects/p/configuration':config});const api=new ApiClient();const init=vi.spyOn(api,'initialize').mockImplementation(async(_id,input:any)=>({...input,projectId:'p',state:'succeeded',message:'Ready',updatedAt:new Date().toISOString()}));
 vi.spyOn(api,'initialization').mockRejectedValue(Error('not yet'));
 render(<MemoryRouter><Settings api={api} project={p}/></MemoryRouter>);
 const button=screen.getByRole('button',{name:'Khởi tạo / sửa GitNexus'});expect(button.hasAttribute('disabled')).toBe(true);
 await userEvent.click(screen.getByLabelText(/Tôi chấp nhận/));await userEvent.click(button);
 expect(init).toHaveBeenCalledWith('p',expect.objectContaining({acceptGitNexusLicense:true,operationId:expect.stringMatching(/^[a-f0-9-]{36}$/)}));
});
it('confirms unregister and accepts an empty HTTP 204 response',async()=>{
 const api=new ApiClient();const fetcher=vi.fn(async()=>new Response(null,{status:204}));vi.stubGlobal('fetch',fetcher);
 render(<MemoryRouter><Settings api={api} project={p}/></MemoryRouter>);
 await userEvent.click(screen.getByRole('button',{name:'Hủy đăng ký dự án'}));expect(fetcher.mock.calls.some((call:any)=>call[1]?.method==='DELETE')).toBe(false);
 await userEvent.click(screen.getByRole('button',{name:'Xác nhận hủy đăng ký'}));expect(fetcher).toHaveBeenCalledWith('/api/v1/projects/p',expect.objectContaining({method:'DELETE',body:JSON.stringify({apiVersion:1,confirmed:true})}));
});
it('starts polling after POST settles so an instant terminal receipt cannot be overwritten',async()=>{
 installApi({'/api/v1/projects/p/configuration':config});const api=new ApiClient();let finish!:(v:any)=>void;
 const init=vi.spyOn(api,'initialize').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const read=vi.spyOn(api,'initialization').mockImplementation(async(_id,operationId)=>({apiVersion:1,projectId:'p',operationId,state:'succeeded',message:'Done',updatedAt:new Date().toISOString()}));
 vi.spyOn(api,'inspect').mockResolvedValue({apiVersion:1,projectId:'p',ready:true,checks:[],observedAt:new Date().toISOString()});
 render(<MemoryRouter><Settings api={api} project={p}/></MemoryRouter>);
 await userEvent.click(screen.getByLabelText(/Tôi chấp nhận/));await userEvent.click(screen.getByRole('button',{name:'Khởi tạo / sửa GitNexus'}));
 expect(read).not.toHaveBeenCalled();const request=init.mock.calls[0]![1] as any;
 finish({apiVersion:1,projectId:'p',operationId:request.operationId,state:'running',message:'Starting',updatedAt:new Date().toISOString()});
 expect(await screen.findByText('Đã hoàn tất',{exact:true})).toBeTruthy();expect(screen.queryByRole('button',{name:'Đang khởi tạo…'})).toBeNull();
});
it('offers a retry with the same ID when the request never reached the owner',async()=>{
 installApi({'/api/v1/projects/p/configuration':config});const api=new ApiClient();
 const {ApiError}=await import('../src/api/client');
 const init=vi.spyOn(api,'initialize').mockRejectedValue(new Error('connection lost'));
 vi.spyOn(api,'initialization').mockRejectedValue(new ApiError('not_found'));
 render(<MemoryRouter><Settings api={api} project={p}/></MemoryRouter>);
 await userEvent.click(screen.getByLabelText(/Tôi chấp nhận/));await userEvent.click(screen.getByRole('button',{name:'Khởi tạo / sửa GitNexus'}));
 await userEvent.click(await screen.findByRole('button',{name:'Gửi lại cùng mã'}));
 expect(init).toHaveBeenCalledTimes(2);expect(init.mock.calls[0]![1]).toEqual(init.mock.calls[1]![1]);
});
it('discard clears invalid JSON draft and its browser validity',async()=>{
 const value={...config,values:{...config.values,environment:{...config.values.environment,skills:{requiredSkills:[]}}}};
 installApi({'/api/v1/projects/p/configuration':value});const api=new ApiClient();render(<MemoryRouter><Settings api={api} project={p}/></MemoryRouter>);
 await screen.findByLabelText('Model (conversation)');await userEvent.click(screen.getByText('Skills',{selector:'summary'}));
 const field=screen.getByLabelText('requiredSkills (JSON)');await userEvent.clear(field);await userEvent.type(field,'broken');expect((field as HTMLTextAreaElement).checkValidity()).toBe(false);
 await userEvent.click(screen.getByRole('button',{name:'Bỏ thay đổi'}));
 await userEvent.click(screen.getByText('Skills',{selector:'summary'}));const restored=screen.getByLabelText('requiredSkills (JSON)') as HTMLTextAreaElement;
 expect(restored.value).toBe('[]');expect(restored.checkValidity()).toBe(true);expect(screen.queryByText('JSON chưa hợp lệ. Hoàn tất trước khi lưu.')).toBeNull();
});
it('pins the loaded configuration revision for an explicitly selected config commit',async()=>{
 installApi({'/api/v1/projects/p/configuration':config});const api=new ApiClient();const init=vi.spyOn(api,'initialize').mockImplementation(async(_id,input:any)=>({...input,projectId:'p',state:'succeeded',message:'Committed',updatedAt:new Date().toISOString()}));
 vi.spyOn(api,'initialization').mockImplementation(async(_id,operationId)=>({apiVersion:1,projectId:'p',operationId,state:'succeeded',message:'Committed',updatedAt:new Date().toISOString()}));
 vi.spyOn(api,'inspect').mockResolvedValue({apiVersion:1,projectId:'p',ready:true,checks:[],observedAt:new Date().toISOString()});
 render(<MemoryRouter><Settings api={api} project={p}/></MemoryRouter>);await screen.findByLabelText('Model (conversation)');
 await userEvent.click(screen.getByLabelText(/Tôi chấp nhận/));await userEvent.click(screen.getByLabelText(/Commit cấu hình đã xem vào Git/));await userEvent.click(screen.getByRole('button',{name:'Khởi tạo / sửa GitNexus'}));
 expect(init).toHaveBeenCalledWith('p',expect.objectContaining({commitConfiguration:true,expectedConfigurationRevision:config.revision,update:false}));
});
