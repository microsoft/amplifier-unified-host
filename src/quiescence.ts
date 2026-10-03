import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

export type QuiescencePurpose='distribution-update'|'recovery'|'service-stop';
export type QuiescenceOutcome='ready'|'unchanged'|'unknown';
export interface ServiceIdentity {installationId:string;dataScope:string;ownerId:string;instanceId:string;releaseDigest:string;}
export interface ServiceStopRequest {commandId:string;expected:ServiceIdentity;retryRefused?:boolean;}
export interface ServiceStopReleaseRequest {fenceId:string;commandId:string;outcome:'resumed'|'stop-refused'|'unknown';resumeCommandId?:string;evidence?:unknown;}
export interface QuiescenceContext {fenceId:string;commandId:string;purpose:QuiescencePurpose;instanceId:string;dataScope:string;serviceIdentity?:ServiceIdentity;}
export interface ServiceReleaseProof extends QuiescenceProof {
 kind:'service-lifecycle';serviceOutcome:'resumed'|'stop-refused';expected:ServiceIdentity;observed:ServiceIdentity;
 resumeCommandId?:string;exitReceiptId?:string;readyReceiptId?:string;refusalReceiptId?:string;
}
export interface ServiceLifecycleConfig {
 /** Trusted launcher identity: instanceId is unique to this actual runtime launch. */
 identity:ServiceIdentity;
 /** Authenticates durable platform-owner exit/readiness or definitive no-effect evidence. */
 verifyRelease:(request:Readonly<QuiescenceContext>&{outcome:'resumed'|'stop-refused';resumeCommandId?:string;evidence:unknown})=>Promise<ServiceReleaseProof>;
}
export interface ServiceStopAdmission {
 admitted:boolean;intakeClosed:boolean;purpose:'service-stop';expected:ServiceIdentity;
 fenceId?:string;commandId?:string;executed?:false;reason?:string;work?:WorkCounts;fence?:QuiescenceFence;
 evidence?:{activeWork:0;intakeClosed:true;instanceId:string;dataScope:string;observedAt:number};
}
export interface ServiceStopReleaseResult {
 released:true;intakeClosed:false;purpose:'service-stop';fenceId:string;commandId:string;
 outcome:'resumed'|'stop-refused';expected:ServiceIdentity;observed:ServiceIdentity;receiptId:string;resumeCommandId?:string;
}
export type ServiceStopReceipt=ServiceStopAdmission|ServiceStopReleaseResult;
export interface QuiescenceProof {verified:true;fenceId:string;commandId:string;outcome:'ready'|'unchanged';instanceId:string;dataScope:string;receiptId:string;}
export interface QuiescenceLease {ownerId:string;fenceId:string;release:(outcome:QuiescenceOutcome,proof?:QuiescenceProof|{kind:'admission-refused'})=>Promise<void>;}
export interface QuiescenceParticipant {
 id:string;
 /** Declares full persisted service identity and service-specific release proof support. */
 serviceStop?:{version:1};
 /** Atomically closes this owner's intake; null is a proven no-effect busy refusal. */
 acquire:(context:Readonly<QuiescenceContext>)=>Promise<QuiescenceLease|null>;
 /** Exact persisted owner fence reconciliation after process/supervisor replacement. */
 reconcileRelease?:(context:Readonly<QuiescenceContext>&{outcome:'ready'|'unchanged';proof:QuiescenceProof})=>Promise<void>;
}
export interface QuiescenceConfig {
 instanceId:string;dataScope:string;
 /** Includes background authorities with no advertised action or resource writer. */
 requiredOwners:string[];
 coverage:{capabilities?:Record<string,string>;resources?:Record<string,string>;nativeHost?:string;nativeHostOwners?:string[]};
 participants:QuiescenceParticipant[];
 /** Reads authenticated supervisor receipts; caller assertions never count as proof. */
 verifyRelease:(request:Readonly<QuiescenceContext>&{outcome:'ready'|'unchanged';evidence:unknown})=>Promise<QuiescenceProof>;
 serviceLifecycle?:ServiceLifecycleConfig;
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
const identity=(value:ServiceIdentity):ServiceIdentity=>{if(!value||typeof value!=='object')throw Error('Service identity required');return {installationId:token(value.installationId,'installation identity'),dataScope:token(value.dataScope,'service data scope'),ownerId:token(value.ownerId,'service owner'),instanceId:token(value.instanceId,'service launch identity'),releaseDigest:token(value.releaseDigest,'release digest')};};
const sameIdentity=(a:ServiceIdentity,b:ServiceIdentity)=>JSON.stringify(identity(a))===JSON.stringify(identity(b));
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
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
   if(config.coverage.nativeHostOwners!==undefined){if(!Array.isArray(config.coverage.nativeHostOwners)||!config.coverage.nativeHostOwners.length||config.coverage.nativeHostOwners.length>128)throw Error('Native callback owner coverage must be a nonempty bounded list');for(const owner of config.coverage.nativeHostOwners)token(owner,'native callback owner');}
   if(config.timeoutMs!==undefined&&(!Number.isSafeInteger(config.timeoutMs)||config.timeoutMs<25||config.timeoutMs>30000))throw Error('Quiescence deadline must be25..30000ms');
   if(typeof config.verifyRelease!=='function')throw Error('Authenticated quiescence reconciliation required');
   if(config.serviceLifecycle){const service=identity(config.serviceLifecycle.identity);if(service.instanceId!==config.instanceId||service.dataScope!==config.dataScope||typeof config.serviceLifecycle.verifyRelease!=='function')throw Error('Service lifecycle identity must match the trusted running host and data scope');}
  }
  db.exec("CREATE TABLE IF NOT EXISTS host_quiescence_fence(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS host_quiescence_commands(command_id TEXT PRIMARY KEY,signature TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS host_quiescence_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,payload TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS host_service_releases(fence_id TEXT PRIMARY KEY,command_id TEXT NOT NULL,request_signature TEXT NOT NULL,proof_signature TEXT NOT NULL,fence TEXT NOT NULL,proof TEXT NOT NULL,state TEXT NOT NULL,result TEXT)");
  const old=this.fence();if(old){old.phase='unknown';old.reason='host-restarted';this.save(old);}
 }
 private fence():QuiescenceFence|undefined {const row=this.db.prepare('SELECT payload FROM host_quiescence_fence WHERE id=1').get();return row?JSON.parse(String(row.payload)):undefined;}
 private save(fence:QuiescenceFence){this.db.prepare('INSERT INTO host_quiescence_fence VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(fence));this.result(fence.commandId,this.bindResult(fence,{admitted:fence.phase==='held',fence:structuredClone(fence),intakeClosed:true}));}
 private result(commandId:string,result:unknown){this.db.prepare('UPDATE host_quiescence_commands SET payload=? WHERE command_id=?').run(JSON.stringify(result),commandId);}
 private bindResult(fence:QuiescenceFence,result:any){return fence.purpose==='service-stop'?{...result,purpose:'service-stop',expected:fence.serviceIdentity}:result;}
 private clear(fence:QuiescenceFence,result:unknown){this.db.exec('BEGIN IMMEDIATE');try{this.result(fence.commandId,this.bindResult(fence,result));this.db.prepare('DELETE FROM host_quiescence_fence WHERE id=1').run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
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
  if(!fence||fence.purpose==='service-stop'||fence.phase!=='held'||fence.fenceId!==input.fenceId||fence.commandId!==input.commandId||this.changing||this.maintenance)throw new QuiescenceError('Exact idle held maintenance fence required',{executed:false});
  this.maintenance++;
  try{return await this.scope.run({active:false},work);}catch(error){this.unknown(fence,'maintenance-effect-outcome-unknown');throw error;}finally{this.maintenance--;}
 }
 workChanged(){this.maybeIdle();}
 private maybeIdle(){if(this.calls||this.continuations||this.fence())return;queueMicrotask(()=>{try{this.config?.onMayBeIdle?.();}catch{/* Advisory wakeup never changes operation truth. */}});}
 private work():WorkCounts{const work=this.inspectWork();return {counts:{...work.counts,admissions:this.calls,continuations:this.continuations},gaps:[...work.gaps,...this.requirements.filter(id=>id.startsWith('uncovered-')||!this.config?.participants.some(p=>p.id===id))]};}
 private async deadline<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('quiescence-observation-timeout')),this.config?.timeoutMs??10000);timer.unref();})]);}finally{clearTimeout(timer);}}
 private async refuse(fence:QuiescenceFence,reason:string,work?:WorkCounts){
  try{for(const owner of [...fence.owners].reverse()){const lease=this.leases.get(owner);if(!lease)throw Error('Participant acquisition is unconfirmed');await this.deadline(lease.release('unchanged',{kind:'admission-refused'}));this.leases.delete(owner);}const result={admitted:false,executed:false,intakeClosed:false,reason,...(work?{work}:{}),fenceId:fence.fenceId,commandId:fence.commandId};this.clear(fence,result);return this.bindResult(fence,result);}
  catch(error){return this.unknown(fence,String(error));}
 }
 private unknown(fence:QuiescenceFence,reason:string){fence.phase='unknown';fence.reason=reason.slice(0,500);this.save(fence);return this.receipt(fence.commandId);}
 async admit(input:{commandId:string;purpose:Exclude<QuiescencePurpose,'service-stop'>;retryRefused?:boolean}) {
  if((input.purpose as string)==='service-stop')throw new QuiescenceError('Service stop requires its identity-bound admission API',{executed:false});
  return this.admitBound(input);
 }
 async admitServiceStop(input:ServiceStopRequest):Promise<ServiceStopReceipt>{
  const expected=identity(input.expected),configured=this.config?.serviceLifecycle;
  if(!configured||!sameIdentity(expected,configured.identity))throw new QuiescenceError('Service stop requires the exact configured running service identity',{executed:false});
  return this.admitBound({...input,purpose:'service-stop',serviceIdentity:expected});
 }
 inspectServiceLifecycle(){const fence=this.fence();return {enabled:!!this.config?.serviceLifecycle,identity:this.config?.serviceLifecycle?identity(this.config.serviceLifecycle.identity):undefined,intakeClosed:!!fence,fence:fence?.purpose==='service-stop'?fence:undefined};}
 serviceStopReceipt(commandId:string):ServiceStopReceipt|undefined{const result=this.receipt(commandId);if(!result)return undefined;if(result.purpose!=='service-stop'&&result.fence?.purpose!=='service-stop')throw new QuiescenceError('Command is not a service stop receipt',{executed:false});return result;}
 private async admitBound(input:{commandId:string;purpose:QuiescencePurpose;retryRefused?:boolean;serviceIdentity?:ServiceIdentity}) {
  token(input.commandId,'command identity');if(input.retryRefused!==undefined&&typeof input.retryRefused!=='boolean')throw Error('retryRefused must be an explicit boolean');if(!['distribution-update','recovery','service-stop'].includes(input.purpose))throw Error('Unknown quiescence purpose');
  if(!this.config)throw new QuiescenceError('Quiescence coverage is not configured',{executed:false});
  if(this.changing)throw new QuiescenceError('Quiescence transition is already running',{executed:false});
  const signature=createHash('sha256').update(JSON.stringify(input.serviceIdentity?[input.commandId,input.purpose,identity(input.serviceIdentity)]:[input.commandId,input.purpose])).digest('hex'),old=this.db.prepare('SELECT signature,payload FROM host_quiescence_commands WHERE command_id=?').get(input.commandId);
  let retry=false;
  if(old){if(old.signature!==signature)throw new QuiescenceError('Quiescence identity has different arguments',{executed:false});const prior=JSON.parse(String(old.payload));retry=input.retryRefused===true&&prior.admitted===false&&prior.executed===false&&prior.intakeClosed===false&&!this.fence();if(!retry)return prior;}
  if(this.fence())throw new QuiescenceError('Existing quiescence fence requires authoritative reconciliation',{executed:false,...this.inspect()});
  this.changing=true;
  const fence:QuiescenceFence={commandId:input.commandId,purpose:input.purpose,fenceId:randomUUID(),instanceId:this.config.instanceId,dataScope:this.config.dataScope,phase:'checking',owners:[],observedAt:Date.now(),...(input.serviceIdentity?{serviceIdentity:structuredClone(input.serviceIdentity)}:{})};
  // Both command reservation and closed intake become durable before any await.
  this.db.exec('BEGIN IMMEDIATE');try{if(retry){this.db.prepare('INSERT INTO host_quiescence_attempts(command_id,payload) VALUES(?,?)').run(input.commandId,String(old!.payload));this.db.prepare('UPDATE host_quiescence_commands SET payload=? WHERE command_id=?').run('{}',input.commandId);}else this.db.prepare('INSERT INTO host_quiescence_commands VALUES(?,?,?)').run(input.commandId,signature,'{}');this.save(fence);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');this.changing=false;throw error;}
  try{
   if(fence.purpose==='service-stop'){const missing=[...new Set([...this.config.requiredOwners,...this.requirements])].filter(id=>this.config!.participants.find(p=>p.id===id)?.serviceStop?.version!==1);if(missing.length)return await this.refuse(fence,'service-stop-coverage-unavailable',{counts:{},gaps:missing});}
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
   const result={admitted:true,...(fence.purpose==='service-stop'?{intakeClosed:true}:{}),fenceId:fence.fenceId,commandId:fence.commandId,evidence:{activeWork:0,intakeClosed:true,instanceId:fence.instanceId,dataScope:fence.dataScope,observedAt:fence.observedAt}};this.result(fence.commandId,this.bindResult(fence,result));return this.bindResult(fence,result);
  }catch(error){return this.unknown(fence,error instanceof Error?error.message:String(error));}finally{this.changing=false;}
 }
 /** Service release uses a distinct authenticated authority; a generic ready receipt cannot open it. */
 async releaseServiceStop(input:ServiceStopReleaseRequest):Promise<ServiceStopReceipt>{
  token(input.fenceId,'fence identity');token(input.commandId,'service stop identity');
  if(!['resumed','stop-refused','unknown'].includes(input.outcome))throw new QuiescenceError('Unknown service stop outcome',{executed:false});
  if(this.changing||this.maintenance)throw new QuiescenceError('Quiescence transition or maintenance effect is still running',{executed:false});
  const current=this.fence(),row=this.db.prepare('SELECT * FROM host_service_releases WHERE fence_id=?').get(input.fenceId);
  const exact=current?.fenceId===input.fenceId&&current.commandId===input.commandId;
  const completed=row?.state==='released'&&row.command_id===input.commandId;
  const fence:QuiescenceFence|undefined=exact?current:completed?JSON.parse(String(row!.fence)):undefined;
  if(!fence||fence.purpose!=='service-stop'||!fence.serviceIdentity)throw new QuiescenceError('Exact retained service stop fence required',{executed:false});
  if(input.outcome==='unknown'){
   if(completed)throw new QuiescenceError('A released service stop cannot be changed to unknown',{executed:false});
   return this.unknown(fence,'service-owner-outcome-unknown');
  }
  const configured=this.config?.serviceLifecycle;
  if(!configured)throw new QuiescenceError('Authenticated service lifecycle reconciliation is not configured',{executed:false});
  if(Buffer.byteLength(canonical(input.evidence??null))>32768)throw new QuiescenceError('Service reconciliation evidence exceeds32KiB',{executed:false});
  if(input.outcome==='resumed')token(input.resumeCommandId,'service resume identity');
  else if(input.resumeCommandId!==undefined)throw new QuiescenceError('A refused stop cannot claim a resume command',{executed:false});
  const requestSignature=digest(input);
  if(row&&row.request_signature!==requestSignature)throw new QuiescenceError('Service release identity has different arguments',{executed:false});
  this.changing=true;
  try{
   const proof=await this.deadline(configured.verifyRelease({...structuredClone(fence),outcome:input.outcome,resumeCommandId:input.resumeCommandId,evidence:input.evidence}));
   const expected=identity(fence.serviceIdentity),observed=identity(proof?.observed);
   if(!proof||proof.kind!=='service-lifecycle'||proof.verified!==true||proof.fenceId!==fence.fenceId||proof.commandId!==fence.commandId||proof.serviceOutcome!==input.outcome||proof.dataScope!==fence.dataScope||proof.instanceId!==observed.instanceId||!sameIdentity(proof.expected,expected)||!sameIdentity(observed,configured.identity)||!sameIdentity({...observed,instanceId:expected.instanceId},expected)||expected.instanceId!==fence.instanceId||expected.dataScope!==fence.dataScope)throw Error('Service proof does not bind installation, scope, owner, release and exact running instance');
   token(proof.receiptId,'service settlement receipt');
   if(input.outcome==='resumed'){
    if(proof.outcome!=='ready'||observed.instanceId===expected.instanceId||proof.resumeCommandId!==input.resumeCommandId||proof.refusalReceiptId!==undefined)throw Error('Resumed service proof must identify the distinct confirmed replacement');
    token(proof.exitReceiptId,'service exit receipt');token(proof.readyReceiptId,'service readiness receipt');
   }else{
    if(proof.outcome!=='unchanged'||!sameIdentity(observed,expected)||proof.resumeCommandId!==undefined||proof.exitReceiptId!==undefined||proof.readyReceiptId!==undefined)throw Error('Refused service stop must prove the unchanged original instance');
    token(proof.refusalReceiptId,'no-effect stop refusal receipt');
   }
   if(Buffer.byteLength(canonical(proof))>32768)throw Error('Service proof exceeds32KiB');
   const proofSignature=digest(proof);
   if(row&&row.proof_signature!==proofSignature)throw Error('Service release proof differs from the exact retained proof');
   if(completed)return JSON.parse(String(row!.result));
   // Persist the accepted request and authenticated proof before releasing any participant.
   if(!row)this.db.prepare('INSERT INTO host_service_releases VALUES(?,?,?,?,?,?,?,NULL)').run(fence.fenceId,fence.commandId,requestSignature,proofSignature,JSON.stringify(fence),JSON.stringify(proof),'releasing');
   fence.phase='releasing';this.save(fence);
   for(const owner of [...fence.owners].reverse()){
    const lease=this.leases.get(owner),participant=this.config!.participants.find(p=>p.id===owner);
    if(lease)await this.deadline(lease.release(proof.outcome,proof));
    else if(participant?.reconcileRelease)await this.deadline(participant.reconcileRelease({...fence,outcome:proof.outcome,proof}));
    else throw Error('Service participant release is unavailable:'+owner);
    this.leases.delete(owner);
   }
   const result:ServiceStopReleaseResult={released:true,intakeClosed:false,purpose:'service-stop',fenceId:fence.fenceId,commandId:fence.commandId,outcome:input.outcome,expected,observed,receiptId:proof.receiptId,...(input.resumeCommandId?{resumeCommandId:input.resumeCommandId}:{})};
   this.db.exec('BEGIN IMMEDIATE');try{this.result(fence.commandId,result);this.db.prepare("UPDATE host_service_releases SET state='released',result=? WHERE fence_id=?").run(JSON.stringify(result),fence.fenceId);this.db.prepare('DELETE FROM host_quiescence_fence WHERE id=1').run();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
   this.maybeIdle();return result;
  }catch(error){
   if(!completed)this.unknown(fence,error instanceof Error?error.message:String(error));
   throw new QuiescenceError(completed?'Service release retry does not match its authenticated retained proof':'Service reconciliation remains unknown; intake stays closed',{executed:false,fenceId:fence.fenceId});
  }finally{this.changing=false;}
 }
 async release(input:{fenceId:string;commandId:string;outcome:QuiescenceOutcome;evidence?:unknown}) {
  token(input.fenceId,'fence identity');token(input.commandId,'command identity');
  if(this.changing||this.maintenance)throw new QuiescenceError('Quiescence transition or maintenance effect is still running',{executed:false});
  const fence=this.fence();if(!fence||fence.fenceId!==input.fenceId||fence.commandId!==input.commandId)throw new QuiescenceError('Exact current quiescence fence required',{executed:false});
  if(fence.purpose==='service-stop')throw new QuiescenceError('Service stop requires its service-specific release proof',{executed:false});
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
