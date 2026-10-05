import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const {createHost}=await import(process.env.HOST_MODULE??'../src/host.js');
const A={installationId:'owned-install',dataScope:'owned-data',ownerId:'owned-unit',instanceId:'owned-A',releaseDigest:'capacity-test'};
test('a real ACP over-capacity update kills the peer without leaving phantom queued work', {timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'capacity-drain-'));
 const peer=join(dir,'peer.mjs');
 const source=await readFile(new URL('../fixtures/acp-peer.mjs',import.meta.url),'utf8');
 // An idle resident emits one frame within ACP framing limits, above the Host queue bound.
 await writeFile(peer,source.replace("else if(message.method==='_amplifier/native'&&p.operation==='configuration.snapshot')", "else if(message.method==='_amplifier/native'&&p.operation==='fixture.capacity'){reply(message.id,{});setTimeout(()=>update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(9*1024*1024)}}),20);}\n  else if(message.method==='_amplifier/native'&&p.operation==='configuration.snapshot')"));
 let stopped!:()=>void;const stop=new Promise<void>(resolve=>stopped=resolve);
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[peer]}],agentStopped:async()=>{stopped();},quiescence:{instanceId:A.instanceId,dataScope:A.dataScope,requiredOwners:[],coverage:{},participants:[],timeoutMs:25,verifyRelease:async()=>{throw Error('No proof');},serviceLifecycle:{identity:A,verifyRelease:async()=>{throw Error('No proof');}}}});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'owner',protocolVersions:['0.9.0']});
 try{
  const session='ahp-session:/capacity';await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
  await host.nativeControl(session,'fixture.capacity',{});
  host.store.admission(session,{},'retained-unknown','prior',1);host.store.finish('retained-unknown','unknown');const before=JSON.stringify(host.store.receipt('retained-unknown'));
  await stop;await new Promise(resolve=>setImmediate(resolve));
  const work=(host as any).quiescenceWork(true);assert.equal(work.counts.nativeUpdates,0,'a rejected frame has no queued completion');
  const active=(host as any).active.get(session);assert.equal(active.agent.closed,true);assert.equal(active.updateBytes??0,0);
  const closed=await host.closeServiceIntake({commandId:'capacity-stop',expected:A});const held=await host.admitServiceStop({commandId:'capacity-stop',expected:A});
  assert.equal(held.phase,'held');assert.equal(held.fenceId,closed.fenceId);assert.equal(held.evidence.activeWork,0);assert.equal(JSON.stringify(host.store.receipt('retained-unknown')),before);
 }finally{await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
