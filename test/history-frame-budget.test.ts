import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
test('large history defaults to a bounded page; oversized views refuse without disconnect or broadcast',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'history-budget-')));
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('./agent.mjs',import.meta.url))]}]});
 const clients:AhpClient[]=[];
 const connect=async(id:string)=>{const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:id,protocolVersions:['0.9.0']});clients.push(c);return c;};
 try{
  const a=await connect('a'),b=await connect('b');const session='ahp-session:/budget',chat='ahp-chat:/budget';
  await a.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
  host.store.transaction(()=>{for(let i=0;i<10000;i++)host.store.saveTurn(chat,{id:'turn-'+i,state:'complete',message:{text:'x'.repeat(1800),origin:{kind:'user'}},responseParts:[],startedAt:new Date().toISOString(),duration:1} as any);});
  const small=await b.subscribe(chat,{view:{turns:1}}),events:any[]=[];
  void(async()=>{for await(const event of small.subscription)events.push(event);})();
  const recent:any=(await a.subscribe(chat)).result.snapshot!.state;
  assert.equal(recent.turns.length,50);assert.equal(recent.turns[0].id,'turn-9950');assert.ok(recent.turnsNextCursor);
  await assert.rejects(a.subscribe(chat,{view:{turns:10000}}),(e:any)=>e.code===-32013);
  assert.equal(await a.request('ping',{}),null);assert.equal(await b.request('ping',{}),null);
  assert.ok(!events.some(e=>e.params?.action?.type==='chat/turnsLoaded'&&e.params.action.turns.length>50));
  await a.request('fetchTurns',{channel:chat,cursor:recent.turnsNextCursor});
  host.store.saveTurn(chat,{id:'huge',state:'complete',message:{text:'x'.repeat(5*1024*1024),origin:{kind:'user'}},responseParts:[],duration:1} as any);
  await assert.rejects(a.subscribe(chat,{view:{turns:1}}),(e:any)=>e.code===-32013);
  assert.equal(await a.request('ping',{}),null);
 }finally{for(const c of clients)await c.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
test('initialize rejects malformed version containers and keeps negotiation available',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'versions-'));const host=await createHost({stateDirectory:dir,allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('./agent.mjs',import.meta.url))]}]});
 const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();
 try{
  for(const protocolVersions of ['not-an-array-0.9.0',[],[null],[9],['garbage'],['0.9.0',{}]])await assert.rejects(c.request('initialize',{clientId:'test',protocolVersions}),(e:any)=>e.code===-32602);
  await assert.rejects(c.request('initialize',{clientId:'test',protocolVersions:['0.8.0']}),(e:any)=>e.code===-32005);
  assert.equal((await c.request('initialize',{clientId:'test',protocolVersions:['0.9.0']})).protocolVersion,'0.9.0');
 }finally{await c.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
