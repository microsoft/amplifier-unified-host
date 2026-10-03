import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost} from '../src/host.js';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

test('native and client capability effects share durable admission and never rerun an uncertain effect',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-capabilities-'));const calls:any[]=[];
 const host=await createHost({stateDirectory:directory,allowedWorkspaceRoots:[directory],engines:[{id:'unused',label:'Unused',command:'/deliberately-unavailable'}],capabilities:{manifest:{version:1,topics:{fixture:{uri:'fixture://topic',version:1}},actions:{'fixture.effect':{topic:'fixture',operation:'effect',method:'x-amplifier/capabilityAction'}}},read:async()=>({topic:'fixture',scope:'host',revision:0,data:{}}),action:async(request,context)=>{calls.push({request,context});throw Error('Effect outcome uncertain');}}});
 try{
  const request={channel:'ahp-root://',topic:'fixture',operation:'effect',version:1,args:{},commandId:'native-stable-effect'};
  await assert.rejects(host.invokeCapability(request,{actorId:'agent:root',origin:'agent'}),/uncertain/);
  assert.equal(host.store.receipt(request.commandId)?.status,'unknown');
  await assert.rejects(host.invokeCapability(request,{actorId:'agent:root'}),/already admitted/);
  assert.equal(calls.length,1);assert.equal(calls[0].context.actorId,'agent:root');assert.equal(calls[0].context.clientId,'');assert.equal(calls[0].context.origin,'agent');assert.equal(host.diagnostics().activeAgents,0);
 }finally{await host.close();await rm(directory,{recursive:true,force:true});}
});

test('a long capability RPC never holds the handshake barrier or same-resource control and receipt reads',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-capability-concurrency-'));
 let ready!:()=>void,release!:()=>void,entered!:()=>void;
 const handshake=new Promise<void>(resolve=>ready=resolve),waiting=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),calls:string[]=[];
 const host=await createHost({stateDirectory:directory,allowedWorkspaceRoots:[directory],engines:[{id:'unused',command:'/must-not-start'}],clientMetadata:async()=>{await handshake;return {};},capabilities:{manifest:{version:1,topics:{fixture:{uri:'fixture://topic',version:1}},actions:Object.fromEntries(['wait','control'].map(operation=>[operation,{topic:'fixture',operation,method:'x-amplifier/capabilityAction'}]))},read:async()=>({topic:'fixture',scope:'host',revision:0,data:{ready:true}}),action:async request=>{calls.push(request.commandId);if(request.operation==='wait'){entered();await waiting;}return {accepted:true};}}});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 const action=(operation:string,commandId:string)=>({channel:'ahp-root://',topic:'fixture',operation,version:1,args:{},commandId});
 try{
  const initialized=client.initialize({clientId:'concurrent-client',protocolVersions:['0.9.0']});
  let settled=false;const pending=client.request('x-amplifier/capabilityAction' as any,action('wait','wait-one') as any).then(value=>{settled=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(calls,[]);ready();await initialized;await started;
  const start=performance.now();
  const effects=await Promise.allSettled([client.request('x-amplifier/capabilityAction' as any,action('control','control-one') as any),client.request('x-amplifier/capabilityAction' as any,action('control','control-one') as any)]);
  assert.equal(effects.filter(value=>value.status==='fulfilled').length,1);assert.equal(effects.filter(value=>value.status==='rejected').length,1);
  const receipt:any=await client.request('x-commandReceipt' as any,{channel:'ahp-root://',commandId:'control-one'} as any);assert.equal(receipt.status,'completed');
  await client.request('listSessions',{channel:'ahp-root://',limit:50});await client.request('resourceRead',{channel:'ahp-root://',uri:'fixture://topic?scope=host',encoding:'utf-8'});
  assert.ok(performance.now()-start<2000);assert.equal(settled,false);assert.equal(calls.filter(id=>id==='control-one').length,1);
  release();await pending;assert.equal(host.diagnostics().activeAgents,0);
 }finally{ready();release();await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});
