import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

/** OS-released lifetime lease, acquired before opening recovery/admission journals. */
export class OwnerLease {
 private db:DatabaseSync;
 constructor(directory:string){
  this.db=new DatabaseSync(join(directory,'host-owner-lock.sqlite'));
  try{
   this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE');
   // Prior releases used a PID marker. Do not unlink or reclaim that artifact.
   // The new lease protects cooperating hosts; a live legacy owner must retire first.
   const legacy=join(directory,'host.lock');
   if(existsSync(legacy)){
    const previous=JSON.parse(readFileSync(legacy,'utf8'));
    if(!Number.isSafeInteger(previous.pid)||previous.pid<=0)throw Error('Legacy host owner marker requires explicit inspection');
    let alive=true;try{process.kill(previous.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error;}
    if(alive)throw Error('Host state directory already has a live owner from a legacy release');
   }
  }catch(error){this.db.close();throw new Error('Host state directory already has a live owner or its exclusive lease is unavailable',{cause:error});}
 }
 close(){try{this.db.exec('ROLLBACK')}finally{this.db.close()}}
}
