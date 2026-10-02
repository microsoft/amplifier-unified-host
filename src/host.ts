import { createServer, type IncomingMessage, type Server } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, relative, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatReducer, sessionReducer, terminalReducer, SessionLifecycle, type ActionEnvelope, type StateAction, type ChatState, type SessionSummary, type Snapshot, type Message, type SessionState, type Turn, type TerminalState } from '@microsoft/agent-host-protocol';
import type { ContentBlock, SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { Store, type SessionRecord } from './store.js';
import { AcpProcess, type EngineConfig, type AgentHandlers } from './acp.js';

type Json = Record<string,any>;
export interface CatalogRecord {uri:string;engineId:string;nativeSessionId?:string;workingDirectory:string;parentUri?:string;title:string;createdAt:string;modifiedAt:string;status:number|string;availability?:string;workspaceAvailability?:string;}
export interface Catalog {
  list(params:{connectionId:string;limit:number;cursor?:string;workingDirectory?:string;search?:string;parentUri?:string;allowedWorkspaceRoots?:string[]}):Promise<{items:CatalogRecord[];nextCursor?:string}>;
  get(uri:string):Promise<CatalogRecord|undefined>;
  upsert(record:CatalogRecord):Promise<unknown>;
  hint?(sessionDirectory:string):Promise<unknown>;
  directoryInUse?(path:string):Promise<{inUse:boolean;sessions?:Array<{session:string;reason:string}>;freshness?:{phase?:string;completedAt?:string;issues?:number};coverage?:string}>;
  close?():Promise<void>;
}
export type MessageUnavailableReason='not-indexed'|'not-user'|'oversized'|'invalid-provenance';
export class MessageUnavailableError extends Error {
  readonly code=-32012;readonly data:{available:false;reason:MessageUnavailableReason;session:string;messageId:string};
  constructor(readonly reason:MessageUnavailableReason,session:string,messageId:string){super(`User message unavailable: ${reason}; no native history scan or absence claim`);this.name='MessageUnavailableError';this.data={available:false,reason,session,messageId};}
}
export interface SessionWorkspace {
  session:string;engineId:string;nativeSessionId?:string;historyHome:string;executionDirectory:string;executionRevision:number;
}
export interface SessionWorkspaceExpectation {expectedExecutionRevision?:number;expectedDirectory?:string;}
export interface AgentStopped {session:string;nativeSessionId?:string;engineId:string;workingDirectory:string;reason:'runtime-closed'|'process-closed'|'idle-retired'|'host-shutdown'|'relocated'|'relocation-unknown'|'startup-failed';exitCode?:number;signal?:string;}
export interface HostConfig {
  stateDirectory:string; engines:EngineConfig[]; allowedWorkspaceRoots:string[];
  host?:string;port?:number;allowedOrigins?:string[];allowedHosts?:string[];bearerToken?:string;
  maxActiveAgents?:number;maxClients?:number;maxSubscriptions?:number;replayLimit?:number;
  maxPeerBufferedBytes?:number;maxInFlightRequests?:number;idleAgentMs?:number;
  maxActiveProjectionBytes?:number;
  resourceProviders?:Array<{scheme:string;read?:(params:Json,context:{clientId:string})=>Promise<Json>;resolve?:(params:Json,context:{clientId:string})=>Promise<Json>;list?:(params:Json,context:{clientId:string})=>Promise<Json>;write?:(params:Json,context:{clientId:string})=>Promise<Json>}>;
  catalog?:Catalog;
  /** Optional bounded handshake metadata, resolved by the authenticated distribution. */
  clientMetadata?:(context:{clientId:string;metadata:Json})=>Promise<Json|undefined>;
  capabilities?: {
    manifest:{version:1;topics:Record<string,{uri:string;version:number}>;actions:Record<string,{topic:string;operation:string;method:string}>};
    read:(request:{uri:string;topic:string;scope:string;clientId:string})=>Promise<{topic:string;scope:string;revision:number;data:unknown}>;
    action:(request:Json,context:{clientId:string;origin:'agent'|'ui';session?:SessionRecord})=>Promise<{accepted:boolean;updates?:Array<{topic:string;scope:string;revision:number;data:unknown}>;invalidate?:string[]}>;
  };
  /** Scoped host capabilities receive trusted native identity and execution workspace. */
  nativeHostRequest?:(context:{session:string;nativeSessionId:string;workingDirectory:string},params:Json)=>Promise<Json>;
  nativeHostCapabilities?:Json;
  /** Actual runtime/process loss, never inferred from a completed prompt. Idempotent owner callback. */
  agentStopped?:(event:Readonly<AgentStopped>)=>Promise<void>;
  nativeEvent?:(context:{session:string;nativeSessionId:string;workingDirectory:string},params:Json)=>Promise<void>;
}
interface Peer {socket:WebSocket;clientId?:string;connectionId:string;initialized:boolean;ready:boolean;buffer:Json[];bufferBytes:number;cuts:Map<string,number>;replayCut?:number;lastClientSeq:number;seenClientSeq:Set<number>;subscriptions:Set<string>;pending:number;queue:Promise<unknown>;channels:Map<string,Promise<unknown>>;cursors:Map<string,Json>;}
interface Active {observationPending?:number;observationBytes?:number;stopCallback?:Promise<void>;stopNotified?:boolean;retireReason?:AgentStopped['reason'];agent:AcpProcess;busy:boolean;lastUsed:number;projectionBytes?:number;cancel?:{action:StateAction;origin:ActionEnvelope['origin']};updates?:Promise<void>;updateCount?:number;updateBytes?:number;controlDepth?:number;pendingHints?:string[];turnId?:string;started?:number;textPart?:string;reasoningPart?:string;run?:Promise<void>;tools:Set<string>;toolStates?:Map<string,Json>;permissions:Map<string,{params:RequestPermissionRequest;resolve:(r:RequestPermissionResponse)=>void}>;}
class RpcFault extends Error {constructor(readonly code:number,message:string,readonly data?:unknown){super(message);}}
const ROOT='ahp-root://';
const now=()=>new Date().toISOString();
const chatURI=(session:string)=>`ahp-chat:/${session.slice('ahp-session:/'.length)}`;
const bounded=(value:unknown,def:number,max:number)=>{if(value===undefined)return def;if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>max)throw new RpcFault(-32602,`Expected integer between 1 and ${max}`);return Number(value);};

export class AmplifierHost {
  readonly store:Store;
  readonly http:Server;
  readonly ws:WebSocketServer;
  private peers=new Set<Peer>();
  private active=new Map<string,Active>();
  private starting=new Map<string,Promise<Active>>();
  private resourceLocks=new Map<string,Promise<unknown>>();
  private cursors=new Map<string,{chat:string;before:number}>();
  private watches=new Map<string,{root:string;recursive:false;owner:Peer}>();
  private nativeCursors=new Map<string,{chat:string;cursor:string;revision:string}>();
  private loadedFloors=new Map<string,number>();
  private passiveReads=0;
  private hotRecords=new Map<string,SessionRecord>();
  private clientTools=new Map<string,{session:string;chat:string;turnId:string;clientId:string;resolve:(result:Json)=>void;timer:ReturnType<typeof setTimeout>}>();
  private observers=new Set<{session:string;chat:string;queue:ActionEnvelope[];bytes:number;running:boolean;closed:boolean;listener:(event:ActionEnvelope)=>void|Promise<void>;onError?:(error:Error)=>void}>();
  private retireTimer:ReturnType<typeof setInterval>;
  private stoppedCallbacks=new Set<Promise<void>>();
  private stoppedCallbackFailures=0;
  private roots:string[]=[];
  url='';
  constructor(readonly config:HostConfig) {
    if(!config.engines.length||!config.allowedWorkspaceRoots.length)throw new Error('At least one engine and allowed workspace root are required');
    if(!isAbsolute(config.stateDirectory))throw new Error('Host stateDirectory must be absolute');
    if(new Set(config.engines.map(e=>e.id)).size!==config.engines.length)throw new Error('Duplicate engine identifier');
    if(!['127.0.0.1','localhost','::1'].includes(config.host??'127.0.0.1')&&!config.bearerToken)throw new Error('Non-loopback listeners require authenticated gateway/bearer token');
    this.store=new Store(config.stateDirectory,config.replayLimit);
    this.http=createServer((_request,response)=>{response.writeHead(404);response.end();});
    this.ws=new WebSocketServer({noServer:true,maxPayload:16*1024*1024,perMessageDeflate:false});
    this.http.on('upgrade',(request,socket,head)=>{
      try {this.authorize(request);if(this.peers.size>=(config.maxClients??128))throw new Error('Client capacity reached');}
      catch {socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
      this.ws.handleUpgrade(request,socket,head,websocket=>this.accept(websocket));
    });
    this.retireTimer=setInterval(()=>void this.retireIdle(),10000);this.retireTimer.unref();
    this.store.db.exec("UPDATE terminals SET payload=json_set(payload,'$.lifecycle.status','exited'),lifecycle='exited' WHERE lifecycle='running'");
    // End interrupted projections without replaying the accepted command or past tool work.
    for(const row of this.store.db.prepare("SELECT uri FROM sessions WHERE json_extract(chat,'$.activeTurn') IS NOT NULL").all()) {
      const record=this.getRecord(row.uri as string)!;
      this.emit(record.chat.resource,{type:'chat/error',turnId:record.chat.activeTurn!.id,duration:0,part:{kind:'error',error:{message:'Host interrupted; execution outcome is unknown. Native history must be reconciled before continuing.'}}} as StateAction);
    }
  }
  async listen():Promise<this> {
    this.roots=await Promise.all(this.config.allowedWorkspaceRoots.map(root=>realpath(root)));
    await new Promise<void>((resolve,reject)=>{this.http.once('error',reject);this.http.listen(this.config.port??0,this.config.host??'127.0.0.1',resolve);});
    const address=this.http.address();if(!address||typeof address==='string')throw new Error('Missing bound address');
    this.url=`ws://${address.address.includes(':')?'['+address.address+']':address.address}:${address.port}/ahp`;return this;
  }
  private authorize(request:IncomingMessage) {
    const origin=request.headers.origin;
    const address=this.http.address(),port=address&&typeof address!=='string'?address.port:this.config.port;
    const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`,...(this.config.allowedHosts??[])]);
    for(const trusted of this.config.allowedOrigins??[])hosts.add(new URL(trusted).host);
    if(!request.headers.host||!hosts.has(request.headers.host))throw new Error('Host authority not allowed');
    const allowed=this.config.allowedOrigins??[...hosts].flatMap(host=>[`http://${host}`,`https://${host}`]);
    if(origin&&!allowed.includes(origin))throw new Error('Origin not allowed');
    if(this.config.bearerToken) {
      const actual=Buffer.from(request.headers.authorization??''), expected=Buffer.from(`Bearer ${this.config.bearerToken}`);
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error('Authentication required');
    }
  }
  private accept(socket:WebSocket) {
    const peer:Peer={socket,connectionId:randomUUID(),initialized:false,ready:false,buffer:[],bufferBytes:0,cuts:new Map(),lastClientSeq:-1,seenClientSeq:new Set(),subscriptions:new Set(),pending:0,queue:Promise.resolve(),channels:new Map(),cursors:new Map()};this.peers.add(peer);
    socket.on('error',()=>{});
    socket.on('close',()=>{this.peers.delete(peer);const subscriptions=[...peer.subscriptions];peer.subscriptions.clear();peer.cursors.clear();for(const uri of subscriptions){this.removeActiveClient(uri,peer.clientId);if(!this.hasSubscribers(uri))this.loadedFloors.delete(uri);}for(const [uri,watch] of this.watches)if(watch.owner===peer&&!this.hasSubscribers(uri))this.watches.delete(uri);});
    socket.on('message',data=>{
      let message:Json;try {message=JSON.parse(data.toString());if(message.jsonrpc!=='2.0'||typeof message.method!=='string')throw new Error();}catch {this.send(peer,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC request'}});return;}
      if(++peer.pending>(this.config.maxInFlightRequests??32)){socket.close(1013,'Inbound capacity exceeded');return;}
      const handle=async()=>{
        try {const result=await this.route(peer,message.method,message.params??{});if(message.id!==undefined)this.send(peer,{jsonrpc:'2.0',id:message.id,result:result??null});if(message.method==='initialize'||message.method==='reconnect'){peer.ready=true;for(const buffered of peer.buffer){const cut=peer.replayCut??peer.cuts.get(buffered.params?.channel)??-1;if(buffered.method!=='action'||buffered.params.serverSeq>cut)this.send(peer,buffered);}peer.buffer=[];peer.bufferBytes=0;peer.cuts.clear();}}
        catch(error) {const fault=error as RpcFault;if(message.id!==undefined)this.send(peer,{jsonrpc:'2.0',id:message.id,error:{code:Number.isSafeInteger(fault.code)?fault.code:-32603,message:fault.message,data:fault.data}});}
        finally {peer.pending--;}
      };
      // Handshake order is connection-wide. Later work is ordered only within its resource.
      if(!peer.initialized||message.method==='initialize'||message.method==='reconnect')peer.queue=peer.queue.catch(()=>{}).then(handle);
      else {
        const key=String(message.params?.channel??ROOT),previous=peer.channels.get(key)??peer.queue;
        const next=previous.catch(()=>{}).then(handle);peer.channels.set(key,next);
        void next.finally(()=>{if(peer.channels.get(key)===next)peer.channels.delete(key);}).catch(()=>{});
      }
    });
  }
  private send(peer:Peer,message:unknown) {
    if(peer.socket.readyState!==WebSocket.OPEN)return;
    if(!peer.ready&&(message as Json).method){const bytes=Buffer.byteLength(JSON.stringify(message));if(peer.buffer.length>=512||peer.bufferBytes+bytes>8*1024*1024){peer.socket.close(1013,'Handshake event capacity exceeded');return;}peer.buffer.push(message as Json);peer.bufferBytes+=bytes;return;}
    if(peer.socket.bufferedAmount>(this.config.maxPeerBufferedBytes??4*1024*1024)){peer.socket.close(1013,'Slow consumer: reconnect for authoritative state');return;}
    peer.socket.send(JSON.stringify(message));
  }
  private notify(method:string,params:Json,channel=ROOT) {for(const peer of this.peers)if(peer.subscriptions.has(channel))this.send(peer,{jsonrpc:'2.0',method,params});}
  private root() {return {agents:this.config.engines.map(engine=>({provider:engine.id,displayName:engine.label,description:'ACP agent',models:[],capabilities:{}})),activeSessions:this.store.count,terminals:this.terminalList(),_meta:{'amplifier.dev/host':{version:1,privateDrafts:'client',features:{receipts:true,sharedDrafts:false,queue:false,steer:false,voice:false,canvas:false,nativeControl:false}}}};}
  private terminalList(){return this.store.db.prepare("SELECT uri,payload FROM terminals WHERE lifecycle='running' ORDER BY modified DESC LIMIT 128").all().map(row=>{const state=JSON.parse(row.payload as string);return {resource:row.uri,title:state.title,claim:state.claim,lifecycle:state.lifecycle};});}
  private terminalState(uri:string):TerminalState|undefined {const row=this.store.db.prepare('SELECT payload FROM terminals WHERE uri=?').get(uri);return row?JSON.parse(row.payload as string):undefined;}
  private terminalEvent(session:string,event:Parameters<NonNullable<AgentHandlers['terminal']>>[0]) {
    const uri=`ahp-terminal:/${event.terminalId}`;
    if(event.kind==='created') {
      const state={title:event.title??'Agent terminal',cwd:pathToFileURL(event.cwd!).href,content:[],claim:{kind:'session',session,chat:chatURI(session)},lifecycle:{status:'running'},isPty:false,supportsCommandDetection:false};
      this.store.db.prepare('INSERT INTO terminals(uri,session,modified,payload,lifecycle) VALUES(?,?,?,?,?)').run(uri,session,now(),JSON.stringify(state),'running');
      this.emit(ROOT,{type:'root/terminalsChanged',terminals:this.terminalList()} as StateAction);return;
    }
    if(event.kind==='data') {
      mkdirSync(join(this.config.stateDirectory,'terminal-logs'),{recursive:true,mode:0o700});appendFileSync(join(this.config.stateDirectory,'terminal-logs',event.terminalId),event.data??'',{mode:0o600});
      const state=this.terminalState(uri)!;
      if(Buffer.byteLength(JSON.stringify(state.content))+Buffer.byteLength(event.data??'')>256*1024)this.emit(uri,{type:'terminal/cleared'} as StateAction);
      this.emit(uri,{type:'terminal/data',data:event.data??''} as StateAction);
    } else {this.emit(uri,{type:'terminal/exited',exitCode:event.exitCode} as StateAction);this.emit(ROOT,{type:'root/terminalsChanged',terminals:this.terminalList()} as StateAction);}
  }
  private withLock<T>(uri:string,work:()=>Promise<T>):Promise<T> {
    const prior=this.resourceLocks.get(uri)??Promise.resolve();
    const next=prior.catch(()=>{}).then(work);this.resourceLocks.set(uri,next);
    void next.finally(()=>{if(this.resourceLocks.get(uri)===next)this.resourceLocks.delete(uri);}).catch(()=>{});return next;
  }
  private async workspace(uri:string|undefined):Promise<string> {
    if(!uri)throw new RpcFault(-32602,'An explicit workingDirectories file URI is required');
    let path:string;try {path=await realpath(fileURLToPath(uri));}catch {throw new RpcFault(-32602,'Working directory must be an existing local directory');}
    if(!(await stat(path)).isDirectory()||!this.roots.some(root=>{const rel=relative(root,path);return !rel||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);}))throw new RpcFault(-32009,'Working directory is outside allowed workspace roots');
    return path;
  }
  private async resourcePath(uri:string):Promise<string> {
    let path:string;try {path=await realpath(fileURLToPath(uri));}catch{throw new RpcFault(-32008,'Resource not found');}
    if(!this.roots.some(root=>{const rel=relative(root,path);return !rel||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);}))throw new RpcFault(-32009,'Resource outside allowed workspace roots');
    return path;
  }
  private hasSubscribers(uri:string){return [...this.peers].some(peer=>peer.subscriptions.has(uri));}
  private capability(uri:string) {
    const config=this.config.capabilities;if(!config)return;
    let parsed:URL;try{parsed=new URL(uri);}catch{return;}
    const base=uri.split('?')[0],entry=Object.entries(config.manifest.topics).find(([,topic])=>topic.uri===base);
    if(!entry)return;return {topic:entry[0],scope:parsed.searchParams.get('scope')??'host'};
  }
  private resourceProvider(uri:string){let scheme;try{scheme=new URL(uri).protocol.slice(0,-1);}catch{return;}return this.config.resourceProviders?.find(provider=>provider.scheme===scheme);}
  /** Called by independent capability owners after their authoritative commit. */
  invalidateCapability(topic:string,scope:string) {
    for(const [channel,watch] of this.watches){const target=this.capability(watch.root);if(target?.topic===topic&&target.scope===scope)this.emit(channel,{type:'resourceWatch/changed',changes:{items:[{uri:watch.root,type:'updated'}]}} as StateAction);}
  }
  private async record(uri:string):Promise<SessionRecord> {
    let record=this.getRecord(uri);if(record){await this.workspace(pathToFileURL(record.workingDirectory).href);return this.getRecord(uri)!;}
    const session=uri.startsWith('ahp-chat:/')?`ahp-session:/${uri.slice('ahp-chat:/'.length)}`:uri;
    const discovered=await this.config.catalog?.get(session);
    if(!discovered)throw new RpcFault(-32008,'Unknown resource');
    await this.workspace(pathToFileURL(discovered.workingDirectory).href);
    // Metadata discovery never starts an agent. Native histories are read by the catalog/resource owner.
    const timestamp=discovered.modifiedAt;
    const summary=this.catalogSummary(discovered);
    const chat:ChatState={resource:chatURI(session),title:summary.title,status:summary.status,modifiedAt:timestamp,turns:[],_meta:{'amplifier.dev/history':{source:'native',available:false,reason:'Native history projection has not been imported'}}};
    record={uri:session,engineId:discovered.engineId,nativeSessionId:discovered.nativeSessionId,workingDirectory:discovered.workingDirectory,summary,
      state:{provider:summary.provider,title:summary.title,status:summary.status,lifecycle:SessionLifecycle.Ready,activeClients:[],chats:[this.chatSummary(chat)],defaultChat:chat.resource,workingDirectories:summary.workingDirectories,_meta:{'amplifier.dev/native':{availability:discovered.availability??'available'}}},chat};
    this.store.save(record);this.emit(ROOT,{type:'root/activeSessionsChanged',activeSessions:this.store.count} as StateAction);return record;
  }
  private getRecord(uri:string):SessionRecord|undefined {return this.hotRecords.get(uri.startsWith('ahp-chat:/')?'ahp-session:/'+uri.slice('ahp-chat:/'.length):uri)??this.store.get(uri);}
  private catalogSummary(record:CatalogRecord):SessionSummary {
    const live=this.getRecord(record.uri);
    return {resource:record.uri,provider:record.engineId,title:live?.summary.title??record.title,status:live?.summary.status??1,createdAt:record.createdAt,modifiedAt:live?.summary.modifiedAt??record.modifiedAt,workingDirectories:[pathToFileURL(record.workingDirectory).href],_meta:{'amplifier.dev/native':{availability:record.availability??'available'}}};
  }
  private chatSummary(chat:ChatState) {return {resource:chat.resource,title:chat.title,status:chat.status,modifiedAt:chat.modifiedAt};}
  private turnCursor(chat:string,before?:number):string|undefined {
    if(before===undefined)return;const token=randomUUID();this.cursors.set(token,{chat,before});if(this.cursors.size>4096)this.cursors.delete(this.cursors.keys().next().value!);return token;
  }
  private async nativeHistory(record:SessionRecord,limit?:number,cursor?:string):Promise<{turns:Turn[];nextCursor?:string;revision:string;diagnostics:unknown[]}> {
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive history read capacity reached');
    const engine=this.config.engines.find(engine=>engine.id===record.engineId);
    if(!engine||!record.nativeSessionId)throw new RpcFault(-32000,'Native history reader is unavailable; no empty transcript was substituted');
    this.passiveReads++;
    const agent=new AcpProcess(engine,record.workingDirectory,{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}})});
    try {
      const init=await agent.initialize();
      const capability=(init.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.history;
      if(capability?.version!==1||capability?.paging!=='complete-turns'||capability?.passive!==true)throw new RpcFault(-32601,'Agent does not advertise a passive native history reader');
      let next=cursor,revision='',diagnostics:unknown[]=[],turns:Turn[]=[];
      do {
        const result=await agent.client.extMethod('_amplifier/history',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,limit:Math.min(limit??200,200),...(next?{cursor:next}:{})}) as Json;
        if(!Array.isArray(result.turnGroups)||typeof result.revision!=='string')throw new Error('Malformed native history page');
        revision=result.revision;diagnostics.push(...(result.diagnostics??[]));const page:Turn[]=[];
        for(const group of result.turnGroups) {
          const inputs=(group.updates as Json[]).filter(update=>update.sessionUpdate==='user_message_chunk').map(update=>update.content);
          const recorded=(group.updates as Json[]).map(update=>update._meta?.['amplifier.dev/history']).find(value=>value?.recordedOnly);
          const message:Message={text:inputs.filter(content=>content.type==='text').map(content=>content.text).join(''),origin:{kind:recorded&&!inputs.length?'agent' as any:'user' as any},_meta:{'amplifier.dev/history':{outcome:group.recordedOnly?'recorded':group.state??'unknown',...(recorded?{via:recorded.via,callId:recorded.callId,itemId:recorded.itemId,recordedOnly:true}: {})}}};
          const attachments:any[]=[];
          for(const content of inputs){if(content.type==='image'||content.type==='audio')attachments.push({type:'embeddedResource',label:content.type,contentType:content.mimeType,data:content.data});else if(content.type==='resource_link')attachments.push({type:'resource',label:content.name??'Resource',uri:content.uri,contentType:content.mimeType});}
          if(attachments.length)message.attachments=attachments;
          let state=chatReducer({...record.chat,turns:[],activeTurn:undefined},{type:'chat/turnStarted',turnId:group.id,startedAt:group.startedAt??record.summary.createdAt,message} as any);
          const active:Active={agent,busy:true,lastUsed:0,turnId:group.id,tools:new Set(),permissions:new Map()};
          for(const update of group.updates)await this.update(record.uri,{sessionId:record.nativeSessionId,update} as SessionNotification,{active,emit:action=>{state=chatReducer(state,action as any);}});
          const action=group.recordedOnly||group.state==='complete'?{type:'chat/turnComplete',turnId:group.id,duration:0}:{type:'chat/error',turnId:group.id,duration:0,part:{kind:'error',error:{code:'NATIVE_OUTCOME_UNKNOWN',message:'Historical content is preserved; its execution outcome was not recorded.'}}};
          state=chatReducer(state,action as any);page.push(...state.turns);
        }
        turns=[...page,...turns];next=result.nextCursor??undefined;
      } while(limit===undefined&&next);
      let nextCursor:string|undefined;
      if(next){nextCursor=randomUUID();this.nativeCursors.set(nextCursor,{chat:record.chat.resource,cursor:next,revision});if(this.nativeCursors.size>4096)this.nativeCursors.delete(this.nativeCursors.keys().next().value!);}
      return {turns,nextCursor,revision,diagnostics};
    } finally {this.passiveReads--;await agent.retire();}
  }
  private async snapshot(uri:string,turns?:number):Promise<Snapshot> {
    let state:any;
    if(uri===ROOT)state=this.root();else if(this.watches.has(uri)){const {root,recursive}=this.watches.get(uri)!;state={root,recursive};}else if(uri.startsWith('ahp-terminal:/')){state=this.terminalState(uri);if(!state)throw new RpcFault(-32008,'Unknown terminal');}else {
      const record=await this.record(uri);
      if(uri===record.uri)state=record.state;
      else {
        const page=this.store.turns(uri,turns);
        if((record.chat._meta?.['amplifier.dev/history'] as Json)?.source==='native') {
          const native=await this.nativeHistory(record,turns);
          const fresh=this.getRecord(record.uri)!,live=this.store.turns(uri,turns),liveIDs=new Set(live.turns.map(turn=>turn.id));
          state={...fresh.chat,turns:[...native.turns.filter(turn=>!liveIDs.has(turn.id)),...live.turns],turnsNextCursor:native.nextCursor,_meta:{...fresh.chat._meta,'amplifier.dev/history':{source:'native',available:true,revision:native.revision,diagnostics:native.diagnostics}}};
        } else {
          const oldFloor=this.loadedFloors.get(uri),requestedFloor=page.first??Number.MAX_SAFE_INTEGER;
          const floor=Math.min(oldFloor??requestedFloor,requestedFloor);
          if(oldFloor!==undefined&&floor<oldFloor)this.emit(uri,{type:'chat/turnsLoaded',turns:this.store.turnsFrom(uri,floor,oldFloor),turnsNextCursor:this.turnCursor(uri,page.before)} as StateAction);
          this.loadedFloors.set(uri,floor);
          state={...record.chat,turns:this.store.turnsFrom(uri,floor),turnsNextCursor:this.turnCursor(uri,this.store.turns(uri,1,floor).turns.length?floor:undefined)};
        }
      }
    }
    return {resource:uri,state,fromSeq:this.store.seq};
  }
  private async subscribe(peer:Peer,uri:string,turns?:number) {
    if(peer.subscriptions.size>=(this.config.maxSubscriptions??64)&&!peer.subscriptions.has(uri))throw new RpcFault(-32000,'Subscription capacity reached');
    const snapshot=await this.snapshot(uri,turns);peer.subscriptions.add(uri);return snapshot;
  }
  private async route(peer:Peer,method:string,p:Json):Promise<unknown> {
    if(method==='ping')return null;
    if(method==='initialize') {
      if(peer.initialized)throw new RpcFault(-32600,'Already initialized');
      if(!p.protocolVersions?.includes('0.9.0'))throw new RpcFault(-32005,'Unsupported protocol version',{supportedVersions:['0.9.0']});
      if(typeof p.clientId!=='string'||!p.clientId||p.clientId.length>256)throw new RpcFault(-32602,'clientId required');
      if([...this.peers].some(other=>other!==peer&&other.clientId===p.clientId))throw new RpcFault(-32602,'Client identity already connected');
      peer.clientId=p.clientId;peer.initialized=true;
      const snapshots=[];for(const uri of p.initialSubscriptions??[])snapshots.push(await this.subscribe(peer,uri));
      for(const snapshot of snapshots)peer.cuts.set(snapshot.resource,snapshot.fromSeq);
      const metadata=await this.config.clientMetadata?.({clientId:p.clientId,metadata:p._meta??{}});
      if(metadata&&Buffer.byteLength(JSON.stringify(metadata))>65536)throw new RpcFault(-32000,'Handshake metadata exceeds capacity');
      return {protocolVersion:'0.9.0',serverSeq:this.store.seq,defaultDirectory:pathToFileURL(this.roots[0]).href,serverInfo:{name:'amplifier-unified-host',version:'0.1.0'},snapshots,_meta:{...metadata,'amplifier.dev/host':{version:1,incarnation:this.store.incarnation,receipts:{method:'x-commandReceipt'},features:this.root()._meta['amplifier.dev/host'].features},...(this.config.capabilities?{'amplifier.dev/capabilities':this.config.capabilities.manifest}:{})}};
    }
    if(method==='reconnect') {
      if(peer.initialized)throw new RpcFault(-32600,'Reconnect must open a fresh connection');
      if(typeof p.clientId!=='string'||!Number.isSafeInteger(p.lastSeenServerSeq)||!Array.isArray(p.subscriptions))throw new RpcFault(-32602,'Invalid reconnect');
      if([...this.peers].some(other=>other!==peer&&other.clientId===p.clientId))throw new RpcFault(-32602,'Client identity already connected');
      peer.clientId=p.clientId;peer.initialized=true;
      const missing:string[]=[];
      if(p.subscriptions.length>(this.config.maxSubscriptions??64))throw new RpcFault(-32000,'Subscription capacity reached');
      for(const uri of p.subscriptions)try {if(uri!==ROOT&&!this.watches.has(uri)&&!this.terminalState(uri))await this.record(uri);peer.subscriptions.add(uri);}catch{missing.push(uri);}
      const replay=this.store.replay(p.lastSeenServerSeq,peer.subscriptions);
      if(replay){peer.replayCut=this.store.seq;return {type:'replay',actions:replay,missing};}
      // Snapshot recovery has no view hint in AHP 0.9; return all retained turns as specified.
      const snapshots:Snapshot[]=[];for(const uri of peer.subscriptions)snapshots.push(await this.snapshot(uri));
      for(const snapshot of snapshots)peer.cuts.set(snapshot.resource,snapshot.fromSeq);
      return {type:'snapshot',snapshots};
    }
    if(!peer.initialized)throw new RpcFault(-32600,'initialize must be the first request');
    switch(method) {
      case 'subscribe':return {snapshot:await this.subscribe(peer,p.channel,p.view?.turns===undefined?undefined:bounded(p.view.turns,50,10000))};
      case 'unsubscribe':peer.subscriptions.delete(p.channel);this.removeActiveClient(p.channel,peer.clientId);if(!this.hasSubscribers(p.channel)){this.loadedFloors.delete(p.channel);this.watches.delete(p.channel);}return null;
      case 'listSessions': {
        const limit=bounded(p.limit,50,200);
        if(this.config.catalog) {const result=await this.config.catalog.list({connectionId:peer.connectionId,limit,cursor:p.cursor,allowedWorkspaceRoots:this.roots});return {...result,items:result.items.map(row=>this.catalogSummary(row))};}
        const cursor=p.cursor?peer.cursors.get(p.cursor):undefined;if(p.cursor&&!cursor)throw new RpcFault(-32602,'Unknown cursor for this connection');
        const rows=this.store.list(limit+1,cursor as any),items=rows.slice(0,limit);let nextCursor;
        if(rows.length>limit){nextCursor=randomUUID();const last=items.at(-1)!;peer.cursors.set(nextCursor,{modified:last.modifiedAt,uri:last.resource});if(peer.cursors.size>256)peer.cursors.delete(peer.cursors.keys().next().value!);}
        return {items,nextCursor};
      }
      case 'createSession':return this.createSessionResource(p);
      case 'fetchTurns': {
        const record=await this.record(p.channel);if(p.channel!==record.chat.resource)throw new RpcFault(-32602,'fetchTurns requires chat channel');
        const native=this.nativeCursors.get(p.cursor);
        if(native&&native.chat===p.channel){const page=await this.nativeHistory(record,50,native.cursor);this.emit(p.channel,{type:'chat/turnsLoaded',turns:page.turns,turnsNextCursor:page.nextCursor} as StateAction);return {};}
        const cursor=this.cursors.get(p.cursor);if(!cursor||cursor.chat!==p.channel)throw new RpcFault(-32602,'Unknown history cursor; subscribe for current state');
        const page=this.store.turns(p.channel,50,cursor.before);
        this.loadedFloors.set(p.channel,Math.min(this.loadedFloors.get(p.channel)??Number.MAX_SAFE_INTEGER,page.first??Number.MAX_SAFE_INTEGER));
        this.emit(p.channel,{type:'chat/turnsLoaded',turns:page.turns,turnsNextCursor:this.turnCursor(p.channel,page.before)} as StateAction);return {};
      }
      case 'dispatchAction':await this.dispatch(peer,p);return null;
      case 'x-commandReceipt': {
        const receipt=this.store.receipt(p.commandId);if(!receipt)throw new RpcFault(-32008,'Command receipt not found');
        if(receipt.channel!==ROOT)await this.record(receipt.channel);return receipt;
      }
      case 'x-amplifier/capabilityAction': {
        return this.invokeCapability(p,{actorId:peer.clientId!,clientId:peer.clientId!});
      }
      case 'createResourceWatch': {
        if(!this.capability(p.uri))throw new RpcFault(-32601,'Only advertised capability resources support watching');
        if(p.recursive||p.includes||p.excludes)throw new RpcFault(-32602,'Capability watches support exact resources only');
        if([...this.watches.values()].filter(w=>w.owner===peer).length>=32)throw new RpcFault(-32000,'Watch capacity reached');
        const channel='ahp-resource-watch:/'+randomUUID();this.watches.set(channel,{root:p.uri,recursive:false,owner:peer});return {channel};
      }
      case 'resourceList': {
        const provider=this.resourceProvider(p.uri);if(provider?.list)return provider.list(p,{clientId:peer.clientId!});
        const path=await this.workspace(p.uri),entries=await readdir(path,{withFileTypes:true});
        if(entries.length>10000)throw new RpcFault(-32000,'Directory exceeds listing budget; use a paged resource provider');
        return {entries:entries.filter(e=>e.isFile()||e.isDirectory()).map(e=>({name:e.name,type:e.isDirectory()?'directory':'file'}))};
      }
      case 'resourceResolve': {
        const provider=this.resourceProvider(p.uri);if(provider?.resolve)return provider.resolve(p,{clientId:peer.clientId!});
        if(p.followSymlinks===false)throw new RpcFault(-32602,'Non-following resource resolution is not supported');
        const path=await this.resourcePath(p.uri),info=await stat(path);return {uri:pathToFileURL(path).href,type:info.isDirectory()?'directory':'file',size:info.size,mtime:info.mtime.toISOString(),ctime:info.birthtime.toISOString()};
      }
      case 'resourceRead': {
        const topic=this.capability(p.uri);
        if(topic){const data=await this.config.capabilities!.read({uri:p.uri,...topic,clientId:peer.clientId!});const json=JSON.stringify(data);if(Buffer.byteLength(json)>1024*1024)throw new RpcFault(-32000,'Capability exceeds bounded topic size');return {data:json,encoding:'utf-8',contentType:'application/json'};}
        const provider=this.resourceProvider(p.uri);if(provider?.read)return provider.read(p,{clientId:peer.clientId!});
        if(typeof p.uri==='string'&&p.uri.startsWith('file:')){const path=await this.resourcePath(p.uri),info=await stat(path);if(info.size>16*1024*1024)throw new RpcFault(-32000,'Resource exceeds read budget');const body=await readFile(path);return {data:body.toString(p.encoding==='utf-8'?'utf8':'base64'),encoding:p.encoding==='utf-8'?'utf-8':'base64'};}
        if(typeof p.uri!=='string'||!/^ahp-content:\/[a-f0-9]{64}$/.test(p.uri))throw new RpcFault(-32009,'Only host-issued content resources are readable');
        const key=p.uri.slice('ahp-content:/'.length),body=await readFile(join(this.config.stateDirectory,'content',key));
        const metadata=JSON.parse(await readFile(join(this.config.stateDirectory,'content',key+'.json'),'utf8'));
        return {data:body.toString(p.encoding==='utf-8'?'utf8':'base64'),encoding:p.encoding==='utf-8'?'utf-8':'base64',contentType:metadata.contentType};
      }
      case 'resourceWrite':{const provider=this.resourceProvider(p.uri);if(provider?.write)return provider.write(p,{clientId:peer.clientId!});throw new RpcFault(-32009,'No authorized resource writer is registered for this URI');}
      default:throw new RpcFault(-32601,`Unsupported AHP method: ${method}`);
    }
  }
  private async createSessionResource(p:Json,creation?:{sessionId:string;source:Json;commandId:string}) {
    if(typeof p.channel!=='string'||!/^ahp-session:\/[A-Za-z0-9_-]{1,200}$/.test(p.channel))throw new RpcFault(-32602,'Invalid client-chosen session URI');
    return this.withLock(p.channel,async()=>{
      if(this.getRecord(p.channel))throw new RpcFault(-32003,'Session already exists');
      const engine=this.config.engines.find(e=>e.id===(p.provider??this.config.engines[0].id));if(!engine)throw new RpcFault(-32002,'Unknown provider');
      const cwd=await this.workspace(p.workingDirectories?.[0]);
      if(p.activeClient)throw new RpcFault(-32602,'Register active client tools after subscribing to the new session');
      if(Object.keys(p.config??{}).length)throw new RpcFault(-32602,'Creation configuration is not advertised; use negotiated session selectors');
      const creationCommand=creation?.commandId??'create:'+p.channel;
      const timestamp=now(),chat:ChatState={resource:chatURI(p.channel),title:p.title??'New conversation',status:1,modifiedAt:timestamp,turns:[]};
      const summary:SessionSummary={resource:p.channel,provider:engine.id,title:chat.title,status:1,createdAt:timestamp,modifiedAt:timestamp,workingDirectories:[pathToFileURL(cwd).href]};
      const state:SessionState={provider:engine.id,title:chat.title,status:1,lifecycle:SessionLifecycle.Creating,activeClients:[],chats:[this.chatSummary(chat)],defaultChat:chat.resource,workingDirectories:summary.workingDirectories};
      await this.withLock('@directory-reservations',async()=>{await this.workspace(pathToFileURL(cwd).href);if(creation?.source.executionDirectory)await this.workspace(pathToFileURL(creation.source.executionDirectory).href);this.store.transaction(()=>{this.store.admission(p.channel,{kind:'session.create',params:p},creationCommand,'host:creation',this.store.extensionSequence('host:creation'));this.store.save({uri:p.channel,engineId:engine.id,workingDirectory:cwd,executionDirectory:creation?.source.executionDirectory??cwd,summary,state,chat});});});
      this.emit(ROOT,{type:'root/activeSessionsChanged',activeSessions:this.store.count} as StateAction);
      this.notify('root/sessionAdded',{channel:ROOT,summary});
      this.store.finish(creationCommand,'dispatching');
      try {await this.ensureAgent(p.channel,creation);this.emit(p.channel,{type:'session/ready'} as StateAction);this.store.finish(creationCommand,'completed');}
      catch(error){this.store.finish(creationCommand,'unknown',(error as Error).message);this.emit(p.channel,{type:'session/creationFailed',error:{message:(error as Error).message}} as StateAction);throw error;}
      await this.syncCatalog(this.getRecord(p.channel)!);return null;
    });
  }
  private async ensureAgent(uri:string,creation?:{sessionId:string;source:Json;commandId:string}):Promise<Active> {
    if(this.relocationFence(uri))throw new RpcFault(-32011,'Session relocation outcome is fenced; inspect and reconcile without replay');
    const existing=this.active.get(uri);if(existing?.stopCallback)await existing.stopCallback;if(existing&&!existing.agent.closed){existing.lastUsed=Date.now();return existing;}
    if(existing?.agent.closed)this.active.delete(uri);
    if(this.starting.has(uri))return this.starting.get(uri)!;
    const pending=(async()=>{
      await Promise.resolve(); // Publish this reservation before checking concurrent startup capacity.
      const count=()=>new Set([...this.active.keys(),...this.starting.keys()]).size;
      if(count()>(this.config.maxActiveAgents??8))await this.retireIdle(true);
      if(count()>(this.config.maxActiveAgents??8))throw new RpcFault(-32000,'Active agent capacity reached; no historical workers are prewarmed');
      const record=await this.record(uri),engine=this.config.engines.find(e=>e.id===record.engineId);
      if(!engine)throw new RpcFault(-32002,'Session engine is not configured');
      await this.workspace(pathToFileURL(record.executionDirectory??record.workingDirectory).href);
      const active:Active={agent:null as any,busy:false,lastUsed:Date.now(),tools:new Set(),permissions:new Map()};
      const agent=new AcpProcess(engine,record.executionDirectory??record.workingDirectory,{
        hostCapabilities:this.config.nativeHostCapabilities,
        update:params=>{
          const bytes=Buffer.byteLength(JSON.stringify(params));active.updateCount=(active.updateCount??0)+1;active.updateBytes=(active.updateBytes??0)+bytes;
          if(active.updateCount>512||active.updateBytes>8*1024*1024){agent.process.kill();return Promise.reject(new Error('ACP update queue capacity exceeded; execution outcome requires reconciliation'));}
          const update=(active.updates??Promise.resolve()).then(()=>this.update(uri,params)).finally(()=>{active.updateCount!--;active.updateBytes!-=bytes;});active.updates=update;return update;
        },permission:async params=>{await active.updates;return this.permission(uri,params);},
        terminal:event=>this.terminalEvent(uri,event),
        stopped:event=>this.notifyAgentStopped(uri,active,active.retireReason??'process-closed',event),
        nativeEvent:async params=>{
          const event=params.event as Json|undefined;
          if(event?.type==='runtime.ready')active.stopNotified=false;
          if(event?.type==='runtime.closed')this.notifyAgentStopped(uri,active,active.retireReason??'runtime-closed');
          if(event?.type==='history.persisted'&&typeof event.metadataPath==='string'&&isAbsolute(event.metadataPath)&&basename(event.metadataPath)==='metadata.json') {
            // The independent catalog validates its configured native roots and reloads metadata.
            if(!this.getRecord(uri)?.nativeSessionId){active.pendingHints??=[];if(active.pendingHints.length<64)active.pendingHints.push(dirname(event.metadataPath));}
            else await this.config.catalog?.hint?.(dirname(event.metadataPath));
          }
          if(agent.nativeId)await this.config.nativeEvent?.({session:uri,nativeSessionId:agent.nativeId,workingDirectory:record.executionDirectory??record.workingDirectory},params);
        },
        ...(this.config.nativeHostRequest?{hostRequest:async(_method:string,params:Json)=>{
          const observation=params.operation==='operations.observe'&&this.config.nativeHostCapabilities?.features?.operations===true;
          if(!agent.nativeId||agent.closed||this.active.get(uri)!==active||active.stopNotified||(!active.busy&&!active.controlDepth&&!observation))throw new Error('Host capability requires an admitted native turn, scoped native control or negotiated owned-operation observation');
          let bytes=0;
          if(observation){const args=params.args as Json|undefined;bytes=Buffer.byteLength(JSON.stringify(args??{}));if(typeof args?.runtimeSessionId!=='string'||!args.runtimeSessionId||args.runtimeSessionId.length>512||!args.event||typeof args.event!=='object'||Array.isArray(args.event)||bytes>256*1024||(active.observationPending??0)>=32||(active.observationBytes??0)+bytes>1024*1024)throw new Error('Owned operation observation exceeded its scoped callback bounds');active.observationPending=(active.observationPending??0)+1;active.observationBytes=(active.observationBytes??0)+bytes;}
          try{return await this.config.nativeHostRequest!({session:uri,nativeSessionId:agent.nativeId,workingDirectory:record.executionDirectory??record.workingDirectory},params);}finally{if(observation){active.observationPending!--;active.observationBytes!-=bytes;}}
        }}:{}),
      });active.agent=agent;this.active.set(uri,active);
      try {const response=await agent.start(record.nativeSessionId,creation,record.workingDirectory);const fresh=this.getRecord(uri)!,location=response?._meta?.['amplifier.dev/native'] as Json|undefined;if(location?.executionDirectory!==undefined){if(location.historyCwd!==record.workingDirectory||location.executionDirectory!==(record.executionDirectory??record.workingDirectory)||!Number.isSafeInteger(location.executionRevision))throw new Error('Native execution location differs from the authorized host mapping; reconcile before executing');fresh.nativeLocationRevision=location.executionRevision;}fresh.nativeSessionId=agent.nativeId;fresh.state._meta={...fresh.state._meta,'amplifier.dev/acp':{...(fresh.state._meta?.['amplifier.dev/acp'] as Json),capabilities:agent.initialized.agentCapabilities,configOptions:response?.configOptions??[],configOptionsProtocol:response?.configOptions===undefined&&response?.modes?'legacy-mode':'standard',...(response?.modes?{legacyModes:response.modes}: {})}};this.store.save(fresh);await this.syncCatalog(fresh);for(const path of active.pendingHints??[])await this.config.catalog?.hint?.(path);active.pendingHints=[];this.configState(uri,response?.configOptions??this.legacyModeOptions(response?.modes));return active;}
      catch(error){active.retireReason='startup-failed';this.active.delete(uri);await agent.retire();throw error;}
    })();this.starting.set(uri,pending);try{return await pending;}finally{this.starting.delete(uri);}
  }
  private async syncCatalog(record:SessionRecord) {
    if(!this.config.catalog)return;
    await this.config.catalog.upsert({uri:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory,title:record.summary.title,createdAt:record.summary.createdAt,modifiedAt:record.summary.modifiedAt,status:record.summary.status,availability:'available',workspaceAvailability:'present'});
  }
  private emit(channel:string,action:StateAction,origin?:ActionEnvelope['origin'],rejectionReason?:string):ActionEnvelope {
    const previous=this.getRecord(channel);let record=previous?{...previous}:undefined;
    const priorSummary=record&&JSON.stringify(this.chatSummary(record.chat));
    const envelope=this.store.transaction(()=>{
      const terminal=this.terminalState(channel);
      if(terminal&&!rejectionReason){const next=terminalReducer(terminal,action as any);this.store.db.prepare('UPDATE terminals SET payload=?,modified=?,lifecycle=? WHERE uri=?').run(JSON.stringify(next),now(),next.lifecycle.status,channel);}
      if(record&&!rejectionReason) {
        if(channel===record.chat.resource) {
          // The projection holds only the active turn. Completed history is independently indexed.
          const reduced=chatReducer({...record.chat,turns:[]},action as any);
          if(action.type!=='chat/turnsLoaded')for(const turn of reduced.turns){const ordinal=this.store.saveTurn(channel,turn);if(this.loadedFloors.has(channel))this.loadedFloors.set(channel,Math.min(this.loadedFloors.get(channel)!,ordinal));}
          record.chat={...reduced,turns:[]};
        } else record.state=sessionReducer(record.state,action as any);
        record.summary={...record.summary,title:record.state.title,status:record.chat.status,modifiedAt:record.chat.modifiedAt};
        if(channel===record.uri)this.store.saveSessionMetadata(record);
        else if(record.chat.activeTurn&&action.type!=='chat/turnStarted'&&action.type!=='chat/turnsLoaded')this.store.appendActive(channel,action);
        else this.store.save(record);
      }
      return this.store.append(channel,action,origin,rejectionReason);
    });
    if(record&&!rejectionReason){if(record.chat.activeTurn)this.hotRecords.set(record.uri,record);else this.hotRecords.delete(record.uri);}
    for(const peer of this.peers)if(peer.subscriptions.has(channel)||origin?.clientId===peer.clientId)this.send(peer,{jsonrpc:'2.0',method:'action',params:envelope});
    for(const observer of this.observers)if(observer.session===channel||observer.chat===channel){
      const bytes=Buffer.byteLength(JSON.stringify(envelope));
      if(observer.queue.length>=128||observer.bytes+bytes>512*1024){observer.closed=true;this.observers.delete(observer);observer.queue=[];try{observer.onError?.(new Error('Scoped observer fell behind; reload selected state'));}catch{}continue;}
      observer.queue.push(envelope);observer.bytes+=bytes;
      if(!observer.running){observer.running=true;void(async()=>{try{while(!observer.closed&&observer.queue.length){const event=observer.queue.shift()!;observer.bytes-=Buffer.byteLength(JSON.stringify(event));await observer.listener(structuredClone(event));}}catch(error){observer.closed=true;this.observers.delete(observer);observer.queue=[];try{observer.onError?.(error as Error);}catch{}}finally{observer.running=false;}})();}
    }
    if(record&&!rejectionReason&&channel===record.chat.resource&&action.type!=='chat/turnsLoaded'&&JSON.stringify(this.chatSummary(record.chat))!==priorSummary) {
      const changes=this.chatSummary(record.chat);
      this.emit(record.uri,{type:'session/chatUpdated',chat:channel,changes:{title:changes.title,status:changes.status,modifiedAt:changes.modifiedAt}} as StateAction);
      this.notify('root/sessionSummaryChanged',{channel:ROOT,session:record.uri,changes:{status:record.chat.status,modifiedAt:record.chat.modifiedAt}});
    }
    return envelope;
  }
  private async dispatch(peer:Peer,p:Json) {
    if(!Number.isSafeInteger(p.clientSeq)||p.clientSeq<0||!p.action||typeof p.action.type!=='string')throw new RpcFault(-32602,'Invalid dispatch');
    const origin={clientId:peer.clientId!,clientSeq:p.clientSeq},action=p.action as StateAction;
    try {
      if(peer.seenClientSeq.has(p.clientSeq)||p.clientSeq<=peer.lastClientSeq-1024)throw new Error('Client action sequence was already used or expired');peer.lastClientSeq=Math.max(peer.lastClientSeq,p.clientSeq);peer.seenClientSeq.add(p.clientSeq);for(const seq of peer.seenClientSeq)if(seq<=peer.lastClientSeq-1024)peer.seenClientSeq.delete(seq);
      const record=await this.record(p.channel);
      await this.withLock(record.uri,async()=>{
        if(action.type==='session/activeClientSet') {
          if(p.channel!==record.uri||action.activeClient.clientId!==peer.clientId||!peer.subscriptions.has(record.uri))throw new Error('Client tools require the owning client and a session subscription');
          if(!Array.isArray(action.activeClient.tools)||action.activeClient.tools.length>64||Buffer.byteLength(JSON.stringify(action.activeClient))>65536)throw new Error('Client capability declaration exceeds limit');
          if(action.activeClient.customizations?.length)throw new Error('Client plugin customizations are not supported');
          this.emit(p.channel,action,origin);return;
        }
        if(action.type==='session/activeClientRemoved') {
          if(p.channel!==record.uri||action.clientId!==peer.clientId)throw new Error('Only the owning client can remove its tools');
          this.emit(p.channel,action,origin);this.removeActiveClient(record.uri,peer.clientId);return;
        }
        if(action.type==='chat/toolCallComplete') {
          const pending=this.clientTools.get(action.toolCallId);
          if(!pending||pending.clientId!==peer.clientId||pending.chat!==p.channel||pending.turnId!==action.turnId)throw new Error('Only the targeted client can complete its pending tool');
          if(typeof action.result?.success!=='boolean'||Buffer.byteLength(JSON.stringify(action.result))>1024*1024)throw new Error('Invalid or oversized client tool result');
          this.emit(p.channel,action,origin);this.finishClientTool(action.toolCallId,action.result);return;
        }
        if(action.type==='chat/turnStarted') {
          await this.admitTurn(record,p.channel,action,origin);return;
        }
        if(action.type==='chat/turnCancelled') {
          const active=this.active.get(record.uri);
          if(!active?.busy||active.turnId!==action.turnId)throw new Error('No matching active turn');
          if(active.cancel)throw new Error('Cancellation already requested');
          this.store.bump(record.uri,'interruption');
          active.cancel={action,origin};
          for(const pending of active.permissions.values())pending.resolve({outcome:{outcome:'cancelled'}});active.permissions.clear();
          await active.agent.client.cancel({sessionId:active.agent.nativeId!});
          // Echo after ACP stops, so late tool updates remain in the authoritative active turn.
          return;
        }
        if(action.type==='chat/toolCallConfirmed') {
          const active=this.active.get(record.uri),pending=active?.permissions.get(action.toolCallId);
          if(!active||active.turnId!==action.turnId||!pending)throw new Error('Permission request is no longer pending');
          const options=pending.params.options;
          const option=action.selectedOptionId?options.find(o=>o.optionId===action.selectedOptionId):options.find(o=>action.approved?o.kind==='allow_once':o.kind==='reject_once');
          if(!option||action.approved!==option.kind.startsWith('allow_'))throw new Error('Permission option does not match approval');
          if('editedToolInput' in action)throw new Error('ACP permission options do not permit editing tool inputs');
          active.permissions.delete(action.toolCallId);
          this.emit(p.channel,action,origin);this.emit(record.uri,{type:'session/inputNeededRemoved',id:action.toolCallId} as StateAction);
          pending.resolve({outcome:{outcome:'selected',optionId:option.optionId}});return;
        }
        if(action.type==='session/titleChanged'||action.type==='session/isReadChanged'||action.type==='session/isArchivedChanged') {
          if(p.channel!==record.uri)throw new Error('Action requires session channel');
          this.emit(p.channel,action,origin);await this.syncCatalog(this.getRecord(record.uri)!);return;
        }
        if(action.type==='session/configChanged') {
          if(p.channel!==record.uri)throw new Error('Config action requires session channel');
          if(Object.keys(action.config).length!==1)throw new Error('One standard ACP config selector per action is required');
          const active=await this.ensureAgent(record.uri),[configId,value]=Object.entries(action.config)[0];
          if(typeof value!=='string')throw new Error('ACP selector value must be a string');
          const current=this.getRecord(record.uri)!;
          if(configId==='mode'&&(current.state._meta?.['amplifier.dev/acp'] as Json)?.configOptionsProtocol==='legacy-mode'){
            const modes=(current.state._meta!['amplifier.dev/acp'] as Json).legacyModes;
            if(!modes.availableModes.some((mode:Json)=>mode.id===value))throw new Error('Unknown ACP legacy mode');
            await active.agent.client.setSessionMode({sessionId:active.agent.nativeId!,modeId:value});
            this.configState(record.uri,this.legacyModeOptions({...modes,currentModeId:value}));
          }else{const response=await active.agent.client.setSessionConfigOption({sessionId:active.agent.nativeId!,configId,value});this.configState(record.uri,response.configOptions);}
          this.emit(p.channel,action,origin);return;
        }
        throw new Error(`Action is unsupported: ${action.type}`);
      });
    } catch(error) {this.emit(p.channel,action,origin,(error as Error).message);}
  }
  private async admitTurn(record:SessionRecord,channel:string,action:Extract<StateAction,{type:'chat/turnStarted'}>,origin:NonNullable<ActionEnvelope['origin']>,scheduled?:Json) {
    record=this.getRecord(record.uri)!;
    if(channel!==record.chat.resource||!action.turnId||typeof action.message?.text!=='string'||action.message.origin?.kind!=='user'||!Number.isFinite(Date.parse(action.startedAt)))throw new Error('Malformed user turn');
    if(record.state.lifecycle!==SessionLifecycle.Ready)throw new Error('Session creation has not completed; reconcile its outcome before execution');
    if(this.store.unknown(channel))throw new Error('A prior execution outcome is unknown; reconcile native history first');
    if(this.getRecord(record.uri)!.chat.activeTurn)throw new Error('A turn is already running; queued turns and steering are not advertised');
    const blocks=this.prompt(action.message),active=await this.ensureAgent(record.uri);
    if(active.busy)throw new Error('The previous ACP turn has not finished; wait for its authoritative outcome');
    this.checkContentCapabilities(active,blocks);
    if(scheduled){
      if((active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.scheduledTurns?.version!==1)throw new Error('Agent does not advertise settled scheduled turns');
      const current=await this.inspectSession(record.uri);
      if(current.interruptionRevision!==scheduled.expectedInterruptionRevision||current.executionRevision!==scheduled.expectedExecutionRevision||current.configurationHash!==scheduled.expectedConfigurationHash)throw new Error('Scheduled admission revisions changed');
    }
    this.store.transaction(()=>{this.store.admission(channel,action,action.turnId,origin.clientId,origin.clientSeq);this.store.bump(record.uri,'execution');});
    active.busy=true;active.cancel=undefined;active.projectionBytes=Buffer.byteLength(JSON.stringify(action));active.turnId=action.turnId;active.started=Date.now();active.textPart=undefined;active.reasoningPart=undefined;active.tools.clear();active.toolStates=new Map();
    this.emit(channel,action,origin.clientSeq>=0?origin:undefined);this.store.finish(action.turnId,'dispatching');active.run=this.run(record.uri,active,blocks,scheduled);
  }
  /** Trusted capability owners submit user-authorized inputs through ordinary admission. */
  async submitTurn(session:string,input:{commandId:string;text:string;clientId:string;attachments?:Message['attachments']}) {
    if(typeof input.commandId!=='string'||!input.commandId||input.commandId.length>512||typeof input.clientId!=='string'||!input.clientId||typeof input.text!=='string'||Buffer.byteLength(input.text)>1024*1024)throw new RpcFault(-32602,'Bounded command, client identity and text are required');
    if(input.attachments&&(!Array.isArray(input.attachments)||input.attachments.length>16||Buffer.byteLength(JSON.stringify(input.attachments))>8*1024*1024))throw new RpcFault(-32602,'Attachments exceed the admitted input bound');
    const record=await this.record(session);
    await this.withLock(record.uri,async()=>{if(this.store.receipt(input.commandId))throw new RpcFault(-32011,'Command already admitted; inspect its durable receipt before new work');await this.admitTurn(record,record.chat.resource,{type:'chat/turnStarted',turnId:input.commandId,startedAt:now(),message:{text:input.text,origin:{kind:'user'},...(input.attachments?{attachments:input.attachments}:{})}} as any,{clientId:input.clientId,clientSeq:this.store.extensionSequence(input.clientId)});});
    return {accepted:true,inputId:input.commandId,sessionId:record.uri,delivery:'sending',receipt:this.store.receipt(input.commandId)};
  }
  /** Durable common creation for a configured source; no native history or goals are copied. */
  async createSession(input:{commandId:string;idempotencyKey:string;sourceSession:string;expectedConfigurationHash:string;title?:string}) {
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||typeof input.idempotencyKey!=='string'||!input.idempotencyKey||input.idempotencyKey.length>512||typeof input.expectedConfigurationHash!=='string'||(input.title!==undefined&&(typeof input.title!=='string'||input.title.length>1000)))throw new RpcFault(-32602,'Bounded creation identity and expected configuration required');
    const source=await this.record(input.sourceSession),identity=createHash('sha256').update(JSON.stringify([source.uri,input.idempotencyKey])).digest('hex');
    const nativeId=identity.slice(0,8)+'-'+identity.slice(8,12)+'-5'+identity.slice(13,16)+'-a'+identity.slice(17,20)+'-'+identity.slice(20,32),uri='ahp-session:/'+nativeId;
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.withLock(source.uri,async()=>{
      const prior=this.store.db.prepare('SELECT * FROM creation_keys WHERE identity=?').get(identity);
      if(prior){
        if(prior.fingerprint!==fingerprint)throw new RpcFault(-32011,'Creation identity reused with different content');
        const receipt=this.store.receipt(String(prior.command_id)),record=this.getRecord(uri);
        if(receipt?.status==='completed'&&record?.state.lifecycle===SessionLifecycle.Ready)return {uri,creationConfirmed:true as const,receipt};
        throw new RpcFault(-32011,'Creation outcome unknown or incomplete; it must not be automatically repeated');
      }
      if((await this.inspectSession(source.uri)).configurationHash!==input.expectedConfigurationHash)throw new RpcFault(-32011,'Source configuration changed');
      const active=await this.ensureAgent(source.uri);
      if((active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.configurationClone?.version!==1)throw new RpcFault(-32601,'Agent does not advertise exact configuration cloning');
      if(active.busy)throw new RpcFault(-32011,'Source must be idle while its configuration is captured');
      const snapshot=await active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation:'configuration.snapshot',args:{}});
      if(snapshot.version!==1||snapshot.sourceSessionId!==active.agent.nativeId||snapshot.sourceCwd!==source.workingDirectory||typeof snapshot.configurationHash!=='string'||Buffer.byteLength(JSON.stringify(snapshot))>65536)throw new RpcFault(-32000,'Invalid native configuration snapshot reference');
      if((await this.inspectSession(source.uri)).configurationHash!==input.expectedConfigurationHash)throw new RpcFault(-32011,'Source configuration changed while preparing creation');
      this.store.db.prepare('INSERT INTO creation_keys VALUES(?,?,?,?)').run(identity,input.commandId,uri,fingerprint);
      await this.createSessionResource({channel:uri,provider:source.engineId,workingDirectories:[pathToFileURL(source.workingDirectory).href],title:input.title},{sessionId:nativeId,source:snapshot,commandId:input.commandId});
      return {uri,creationConfirmed:true as const,receipt:this.store.receipt(input.commandId)};
    });
  }
  /** Compare-and-admit scheduled work under the same session lock as user turns and stop. */
  async submitScheduled(session:string,input:{commandId:string;text:string;taskId:string;taskRevision:number;kind:'task'|'monitor';expectedInterruptionRevision:number;expectedExecutionRevision:number;expectedConfigurationHash:string;scheduledRunId?:string}) {
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||typeof input.text!=='string'||Buffer.byteLength(input.text)>1024*1024||typeof input.taskId!=='string'||!input.taskId||input.taskId.length>512||!['task','monitor'].includes(input.kind)||![input.taskRevision,input.expectedInterruptionRevision,input.expectedExecutionRevision].every(n=>Number.isSafeInteger(n)&&n>=0)||typeof input.expectedConfigurationHash!=='string')throw new RpcFault(-32602,'Malformed bounded scheduled admission');
    const record=await this.record(session);
    return this.withLock(record.uri,async()=>{
      if(this.store.receipt(input.commandId))throw new RpcFault(-32011,'Scheduled command already admitted; inspect its receipt without replay');
      try {
        const meta={inputOrigin:'scheduled',scheduledRunId:input.scheduledRunId??input.commandId,taskId:input.taskId,taskRevision:input.taskRevision,kind:input.kind};
        await this.admitTurn(record,record.chat.resource,{type:'chat/turnStarted',turnId:input.commandId,startedAt:now(),message:{text:input.text,origin:{kind:'user'},_meta:{'amplifier.dev/scheduled':meta}}} as any,{clientId:'host:schedule',clientSeq:this.store.extensionSequence('host:schedule')},input);
        return {accepted:true,turnId:input.commandId,receipt:this.store.receipt(input.commandId)};
      }catch(error){if(this.store.receipt(input.commandId))throw error;return {accepted:false,reason:(error as Error).message};}
    });
  }
  /** Wait for an already admitted turn. Timeout leaves execution running and never resubmits. */
  async waitForTurn(session:string,commandId:string,timeoutMs=600000) {
    const record=await this.record(session),receipt=this.store.receipt(commandId);
    if(!receipt||receipt.channel!==record.chat.resource)throw new RpcFault(-32008,'No admitted turn in this conversation');
    const active=this.active.get(record.uri);let timer:ReturnType<typeof setTimeout>|undefined;
    try {if(active?.turnId===commandId&&active.run)await Promise.race([active.run,new Promise<void>(resolve=>{timer=setTimeout(resolve,bounded(timeoutMs,600000,600000));timer.unref();})]);}
    finally {clearTimeout(timer);}
    const current=this.store.receipt(commandId)!,row=this.store.db.prepare('SELECT payload FROM turns WHERE chat=? AND turn_id=?').get(record.chat.resource,commandId);
    const turn=row?JSON.parse(row.payload as string):undefined;
    const text=(turn?.responseParts??[]).filter((part:any)=>part.kind==='markdown').map((part:any)=>part.content??'').join('\n').slice(0,50000);
    return {generation_id:commandId,status:current.status,completed:current.status==='completed',text,detail:current.detail,workContinues:['admitted','dispatching'].includes(current.status)};
  }
  /** Exact host-indexed input, never a recent-window search or eager native transcript read. */
  async readUserMessage(session:string,messageId:string,options:{maxBytes?:number}={}):Promise<Json> {
    if(typeof messageId!=='string'||!messageId||messageId.length>512)throw new RpcFault(-32602,'A bounded exact message identity is required');
    const maxBytes=bounded(options.maxBytes,65536,1024*1024),record=await this.record(session);
    const fail=(reason:MessageUnavailableReason):never=>{throw new MessageUnavailableError(reason,record.uri,messageId);};
    let message:Message,createdAt:string;
    if(record.chat.activeTurn?.id===messageId){message=record.chat.activeTurn.message;createdAt=record.chat.activeTurn.startedAt;if(Buffer.byteLength(JSON.stringify(message))>maxBytes)fail('oversized');}
    else {
      // The composite unique index selects one turn. Never materialize its potentially huge response.
      const row=this.store.db.prepare("SELECT length(CAST(json_extract(payload,'$.message') AS BLOB)) AS bytes, CASE WHEN length(CAST(json_extract(payload,'$.message') AS BLOB))<=? THEN json_extract(payload,'$.message') END AS message, json_extract(payload,'$.startedAt') AS created_at FROM turns WHERE chat=? AND turn_id=?").get(maxBytes,record.chat.resource,messageId);
      if(!row)fail('not-indexed');if(Number(row!.bytes)>maxBytes)fail('oversized');
      if(typeof row!.message!=='string')fail('invalid-provenance');message=JSON.parse(String(row!.message));createdAt=String(row!.created_at);
    }
    if(message.origin?.kind!=='user')fail('not-user');if(typeof message.text!=='string'||!Number.isFinite(Date.parse(createdAt)))fail('invalid-provenance');
    const history=message._meta?.['amplifier.dev/history'] as Json|undefined,scheduled=message._meta?.['amplifier.dev/scheduled'] as Json|undefined,input=message._meta?.['amplifier.dev/input'] as Json|undefined,raw=message as unknown as Json;
    const receipt=this.store.receipt(messageId),admission=receipt?.channel===record.chat.resource?receipt:undefined;
    const questionId=input?.questionId??history?.questionId??scheduled?.questionId??raw.questionId,scheduledRunId=scheduled?.scheduledRunId??input?.scheduledRunId??raw.scheduledRunId,voiceId=history?.callId??input?.voiceId??raw.voiceId,voiceItemId=history?.itemId??input?.voiceItemId??raw.voiceItemId;
    const inputOrigin=scheduled||scheduledRunId?'scheduled':questionId?'question':history?.via==='call'?'voice':input?.inputOrigin??history?.inputOrigin??raw.inputOrigin??(admission?'user':'unknown');
    return structuredClone({...message,id:messageId,role:'user',createdAt,inputOrigin,...(questionId?{questionId}:{}),...(scheduledRunId?{scheduledRunId}:{}),...(voiceId?{voiceId}:{}),...(voiceItemId?{voiceItemId}:{}),provenance:{source:admission?'host-admission':'host-projection',complete:true,...(admission?{admission:{clientId:admission.clientId,status:admission.status,createdAt:admission.createdAt}}:{})}});
  }
  /** Selected context only. It never widens an AHP subscription's shared history window. */
  async readSessionContext(session:string,limit=12) {
    limit=bounded(limit,12,50);const record=await this.record(session);let turns=this.store.turns(record.chat.resource,limit).turns;
    if((record.chat._meta?.['amplifier.dev/history'] as Json)?.source==='native'){const native=await this.nativeHistory(record,limit),ids=new Set(turns.map(t=>t.id));turns=[...native.turns.filter(t=>!ids.has(t.id)),...turns].slice(-limit);}
    const messages:Json[]=[];
    for(const turn of turns){
      const history=turn.message._meta?.['amplifier.dev/history'] as Json|undefined,scheduled=turn.message._meta?.['amplifier.dev/scheduled'] as Json|undefined;
      const provenance={createdAt:turn.startedAt,inputOrigin:scheduled?.inputOrigin??(history?.via==='call'?'voice':'user'),...(scheduled?{scheduledRunId:scheduled.scheduledRunId}:{}),...(history?.via==='call'?{voiceId:history.callId,voiceItemId:history.itemId}:{})};
      if(turn.message.text)messages.push({id:turn.id,role:turn.message.origin?.kind==='agent'?'assistant':'user',text:turn.message.text.slice(0,5000),truncated:turn.message.text.length>5000,...provenance});
      const text=turn.responseParts.filter((part:any)=>part.kind==='markdown').map((part:any)=>part.content??'').join('\n');
      if(text)messages.push({id:turn.id+':response',role:'assistant',text:text.slice(0,5000),truncated:text.length>5000,...provenance});
    }
    return {...await this.inspectSession(session),status:record.chat.status,messages:messages.slice(-limit),recentLimit:limit};
  }
  /** Native-only recordings become available on the next standard history read. */
  async invalidateNativeHistory(session:string) {
    const record=await this.record(session);if(!record.nativeSessionId)throw new RpcFault(-32008,'No native history identity');
    record.chat._meta={...record.chat._meta,'amplifier.dev/history':{source:'native',available:true}};this.store.save(record);
    this.notify('root/sessionSummaryChanged',{channel:ROOT,session:record.uri,changes:{modifiedAt:now()}});
  }
  /** One bounded observer per active capability consumer, with an explicit release callback. */
  async observeSession(session:string,listener:(event:ActionEnvelope)=>void|Promise<void>,onError?:(error:Error)=>void) {
    if(this.observers.size>=64)throw new RpcFault(-32000,'Scoped observer capacity reached');const record=await this.record(session);
    const observer={session:record.uri,chat:record.chat.resource,queue:[] as ActionEnvelope[],bytes:0,running:false,closed:false,listener,onError};this.observers.add(observer);
    return ()=>{observer.closed=true;observer.queue=[];this.observers.delete(observer);};
  }
  private prompt(message:Message):ContentBlock[] {
    if(message.model||message.agent)throw new Error('Per-message model/custom-agent selection is not advertised; use session configuration');
    const blocks:ContentBlock[]=[{type:'text',text:message.text}];
    for(const attachment of message.attachments??[]) {
      if(attachment.type==='simple'&&attachment.modelRepresentation)blocks.push({type:'text',text:attachment.modelRepresentation});
      else if(attachment.type==='resource')blocks.push({type:'resource_link',uri:attachment.uri,name:attachment.label,mimeType:attachment.contentType});
      else if(attachment.type==='embeddedResource') {
        if(attachment.contentType.startsWith('image/'))blocks.push({type:'image',mimeType:attachment.contentType,data:attachment.data});
        else if(attachment.contentType.startsWith('audio/'))blocks.push({type:'audio',mimeType:attachment.contentType,data:attachment.data});
        else blocks.push({type:'resource',resource:{uri:`data:${attachment.contentType};base64,${attachment.data}`,mimeType:attachment.contentType,blob:attachment.data}});
      } else throw new Error(`Attachment type unsupported: ${attachment.type}`);
    }return blocks;
  }
  private checkContentCapabilities(active:Active,blocks:ContentBlock[]) {
    const capabilities=active.agent.initialized.agentCapabilities?.promptCapabilities;
    for(const block of blocks) {
      if(block.type==='image'&&!capabilities?.image)throw new Error('Agent did not advertise image prompts');
      if(block.type==='audio'&&!capabilities?.audio)throw new Error('Agent did not advertise audio prompts');
      if(block.type==='resource'&&!capabilities?.embeddedContext)throw new Error('Agent did not advertise embedded context');
    }
  }
  private async run(uri:string,active:Active,blocks:ContentBlock[],scheduled?:Json) {
    const channel=chatURI(uri),turnId=active.turnId!;
    try {
      const response:Json=scheduled?await active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation:'schedule.submit',args:{taskId:scheduled.taskId,taskRevision:scheduled.taskRevision,inputId:turnId,text:scheduled.text,kind:scheduled.kind,interruptionRevision:scheduled.expectedInterruptionRevision}}):await active.agent.client.prompt({sessionId:active.agent.nativeId!,prompt:blocks,_meta:{'amplifier.dev/command':{commandId:turnId}}});
      if(scheduled&&response.accepted!==true){
        if(response.accepted!==false)throw new Error('Native scheduled outcome was not conclusive');
        await active.updates;this.store.finish(turnId,'failed',String(response.reason??'Native schedule rejected'));
        this.emit(channel,{type:'chat/error',turnId,duration:Date.now()-active.started!,part:{kind:'error',error:{message:String(response.reason??'Native schedule rejected before execution')}}} as StateAction);return;
      }
      if(typeof response.stopReason!=='string')throw new Error('Native execution did not provide a settled stop reason');
      await active.updates;
      if(response.usage&&this.getRecord(uri)!.chat.activeTurn)this.emit(channel,{type:'chat/usage',turnId,usage:{inputTokens:response.usage.inputTokens,outputTokens:response.usage.outputTokens,cacheReadTokens:response.usage.cachedReadTokens??undefined,_meta:{'amplifier.dev/acp':{usage:response.usage,experimental:true}}}} as StateAction);
      if(active.cancel&&response.stopReason!=='cancelled')this.emit(channel,active.cancel.action,active.cancel.origin,'Turn finished before cancellation took effect');
      if(this.getRecord(uri)!.chat.activeTurn) this.emit(channel,{type:response.stopReason==='cancelled'?'chat/turnCancelled':'chat/turnComplete',turnId,duration:Date.now()-active.started!,_meta:{'amplifier.dev/acp':{stopReason:response.stopReason}}} as StateAction,response.stopReason==='cancelled'?active.cancel?.origin:undefined);
      this.store.finish(turnId,response.stopReason==='cancelled'?'cancelled':'completed',response.stopReason);
    } catch(error) {
      this.store.finish(turnId,'unknown',(error as Error).message);
      if(this.getRecord(uri)!.chat.activeTurn)this.emit(channel,{type:'chat/error',turnId,duration:Date.now()-active.started!,part:{kind:'error',error:{message:`Execution outcome unknown: ${(error as Error).message}`}}} as StateAction);
    } finally {
      for(const pending of active.permissions.values())pending.resolve({outcome:{outcome:'cancelled'}});active.permissions.clear();active.busy=false;active.lastUsed=Date.now();
      await this.syncCatalog(this.getRecord(uri)!).catch(()=>{});
    }
  }
  private legacyModeOptions(modes?:Json):any[] {return modes?.availableModes?[{id:'mode',name:'Mode',type:'select',currentValue:modes.currentModeId,options:modes.availableModes.map((mode:Json)=>({value:mode.id,name:mode.name,description:mode.description}))}]:[];}
  private acpMetadata(uri:string,patch:Json) {
    if(Buffer.byteLength(JSON.stringify(patch))>512*1024)throw new Error('ACP session metadata exceeds bounded projection capacity');
    const record=this.getRecord(uri)!;
    this.emit(uri,{type:'session/metaChanged',_meta:{...record.state._meta,'amplifier.dev/acp':{...(record.state._meta?.['amplifier.dev/acp'] as Json),...patch}}} as StateAction);
  }
  private configState(uri:string,options:any[]) {
    const record=this.getRecord(uri)!;
    const properties:Record<string,any>={},values:Record<string,unknown>={};
    for(const option of options) {if(option.type!=='select')continue;const choices=(option.options??[]).flatMap((o:any)=>o.options??[o]);properties[option.id]={type:'string',title:option.name,description:option.description,enum:choices.map((o:any)=>o.value),enumLabels:choices.map((o:any)=>o.name),sessionMutable:true};values[option.id]=option.currentValue;}
    if(JSON.stringify(record.state.config?.values??{})!==JSON.stringify(values))this.store.bump(uri,'configuration');
    record.state.config={schema:{type:'object',properties},values};record.state._meta={...record.state._meta,'amplifier.dev/acp':{...(record.state._meta?.['amplifier.dev/acp'] as Json),configOptions:options}};this.store.saveSessionMetadata(record);
    this.emit(uri,{type:'session/metaChanged',_meta:record.state._meta} as StateAction);
    this.emit(uri,{type:'session/configChanged',config:values,replace:true} as StateAction);
  }
  private async content(block:any):Promise<Json> {
    const body=block.data?Buffer.from(block.data,'base64'):Buffer.from(JSON.stringify(block));
    const key=createHash('sha256').update(body).digest('hex'),directory=join(this.config.stateDirectory,'content');await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(join(directory,key),body,{mode:0o600});await writeFile(join(directory,key+'.json'),JSON.stringify({contentType:block.mimeType??'application/json'}),{mode:0o600});
    return {kind:'contentRef',uri:`ahp-content:/${key}`,contentType:block.mimeType??'application/json'};
  }
  private async toolContent(content:any[]):Promise<any[]> {
    const results=[];
    for(const item of content) {
      if(item.type==='terminal')results.push({type:'terminal',resource:`ahp-terminal:/${item.terminalId}`,title:'Agent terminal',isPty:false});
      else if(item.type==='diff')results.push({type:'text',text:`File: ${item.path}\nPrevious:\n${item.oldText??''}\nUpdated:\n${item.newText??''}`});
      else if(item.type==='content'){
        const block=item.content;
        if(block.type==='text')results.push({type:'text',text:block.text});
        else if(block.type==='resource_link')results.push({type:'resource',uri:block.uri,contentType:block.mimeType});
        else {const ref=await this.content(block);results.push({type:'resource',uri:ref.uri,contentType:ref.contentType});}
      }
    }return results;
  }
  private async update(uri:string,params:SessionNotification,projection?:{active:Active;emit:(action:StateAction)=>void}) {
    const active=projection?.active??this.active.get(uri);if(!active)return;
    const update=params.update as any;
    if(update.sessionUpdate==='config_option_update'){if(!projection){this.acpMetadata(uri,{configOptionsProtocol:'standard'});this.configState(uri,update.configOptions);}return;}
    if(['available_commands_update','usage_update','current_mode_update','session_info_update'].includes(update.sessionUpdate)){
      if(projection)return;
      if(update.sessionUpdate==='available_commands_update')this.acpMetadata(uri,{availableCommands:update.availableCommands});
      if(update.sessionUpdate==='usage_update')this.acpMetadata(uri,{usage:{used:update.used,size:update.size,cost:update.cost??null,_meta:update._meta}});
      if(update.sessionUpdate==='current_mode_update'){
        const record=this.getRecord(uri)!,meta=record.state._meta?.['amplifier.dev/acp'] as Json;
        this.acpMetadata(uri,{currentModeId:update.currentModeId,...(meta?.legacyModes?{legacyModes:{...meta.legacyModes,currentModeId:update.currentModeId}}:{})});
        if(meta?.legacyModes)this.configState(uri,this.legacyModeOptions({...meta.legacyModes,currentModeId:update.currentModeId}));
        else if(record.state.config?.schema?.properties?.mode)this.emit(uri,{type:'session/configChanged',config:{mode:update.currentModeId}} as StateAction);
      }
      if(update.sessionUpdate==='session_info_update'){
        this.acpMetadata(uri,{sessionInfo:{...((this.getRecord(uri)!.state._meta?.['amplifier.dev/acp'] as Json)?.sessionInfo??{}),...update}});
        if(update.title!==undefined)this.emit(uri,{type:'session/titleChanged',title:update.title??''} as StateAction);
        await this.syncCatalog(this.getRecord(uri)!);
      }
      return;
    }
    if(active.agent.loading)return; // load replay never executes or duplicates the persisted host projection.
    if(!active.busy||!active.turnId)return;
    if(!projection){active.projectionBytes=(active.projectionBytes??0)+Buffer.byteLength(JSON.stringify(update));if(active.projectionBytes>(this.config.maxActiveProjectionBytes??8*1024*1024)){void active.agent.client.cancel({sessionId:active.agent.nativeId!}).catch(()=>{});throw new Error('Active view exceeded its byte budget; native history is preserved and execution outcome requires reconciliation');}}
    const channel=chatURI(uri),turnId=active.turnId;
    const emit=(action:StateAction)=>projection?projection.emit(action):this.emit(channel,action);
    if(update.sessionUpdate==='agent_message_chunk') {
      if(update.content.type==='text') {
        if(!active.textPart){active.textPart=randomUUID();emit({type:'chat/responsePart',turnId,part:{kind:'markdown',id:active.textPart,content:''}} as StateAction);}
        emit({type:'chat/delta',turnId,partId:active.textPart,content:update.content.text} as StateAction);
      } else {active.textPart=undefined;emit({type:'chat/responsePart',turnId,part:await this.content(update.content)} as StateAction);}
    } else if(update.sessionUpdate==='agent_thought_chunk') {
      active.textPart=undefined;
      if(update.content.type==='text'){if(!active.reasoningPart){active.reasoningPart=randomUUID();emit({type:'chat/responsePart',turnId,part:{kind:'reasoning',id:active.reasoningPart,content:''}} as StateAction);}emit({type:'chat/reasoning',turnId,partId:active.reasoningPart,content:update.content.text} as StateAction);}
    } else if(update.sessionUpdate==='tool_call'||update.sessionUpdate==='tool_call_update') {
      active.textPart=undefined;const id=update.toolCallId;active.toolStates??=new Map();
      const previous=active.toolStates.get(id)??{},current={...previous,...Object.fromEntries(Object.entries(update).filter(([key,value])=>value!==undefined&&(value!==null||key==='rawInput'||key==='rawOutput')))};
      active.toolStates.set(id,current);
      const metadata={'amplifier.dev/acp':{kind:current.kind,locations:current.locations,title:current.title,rawInput:current.rawInput}};
      if(!active.tools.has(id)){active.tools.add(id);emit({type:'chat/toolCallStart',turnId,toolCallId:id,toolName:current.name??current.kind??'tool',displayName:current.title??'Tool',_meta:metadata} as StateAction);}
      const raw=current.rawInput===undefined?undefined:JSON.stringify(current.rawInput);
      // ACP rawInput is a replacement object, never an appendable JSON fragment.
      if(['in_progress','completed','failed'].includes(current.status)||active.permissions.has(id))emit({type:'chat/toolCallReady',turnId,toolCallId:id,invocationMessage:current.title??'Running tool',toolInput:raw,...(active.permissions.has(id)?{}:{confirmed:'not-needed'}),_meta:metadata} as StateAction);
      else emit({type:'chat/toolCallDelta',turnId,toolCallId:id,_meta:metadata} as StateAction);
      if(update.status==='completed'||update.status==='failed')emit({type:'chat/toolCallComplete',turnId,toolCallId:id,result:{success:update.status==='completed',pastTenseMessage:current.title??'Tool finished',content:await this.toolContent(current.content??[]),structuredContent:current.rawOutput===undefined?undefined:{output:current.rawOutput}}} as StateAction);
      else if(update.content!==undefined)emit({type:'chat/toolCallContentChanged',turnId,toolCallId:id,content:await this.toolContent(current.content??[])} as StateAction);
    } else if(update.sessionUpdate==='plan') {
      emit({type:'chat/responsePart',turnId,part:{kind:'systemNotification',content:update.entries.map((e:any)=>`${e.status}: ${e.content}`).join('\n')}} as StateAction);
    }
  }
  private async permission(uri:string,params:RequestPermissionRequest):Promise<RequestPermissionResponse> {
    const active=this.active.get(uri);if(!active?.busy||!active.turnId)return {outcome:{outcome:'cancelled'}};
    const channel=chatURI(uri),turnId=active.turnId,id=params.toolCall.toolCallId;
    if(active.permissions.has(id))throw new Error('Duplicate pending permission identity');
    if(!active.tools.has(id)){active.tools.add(id);this.emit(channel,{type:'chat/toolCallStart',turnId,toolCallId:id,toolName:params.toolCall.kind??'tool',displayName:params.toolCall.title??'Tool'} as StateAction);}
    const result=new Promise<RequestPermissionResponse>(resolve=>active.permissions.set(id,{params,resolve}));
    this.emit(channel,{type:'chat/toolCallReady',turnId,toolCallId:id,invocationMessage:params.toolCall.title??'Agent requests permission',toolInput:params.toolCall.rawInput===undefined?(active.toolStates?.get(id)?.rawInput===undefined?undefined:JSON.stringify(active.toolStates.get(id)!.rawInput)):JSON.stringify(params.toolCall.rawInput),options:params.options.map(o=>({id:o.optionId,label:o.name,kind:o.kind.startsWith('allow_')?'approve':'deny'}))} as StateAction);
    const tool=this.getRecord(uri)!.chat.activeTurn?.responseParts.find((p:any)=>p.kind==='toolCall'&&p.toolCall.toolCallId===id) as any;
    if(tool)this.emit(uri,{type:'session/inputNeededSet',request:{id,chat:channel,kind:'toolConfirmation',turnId,toolCall:tool.toolCall}} as StateAction);
    return result;
  }
  private notifyAgentStopped(session:string,active:Active,reason:AgentStopped['reason'],details:{exitCode?:number;signal?:string}={}) {
    if(active.stopNotified)return;active.stopNotified=true;
    if(!this.config.agentStopped)return;
    const event=Object.freeze({session,nativeSessionId:active.agent.nativeId,engineId:active.agent.engine.id,workingDirectory:active.agent.cwd,reason,...details});
    const pending=Promise.resolve().then(()=>this.config.agentStopped!(event)).catch(()=>{this.stoppedCallbackFailures++;}).finally(()=>this.stoppedCallbacks.delete(pending));this.stoppedCallbacks.add(pending);active.stopCallback=pending;
  }
  private async retireIdle(force=false) {
    for(const [uri,active] of this.active) {
      if(active.busy||active.controlDepth||this.starting.has(uri)||this.resourceLocks.has(uri)||(!force&&Date.now()-active.lastUsed<(this.config.idleAgentMs??60000)))continue;
      if(!active.agent.initialized?.agentCapabilities?.sessionCapabilities?.resume&&!active.agent.initialized?.agentCapabilities?.loadSession)continue;
      const retired=await this.withLock(uri,async()=>{
        if(this.active.get(uri)!==active||active.busy||active.controlDepth||this.starting.has(uri))return false;
        active.controlDepth=(active.controlDepth??0)+1;
        try {
          if(!await active.agent.retireIfIdle())return false;
          active.retireReason='idle-retired';await active.agent.retire();await active.stopCallback;this.active.delete(uri);return true;
        }finally{active.controlDepth--;}
      });
      if(force&&retired)return;
    }
  }
  diagnostics(){return {agentStoppedPending:this.stoppedCallbacks.size,agentStoppedFailures:this.stoppedCallbackFailures,clients:this.peers.size,activeAgents:this.active.size,startingAgents:this.starting.size,subscriptions:[...this.peers].reduce((n,p)=>n+p.subscriptions.size,0),serverSeq:this.store.seq};}
  async inspectSession(session:string) {
    const record=await this.record(session),revisions=this.store.revisions(record.uri);
    const engine=this.config.engines.find(e=>e.id===record.engineId);
    const configurationHash=createHash('sha256').update(JSON.stringify({engine,values:record.state.config?.values,revision:revisions.configurationRevision})).digest('hex');
    return {session:record.uri,uri:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory,historyHome:record.workingDirectory,executionDirectory:record.executionDirectory??record.workingDirectory,nativeLocationRevision:record.nativeLocationRevision??0,relocationFence:this.relocationFence(record.uri),title:record.summary.title,activeTurnId:record.chat.activeTurn?.id,status:record.chat.activeTurn?'working':'idle',...revisions,configurationHash};
  }
  /** Hold the selected session mapping through bounded trusted I/O. No filesystem snapshot is implied. */
  async withSessionWorkspace<T>(session:string,expected:SessionWorkspaceExpectation,capture:(workspace:Readonly<SessionWorkspace>)=>Promise<T>):Promise<T> {
    if(!expected||typeof expected!=='object'||typeof capture!=='function'||(expected.expectedExecutionRevision!==undefined&&(!Number.isSafeInteger(expected.expectedExecutionRevision)||expected.expectedExecutionRevision<0))||(expected.expectedDirectory!==undefined&&(typeof expected.expectedDirectory!=='string'||!isAbsolute(expected.expectedDirectory))))throw new RpcFault(-32602,'An optional execution revision and absolute directory are required');
    const selected=await this.record(session);
    return this.withLock(selected.uri,async()=>{
      const record=await this.record(selected.uri);
      if(this.relocationFence(record.uri))throw new RpcFault(-32011,'Session relocation is fenced; workspace capture was not started',{executed:false});
      const executionDirectory=await this.workspace(pathToFileURL(record.executionDirectory??record.workingDirectory).href),executionRevision=this.store.revisions(record.uri).executionRevision;
      if(expected.expectedExecutionRevision!==undefined&&expected.expectedExecutionRevision!==executionRevision)throw new RpcFault(-32011,'Execution revision changed; workspace capture was not started',{executed:false});
      if(expected.expectedDirectory!==undefined&&await this.workspace(pathToFileURL(expected.expectedDirectory).href)!==executionDirectory)throw new RpcFault(-32011,'Execution directory changed; workspace capture was not started',{executed:false});
      // The caller owns byte/time limits and may read files, but must not reenter host mutations.
      // Keep the mutex until its promise settles: a timeout must not free mapping while I/O runs.
      return capture(Object.freeze({session:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,historyHome:record.workingDirectory,executionDirectory,executionRevision}));
    });
  }
  private relocationFence(session:string):Json|undefined {
    const row=this.store.db.prepare("SELECT command_id,source,target,status FROM relocations WHERE uri=? AND status IN ('admitted','unknown') ORDER BY rowid DESC LIMIT 1").get(session);
    return row?{commandId:row.command_id,source:row.source,target:row.target,status:row.status}:undefined;
  }
  private async inspectNativeLocation(record:SessionRecord,reconcileCommand?:string):Promise<Json> {
    if(!record.nativeSessionId)throw new RpcFault(-32008,'Native identity is unavailable');
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive native read capacity reached');
    const engine=this.config.engines.find(e=>e.id===record.engineId);if(!engine)throw new RpcFault(-32008,'Native engine is unavailable');
    this.passiveReads++;const agent=new AcpProcess(engine,record.workingDirectory,{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}})});
    try {
      const initialized=await agent.initialize();
      if((initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.relocation?.version!==1)throw new RpcFault(-32601,'Native relocation was not negotiated');
      return await agent.client.extMethod(reconcileCommand?'_amplifier/relocation/reconcile':'_amplifier/relocation',{sessionId:record.nativeSessionId,historyCwd:record.workingDirectory,...(reconcileCommand?{commandId:reconcileCommand}:{})});
    }finally{this.passiveReads--;await agent.retire();}
  }
  /** Indexed references only; a catalog without a directory guard cannot prove absence. */
  async directoryInUse(path:string):Promise<{inUse:boolean;sessions:Array<{session:string;reason:string}>;pending:boolean;truncated?:boolean}> {
    if(!isAbsolute(path))throw new RpcFault(-32602,'An absolute directory is required');
    let target:string;try{target=await realpath(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;target=join(await realpath(dirname(path)),basename(path));}
    const lower=target.endsWith('/')?target:target+'/',upper=lower+'\uffff',sessions:Array<{session:string;reason:string}>=[];
    for(const row of this.store.db.prepare('SELECT uri FROM sessions WHERE execution_cwd=? OR execution_cwd>=? AND execution_cwd<? OR cwd=? OR cwd>=? AND cwd<? LIMIT 101').all(target,lower,upper,target,lower,upper))sessions.push({session:String(row.uri),reason:'execution-or-history-directory'});
    const pending=this.store.db.prepare("SELECT uri FROM relocations WHERE status IN ('admitted','unknown') AND (source=? OR source>=? AND source<? OR target=? OR target>=? AND target<?) LIMIT 101").all(target,lower,upper,target,lower,upper);
    for(const row of pending)sessions.push({session:String(row.uri),reason:'unresolved-relocation'});
    // Ancestor equality lookups remain indexed and bounded by path depth.
    for(let ancestor=dirname(target);ancestor!==target;){for(const row of this.store.db.prepare('SELECT uri FROM sessions WHERE execution_cwd=? OR cwd=? LIMIT 101').all(ancestor,ancestor))sessions.push({session:String(row.uri),reason:'ancestor-execution-or-history-directory'});for(const row of this.store.db.prepare("SELECT uri FROM relocations WHERE status IN ('admitted','unknown') AND (source=? OR target=?) LIMIT 101").all(ancestor,ancestor)){pending.push(row);sessions.push({session:String(row.uri),reason:'ancestor-unresolved-relocation'});}const next=dirname(ancestor);if(next===ancestor)break;ancestor=next;}
    if(this.config.catalog){if(!this.config.catalog.directoryInUse)sessions.push({session:'',reason:'catalog-directory-authority-unavailable'});else{const result=await this.config.catalog.directoryInUse(target);if(result.inUse)sessions.push(...(result.sessions?.length?result.sessions:[{session:'',reason:'catalog-reference'}]));const freshness=result.freshness,age=Date.now()-Date.parse(freshness?.completedAt??'');if(result.coverage!=='indexed-native-history'||freshness?.phase!=='complete'||freshness.issues!==0||!Number.isFinite(age)||age<0||age>600000)sessions.push({session:'',reason:'catalog-coverage-incomplete-or-stale'});}}
    return {inUse:sessions.length>0,sessions:sessions.slice(0,100),pending:pending.length>0,...(sessions.length>100?{truncated:true}:{})};
  }
  /** The callback may remove Git/filesystem state only; it must not reenter host mutations. */
  async withDirectoryGuard<T>(path:string,remove:()=>Promise<T>):Promise<T> {
    const target=await this.workspace(pathToFileURL(path).href);
    return this.withLock('@directory-reservations',async()=>{const result=await this.directoryInUse(target);if(result.inUse)throw new RpcFault(-32011,'Directory is referenced by a session, history or unresolved transition',result);return remove();});
  }
  async relocateSession(session:string,input:{commandId:string;target:string;expectedExecutionRevision:number;reconciles?:string;evidence?:unknown}) {
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||typeof input.target!=='string'||!isAbsolute(input.target)||!Number.isSafeInteger(input.expectedExecutionRevision)||input.expectedExecutionRevision<0||Buffer.byteLength(JSON.stringify(input.evidence??null))>65536)throw new RpcFault(-32602,'Bounded relocation command, target and expected revision required');
    let record:SessionRecord,target:string;
    try{record=await this.record(session);target=await this.workspace(pathToFileURL(input.target).href);}catch(error){return {applied:false,executed:false,reason:(error as Error).message};}
    return this.withLock(record.uri,async()=>{
      let admitted=false;
      try {
      const prior=this.store.db.prepare('SELECT uri,payload,status FROM relocations WHERE command_id=?').get(input.commandId);
      if(prior){const value=JSON.parse(String(prior.payload));if(prior.uri!==record.uri||value.target!==target||value.expectedExecutionRevision!==input.expectedExecutionRevision||value.reconciles!==input.reconciles)throw new RpcFault(-32011,'Relocation command reused with different content');if(prior.status==='applied')return value.result;if(prior.status==='rejected')return {applied:false,executed:false,reason:'Native relocation previously refused'};throw new RpcFault(-32011,'Relocation outcome is unresolved; the original operation must not be repeated',{receipt:input.commandId,outcome:'unknown',executed:true});}
      const latest=this.getRecord(record.uri)!,fence=this.relocationFence(record.uri),revision=this.store.revisions(record.uri).executionRevision;
      if(revision!==input.expectedExecutionRevision)return {applied:false,executed:false,reason:'Execution revision changed'};
      if(fence&&!input.reconciles)return {applied:false,executed:false,reason:'A relocation is unresolved; inspect and explicitly reconcile'};
      if(input.reconciles&&fence?.commandId!==input.reconciles)return {applied:false,executed:false,reason:'Reconciliation does not identify the current fence'};
      if(latest.chat.activeTurn||this.active.get(record.uri)?.busy||this.active.get(record.uri)?.controlDepth||this.store.unknown(latest.chat.resource))return {applied:false,executed:false,reason:'Execution must be conclusively idle before relocation'};
      // A reconcile admission can itself lose its reply. Follow only stored receipt links, never replay any effect.
      const reconciledIds:string[]=[];let nativeCommand=input.reconciles;
      while(nativeCommand){if(reconciledIds.includes(nativeCommand)||reconciledIds.length>=64)throw new RpcFault(-32011,'Invalid reconciliation chain');reconciledIds.push(nativeCommand);const ancestor=this.store.db.prepare('SELECT uri,payload FROM relocations WHERE command_id=?').get(nativeCommand);if(!ancestor||ancestor.uri!==record.uri)throw new RpcFault(-32011,'Reconciliation identity does not belong to this session');const parent=JSON.parse(String(ancestor.payload)).reconciles;if(!parent)break;nativeCommand=parent;}
      const native=await this.inspectNativeLocation(latest,nativeCommand);
      if(native.sessionId!==latest.nativeSessionId||native.historyCwd!==latest.workingDirectory||!Number.isSafeInteger(native.executionRevision))throw new RpcFault(-32000,'Native location identity or revision is invalid');
      if(input.reconciles){
        if(native.blocked||native.reconciled!==true||native.receipt?.commandId!==nativeCommand||native.receipt?.status!=='applied'||native.executionDirectory!==target)return {applied:false,executed:false,reason:'Native location evidence does not prove the requested outcome'};
      }else if(native.blocked||native.executionDirectory!==(latest.executionDirectory??latest.workingDirectory))return {applied:false,executed:false,reason:'Native execution location changed or is blocked; no relocation was repeated'};
      const active=input.reconciles?undefined:await this.ensureAgent(record.uri);
      const request={...input,target,source:latest.executionDirectory??latest.workingDirectory};
      await this.withLock('@directory-reservations',async()=>{
        await this.workspace(pathToFileURL(target).href);
        this.store.transaction(()=>{this.store.admission(record.uri,{kind:'session.relocate',...request},input.commandId,'host:relocation',this.store.extensionSequence('host:relocation'));this.store.db.prepare('INSERT INTO relocations VALUES(?,?,?,?,?,?)').run(input.commandId,record.uri,request.source,target,'admitted',JSON.stringify(request));});
      });
      admitted=true;this.store.finish(input.commandId,'dispatching');
      try {
        let result=native;
        if(active){active.controlDepth=(active.controlDepth??0)+1;try{result=await active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation:'session.relocate',args:{commandId:input.commandId,target,expectedExecutionRevision:native.executionRevision}});}finally{active.controlDepth--;}}
        if(result.applied===false){this.store.transaction(()=>{this.store.finish(input.commandId,'failed',String(result.reason??'Native relocation refused'));this.store.db.prepare("UPDATE relocations SET status='rejected' WHERE command_id=?").run(input.commandId);});return {applied:false,executed:false,reason:String(result.reason??'Native relocation refused')};}
        if((!input.reconciles&&result.applied!==true)||result.blocked||result.historyCwd!==latest.workingDirectory||result.executionDirectory!==target||!Number.isSafeInteger(result.executionRevision))throw new Error('Native relocation did not prove the requested committed location');
        if(active){active.retireReason='relocated';await active.agent.retire();this.active.delete(record.uri);}
        const current=this.getRecord(record.uri)!;current.executionDirectory=target;current.nativeLocationRevision=result.executionRevision;
        const outcome={applied:true,historyHome:current.workingDirectory,executionDirectory:target,executionRevision:revision+1,receipt:input.commandId};
        this.store.transaction(()=>{this.store.save(current);this.store.bump(record.uri,'execution');this.store.finish(input.commandId,'completed');this.store.db.prepare("UPDATE relocations SET status='applied',payload=? WHERE command_id=?").run(JSON.stringify({...request,result:outcome}),input.commandId);for(const ancestor of reconciledIds){this.store.db.prepare("UPDATE relocations SET status='applied',payload=json_set(payload,'$.result',json(?)) WHERE command_id=?").run(JSON.stringify({...outcome,receipt:ancestor}),ancestor);this.store.finish(ancestor,'completed','Native durable location proof was explicitly reconciled');}});
        this.acpMetadata(record.uri,{executionLocation:{historyHome:current.workingDirectory,executionDirectory:target,executionRevision:revision+1}});
        return outcome;
      }catch(error){this.store.transaction(()=>{this.store.finish(input.commandId,'unknown',(error as Error).message);this.store.db.prepare("UPDATE relocations SET status='unknown' WHERE command_id=?").run(input.commandId);});if(active){active.retireReason='relocation-unknown';await active.agent.retire();this.active.delete(record.uri);}throw new RpcFault(-32011,(error as Error).message,{receipt:input.commandId,outcome:'unknown',executed:true});}
      }catch(error){if(admitted||(error instanceof RpcFault&&(error.data as Json)?.outcome==='unknown'))throw error;return {applied:false,executed:false,reason:(error as Error).message};}
    });
  }
  /** Advertised tools only: no client drafts, DOM, editing buffers or rendered state. */
  async listClientTools(session:string) {const record=await this.record(session);return structuredClone(record.state.activeClients);}
  /** Shared admission path for authenticated clients and trusted native-host callbacks. */
  async invokeCapability(request:Json,actor:{actorId:string;clientId?:string;origin?:'agent'|'ui'}) {
    const provider=this.config.capabilities;
    if(!provider||request.version!==1||!Object.values(provider.manifest.actions).some(action=>action.topic===request.topic&&action.operation===request.operation&&action.method==='x-amplifier/capabilityAction'))throw new RpcFault(-32601,'Capability action/version not advertised');
    if(typeof request.commandId!=='string'||!request.commandId||request.commandId.length>512||typeof actor.actorId!=='string'||!actor.actorId)throw new RpcFault(-32602,'Durable command and actor identities required');
    const session=request.channel===ROOT?undefined:await this.record(request.channel);
    this.store.transaction(()=>this.store.admission(request.channel,request,request.commandId,actor.actorId,this.store.extensionSequence(actor.actorId)));
    this.store.finish(request.commandId,'dispatching');
    try {const result=await provider.action(request,{clientId:actor.clientId??'',origin:actor.origin??'ui',session});this.store.finish(request.commandId,result.accepted?'completed':'failed');for(const topic of result.invalidate??[])this.invalidateCapability(topic,request.channel===ROOT?'host':request.channel);for(const update of result.updates??[])this.invalidateCapability(update.topic,update.scope);return result;}
    catch(error){this.store.finish(request.commandId,'unknown',(error as Error).message);throw error;}
  }
  private finishClientTool(id:string,result:Json) {
    const pending=this.clientTools.get(id);if(!pending)return;this.clientTools.delete(id);clearTimeout(pending.timer);
    this.emit(pending.session,{type:'session/inputNeededRemoved',id} as StateAction);pending.resolve(result);
  }
  private removeActiveClient(uri:string,clientId?:string) {
    if(!clientId)return;const record=this.getRecord(uri);if(!record||record.uri!==uri)return;
    if(record.state.activeClients.some(client=>client.clientId===clientId))this.emit(uri,{type:'session/activeClientRemoved',clientId} as StateAction);
    for(const [id,pending] of this.clientTools)if(pending.clientId===clientId&&pending.session===uri){const result={success:false,pastTenseMessage:'Client disconnected before returning its result',error:{code:'CLIENT_OUTCOME_UNKNOWN',message:'Do not replay this client action; its effects may already have occurred.'}};this.emit(pending.chat,{type:'chat/toolCallComplete',turnId:pending.turnId,toolCallId:id,result} as StateAction);this.finishClientTool(id,result);}
  }
  /** Explicitly targeted AHP client tools; never enumerates or mirrors private UI state. */
  async invokeClientTool(session:string,targetClientId:string,toolName:string,args:Json):Promise<Json> {
    const record=await this.record(session),active=this.active.get(record.uri);
    if(!active?.busy||!active.turnId)throw new RpcFault(-32009,'Client tool invocation requires an admitted active native turn');
    const client=record.state.activeClients.find(client=>client.clientId===targetClientId);
    if(!client?.tools.some(tool=>tool.name===toolName)||![...this.peers].some(peer=>peer.clientId===targetClientId&&peer.subscriptions.has(session)))throw new RpcFault(-32009,'Target client has not registered this tool');
    if(this.clientTools.size>=32||Buffer.byteLength(JSON.stringify(args))>65536)throw new RpcFault(-32000,'Client tool capacity exceeded');
    const id=randomUUID(),chat=record.chat.resource,turnId=active.turnId;
    const result=new Promise<Json>(resolve=>{const timer=setTimeout(()=>{const failure={success:false,pastTenseMessage:'Client tool result timed out',error:{code:'CLIENT_OUTCOME_UNKNOWN',message:'No automatic replay is permitted'}};this.emit(chat,{type:'chat/toolCallComplete',turnId,toolCallId:id,result:failure} as StateAction);this.finishClientTool(id,failure);},120000);timer.unref();this.clientTools.set(id,{session,chat,turnId,clientId:targetClientId,resolve,timer});});
    this.emit(chat,{type:'chat/toolCallStart',turnId,toolCallId:id,toolName,displayName:client.tools.find(tool=>tool.name===toolName)?.title??toolName,contributor:{kind:'client',clientId:targetClientId}} as StateAction);
    this.emit(chat,{type:'chat/toolCallReady',turnId,toolCallId:id,invocationMessage:`Run ${toolName} in the selected client`,toolInput:JSON.stringify(args),confirmed:'not-needed'} as StateAction);
    const tool=(this.getRecord(session)!.chat.activeTurn!.responseParts.find((part:any)=>part.kind==='toolCall'&&part.toolCall.toolCallId===id) as any).toolCall;
    this.emit(session,{type:'session/inputNeededSet',request:{id,chat,kind:'toolClientExecution',turnId,toolCall:tool,clientId:targetClientId}} as StateAction);
    return result;
  }
  /** Used by capability owners; all native controls retain the ACP execution boundary. */
  async nativeControlExisting(session:string,operation:string,args:Json):Promise<Json> {return this.nativeControl(session,operation,args,{requireExisting:true});}
  async nativeControl(session:string,operation:string,args:Json,options:{requireExisting?:boolean}={}):Promise<Json> {
    session=(await this.record(session)).uri;
    if(this.relocationFence(session))throw new RpcFault(-32011,'Session relocation is fenced; no runtime control was dispatched');
    if(operation==='session.relocate')throw new RpcFault(-32602,'Relocation requires relocateSession admission');
    if(operation==='schedule.submit')throw new RpcFault(-32602,'Scheduled execution requires submitScheduled admission');
    const execute=async()=>{
      const active=options.requireExisting?this.active.get(session):await this.ensureAgent(session);
      if(!active||active.agent.closed||!active.agent.nativeId)throw new RpcFault(-32008,'No existing owned native runtime; no process was started');
      if((active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.version!==1)throw new RpcFault(-32601,'Native control extension not negotiated');
      if(['configuration.apply','configuration.toggle','bundle.switch','provider.select','provider.reset','mode.set','mode.clear','budget.set','capacity.set','capacity.quota'].includes(operation))this.store.bump(session,'configuration');
      if(['worker.stop','operations.cancel'].includes(operation))this.store.bump(session,'interruption');
      active.controlDepth=(active.controlDepth??0)+1;
      try{return await active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation,args,...(options.requireExisting?{_meta:{'amplifier.dev/native':{requireExisting:true}}}:{})});}finally{active.controlDepth--;}
    };
    return ['configuration.apply','configuration.toggle','bundle.switch','provider.select','provider.reset','mode.set','mode.clear','budget.set','capacity.set','capacity.quota','worker.stop','operations.cancel'].includes(operation)?this.withLock(session,execute):execute();
  }
  async close() {
    clearInterval(this.retireTimer);
    for(const observer of this.observers){observer.closed=true;observer.queue=[];}this.observers.clear();
    for(const peer of this.peers)peer.socket.terminate();
    const agents=[...this.active.values()];await Promise.all(agents.map(active=>{active.retireReason='host-shutdown';return active.agent.retire();}));await Promise.all([...this.stoppedCallbacks]);await Promise.allSettled(agents.map(active=>active.run));this.active.clear();
    await new Promise<void>(resolve=>this.ws.close(()=>resolve()));await new Promise<void>(resolve=>this.http.close(()=>resolve()));
    await this.config.catalog?.close?.();this.store.close();
  }
}

export async function createHost(config:HostConfig) {return new AmplifierHost(config).listen();}
