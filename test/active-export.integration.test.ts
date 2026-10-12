import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createHost} from '../src/host.js';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

test('installed Native export freezes saved bytes while the same conversation continues working',{
 skip:!process.env.ACP_EXECUTABLE||!process.env.ACP_NATIVE_TEST_CONFIG,timeout:60000,
},async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'active-export-'))),workspace=join(dir,'workspace'),home=join(dir,'native');
 await mkdir(workspace);await mkdir(home);await writeFile(join(home,'settings.yaml'),'bundle:\n  app: []\n');
 const template=JSON.parse(await readFile(process.env.ACP_NATIVE_TEST_CONFIG!,'utf8')),config=join(dir,'native.json');
 await writeFile(config,JSON.stringify({...template,home,appHome:join(dir,'app')}));
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[workspace],engines:[{id:'native',command:process.env.ACP_EXECUTABLE!,args:['--config',config],env:{AMPLIFIER_SESSION_STATE_HOME:join(dir,'writers')}}]});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  await client.initialize({clientId:'export-reviewer',protocolVersions:['0.9.0']});
  const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,workingDirectories:[pathToFileURL(workspace).href]});
  await host.submitTurn(session,{commandId:'saved',text:'Saved before export',clientId:'export-reviewer'});
  assert.equal((await host.waitForTurn(session,'saved')).completed,true);
  await host.submitTurn(session,{commandId:'active',text:'slow active export',clientId:'export-reviewer'});
  const before=await host.inspectSession(session);assert.equal(before.status,'working');
  const reviewed=await host.inspectSessionHistory(session);assert.equal(reviewed.lifecycleCapabilities.exportDetails.activeSnapshot.executionUnchanged,true);
  const args={commandId:'while-working',expectedHistoryRevision:reviewed.historyRevision,format:'markdown' as const,includeExecution:true};
  const result:any=await client.request('x-amplifier/sessionLifecycle' as any,{channel:session,operation:'export',args} as any);
  const page=await host.readExportResource(result.resource),body=Buffer.from(page.data,'base64');
  assert.match(body.toString(),/Saved before export/);assert.equal(createHash('sha256').update(body).digest('hex'),result.contentHash);
  const during=await host.inspectSession(session);assert.equal(during.status,'working');assert.equal(during.activeTurnId,'active');
  assert.equal(during.interruptionRevision,before.interruptionRevision);assert.equal(host.diagnostics().activeAgents,1);
  await assert.rejects(host.restoreSession(session,{commandId:'no-active-restore',expectedHistoryRevision:reviewed.historyRevision}),/active work/);
  await host.interruptSession(session,{commandId:'fixture-stop',turnId:'active',clientId:'export-reviewer'});await host.waitForTurn(session,'active');
  assert.deepEqual(await host.exportSession(session,args),result);
  assert.deepEqual(Buffer.from((await host.readExportResource(result.resource)).data,'base64'),body);
 }finally{await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
