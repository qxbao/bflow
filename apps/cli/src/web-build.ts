import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Content identity, independent of mtimes and Git branch labels. Includes loaded workspace code and the Web bundle. */
export async function webBuildId(assetsDirectory:string):Promise<string>{
 const hash=createHash('sha256');
 async function tree(root:string,kind:string,runtimeOnly=false):Promise<void>{
  async function walk(directory:string):Promise<void>{
   for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink())throw Error('Web build contains a symlink');
    if(entry.isDirectory())await walk(path);
    else if(entry.isFile() && (!runtimeOnly || /\.(?:js|json|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts'))){
     hash.update(JSON.stringify([kind,relative(root,path)]));hash.update(createHash('sha256').update(await readFile(path)).digest());
    }
   }
  }
  await walk(root);
 }
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 await tree(fileURLToPath(new URL('./',import.meta.url)),'cli',true);
 await tree(join(root,'apps/local-server/dist'),'server',true);
 for(const name of (await readdir(join(root,'packages'))).sort()){
  const path=join(root,'packages',name,'dist');
  try{if((await lstat(path)).isDirectory())await tree(path,name,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 await tree(assetsDirectory,'web');return hash.digest('hex');
}
/** A running backend serves one immutable frontend, even while dist is being rebuilt. */
export async function snapshotWebAssets(assetsDirectory:string,stateDirectory:string,expectedBuildId:string):Promise<string>{
 const target=await mkdtemp(join(stateDirectory,'assets-'));
 try{
  await cp(assetsDirectory,target,{recursive:true,errorOnExist:false});
  if(await webBuildId(target)!==expectedBuildId || await webBuildId(assetsDirectory)!==expectedBuildId)
   throw Error('Bản build đang thay đổi. Chờ build hoàn tất rồi chạy lại bflow web.');
  const index=join(target,'index.html');
  const html=await readFile(index,'utf8');
  await writeFile(index,html.replace('</head>',`<meta name="bflow-build" content="${expectedBuildId}"></head>`));
  return target;
 }catch(error){await rm(target,{recursive:true,force:true});throw error;}
}
