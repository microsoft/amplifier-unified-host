import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,realpath,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost} from '../src/host.js';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

const python=process.env.MISSING_HISTORY_PYTHON;
test('installed native: missing workspace remains readable across host restart without execution or canonical changes',{skip:!python,timeout:30000},async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'missing-history-installed-'))),cwd=join(directory,'gone'),config=join(directory,'native.json');
 const sid='22222222-2222-4222-8222-222222222222',uri='ahp-session:/'+sid,chat=uri.replace('ahp-session:','ahp-chat:');
 await writeFile(config,JSON.stringify({home:join(directory,'native'),appHome:join(directory,'app'),workerCommand:['/must-not-start']}));
 const history=execFileSync(python!,['-I','-B','-c',`import sys,json
from pathlib import Path
from amplifier_acp.native.session_files import project_slug
p=Path(sys.argv[1])/'native'/'projects'/project_slug(sys.argv[2])/'sessions'/sys.argv[3];p.mkdir(parents=True)
(p/'metadata.json').write_text(json.dumps({'session_id':sys.argv[3],'working_dir':sys.argv[2],'name':'Retained conversation'}))
(p/'transcript.jsonl').write_text(''.join(json.dumps(x)+'\\n' for x in [{'role':'user','content':'Saved question'},{'role':'assistant','content':'Saved answer'}]))
print(p)`,directory,cwd,sid],{encoding:'utf8'}).trim();
 const original=await readFile(join(history,'transcript.jsonl')),metadata=await readFile(join(history,'metadata.json'));
 const catalog:any={get:async(s:string)=>s===uri?{uri,engineId:'native',nativeSessionId:sid,workingDirectory:cwd,title:'Retained conversation',createdAt:'2026-01-01T00:00:00Z',modifiedAt:'2026-01-01T00:00:00Z',workspaceAvailability:'missing'}:undefined,list:async()=>({items:[]}),upsert:async()=>{}};
 const settings={stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[directory],defaultWorkingDirectory:directory,catalog,engines:[{id:'native',command:python!,args:['-I','-B','-m','amplifier_acp','--config',config],env:{AMPLIFIER_SESSION_STATE_HOME:join(directory,'writers')}}]};
 let host:any,client:AhpClient|undefined;
 try{
  for(let attempt=0;attempt<2;attempt++){
   host=await createHost(settings);client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'read-missing',protocolVersions:['0.9.0']});
   const session=(await client.subscribe(uri)).result.snapshot!.state as any;
   assert.equal(session._meta['amplifier.dev/native'].workspaceAvailable,false);
   const snapshot=(await client.subscribe(chat,{view:{turns:10}})).result.snapshot!.state as any;
   assert.equal(snapshot.turns.length,1);assert.equal(snapshot.turns[0].message.text,'Saved question');
   assert.match(JSON.stringify(snapshot.turns[0].responseParts),/Saved answer/);
   const inspection=await host.inspectSessionHistory(uri);assert.equal(inspection.readOnly,true);assert.equal(inspection.location.executionAvailable,false);
   await assert.rejects(host.submitTurn(uri,{commandId:'no-execution-'+attempt,text:'Never sent',clientId:'read-missing'}));
   assert.equal(host.diagnostics().activeAgents,0);assert.deepEqual(await readFile(join(history,'transcript.jsonl')),original);assert.deepEqual(await readFile(join(history,'metadata.json')),metadata);
   await client.shutdown();client=undefined;await host.close();host=undefined;
  }
  // A restored ordinary directory resumes normal validation, not a permanent
  // read-only cache flag. Still no worker is started simply by opening it.
  await mkdir(cwd);host=await createHost(settings);client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'restored',protocolVersions:['0.9.0']});
  const restored=(await client.subscribe(uri)).result.snapshot!.state as any;assert.equal(restored._meta['amplifier.dev/native'].workspaceAvailable,true);assert.equal(host.diagnostics().activeAgents,0);
 }finally{await client?.shutdown();await host?.close();await rm(directory,{recursive:true,force:true});}
});
