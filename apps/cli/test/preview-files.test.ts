import { expect,it } from 'vitest';
import { mkdtemp,writeFile,symlink,rm,readdir } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPreviewFile} from '../src/preview-files.js';
it('reads without creating state and rejects symlinked or oversized inputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'preview-files-'));
 try {await writeFile(join(root,'input'),'{}');await symlink(join(root,'input'),join(root,'link'));
 const before=await readdir(root);expect(await readPreviewFile(join(root,'input'))).toBe('{}');
 await expect(readPreviewFile(join(root,'link'))).rejects.toThrow();
 await expect(readPreviewFile(join(root,'input'),1)).rejects.toThrow();
 expect(await readdir(root)).toEqual(before);
 }finally {await rm(root,{recursive:true,force:true});}
});
