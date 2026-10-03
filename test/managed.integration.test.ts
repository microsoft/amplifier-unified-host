import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,realpath,rm,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {createHost} from '../src/host.js';import {StdioCatalog} from '../src/catalog.js';import {AhpClient} from '@microsoft/agent-host-protocol/client';import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

test('actual native managed creation is cold, indexed once, global-only, private, restart-safe',{skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_NATIVE_TEST_CONFIG||!process.env.CATALOG_EXECUTABLE,timeout:90000},async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'native-managed-'))),workspace=join(dir,'workspace'),home=join(dir,'home'),root=join(dir,'managed');await mkdir(workspace);await mkdir(home);await writeFile(join(home,'settings.yaml'),'bundle:\n  app: []\n');
 const config=join(dir,'native.json'),template=JSON.parse(await readFile(process.env.ACP_NATIVE_TEST_CONFIG!,'utf8')),normal={...template,home,appHome:join(dir,'app'),managedSessionRoots:[root]};await writeFile(config,JSON.stringify({...normal,workerCommand:['/impossible-worker']}));
 const engines=[{id:'amplifier',command:process.env.ACP_EXECUTABLE!,args:['--config',config],env:{AMPLIFIER_SESSION_STATE_HOME:join(dir,'writers')}}];
 const catalogConfig={command:process.env.CATALOG_EXECUTABLE!,args:['serve','--db',join(dir,'catalog.sqlite'),'--home',home,'--workspace',workspace,'--scan-interval','0','--workspace-check-interval','0']};let catalog=new StdioCatalog(catalogConfig);
 const hostConfig={stateDirectory:join(dir,'host'),managedSessionRoot:root,allowedWorkspaceRoots:[workspace],engines};let host=await createHost({...hostConfig,catalog}),client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  const init=await client.initialize({clientId:'managed-client',protocolVersions:['0.9.0']});assert.equal((init._meta?.['amplifier.dev/managedCreation'] as any).passive,true);
  const session='ahp-session:/'+randomUUID(),commandId='create-from-private-draft',args={session,commandId,selection:{instance:'fixture',model:'specific-fixture-model'}};
  const result:any=await client.request('x-amplifier/managedSession',{channel:'ahp-root://',operation:'create',args});assert.equal(result.runtimeStarted,false);assert.equal(host.diagnostics().activeAgents,0);
  let info=await host.inspectSession(session);const cwd=info.executionDirectory;await assert.rejects(host.authorizeWorkspace(cwd),/selected-session/);
  assert.equal((await client.request('listSessions',{channel:'ahp-root://',limit:50}) as any).items[0].resource,session);
  const dirs:any=await catalog.listWorkspaces({connectionId:'picker',limit:50,allowedWorkspaceRoots:[workspace]});assert.ok(dirs.items.every((r:any)=>r.path!==cwd&&r.workingDirectory!==cwd));
  const native=join(home,'projects',cwd.replaceAll('/','-'),'sessions',info.nativeSessionId!);assert.equal((await readFile(join(native,'transcript.jsonl'))).length,0);
  await mkdir(join(cwd,'.amplifier'));await writeFile(join(cwd,'.amplifier/settings.yaml'),'bundle:\n  active: /must-not-load-project\n');await writeFile(config,JSON.stringify(normal));
  await host.submitTurn(session,{commandId:'first-explicit-input',text:'Managed real graph request',clientId:'managed-client'});const settled=await host.waitForTurn(session,'first-explicit-input');assert.equal(settled.completed,true,JSON.stringify(settled));
  const before=await readFile(join(native,'transcript.jsonl')),metadata=JSON.parse(await readFile(join(native,'metadata.json'),'utf8'));assert.deepEqual(metadata.location,result.location);assert.match(before.toString(),/Managed real graph request/);
  await client.shutdown();await host.close();catalog=new StdioCatalog(catalogConfig);host=await createHost({...hostConfig,catalog});
  assert.deepEqual((await host.managedSessionReceipt(commandId))?.result,result);assert.equal(host.diagnostics().activeAgents,0);assert.deepEqual(await readFile(join(native,'transcript.jsonl')),before);
  await catalog.request('scan',{});let status:any;for(let i=0;i<500;i++){status=await catalog.request('status',{});if(status.phase==='complete')break;await new Promise(r=>setTimeout(r,10));}assert.equal(status.phase,'complete');
  const rows=await catalog.list({connectionId:'after-scan',limit:50,allowedWorkspaceRoots:[workspace],allowedManagedRoots:[root]});assert.equal(rows.items.length,1);assert.equal(rows.items[0].uri,session);assert.deepEqual(rows.items[0].location,result.location);
  assert.equal((await catalog.list({connectionId:'ordinary',limit:50,allowedWorkspaceRoots:[workspace]})).items.length,0);
  await host.submitTurn(session,{commandId:'second-explicit-input',text:'Continue in same private directory',clientId:'managed-client'});assert.equal((await host.waitForTurn(session,'second-explicit-input')).completed,true);
  assert.equal((await readdir(join(root,'chats'))).length,1);assert.equal((await host.inspectSession(session)).nativeSessionId,info.nativeSessionId);
 }finally{await client.shutdown().catch(()=>{});await host.close().catch(()=>{});await catalog.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
