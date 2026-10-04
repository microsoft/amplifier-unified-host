import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
import {AhpClient} from '@microsoft/agent-host-protocol/client';import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const {createHost}=await import(process.env.HOST_REPLY_MODULE??'../src/host.js');
const {AcpProcess}=await import(process.env.HOST_REPLY_MODULE?new URL('./acp.js',process.env.HOST_REPLY_MODULE).href:'../src/acp.js');
const grant={version:1,quoteMeta:'amplifier.dev/messageReply',maxQuoteChars:4000,privateReplySelection:true,methods:['reaction','read','receipt']};
const ref={messageId:'native:public-source',position:0,historyEpoch:null,sourceDigest:'a'.repeat(64)};
const wait=async(check:()=>boolean)=>{for(let n=0;n<400;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('bounded wait expired');};
async function fixture(options:{principal?:string;grant?:any;history?:boolean}={principal:'trusted-server-account',grant}){
 const dir=await mkdtemp(join(tmpdir(),'host-reply-')),log=join(dir,'prompts'),init=join(dir,'initialize');
 const host=await createHost({stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],...(options.principal!==undefined?{messagePrincipal:options.principal}:{}),env:{FIXTURE_LOG:log,FIXTURE_MESSAGE_INIT:init,...(options.history?{FIXTURE_HISTORY:join(dir,'history.json'),FIXTURE_HISTORY_LIFECYCLE:'1'}:{}),...(options.grant?{FIXTURE_MESSAGE_INTERACTIONS:JSON.stringify(options.grant)}:{})}}]});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'untrusted-browser-account',protocolVersions:['0.9.0']});
 const session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
 return {dir,log,init,host,client,session,chat,close:async()=>{await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}};
}
test('quoted ordinary send uses trusted initialize principal and exact native reference with original input identity',async()=>{
 const f=await fixture();try{
  const commandId=randomUUID(),message={text:'Explicit quoted request',origin:{kind:'user'},_meta:{'amplifier.dev/messageReply':ref,'amplifier.dev/messagePrincipal':{version:1,account:'forged-browser-account'},'amplifier.dev/actor':{id:'forged'}}};
  f.client.dispatch(f.chat,{type:'chat/turnStarted',turnId:commandId,startedAt:new Date().toISOString(),message} as any);await wait(()=>f.host.store.receipt(commandId)?.status==='completed');
  const prompts=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(prompts.length,1);const selected=await f.host.inspectSession(f.session);
  assert.deepEqual(prompts[0]._meta,{'amplifier.dev/command':{commandId},'amplifier.dev/messageReply':{...ref,sessionId:selected.nativeSessionId}});assert.deepEqual(prompts[0].prompt,[{type:'text',text:'Explicit quoted request'}]);
  const initialization=JSON.parse((await readFile(f.init,'utf8')).trim().split('\n')[0]);assert.equal(initialization._meta,undefined);assert.deepEqual(initialization.clientCapabilities._meta['amplifier.dev/native'],{version:1});assert.deepEqual(initialization.clientCapabilities._meta['amplifier.dev/messagePrincipal'],{version:1,account:'trusted-server-account'});
  f.client.dispatch(f.chat,{type:'chat/turnStarted',turnId:commandId,startedAt:new Date().toISOString(),message} as any);await new Promise(r=>setTimeout(r,30));assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);assert.equal(f.host.store.receipt(commandId)?.status,'completed');
 }finally{await f.close();}
});
test('unsupported quote grants retain exact queued draft without prompt effects or receipt admission',async()=>{
 for(const options of [{principal:'trusted',grant:undefined},{principal:undefined,grant},{principal:'trusted',grant:{...grant,version:2}},{principal:'trusted',grant:{...grant,quoteMeta:'foreign'}}]){
  const f=await fixture(options);try{const id=randomUUID(),message={text:'Keep this draft',origin:{kind:'user'},_meta:{'amplifier.dev/messageReply':ref}};
   const result=await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'queued',id,message} as any,{clientId:'untrusted-browser-account'});assert.equal(result.pending,true);assert.equal(f.host.store.receipt(id),undefined);
   const saved=f.host.store.db.prepare('SELECT message,status,held,reason FROM queue_intents WHERE id=?').get(id)!;assert.equal(saved.status,'pending');assert.equal(saved.held,1);assert.match(String(saved.reason),/does not support quoted/);assert.deepEqual(JSON.parse(String(saved.message))._meta['amplifier.dev/messageReply'],ref);await assert.rejects(readFile(f.log));
  }finally{await f.close();}
 }
});
test('invalid external quote fields and bounds refuse before replacing a retained draft or resolving attachments',async()=>{
 const f=await fixture();try{
  const id=randomUUID();await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'queued',id,message:{text:'slow',origin:{kind:'user'}}} as any,{clientId:'owner'});await wait(()=>f.host.store.receipt(id)?.status==='dispatching');
  const draft=randomUUID(),message={text:'Preserved draft',origin:{kind:'user'},_meta:{'amplifier.dev/messageReply':ref}};await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'queued',id:draft,message} as any,{clientId:'owner'});const before=f.host.store.db.prepare('SELECT message FROM queue_intents WHERE id=?').get(draft)!.message;
  for(const invalid of [null,[],{...ref,sessionId:'other'},{...ref,actorId:'caller'},{...ref,excerpt:'forged'},{...ref,path:'/caller'}, {...ref,position:-1},{...ref,position:Number.MAX_SAFE_INTEGER+1},{...ref,messageId:'x'.repeat(201)},{...ref,historyEpoch:''},{messageId:'source',position:0},{...ref,sourceDigest:'not-a-digest'}]){
   await assert.rejects(f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'queued',id:draft,message:{...message,_meta:{'amplifier.dev/messageReply':invalid}}} as any,{clientId:'owner'}),/bounded native message reply/);assert.equal(f.host.store.db.prepare('SELECT message FROM queue_intents WHERE id=?').get(draft)!.message,before);assert.equal(f.host.store.receipt(draft),undefined);
  }
  await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageRemoved',kind:'queued',id:draft} as any,{clientId:'owner'});await wait(()=>f.host.store.receipt(id)?.status==='completed');
 }finally{await f.close();}
});
test('lost quoted input remains unknown and blocks retry without dropping reference or changing input identity',async()=>{
 const f=await fixture();try{const id=randomUUID(),message={text:'crash',origin:{kind:'user'},_meta:{'amplifier.dev/messageReply':ref}};f.client.dispatch(f.chat,{type:'chat/turnStarted',turnId:id,startedAt:new Date().toISOString(),message} as any);await wait(()=>f.host.store.receipt(id)?.status==='unknown');
  const before=f.host.store.receipt(id);f.client.dispatch(f.chat,{type:'chat/turnStarted',turnId:id,startedAt:new Date().toISOString(),message} as any);await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.host.store.receipt(id),before);const prompts=(await readFile(f.log,'utf8')).trim().split('\n').map(row=>JSON.parse(row));assert.equal(prompts.length,1);assert.equal(prompts[0]._meta['amplifier.dev/command'].commandId,id);const retained=JSON.parse(String(f.host.store.db.prepare('SELECT payload FROM turns WHERE chat=? AND turn_id=?').get(f.chat,id)!.payload));assert.deepEqual(retained.message._meta['amplifier.dev/messageReply'],ref);
 }finally{await f.close();}
});
test('server-only principal bound rejects invalid accounts before spawning an ACP process',()=>{
 for(const messagePrincipal of ['', ' ', 'x'.repeat(201), 'account\nother', 42])assert.throws(()=>new AcpProcess({id:'fixture',label:'Fixture',command:'/never-spawn',messagePrincipal} as any,tmpdir(),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}})}),/bounded nonempty account/);
});

test('bounded selected refresh preserves canonical user/assistant locators and frozen quotes without replacing admission provenance',async()=>{
 const f=await fixture({principal:'trusted',grant,history:true});try{
  const id=randomUUID();await f.host.submitTurn(f.session,{commandId:id,text:'Live input',clientId:'retained-client'});await wait(()=>f.host.store.receipt(id)?.status==='completed');const native=(await f.host.inspectSession(f.session)).nativeSessionId;
  const locator={...ref,sessionId:native},answer={...locator,messageId:'native:answer',position:200},quote={id:'b'.repeat(64),sessionId:'original-native-source',messageId:'native:original',role:'assistant',sourceDigest:'c'.repeat(64),historyEpoch:null,inputId:id,excerpt:'Bounded canonical earlier excerpt',truncated:false};
  const history=(historicalOnly=false)=>[{id,state:'complete',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'Canonical input'},_meta:{'amplifier.dev/history':{messageId:locator.messageId,messageReference:locator,replyTo:quote,inputOrigin:'unverified',...(historicalOnly?{historicalOnly:true}:{})}}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Canonical answer'},_meta:{'amplifier.dev/history':{messageId:answer.messageId,messageReference:answer,replyTo:quote}}}]}];
  await writeFile(join(f.dir,'history.json'),JSON.stringify(history()));const receipt=f.host.store.receipt(id);assert.equal((await f.host.refreshSessionHistory(f.session,{limit:1})).refreshedTurns,1);
  const row=()=>JSON.parse(String(f.host.store.db.prepare('SELECT payload FROM turns WHERE chat=? AND turn_id=?').get(f.chat,id)!.payload));let retained=row();assert.deepEqual(retained.message._meta['amplifier.dev/history'].messageReference,locator);assert.deepEqual(retained.message._meta['amplifier.dev/history'].replyTo,quote);assert.equal(retained.message.text,'Live input');assert.deepEqual(retained.responseParts[0]._meta['amplifier.dev/history'].messageReference,answer);assert.deepEqual(retained.responseParts[0]._meta['amplifier.dev/history'].replyTo,quote);assert.deepEqual(f.host.store.receipt(id),receipt);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
  const snapshot=(await f.client.subscribe(f.session)).result.snapshot!.state as any;assert.deepEqual(snapshot._meta['amplifier.dev/acp'].capabilities._meta['amplifier.dev/native'].messageInteractions,grant);
  await writeFile(join(f.dir,'history.json'),JSON.stringify(history(true)));await f.host.refreshSessionHistory(f.session,{limit:1});retained=row();assert.equal(retained.message._meta['amplifier.dev/history'].messageReference,undefined);assert.deepEqual(retained.message._meta['amplifier.dev/history'].replyTo,quote);
  const before=JSON.stringify(retained);for(const invalid of [{...locator,sessionId:'foreign'},{...locator,excerpt:'caller'},{...locator,sourceDigest:'bad'}]){const malformed=history();malformed[0].updates[0]._meta['amplifier.dev/history'].messageReference=invalid;await writeFile(join(f.dir,'history.json'),JSON.stringify(malformed));await assert.rejects(f.host.refreshSessionHistory(f.session,{limit:1}),/quote metadata/);assert.equal(JSON.stringify(row()),before);assert.deepEqual(f.host.store.receipt(id),receipt);}
  const malformed=history();malformed[0].updates[0]._meta['amplifier.dev/history'].replyTo={...quote,excerpt:'x'.repeat(4001)};await writeFile(join(f.dir,'history.json'),JSON.stringify(malformed));await assert.rejects(f.host.refreshSessionHistory(f.session,{limit:1}),/quote metadata/);assert.equal(JSON.stringify(row()),before);
 }finally{await f.close();}
});

test('public settled marker follows joined idle cleanup and allows bounded refresh without an early completion retry',async()=>{
 const f=await fixture({principal:'trusted',grant,history:true});let stop:(()=>void)|undefined;
 try{
  const id=randomUUID(),observed:any[]=[];let refreshed:any,earlyBusy=false;
  const native=(await f.host.inspectSession(f.session)).nativeSessionId;const canonical={id,state:'complete',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'canonical'},_meta:{'amplifier.dev/history':{messageId:'native:canonical',messageReference:{...ref,messageId:'native:canonical',sessionId:native}}}}]};await writeFile(join(f.dir,'history.json'),JSON.stringify([canonical]));
  stop=await f.host.observeSession(f.session,async(event:any)=>{if(event.action.type==='chat/turnComplete')earlyBusy=!!(f.host as any).active.get(f.session)?.busy;const marker=event.action.type==='session/metaChanged'&&event.action._meta?.['amplifier.dev/acp']?.lastSettledTurnId;if(marker){const active=(f.host as any).active.get(f.session);observed.push({id:marker,busy:active.busy,finishing:active.finishing});refreshed=await f.host.refreshSessionHistory(f.session,{limit:1});}});
  await f.host.submitTurn(f.session,{commandId:id,text:'ordinary',clientId:'marker-client'});await wait(()=>!!refreshed);assert.equal(earlyBusy,true);assert.deepEqual(observed,[{id,busy:false,finishing:false}]);assert.equal(refreshed.refreshed,true);assert.equal(refreshed.refreshedTurns,1);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{stop?.();await f.close();}
});
test('queued next input defers settled refresh signal until an idle completed turn, without replay',async()=>{
 const f=await fixture();let stop:(()=>void)|undefined;
 try{
  const first=randomUUID(),next=randomUUID(),markers:any[]=[];stop=await f.host.observeSession(f.session,(event:any)=>{const id=event.action.type==='session/metaChanged'&&event.action._meta?.['amplifier.dev/acp']?.lastSettledTurnId;if(id&&!markers.some(row=>row.id===id)){const active=(f.host as any).active.get(f.session);markers.push({id,busy:active.busy,finishing:active.finishing});}});
  await f.host.submitTurn(f.session,{commandId:first,text:'slow',clientId:'marker-client'});await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'queued',id:next,message:{text:'next ordinary',origin:{kind:'user'}}} as any,{clientId:'marker-client'});await wait(()=>markers.some(row=>row.id===next));assert.equal(f.host.store.receipt(first)?.status,'completed');assert.equal(f.host.store.receipt(next)?.status,'completed');assert.ok(markers.every(row=>!row.busy&&!row.finishing));assert.equal(markers.filter(row=>row.id===next).length,1);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,2);
 }finally{stop?.();await f.close();}
});
