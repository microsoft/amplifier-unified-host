import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
import {toolInputDetail,toolResultDetail,TOOL_RESULT_TYPE} from '../src/tool-details.js';
test('small input/result stay inline and explicit null clears old input',async()=>{
 const save=async()=>{throw Error('Small payload must remain inline');};
 assert.equal(await toolInputDetail(null,save),'null');assert.equal(await toolInputDetail(undefined,save),undefined);
 assert.equal(await toolInputDetail({x:1},save),'{"x":1}');
 const result={success:false,pastTenseMessage:'Failed',structuredContent:{output:null}};
 assert.equal(await toolResultDetail(result,save),result);
});
test('large tool bodies are read on demand and survive host restart without execution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'host-tool-details-')),log=join(root,'calls');
 const config={stateDirectory:join(root,'state'),allowedWorkspaceRoots:[root],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/tool-details-acp.mjs',import.meta.url))],env:{FIXTURE_LOG:log}}]};
 let host=await createHost(config),client:AhpClient;
 const connect=async()=>{client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'details',protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});};
 const session='ahp-session:/details',chat='ahp-chat:/details';
 try{
  await connect();await client!.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(root).href]});
  await host.submitTurn(session,{commandId:'details-turn',text:'large details',clientId:'details'});await host.waitForTurn(session,'details-turn');
  const view:any=(await client!.subscribe(chat,{view:{turns:20}})).result.snapshot!.state;
  const raw=JSON.stringify(view);assert.ok(raw.length<14000,`Snapshot too large: ${raw.length}`);assert.ok(!raw.includes('OUTPUT-LARGE-'));assert.ok(!raw.includes('INPUT-LARGE-'));
  const tool=view.turns[0].responseParts.find((p:any)=>p.kind==='toolCall').toolCall;
  assert.equal(tool.toolInput.contentType,'application/json');assert.equal(tool.structuredContent,undefined);assert.equal(tool.content[0].contentType,TOOL_RESULT_TYPE);
  const outputRef=tool.content[0].uri,inputRef=tool.toolInput.uri;
  const read=async(uri:string)=>client!.request('resourceRead',{channel:'ahp-root://',uri,encoding:'utf-8'}) as Promise<any>;
  assert.equal(JSON.parse((await read(inputRef)).data).payload,'INPUT-LARGE-'.repeat(1000));
  assert.equal(JSON.parse((await read(outputRef)).data).structuredContent.output.stdout,'OUTPUT-LARGE-'.repeat(12000)+'FINAL-OUTPUT-MARKER');
  await client!.shutdown();await host.close();host=await createHost(config);await connect();
  const again:any=(await client!.subscribe(chat,{view:{turns:20}})).result.snapshot!.state;
  assert.deepEqual(again.turns,view.turns);assert.ok((await read(outputRef)).data.includes('FINAL-OUTPUT-MARKER'));
  assert.equal(await readFile(log,'utf8'),'prompt\n');assert.equal(host.diagnostics().activeAgents,0);
  const blob=join(root,'state','content',outputRef.slice('ahp-content:/'.length));
  await writeFile(blob,'corrupted');
  await assert.rejects(read(outputRef),/integrity check failed/);
 }finally{await client!?.shutdown();await host.close();await rm(root,{recursive:true,force:true});}
});
test('large replacement input stays fully visible while permission is pending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'host-tool-approval-')),log=join(root,'calls');
 const host=await createHost({stateDirectory:join(root,'state'),allowedWorkspaceRoots:[root],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/tool-details-acp.mjs',import.meta.url))],env:{FIXTURE_LOG:log}}]});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 const session='ahp-session:/approval',chat='ahp-chat:/approval';
 try{
  await client.initialize({clientId:'reviewer',protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});
  await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(root).href]});
  await client.subscribe(chat,{view:{turns:10}});
  await host.submitTurn(session,{commandId:'approval-turn',text:'approval',clientId:'reviewer'});
  let tool:any;
  for(let count=0;count<100;count++){
   tool=(host.store.get(chat)?.chat.activeTurn?.responseParts.find((p:any)=>p.kind==='toolCall') as any)?.toolCall;
   if(typeof tool?.toolInput==='string'&&tool.toolInput.includes('echo reviewed replacement'))break;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(tool.status,'pending-confirmation');assert.equal(typeof tool.toolInput,'string');
  assert.deepEqual(JSON.parse(tool.toolInput),{command:'echo reviewed replacement',payload:'INPUT-LARGE-'.repeat(1000)});
  assert.equal(await readFile(log,'utf8'),'prompt\n');
  client.dispatch(chat,{type:'chat/toolCallConfirmed',turnId:'approval-turn',toolCallId:'large',approved:true,confirmed:'user-action',selectedOptionId:'allow'});
  await host.waitForTurn(session,'approval-turn');
  assert.ok((await readFile(log,'utf8')).includes('"optionId":"allow"'));
 }finally{await client.shutdown();await host.close();await rm(root,{recursive:true,force:true});}
});
