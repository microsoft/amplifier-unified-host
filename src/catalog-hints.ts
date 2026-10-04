import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogDiscoveryAttempt,CatalogDiscoverySettlement} from './presentation-types.js';

/** Derived observations only: never queues or replays native commands. */
export class CatalogHints {
 private active?:Promise<void>;
 private paused=0;
 private closed=false;
 constructor(private db:DatabaseSync,private ports:{hint(path:string,context:{attemptId:string}):Promise<unknown>;ready():Promise<boolean>;blocked(reason:string):void;settle?(attempt:CatalogDiscoveryAttempt):Promise<CatalogDiscoverySettlement>}) {
  db.exec(`CREATE TABLE IF NOT EXISTS presentation_hints(path TEXT PRIMARY KEY,generation INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS presentation_hint_state(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,overflow INTEGER NOT NULL,attempt TEXT);
   CREATE TABLE IF NOT EXISTS presentation_hint_settlements(attempt_id TEXT PRIMARY KEY,attempt TEXT NOT NULL,evidence TEXT NOT NULL);
   INSERT OR IGNORE INTO presentation_hint_state VALUES(1,0,0,NULL);`);
 }
 private state(){return this.db.prepare('SELECT * FROM presentation_hint_state WHERE id=1').get()!;}
 inspect(){const state=this.state();return {pending:Number(this.db.prepare('SELECT count(*) n FROM presentation_hints').get()!.n),capacity:512,overflow:!!state.overflow,inFlight:!!this.active,unsettled:!!state.attempt};}
 enqueue(path:string){
  const generation=Number(this.state().generation)+1;this.db.prepare('UPDATE presentation_hint_state SET generation=? WHERE id=1').run(generation);
  if(Buffer.byteLength(path)>8192||!this.db.prepare('SELECT 1 FROM presentation_hints WHERE path=?').get(path)&&this.inspect().pending>=512){this.db.prepare('UPDATE presentation_hint_state SET overflow=? WHERE id=1').run(generation);this.ports.blocked('discovery-hint-capacity-requires-reconstruction');return;}
  this.db.prepare('INSERT INTO presentation_hints VALUES(?,?) ON CONFLICT(path) DO UPDATE SET generation=excluded.generation').run(path,generation);this.wake();
 }
 pause(){this.paused++;}
 resume(){this.paused--;this.wake();}
 async quiet(){
  if(this.active){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([this.active,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Catalog discovery is still in flight')),10000);})]);}finally{clearTimeout(timer);}}
  const saved=this.state().attempt;if(!saved)return;
  const attempt=JSON.parse(String(saved)) as CatalogDiscoveryAttempt;
  if(!this.ports.settle)throw Error('Catalog discovery outcome is unknown; original writer settlement is required');
  let timer:ReturnType<typeof setTimeout>|undefined;let result:CatalogDiscoverySettlement;
  try{result=await Promise.race([this.ports.settle(structuredClone(attempt)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Catalog-owner settlement inspection timed out')),10000);})]);}finally{clearTimeout(timer);}
  if(!result||Object.keys(result).sort().join(',')!=='attemptId,evidence,ownerReceipt'||result.attemptId!==attempt.attemptId||!['response-settled','process-exited'].includes(result.evidence)||typeof result.ownerReceipt!=='string'||!result.ownerReceipt||result.ownerReceipt.length>512)throw Error('Exact catalog-owner settlement evidence required');
  // Owner evidence may establish writer quiet, but does not claim its metadata effect succeeded.
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO presentation_hint_settlements VALUES(?,?,?)').run(attempt.attemptId,String(saved),JSON.stringify(result));this.db.prepare('UPDATE presentation_hint_state SET attempt=NULL WHERE id=1 AND attempt=?').run(String(saved));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async discover<T>(attempt:CatalogDiscoveryAttempt,work:()=>Promise<T>):Promise<T>{
  if(this.closed||this.active||this.state().attempt||!this.paused)throw Error('Catalog discovery requires its exclusive settled presentation boundary');
  this.db.prepare('UPDATE presentation_hint_state SET attempt=? WHERE id=1').run(JSON.stringify(attempt));
  const result=Promise.resolve().then(work).then(value=>{this.db.prepare('UPDATE presentation_hint_state SET attempt=NULL WHERE id=1').run();return value;},error=>{
   if((error as any)?.catalogDiscoverySettled===true)this.db.prepare('UPDATE presentation_hint_state SET attempt=NULL WHERE id=1').run();
   else this.ports.blocked('catalog-discovery-unconfirmed');
   throw error;
  });
  // quiet joins writer completion; unknown failures retain the exact durable attempt.
  this.active=result.then(()=>{},()=>{});
  try{return await result;}finally{this.active=undefined;}
 }
 scanBoundary(){return Number(this.state().generation);}
 scanned(through:number){this.db.prepare('UPDATE presentation_hint_state SET overflow=0 WHERE id=1 AND overflow<=?').run(through);}
 assertComplete(){if(this.state().overflow)throw Error('Discovery hint overflow requires another complete metadata reconstruction');if(this.state().attempt)throw Error('Catalog discovery writer is unsettled');}
 wake(){
  if(this.closed||this.paused||this.active||this.state().attempt||this.state().overflow||!this.inspect().pending)return;
  const work=async()=>{while(!this.closed&&!this.paused){
   if(!await this.ports.ready()||this.closed||this.paused)return;
   const row=this.db.prepare('SELECT path,generation FROM presentation_hints ORDER BY generation LIMIT 1').get();if(!row)return;
   const attempt:CatalogDiscoveryAttempt={attemptId:randomUUID(),sessionDirectory:String(row.path)};
   this.db.prepare('UPDATE presentation_hint_state SET attempt=? WHERE id=1').run(JSON.stringify(attempt));
   try{await this.ports.hint(String(row.path),{attemptId:attempt.attemptId});this.db.prepare('DELETE FROM presentation_hints WHERE path=? AND generation=?').run(row.path,row.generation);this.db.prepare('UPDATE presentation_hint_state SET attempt=NULL WHERE id=1').run();}
   catch(error){if((error as any)?.catalogDiscoverySettled===true)this.db.prepare('UPDATE presentation_hint_state SET attempt=NULL WHERE id=1').run();this.ports.blocked('catalog-discovery-unconfirmed');return;}
  }};
  this.active=Promise.resolve().then(work).catch(()=>this.ports.blocked('catalog-discovery-unconfirmed')).finally(()=>{this.active=undefined;});
 }
 async close(){this.closed=true;await this.active;}
}
