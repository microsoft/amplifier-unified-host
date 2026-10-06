import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
const wait=async(fn:()=>unknown)=>{for(let n=0;n<500;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'capability-review-')),session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:'),turnId=randomUUID();let effects=0;
 const host=await createHost({stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}],capabilities:{manifest:{version:1,topics:{fixture:{uri:'fixture://review',scope:'host',version:1}},actions:{publish:{topic:'fixture',operation:'publish',method:'x-amplifier/capabilityAction'}}},read:async()=>({topic:'fixture',scope:'host',revision:0,data:{}}),action:async(request,context)=>{await host.confirmCapability(context.session!.uri,{operation:'fixture.publish',title:'Send reviewed content?',args:request.args});effects++;return {accepted:true};}}});
 const clients:AhpClient[]=[];
 const connect=async()=>{const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:randomUUID(),protocolVersions:['0.9.0']});clients.push(c);return c;};
 const a=await connect(),b=await connect();await a.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});await a.subscribe(chat,{view:{turns:2}});await b.subscribe(chat,{view:{turns:2}});
 const start=async()=>{a.dispatch(chat,{type:'chat/turnStarted',turnId,startedAt:new Date().toISOString(),message:{text:'approval',origin:{kind:'user'}}});await wait(()=>host.store.get(session)?.chat.activeTurn?.responseParts.some((p:any)=>p.toolCall?.toolCallId==='tool-1'));};
 const approve=(c:AhpClient,id:string,yes=true,turn=turnId)=>c.dispatch(chat,{type:'chat/toolCallConfirmed',turnId:turn,toolCallId:id,approved:yes,confirmed:'user-action',selectedOptionId:yes?'approve':'deny'});
 const request=(commandId:string)=>host.invokeCapability({channel:'ahp-root://',topic:'fixture',operation:'publish',version:1,commandId,args:{title:'Exact report',body:'Reviewed **body**'}},{actorId:'agent:fixture',origin:'agent',session});
 const review=()=>host.store.get(session)?.chat.activeTurn?.responseParts.find((p:any)=>p.toolCall?.toolCallId.startsWith('capability-approval:')) as any;
 return {host,a,b,session,chat,turnId,start,approve,request,review,get effects(){return effects;},close:async()=>{for(const c of clients)await c.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}};
}
test('one exact capability approval through two official clients authorizes one effect',async()=>{
 const f=await fixture();try{
  await f.start();const pending=f.request('review-once');await wait(f.review);const tool=f.review().toolCall;
  assert.equal(f.effects,0);assert.equal(tool.status,'pending-confirmation');assert.deepEqual(JSON.parse(tool.toolInput),{operation:'fixture.publish',args:{title:'Exact report',body:'Reviewed **body**'}});
  f.approve(f.a,tool.toolCallId,true,'wrong-turn');await new Promise(r=>setTimeout(r,30));assert.equal(f.effects,0);
  f.approve(f.a,tool.toolCallId);f.approve(f.b,tool.toolCallId);await pending;assert.equal(f.effects,1);assert.equal(f.host.store.receipt('review-once')?.status,'completed');
  await assert.rejects(f.request('review-once'),/already admitted/);assert.equal(f.effects,1);
 }finally{await f.close();}
});
for(const mode of ['deny','cancel','turn-ended'] as const)test('capability review '+mode+' never dispatches or replays the effect',async()=>{
 const f=await fixture();try{
  await f.start();const pending=assert.rejects(f.request(mode),error=>(error as any).data?.executed===false);await wait(f.review);const id=f.review().toolCall.toolCallId;
  if(mode==='deny')f.approve(f.a,id,false);
  else if(mode==='cancel')f.a.dispatch(f.chat,{type:'chat/turnCancelled',turnId:f.turnId});
  else f.a.dispatch(f.chat,{type:'chat/toolCallConfirmed',turnId:f.turnId,toolCallId:'tool-1',approved:false,confirmed:'user-action',selectedOptionId:'deny'});
  await pending;assert.equal(f.effects,0);assert.equal(f.host.store.receipt(mode)?.status,'failed');await assert.rejects(f.request(mode),/already admitted/);
 }finally{await f.close();}
});
test('inactive sessions and oversized requests do not start work or create a review',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.request('inactive'),/active originating/);assert.equal(f.host.store.receipt('inactive')?.status,'failed');
  await f.start();await assert.rejects(f.host.confirmCapability(f.session,{operation:'fixture.publish',title:'Too large',args:{body:'x'.repeat(70000)}}),/review limit/);assert.equal(f.review(),undefined);assert.equal(f.effects,0);
 }finally{await f.close();}
});
