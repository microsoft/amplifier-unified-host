import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
import {delegateObservation} from '../src/delegate-observation.js';
test('invalid or oversized delegate observations cannot become history or authority',async()=>{
 const save=async()=>{throw Error('No content should be saved');};
 for(const node of [{kind:'llm'},{kind:'worker',id:'a',sessionId:'a',revision:0},{kind:'worker',id:'a',sessionId:'a',revision:1,arbitrary:'x'.repeat(65536)}])assert.equal(await delegateObservation(node,save),undefined);
 const value=await delegateObservation({kind:'worker',id:'worker:a',sessionId:'a',revision:1,summary:'A small report',secret:'ignored',stopPermission:true},save);
 assert.deepEqual(value,{version:1,id:'worker:a',sessionId:'a',kind:'worker',revision:1,summary:'A small report'});
});
test('delegate report survives completion and host restart without appearing as a reply or replay',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'delegate-report-')),log=join(root,'calls');
 const config={stateDirectory:join(root,'state'),allowedWorkspaceRoots:[root],engines:[{id:'fixture',command:process.execPath,args:[resolve('fixtures/delegate-report-acp.mjs')],env:{FIXTURE_LOG:log}}]};
 let host=await createHost(config),client:AhpClient;
 const connect=async()=>{client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'reports',protocolVersions:['0.9.0']});};
 try{
  await connect();const session='ahp-session:/reports',chat='ahp-chat:/reports';
  await client!.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(root).href]});
  await host.submitTurn(session,{commandId:'review',text:'Review',clientId:'reports'});
  const outcome=await host.waitForTurn(session,'review');assert.equal(outcome.text,'Review finished.');
  const read=async()=>((await client!.subscribe(chat,{view:{turns:20}})).result.snapshot!.state as any).turns;
  const turns=await read(),reports=turns[0].responseParts.filter((p:any)=>p._meta?.['amplifier.dev/delegate']);
  assert.equal(reports.length,2);assert.ok(JSON.stringify(turns).length<5000);assert.ok(!JSON.stringify(turns).includes('FOREIGN-INPUT-REPORT'));
  const node=reports.at(-1)._meta['amplifier.dev/delegate'];assert.equal(node.ignoredAuthority,undefined);
  const full:any=await client!.request('resourceRead',{channel:'ahp-root://',uri:node.summaryDetail.uri,encoding:'utf-8'});
  assert.equal(full.contentType,'text/markdown');assert.ok(full.data.endsWith('END-OF-REPORT'));
  await client!.shutdown();await host.close();host=await createHost(config);await connect();
  assert.deepEqual(await read(),turns);assert.equal(await readFile(log,'utf8'),'prompt\n');assert.equal(host.diagnostics().activeAgents,0);
  const history=(text:string)=>[{id:'review',state:'complete',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'Review'}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}]}];
  await writeFile(log+'.history',JSON.stringify(history('Review finished.')));
  const refreshed=await host.refreshSessionHistory(session,{limit:1});assert.equal(refreshed.refreshedTurns,1);
  assert.deepEqual((await read())[0].responseParts.filter((p:any)=>p._meta?.['amplifier.dev/delegate']),reports);
  await writeFile(log+'.history',JSON.stringify(history('A different answer')));
  const retained=await host.refreshSessionHistory(session,{limit:1});assert.equal(retained.retainedTurns,1);
  assert.deepEqual((await read())[0].responseParts.filter((p:any)=>p._meta?.['amplifier.dev/delegate']),reports);
  assert.equal(await readFile(log,'utf8'),'prompt\n');assert.equal(host.diagnostics().activeAgents,0);
 }finally{await client!?.shutdown();await host.close();await rm(root,{recursive:true,force:true});}
});
