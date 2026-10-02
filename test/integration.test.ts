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
