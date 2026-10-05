import {initializeAuthority} from './authoritative-schema.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

export type QuiescencePurpose='distribution-update'|'recovery'|'service-stop'|'initial-start'|'retention-hide';
export type QuiescenceOutcome='ready'|'unchanged'|'unknown';
export interface ServiceIdentity {installationId:string;dataScope:string;ownerId:string;instanceId:string;releaseDigest:string;}
export interface ServiceStopRequest {commandId:string;expected:ServiceIdentity;retryRefused?:boolean;}
export interface ServiceStopReleaseRequest {fenceId:string;commandId:string;outcome:'resumed'|'stop-refused'|'unknown';resumeCommandId?:string;evidence?:unknown;}
export interface QuiescenceContext {fenceId:string;commandId:string;purpose:QuiescencePurpose;instanceId:string;dataScope:string;serviceIdentity?:ServiceIdentity;}
export interface ServiceReleaseProof extends QuiescenceProof {
 kind:'service-lifecycle';serviceOutcome:'resumed'|'stop-refused';expected:ServiceIdentity;observed:ServiceIdentity;
 resumeCommandId?:string;exitReceiptId?:string;readyReceiptId?:string;refusalReceiptId?:string;
 activation?:{schema:'distribution-service-activation-v1';target:{id:string;version:string;revision:string;digest:string}};
}
export interface ServiceStartReleaseRequest {fenceId:string;commandId:string;evidence?:unknown;}
export interface ServiceInitialStartProof {
 kind:'service-initial-start';verified:true;fenceId:string;commandId:string;expected:ServiceIdentity;observed:ServiceIdentity;
 instanceId:string;dataScope:string;claimReceiptId:string;readyReceiptId:string;receiptId:string;
 target:{id:string;version:string;revision:string;digest:string};
}
export interface ServiceStartReleaseResult {
 released:true;intakeClosed:false;purpose:'initial-start';fenceId:string;commandId:string;
 expected:ServiceIdentity;observed:ServiceIdentity;receiptId:string;
}
export interface ServiceLifecycleConfig {
 /** Trusted launcher identity: instanceId is unique to this actual runtime launch. */
 identity:ServiceIdentity;
 /** Trusted pristine provisioning command and the already persisted actual generation. */
 initialStart?:{commandId:string;identity:ServiceIdentity};
 /** Authenticates consumed provisioning claim, runtime custody and durable closed readiness. */
 verifyInitialStart?:(request:Readonly<QuiescenceContext>&{evidence:unknown})=>Promise<ServiceInitialStartProof>;
 /** Authenticates durable platform-owner exit/readiness or definitive no-effect evidence. */
 verifyRelease:(request:Readonly<QuiescenceContext>&{outcome:'resumed'|'stop-refused';resumeCommandId?:string;evidence:unknown})=>Promise<ServiceReleaseProof>;
}
export interface ServiceStopAdmission {
 admitted:boolean;intakeClosed:boolean;purpose:'service-stop';expected:ServiceIdentity;
 phase?:'closed'|'held';
 fenceId?:string;commandId?:string;executed?:false;reason?:string;work?:WorkCounts;fence?:QuiescenceFence;
 evidence?:{activeWork:number|'unknown';intakeClosed:true;instanceId:string;dataScope:string;observedAt:number};
}
export interface ServiceStopReleaseResult {
 released:true;intakeClosed:false;purpose:'service-stop';fenceId:string;commandId:string;
 outcome:'resumed'|'stop-refused';expected:ServiceIdentity;observed:ServiceIdentity;receiptId:string;resumeCommandId?:string;
}
export type ServiceStopReceipt=ServiceStopAdmission|ServiceStopReleaseResult;
export interface QuiescenceProof {verified:true;fenceId:string;commandId:string;outcome:'ready'|'unchanged';instanceId:string;dataScope:string;receiptId:string;}
export interface AdmissionAbortBinding {commandId:string;fenceId:string;instanceId:string;dataScope:string;}
export interface AdmissionAbortRequest extends AdmissionAbortBinding {evidence?:unknown;}
export interface AdmissionAbortProof extends AdmissionAbortBinding {kind:'distribution-admission-abort';verified:true;purpose:'distribution-update';receiptId:string;}
export interface AdmissionAbortOwnerReceipt extends AdmissionAbortBinding {ownerId:string;status:'released'|'not-acquired';receiptId:string;}
export interface HostAdmissionAbortReceipt extends AdmissionAbortBinding {schema:'host-admission-abort-v1';status:'aborted';intakeClosed:false;receiptId:string;owners:AdmissionAbortOwnerReceipt[];}
interface AdmissionAbortAttempt {kind:'admission-abort-v1';requestSignature:string;proofSignature:string;context:QuiescenceFence;proof:AdmissionAbortProof;owners:AdmissionAbortOwnerReceipt[];result?:HostAdmissionAbortReceipt;}
export interface QuiescenceLease {ownerId:string;fenceId:string;release:(outcome:QuiescenceOutcome,proof?:QuiescenceProof|{kind:'admission-refused'})=>Promise<void>;}
export interface QuiescenceParticipant {
 id:string;
 /** Declares full persisted service identity and service-specific release proof support. */
 serviceStop?:{version:1};
 /** Supports persisted retention-purpose identity and exact selected-item release evidence. */
 retentionHide?:{version:1};
 /** Atomically closes this owner's intake; null is a proven no-effect busy refusal. */
 acquire:(context:Readonly<QuiescenceContext>)=>Promise<QuiescenceLease|null>;
 /** Exact persisted owner fence reconciliation after process/supervisor replacement. */
 reconcileRelease?:(context:Readonly<QuiescenceContext>&{outcome:'ready'|'unchanged';proof:QuiescenceProof})=>Promise<void>;
 /** Authenticates this owner's original attempted acquisition and settles only that fence.
  * Absence of a live lease is never proof of not-acquired. Exact retries must return the original receipt. */
 abortAdmission?:(context:Readonly<QuiescenceContext>&{proof:AdmissionAbortProof})=>Promise<AdmissionAbortOwnerReceipt>;
}
export interface QuiescenceConfig {
 instanceId:string;dataScope:string;
 /** Includes background authorities with no advertised action or resource writer. */
 requiredOwners:string[];
 coverage:{capabilities?:Record<string,string>;resources?:Record<string,string>;nativeHost?:string;nativeHostOwners?:string[]};
 participants:QuiescenceParticipant[];
 /** Reads authenticated supervisor receipts; caller assertions never count as proof. */
 verifyRelease:(request:Readonly<QuiescenceContext>&{outcome:'ready'|'unchanged';evidence:unknown})=>Promise<QuiescenceProof>;
 /** Distinct supervisor authority proving pre-retirement admission abort, not a running/release assertion. */
 verifyAdmissionAbort?:(request:Readonly<QuiescenceContext>&{evidence?:unknown})=>Promise<AdmissionAbortProof>;
 serviceLifecycle?:ServiceLifecycleConfig;
 onMayBeIdle?:()=>void;
 /** Bounds owner/verifier observations, never the lifetime of known local service work. */
 timeoutMs?:number;
}
export interface QuiescenceFence extends QuiescenceContext {phase:'checking'|'closed'|'held'|'unknown'|'releasing';owners:string[];observedAt:number;reason?:string;admissionStage?:'participants'|'native-retirement'|'owner-exclusion'|'held'|'service-drain';admissionModel?:'shared-service-v1';}
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
 // A timeout is not cancellation: late owner work must settle before an abort can be admitted.
 private pending=new Set<Promise<unknown>>();
 private serviceDrain?:Promise<ServiceStopReceipt>;
 private drainWake?:()=>void;
 private closing=false;
 constructor(private db:DatabaseSync,private config:QuiescenceConfig|undefined,private requirements:string[],private inspectWork:()=>WorkCounts,private retire:()=>Promise<{ready:boolean;reason?:string;unknown?:boolean}>,private hasResidents:()=>boolean=()=>false,private inspectServiceWork:()=>WorkCounts=inspectWork) {
  if(config){
   token(config.instanceId,'launch identity');token(config.dataScope,'data scope');
   if(!Array.isArray(config.requiredOwners)||config.requiredOwners.length>128||!Array.isArray(config.participants)||config.participants.length>128)throw Error('Bounded quiescence owner declarations required');
   const owners=new Set<string>();for(const p of config.participants){token(p.id,'participant');if(owners.has(p.id)||typeof p.acquire!=='function')throw Error('Invalid quiescence participant');owners.add(p.id);}
   for(const id of config.requiredOwners)token(id,'required owner');
   if(config.coverage.nativeHostOwners!==undefined){if(!Array.isArray(config.coverage.nativeHostOwners)||!config.coverage.nativeHostOwners.length||config.coverage.nativeHostOwners.length>128)throw Error('Native callback owner coverage must be a nonempty bounded list');for(const owner of config.coverage.nativeHostOwners)token(owner,'native callback owner');}
   if(config.timeoutMs!==undefined&&(!Number.isSafeInteger(config.timeoutMs)||config.timeoutMs<25||config.timeoutMs>30000))throw Error('Quiescence deadline must be25..30000ms');
   if(typeof config.verifyRelease!=='function')throw Error('Authenticated quiescence reconciliation required');
   if(config.serviceLifecycle){const service=identity(config.serviceLifecycle.identity);if(service.instanceId!==config.instanceId||service.dataScope!==config.dataScope||typeof config.serviceLifecycle.verifyRelease!=='function')throw Error('Service lifecycle identity must match the trusted running host and data scope');
    const initial=config.serviceLifecycle.initialStart;if(initial){token(initial.commandId,'initial start identity');if(!sameIdentity(initial.identity,service)||typeof config.serviceLifecycle.verifyInitialStart!=='function')throw Error('Initial start must bind the actual generation and authenticated verifier');}
   }
  }
  initializeAuthority(db,'quiescence',()=>{db.exec("CREATE TABLE IF NOT EXISTS host_quiescence_fence(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS host_quiescence_commands(command_id TEXT PRIMARY KEY,signature TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS host_quiescence_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,payload TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS host_service_releases(fence_id TEXT PRIMARY KEY,command_id TEXT NOT NULL,request_signature TEXT NOT NULL,proof_signature TEXT NOT NULL,fence TEXT NOT NULL,proof TEXT NOT NULL,state TEXT NOT NULL,result TEXT)");
  const old=this.fence(),initial=config?.serviceLifecycle?.initialStart;
  if(old){
   // A real retained A stop is never replaced with a fabricated initial generation.
   if(initial&&(old.purpose!=='initial-start'||old.commandId!==initial.commandId||!old.serviceIdentity||!sameIdentity(old.serviceIdentity,initial.identity)))throw Error('Initial start differs from retained service fence');
   old.phase='unknown';old.reason='host-restarted';this.save(old);
  }else if(initial){
   const expected=identity(initial.identity),signature=digest(['initial-start',initial.commandId,expected]);
   const prior=db.prepare('SELECT signature,payload FROM host_quiescence_commands WHERE command_id=?').get(initial.commandId);
   if(prior){
    if(prior.signature!==signature)throw Error('Initial start identity differs from retained command');
    const result=JSON.parse(String(prior.payload));
    // Observing a completed exact generation does not consume another claim or close again.
    const release=db.prepare("SELECT result FROM host_service_releases WHERE command_id=? AND state='released'").get(initial.commandId);
    if(!release||canonical(JSON.parse(String(release.result)))!==canonical(result)||result.purpose!=='initial-start'||result.released!==true||!sameIdentity(result.observed,expected))throw Error('Initial start lacks exact retained release');
   }else{
    // Existing authoritative service records cannot be relabelled as pristine provisioning.
    if(db.prepare('SELECT 1 FROM host_quiescence_commands LIMIT 1').get())throw Error('Initial start requires a pristine service lifecycle');
    const fence:QuiescenceFence={commandId:initial.commandId,purpose:'initial-start',fenceId:randomUUID(),instanceId:expected.instanceId,dataScope:expected.dataScope,phase:'closed',owners:[],observedAt:Date.now(),serviceIdentity:expected};
    db.prepare('INSERT INTO host_quiescence_commands VALUES(?,?,?)').run(initial.commandId,signature,'{}');this.save(fence);
   }
  }
  });
 }
 private fence():QuiescenceFence|undefined {const row=this.db.prepare('SELECT payload FROM host_quiescence_fence WHERE id=1').get();return row?JSON.parse(String(row.payload)):undefined;}
 private save(fence:QuiescenceFence){this.db.prepare('INSERT INTO host_quiescence_fence VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(fence));this.result(fence.commandId,this.bindResult(fence,{admitted:fence.phase==='held',fence:structuredClone(fence),intakeClosed:true,...(fence.admissionModel==='shared-service-v1'?{fenceId:fence.fenceId,commandId:fence.commandId}: {})}));}
 private result(commandId:string,result:unknown){this.db.prepare('UPDATE host_quiescence_commands SET payload=? WHERE command_id=?').run(JSON.stringify(result),commandId);}
 private bindResult(fence:QuiescenceFence,result:any){return fence.purpose==='service-stop'?{...result,purpose:'service-stop',expected:fence.serviceIdentity}:fence.purpose==='initial-start'?{...result,purpose:'initial-start',expected:fence.serviceIdentity,fenceId:fence.fenceId,commandId:fence.commandId}:result;}
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
  token(ownerId,'external owner');
  return this.run(work);
 }
 /** Trusted native snapshot/reset I/O under this held fence; no normal admission is inherited. */
 async maintain<T>(input:{fenceId:string;commandId:string},work:()=>Promise<T>):Promise<T>{
  const fence=this.fence();
  if(!fence||['service-stop','initial-start'].includes(fence.purpose)||fence.phase!=='held'||fence.fenceId!==input.fenceId||fence.commandId!==input.commandId||this.changing||this.maintenance)throw new QuiescenceError('Exact idle held maintenance fence required',{executed:false});
  this.maintenance++;
  try{return await this.scope.run({active:false},work);}catch(error){this.unknown(fence,'maintenance-effect-outcome-unknown');throw error;}finally{this.maintenance--;}
 }
 workChanged(){this.maybeIdle();}
 /** End observations of this local lifetime without treating process shutdown as drained work. */
 hostClosing(){this.closing=true;const fence=this.fence();if(fence?.admissionModel==='shared-service-v1'&&fence.phase==='closed')this.unknown(fence,'host-closing');this.drainWake?.();}
 private maybeIdle(){this.drainWake?.();if(this.calls||this.continuations)return;queueMicrotask(()=>{try{this.config?.onMayBeIdle?.();}catch{/* Advisory wakeup never changes operation truth. */}});}
 private work():WorkCounts{const work=this.inspectWork();return {counts:{...work.counts,admissions:this.calls,continuations:this.continuations},gaps:[...work.gaps,...this.requirements.filter(id=>id.startsWith('uncovered-')||!this.config?.participants.some(p=>p.id===id))]};}
 private async deadline<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;this.pending.add(promise);void promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('quiescence-observation-timeout')),this.config?.timeoutMs??10000);timer.unref();})]);}finally{clearTimeout(timer);}}
 private async refuse(fence:QuiescenceFence,reason:string,work?:WorkCounts){
  try{for(const owner of [...fence.owners].reverse()){const lease=this.leases.get(owner);if(!lease)throw Error('Participant acquisition is unconfirmed');await this.deadline(lease.release('unchanged',{kind:'admission-refused'}));this.leases.delete(owner);}const result={admitted:false,executed:false,intakeClosed:false,reason,...(work?{work}:{}),fenceId:fence.fenceId,commandId:fence.commandId};this.clear(fence,result);return this.bindResult(fence,result);}
  catch(error){return this.unknown(fence,String(error));}
 }
 private unknown(fence:QuiescenceFence,reason:string){fence.phase='unknown';fence.reason=reason.slice(0,500);this.save(fence);return this.receipt(fence.commandId);}
 async admit(input:{commandId:string;purpose:Exclude<QuiescencePurpose,'service-stop'|'initial-start'|'retention-hide'>;retryRefused?:boolean}) {
  if(['service-stop','initial-start'].includes(input.purpose as string))throw new QuiescenceError('Service stop requires its identity-bound admission API',{executed:false});
  return this.admitBound(input);
 }
 /** Explicit offline backup/handoff preparation. Ordinary shutdown never uses
  * this stronger owner-exclusion path. The retained identity-bound participant
  * protocol supplies real capture coverage, not a census inferred from exit. */
 async admitMaintenanceServiceStop(input:ServiceStopRequest):Promise<ServiceStopReceipt>{
  const expected=identity(input.expected),configured=this.config?.serviceLifecycle;
  if(!configured||!sameIdentity(expected,configured.identity))throw new QuiescenceError('Maintenance stop requires the exact configured running service identity',{executed:false});
  return this.admitBound({commandId:input.commandId,purpose:'service-stop',serviceIdentity:expected});
 }
 async admitServiceStop(input:ServiceStopRequest):Promise<ServiceStopReceipt>{
  const closed=await this.closeServiceIntake(input);
  if(!closed.intakeClosed||'released' in closed)return closed;
  const fence=this.fence();
  if(!fence||fence.fenceId!==closed.fenceId||fence.admissionModel!=='shared-service-v1')throw new QuiescenceError('Legacy service holds are not shared drain proof',{executed:false});
  if(fence.phase!=='closed')return this.serviceStopReceipt(fence.commandId)!;
  if(this.serviceDrain)return this.serviceDrain;
  this.serviceDrain=(async()=>{
   while(true){
    const current=this.fence();if(!current||current.fenceId!==fence.fenceId||current.commandId!==fence.commandId)throw new QuiescenceError('Service drain fence changed',{executed:false});
    if(current.phase!=='closed')return this.serviceStopReceipt(current.commandId)!;
    if(this.closing)return this.unknown(current,'host-closing');
    let work:WorkCounts;try{work=this.serviceWork();}catch{return this.unknown(current,'service-work-unconfirmed');}
    if(work.gaps.length||Object.values(work.counts).some(n=>!Number.isSafeInteger(n)||n<0))return this.unknown(current,'service-work-unconfirmed');
    if(Object.values(work.counts).every(n=>n===0)){
     current.phase='held';current.observedAt=Date.now();delete current.reason;this.save(current);
     const result=this.serviceClosedResult(current,work);this.result(current.commandId,result);return result;
    }
    // A caller's observation deadline cannot make known, still-running work unknown.
    // This original drain continues after a lost reply; passive receipt reads can find its settlement.
    await new Promise<void>(resolve=>{const wake=()=>{if(this.drainWake===wake)this.drainWake=undefined;resolve();};this.drainWake=wake;});
   }
  })().finally(()=>{this.serviceDrain=undefined;this.drainWake=undefined;});return this.serviceDrain;
 }
 private serviceWork():WorkCounts {const work=this.inspectServiceWork();return {counts:{...work.counts,admissions:this.calls,continuations:this.continuations,maintenance:this.maintenance},gaps:[...work.gaps]};}
 private serviceClosedResult(fence:QuiescenceFence,work:WorkCounts):ServiceStopAdmission {
  const values=Object.values(work.counts),activeWork=work.gaps.length||values.some(n=>!Number.isSafeInteger(n)||n<0)?'unknown':values.reduce((sum,n)=>sum+n,0);
  return {admitted:true,intakeClosed:true,purpose:'service-stop',phase:fence.phase==='held'?'held':'closed',expected:structuredClone(fence.serviceIdentity!),fenceId:fence.fenceId,commandId:fence.commandId,fence:structuredClone(fence),work,evidence:{activeWork,intakeClosed:true,instanceId:fence.instanceId,dataScope:fence.dataScope,observedAt:Date.now()}};
 }
 /** Close the shared local gate before any await; closure is not proof that work drained. */
 async closeServiceIntake(input:ServiceStopRequest):Promise<ServiceStopReceipt>{
  const expected=identity(input.expected),configured=this.config?.serviceLifecycle;
  if(!configured||!sameIdentity(expected,configured.identity))throw new QuiescenceError('Service stop requires the exact configured running service identity',{executed:false});
  token(input.commandId,'service stop identity');if(input.retryRefused!==undefined&&typeof input.retryRefused!=='boolean')throw Error('retryRefused must be an explicit boolean');
  const signature=digest(['shared-service-v1',input.commandId,expected]),old=this.db.prepare('SELECT signature,payload FROM host_quiescence_commands WHERE command_id=?').get(input.commandId);
  if(old){if(old.signature!==signature)throw new QuiescenceError('Service identity differs or belongs to legacy admission',{executed:false});return JSON.parse(String(old.payload));}
  if(this.fence()||this.changing)throw new QuiescenceError('Existing quiescence fence requires authoritative reconciliation',{executed:false,...this.inspect()});
  const fence:QuiescenceFence={commandId:input.commandId,purpose:'service-stop',fenceId:randomUUID(),instanceId:expected.instanceId,dataScope:expected.dataScope,phase:'closed',owners:[],observedAt:Date.now(),serviceIdentity:expected,admissionStage:'service-drain',admissionModel:'shared-service-v1'};
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO host_quiescence_commands VALUES(?,?,?)').run(input.commandId,signature,'{}');this.save(fence);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  const result=this.serviceClosedResult(fence,this.serviceWork());this.result(input.commandId,result);return result;
 }
 inspectServiceLifecycle(){const fence=this.fence();return {enabled:!!this.config?.serviceLifecycle,identity:this.config?.serviceLifecycle?identity(this.config.serviceLifecycle.identity):undefined,intakeClosed:!!fence,fence:fence&&['service-stop','initial-start'].includes(fence.purpose)?fence:undefined};}
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
  const fence:QuiescenceFence={commandId:input.commandId,purpose:input.purpose,fenceId:randomUUID(),instanceId:this.config.instanceId,dataScope:this.config.dataScope,phase:'checking',admissionStage:'participants',owners:[],observedAt:Date.now(),...(input.serviceIdentity?{serviceIdentity:structuredClone(input.serviceIdentity)}:{})};
  // Both command reservation and closed intake become durable before any await.
  this.db.exec('BEGIN IMMEDIATE');try{if(retry){this.db.prepare('INSERT INTO host_quiescence_attempts(command_id,payload) VALUES(?,?)').run(input.commandId,String(old!.payload));this.db.prepare('UPDATE host_quiescence_commands SET payload=? WHERE command_id=?').run('{}',input.commandId);}else this.db.prepare('INSERT INTO host_quiescence_commands VALUES(?,?,?)').run(input.commandId,signature,'{}');this.save(fence);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');this.changing=false;throw error;}
  try{
   if(fence.purpose==='service-stop'){const missing=[...new Set([...this.config.requiredOwners,...this.requirements])].filter(id=>this.config!.participants.find(p=>p.id===id)?.serviceStop?.version!==1);if(missing.length)return await this.refuse(fence,'service-stop-coverage-unavailable',{counts:{},gaps:missing});}
   const before=this.work();if(before.gaps.length||Object.values(before.counts).some(n=>n>0))return await this.refuse(fence,'work-or-coverage-unavailable',before);
   // Resident Native workers hold shared writer gates until their cleanup finishes.
   // Their atomic retirement must precede external writer exclusion. A later lost
   // owner acknowledgement is post-retirement and cannot use admissionAbort.
   const retiredResidents=this.hasResidents();
   if(retiredResidents){
    fence.admissionStage='native-retirement';this.save(fence);
    const native=await this.deadline(this.retire());if(!native.ready){if(native.unknown)return this.unknown(fence,native.reason??'native-quiescence-unknown');return await this.refuse(fence,native.reason??'native-owned-work');}
    fence.admissionStage='owner-exclusion';this.save(fence);
   }
   const owners=[...new Set([...this.config.requiredOwners,...this.requirements])];
   for(const ownerId of owners){
    const participant=this.config.participants.find(p=>p.id===ownerId);if(!participant)return await this.refuse(fence,'participant-unavailable:'+ownerId);
    fence.owners.push(ownerId);this.save(fence);
    const lease=await this.deadline(participant.acquire(fence).then(lease=>{if(lease){if(lease.ownerId!==ownerId||lease.fenceId!==fence.fenceId||typeof lease.release!=='function')throw Error('Participant lease is not bound to this fence');this.leases.set(ownerId,lease);}return lease;}));
    if(!lease){fence.owners.pop();this.save(fence);return await this.refuse(fence,'owner-busy:'+ownerId);}
   }
   if(!retiredResidents){
    fence.admissionStage='native-retirement';this.save(fence);
    const native=await this.deadline(this.retire());if(!native.ready){if(native.unknown)return this.unknown(fence,native.reason??'native-quiescence-unknown');return await this.refuse(fence,native.reason??'native-owned-work');}
   }
   const after=this.work();if(after.gaps.length||Object.values(after.counts).some(n=>n>0))return await this.refuse(fence,'work-changed-during-quiescence',after);
   fence.phase='held';fence.admissionStage='held';fence.observedAt=Date.now();this.save(fence);
   const result={admitted:true,...(fence.purpose==='service-stop'?{intakeClosed:true}:{}),fenceId:fence.fenceId,commandId:fence.commandId,evidence:{activeWork:0,intakeClosed:true,instanceId:fence.instanceId,dataScope:fence.dataScope,observedAt:fence.observedAt}};this.result(fence.commandId,this.bindResult(fence,result));return this.bindResult(fence,result);
 }catch(error){return this.unknown(fence,error instanceof Error?error.message:String(error));}finally{this.changing=false;}
 }
 private abortAttempt(commandId:string):{id:number;value:AdmissionAbortAttempt}|undefined {
  const row=this.db.prepare('SELECT id,payload FROM host_quiescence_attempts WHERE command_id=? ORDER BY id DESC LIMIT 1').get(commandId);
  if(!row)return undefined;const value=JSON.parse(String(row.payload));return value.kind==='admission-abort-v1'?{id:Number(row.id),value}:undefined;
 }
 /** Passive observation of the original completed abort; never repeats owner settlement. */
 admissionAbortReceipt(commandId:string):HostAdmissionAbortReceipt|undefined {token(commandId,'command identity');return this.abortAttempt(commandId)?.value.result;}
 /** This can settle only a provably pre-retirement admission attempt, never an update or maintenance effect. */
 async abortAdmission(input:AdmissionAbortRequest):Promise<HostAdmissionAbortReceipt> {
  for(const key of ['commandId','fenceId','instanceId','dataScope'] as const)token(input[key],key);
  if(Object.keys(input).some(key=>!['commandId','fenceId','instanceId','dataScope','evidence'].includes(key)))throw new QuiescenceError('Unknown admission abort argument',{executed:false});
  if(Buffer.byteLength(canonical(input.evidence??null))>32768)throw new QuiescenceError('Admission abort evidence exceeds32KiB',{executed:false});
  if(this.changing||this.pending.size||this.maintenance||this.calls||this.continuations)throw new QuiescenceError('Admission work or settlement is still running',{executed:false});
  const config=this.config,previous=this.abortAttempt(input.commandId),completed=previous?.value.result;
  const current=this.fence(),fence=completed?previous!.value.context:current;
  if(!config?.verifyAdmissionAbort||!fence||fence.purpose!=='distribution-update'||fence.admissionStage!=='participants'||(!completed&&fence.phase!=='unknown')||fence.fenceId!==input.fenceId||fence.commandId!==input.commandId||fence.instanceId!==input.instanceId||fence.dataScope!==input.dataScope||config.instanceId!==input.instanceId||config.dataScope!==input.dataScope)throw new QuiescenceError('Exact authenticated pre-retirement admission abort is unavailable',{executed:false});
  // The persisted fence retains internal phase/owner/stage evidence. External
  // abort callbacks receive only their declared distribution context contract.
  const context:Readonly<QuiescenceContext>=Object.freeze({commandId:fence.commandId,fenceId:fence.fenceId,instanceId:fence.instanceId,dataScope:fence.dataScope,purpose:fence.purpose});
  const requestSignature=digest(input);
  if(previous&&previous.value.requestSignature!==requestSignature)throw new QuiescenceError('Admission abort identity has different arguments',{executed:false});
  if(!completed&&fence.owners.some(owner=>!config.participants.find(p=>p.id===owner)?.abortAdmission))throw new QuiescenceError('Admission abort owner receipt coverage is unavailable',{executed:false});
  this.changing=true;
  try {
   const proof=await this.deadline(config.verifyAdmissionAbort({...context,evidence:input.evidence}));
   const bound=(value:AdmissionAbortBinding)=>value&&value.commandId===input.commandId&&value.fenceId===input.fenceId&&value.instanceId===input.instanceId&&value.dataScope===input.dataScope;
   if(!bound(proof)||proof.kind!=='distribution-admission-abort'||proof.verified!==true||proof.purpose!=='distribution-update'||Object.keys(proof).sort().join(',')!=='commandId,dataScope,fenceId,instanceId,kind,purpose,receiptId,verified')throw Error('Supervisor admission abort proof does not bind the exact original attempt');
   token(proof.receiptId,'admission abort proof receipt');
   const proofSignature=digest(proof);
   if(previous&&previous.value.proofSignature!==proofSignature)throw Error('Admission abort proof differs from its retained proof');
   if(completed)return structuredClone(completed);
   const attempt:AdmissionAbortAttempt=previous?.value??{kind:'admission-abort-v1',requestSignature,proofSignature,context:structuredClone(fence),proof:structuredClone(proof),owners:[]};
   const id=previous?.id??Number(this.db.prepare('INSERT INTO host_quiescence_attempts(command_id,payload) VALUES(?,?)').run(input.commandId,JSON.stringify(attempt)).lastInsertRowid);
   const save=()=>this.db.prepare('UPDATE host_quiescence_attempts SET payload=? WHERE id=?').run(JSON.stringify(attempt),id);
   // The intent/proof is durable before the first owner callback. Resume only missing exact receipts.
   for(const ownerId of [...fence.owners].reverse()) {
    if(attempt.owners.some(receipt=>receipt.ownerId===ownerId))continue;
    const participant=config.participants.find(p=>p.id===ownerId)!;
    const receipt=await this.deadline(participant.abortAdmission!({...context,proof:structuredClone(proof)}));
    if(!bound(receipt)||receipt.ownerId!==ownerId||!['released','not-acquired'].includes(receipt.status)||Object.keys(receipt).sort().join(',')!=='commandId,dataScope,fenceId,instanceId,ownerId,receiptId,status'||(receipt.status==='not-acquired'&&this.leases.has(ownerId)))throw Error('Owner admission abort receipt is missing, uncertain or misbound');
    token(receipt.receiptId,'owner admission abort receipt');
    attempt.owners.push(structuredClone(receipt));save();this.leases.delete(ownerId);
   }
   const result:HostAdmissionAbortReceipt={schema:'host-admission-abort-v1',commandId:input.commandId,fenceId:input.fenceId,instanceId:input.instanceId,dataScope:input.dataScope,status:'aborted',intakeClosed:false,receiptId:proof.receiptId,owners:structuredClone(attempt.owners)};
   attempt.result=result;
   this.db.exec('BEGIN IMMEDIATE');try{save();this.result(fence.commandId,result);this.db.prepare('DELETE FROM host_quiescence_fence WHERE id=1').run();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
   this.maybeIdle();return result;
  } catch(error) {
   if(!completed)this.unknown(fence,error instanceof Error?error.message:String(error));
   throw new QuiescenceError(completed?'Admission abort retry differs from its retained proof':'Admission abort remains unknown; intake stays closed',{fenceId:fence.fenceId,outcome:'unknown'});
  } finally {this.changing=false;}
 }
 /** Trusted provisioning reconciliation only; caller evidence cannot authenticate a startup. */
 async releaseServiceStart(input:ServiceStartReleaseRequest):Promise<ServiceStartReleaseResult>{
  token(input.fenceId,'fence identity');token(input.commandId,'initial start identity');
  if(Object.keys(input).some(key=>!['fenceId','commandId','evidence'].includes(key))||Buffer.byteLength(canonical(input.evidence??null))>32768)throw new QuiescenceError('Invalid initial start reconciliation arguments',{executed:false});
  if(this.changing||this.pending.size||this.maintenance||this.serviceDrain||this.calls||this.continuations)throw new QuiescenceError('Initial start settlement is still running',{executed:false});
  const current=this.fence(),row=this.db.prepare('SELECT * FROM host_service_releases WHERE fence_id=?').get(input.fenceId);
  const completed=row?.state==='released'&&row.command_id===input.commandId;
  const fence:QuiescenceFence|undefined=current?.fenceId===input.fenceId&&current.commandId===input.commandId?current:completed?JSON.parse(String(row!.fence)):undefined;
  const configured=this.config?.serviceLifecycle,initial=configured?.initialStart;
  if(!fence||fence.purpose!=='initial-start'||!fence.serviceIdentity||!initial||!configured?.verifyInitialStart||initial.commandId!==fence.commandId||!sameIdentity(initial.identity,fence.serviceIdentity)||!sameIdentity(configured.identity,fence.serviceIdentity))throw new QuiescenceError('Exact retained initial generation and verifier required',{executed:false});
  const requestSignature=digest(input);if(row&&row.request_signature!==requestSignature)throw new QuiescenceError('Initial start release identity has different arguments',{executed:false});
  this.changing=true;
  try{
   const proof=await this.deadline(configured.verifyInitialStart({...structuredClone(fence),evidence:input.evidence}));
   const expected=identity(fence.serviceIdentity);
   const exactIdentity=(value:ServiceIdentity)=>value&&Object.keys(value).sort().join(',')==='dataScope,installationId,instanceId,ownerId,releaseDigest'&&sameIdentity(value,expected);
   if(!proof||proof.kind!=='service-initial-start'||proof.verified!==true||Object.keys(proof).sort().join(',')!=='claimReceiptId,commandId,dataScope,expected,fenceId,instanceId,kind,observed,readyReceiptId,receiptId,target,verified'||proof.fenceId!==fence.fenceId||proof.commandId!==fence.commandId||proof.instanceId!==expected.instanceId||proof.dataScope!==expected.dataScope||!exactIdentity(proof.expected)||!exactIdentity(proof.observed))throw Error('Initial proof does not bind the exact original generation');
   for(const key of ['claimReceiptId','readyReceiptId','receiptId'] as const)token(proof[key],key);
   if(!proof.target||Object.keys(proof.target).sort().join(',')!=='digest,id,revision,version'||proof.target.digest!==expected.releaseDigest)throw Error('Initial proof lacks the authenticated full release target');
   for(const key of ['id','version','revision','digest'] as const)token(proof.target[key],'initial target '+key);
   if(Buffer.byteLength(canonical(proof))>32768)throw Error('Initial start proof exceeds32KiB');
   const proofSignature=digest(proof);if(row&&row.proof_signature!==proofSignature)throw Error('Initial start proof differs from retained proof');
   if(completed)return JSON.parse(String(row!.result));
   const result:ServiceStartReleaseResult={released:true,intakeClosed:false,purpose:'initial-start',fenceId:fence.fenceId,commandId:fence.commandId,expected,observed:identity(proof.observed),receiptId:proof.receiptId};
   // No owner acquisition, respawn or claim occurs here. Reuse the existing release authority.
   this.db.exec('BEGIN IMMEDIATE');try{
    if(!row)this.db.prepare('INSERT INTO host_service_releases VALUES(?,?,?,?,?,?,?,?)').run(fence.fenceId,fence.commandId,requestSignature,proofSignature,JSON.stringify(fence),JSON.stringify(proof),'released',JSON.stringify(result));
    else this.db.prepare("UPDATE host_service_releases SET state='released',result=? WHERE fence_id=?").run(JSON.stringify(result),fence.fenceId);
    this.result(fence.commandId,result);this.db.prepare('DELETE FROM host_quiescence_fence WHERE id=1').run();this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   this.maybeIdle();return result;
  }catch(error){if(!completed)this.unknown(fence,error instanceof Error?error.message:String(error));throw new QuiescenceError(completed?'Initial start retry differs from retained proof':'Initial start remains unknown; intake stays closed',{executed:false,fenceId:fence.fenceId});}finally{this.changing=false;}
 }
 /** Service release uses a distinct authenticated authority; a generic ready receipt cannot open it. */
 async releaseServiceStop(input:ServiceStopReleaseRequest):Promise<ServiceStopReceipt>{
  token(input.fenceId,'fence identity');token(input.commandId,'service stop identity');
  if(!['resumed','stop-refused','unknown'].includes(input.outcome))throw new QuiescenceError('Unknown service stop outcome',{executed:false});
  if(this.changing||this.pending.size||this.maintenance||this.serviceDrain)throw new QuiescenceError('Quiescence transition or maintenance effect is still running',{executed:false});
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
   if(!proof||proof.kind!=='service-lifecycle'||proof.verified!==true||proof.fenceId!==fence.fenceId||proof.commandId!==fence.commandId||proof.serviceOutcome!==input.outcome||proof.dataScope!==fence.dataScope||proof.instanceId!==observed.instanceId||!sameIdentity(proof.expected,expected)||!sameIdentity(observed,configured.identity)||['installationId','dataScope','ownerId'].some(key=>expected[key as keyof ServiceIdentity]!==observed[key as keyof ServiceIdentity])||expected.instanceId!==fence.instanceId||expected.dataScope!==fence.dataScope)throw Error('Service proof does not bind installation, scope, owner, release and exact running instance');
   token(proof.receiptId,'service settlement receipt');
   if(input.outcome==='resumed'){
    if(proof.outcome!=='ready'||observed.instanceId===expected.instanceId||proof.resumeCommandId!==input.resumeCommandId||proof.refusalReceiptId!==undefined)throw Error('Resumed service proof must identify the distinct confirmed replacement');
    token(proof.exitReceiptId,'service exit receipt');token(proof.readyReceiptId,'service readiness receipt');
    if(observed.releaseDigest!==expected.releaseDigest){
     const activation=proof.activation;
     if(activation?.schema!=='distribution-service-activation-v1'||!activation.target||activation.target.digest!==observed.releaseDigest||Object.keys(activation).sort().join(',')!=='schema,target'||Object.keys(activation.target).sort().join(',')!=='digest,id,revision,version')throw Error('Cross-release service readiness requires its authenticated exact activation target');
     for(const key of ['id','version','revision','digest'] as const)token(activation.target[key],'activation '+key);
    }else if(proof.activation!==undefined)throw Error('Same-release service readiness cannot claim cross-release activation');
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
  if(this.changing||this.pending.size||this.maintenance)throw new QuiescenceError('Quiescence transition or maintenance effect is still running',{executed:false});
  const fence=this.fence();if(!fence||fence.fenceId!==input.fenceId||fence.commandId!==input.commandId)throw new QuiescenceError('Exact current quiescence fence required',{executed:false});
  if(this.abortAttempt(input.commandId))throw new QuiescenceError('Original admission abort requires its distinct settlement proof',{executed:false});
  if(['service-stop','initial-start'].includes(fence.purpose))throw new QuiescenceError('Service lifecycle requires its service-specific release proof',{executed:false});
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
