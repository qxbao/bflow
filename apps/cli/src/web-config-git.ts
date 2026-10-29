import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readPreviewFile } from './preview-files.js';
const exec=promisify(execFile);
const paths=['.bflow/config.yml','.bflow/.gitignore'];
/** Explicit administrative commit of reviewed Bflow config, never an application implementation commit. */
export async function commitWebConfiguration(root:string):Promise<string>{
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
 env.GIT_TERMINAL_PROMPT='0';
 // Same non-executable-repository Git policy as GitIntegrationEngine. Never execute repo hooks/fsmonitor from HTTP.
 const git=async(args:string[])=>{const result=await exec('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false',...args],{cwd:root,env,timeout:15000,maxBuffer:128*1024});return result.stdout;};
 for(const path of paths)await readPreviewFile(join(root,path),180000);
 const attributes=(await git(['check-attr','-z','filter','--',...paths])).split('\0');
 for(let i=0;i+2<attributes.length;i+=3)if(!['unspecified','unset'].includes(attributes[i+2]!))
  throw Error('Cấu hình có Git filter ('+attributes[i]+'). Commit từ web bị chặn trước khi chạy filter; không có file nào được staged.');
 const staged=(await git(['diff','--cached','--name-only','-z'])).split('\0').filter(Boolean);
 if(staged.some(path=>!paths.includes(path)))throw Error('Git index có file khác đang staged. Giữ nguyên index; commit cấu hình chưa được thực hiện.');
 const changes=(await git(['status','--porcelain=v1','--untracked-files=all','--',...paths])).trim();
 const tracked=(await git(['ls-files','-z','--',...paths])).split('\0');
 if(!changes && paths.every(path=>tracked.includes(path)))return 'Cấu hình Bflow đã có trong Git; không cần commit mới.';
 // Check identity before changing the index. Do not invent an author or alter Git global config.
 await git(['var','GIT_AUTHOR_IDENT']);await git(['var','GIT_COMMITTER_IDENT']);
 // The reviewed allowlist is explicit even when a repository ignores all of .bflow.
 await git(['add','--force','--',...paths]);await git(['commit','--only','-m','chore(bflow): save repository configuration','--',...paths]);
 return 'Đã commit cấu hình Bflow: '+(await git(['rev-parse','HEAD'])).trim();
}
