import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

export type QuiescencePurpose='distribution-update'|'recovery';
export type QuiescenceOutcome='ready'|'unchanged'|'unknown';
export interface QuiescenceContext {fenceId:string;commandId:string;purpose:QuiescencePurpose;instanceId:string;dataScope:string;}
export interface QuiescenceProof {verified:true;fenceId:string;commandId:string;outcome:'ready'|'unchanged';instanceId:string;dataScope:string;receiptId:string;}
export interface QuiescenceLease {ownerId:string;fenceId:string;release:(outcome:QuiescenceOutcome,proof?:QuiescenceProof|{kind:'admission-refused'})=>Promise<void>;}
export interface QuiescenceParticipant {
 id:string;
 /** Atomically closes this owner's intake; null is a proven no-effect busy refusal. */
 acquire:(context:Readonly<QuiescenceContext>)=>Promise<QuiescenceLease|null>;
 /** Exact persisted owner fence reconciliation after process/supervisor replacement. */
 reconcileRelease?:(context:Readonly<QuiescenceContext>&{outcome:'ready'|'unchanged';proof:QuiescenceProof})=>Promise<void>;
}
export interface QuiescenceConfig {
 instanceId:string;dataScope:string;
 /** Includes background authorities with no advertised action or resource writer. */
 requiredOwners:string[];
 coverage:{capabilities?:Record<string,string>;resources?:Record<string,string>;nativeHost?:string};
 participants:QuiescenceParticipant[];
 /** Reads authenticated supervisor receipts; caller assertions never count as proof. */
 verifyRelease:(request:Readonly<QuiescenceContext>&{outcome:'ready'|'unchanged';evidence:unknown})=>Promise<QuiescenceProof>;
 onMayBeIdle?:()=>void;
 timeoutMs?:number;
}
export interface QuiescenceFence extends QuiescenceContext {phase:'checking'|'held'|'unknown'|'releasing';owners:string[];observedAt:number;reason?:string;}
export interface WorkCounts {counts:Record<string,number>;gaps:string[];}
export class QuiescenceError extends Error {
 readonly code=-32014;
 constructor(message:string,readonly data:Record<string,unknown>){super(message);}
}
const token=(value:unknown,name:string)=>{if(typeof value!=='string'||!value||value.length>200||/[\x00-\x1f]/.test(value))throw Error(`Invalid ${name}`);return value;};
/** Durable intake fence. Read-only state may remain available while execution is closed. */
export class QuiescenceGate {
 private scope=new AsyncLocalStorage<{active:boolean}>();
 private calls=0;
 private continuations=0;
 private maintenance=0;
 private leases=new Map<string,QuiescenceLease>();
 private changing=false;
 constructor(private db:DatabaseSync,private config:QuiescenceConfig|undefined,private requirements:string[],private inspectWork:()=>WorkCounts,private retire:()=>Promise<{ready:boolean;reason?:string;unknown?:boolean}>) {
  if(config){
   token(config.instanceId,'launch identity');token(config.dataScope,'data scope');
   if(!Array.isArray(config.requiredOwners)||config.requiredOwners.length>128||!Array.isArray(config.participants)||config.participants.length>128)throw Error('Bounded quiescence owner declarations required');
   const owners=new Set<string>();for(const p of config.participants){token(p.id,'participant');if(owners.has(p.id)||typeof p.acquire!=='function')throw Error('Invalid quiescence participant');owners.add(p.id);}
   for(const id of config.requiredOwners)token(id,'required owner');
   if(config.timeoutMs!==undefined&&(!Number.isSafeInteger(config.timeoutMs)||config.timeoutMs<25||config.timeoutMs>30000))throw Error('Quiescence deadline must be25..30000ms');
   if(typeof config.verifyRelease!=='function')throw Error('Authenticated quiescence reconciliation required');
  }
  db.exec("CREATE TABLE IF NOT EXISTS host_quiescence_fence(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS host_quiescence_commands(command_id TEXT PRIMARY KEY,signature TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS host_quiescence_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,payload TEXT NOT NULL)");
  const old=this.fence();if(old){old.phase='unknown';old.reason='host-restarted';this.save(old);}
 }
 private fence():QuiescenceFence|undefined {const row=this.db.prepare('SELECT payload FROM host_quiescence_fence WHERE id=1').get();return row?JSON.parse(String(row.payload)):undefined;}
 private save(fence:QuiescenceFence){this.db.prepare('INSERT INTO host_quiescence_fence VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(fence));this.result(fence.commandId,{admitted:fence.phase==='held',fence:structuredClone(fence),intakeClosed:true});}
 private result(commandId:string,result:unknown){this.db.prepare('UPDATE host_quiescence_commands SET payload=? WHERE command_id=?').run(JSON.stringify(result),commandId);}
 private clear(fence:QuiescenceFence,result:unknown){this.db.exec('BEGIN IMMEDIATE');try{this.result(fence.commandId,result);this.db.prepare('DELETE FROM host_quiescence_fence WHERE id=1').run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 inspect(){return {enabled:!!this.config,intakeClosed:!!this.fence(),fence:this.fence(),activeAdmissions:this.calls,continuations:this.continuations,activeMaintenance:this.maintenance};}
 receipt(commandId:string){token(commandId,'command identity');const row=this.db.prepare('SELECT payload FROM host_quiescence_commands WHERE command_id=?').get(commandId);return row?JSON.parse(String(row.payload)):undefined;}
 /** The scope expires with the outer call; detached promises cannot inherit an open gate forever. */
 async run<T>(work:()=>Promise<T>):Promise<T>{
  if(this.scope.getStore()?.active)return work();
  const fence=this.fence();if(fence)throw new QuiescenceError('Host intake is closed for quiescence; no new effect was admitted',{executed:false,fenceId:fence.fenceId,phase:fence.phase});
  this.calls++;const admission={active:true};
  try{return await this.scope.run(admission,work);}finally{admission.active=false;this.calls--;this.maybeIdle();}
 }
 /** Trusted read/reconciliation callbacks inherit no general execution admission. */
 inspectOnly<T>(work:()=>Promise<T>):Promise<T>{return this.scope.run({active:false},work);}
 /** Existing result delivery must finish even when an uncertain fence remains held. It grants no new admission. */
 async continuation<T>(work:()=>Promise<T>):Promise<T>{this.continuations++;try{return await this.scope.run({active:false},work);}finally{this.continuations--;this.maybeIdle();}}
 external<T>(ownerId:string,work:()=>Promise<T>):Promise<T>{
  token(ownerId,'external owner');if(this.config&&!this.config.requiredOwners.includes(ownerId)&&!this.config.participants.some(p=>p.id===ownerId))throw new QuiescenceError('External mutation owner is not declared',{executed:false});
  return this.run(work);
 }
 /** Trusted native snapshot/reset I/O under this held fence; no normal admission is inherited. */
 async maintain<T>(input:{fenceId:string;commandId:string},work:()=>Promise<T>):Promise<T>{
  const fence=this.fence();
  if(!fence||fence.phase!=='held'||fence.fenceId!==input.fenceId||fence.commandId!==input.commandId||this.changing||this.maintenance)throw new QuiescenceError('Exact idle held maintenance fence required',{executed:false});
  this.maintenance++;
  try{return await this.scope.run({active:false},work);}catch(error){this.unknown(fence,'maintenance-effect-outcome-unknown');throw error;}finally{this.maintenance--;}
 }
 workChanged(){this.maybeIdle();}
 private maybeIdle(){if(this.calls||this.continuations||this.fence())return;queueMicrotask(()=>{try{this.config?.onMayBeIdle?.();}catch{/* Advisory wakeup never changes operation truth. */}});}
 private work():WorkCounts{const work=this.inspectWork();return {counts:{...work.counts,admissions:this.calls,continuations:this.continuations},gaps:[...work.gaps,...this.requirements.filter(id=>id.startsWith('uncovered-')||!this.config?.participants.some(p=>p.id===id))]};}
 private async deadline<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('quiescence-observation-timeout')),this.config?.timeoutMs??10000);timer.unref();})]);}finally{clearTimeout(timer);}}
 private async refuse(fence:QuiescenceFence,reason:string,work?:WorkCounts){
  try{for(const owner of [...fence.owners].reverse()){const lease=this.leases.get(owner);if(!lease)throw Error('Participant acquisition is unconfirmed');await this.deadline(lease.release('unchanged',{kind:'admission-refused'}));this.leases.delete(owner);}const result={admitted:false,executed:false,intakeClosed:false,reason,...(work?{work}:{}),fenceId:fence.fenceId,commandId:fence.commandId};this.clear(fence,result);return result;}
  catch(error){return this.unknown(fence,String(error));}
 }
 private unknown(fence:QuiescenceFence,reason:string){fence.phase='unknown';fence.reason=reason.slice(0,500);this.save(fence);return this.receipt(fence.commandId);}
 async admit(input:{commandId:string;purpose:QuiescencePurpose;retryRefused?:boolean}) {
  token(input.commandId,'command identity');if(input.retryRefused!==undefined&&typeof input.retryRefused!=='boolean')throw Error('retryRefused must be an explicit boolean');if(!['distribution-update','recovery'].includes(input.purpose))throw Error('Unknown quiescence purpose');
  if(!this.config)throw new QuiescenceError('Quiescence coverage is not configured',{executed:false});
  if(this.changing)throw new QuiescenceError('Quiescence transition is already running',{executed:false});
  const signature=createHash('sha256').update(JSON.stringify([input.commandId,input.purpose])).digest('hex'),old=this.db.prepare('SELECT signature,payload FROM host_quiescence_commands WHERE command_id=?').get(input.commandId);
  let retry=false;
  if(old){if(old.signature!==signature)throw new QuiescenceError('Quiescence identity has different arguments',{executed:false});const prior=JSON.parse(String(old.payload));retry=input.retryRefused===true&&prior.admitted===false&&prior.executed===false&&prior.intakeClosed===false&&!this.fence();if(!retry)return prior;}
  if(this.fence())throw new QuiescenceError('Existing quiescence fence requires authoritative reconciliation',{executed:false,...this.inspect()});
  this.changing=true;
  const fence:QuiescenceFence={commandId:input.commandId,purpose:input.purpose,fenceId:randomUUID(),instanceId:this.config.instanceId,dataScope:this.config.dataScope,phase:'checking',owners:[],observedAt:Date.now()};
  // Both command reservation and closed intake become durable before any await.
  this.db.exec('BEGIN IMMEDIATE');try{if(retry){this.db.prepare('INSERT INTO host_quiescence_attempts(command_id,payload) VALUES(?,?)').run(input.commandId,String(old!.payload));this.db.prepare('UPDATE host_quiescence_commands SET payload=? WHERE command_id=?').run('{}',input.commandId);}else this.db.prepare('INSERT INTO host_quiescence_commands VALUES(?,?,?)').run(input.commandId,signature,'{}');this.save(fence);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');this.changing=false;throw error;}
  try{
   const before=this.work();if(before.gaps.length||Object.values(before.counts).some(n=>n>0))return await this.refuse(fence,'work-or-coverage-unavailable',before);
   const owners=[...new Set([...this.config.requiredOwners,...this.requirements])];
   for(const ownerId of owners){
    const participant=this.config.participants.find(p=>p.id===ownerId);if(!participant)return await this.refuse(fence,'participant-unavailable:'+ownerId);
    fence.owners.push(ownerId);this.save(fence);
    const lease=await this.deadline(participant.acquire(fence).then(lease=>{if(lease){if(lease.ownerId!==ownerId||lease.fenceId!==fence.fenceId||typeof lease.release!=='function')throw Error('Participant lease is not bound to this fence');this.leases.set(ownerId,lease);}return lease;}));
    if(!lease){fence.owners.pop();this.save(fence);return await this.refuse(fence,'owner-busy:'+ownerId);}
   }
   const native=await this.retire();if(!native.ready){if(native.unknown)return this.unknown(fence,native.reason??'native-quiescence-unknown');return await this.refuse(fence,native.reason??'native-owned-work');}
   const after=this.work();if(after.gaps.length||Object.values(after.counts).some(n=>n>0))return await this.refuse(fence,'work-changed-during-quiescence',after);
   fence.phase='held';fence.observedAt=Date.now();this.save(fence);
   const result={admitted:true,fenceId:fence.fenceId,commandId:fence.commandId,evidence:{activeWork:0,intakeClosed:true,instanceId:fence.instanceId,dataScope:fence.dataScope,observedAt:fence.observedAt}};this.result(fence.commandId,result);return result;
  }catch(error){return this.unknown(fence,error instanceof Error?error.message:String(error));}finally{this.changing=false;}
 }
 async release(input:{fenceId:string;commandId:string;outcome:QuiescenceOutcome;evidence?:unknown}) {
  token(input.fenceId,'fence identity');token(input.commandId,'command identity');
  if(this.changing||this.maintenance)throw new QuiescenceError('Quiescence transition or maintenance effect is still running',{executed:false});
  const fence=this.fence();if(!fence||fence.fenceId!==input.fenceId||fence.commandId!==input.commandId)throw new QuiescenceError('Exact current quiescence fence required',{executed:false});
  if(input.outcome==='unknown')return this.unknown(fence,'supervisor-outcome-unknown');
  if(!['ready','unchanged'].includes(input.outcome)||!this.config)throw new QuiescenceError('Authenticated supervisor reconciliation is required',{executed:false});
  if(Buffer.byteLength(JSON.stringify(input.evidence??null))>32768)throw new QuiescenceError('Reconciliation evidence exceeds32KiB',{executed:false});
  this.changing=true;
  try{
   const proof=await this.deadline(this.config.verifyRelease({...fence,outcome:input.outcome,evidence:input.evidence}));
   if(!proof||proof.verified!==true||proof.fenceId!==fence.fenceId||proof.commandId!==fence.commandId||proof.outcome!==input.outcome||proof.dataScope!==fence.dataScope||proof.dataScope!==this.config.dataScope||proof.instanceId!==this.config.instanceId||(input.outcome==='ready'?proof.instanceId===fence.instanceId:proof.instanceId!==fence.instanceId))throw Error('Supervisor proof does not bind the exact fence, outcome and running instance');
   token(proof.receiptId,'supervisor receipt');
   fence.phase='releasing';this.save(fence);
   for(const owner of [...fence.owners].reverse()){
    const lease=this.leases.get(owner),participant=this.config.participants.find(p=>p.id===owner);
    if(lease)await this.deadline(lease.release(input.outcome,proof));
    else if(participant?.reconcileRelease)await this.deadline(participant.reconcileRelease({...fence,outcome:input.outcome,proof}));
    else throw Error('Participant recovery release is unavailable:'+owner);
    this.leases.delete(owner);
   }
   const result={released:true,intakeClosed:false,fenceId:fence.fenceId,commandId:fence.commandId,outcome:input.outcome,instanceId:proof.instanceId,receiptId:proof.receiptId};this.clear(fence,result);return result;
  }catch(error){this.unknown(fence,error instanceof Error?error.message:String(error));throw new QuiescenceError('Quiescence reconciliation remains unknown; intake stays closed',{executed:false,fenceId:fence.fenceId});}finally{this.changing=false;}
 }
}
