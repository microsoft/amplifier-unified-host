import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost,type HostConfig} from '../src/host.js';
const source='a'.repeat(64),destination='b'.repeat(64);
async function setup(extra:Record<string,string>={}){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'ahp-transfer-'))),authority=join(dir,'authority.json');await writeFile(authority,'{}');
 const config:HostConfig={stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],transferIdentity:source,engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_TRANSFER:authority,FIXTURE_LOG:join(dir,'prompts'),...extra}}]};
 let host=await createHost(config),client:AhpClient;
 const connect=async()=>{client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:randomUUID(),protocolVersions:['0.9.0']});};await connect();
 const create=async()=>{const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,workingDirectories:[pathToFileURL(dir).href]});return session;};
 const authorize=async(session:string,transferId:string)=>{const selected=await host.inspectSession(session);await writeFile(authority,JSON.stringify({[transferId]:{nativeSessionId:selected.nativeSessionId,historyCwd:dir,source,destination}}));};
 const restart=async()=>{await client.shutdown();await host.close();host=await createHost(config);await connect();};
 return {dir,authority,config,get host(){return host;},get client(){return client;},create,authorize,restart,cleanup:async()=>{await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}};
}
test('source transfer holds admission, preserves unrelated sessions, commits without duplicate effects across restart',async()=>{
 const f=await setup();try{
  const session=await f.create(),transferId=randomUUID();await f.authorize(session,transferId);const revision=(await f.host.inspectSession(session)).executionRevision;
  await assert.rejects(f.host.beginTransfer(session,{commandId:randomUUID(),transferId,destination,expectedExecutionRevision:revision+1}),/expected execution revision/);
  const input={commandId:randomUUID(),transferId,destination,expectedExecutionRevision:revision};const fenced=await f.host.beginTransfer(session,input);assert.equal(fenced.phase,'source-fenced');assert.equal(f.host.diagnostics().activeAgents,0);
  assert.deepEqual(await f.host.beginTransfer(session,input),fenced);assert.equal((await readFile(f.authority+'.calls','utf8')).trim(),'source.fence');
  await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'must not run',clientId:'a'}),/transfer is fenced/);
  await assert.rejects(f.host.nativeControl(session,'fixture.background.start',{}),/transfer is fenced/);
  assert.equal((await f.host.relocateSession(session,{commandId:randomUUID(),target:f.dir,expectedExecutionRevision:revision+1})).executed,false);
  const other=await f.create(),id=randomUUID();await f.host.submitTurn(other,{commandId:id,text:'other still works',clientId:'a'});assert.equal((await f.host.waitForTurn(other,id)).completed,true);
  const command={commandId:randomUUID(),transferId},committed=await f.host.commitTransfer(session,command);assert.equal(committed.phase,'source-committed');await f.restart();
  assert.equal((await f.host.inspectSession(session)).transferFence?.status,'source-committed');assert.deepEqual(await f.host.commitTransfer(session,command),committed);
  await assert.rejects(f.host.cancelTransfer(session,{commandId:randomUUID(),transferId}),/reversible/);
  await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'still fenced',clientId:'a'}),/transfer is fenced/);
  assert.deepEqual((await readFile(f.authority+'.calls','utf8')).trim().split('\n'),['source.fence','source.commit']);
 }finally{await f.cleanup();}
});
test('lost source fencing response stays durable unknown until passive proof, never repeats original input',async()=>{
 const f=await setup({FIXTURE_TRANSFER_LOST_OPERATION:'source.fence'});try{
  const session=await f.create(),transferId=randomUUID();await f.authorize(session,transferId);const input={commandId:randomUUID(),transferId,destination,expectedExecutionRevision:(await f.host.inspectSession(session)).executionRevision};
  await assert.rejects(f.host.beginTransfer(session,input),(error:any)=>error.data.outcome==='unknown');await f.restart();
  assert.equal((await f.host.inspectSession(session)).transferFence?.status,'unknown');await assert.rejects(f.host.beginTransfer(session,input),/already attempted/);
  await assert.rejects(f.host.commitTransfer(session,{commandId:randomUUID(),transferId}),/confirmed/);
  assert.equal((await f.host.inspectTransfer(session,transferId)).hostFence?.status,'source-fenced');assert.equal((await f.host.inspectSession(session)).executionRevision,input.expectedExecutionRevision+1);
  assert.equal((await f.host.inspectTransfer(session,transferId)).hostFence?.status,'source-fenced');assert.equal((await f.host.inspectSession(session)).executionRevision,input.expectedExecutionRevision+1);
  await f.host.cancelTransfer(session,{commandId:randomUUID(),transferId});assert.equal((await f.host.inspectSession(session)).transferFence,undefined);
  const turnId=randomUUID();await f.host.submitTurn(session,{commandId:turnId,text:'explicit cancellation restored admission',clientId:'a'});assert.equal((await f.host.waitForTurn(session,turnId)).completed,true);
  assert.deepEqual((await readFile(f.authority+'.calls','utf8')).trim().split('\n'),['source.fence','source.cancel']);
 }finally{await f.cleanup();}
});
test('native owned background work refuses transfer without killing its lifetime',async()=>{
 const f=await setup();try{
  const session=await f.create(),transferId=randomUUID();await f.authorize(session,transferId);await f.host.nativeControl(session,'fixture.background.start',{});
  await assert.rejects(f.host.beginTransfer(session,{commandId:randomUUID(),transferId,destination,expectedExecutionRevision:0}),(error:any)=>error.data.executed===false);
  assert.equal((await f.host.inspectSession(session)).transferFence,undefined);assert.equal(f.host.diagnostics().activeAgents,1);
  await assert.rejects(readFile(f.authority+'.calls'),{code:'ENOENT'});await f.host.nativeControlExisting(session,'fixture.background.stop',{});
 }finally{await f.cleanup();}
});
test('destination independently verifies persisted proof, preserves AHP/native IDs, refuses conflicting identity and recovers metadata-only uncertainty',async()=>{
 const f=await setup();try{
  f.config.transferIdentity=destination;
  let fail=true;f.config.catalog={list:async()=>({items:[]}),get:async()=>undefined,upsert:async()=>{if(fail)throw new Error('catalog unavailable');}};await f.restart();
  const session='ahp-session:/original-public-id',nativeSessionId=randomUUID(),transferId=randomUUID(),releaseHash='c'.repeat(64);
  const input={session,nativeSessionId,transferId,releaseHash,commandId:randomUUID(),engineId:'fixture',historyHome:f.dir,executionDirectory:f.dir,source,destination,title:'Preserved identity'};
  const proof={version:1,transferId,nativeSessionId,historyCwd:f.dir,executionDirectory:f.dir,source,destination,phase:'activated',inputsReplayed:false,authority:'foundation-transfer-fence',releaseHash,historyRevision:'history-proof'};
  const seed=async(receipt:any,fence:any=null)=>writeFile(f.authority,JSON.stringify({[transferId]:{nativeSessionId,historyCwd:f.dir,receipt,fence}}));
  await seed({...proof,destination:source});await assert.rejects(f.host.adoptTransferredSession(input),/does not match/);assert.equal(f.host.store.get(session),undefined);
  await seed(proof,{transfer_id:transferId});await assert.rejects(f.host.adoptTransferredSession(input),/not proven/);assert.equal(f.host.store.get(session),undefined);
  await seed(proof);await assert.rejects(f.host.adoptTransferredSession(input),(error:any)=>error.data.outcome==='unknown');assert.equal(f.host.diagnostics().activeAgents,0);
  await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'must remain fenced',clientId:'a'}),/transfer is fenced/);
  fail=false;await f.restart();await f.host.inspectTransfer(session,transferId);const selected=await f.host.inspectSession(session);assert.equal(selected.nativeSessionId,nativeSessionId);assert.equal(selected.session,session);assert.equal(selected.transferFence,undefined);assert.equal(f.host.diagnostics().activeAgents,0);
  assert.equal((await f.host.adoptTransferredSession(input)).uri,session);await assert.rejects(f.host.adoptTransferredSession({...input,commandId:randomUUID(),nativeSessionId:randomUUID()}),/different native session/);
  const turnId=randomUUID();await f.host.submitTurn(session,{commandId:turnId,text:'new explicit work only',clientId:'a'});assert.equal((await f.host.waitForTurn(session,turnId)).completed,true);
 }finally{await f.cleanup();}
});

test('bounded workspace capture and transfer share only the selected session admission mutex',async()=>{
 const f=await setup();try{
  const session=await f.create(),other=await f.create(),transferId=randomUUID();await f.authorize(session,transferId);
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const capture=f.host.withSessionWorkspace(session,{},async snapshot=>{assert.equal(snapshot.executionDirectory,f.dir);entered();await gate;return 'captured';});await ready;
  let settled=false;const transfer=f.host.beginTransfer(session,{commandId:randomUUID(),transferId,destination,expectedExecutionRevision:0}).finally(()=>settled=true);
  const turnId=randomUUID();await f.host.submitTurn(other,{commandId:turnId,text:'unrelated session remains responsive',clientId:'a'});assert.equal((await f.host.waitForTurn(other,turnId)).completed,true);assert.equal(settled,false);
  release();assert.equal(await capture,'captured');assert.equal((await transfer).phase,'source-fenced');
  await assert.rejects(f.host.withSessionWorkspace(session,{},async()=>{throw new Error('must not start capture');}),/transfer is fenced/);
 }finally{await f.cleanup();}
});
