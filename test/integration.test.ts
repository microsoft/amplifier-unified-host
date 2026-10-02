import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';
import { StdioCatalog } from '../src/catalog.js';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';

test('independent catalog process + real Amplifier passive ACP history, with no prepared bundle', {skip:!process.env.CATALOG_EXECUTABLE||!process.env.ACP_EXECUTABLE},async()=>{
  const temp=await mkdtemp(join(tmpdir(),'ahp-native-interop-')),workspace=await realpath(temp),home=join(workspace,'native');
  const nativeId='existing-native',native=join(home,'projects',workspace.replaceAll('/','-'),'sessions',nativeId);
  await mkdir(native,{recursive:true});const transcript=join(native,'transcript.jsonl');
  const source=JSON.stringify({role:'user',content:'historical request',metadata:{amplifier_input:{id:'stable-native-turn'}}})+'\n'+JSON.stringify({role:'assistant',content:'historical answer'})+'\n';
  await writeFile(transcript,source);await writeFile(join(native,'metadata.json'),JSON.stringify({session_id:nativeId,working_directory:workspace}));
  const config=join(workspace,'agent.json');await writeFile(config,JSON.stringify({home,bundle:'intentionally-unavailable:no-runtime-may-start'}));
  const catalog=new StdioCatalog({command:process.env.CATALOG_EXECUTABLE!,args:['serve','--db',join(workspace,'catalog.sqlite'),'--home',home]});
  const timestamp=new Date().toISOString();await catalog.upsert({uri:'ahp-session:/imported',engineId:'amplifier',nativeSessionId:nativeId,workingDirectory:workspace,title:'Preserved chat',createdAt:timestamp,modifiedAt:timestamp,status:'idle'});
  const host=await createHost({stateDirectory:join(workspace,'host'),allowedWorkspaceRoots:[workspace],engines:[{id:'amplifier',label:'Amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',config]}],catalog});
  const transport=await WebSocketTransport.connect(host.url),client=new AhpClient(transport);client.connect();
  try {
    await client.initialize({clientId:'interop',protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});
    const list=await client.request('listSessions',{channel:'ahp-root://',limit:1});assert.equal(list.items[0].resource,'ahp-session:/imported');assert.equal(list.items[0].status,1);
    const snapshot=(await client.subscribe('ahp-chat:/imported',{view:{turns:1}})).result.snapshot!.state as any;
    assert.equal(snapshot.turns[0].id,'stable-native-turn');assert.equal(snapshot.turns[0].message.text,'historical request');assert.ok(snapshot.turns[0].responseParts.some((part:any)=>part.content==='historical answer'));
    assert.equal(host.diagnostics().activeAgents,0);assert.equal(await readFile(transcript,'utf8'),source);
  } finally {await client.shutdown();await host.close();await rm(temp,{recursive:true,force:true});}
});

test('real Core/Foundation scheduled work and exact source configuration clone use public host admission', {skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_NATIVE_TEST_CONFIG||!process.env.ACP_NATIVE_TEST_WORKSPACE},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-native-schedule-')),workspace=await realpath(process.env.ACP_NATIVE_TEST_WORKSPACE!);
 const host=await createHost({stateDirectory:directory,allowedWorkspaceRoots:[workspace],engines:[{id:'amplifier',label:'Amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',process.env.ACP_NATIVE_TEST_CONFIG!]}]});
 const transport=await WebSocketTransport.connect(host.url),client=new AhpClient(transport);client.connect();
 try{
  await client.initialize({clientId:'scheduled-interop',protocolVersions:['0.9.0']});
  const {randomUUID}=await import('node:crypto'),session='ahp-session:/'+randomUUID();
  await client.request('createSession',{channel:session,workingDirectories:[new URL('file://'+workspace).href]});
  await host.nativeControl(session,'budget.set',{contextTokens:4321});
  const made=await host.nativeControl(session,'task.create',{objective:'Finite offline qualification',maxTurns:3,commandId:'qualification-task',expectedRevision:0}),task=made.task;
  const before=await host.inspectSession(session),commandId=randomUUID();
  const accepted=await host.submitScheduled(session,{commandId,text:'Finite offline monitor',taskId:task.id,taskRevision:task.revision,kind:'monitor',expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash});
  assert.equal(accepted.accepted,true);
  const outcome=await host.waitForTurn(session,commandId,30000);assert.equal(outcome.completed,true,JSON.stringify(outcome));assert.match(outcome.text,/Native graph reply/);
  const selected=await host.readSessionContext(session);assert.equal(selected.messages[0].inputOrigin,'scheduled');
  const after=await host.inspectSession(session),created=await host.createSession({commandId:randomUUID(),idempotencyKey:randomUUID(),sourceSession:session,expectedConfigurationHash:after.configurationHash,title:'Configured clone'});
  assert.equal(created.creationConfirmed,true);assert.equal((await host.nativeControl(created.uri,'task.get',{})).task,null);
  const budget=await host.nativeControl(created.uri,'budget.get',{});assert.equal(budget.contextTokens??budget.budget?.contextTokens,4321);
  assert.equal((await host.readSessionContext(created.uri)).messages.length,0);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});
