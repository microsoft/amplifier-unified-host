import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
const A={installationId:'owned-install',dataScope:'owned-data',ownerId:'owned-unit',instanceId:'owned-A',releaseDigest:'review'};
const tick=()=>new Promise<void>(r=>setImmediate(r));
test('autonomous idle retirement completing after intake closure wakes original service drain', {timeout:5000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'independent-idle-drain-'));const log=join(dir,'native.log');
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL(process.env.REVIEW_RETIRE_SUCCESS==='1'?'../fixtures/acp-peer-idle-drain-review.mjs':'../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:log,FIXTURE_RETIRE_DELAY:'150'}}],quiescence:{instanceId:A.instanceId,dataScope:A.dataScope,requiredOwners:[],coverage:{},participants:[],timeoutMs:25,verifyRelease:async()=>{throw Error('No proof');},serviceLifecycle:{identity:A,verifyRelease:async()=>{throw Error('No proof');}}}});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'owned-reviewer',protocolVersions:['0.9.0']});
 let drain:Promise<any>|undefined;
 try{
  const session='ahp-session:/owned-idle-drain';await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
  await host.nativeControl(session,'capabilities',{});
  // Invoke the timer's real executor directly to avoid waiting ten seconds for setInterval.
  const retiring=(host as any).retireIdle(true);
  for(let i=0;;i++){try{if((await readFile(log+'.retirement-requests','utf8')).includes('retire'))break;}catch{}assert.ok(i<100,'retirement must start');await new Promise(r=>setTimeout(r,5));}
  const closed=await host.closeServiceIntake({commandId:'stop-during-idle-retire',expected:A});let settled=false;
  drain=host.admitServiceStop({commandId:'stop-during-idle-retire',expected:A}).then(r=>{settled=true;return r;});
  await tick();const during=(host as any).quiescenceWork(true);assert.equal(during.counts.activeControls,1);
  await retiring;await tick();await tick();
  const after=(host as any).quiescenceWork(true);
  const observation={during,after,settled,receipt:host.serviceStopReceipt('stop-during-idle-retire'),closedFence:closed.fenceId};
  if(process.env.REVIEW_OBSERVATION)await writeFile(process.env.REVIEW_OBSERVATION,JSON.stringify(observation,null,2)+'\n');
  assert.ok(Object.values(after.counts).every(n=>n===0),'all local work must be finished before checking missed notification');
  assert.equal(settled,true,'idle retirement finally must notify the drain when activeControls reaches zero');
  assert.equal((await drain).phase,'held');
 }finally{
  // Review cleanup only: wake the otherwise stuck waiter without replay/releasing any effect.
  (host as any).intake.workChanged();await drain;await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});
 }
});
