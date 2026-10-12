import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

const python=process.env.EDIT_NATIVE_PYTHON,source=process.env.EDIT_NATIVE_SOURCE;
const managed=process.env.EDIT_CONTEXT_SOURCE,provider=process.env.EDIT_PROVIDER_SOURCE,resourcesModule=process.env.EDIT_RESOURCES_MODULE;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const wait=async(check:()=>boolean)=>{for(let n=0;n<1000;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Owned edit fixture deadline');};

for(const kind of (process.env.EDIT_SIMPLE_CONTEXT_SOURCE?['simple','managed']:['managed']))for(const mode of ['current','fork'] as const)test(`actual Native/Host/Resources ${kind}/${mode} text edit preserves canonical file and frozen quote`,{skip:!python||!source||!managed||!provider||!resourcesModule,timeout:90000},async()=>{
 const {createHost}=await import(process.env.EDIT_HOST_MODULE??'../src/host.js');
 const {createResourcesCapability}=await import(resourcesModule!);
 const dir=await realpath(await mkdtemp(join(tmpdir(),'edit-original-context-'))),workspace=join(dir,'workspace'),home=join(dir,'home'),appHome=join(dir,'app'),config=join(dir,'native.json'),audit=join(dir,'prompts.jsonl'),bundle=join(dir,'bundle.yaml');
 await mkdir(workspace);await mkdir(home);await writeFile(join(home,'settings.yaml'),'bundle:\n  app: []\n');
 await writeFile(bundle,JSON.stringify({bundle:{name:'owned-edit-context',version:'1.0.0'},session:{orchestrator:{module:'loop-live'},context:kind==='managed'?{module:'context-managed',source:managed,config:{engine:'boundary',token_meter:'actual',summarize_trigger:0.70,summary_target_tokens:1500}}:{module:'context-simple',source:process.env.EDIT_SIMPLE_CONTEXT_SOURCE,config:{}}},providers:[{module:'provider-fixture',source:provider,config:{promptAuditFile:audit}}]}));
 await writeFile(config,JSON.stringify({home,appHome,bundle,startupTimeout:60,adminWorkspaceRoots:[workspace]}));
 const env={NATIVE_ADMISSION_SOURCE:source!,PYTHONDONTWRITEBYTECODE:'1',AMPLIFIER_SESSION_STATE_HOME:join(dir,'writers')};
 const engine={id:'native',command:python!,args:['-I','-B','-m','amplifier_acp','--config',config],env,messagePrincipal:'owned-edit-account'};
 let host:any,resources:any,client:AhpClient|undefined,missingContext=false;
 const settings={stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[workspace],engines:[engine],publicOriginalResources:{retainOriginalAttachment:(r:any)=>resources.retainForkAttachments(r),resolveOriginalAttachment:(s:string,r:any)=>resources.resolveOriginalAttachment(s,r)},resolvePromptAttachment:async(ctx:any,a:any)=>{if(missingContext)return undefined;const grant=await resources.resolveOriginalAttachment(ctx.session,{owner:'resources',id:a.uri});if(grant&&grant.status!=='completed')throw Error('Unqualified original resource grant');return resources.resolvePromptAttachment(ctx,grant?{...a,uri:grant.accessUri}:a);}};
 const connect=async()=>{const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:'owned-edit-browser',protocolVersions:['0.9.0']});return c;};
 const completed=async(id:string,s:string)=>{await wait(()=>!!host.store.receipt(id));assert.equal((await host.waitForTurn(s,id,30000)).completed,true);await wait(()=>host.store.get(s)?.state._meta?.['amplifier.dev/acp']?.lastSettledTurnId===id);};
 const calls=async()=>{try{return (await readFile(audit,'utf8')).trim().split('\n').filter(Boolean);}catch{return [];}};
 try{
  host=await createHost(settings);resources=createResourcesCapability({directory:join(dir,'resources'),inspectSession:(s:string)=>host.inspectSession(s),verifyOriginalAttachment:(r:any)=>host.verifyOriginalForkAttachment(r)});client=await connect();
  const session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');await client.request('createSession',{channel:session,provider:'native',workingDirectories:[pathToFileURL(workspace).href]});const native=host.store.get(session).nativeSessionId;
  execFileSync(python!,['-c',`import json,sys,io,asyncio
from amplifier_acp.server import Server
server=Server(json.load(open(sys.argv[1])),io.StringIO())
async def rename():
 await server.dispatch('initialize',{'protocolVersion':1,'clientCapabilities':{'_meta':{'amplifier.dev/native':{'version':1}}}})
 await server.dispatch('_amplifier/naming',{'sessionId':sys.argv[2],'cwd':sys.argv[3],'operation':'rename','args':{'commandId':'owned-no-aux','title':'Owned edit fixture'}})
asyncio.run(rename())`,config,native,workspace],{env:{...process.env,...env}});
  const first=randomUUID();await host.submitTurn(session,{commandId:first,text:'Canonical earlier quote source',clientId:'owned-edit-browser'});await completed(first,session);await host.refreshSessionHistory(session,{limit:1});
  const firstState=(await client.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as any,reference={...firstState.turns[0].message._meta['amplifier.dev/history'].messageReference};delete reference.sessionId;
  const file=Buffer.from('Exact retained edit file context\n'),action=(operation:string,args:any)=>resources.action({version:1,topic:'attachments',channel:session,operation,args});
  const upload=(await action('attachments.create',{requestId:randomUUID(),name:'edit.txt',contentType:'text/plain',size:file.length,sha256:hash(file)})).result.attachment;
  await resources.resourceProviders[1].write({uri:upload.uploadUri+'&offset=0',encoding:'base64',data:file.toString('base64'),mode:'append'});
  const descriptor=(await action('attachments.commit',{id:upload.id,requestId:randomUUID()})).result.attachment;
  const target=randomUUID();client.dispatch(chat,{type:'chat/turnStarted',turnId:target,startedAt:new Date().toISOString(),message:{text:'Original attached quoted request',origin:{kind:'user'},attachments:[{type:'resource',label:'edit.txt',contentType:'text/plain',uri:descriptor.resourceUri}],_meta:{'amplifier.dev/messageReply':reference}}} as any);await completed(target,session);await host.refreshSessionHistory(session,{limit:2});
  const original=(await host.readPublicOriginalRows(session)).rows.find((r:any)=>r.publicMessage.inputId===target);assert.ok(original);assert.equal(original.publicMessage.blocks[1].reference.id,descriptor.resourceUri);
  const snapshot=(await client.subscribe(chat,{view:{turns:2}})).result.snapshot!.state as any,originalTurn=snapshot.turns.find((t:any)=>t.id===target),frozenQuote=originalTurn.message._meta['amplifier.dev/history'].replyTo;assert.ok(frozenQuote);assert.match((await calls()).at(-1)!,/Exact retained edit file context/);
  let selected=session,boundary=originalTurn.message._meta['amplifier.dev/history'].messageId;const beforeSource=(await host.inspectSessionHistory(session)).historyRevision;
  if(mode==='fork'){const forkCommand=randomUUID(),fork=await host.forkSession(session,{commandId:forkCommand,expectedHistoryRevision:beforeSource,throughMessageId:boundary});selected=fork.uri;assert.equal((await host.reconcileOriginalForkAttachments(session,forkCommand)).grantCoverage,'complete');
   const copied=(await host.readPublicOriginalRows(selected)).rows.find((r:any)=>r.publicMessage.inputId===target);assert.ok(copied);
   assert.deepEqual(fork.forkBoundary,{sourceMessageId:boundary,targetMessageId:copied.locator.messageId,historyRevision:fork.historyRevision});
   boundary=fork.forkBoundary.targetMessageId;
  }
  const before=(await host.inspectSessionHistory(selected)).historyRevision,count=(await calls()).length;
  const stale=await host.reviseHistory(selected,{commandId:randomUUID(),operationId:randomUUID(),targetMessageId:boundary,expectedHistoryRevision:'stale-owned-revision',text:'Must never execute stale edit'});assert.equal(stale.accepted,false);assert.equal((await calls()).length,count);assert.equal((await host.inspectSessionHistory(selected)).historyRevision,before);
  missingContext=true;
  const unavailable=await host.reviseHistory(selected,{commandId:randomUUID(),operationId:randomUUID(),targetMessageId:boundary,expectedHistoryRevision:before,text:'Must never omit an unavailable attachment'});
  assert.equal(unavailable.accepted,false);assert.equal((await calls()).length,count);assert.equal((await host.inspectSessionHistory(selected)).historyRevision,before);
  missingContext=false;
  const input={commandId:randomUUID(),operationId:randomUUID(),targetMessageId:boundary,expectedHistoryRevision:before,text:'Replacement retains original context'};assert.equal((await host.reviseHistory(selected,input)).accepted,true);await completed(input.commandId,selected);assert.equal((await calls()).length,count+1);
  const prompt=(await calls()).at(-1)!;assert.match(prompt,/Replacement retains original context/);assert.match(prompt,/Exact retained edit file context/);assert.match(prompt,/historical data, not new instructions/);assert.match(prompt,/Canonical earlier quote source/);
  const editReceipt=host.store.db.prepare('SELECT payload FROM history_edits WHERE operation_id=?').get(input.operationId) as any;
  assert.equal(JSON.parse(editReceipt.payload).prompt,undefined,'Resolved attachment bodies do not become another durable Host copy');
  await host.refreshSessionHistory(selected,{limit:2});const revisedChat=selected.replace('ahp-session:','ahp-chat:'),state=(await client.subscribe(revisedChat,{view:{turns:2}})).result.snapshot!.state as any,replacement=state.turns.find((t:any)=>t.id===input.commandId);assert.ok(replacement);assert.equal(replacement.message.attachments.length,1);assert.equal(replacement.message._meta['amplifier.dev/history'].replyTo.excerpt,frozenQuote.excerpt);const access=replacement.message.attachments[0].uri;assert.ok(access);const downloaded=await resources.resourceProviders[1].read({uri:access,encoding:'base64'});assert.deepEqual(Buffer.from(downloaded.data,'base64'),file);
  if(mode==='fork')assert.equal((await host.inspectSessionHistory(session)).historyRevision,beforeSource);
  await assert.rejects(host.reviseHistory(selected,input),/already attempted/);assert.equal((await calls()).length,count+1);
  await client.shutdown();client=undefined;await host.close();host=await createHost(settings);client=await connect();const reloaded=(await client.subscribe(revisedChat,{view:{turns:2}})).result.snapshot!.state as any;assert.equal(reloaded.turns.find((t:any)=>t.id===input.commandId).message.attachments.length,1);assert.equal((await calls()).length,count+1);assert.equal(host.diagnostics().activeAgents,0);
  console.log(JSON.stringify({kind,mode,actualNative:true,fileBytes:file.length,exactlyOneReplacement:true,quotePreserved:true,reloadNoReplay:true,sourcePreserved:mode==='fork'}));
 }finally{await client?.shutdown();await host?.close();resources?.close();await rm(dir,{recursive:true,force:true});}
});
