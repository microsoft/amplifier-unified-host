import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createHost} from '../src/host.js';
import {capturePublicMessage,qualifiedAccessUri,type PublicCard,type PersistedPublicRow} from '../src/public-original.js';

const capability={version:1,routes:['prompt','steer.submit','history.revise'],variants:['text','resources','native-attachments'],publicRows:true,exactRowRead:true};
const wait=async(check:()=>boolean)=>{for(let i=0;i<400;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('fixture did not settle');};
async function fixture(options:any={}){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'host-public-original-'))),log=join(dir,'prompts'),data=join(dir,'public.json'),history=join(dir,'history.json');
  await writeFile(data,'{}');await writeFile(history,'[]');
  const host=await createHost({stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:log,FIXTURE_HISTORY:history,FIXTURE_HISTORY_LIFECYCLE:'1',FIXTURE_PUBLIC_ROWS:data,...(options.mounted?{FIXTURE_MOUNTED_PUBLIC_ORIGINAL:JSON.stringify(options.mounted)}:{}),...(options.ready?{FIXTURE_READY_PUBLIC_ORIGINAL:JSON.stringify(options.ready)}:{}),...(options.negotiated===false?{}:{FIXTURE_PUBLIC_ORIGINAL:JSON.stringify(options.capability??capability)})}}],...options.config});
  // Fixture session creation uses the actual AHP entry point, not a fake record.
  const {AhpClient}=await import('@microsoft/agent-host-protocol/client'),{WebSocketTransport}=await import('@microsoft/agent-host-protocol/ws');
  const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'public-viewer',protocolVersions:['0.9.0']});
  const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
  return {dir,log,data,host,client,session,close:async()=>{await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}};
}

test('capture precedes resolver mutation and forged caller metadata cannot supply an original',async()=>{
  let calls=0;
  const f=await fixture({config:{resolvePromptAttachment:async(_context:any,attachment:any)=>{calls++;attachment.label='resolver execution label';return [{type:'text',text:'provider-expanded resource material'}];}}});
  try{
    const id=randomUUID(),uri=`amplifier-attachment://${randomUUID()}/body?session=${encodeURIComponent(f.session)}`;
    const message={text:'  literal user text\n',origin:{kind:'user'},attachments:[{type:'resource',label:'public.pdf',contentType:'application/pdf',uri}],_meta:{'amplifier.dev/publicMessage':{inputId:'forged',blocks:[{type:'text',text:'forged'}]}}};
    f.client.dispatch(f.session.replace('ahp-session:','ahp-chat:'),{type:'chat/turnStarted',turnId:id,startedAt:new Date().toISOString(),message} as any);
    await wait(()=>f.host.store.receipt(id)?.status==='completed');
    const prompt=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(calls,1);
    assert.deepEqual(prompt._meta['amplifier.dev/publicMessage'],{version:1,inputId:id,capture:'host-standard',blocks:[{type:'text',text:'  literal user text\n'},{type:'attachment',reference:{owner:'resources',id:uri},name:'public.pdf',mimeType:'application/pdf'}]});
    assert.deepEqual(prompt.prompt,[{type:'text',text:'  literal user text\n'},{type:'text',text:'provider-expanded resource material'}]);
    assert.equal(prompt._meta['amplifier.dev/command'].commandId,id);
    const stored=f.host.store.db.prepare('SELECT payload FROM turns WHERE turn_id=?').get(id)!;
    assert.equal(JSON.parse(String(stored.payload)).message.attachments[0].label,'public.pdf');
  }finally{await f.close();}
});

test('negotiated exact ID is validated before resolver/admission effects',async()=>{
  let calls=0;const f=await fixture({config:{resolvePromptAttachment:async()=>{calls++;return [];}}});
  try{const id='x'.repeat(129);await assert.rejects(f.host.submitTurn(f.session,{commandId:id,clientId:'caller',text:'literal',attachments:[{type:'resource',label:'a.pdf',contentType:'application/pdf',uri:`amplifier-attachment://${randomUUID()}/body?session=${encodeURIComponent(f.session)}`}]}));assert.equal(calls,0);assert.equal(f.host.store.receipt(id),undefined);await assert.rejects(readFile(f.log));}finally{await f.close();}
});

test('runtime-negotiated capture requires a positive mounted report and preserves ordinary Host intent otherwise',async()=>{
  const declared={...capability,runtimeNegotiated:true},negative={version:1,supported:false,originalAuthority:'host',reason:'shared-request-view-unavailable'};
  for(const mounted of [undefined,negative,{...declared,supported:true}]){
    const f=await fixture({capability:declared,mounted});try{
      const id=randomUUID();await f.host.submitTurn(f.session,{commandId:id,text:'Literal retained Host original',clientId:'caller'});await wait(()=>f.host.store.receipt(id)?.status==='completed');
      const prompt=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(!!prompt._meta['amplifier.dev/publicMessage'],mounted?.supported===true);assert.equal(prompt.prompt[0].text,'Literal retained Host original');assert.equal((await f.host.readUserMessage(f.session,id)).text,'Literal retained Host original');
    }finally{await f.close();}
  }
});

test('runtime.ready negative report overrides the mounted positive for subsequent captures',async()=>{
  const declared={...capability,runtimeNegotiated:true},negative={version:1,supported:false,originalAuthority:'host',reason:'shared-request-view-unavailable'};
  const f=await fixture({capability:declared,mounted:{...declared,supported:true},ready:negative});try{
    for(const text of ['first admitted original','after mounted downgrade']){const id=randomUUID();await f.host.submitTurn(f.session,{commandId:id,text,clientId:'caller'});await wait(()=>f.host.store.receipt(id)?.status==='completed');}
    const prompts=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(prompts[0]._meta['amplifier.dev/publicMessage']);assert.equal(prompts[1]._meta['amplifier.dev/publicMessage'],undefined);assert.equal(prompts[1].prompt[0].text,'after mounted downgrade');
  }finally{await f.close();}
});

test('cold resume uses the new mounted report instead of a prior worker positive',async()=>{
  const declared={...capability,runtimeNegotiated:true},negative={version:1,supported:false,originalAuthority:'host',reason:'shared-request-view-unavailable'};
  const f=await fixture({capability:declared,mounted:{...declared,supported:true}});let cold:any;
  try{
    const first=randomUUID();await f.host.submitTurn(f.session,{commandId:first,text:'previous context original',clientId:'caller'});await wait(()=>f.host.store.receipt(first)?.status==='completed');
    const config=f.host.config;await f.client.shutdown();await f.host.close();config.engines[0]!.env!.FIXTURE_MOUNTED_PUBLIC_ORIGINAL=JSON.stringify(negative);cold=await createHost(config);
    const next=randomUUID();await cold.submitTurn(f.session,{commandId:next,text:'new unsupported context original',clientId:'caller'});await wait(()=>cold.store.receipt(next)?.status==='completed');
    const prompts=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(prompts[0]._meta['amplifier.dev/publicMessage']);assert.equal(prompts[1]._meta['amplifier.dev/publicMessage'],undefined);assert.equal((await cold.readUserMessage(f.session,next)).text,'new unsupported context original');
  }finally{await cold?.close();await f.client.shutdown();await f.host.close();await rm(f.dir,{recursive:true,force:true});}
});

test('missing negotiation and unsupported typed selections retain the ordinary route',async()=>{
  for(const negotiated of [true,false]){
    const f=await fixture({negotiated,config:{resolvePromptAttachment:async()=>[{type:'text',text:'existing resolution'}]}});
    try{const id=randomUUID();await f.host.submitTurn(f.session,{commandId:id,clientId:'caller',text:'existing text',attachments:[{type:'resource',label:'public.pdf',contentType:'application/pdf',uri:`amplifier-attachment://${randomUUID()}/body?session=${encodeURIComponent(f.session)}`,selection:{startLine:1,endLine:2}} as any]});await wait(()=>f.host.store.receipt(id)?.status==='completed');const prompt=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(prompt._meta['amplifier.dev/publicMessage'],undefined);assert.equal(prompt.prompt[1].text,'existing resolution');}finally{await f.close();}
  }
});

test('steering original uses its own exact input ID and validates before pending-intent effects',async()=>{
  const f=await fixture();try{
    const invalid='bad\0id';await assert.rejects(f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'steering',id:invalid,message:{text:'literal',origin:{kind:'user'}}} as any,{clientId:'caller'}));assert.equal(f.host.store.db.prepare('SELECT id FROM steering_intents WHERE id=?').get(invalid),undefined);
    const steering=randomUUID(),initial=randomUUID();await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'steering',id:steering,message:{text:'  literal steering\n',origin:{kind:'user'},_meta:{'amplifier.dev/publicMessage':{inputId:'forged'}}}} as any,{clientId:'caller'});
    await f.host.submitTurn(f.session,{commandId:initial,text:'queue-hold',clientId:'caller'});await wait(()=>f.host.store.receipt(steering)?.status==='completed');
    const request=JSON.parse((await readFile(f.log+'.public-steering','utf8')).trim());assert.equal(request.args.inputId,steering);assert.equal(request.args.activeInputId,initial);assert.deepEqual(request._meta['amplifier.dev/publicMessage'],{version:1,inputId:steering,capture:'host-standard',blocks:[{type:'text',text:'  literal steering\n'}]});assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
  }finally{await f.close();}
});

test('ordered card occurrence counts text blocks and permits Resources255 names without URI rewrite',()=>{
  const uri=`amplifier-attachment://${randomUUID()}/body?session=ahp-session%3A%2Fsource`,name='n'.repeat(255);
  const original=capturePublicMessage({text:'',origin:{kind:'user'},attachments:[{type:'resource',label:name,contentType:'application/pdf',uri}]} as any,'input')!;
  assert.equal(original.blocks[0]!.type,'text');assert.equal((original.blocks[1] as PublicCard).reference.id,uri);assert.equal((original.blocks[1] as PublicCard).name,name);
  assert.equal(capturePublicMessage({text:'keep',origin:{kind:'user'},attachments:[{type:'resource',label:'a',contentType:'application/pdf',uri,range:{start:0,end:4}}]} as any,'input'),undefined);
  assert.equal(capturePublicMessage({text:'keep',origin:{kind:'user'},attachments:[{type:'resource',label:'a',contentType:'application/pdf',uri:uri+'&token=not-an-owner-handle'}]} as any,'input'),undefined);
});

test('target access rejects forged scope and never supplies access for unknown grants',()=>{
  const reference={owner:'resources' as const,id:'unchanged-original'},target='ahp-session:/target';
  const base={version:2 as const,commandId:'fork',targetHostSession:target,originalReference:reference,status:'unknown' as const,replayed:false as const};
  assert.equal(qualifiedAccessUri(base,target,reference),undefined);
  assert.throws(()=>qualifiedAccessUri({...base,accessUri:'amplifier-attachment://forged/body'},target,reference));
  assert.throws(()=>qualifiedAccessUri({...base,status:'completed',accessUri:`amplifier-attachment://${randomUUID()}/body?session=ahp-session%3A%2Fother`},target,reference));
  assert.throws(()=>qualifiedAccessUri({...base,status:'completed',accessUri:`amplifier-attachment://untrusted@${randomUUID()}/body?session=${encodeURIComponent(target)}`},target,reference));
});

test('card-only persisted rows read after append using locator identity and no worker mount',async()=>{
  const f=await fixture();try{
    const native=f.host.store.get(f.session)!.nativeSessionId!,locator={sessionId:native,messageId:'native:card',position:0,historyEpoch:null};
    const row={locator,publicMessage:{version:1,inputId:'card-only',capture:'host-standard',blocks:[{type:'attachment',reference:{owner:'resources',id:`amplifier-attachment://${randomUUID()}/body?session=${encodeURIComponent(f.session)}`},name:'card.pdf',mimeType:'application/pdf'}]}};
    await writeFile(f.data,JSON.stringify({[native]:{revision:'after-append',rows:[row]}}));
    const resident=f.host.diagnostics().activeAgents;const page=await f.host.readPublicOriginalRows(f.session,{rowLocator:locator});assert.equal(page.revision,'after-append');assert.deepEqual(page.rows,[row]);assert.equal(page.complete,true);assert.equal(f.host.diagnostics().activeAgents,resident);await assert.rejects(readFile(f.log));
    await assert.rejects(f.host.readPublicOriginalRows(f.session,{rowLocator:{...locator,historyEpoch:'changed'}}),/unavailable/);
  }finally{await f.close();}
});

test('Native history keeps opaque originals and unknown outcomes while access materializes separately',async()=>{
  let usable=false,grantWrites=0;const f=await fixture();try{
    const native=f.host.store.get(f.session)!.nativeSessionId!,locator={sessionId:native,messageId:'copy-row',position:0,historyEpoch:null},originalUri=`amplifier-attachment://${randomUUID()}/body?session=ahp-session%3A%2Foriginal`,accessUri=`amplifier-attachment://${randomUUID()}/body?session=${encodeURIComponent(f.session)}`;
    const card:PublicCard={type:'attachment',reference:{owner:'resources',id:originalUri},name:'public.pdf',mimeType:'application/pdf'};
    const row={locator,publicMessage:{version:1,inputId:'original-input',capture:'host-standard',blocks:[{type:'text',text:'Exact public original'},card]},copySource:{version:1,source:{...locator,sessionId:'immediate-native-source'},disposition:'retained'}};
    const groups=[{id:'copy-turn',state:'unknown',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'Embedded resource and Local file provider scaffolding'},_meta:{'amplifier.dev/history':{rowLocator:locator,originalBlockIndex:0}}},{sessionUpdate:'user_message_chunk',content:{type:'resource_link',uri:originalUri,name:'generated.pdf',mimeType:'application/pdf'},_meta:{'amplifier.dev/history':{rowLocator:locator,originalBlockIndex:1}}}]}];
    const data=JSON.stringify({[native]:{revision:'retained-copy',rows:[row],turnGroups:groups}});await writeFile(f.data,data);
    f.host.config.publicOriginalResources={retainOriginalAttachment:async()=>{grantWrites++;throw Error('no writes during reads');},resolveOriginalAttachment:async()=>({version:2,commandId:'fork',targetHostSession:f.session,originalReference:card.reference,status:usable?'completed':'unknown',...(usable?{accessUri}:{}),replayed:false})};
    const first=await (f.host as any).nativeHistory(f.host.store.get(f.session),50),turn=first.turns[0];assert.equal(turn.message.text,'Exact public original');assert.equal(turn.message.attachments[0].label,'public.pdf');assert.equal(turn.message.attachments[0].type,'simple');assert.equal(turn.message.attachments[0].uri,undefined);assert.equal(turn.message.attachments[0]._meta['amplifier.dev/publicAttachment'].access,'unknown');assert.equal(turn.state,'error');assert.equal(turn.responseParts.at(-1).error.errorType,'NATIVE_OUTCOME_UNKNOWN');
    usable=true;const second=await (f.host as any).nativeHistory(f.host.store.get(f.session),50);assert.equal(second.turns[0].message.attachments[0].uri,accessUri);assert.equal(second.turns[0].message.attachments[0]._meta['amplifier.dev/publicAttachment'].originalReference.id,originalUri);assert.equal(second.turns[0].responseParts.at(-1).error.errorType,'NATIVE_OUTCOME_UNKNOWN');assert.equal(grantWrites,0);assert.equal(await readFile(f.data,'utf8'),data);await assert.rejects(readFile(f.log));
  }finally{await f.close();}
});

test('paged grant continuation spans more than64 cards; unknown retry never reforks or rewrites originals',async()=>{
  let pending=true,calls=0;const f=await fixture();try{
    const commandId=randomUUID(),fork=await f.host.forkSession(f.session,{commandId,expectedHistoryRevision:'fixture-revision'}),sourceNative=f.host.store.get(f.session)!.nativeSessionId!,targetNative=f.host.store.get(fork.uri)!.nativeSessionId!;
    const sourceRows:PersistedPublicRow[]=[],targetRows:PersistedPublicRow[]=[];
    for(let index=0;index<70;index++){
      const locator={sessionId:sourceNative,messageId:'source:'+index,position:index*100,historyEpoch:null},card:PublicCard={type:'attachment',reference:{owner:'resources',id:`amplifier-attachment://${randomUUID()}/body?session=${encodeURIComponent('ahp-session:/earlier-chat')}`},name:'a.pdf',mimeType:'application/pdf'};
      const publicMessage={version:1 as const,inputId:'input:'+index,capture:'host-standard' as const,blocks:[{type:'text' as const,text:'literal'},card]};sourceRows.push({locator,publicMessage});targetRows.push({locator:{...locator,sessionId:targetNative,messageId:'target:'+index},publicMessage,copySource:{version:1,source:locator,disposition:'retained'}});
    }
    const before=JSON.stringify(targetRows);
    f.host.readPublicOriginalRows=async(session,input:any={})=>{const rows=session===f.session?sourceRows:targetRows;if(input.rowLocator){const selected=rows.find(row=>JSON.stringify(row.locator)===JSON.stringify(input.rowLocator));return {revision:'appended',rows:selected?[selected]:[],nextCursor:null,complete:true,diagnostics:[]};}const start=Number(input.cursor??0),end=Math.min(start+25,rows.length);return {revision:'appended',rows:rows.slice(start,end),nextCursor:end<rows.length?String(end):null,complete:end===rows.length,diagnostics:[]};};
    f.host.config.publicOriginalResources={resolveOriginalAttachment:async()=>null,retainOriginalAttachment:async request=>{calls++;const proof=await f.host.verifyOriginalForkAttachment(request);assert.equal(proof.sourceHostSession,f.session);assert.match(proof.card.reference.id,/earlier-chat/);const unknown=pending&&request.target.blockIndex===1&&request.target.row.messageId==='target:0';return {version:2,commandId,targetHostSession:fork.uri,originalReference:proof.card.reference,status:unknown?'unknown':'completed',...(unknown?{}:{accessUri:`amplifier-attachment://${randomUUID()}/body?session=${encodeURIComponent(fork.uri)}`}),replayed:false};}};
    const first=await f.host.reconcileOriginalForkAttachments(f.session,commandId);assert.equal(first.qualified,69);assert.equal(first.unresolved,1);assert.equal(calls,70);
    pending=false;const second=await f.host.reconcileOriginalForkAttachments(f.session,commandId);assert.equal(second.qualified,70);assert.equal(second.unresolved,0);assert.equal(calls,140);assert.equal(JSON.stringify(targetRows),before);
    const receipts=JSON.parse(await readFile(f.log+'.lifecycle','utf8'));assert.deepEqual(Object.keys(receipts),[commandId]);
    targetRows[0]!.publicMessage=structuredClone(targetRows[0]!.publicMessage);(targetRows[0]!.publicMessage.blocks[1] as PublicCard).name='forged.pdf';await assert.rejects(f.host.verifyOriginalForkAttachment({version:2,commandId,target:{row:targetRows[0]!.locator,blockIndex:1}}),/changed/);
  }finally{await f.close();}
});
