import {lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve} from 'node:path';

/** Missing ordinary folders remain read scopes, never execution directories.
 * Roots are the launcher's canonical authority; indexed metadata cannot add one.
 */
export async function missingHistoryWorkspace(directory:string,roots:string[],managedRoot?:string):Promise<boolean>{
 const inside=(root:string)=>{const r=relative(root,directory);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
 if(!isAbsolute(directory)||resolve(directory)!==directory||!roots.some(inside)||managedRoot&&inside(managedRoot))throw Error('History workspace is outside authorized ordinary roots');
 let missing=false,current=directory;
 for(;;){
  try{
   const info=await lstat(current);
   if(!info.isDirectory()||await realpath(current)!==current)throw Error('History workspace ancestor is not an unchanged canonical directory');
   return missing;
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   missing=true;const parent=dirname(current);if(parent===current)throw error;current=parent;
  }
 }
}
