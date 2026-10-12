import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
const python=process.env.INITIAL_SELECTION_PYTHON;
const wait=async(check:()=>Promise<unknown>|unknown)=>{for(let n=0;n<1500;n++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Rich steering fixture deadline');};
test('actual installed Native receives a quoted file correction in the original turn and refresh preserves it',{skip:!python,timeout:60000},async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'rich-steering-')));
 const made=JSON.parse(execFileSync(python!,['-c',`import json,sys,yaml
from pathlib import Path
from native_setup import configuration
root=Path(sys.argv[1]);config,cwd=configuration(root,idleSeconds=60)
value=json.loads(config.read_text());bundle=Path(value['bundle'])
doc=yaml.safe_load(bundle.read_text());doc['providers'][0]['config']={'gateDirectory':str(root/'gates'),'promptAuditFile':str(root/'audit.jsonl')}
bundle.write_text(yaml.safe_dump(doc));print(json.dumps({'config':str(config),'cwd':str(cwd)}))`,dir],{encoding:'utf8'}));
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[made.cwd],resolvePromptAttachment:async()=>[{type:'resource',resource:{uri:'fixture:/notes',mimeType:'text/plain',blob:Buffer.from('The corrected attachment contents').toString('base64')}}],engines:[{id:'native',command:python!,args:['-I','-B','-m','amplifier_acp','--config',made.config],messagePrincipal:'owned-rich-steering'}]});
 const one=new AhpClient(await WebSocketTransport.connect(host.url)),two=new AhpClient(await WebSocketTransport.connect(host.url));
 one.connect();two.connect();
 try{
  await one.initialize({clientId:'one',protocolVersions:['0.9.0']});await two.initialize({clientId:'two',protocolVersions:['0.9.0']});
  const session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');
  await one.request('createSession',{channel:session,provider:'native',workingDirectories:[pathToFileURL(made.cwd).href]});
  await host.submitTurn(session,{commandId:'first',text:'Earlier source for a quoted correction',clientId:'one'});
  await host.waitForTurn(session,'first');await wait(()=>!host.store.get(session)?.chat.activeTurn);
  await host.refreshSessionHistory(session,{limit:2});
  const earlier=(await one.subscribe(chat)).result.snapshot!.state as any;
  const reference=earlier.turns[0].message._meta['amplifier.dev/history'].messageReference;assert.ok(reference);
  const {sessionId:_native,...reply}=reference;
  await host.submitTurn(session,{commandId:'active',text:'steering-apply',clientId:'one'});
  await wait(async()=>{try{await readFile(join(dir,'gates/tool.entered'));return true;}catch{return false;}});
  await wait(()=>host.store.get(session)?.state._meta?.['amplifier.dev/host']?.activeSteering?.content?.version===1);
  const attachment={type:'resource',label:'correction.txt',uri:'amplifier-attachment://12345678-1234-1234-1234-123456789abc/body?session='+encodeURIComponent(session),contentType:'text/plain'};
  const message={text:'Use **this** correction',origin:{kind:'user'},attachments:[attachment],_meta:{'amplifier.dev/steering':{activeTurnId:'active'},'amplifier.dev/messageReply':reply}};
  await host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'steering',id:'rich',message} as any,{clientId:'two'});
  const live=(await two.subscribe(chat)).result.snapshot!.state as any;
  const note=live.activeTurn.responseParts.find((p:any)=>p._meta?.['amplifier.dev/steering']?.inputId==='rich');
  assert.deepEqual(note._meta['amplifier.dev/steering'].message,message);
  const db=host.store.db,stateDirectory=join(dir,'crash-cut');await mkdir(stateDirectory);
  const dbfile=String(db.prepare('PRAGMA database_list').get()!.file);db.prepare('VACUUM INTO ?').run(join(stateDirectory,dbfile.slice(dbfile.lastIndexOf('/')+1)));
  const restored=await createHost({stateDirectory,allowedWorkspaceRoots:[made.cwd],engines:[{id:'native',command:'/must-not-launch'}]});
  try{const retained=restored.store.turns(chat,1).turns[0];assert.deepEqual(retained.responseParts.find((p:any)=>p._meta?.['amplifier.dev/steering']?.inputId==='rich')?._meta?.['amplifier.dev/steering']?.message,message);assert.equal(restored.diagnostics().activeAgents,0);}finally{await restored.close();}
  await writeFile(join(dir,'gates/tool.release'),'release');assert.equal((await host.waitForTurn(session,'active')).completed,true);
  await wait(()=>host.store.receipt('rich')?.status==='completed');
  const audit=(await readFile(join(dir,'audit.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  const content=JSON.stringify(audit.at(-1));assert.match(content,/The corrected attachment contents/);assert.match(content,/Quoted earlier message/);assert.match(content,/Earlier source for a quoted correction/);
  const refreshed=await host.refreshSessionHistory(session,{limit:2});assert.equal(refreshed.unresolvedSteeringInputs,0);assert.equal(refreshed.retainedTurns,0);
  const history=(await one.subscribe(chat)).result.snapshot!.state as any,turn=history.turns.find((t:any)=>t.id==='active');
  const canonical=turn.responseParts.find((p:any)=>p._meta?.['amplifier.dev/history']?.nativeInput?.id==='rich')._meta['amplifier.dev/history'];
  assert.equal(canonical.message.text,message.text);assert.equal(canonical.message.attachments[0].uri,attachment.uri);assert.equal(canonical.message.attachments[0].label,attachment.label);assert.equal(canonical.replyTo.messageId,reference.messageId);
  const before=await readFile(join(dir,'audit.jsonl'));await host.refreshSessionHistory(session,{limit:2});assert.deepEqual(await readFile(join(dir,'audit.jsonl')),before);
  assert.deepEqual(history.turns.map((t:any)=>t.id),['first','active']);
  console.log(JSON.stringify({richSteering:true,sameTurn:true,quotedNativeHistory:true,attachmentInProviderInput:true,liveAndColdOriginal:true,refreshNoReplay:true}));
 }finally{await writeFile(join(dir,'gates/tool.release'),'release').catch(()=>{});await one.shutdown();await two.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
