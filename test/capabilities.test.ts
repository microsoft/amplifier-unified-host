import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost} from '../src/host.js';

test('native and client capability effects share durable admission and never rerun an uncertain effect',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-capabilities-'));const calls:any[]=[];
 const host=await createHost({stateDirectory:directory,allowedWorkspaceRoots:[directory],engines:[{id:'unused',label:'Unused',command:'/deliberately-unavailable'}],capabilities:{manifest:{version:1,topics:{fixture:{uri:'fixture://topic',version:1}},actions:{'fixture.effect':{topic:'fixture',operation:'effect',method:'x-amplifier/capabilityAction'}}},read:async()=>({topic:'fixture',scope:'host',revision:0,data:{}}),action:async(request,context)=>{calls.push({request,context});throw Error('Effect outcome uncertain');}}});
 try{
  const request={channel:'ahp-root://',topic:'fixture',operation:'effect',version:1,args:{},commandId:'native-stable-effect'};
  await assert.rejects(host.invokeCapability(request,{actorId:'agent:root',origin:'agent'}),/uncertain/);
  assert.equal(host.store.receipt(request.commandId)?.status,'unknown');
  await assert.rejects(host.invokeCapability(request,{actorId:'agent:root'}),/already admitted/);
  assert.equal(calls.length,1);assert.equal(calls[0].context.clientId,'');assert.equal(calls[0].context.origin,'agent');assert.equal(host.diagnostics().activeAgents,0);
 }finally{await host.close();await rm(directory,{recursive:true,force:true});}
});
