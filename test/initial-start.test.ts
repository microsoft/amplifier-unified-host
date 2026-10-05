import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
import {QuiescenceGate,type QuiescenceConfig} from '../src/quiescence.js';
const identity={installationId:'installation',dataScope:'owned-data',ownerId:'unit-owner',instanceId:'persisted-generation',releaseDigest:'signed-target-digest'};
const commandId='original-provisioning-command';
function config(patch:()=>any=()=>({})):QuiescenceConfig{return {instanceId:identity.instanceId,dataScope:identity.dataScope,requiredOwners:[],coverage:{},participants:[],verifyRelease:async()=>{throw Error('generic verifier cannot open initial startup');},serviceLifecycle:{identity,initialStart:{commandId,identity},verifyRelease:async()=>{throw Error('stop verifier cannot open initial startup');},verifyInitialStart:async request=>({kind:'service-initial-start',verified:true,fenceId:request.fenceId,commandId:request.commandId,expected:identity,observed:identity,instanceId:identity.instanceId,dataScope:identity.dataScope,claimReceiptId:commandId,readyReceiptId:commandId,receiptId:commandId,target:{id:'qualified-target',version:'1',revision:'signed-revision',digest:identity.releaseDigest},...patch()})}};}
const make=(db:DatabaseSync,c=config())=>new QuiescenceGate(db,c,[],()=>({counts:{},gaps:[]}),async()=>{throw Error('initial startup must not retire or respawn');});

test('first actual Host listener permits initialization and reads while all fresh execution stays closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'initial-host-'));let host:any,c:AhpClient|undefined;
 try{
  host=await createHost({stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}],quiescence:config()});
  const original=host.inspectServiceLifecycle().fence;assert.equal(original.purpose,'initial-start');assert.equal(original.phase,'closed');assert.deepEqual(original.owners,[]);
  c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:'owner',protocolVersions:['0.9.0']});await c.request('listSessions',{channel:'ahp-root://',limit:1});
  const create=()=>c!.request('createSession',{channel:'ahp-session:/initial',provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
  await assert.rejects(create(),/intake is closed/);await assert.rejects(host.withExternalMutation('composition',async()=>{}),/intake is closed/);
  await assert.rejects(host.admitQuiescence({commandId:'forged',purpose:'initial-start'}),/identity-bound/);
  await assert.rejects(host.releaseQuiescence({fenceId:original.fenceId,commandId,outcome:'ready'}),/service-specific/);
  await assert.rejects(host.releaseServiceStop({fenceId:original.fenceId,commandId,outcome:'stop-refused'}),/service stop fence/);
  await assert.rejects(host.withQuiescenceMaintenance({fenceId:original.fenceId,commandId},async()=>{}),/maintenance fence/);
  const request={fenceId:original.fenceId,commandId,evidence:{callerAssertion:'not authority'}};
  const opened=await host.releaseServiceStart(request);assert.equal(opened.purpose,'initial-start');assert.equal(opened.released,true);assert.equal(host.inspectServiceLifecycle().intakeClosed,false);await create();
  host.store.admission('ahp-chat:/initial',{},'retained-unknown','prior',1);host.store.finish('retained-unknown','unknown');const before=JSON.stringify(host.store.receipt('retained-unknown'));
  const native=join(dir,'native-transcript.jsonl');await writeFile(native,'{"preserve":"exact original bytes"}\n');const nativeBefore=await readFile(native);
  await c.shutdown();c=undefined;await host.close();host=await createHost({stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}],quiescence:config()});
  assert.equal(host.inspectServiceLifecycle().intakeClosed,false);assert.deepEqual(await host.releaseServiceStart(request),opened);assert.equal(JSON.stringify(host.store.receipt('retained-unknown')),before);assert.deepEqual(await readFile(native),nativeBefore);
 }finally{await c?.shutdown();await host?.close();await rm(dir,{recursive:true,force:true});}
});

test('only authenticated exact full proof opens; malformed claim, readiness, identity and target remain closed',async()=>{
 const db=new DatabaseSync(':memory:');let patch:any={};const gate=make(db,config(()=>patch));const fence=gate.inspect().fence!;const request={fenceId:fence.fenceId,commandId,evidence:{verified:true}};
 try{
  for(const bad of [{kind:'service-lifecycle'},{verified:false},{claimReceiptId:undefined},{readyReceiptId:''},{receiptId:undefined},{expected:{...identity,ownerId:'other'}},{observed:{...identity,instanceId:'replacement'}},{dataScope:'other'},{instanceId:'other'},{commandId:'new-claim'},{target:{id:'qualified-target',version:'1',revision:'signed-revision',digest:'wrong'}},{target:{digest:identity.releaseDigest}},{extra:'not-contract'}]){
   patch=bad;await assert.rejects(gate.releaseServiceStart(request),/remains unknown/);assert.equal(gate.inspect().intakeClosed,true);assert.equal(gate.inspect().fence!.fenceId,fence.fenceId);
  }
  patch={};const opened=await gate.releaseServiceStart(request);assert.equal(opened.receiptId,commandId);assert.deepEqual(await gate.releaseServiceStart(request),opened);
  await assert.rejects(gate.releaseServiceStart({...request,evidence:{changed:true}}),/different arguments/);
  patch={receiptId:'changed'};await assert.rejects(gate.releaseServiceStart(request),/differs from retained proof/);assert.equal(gate.inspect().intakeClosed,false);
 }finally{db.close();}
});

test('reopen retains same command, generation and fence; exact completed retry observes one durable release',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'initial-reopen-')),path=join(dir,'gate.sqlite');let db=new DatabaseSync(path),gate=make(db);const first=gate.inspect().fence!;
 try{
  // Native or session-owned bytes do not participate in this authority's mutation.
  const commands=()=>Number(db.prepare('SELECT count(*) AS n FROM host_quiescence_commands').get()!.n);
  assert.equal(commands(),1);db.close();db=new DatabaseSync(path);gate=make(db);assert.equal(gate.inspect().fence!.fenceId,first.fenceId);assert.equal(gate.inspect().fence!.instanceId,identity.instanceId);assert.equal(gate.inspect().fence!.phase,'unknown');assert.equal(commands(),1);
  const input={fenceId:first.fenceId,commandId},opened=await gate.releaseServiceStart(input);db.close();db=new DatabaseSync(path);gate=make(db);assert.equal(gate.inspect().intakeClosed,false);assert.deepEqual(await gate.releaseServiceStart(input),opened);assert.equal(commands(),1);assert.equal(db.prepare('SELECT count(*) AS n FROM host_service_releases').get()!.n,1);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name),['host_quiescence_attempts','host_quiescence_commands','host_quiescence_fence','host_service_releases']);
  const changed=config();changed.serviceLifecycle!.initialStart!.commandId='second-claim';assert.throws(()=>make(db,changed),/pristine/);assert.equal(commands(),1);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('initial config cannot replace a real stop fence or change its original generation',async()=>{
 const db=new DatabaseSync(':memory:');try{
  const c=config();delete c.serviceLifecycle!.initialStart;const gate=make(db,c);const stop=await gate.closeServiceIntake({commandId:'real-A-stop',expected:identity});assert.throws(()=>make(db),/retained service fence/);assert.equal(gate.inspect().fence!.fenceId,stop.fenceId);
  const other=config();other.serviceLifecycle!.initialStart!.identity={...identity,instanceId:'changed'};assert.throws(()=>make(db,other),/actual generation/);
 }finally{db.close();}
});

test('an untrusted ready assertion cannot replace an authenticated startup verifier',async()=>{
 const db=new DatabaseSync(':memory:');try{const c=config();delete c.serviceLifecycle!.verifyInitialStart;assert.throws(()=>make(db,c),/authenticated verifier/);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n,0);}finally{db.close();}
});
