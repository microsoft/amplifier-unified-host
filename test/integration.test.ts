import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const sources=await host.listRecallSources({session:'ahp-session:/imported',scope:'workspace',limit:25});assert.equal(sources.items[0].id,'ahp-session:/imported');
    const inspection=await host.inspectRecallSource('ahp-session:/imported'),page=await host.readRecallSource('ahp-session:/imported',{expectedRevision:inspection.revision,limit:1});assert.equal(page.rows.length,2);assert.equal(page.rows[0].text,'historical request');assert.equal(page.rows[0].inputOrigin,'unknown');assert.equal(page.rows[0].authorization,'unverified-native-history');assert.equal((await host.inspectRecallSource('ahp-session:/imported')).revision,inspection.revision);
    assert.equal(host.diagnostics().activeAgents,0);assert.equal(await readFile(transcript,'utf8'),source);
    await writeFile(transcript,source+JSON.stringify({role:'user',content:'new persisted turn'})+'\n');await assert.rejects(host.readRecallSource('ahp-session:/imported',{expectedRevision:inspection.revision}),/revision|changed/i);assert.notEqual((await host.inspectRecallSource('ahp-session:/imported')).revision,inspection.revision);
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


test('actual native worktree handoff keeps transcript home, execution cwd, IDs and cloned configuration separate', {skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_RELOCATION_TEST_CONFIG},async()=>{
 const {execFileSync}=await import('node:child_process'),{randomUUID}=await import('node:crypto'),{dirname}=await import('node:path'),{pathToFileURL}=await import('node:url'),{readdir}=await import('node:fs/promises');
 const nativeConfig=process.env.ACP_RELOCATION_TEST_CONFIG!,owned=dirname(nativeConfig),workspace=await realpath(join(owned,'workspace')),target=join(owned,'worktree-'+randomUUID()),state=await mkdtemp(join(tmpdir(),'ahp-relocation-state-'));
 execFileSync('git',['init',workspace]);execFileSync('git',['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','Owned qualification']);execFileSync('git',['-C',workspace,'worktree','add','-b','qualification-'+randomUUID(),target]);
 const config={stateDirectory:state,allowedWorkspaceRoots:[owned],engines:[{id:'amplifier',label:'Amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',nativeConfig]}]};
 let host=await createHost(config);const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  await client.initialize({clientId:'real-relocator',protocolVersions:['0.9.0']});const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,workingDirectories:[pathToFileURL(workspace).href]});
  await host.nativeControl(session,'budget.set',{contextTokens:7654});
  const first=randomUUID();await host.submitTurn(session,{commandId:first,text:'Before host worktree handoff',clientId:'real-relocator'});assert.equal((await host.waitForTurn(session,first,30000)).completed,true);
  const before=await host.inspectSession(session),projects=join(owned,'home/projects'),project=(await readdir(projects)).find(name=>name===workspace.replaceAll('/','-'))!;assert.ok(project);const transcript=join(projects,project,'sessions',before.nativeSessionId!,'transcript.jsonl'),original=await readFile(transcript,'utf8');
  const commandId=randomUUID(),moved=await host.relocateSession(session,{commandId,target,expectedExecutionRevision:before.executionRevision});assert.equal(moved.applied,true,JSON.stringify(moved));
  assert.equal((await host.nativeControl(session,'budget.get',{})).contextTokens,7654);
  const second=randomUUID();await host.submitTurn(session,{commandId:second,text:'After host worktree handoff',clientId:'real-relocator'});assert.equal((await host.waitForTurn(session,second,30000)).completed,true);
  const history=await readFile(transcript,'utf8');assert.ok(history.includes('Before host worktree handoff'));assert.ok(history.includes('After host worktree handoff'));assert.ok(history.length>original.length);
  assert.equal((await host.inspectSession(session)).historyHome,workspace);assert.equal((await host.inspectSession(session)).executionDirectory,target);
  const current=await host.inspectSession(session),clone=await host.createSession({commandId:randomUUID(),idempotencyKey:randomUUID(),sourceSession:session,expectedConfigurationHash:current.configurationHash});
  const cloned=await host.inspectSession(clone.uri);assert.equal(cloned.executionDirectory,target);assert.equal(cloned.historyHome,workspace);assert.equal(cloned.nativeLocationRevision,0);assert.equal((await host.readSessionContext(clone.uri)).messages.length,0);assert.equal((await host.nativeControl(clone.uri,'budget.get',{})).contextTokens,7654);
  await client.shutdown();await host.close();host=await createHost(config);
  const third=randomUUID();await host.submitTurn(session,{commandId:third,text:'Fresh host retains relocated execution',clientId:'real-relocator'});assert.equal((await host.waitForTurn(session,third,30000)).completed,true);
  assert.equal((await host.inspectSession(session)).nativeSessionId,before.nativeSessionId);assert.ok((await readFile(transcript,'utf8')).includes('Fresh host retains relocated execution'));
  const snapshot=await host.nativeControl(session,'configuration.snapshot',{});assert.equal(snapshot.sourceCwd,workspace);assert.equal(snapshot.executionDirectory,target);assert.equal(snapshot.locationRevision,1);
 }finally{await client.shutdown();await host.close();execFileSync('git',['-C',workspace,'worktree','remove','--force',target]);await rm(state,{recursive:true,force:true});}
});


test('real native graceful retirement releases a host slot only after confirmed worker exit', {skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_NATIVE_TEST_CONFIG||!process.env.ACP_NATIVE_TEST_WORKSPACE},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-native-retire-')),workspace=await realpath(process.env.ACP_NATIVE_TEST_WORKSPACE!),stopped:any[]=[],{randomUUID}=await import('node:crypto');
 const host=await createHost({stateDirectory:directory,allowedWorkspaceRoots:[workspace],maxActiveAgents:1,engines:[{id:'amplifier',label:'Amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',process.env.ACP_NATIVE_TEST_CONFIG!]}],agentStopped:async event=>{stopped.push(event);}}),client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  await client.initialize({clientId:'retire-interop',protocolVersions:['0.9.0']});const first='ahp-session:/'+randomUUID(),second='ahp-session:/'+randomUUID();
  await client.request('createSession',{channel:first,workingDirectories:[new URL('file://'+workspace).href]});await client.request('createSession',{channel:second,workingDirectories:[new URL('file://'+workspace).href]});
  assert.equal(host.diagnostics().activeAgents,1);assert.equal(stopped.length,1);assert.equal(stopped[0].session,first);await assert.rejects(host.nativeControlExisting(first,'budget.get',{}),/No existing owned native runtime/);
  assert.equal((await host.inspectSession(first)).status,'idle');assert.equal((await host.readSessionContext(first)).messages.length,0);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});

test('actual Core/Foundation question admission preserves canonical answer provenance without plain prompt fallback',{skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_NATIVE_TEST_CONFIG||!process.env.ACP_NATIVE_TEST_WORKSPACE},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-native-question-')),workspace=await realpath(process.env.ACP_NATIVE_TEST_WORKSPACE!),{randomUUID,createHash}=await import('node:crypto'),proofs:any[]=[];
 const host=await createHost({stateDirectory:directory,allowedWorkspaceRoots:[workspace],engines:[{id:'amplifier',label:'Amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',process.env.ACP_NATIVE_TEST_CONFIG!]}],nativeHostCapabilities:{version:1,features:{questions:true}},nativeHostRequest:async(context,request)=>{assert.equal(request.operation,'questions.delivery.admit');proofs.push({context,args:request.args});return {admitted:true,inputId:request.args.inputId,questionId:request.args.questionId,questionRevision:request.args.questionRevision,answerHash:createHash('sha256').update(request.args.text).digest('hex')};}}),client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  await client.initialize({clientId:'question-integration',protocolVersions:['0.9.0']});const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,provider:'amplifier',workingDirectories:[pathToFileURL(workspace).href]});
  const answer={commandId:randomUUID(),questionId:'native-question-proof',questionRevision:2,text:'Use the exact saved answer',answerProvenance:{actor:'user',sourceMessageId:'owner-record-1'}};
  const admitted=await host.submitQuestionAnswer(session,answer);assert.equal(admitted.accepted,true);const result=await host.waitForTurn(session,answer.commandId);assert.equal(result.status,'completed');assert.equal(proofs.length,1);assert.equal(proofs[0].context.session,session);assert.equal(proofs[0].args.inputId,answer.commandId);
  const indexed=await host.readUserMessage(session,answer.commandId);assert.equal(indexed.inputOrigin,'question');assert.equal(indexed._meta['amplifier.dev/input'].questionRevision,2);
  const source=await host.inspectRecallSource(session),page=await host.readRecallSource(session,{expectedRevision:source.revision,limit:1}),persisted=page.rows.find(row=>row.role==='user');assert.equal(persisted?.inputOrigin,'question');assert.equal(persisted?.questionId,answer.questionId);assert.equal(persisted?.authorization,'unverified-native-history');
  await assert.rejects(host.submitQuestionAnswer(session,answer),/already admitted/);assert.equal(proofs.length,1);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});

test('actual Core/Foundation typed observation uses finite native admission and settles its authoritative outcome',{skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_NATIVE_TEST_CONFIG||!process.env.ACP_NATIVE_TEST_WORKSPACE},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-native-observation-')),workspace=await realpath(process.env.ACP_NATIVE_TEST_WORKSPACE!),{randomUUID}=await import('node:crypto');let allow=false,calls=0;
 const host=await createHost({stateDirectory:directory,allowedWorkspaceRoots:[workspace],engines:[{id:'amplifier',label:'Amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',process.env.ACP_NATIVE_TEST_CONFIG!]}],nativeHostCapabilities:{version:1,features:{observation:true}},nativeHostRequest:async(_context,request)=>{assert.equal(request.operation,'observation.admit');calls++;return {admitted:allow,reason:allow?undefined:'Saved watch changed'};}}),client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  await client.initialize({clientId:'observation-integration',protocolVersions:['0.9.0']});const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,provider:'amplifier',workingDirectories:[pathToFileURL(workspace).href]});
  const created=await host.nativeControl(session,'task.create',{objective:'Finite typed observation qualification',maxTurns:3,commandId:randomUUID(),expectedRevision:0}),task=created.task;
  const submit=async()=>{const current=await host.inspectSession(session),input={commandId:randomUUID(),watchId:'fixture-watch',taskId:task.id,taskRevision:task.revision,outcome:{status:'changed',summary:'Observed artifact changed'},expectedExecutionRevision:current.executionRevision,expectedInterruptionRevision:current.interruptionRevision,expectedConfigurationHash:current.configurationHash};assert.equal((await host.submitObservation(session,input)).accepted,true);return {input,result:await host.waitForTurn(session,input.commandId)};};
  const denied=await submit();assert.equal(denied.result.status,'failed');allow=true;const accepted=await submit();assert.equal(accepted.result.status,'completed');assert.match(accepted.result.text,/Native graph reply/);assert.equal(calls,2);
  const context=await host.readSessionContext(session,2);assert.equal(context.messages[0].inputOrigin,'observation');assert.equal(context.messages[0].role,'system');await assert.rejects(host.readUserMessage(session,accepted.input.commandId),(e:any)=>e.reason==='not-user');await assert.rejects(host.submitObservation(session,accepted.input),/already admitted/);assert.equal(calls,2);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});

test('actual persisted native task inspection needs no runtime worker', {skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_NATIVE_TEST_CONFIG||!process.env.ACP_NATIVE_TEST_WORKSPACE},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ahp-passive-task-')),workspace=await realpath(process.env.ACP_NATIVE_TEST_WORKSPACE!),{randomUUID}=await import('node:crypto');
 const nativeConfig=join(dir,'agent.json'),original=JSON.parse(await readFile(process.env.ACP_NATIVE_TEST_CONFIG!,'utf8'));await writeFile(nativeConfig,JSON.stringify(original));
 const config={stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[workspace],engines:[{id:'amplifier',label:'Amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',nativeConfig]}]};
 let host=await createHost(config);const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  await client.initialize({clientId:'passive-task',protocolVersions:['0.9.0']});const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,workingDirectories:[pathToFileURL(workspace).href]});
  const created=await host.nativeControl(session,'task.create',{objective:'Persist without warming task readers',maxTurns:3,commandId:randomUUID(),expectedRevision:0});
  await client.shutdown();await host.close();await writeFile(nativeConfig,JSON.stringify({...original,workerCommand:['/must/not/start']}));host=await createHost(config);
  const result=await host.readTaskState(session);assert.equal(result.available,true);assert.equal((result.task as any).id,created.task.id);assert.equal(result.source,'persisted-native-controls');assert.equal(host.diagnostics().activeAgents,0);
  assert.equal((await host.readTaskState(session,{expectedRevision:String(result.revision)})).revision,result.revision);
  await assert.rejects(host.readTaskState(session,{expectedRevision:'stale'}),/revision|changed/i);assert.equal(host.diagnostics().activeAgents,0);
 }finally{await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
