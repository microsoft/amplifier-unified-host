import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {SessionStatus} from '@microsoft/agent-host-protocol';
import {createHost} from '../src/host.js';
const wait=async(fn:()=>unknown)=>{for(let n=0;n<500;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};

test('standard shared read state is cleared at work boundaries and survives cold host restart',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ahp-read-state-'))),config={stateDirectory:join(root,'host'),allowedWorkspaceRoots:[root],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}]};
 let host=await createHost(config);const clients:AhpClient[]=[];const events:any[][]=[[],[]];
 const connect=async(id:string)=>{const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:id,protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});clients.push(c);return c;};
 try{
  const a=await connect('a'),b=await connect('b'),uri='ahp-session:/'+randomUUID();await a.request('createSession',{channel:uri,provider:'fixture',workingDirectories:[pathToFileURL(root).href]});
  for(const [index,c] of [a,b].entries()){const s=await c.subscribe(uri);void(async()=>{for await(const e of s.subscription)if(e.type==='action')events[index].push(e.params);})();}
  const read=()=>Boolean(host.store.get(uri)!.state.status&SessionStatus.IsRead);
  a.dispatch(uri,{type:'session/isReadChanged',isRead:true});await wait(read);
  const id=randomUUID();await host.submitTurn(uri,{commandId:id,text:'slow',clientId:'a'});assert.equal(read(),false);
  b.dispatch(uri,{type:'session/isReadChanged',isRead:true});await wait(read);
  await host.waitForTurn(uri,id);assert.equal(read(),false,'Completion after a mid-turn read is new work');
  await wait(()=>events.every(list=>list.filter(e=>e.action.type==='session/isReadChanged'&&!e.action.isRead).length===2));
  assert.deepEqual(events[0].filter(e=>e.action.type==='session/isReadChanged').map(e=>e.action),events[1].filter(e=>e.action.type==='session/isReadChanged').map(e=>e.action));
  a.dispatch(uri,{type:'session/isReadChanged',isRead:true});await wait(read);
  await a.subscribe(uri.replace('ahp-session:','ahp-chat:'),{view:{turns:1}});assert.equal(read(),true,'Reading historical pages is not new activity');
  const list:any=await b.request('listSessions',{channel:'ahp-root://',limit:1});assert.ok(list.items[0].status&SessionStatus.IsRead);
  for(const c of clients)await c.shutdown();clients.length=0;await host.close();host=await createHost(config);assert.equal(read(),true);assert.equal(host.diagnostics().activeAgents,0);
 }finally{for(const c of clients)await c.shutdown();await host.close();await rm(root,{recursive:true,force:true});}
});

test('marking an approval read does not acknowledge or resolve its input requirement',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ahp-approval-read-')));const host=await createHost({stateDirectory:join(root,'state'),allowedWorkspaceRoots:[root],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}]});let client:AhpClient|undefined;
 try{
  client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'reader',protocolVersions:['0.9.0']});const uri='ahp-session:/'+randomUUID(),chat=uri.replace('ahp-session:','ahp-chat:');await client.request('createSession',{channel:uri,provider:'fixture',workingDirectories:[pathToFileURL(root).href]});await client.subscribe(uri);await client.subscribe(chat,{view:{turns:1}});
  const id=randomUUID();await host.submitTurn(uri,{commandId:id,text:'approval',clientId:'reader'});await wait(()=>host.store.get(uri)?.state.inputNeeded?.length===1);
  const before=structuredClone(host.store.get(uri)!.state.inputNeeded);client.dispatch(uri,{type:'session/isReadChanged',isRead:true});await wait(()=>Boolean(host.store.get(uri)!.state.status&SessionStatus.IsRead));
  assert.deepEqual(host.store.get(uri)!.state.inputNeeded,before);assert.ok(host.store.get(uri)!.summary.status&SessionStatus.InputNeeded);assert.notEqual(host.store.receipt(id)?.status,'completed');
  client.dispatch(chat,{type:'chat/toolCallConfirmed',turnId:id,toolCallId:'tool-1',approved:false,selectedOptionId:'deny'});await host.waitForTurn(uri,id);assert.equal(host.store.get(uri)!.state.inputNeeded?.length??0,0);
 }finally{await client?.shutdown();await host.close();await rm(root,{recursive:true,force:true});}
});
