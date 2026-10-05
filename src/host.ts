import {LibraryIndex,type LibraryQuery,type LibraryRead,type HostObservation,type LiveFact} from './library-index.js';
import {PUBLIC_MESSAGE_META,capturePublicMessage,supportsPublicOriginal,nativeLocator,persistedPublicRow,cardOccurrence,sameLocator,sameCard,samePublicMessage,qualifiedAccessUri,type PublicMessageV1,type PersistedPublicRow,type NativeLocator,type PublicCard,type PublicOriginalResources,type RetainOriginalAttachmentV2,type VerifiedOriginalAttachmentV2} from './public-original.js';
import {SESSION_METADATA_KEY,type SessionTitleSnapshot,type SessionTitleCommitContext,type SessionTitleCommitResult} from './session-metadata.js';
import {nativeFailedInput} from './input-outcome.js';
import {ConversationPresentation,type PresentationMetadata} from './presentation.js';
import type {ConversationPresentationConfig,PresentationActor,PresentationPrepare,PresentationApply,PresentationRebuild,PresentationIdentity,VisibilityProjectionRequest,VisibilityProjectionReceipt} from './presentation-types.js';
import {ManagedFilesJournal,type ManagedFilesProtection,type ManagedFilesApply,type ManagedFilesActor} from './managed-files.js';
import {ManagedAllocations,managedHash,type ManagedSessionCreate,type ManagedLocation} from './managed.js';
import {Retention,type RetentionProtection,type RetentionPreviewRequest,type RetentionApplyRequest} from './retention.js';
import {QuiescenceGate,type QuiescenceConfig,type QuiescencePurpose,type QuiescenceOutcome,type ServiceStopRequest,type ServiceStopReleaseRequest,type AdmissionAbortRequest} from './quiescence.js';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, relative, join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatReducer, sessionReducer, terminalReducer, SessionLifecycle, SessionStatus, type ActionEnvelope, type StateAction, type ChatState, type SessionSummary, type Snapshot, type Message, type SessionState, type Turn, type TerminalState } from '@microsoft/agent-host-protocol';
import type { ContentBlock, SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { Store, type SessionRecord } from './store.js';
import { AcpProcess, type EngineConfig, type AgentHandlers } from './acp.js';
import { mergeHistoryTurns, turnIdentityHash } from './history.js';
import { recallRows, RECALL_LIMITS, type RecallSource } from './recall.js';

type Json = Record<string,any>;
export interface CatalogRecord {uri:string;engineId:string;nativeSessionId?:string;workingDirectory:string;parentUri?:string;title:string;createdAt:string;modifiedAt:string;status?:number|string;kind?:string;availability?:string;workspaceAvailability?:string;nativeDeleted?:boolean;productHidden?:boolean;storagePath?:string;isArchived?:boolean;location?:ManagedLocation;hostObservation?:HostObservation;hostObservationOnly?:true;activity?:{kind:string;runtime:string;effect:string;evidence:string;observedAt?:string};}
export interface CatalogFamilyDiscovery {version:1;scope:'selected-native-project-namespaces';phase:'complete'|'refused';issues:string[];maxEntries:number;metadataByteLimit:number;metadataFileLimit:number;indexRevision:string;verificationToken:string;inventoryHash:string;entriesExamined:number;metadataReads:number;metadataBytesAdmitted:number;namespaces:string[];completedAt:string;externalWriterCoverage:false;transcriptBodiesRead:false;nativeOwnershipVerified:false;}
export interface CatalogFamily {parentUri:string;rootKnown:boolean;root?:CatalogRecord;items:CatalogRecord[];completeIndexedCoverage:boolean;truncated:boolean;issues:string[];excludedKinds:string[];revision:string;coverage:string;externalWriterCoverage:false;freshness:{phase?:string;completedAt?:string;issues?:number};familyDiscovery?:CatalogFamilyDiscovery;}
export interface Catalog {
  supportsLibraryQuery?:()=>Promise<boolean>;
  libraryQuery?:(params:LibraryRead)=>Promise<{version:1;items:CatalogRecord[];nextCursor?:string;observationFreshness?:unknown;[key:string]:unknown}>;
  list(params:{connectionId:string;limit:number;cursor?:string;workingDirectory?:string;search?:string;parentUri?:string;allowedWorkspaceRoots?:string[];allowedManagedRoots?:string[];includeArchive?:boolean;archive?:'active'|'all'|'archived'}):Promise<{items:CatalogRecord[];nextCursor?:string;freshness?:unknown}>;
  projectSessionVisibility?:(params:VisibilityProjectionRequest)=>Promise<VisibilityProjectionReceipt>;
  sessionVisibilityProjectionStatus?:(params:{source:string})=>Promise<{source:string;revision:number}>;
  sessionVisibilityProjectionReceipt?:(params:{source:string;commandId:string})=>Promise<VisibilityProjectionReceipt|null>;
  status?:()=>Promise<{phase?:string;issues?:number}>;
  projectSessionArchives?(params:{items:Array<{uri:string;isArchived:boolean}>}):Promise<unknown>;
  get(uri:string):Promise<CatalogRecord|undefined>;
  upsert(record:CatalogRecord):Promise<unknown>;
  claimNative?(params:{record:CatalogRecord;commandId:string;evidence:'verified-native-import'}):Promise<CatalogRecord>;
  hint?(sessionDirectory:string,context?:{attemptId:string}):Promise<unknown>;
  directoryInUse?(path:string):Promise<{inUse:boolean;sessions?:Array<{session:string;reason:string}>;freshness?:{phase?:string;completedAt?:string;issues?:number};coverage?:string}>;
  setVisibility?(params:{uri:string;nativeSessionId:string;workingDirectory:string;deleted:boolean;commandId:string;evidence:"native-completed-receipt"}):Promise<unknown>;
  retentionCandidates?(params:RetentionPreviewRequest&{allowedWorkspaceRoots:string[]}):Promise<Json>;
  descendants?(params:{parentUri:string;limit:number}):Promise<CatalogFamily>;
  reconcileFamily?(params:{parentUri:string;limit:number;maxEntries:number}):Promise<CatalogFamily>;
  verifyFamily?(params:{parentUri:string;verificationToken:string}):Promise<{version:1;scope:string;valid:boolean;parentUri:string;indexRevision?:string;inventoryHash?:string;issues:string[];completedAt:string;externalWriterCoverage:false;nativeOwnershipVerified:false;transcriptBodiesRead:false}>;
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
export interface AdoptImport {commandId:string;session:string;engineId:string;workingDirectory:string;importCommandId:string;sourceSha256:string;previewHash:string;}
export interface TransferCommand {commandId:string;transferId:string;}
export interface BeginTransfer extends TransferCommand {destination:string;expectedExecutionRevision:number;}
/** AHP identity/source originate in the authenticated signed portability envelope. */
export interface AdoptTransfer extends TransferCommand {session:string;engineId:string;nativeSessionId:string;historyHome:string;executionDirectory:string;source:string;destination:string;releaseHash:string;title?:string;}
export type PendingQueueAction=Extract<StateAction,{type:'chat/pendingMessageSet'|'chat/pendingMessageRemoved'|'chat/queuedMessagesReordered'}>;
export interface TurnSettled {session:string;commandId:string;status:'completed'|'cancelled'|'failed'|'unknown';inputOrigin:string;}
export interface AgentStopped {session:string;nativeSessionId?:string;engineId:string;workingDirectory:string;reason:'runtime-closed'|'process-closed'|'idle-retired'|'host-shutdown'|'relocated'|'relocation-unknown'|'startup-failed'|'session-lifecycle'|'quiesced';exitCode?:number;signal?:string;}
export interface HostConfig {
  stateDirectory:string; engines:EngineConfig[]; allowedWorkspaceRoots:string[];
  host?:string;port?:number;allowedOrigins?:string[];allowedHosts?:string[];bearerToken?:string;
  maxActiveAgents?:number;maxClients?:number;maxSubscriptions?:number;replayLimit?:number;
  maxPeerBufferedBytes?:number;maxInFlightRequests?:number;idleAgentMs?:number;
  maxActiveProjectionBytes?:number;steeringOutcomeTimeoutMs?:number;
  /** Resolve committed attachment references only during new execution, never history reads. */
  resolvePromptAttachment?:(context:{session:string;engineId:string;nativeSessionId?:string;workingDirectory:string},attachment:NonNullable<Message['attachments']>[number])=>Promise<ContentBlock[]|undefined>;
  /** Resources-owned target access, distinct from unchanged public originals. */
  publicOriginalResources?:PublicOriginalResources;
  resourceProviders?:Array<{scheme:string;read?:(params:Json,context:{clientId:string})=>Promise<Json>;resolve?:(params:Json,context:{clientId:string})=>Promise<Json>;list?:(params:Json,context:{clientId:string})=>Promise<Json>;write?:(params:Json,context:{clientId:string})=>Promise<Json>}>;
  catalog?:Catalog;
  retentionProtection?:RetentionProtection;
  conversationPresentation?:ConversationPresentationConfig;
  /** Existing directory used for new-client workspace hints; must be within allowed roots. */
  defaultWorkingDirectory?:string;
  /** Private allocation owner; never grants workspace browsing or arbitrary cwd access. */
  managedSessionRoot?:string;
  managedFilesProtection?:ManagedFilesProtection;
  quiescence?:QuiescenceConfig;
  /** SHA256 of this TransferNode's Ed25519 raw public key; never caller-selected. */
  transferIdentity?:string;
  /** Optional bounded handshake metadata, resolved by the authenticated distribution. */
  clientMetadata?:(context:{clientId:string;metadata:Json})=>Promise<Json|undefined>;
  capabilities?: {
    manifest:{version:1;topics:Record<string,{uri:string;version:number;watch?:boolean;scope?:'context'|'host'}>;actions:Record<string,{topic:string;operation:string;method:string}>};
    /** Trusted exact manifest action classification; no ordinary mutation rights are inherited. */
    quiescenceAccess?:Record<string,'read'|'reconcile'>;
    read:(request:{uri:string;topic:string;scope:string;clientId:string})=>Promise<{topic:string;scope:string;revision:number;data:unknown}>;
    action:(request:Json,context:{actorId:string;clientId:string;origin:'agent'|'ui';session?:SessionRecord})=>Promise<{accepted:boolean;updates?:Array<{topic:string;scope:string;revision:number;data:unknown}>;invalidate?:string[]}>;
  };
  /** Scoped host capabilities receive trusted native identity and execution workspace. */
  nativeHostRequest?:(context:{session:string;nativeSessionId:string;workingDirectory:string},params:Json)=>Promise<Json>;
  nativeHostCapabilities?:Json;
  /** Actual runtime/process loss, never inferred from a completed prompt. Idempotent owner callback. */
  agentStopped?:(event:Readonly<AgentStopped>)=>Promise<void>;
  /** Best-effort bounded completion signal, after durable settlement and session lock release. No startup replay. */
  turnSettled?:(event:Readonly<TurnSettled>)=>Promise<void>;
  nativeEvent?:(context:{session:string;nativeSessionId:string;workingDirectory:string},params:Json)=>Promise<void>;
}
interface Peer {socket:WebSocket;clientId?:string;connectionId:string;handshakeQueued:boolean;initialized:boolean;ready:boolean;buffer:Json[];bufferBytes:number;cuts:Map<string,number>;replayCut?:number;lastClientSeq:number;seenClientSeq:Set<number>;subscriptions:Set<string>;pending:number;queue:Promise<unknown>;channels:Map<string,Promise<unknown>>;cursors:Map<string,Json>;}
interface SettledInput {requestSignature?:string;operation:'schedule.submit'|'question.submit'|'observation.submit'|'history.revise';args:Json;expected?:{interruptionRevision:number;executionRevision:number;configurationHash:string};}
interface Active {retirementCommandId?:string;finishing?:boolean;publicOriginal?:PublicMessageV1;historyRevision?:{args:Json;prefix:{turns:Turn[];nextCursor?:string;revision:string;diagnostics:unknown[]};confirmed:boolean};pendingTurn?:{action:Extract<StateAction,{type:'chat/turnStarted'}>;origin:ActionEnvelope['origin']};observationAdmission?:Json;generationId?:string;steeringRuns?:Set<Promise<void>>;observationPending?:number;observationBytes?:number;stopCallback?:Promise<void>;stopNotified?:boolean;retireReason?:AgentStopped['reason'];agent:AcpProcess;busy:boolean;lastUsed:number;useOrder?:number;interested?:boolean;uninterestedSince?:number;projectionBytes?:number;cancel?:{action:StateAction;origin:ActionEnvelope['origin']};updates?:Promise<void>;updateCount?:number;updateBytes?:number;controlDepth?:number;pendingHints?:string[];turnId?:string;started?:number;textPart?:string;textMessageId?:string;reasoningPart?:string;run?:Promise<void>;tools:Set<string>;toolStates?:Map<string,Json>;permissions:Map<string,{params:RequestPermissionRequest;resolve:(r:RequestPermissionResponse)=>void}>;}
class RpcFault extends Error {constructor(readonly code:number,message:string,readonly data?:unknown){super(message);}}
const ROOT='ahp-root://';
const now=()=>new Date().toISOString();
const chatURI=(session:string)=>`ahp-chat:/${session.slice('ahp-session:/'.length)}`;
// Request completion order is independent of the server-sequenced action stream.
// Capability owners supply their own admission/CAS; a long wait must not hold
// the resource action queue or prevent the same client from checking its receipt.
const independentRequests=new Set(['x-amplifier/capabilityAction','x-commandReceipt','listSessions','resourceRead','resourceResolve','resourceList','ping']);
const bounded=(value:unknown,def:number,max:number)=>{if(value===undefined)return def;if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>max)throw new RpcFault(-32602,`Expected integer between 1 and ${max}`);return Number(value);};

export class AmplifierHost {
  readonly store:Store;
  private intake:QuiescenceGate;
  private presentation?:ConversationPresentation;
  private presentationSelections=new Set<string>();
  readonly http:Server;
  readonly ws:WebSocketServer;
  private peers=new Set<Peer>();
  private retention:Retention;
  private managed?:ManagedAllocations;
  private managedFiles:ManagedFilesJournal;
  private retentionChanging=new Set<string>();
  private active=new Map<string,Active>();
  private library?:LibraryIndex;
  private starting=new Map<string,Promise<Active>>();
  private resourceLocks=new Map<string,Promise<unknown>>();
  private cursors=new Map<string,{chat:string;before:number}>();
  private watches=new Map<string,{root:string;recursive:false;owner:Peer}>();
  private prefixCursors=new Map<string,{chat:string;beforeTurnId:string}>();
  private nativeCursors=new Map<string,{chat:string;cursor:string;revision:string}>();
  private loadedFloors=new Map<string,number>();
  private nativeWindows=new Map<string,{ids:string[];unbounded:boolean}>();
  private mixedCursors=new Map<string,{chat:string;count:number;first:string;hash:string;revision:string}>();
  private coordinationCursors=new Map<string,{modified:string;uri:string}>();
  private passiveReads=0;
  private recallCursors=new Map<string,{scope:string;cursor?:string;after?:{modified:string;uri:string}}>();
  private hotRecords=new Map<string,SessionRecord>();
  private clientTools=new Map<string,{session:string;chat:string;turnId:string;clientId:string;resolve:(result:Json)=>void;timer:ReturnType<typeof setTimeout>}>();
  private observers=new Set<{session:string;chat:string;queue:ActionEnvelope[];bytes:number;running:boolean;closed:boolean;listener:(event:ActionEnvelope)=>void|Promise<void>;onError?:(error:Error)=>void}>();
  private agentUseOrder=0;
  private admittedStarts=new Set<string>();
  private agentCapacity:Promise<unknown>=Promise.resolve();
  private retireTimer:ReturnType<typeof setInterval>;
  private steeringTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private stoppedCallbacks=new Set<Promise<void>>();
  private stoppedCallbackFailures=0;
  private settledCallbacks=new Set<Promise<void>>();
  private settledCallbackFailures=0;
  private settledCallbackDropped=0;
  private closing=false;
  private roots:string[]=[];
  private defaultWorkingDirectory='';
  url='';
  constructor(readonly config:HostConfig) {
    if(!config.engines.length||!config.allowedWorkspaceRoots.length)throw new Error('At least one engine and allowed workspace root are required');
    if(!isAbsolute(config.stateDirectory))throw new Error('Host stateDirectory must be absolute');
    if(config.defaultWorkingDirectory!==undefined&&!isAbsolute(config.defaultWorkingDirectory))throw new Error('defaultWorkingDirectory must be absolute');
    if(new Set(config.engines.map(e=>e.id)).size!==config.engines.length)throw new Error('Duplicate engine identifier');
    for(const engine of config.engines)if(engine.sessionMetadata&&(typeof engine.sessionMetadata.readTitle!=='function'||typeof engine.sessionMetadata.writeTitle!=='function'))throw new Error('Session metadata adapter requires passive readTitle and writeTitle ports');
    if(config.transferIdentity!==undefined&&!/^[a-f0-9]{64}$/.test(config.transferIdentity))throw new Error('transferIdentity must be an exact node public-key fingerprint');
    if(!['127.0.0.1','localhost','::1'].includes(config.host??'127.0.0.1')&&!config.bearerToken)throw new Error('Non-loopback listeners require authenticated gateway/bearer token');
    if(config.conversationPresentation){const c=config.catalog;if(!c?.projectSessionVisibility||!c.sessionVisibilityProjectionStatus||!c.sessionVisibilityProjectionReceipt||!c.status)throw Error('Conversation presentation requires the indexed visibility projection protocol');}
    this.store=new Store(config.stateDirectory,config.replayLimit);
    if(!config.conversationPresentation&&this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='presentation_state'").get()){this.store.close();throw Error('Retained conversation presentation authority requires its configured owner; it cannot be disabled to bypass a fence');}
    this.managedFiles=new ManagedFilesJournal(this.store.db);
    try{if(config.managedSessionRoot)this.managed=new ManagedAllocations(config.managedSessionRoot);}catch(error){this.store.close();throw error;}
    this.retention=new Retention(this.store.db,{list:async input=>{
      if(!config.catalog?.retentionCandidates)throw new RpcFault(-32601,'Catalog retention metadata is unavailable',{executed:false});
      if(input.workingDirectory)await this.workspace(pathToFileURL(input.workingDirectory).href);
      return this.withConversationCatalogRead(()=>config.catalog!.retentionCandidates!({...input,allowedWorkspaceRoots:this.roots,...(this.managed?{allowedManagedRoots:[this.managed.root]}:{})}));
    },protected:(row,protect)=>this.retentionProtected(row,protect),hide:(row,input)=>this.hideRetained(row,input)});
    for(const [name,access] of Object.entries(config.capabilities?.quiescenceAccess??{})){
      const action=config.capabilities?.manifest.actions[name];
      if(!action||!['read','reconcile'].includes(access)||Object.values(config.capabilities!.manifest.actions).filter(candidate=>candidate.topic===action.topic&&candidate.operation===action.operation).length!==1)throw Error('Quiescence action classification must identify one exact advertised action');
    }
    const coverage=config.quiescence?.coverage;
    const requirements=[...new Set(Object.entries(config.capabilities?.manifest.actions??{}).filter(([name])=>!config.capabilities?.quiescenceAccess?.[name]).map(([,action])=>coverage?.capabilities?.[action.topic]??'uncovered-capability:'+action.topic)),...(config.resourceProviders??[]).filter(provider=>provider.write).map(provider=>coverage?.resources?.[provider.scheme]??'uncovered-resource:'+provider.scheme),...(config.nativeHostRequest||config.nativeEvent?(coverage?.nativeHostOwners?.length?coverage.nativeHostOwners:[coverage?.nativeHost??'uncovered-native-host']):[])];
    this.intake=new QuiescenceGate(this.store.db,config.quiescence,requirements,()=>this.quiescenceWork(),()=>this.quiesceAgents(),()=>this.active.size>0);
    if(config.conversationPresentation){
      const catalog=config.catalog!;
      this.presentation=new ConversationPresentation(this.store.db,{
        metadata:session=>this.presentationMetadata(session),
        withSelection:(sessions,work)=>this.withPresentationSelection(sessions,work),validateSelection:sessions=>this.validatePresentationSelection(sessions),
        projectionStatus:source=>catalog.sessionVisibilityProjectionStatus!({source}),project:request=>catalog.projectSessionVisibility!(request),projectionReceipt:(source,commandId)=>catalog.sessionVisibilityProjectionReceipt!({source,commandId}),
        catalogGet:session=>catalog.get(session),catalogFreshness:()=>catalog.status!(),
        mappings:async after=>{
          const rows=this.store.db.prepare("SELECT uri,native_id,native_location_revision,json_extract(state,'$.lifecycle') AS lifecycle FROM sessions WHERE uri>? ORDER BY uri LIMIT 100").all(after??'');
          const items=[];
          for(const row of rows){
            const retained=this.presentation!.mapping(String(row.uri));
            if(retained){items.push(retained);continue;}
            // A reserved creation may have reached the engine without returning a native identity.
            // Its unknown receipt is not a mapping, absence proof, or permission to retry creation.
            const unboundCreation=row.native_id===null&&row.native_location_revision===0&&
              (row.lifecycle===SessionLifecycle.Creating||row.lifecycle===SessionLifecycle.Failed)&&
              this.store.db.prepare("SELECT 1 FROM receipts WHERE json_extract(payload,'$.status')='unknown' AND channel=? AND client_id='host:creation' LIMIT 1").get(row.uri);
            if(!unboundCreation)throw Error('Host mapping lacks retained canonical metadata; reconstruct its original authority first');
          }
          // Advance over the original bounded page, including any unbound reservations.
          return {items,...(rows.length===100?{nextCursor:String(rows.at(-1)!.uri)}:{})};
        },
        reconstructMetadata:config.conversationPresentation.reconstructMetadata,settleDiscovery:config.conversationPresentation.settleDiscovery,
        ...(catalog.hint?{hint:(path:string,context:{attemptId:string})=>catalog.hint!(path,context)}:{}),
        changed:rows=>{for(const row of rows){if(row.hidden)this.notify('root/sessionRemoved',{channel:ROOT,session:row.session});else {const record=this.getRecord(row.session);if(record&&!this.store.db.prepare('SELECT 1 FROM session_visibility WHERE uri=? AND deleted=1').get(row.session))this.notify('root/sessionAdded',{channel:ROOT,summary:record.summary});}}},
      });
    }
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
      this.emit(record.chat.resource,{type:'chat/error',turnId:record.chat.activeTurn!.id,duration:0,part:{kind:'error',error:{errorType:'HOST_OUTCOME_UNKNOWN',message:'Host interrupted; execution outcome is unknown. Native history must be reconciled before continuing.'}}} as StateAction);
    }
    for(const row of this.store.db.prepare("SELECT chat,id FROM queue_intents WHERE projected=0").all()){this.emit(String(row.chat),{type:'chat/pendingMessageRemoved',kind:'queued',id:String(row.id)} as PendingQueueAction);this.store.db.prepare('UPDATE queue_intents SET projected=1 WHERE id=?').run(row.id);}
    for(const row of this.store.db.prepare("SELECT DISTINCT chat FROM queue_intents WHERE status='pending'").all())this.holdQueue(String(row.chat),'host-restarted');
    for(const row of this.store.db.prepare("SELECT chat,id FROM steering_intents WHERE projected=0").all()){this.emit(String(row.chat),{type:'chat/pendingMessageRemoved',kind:'steering',id:String(row.id)} as PendingQueueAction);this.store.db.prepare('UPDATE steering_intents SET projected=1 WHERE id=?').run(row.id);}
    for(const row of this.store.db.prepare("SELECT chat,id,message FROM steering_intents WHERE status='pending'").all())this.emit(String(row.chat),{type:'chat/pendingMessageSet',kind:'steering',id:String(row.id),message:{...JSON.parse(String(row.message)),_meta:{'amplifier.dev/steering':{held:true,reason:'host-restarted'}}}} as PendingQueueAction);
  }
  async listen():Promise<this> {
    this.roots=await Promise.all(this.config.allowedWorkspaceRoots.map(root=>realpath(root)));
    if(this.config.catalog?.libraryQuery&&(!this.config.catalog.supportsLibraryQuery||await this.config.catalog.supportsLibraryQuery()))this.library=new LibraryIndex(this.config.catalog,{
      page:after=>this.store.db.prepare('SELECT uri FROM sessions WHERE uri>? ORDER BY uri LIMIT 100').all(after).map(row=>String(row.uri)),
      record:uri=>this.libraryMetadata(uri),unknown:uri=>this.libraryUnknown(uri),live:()=>this.libraryLiveFacts(),
      changed:()=>this.invalidateCapability('workspaces','host'),
    },await realpath(this.config.stateDirectory),this.store.incarnation);
    this.store.onReceiptChanged=this.library?channel=>{if(channel==='*capacity')this.library?.degraded();else if(channel.startsWith('ahp-chat:/')||channel.startsWith('ahp-session:/'))this.library?.point(channel.replace('ahp-chat:/','ahp-session:/'));}:undefined;
    await this.repairArchiveProjection();
    await this.presentation?.checkReady();
    this.defaultWorkingDirectory=await this.workspace(pathToFileURL(this.config.defaultWorkingDirectory??this.roots[0]).href);
    await new Promise<void>((resolve,reject)=>{this.http.once('error',reject);this.http.listen(this.config.port??0,this.config.host??'127.0.0.1',resolve);});
    void this.library?.reconcile();
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
    const peer:Peer={socket,connectionId:randomUUID(),handshakeQueued:false,initialized:false,ready:false,buffer:[],bufferBytes:0,cuts:new Map(),lastClientSeq:-1,seenClientSeq:new Set(),subscriptions:new Set(),pending:0,queue:Promise.resolve(),channels:new Map(),cursors:new Map()};this.peers.add(peer);
    socket.on('error',()=>{});
    socket.on('close',()=>{this.peers.delete(peer);const subscriptions=[...peer.subscriptions];peer.subscriptions.clear();peer.cursors.clear();for(const uri of subscriptions){this.refreshAgentInterest(uri);this.removeActiveClient(uri,peer.clientId);if(!this.hasSubscribers(uri)){this.loadedFloors.delete(uri);this.nativeWindows.delete(uri);}}for(const [uri,watch] of this.watches)if(watch.owner===peer&&!this.hasSubscribers(uri))this.watches.delete(uri);});
    socket.on('message',data=>{
      let message:Json;try {message=JSON.parse(data.toString());if(message.jsonrpc!=='2.0'||typeof message.method!=='string')throw new Error();}catch {this.send(peer,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC request'}});return;}
      if(++peer.pending>(this.config.maxInFlightRequests??32)){socket.close(1013,'Inbound capacity exceeded');return;}
      const handle=async()=>{
        try {const result=await this.route(peer,message.method,message.params??{});if(message.id!==undefined)this.send(peer,{jsonrpc:'2.0',id:message.id,result:result??null});if(message.method==='initialize'||message.method==='reconnect'){peer.ready=true;for(const buffered of peer.buffer){const cut=peer.replayCut??peer.cuts.get(buffered.params?.channel)??-1;if(buffered.method!=='action'||buffered.params.serverSeq>cut)this.send(peer,buffered);}peer.buffer=[];peer.bufferBytes=0;peer.cuts.clear();}}
        catch(error) {const fault=error as RpcFault;if(message.id!==undefined)this.send(peer,{jsonrpc:'2.0',id:message.id,error:{code:Number.isSafeInteger(fault.code)?fault.code:-32603,message:fault.message,data:fault.data}});}
        finally {peer.pending--;}
      };
      // Only the handshake owns the connection barrier. Requests already queued
      // behind a pending handshake must not accidentally extend that barrier.
      if(message.method==='initialize'||message.method==='reconnect'){peer.handshakeQueued=true;peer.queue=peer.queue.catch(()=>{}).then(handle);}
      else if(!peer.handshakeQueued)void handle(); // route rejects use before initialize
      else if(independentRequests.has(message.method))void peer.queue.catch(()=>{}).then(handle);
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
  private notify(method:string,params:Json,channel=ROOT) {const session=params.session??params.summary?.resource;if(channel===ROOT&&['root/sessionAdded','root/sessionSummaryChanged'].includes(method)&&typeof session==='string'&&this.presentation?.hidden(session))return;for(const peer of this.peers)if(peer.subscriptions.has(channel))this.send(peer,{jsonrpc:'2.0',method,params});}
  private root() {return {agents:this.config.engines.map(engine=>({provider:engine.id,displayName:engine.label,description:'ACP agent',models:[],capabilities:{}})),activeSessions:this.store.count,terminals:this.terminalList(),_meta:{'amplifier.dev/host':{version:1,privateDrafts:'client',defaultDirectory:this.defaultWorkingDirectory?pathToFileURL(this.defaultWorkingDirectory).href:undefined,features:{libraryQuery:!!this.library,receipts:true,sharedDrafts:false,queue:true,steer:true,voice:false,canvas:false,nativeControl:false}}}};}
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
    if(this.managed&&this.insideManaged(path))throw new RpcFault(-32009,'Managed chat folders are selected-session resources, not workspaces');
    if(!(await stat(path)).isDirectory()||!this.roots.some(root=>{const rel=relative(root,path);return !rel||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);}))throw new RpcFault(-32009,'Working directory is outside allowed workspace roots');
    return path;
  }
  private insideManaged(path:string){if(!this.managed)return false;const r=relative(this.managed.root,path);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);}
  private async selectedWorkspace(record:SessionRecord,execution=false):Promise<string>{
    const location=record.state._meta?.['amplifier.dev/location'] as ManagedLocation|undefined;
    if(!location)return this.workspace(pathToFileURL(execution?(record.executionDirectory??record.workingDirectory):record.workingDirectory).href);
    const receipt=this.managed?.bySession(record.uri);
    if(!receipt||receipt.state!=='completed'||managedHash(location)!==managedHash(this.managed!.location(receipt))||record.nativeSessionId!==location.allocationId||record.engineId!==receipt.request.provider)throw new RpcFault(-32009,'Managed session has no confirmed local allocation authority');
    const disposed=this.managedFiles.fence(record.uri);
    if(disposed){if(execution)throw new RpcFault(-32011,'Managed files disposal prevents execution; inspect its receipt or create an independent recovery copy');if(record.workingDirectory!==receipt.marker.workspace)throw new RpcFault(-32009,'Disposed managed history identity differs');return receipt.marker.workspace;}
    const cwd=await this.managed!.inspect(receipt);
    if(record.workingDirectory!==cwd||execution&&(record.executionDirectory??cwd)!==cwd)throw new RpcFault(-32009,'Managed session directory differs from its allocation');
    return cwd;
  }
  /** Read-only canonical workspace authority for trusted product owners. */
  async authorizeWorkspace(directory:string):Promise<string> {
    if(typeof directory!=='string'||directory.length>8192||!isAbsolute(directory))throw new RpcFault(-32602,'An absolute existing workspace directory is required');
    return this.workspace(pathToFileURL(directory).href);
  }
  private async resourcePath(uri:string):Promise<string> {
    let path:string;try {path=await realpath(fileURLToPath(uri));}catch{throw new RpcFault(-32008,'Resource not found');}
    if(this.managed&&this.insideManaged(path))throw new RpcFault(-32009,'Managed chat files require a selected-session resource owner');
    if(!this.roots.some(root=>{const rel=relative(root,path);return !rel||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);}))throw new RpcFault(-32009,'Resource outside allowed workspace roots');
    return path;
  }
  private agentInterested(session:string){return this.hasSubscribers(session)||this.hasSubscribers(chatURI(session));}
  private refreshAgentInterest(channel:string) {
    if(typeof channel!=='string'||!/^ahp-(session|chat):/.test(channel))return;
    const session=channel.replace('ahp-chat:','ahp-session:'),active=this.active.get(session);
    if(!active)return;
    const interested=this.agentInterested(session);
    if(active.interested===true&&!interested)active.uninterestedSince=performance.now();
    active.interested=interested;
  }
  private touchAgent(active:Active){active.lastUsed=performance.now();active.useOrder=++this.agentUseOrder;}
  /** Only an actual dispatched use renews LRU/grace; validation and passive polls do not. */
  private async withAgentUse<T>(active:Active,request:()=>Promise<T>,use=true):Promise<T> {
    active.controlDepth=(active.controlDepth??0)+1;
    if(use)this.touchAgent(active);
    try{return await request();}finally{active.controlDepth--;if(use)this.touchAgent(active);}
  }
  private nativeControlIsUse(operation:string) {
    // Exact known read contracts, not suffix heuristics: snapshots persist state and are use.
    return !new Set(['capabilities','configuration.inspect','configuration.exportResources','configuration.providers','configuration.providerModels','configuration.providerLoginStatus','catalog.inspect','usage.inspect','context.clear.review','goals.get','budget.get','mode.list','native.status','bundle.preview','capacity.get','capacity.quota','task.get','task.receipt','task.history','session.relocation.inspect','runtime.inspect','workers.inspect']).has(operation);
  }
  private withAgentCapacity<T>(work:()=>Promise<T>):Promise<T> {
    const next=this.agentCapacity.catch(()=>{}).then(work);this.agentCapacity=next;return next;
  }
  private hasSubscribers(uri:string){return [...this.peers].some(peer=>peer.subscriptions.has(uri));}
  private capability(uri:string) {
    const config=this.config.capabilities;if(!config)return;
    let parsed:URL;try{parsed=new URL(uri);}catch{return;}
    const base=uri.split('?')[0],entry=Object.entries(config.manifest.topics).find(([,topic])=>topic.uri===base);
    if(!entry)return;
    const scopes=parsed.searchParams.getAll('scope'),scope=scopes[0];
    if(scopes.length!==1||!scope||(scope!=='host'&&!/^ahp-session:\/[^?#\s]+$/.test(scope)))throw new RpcFault(-32602,'Capability URI requires one explicit host or AHP session scope',{executed:false});
    if(entry[1].scope==='host'&&scope!=='host')throw new RpcFault(-32602,'Host capability topic requires scope=host',{executed:false});
    return {topic:entry[0],scope};
  }
  private resourceProvider(uri:string){let scheme;try{scheme=new URL(uri).protocol.slice(0,-1);}catch{return;}return this.config.resourceProviders?.find(provider=>provider.scheme===scheme);}
  /** Called by independent capability owners after their authoritative commit. */
  invalidateCapability(topic:string,scope:string) {
    for(const [channel,watch] of this.watches){const target=this.capability(watch.root);if(target?.topic===topic&&target.scope===scope)this.emit(channel,{type:'resourceWatch/changed',changes:{items:[{uri:watch.root,type:'updated'}]}} as StateAction);}
  }
  private async record(uri:string):Promise<SessionRecord> {
    let record=this.getRecord(uri);if(record){await this.selectedWorkspace(record);return this.getRecord(uri)!;}
    const session=uri.startsWith('ahp-chat:/')?`ahp-session:/${uri.slice('ahp-chat:/'.length)}`:uri;
    const discovered=await this.exactCatalogRecord(session);
    if(!discovered)throw new RpcFault(-32008,'Unknown resource');
    if(discovered.location?.kind==='managed')throw new RpcFault(-32009,'Managed session must be restored from its local allocation receipt before activation');
    await this.workspace(pathToFileURL(discovered.workingDirectory).href);
    // Metadata discovery never starts an agent. Native histories are read by the catalog/resource owner.
    const timestamp=discovered.modifiedAt;
    const summary=this.catalogSummary(discovered);
    const chat:ChatState={resource:chatURI(session),title:summary.title,status:summary.status,modifiedAt:timestamp,turns:[],_meta:{'amplifier.dev/history':{source:'native',available:false,reason:'Native history projection has not been imported'}}};
    record={uri:session,engineId:discovered.engineId,nativeSessionId:discovered.nativeSessionId,workingDirectory:discovered.workingDirectory,summary,
      state:{provider:summary.provider,title:summary.title,status:summary.status,lifecycle:SessionLifecycle.Ready,activeClients:[],chats:[this.chatSummary(chat)],defaultChat:chat.resource,workingDirectories:summary.workingDirectories,_meta:{'amplifier.dev/native':{availability:discovered.availability??'available'},...(discovered.nativeDeleted?{'amplifier.dev/lifecycle':{version:1,deleted:true,source:'native-catalog'}}:{})}},chat};
    if(this.presentation&&discovered.nativeSessionId)this.presentation.retainMapping(discovered as unknown as Json);this.store.save(record);if(discovered.nativeDeleted){this.store.db.prepare('INSERT OR REPLACE INTO session_visibility VALUES(?,1,?)').run(record.uri,'catalog-native-deleted');this.store.db.prepare('UPDATE sessions SET hidden=1 WHERE uri=?').run(record.uri);}this.emit(ROOT,{type:'root/activeSessionsChanged',activeSessions:this.store.count} as StateAction);return record;
  }
  private getRecord(uri:string):SessionRecord|undefined {return this.hotRecords.get(uri.startsWith('ahp-chat:/')?'ahp-session:/'+uri.slice('ahp-chat:/'.length):uri)??this.store.get(uri);}
  private catalogSummary(record:CatalogRecord):SessionSummary {
    const live=this.getRecord(record.uri);
    return {resource:record.uri,provider:record.engineId,title:live?.summary.title??record.title,status:live?.summary.status??(1|(record.isArchived?SessionStatus.IsArchived:0)),createdAt:record.createdAt,modifiedAt:live?.summary.modifiedAt??record.modifiedAt,workingDirectories:[pathToFileURL(record.workingDirectory).href],_meta:{'amplifier.dev/native':{availability:record.availability??'available'},...(record.location?{'amplifier.dev/location':record.location}:{})}};
  }
  private chatSummary(chat:ChatState) {return {resource:chat.resource,title:chat.title,status:chat.status,modifiedAt:chat.modifiedAt};}
  private turnCursor(chat:string,before?:number):string|undefined {
    if(before===undefined)return;const token=randomUUID();this.cursors.set(token,{chat,before});if(this.cursors.size>4096)this.cursors.delete(this.cursors.keys().next().value!);return token;
  }
  private rememberRecallCursor(value:{scope:string;cursor?:string;after?:{modified:string;uri:string}}):string {
    const token=randomUUID();this.recallCursors.set(token,value);if(this.recallCursors.size>4096)this.recallCursors.delete(this.recallCursors.keys().next().value!);return token;
  }
  private recallCursor(token:string|undefined,scope:string) {
    if(token===undefined)return;
    const value=this.recallCursors.get(token);if(!value||value.scope!==scope)throw new RpcFault(-32602,'Recall cursor expired or belongs to a different source/query/revision');return value;
  }
  private recallMetadata(record:CatalogRecord):RecallSource {
    if((record as Json).nativeDeleted)throw new RpcFault(-32008,'Removed native source is not visible');
    if(record.parentUri||record.kind&&record.kind!=='root'&&record.kind!=='session')throw new RpcFault(-32601,'Child/internal Recall sources are not advertised');
    if(record.workspaceAvailability&&record.workspaceAvailability!=='present')throw new RpcFault(-32008,'Recall workspace is not currently visible');
    return {id:record.uri,title:record.title,workspace:record.workingDirectory,kind:record.kind??'root'};
  }
  private async recallSource(id:string):Promise<{source:RecallSource;record:SessionRecord}> {
    const catalog=await this.exactCatalogRecord(id);
    if(catalog){if(catalog.uri!==id)throw new RpcFault(-32008,'Catalog returned a different source identity');this.recallMetadata(catalog);if((catalog as Json).isArchived)throw new RpcFault(-32008,'Archived source is not visible');}
    const record=await this.record(id);
    if(record.state.status & SessionStatus.IsArchived)throw new RpcFault(-32008,'Archived source is not visible');
    return {source:this.recallMetadata(catalog??{uri:record.uri,title:record.summary.title,workingDirectory:record.workingDirectory,engineId:record.engineId,createdAt:record.summary.createdAt,modifiedAt:record.summary.modifiedAt}),record};
  }
  /** Indexed source inventory only; no native initialization, history reads, or global projection. */
  async listRecallSources(input:{session:string;scope:'task'|'workspace'|'all';cursor?:string;limit?:number}) {
    if(!input||!['task','workspace','all'].includes(input.scope))throw new RpcFault(-32602,'Recall scope is required');
    const selected=await this.recallSource(input.session),limit=bounded(input.limit,25,25),scope=JSON.stringify(['list',selected.source.id,input.scope]);
    const cursor=this.recallCursor(input.cursor,scope);
    if(input.scope==='task'){if(input.cursor)throw new RpcFault(-32602,'Task inventory has no next page');return {items:[selected.source],coverage:{source:'selected-root',children:false,internal:false}};}
    if(this.config.catalog){
      const result=await this.withConversationCatalogRead(()=>this.config.catalog!.list({connectionId:'recall:'+this.store.incarnation+':'+createHash('sha256').update(scope).digest('hex'),limit,cursor:cursor?.cursor,allowedWorkspaceRoots:this.roots,...(this.managed?{allowedManagedRoots:[this.managed.root]}:{}),includeArchive:false,...(input.scope==='workspace'?{workingDirectory:selected.source.workspace}:{})}));
      if(result.items.length>limit)throw new RpcFault(-32000,'Catalog exceeded Recall page bound');
      const items=result.items.map(row=>this.recallMetadata(row));
      return {items,...(result.nextCursor?{nextCursor:this.rememberRecallCursor({scope,cursor:result.nextCursor})}:{}),coverage:{source:'indexed-catalog',freshness:result.freshness,children:false,internal:false}};
    }
    const after=cursor?.after,where=['hidden=0',`(json_extract(state,'$.status') & ${SessionStatus.IsArchived})=0`],args:any[]=[];
    if(input.scope==='workspace'){where.push('cwd=?');args.push(selected.source.workspace);}
    if(after){where.push('(modified,uri)<(?,?)');args.push(after.modified,after.uri);}
    const rows=this.store.db.prepare(`SELECT uri,cwd,modified,summary FROM sessions WHERE ${where.join(' AND ')} ORDER BY modified DESC,uri DESC LIMIT ?`).all(...args,limit+1),items:RecallSource[]=[];
    for(const row of rows.slice(0,limit)){try{await this.workspace(pathToFileURL(String(row.cwd)).href);}catch{continue;}const summary=JSON.parse(String(row.summary));items.push({id:String(row.uri),title:summary.title,workspace:String(row.cwd),kind:'root'});}
    const last=rows[Math.min(rows.length,limit)-1];
    return {items,...(rows.length>limit?{nextCursor:this.rememberRecallCursor({scope,after:{modified:String(last.modified),uri:String(last.uri)}})}:{}),coverage:{source:'host-owned-only',children:false,internal:false}};
  }
  private async passiveRecall(record:SessionRecord,operation:'inspect'|'read',params:Json={}):Promise<Json> {
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive history read capacity reached');
    const engine=this.config.engines.find(engine=>engine.id===record.engineId);
    if(!engine||!record.nativeSessionId)throw new RpcFault(-32601,'Passive native source is unavailable');
    this.passiveReads++;const agent=new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive native inspection cannot perform filesystem or terminal effects');}});
    try{
      const init=await agent.initialize(),capability=(init.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.history;
      if(capability?.version!==1||capability.paging!=='complete-turns'||capability.passive!==true||capability.passiveInspect!==true)throw new RpcFault(-32601,'Agent does not advertise revision-checked passive history');
      return await agent.client.extMethod(operation==='inspect'?'_amplifier/history/inspect':'_amplifier/history',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,...params});
    }finally{this.passiveReads--;await agent.retire();}
  }
  /** Metadata-only indexed inventory. Unselected catalog history is intentionally outside this coverage. */
  async listCoordinationSessions(input:{cursor?:string;limit?:number;clientId?:string}={}) {return this.withConversationCatalogRead(()=>this.listCoordinationSessionsGuarded(input));}
  private async listCoordinationSessionsGuarded(input:{cursor?:string;limit?:number;clientId?:string}={}) {
    const limit=bounded(input.limit,50,100),cursor=input.cursor?this.coordinationCursors.get(input.cursor):undefined;
    if(input.cursor&&!cursor)throw new RpcFault(-32602,'Coordination cursor expired; start a fresh indexed page');
    const roots=this.roots.map(()=>'(cwd=? OR substr(cwd,1,?)=?)').join(' OR '),values=this.roots.flatMap(root=>[root,(root.endsWith('/')?root:root+'/').length,root.endsWith('/')?root:root+'/']);
    const rows=this.store.db.prepare(`SELECT uri,chat_uri,modified,summary FROM sessions WHERE hidden=0 ${this.presentation?'AND NOT EXISTS(SELECT 1 FROM presentation_markers p WHERE p.session=sessions.uri AND p.hidden=1)':''} AND (${roots}) ${cursor?'AND (modified,uri)<(?,?)':''} ORDER BY modified DESC,uri DESC LIMIT ?`).all(...values,...(cursor?[cursor.modified,cursor.uri]:[]),limit+1),items=[];
    for(const row of rows.slice(0,limit)){const summary=JSON.parse(String(row.summary)),active=this.active.get(String(row.uri));items.push({uri:String(row.uri),title:summary.title,status:active?.busy?'working':this.store.unknown(String(row.chat_uri))?'unknown':'idle',activeTurnId:active?.busy?active.turnId:undefined,...this.store.revisions(String(row.uri))});}
    let nextCursor:string|undefined;if(rows.length>limit){const last=rows[limit-1];nextCursor=randomUUID();this.coordinationCursors.set(nextCursor,{modified:String(last.modified),uri:String(last.uri)});if(this.coordinationCursors.size>4096)this.coordinationCursors.delete(this.coordinationCursors.keys().next().value!);}
    return {items,nextCursor,coverage:{source:'host-indexed',unselectedCatalogSessions:false,workspaceExistence:'last-admission',nativeHistoriesRead:false}};
  }
  /** Compact settled results are written once at turn settlement, never rebuilt from native history. */
  async readCoordinationSession(session:string,input:{afterSequence?:number;limit?:number;clientId?:string}={}) {
    const limit=bounded(input.limit,32,32),after=input.afterSequence??0;if(!Number.isSafeInteger(after)||after<0)throw new RpcFault(-32602,'A nonnegative result sequence is required');
    if(typeof session!=='string'||!session.startsWith('ahp-session:/'))throw new RpcFault(-32602,'An exact session URI is required');
    const row=this.store.db.prepare('SELECT uri,chat_uri,cwd,summary,hidden FROM sessions WHERE uri=?').get(session);
    if(!row){const discovered=await this.exactCatalogRecord(session);if(!discovered)throw new RpcFault(-32008,'Unknown coordination target');await this.workspace(pathToFileURL(discovered.workingDirectory).href);return {available:false,reason:'not-indexed',session,results:[],coverage:{source:'host-indexed',nativeHistoriesRead:false},attentionUnknown:true};}
    await this.workspace(pathToFileURL(String(row.cwd)).href);
    const rows=this.store.db.prepare('SELECT * FROM coordination_results WHERE chat=? AND sequence>? ORDER BY sequence LIMIT ?').all(String(row.chat_uri),after,limit+1),latest=Number(this.store.db.prepare('SELECT coalesce(max(sequence),0) n FROM coordination_results WHERE chat=?').get(String(row.chat_uri))!.n);
    const cutoff=Number(this.store.db.prepare("SELECT value FROM meta WHERE key='coordination_start_ordinal'").get()!.value),legacy=!!this.store.db.prepare('SELECT 1 FROM turns WHERE chat=? AND ordinal<=? LIMIT 1').get(String(row.chat_uri),cutoff);
    const native=!!this.store.db.prepare("SELECT 1 FROM sessions WHERE uri=? AND json_extract(chat,'$._meta.\"amplifier.dev/history\".source')='native'").get(session);
    const approvals=this.store.db.prepare("SELECT json_extract(value,'$.id') id FROM sessions,json_each(state,'$.inputNeeded') WHERE uri=? AND json_extract(value,'$.kind')='toolConfirmation' LIMIT 65").all(session).map(value=>String(value.id));
    const active=this.active.get(session),results=rows.slice(0,limit).map(value=>({id:String(value.turn_id)+':assistant-result',inputId:String(value.turn_id),sequence:Number(value.sequence),text:String(value.text),sourceTruncated:!!value.truncated,window:'head',source:'host-indexed-result',state:String(value.state)}));
    const unknown=this.store.unknown(String(row.chat_uri)),fenced=!!row.hidden||!!this.relocationFence(session)||!!this.transferFence(session)||!!this.store.db.prepare("SELECT 1 FROM lifecycle_commands WHERE session=? AND status IN ('dispatching','unknown') LIMIT 1").get(session)||!!this.store.db.prepare("SELECT 1 FROM history_edits WHERE session=? AND status IN ('admitted','unknown') LIMIT 1").get(session);
    return {available:latest>0||!native&&!legacy,...(latest===0&&(native||legacy)?{reason:'not-indexed'}:{}),session,title:JSON.parse(String(row.summary)).title,canFollowup:!active?.busy&&!active?.controlDepth&&!unknown&&!fenced&&!this.closing,canInterrupt:!!active?.busy&&!active.cancel,admissionEligibility:'advisory',status:active?.busy?'working':unknown?'unknown':'idle',activeTurnId:active?.busy?active.turnId:undefined,revision:this.store.seq,latestSequence:latest,results,hasMore:rows.length>limit,approvalIds:approvals.slice(0,64),attentionUnknown:true,attentionCoverage:{approvals:true,approvalsTruncated:approvals.length>64,questions:false},coverage:{source:'host-indexed',legacyGap:legacy,nativeHistoryOmitted:native,nativeHistoriesRead:false},...this.store.revisions(session)};
  }
  /** Selected passive worker index. Even a warm ACP connection never implies a resident worker. */
  async readCoordinationWorkers(session:string,input:{workerId?:string;cursor?:string;limit?:number;afterSequence?:number;resultLimit?:number;commandId?:string}={}) {
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['workerId','cursor','limit','afterSequence','resultLimit','commandId'].includes(key)))throw new RpcFault(-32602,'Bounded worker index options required');
    for(const key of ['workerId','cursor','commandId'] as const)if(input[key]!==undefined&&(typeof input[key]!=='string'||!input[key]||input[key]!.length>200))throw new RpcFault(-32602,'Bounded worker or cursor identity required');
    const params={...input,limit:bounded(input.limit,50,100),resultLimit:bounded(input.resultLimit,32,32)};if(input.afterSequence!==undefined&&(!Number.isSafeInteger(input.afterSequence)||input.afterSequence<0))throw new RpcFault(-32602,'Nonnegative worker report sequence required');
    const record=await this.record(session),engine=this.config.engines.find(engine=>engine.id===record.engineId);if(!engine||!record.nativeSessionId)throw new RpcFault(-32601,'Native worker index identity is unavailable');
    const live=this.active.get(record.uri)?.agent,owned=live&&!live.closed?live:undefined;
    if(!owned&&this.passiveReads>=4)throw new RpcFault(-32000,'Passive worker inspection capacity reached');
    if(!owned)this.passiveReads++;const agent=owned??new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive native inspection cannot perform filesystem or terminal effects');}});
    try{
      const initialized=owned?owned.initialized:await agent.initialize(),capability=(initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.workers;
      if(capability?.version!==1||capability.passiveInspection!==true)throw new RpcFault(-32601,'Agent does not advertise passive worker inspection');
      const result:Json=await agent.client.extMethod('_amplifier/workers',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,...params});
      if(!result||typeof result!=='object'||Array.isArray(result)||Buffer.byteLength(JSON.stringify(result))>2*1024*1024||input.commandId===undefined&&(typeof result.available!=='boolean'||result.source!=='native-worker-index'||!Number.isSafeInteger(result.revision)||result.items?.length>params.limit||result.results?.length>params.resultLimit))throw new RpcFault(-32000,'Invalid or oversized native worker index response');
      return result;
    }finally{if(!owned){this.passiveReads--;await agent.retire();}}
  }
  /** Selected persisted task authority; never mounts or resumes the native runtime. */
  async readTaskState(session:string,input:{expectedRevision?:string}={}) {
    if(input.expectedRevision!==undefined&&(typeof input.expectedRevision!=='string'||!input.expectedRevision||input.expectedRevision.length>512))throw new RpcFault(-32602,'Bounded expected task source revision required');
    const record=await this.record(session),engine=this.config.engines.find(engine=>engine.id===record.engineId);
    if(!engine||!record.nativeSessionId)throw new RpcFault(-32601,'Passive native task state is unavailable');
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive native read capacity reached');
    this.passiveReads++;const agent=new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive native inspection cannot perform filesystem or terminal effects');}});
    try{
      const init=await agent.initialize(),capability=(init.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.taskState;
      if(capability?.version!==1||capability.passive!==true)throw new RpcFault(-32601,'Agent does not advertise passive persisted task state');
      const result=await agent.client.extMethod('_amplifier/task/inspect',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,...input});
      if(typeof result.available!=='boolean'||result.source!=='persisted-native-controls'||(result.revision!==null&&(typeof result.revision!=='string'||result.revision.length>512))||Buffer.byteLength(JSON.stringify(result))>65536||result.task!==null&&(typeof result.task!=='object'||Array.isArray(result.task)||Buffer.byteLength(JSON.stringify(result.task))>32768))throw new RpcFault(-32000,'Invalid or oversized persisted task state');
      if(input.expectedRevision!==undefined&&result.revision!==input.expectedRevision)throw new RpcFault(-32011,'Persisted task source revision changed');
      return result;
    }finally{this.passiveReads--;await agent.retire();}
  }
  /** Storage-owner stat only. Missing/unsupported history is explicit, never an empty success. */
  async inspectRecallSource(id:string) {
    const {source,record}=await this.recallSource(id),result=await this.passiveRecall(record,'inspect');
    if(result.available!==true||typeof result.revision!=='string'||!result.revision||result.revision.length>512)throw new RpcFault(-32008,'Native Recall history is unavailable',{available:false,diagnostics:result.diagnostics});
    return {...source,revision:result.revision,limits:RECALL_LIMITS,coverage:{source:'native-history',authorization:'unverified-native-history',diagnostics:result.diagnostics??[]}};
  }
  /** One complete-turn page; no worker mount, implicit pagination, or truncated messages. */
  async readRecallSource(id:string,input:{cursor?:string;limit?:number;expectedRevision:string}) {
    if(!input||typeof input.expectedRevision!=='string'||!input.expectedRevision||input.expectedRevision.length>512)throw new RpcFault(-32602,'An expected passive source revision is required');
    const {record}=await this.recallSource(id),limit=bounded(input.limit,50,RECALL_LIMITS.maxTurns),scope=JSON.stringify(['read',record.uri,input.expectedRevision]),cursor=this.recallCursor(input.cursor,scope);
    const result=await this.passiveRecall(record,'read',{limit,expectedRevision:input.expectedRevision,...(cursor?.cursor?{cursor:cursor.cursor}:{})});
    if(result.revision!==input.expectedRevision||!Array.isArray(result.turnGroups)||result.turnGroups.length>limit||result.turnGroups.some((group:Json)=>!Array.isArray(group.updates)))throw new RpcFault(-32011,'Native history revision/page contract changed');
    const mapped=recallRows(result.turnGroups);
    if(Buffer.byteLength(JSON.stringify({...mapped,diagnostics:result.diagnostics??[]}))>RECALL_LIMITS.maxBytes)throw new RpcFault(-32000,'Complete Recall page exceeds byte capacity; use a smaller turn limit');
    return {...mapped,revision:result.revision,...(result.nextCursor?{nextCursor:this.rememberRecallCursor({scope,cursor:result.nextCursor})}:{}),limits:RECALL_LIMITS,coverage:{source:'native-history',authorization:'unverified-native-history',diagnostics:result.diagnostics??[],omittedUpdates:mapped.omittedUpdates}};
  }
  private publicRows(record:SessionRecord,result:Json):PersistedPublicRow[] {
    if(!Array.isArray(result.publicRows)||typeof result.publicRowsComplete!=='boolean')throw new RpcFault(-32000,'Native public row page has no explicit coverage');
    const rows=result.publicRows.map(persistedPublicRow);
    if(rows.some(row=>row.locator.sessionId!==record.nativeSessionId)||new Set(rows.map(row=>JSON.stringify(row.locator))).size!==rows.length)throw new RpcFault(-32000,'Native public row page scope or occurrence changed');
    return rows;
  }
  /** Existing passive Native owner reads; no grant or execution effects. */
  async readPublicOriginalRows(session:string,input:{cursor?:string;rowLocator?:NativeLocator;expectedRevision?:string}={}) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['cursor','rowLocator','expectedRevision'].includes(key))||input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor)||input.expectedRevision!==undefined&&(typeof input.expectedRevision!=='string'||!input.expectedRevision))throw new RpcFault(-32602,'Exact public row read options required');
    if(input.cursor!==undefined&&input.rowLocator!==undefined)throw new RpcFault(-32602,'Choose public row paging or one exact occurrence');
    const record=await this.record(session),engine=this.config.engines.find(value=>value.id===record.engineId);
    if(!engine||!record.nativeSessionId)throw new RpcFault(-32601,'Native public row identity unavailable');
    const locator=input.rowLocator===undefined?undefined:nativeLocator(input.rowLocator);
    if(locator&&locator.sessionId!==record.nativeSessionId)throw new RpcFault(-32602,'Public row locator scope changed');
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive history read capacity reached');
    this.passiveReads++;
    const agent=new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive public row read cannot perform effects');}});
    try{
      const init=await agent.initialize(),capability=(init.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.publicMessagePreservation;
      if(capability?.version!==1||capability.publicRows!==true||locator&&capability.exactRowRead!==true)throw new RpcFault(-32601,'Native public row reading is not qualified');
      const result:Json=await agent.client.extMethod('_amplifier/history',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,includePublicRows:true,...input});
      if(typeof result.revision!=='string'||!Array.isArray(result.diagnostics)||input.expectedRevision!==undefined&&result.revision!==input.expectedRevision)throw new RpcFault(-32013,'Native public row revision changed');
      const rows=this.publicRows(record,result);
      if(result.nextCursor!==undefined&&result.nextCursor!==null&&(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor===input.cursor))throw new RpcFault(-32013,'Native public row cursor did not advance');
      if(result.publicRowsComplete&&(result.nextCursor!==undefined&&result.nextCursor!==null))throw new RpcFault(-32000,'Native public row page falsely claims completion');
      if(locator&&(rows.length!==1||!sameLocator(rows[0]!.locator,locator)||!result.publicRowsComplete||result.nextCursor))throw new RpcFault(-32008,'Exact persisted public row unavailable');
      return {revision:result.revision,rows,nextCursor:result.nextCursor??null,complete:result.publicRowsComplete,diagnostics:result.diagnostics as unknown[]};
    }finally{this.passiveReads--;await agent.retire();}
  }
  private async publicAttachment(record:SessionRecord,row:PersistedPublicRow,blockIndex:number,card:PublicCard) {
    const metadata={originalReference:card.reference,rowLocator:row.locator,originalBlockIndex:blockIndex,disposition:row.copySource?.disposition??'original'};
    let uri:string|undefined,access='unavailable';
    if(card.reference.owner==='resources'){
      if(!row.copySource){try{const original=new URL(card.reference.id);if(original.protocol==='amplifier-attachment:'&&original.pathname==='/body'&&original.searchParams.get('session')===record.uri&&original.searchParams.size===1)uri=original.href;}catch{}}
      else if(this.config.publicOriginalResources){try{const grant=await this.config.publicOriginalResources.resolveOriginalAttachment(record.uri,card.reference);uri=qualifiedAccessUri(grant,record.uri,card.reference);if(grant?.status==='unknown'||grant?.status==='pending')access=grant.status;}catch{access='unknown';}}
    }
    // A retained descriptor is visible even when target access is not qualified.
    return uri?{type:'resource',label:card.name,contentType:card.mimeType,uri,_meta:{'amplifier.dev/publicAttachment':{...metadata,access:'qualified'}}}:{type:'simple',label:card.name,_meta:{'amplifier.dev/publicAttachment':{...metadata,access}}};
  }
  /** Resources calls this trusted verifier; callers cannot supply card authority. */
  async verifyOriginalForkAttachment(input:RetainOriginalAttachmentV2):Promise<VerifiedOriginalAttachmentV2> {
    if(!input||input.version!==2||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>200||Object.keys(input).some(key=>!['version','commandId','target'].includes(key)))throw new RpcFault(-32602,'Exact original attachment operation required');
    const occurrence=cardOccurrence(input.target),entry=this.store.db.prepare("SELECT * FROM lifecycle_commands WHERE command_id=? AND operation='fork'").get(input.commandId);
    if(!entry||entry.status!=='completed'||typeof entry.target!=='string')throw new RpcFault(-32011,'Original Native creation has no completed authority');
    const source=await this.record(String(entry.session)),target=await this.record(String(entry.target)),result=JSON.parse(String(entry.result)),args=JSON.parse(String(entry.payload)),receipt=result.receipt,native=receipt?.result;
    if(source.engineId!==target.engineId||!source.nativeSessionId||target.nativeSessionId!==occurrence.row.sessionId||receipt?.status!=='completed'||receipt.commandId!==input.commandId||receipt.operation!=='fork'||native?.sessionId!==target.nativeSessionId||native.creationConfirmed!==true||native.preservedSource!==true||native.workReplayed!==false||native.source?.sessionId!==source.nativeSessionId||native.source.historyRevision!==args.expectedHistoryRevision||native.source.throughMessageId!==args.throughMessageId||native.historyCwd!==target.workingDirectory||typeof native.historyRevision!=='string')throw new RpcFault(-32011,'Native fork receipt or exact Host scope changed');
    const selected=await this.readPublicOriginalRows(target.uri,{rowLocator:occurrence.row}),row=selected.rows[0]!,lineage=row.copySource;
    if(!lineage||lineage.source.sessionId!==source.nativeSessionId)throw new RpcFault(-32008,'Target row has no immediate source copy proof');
    const original=(await this.readPublicOriginalRows(source.uri,{rowLocator:lineage.source})).rows[0]!;
    if(!samePublicMessage(original.publicMessage,row.publicMessage))throw new RpcFault(-32008,'Copied public original changed');
    const card=row.publicMessage.blocks[occurrence.blockIndex],sourceCard=original.publicMessage.blocks[occurrence.blockIndex];
    if(card?.type!=='attachment'||sourceCard?.type!=='attachment'||card.reference.owner!=='resources'||!sameCard(card,sourceCard))throw new RpcFault(-32008,'Exact copied Resources card occurrence unavailable');
    return {version:2,commandId:input.commandId,authority:{commandId:input.commandId,status:'completed',source:{sessionId:source.nativeSessionId,historyRevision:native.source.historyRevision,...(args.throughMessageId?{throughMessageId:args.throughMessageId}:{})},target:{sessionId:target.nativeSessionId!,creationHistoryRevision:native.historyRevision},creationConfirmed:true,preservedSource:true,workReplayed:false},sourceOccurrence:{row:lineage.source,blockIndex:occurrence.blockIndex},targetOccurrence:occurrence,card,disposition:lineage.disposition,sourceHostSession:source.uri,targetHostSession:target.uri,engineId:source.engineId};
  }
  /** Explicit grant continuation. Resources owns its retry state; never refork. */
  async reconcileOriginalForkAttachments(sourceSession:string,commandId:string) {
    return this.intake.run(async()=>{
    if(this.closing)throw new RpcFault(-32008,'Host is shutting down');
    const source=await this.record(sourceSession),entry=this.store.db.prepare("SELECT * FROM lifecycle_commands WHERE command_id=? AND session=? AND operation='fork'").get(commandId,source.uri);
    if(!entry||entry.status!=='completed'||typeof entry.target!=='string')throw new RpcFault(-32011,'Reconcile Native creation without replay before qualifying grants');
    const owner=this.config.publicOriginalResources;
    if(!owner)throw new RpcFault(-32601,'Resources original attachment consumer unavailable');
    let cursor:string|undefined,revision:string|undefined,qualified=0,unresolved=0,unsupported=0,diagnosticCount=0;
    do{
      const page=await this.readPublicOriginalRows(String(entry.target),{...(cursor?{cursor}:{}),...(revision?{expectedRevision:revision}:{})});revision=page.revision;diagnosticCount+=page.diagnostics.length;
      for(const row of page.rows)if(row.copySource)for(const [blockIndex,card] of row.publicMessage.blocks.entries())if(card.type==='attachment'){
        if(card.reference.owner!=='resources'){unsupported++;continue;}
        const request:RetainOriginalAttachmentV2={version:2,commandId,target:{row:row.locator,blockIndex}};
        await this.verifyOriginalForkAttachment(request);
        const grant=await owner.retainOriginalAttachment(request);
        if(grant.commandId!==commandId)throw new RpcFault(-32000,'Resources grant command changed');
        if(qualifiedAccessUri(grant,String(entry.target),card.reference))qualified++;else unresolved++;
      }
      if(!page.nextCursor&&!page.complete)throw new RpcFault(-32008,'Native public row enumeration coverage incomplete');
      cursor=page.nextCursor??undefined;
    }while(cursor);
    return {commandId,targetSession:String(entry.target),qualified,unresolved,unsupported,diagnosticCount,enumeration:diagnosticCount?'partial':'complete',grantCoverage:diagnosticCount||unresolved||unsupported?'partial':'complete',replayed:false};
    });
  }
  private async nativeHistory(record:SessionRecord,limit?:number,cursor?:string,before?:{beforeTurnId:string;expectedRevision:string}):Promise<{turns:Turn[];nextCursor?:string;revision:string;diagnostics:unknown[]}> {
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive history read capacity reached');
    const engine=this.config.engines.find(engine=>engine.id===record.engineId);
    if(!engine||!record.nativeSessionId)throw new RpcFault(-32000,'Native history reader is unavailable; no empty transcript was substituted');
    this.passiveReads++;
    const agent=new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive native inspection cannot perform filesystem or terminal effects');}});
    try {
      const init=await agent.initialize();
      const capability=(init.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.history;
      if(capability?.version!==1||capability?.paging!=='complete-turns'||capability?.passive!==true)throw new RpcFault(-32601,'Agent does not advertise a passive native history reader');
      let next=cursor,revision='',diagnostics:unknown[]=[],turns:Turn[]=[];
      do {
        const publicCapability=(init.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.publicMessagePreservation;
        const includePublicRows=!before&&publicCapability?.version===1&&publicCapability.publicRows===true;
        const result=await agent.client.extMethod(before?'_amplifier/history/before':'_amplifier/history',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,limit:Math.min(limit===undefined?200:limit-turns.length,200),...(includePublicRows?{includePublicRows:true}:{}),...(before??{}),...(next?{cursor:next}:{})}) as Json;
        if(!Array.isArray(result.turnGroups)||typeof result.revision!=='string')throw new Error('Malformed native history page');
        const publicRows=includePublicRows?this.publicRows(record,result):[];
        if(revision&&revision!==result.revision)throw new RpcFault(-32013,'Native history changed while assembling the selected window');
        if(result.nextCursor&&(!result.turnGroups.length||result.nextCursor===next))throw new RpcFault(-32013,'Native history cursor did not advance');
        revision=result.revision;diagnostics.push(...(result.diagnostics??[]));const page:Turn[]=[];
        for(const group of result.turnGroups) {
          for(const update of group.updates as Json[])if(update._meta?.['amplifier.dev/history']!==undefined)update._meta={...update._meta,'amplifier.dev/history':this.nativeMessageHistory(record,update._meta['amplifier.dev/history'])};
          const inputs=(group.updates as Json[]).filter(update=>update.sessionUpdate==='user_message_chunk').map(update=>update.content);
          const recorded=(group.updates as Json[]).map(update=>update._meta?.['amplifier.dev/history']).find(value=>value?.recordedOnly);
          const inputHistory=(group.updates as Json[]).find(update=>update.sessionUpdate==='user_message_chunk')?._meta?.['amplifier.dev/history'];
          const message:Message={text:inputs.filter(content=>content.type==='text').map(content=>content.text).join(''),origin:{kind:recorded&&!inputs.length?'agent' as any:'user' as any},_meta:{'amplifier.dev/history':{...inputHistory,inputOrigin:inputHistory?.inputOrigin??'unknown',authorization:'unverified-native-history',outcome:group.recordedOnly?'recorded':group.state??'unknown',...(recorded?{via:recorded.via,callId:recorded.callId,itemId:recorded.itemId,recordedOnly:true}: {})}}};
          const attachments:any[]=[];
          for(const content of inputs){
            if(content.type==='image'||content.type==='audio')attachments.push({type:'embeddedResource',label:content.type,contentType:content.mimeType,data:content.data});
            else if(content.type==='resource_link'){
              let foreignScope=false;
              if(content.uri?.startsWith('amplifier-attachment:')){try{foreignScope=new URL(content.uri).searchParams.get('session')!==record.uri;}catch{foreignScope=true;}}
              attachments.push(foreignScope?{type:'simple',label:content.name??'Resource',_meta:{'amplifier.dev/publicAttachment':{originalReference:{owner:'resources',id:content.uri},access:'unavailable'}}}:{type:'resource',label:content.name??'Resource',uri:content.uri,contentType:content.mimeType});
            }
          }
          if(publicRows.length){
            const seen=new Set<string>(),originals:PersistedPublicRow[]=[];
            for(const update of group.updates as Json[]){const locator=update._meta?.['amplifier.dev/history']?.rowLocator;if(locator){const exact=nativeLocator(locator),row=publicRows.find(value=>sameLocator(value.locator,exact));if(row&&!seen.has(row.locator.messageId)){seen.add(row.locator.messageId);originals.push(row);}}}
            if(originals.length){
              message.text=originals.flatMap(row=>row.publicMessage.blocks.filter(block=>block.type==='text').map(block=>block.text)).join('');
              attachments.length=0;
              for(const row of originals)for(const [blockIndex,block] of row.publicMessage.blocks.entries())if(block.type==='attachment')attachments.push(await this.publicAttachment(record,row,blockIndex,block));
            }
          }
          if(attachments.length)message.attachments=attachments;
          let state=chatReducer({...record.chat,turns:[],activeTurn:undefined},{type:'chat/turnStarted',turnId:group.id,startedAt:group.startedAt??record.summary.createdAt,message} as any);
          const active:Active={agent,busy:true,lastUsed:0,turnId:group.id,tools:new Set(),permissions:new Map()};
          for(const update of group.updates)await this.update(record.uri,{sessionId:record.nativeSessionId,update} as SessionNotification,{active,emit:action=>{state=chatReducer(state,action as any);}});
          const action=group.recordedOnly||group.state==='complete'?{type:'chat/turnComplete',turnId:group.id,duration:0}:{type:'chat/error',turnId:group.id,duration:0,part:{kind:'error',error:{errorType:'NATIVE_OUTCOME_UNKNOWN',message:'Historical content is preserved; its execution outcome was not recorded.'}}};
          state=chatReducer(state,action as any);page.push(...state.turns);
        }
        turns=[...page,...turns];next=result.nextCursor??undefined;
      } while(next&&(limit===undefined||turns.length<limit));
      let nextCursor:string|undefined;
      if(next){nextCursor=randomUUID();this.nativeCursors.set(nextCursor,{chat:record.chat.resource,cursor:next,revision});if(this.nativeCursors.size>4096)this.nativeCursors.delete(this.nativeCursors.keys().next().value!);}
      // A cold copied/imported chat can expose canonical message locators before
      // any runtime is mounted. Retain the same negotiated ACP grant used by
      // live sessions only after the selected passive read has succeeded.
      const fresh=this.getRecord(record.uri);
      if(fresh&&fresh.engineId===record.engineId&&fresh.nativeSessionId===record.nativeSessionId&&fresh.workingDirectory===record.workingDirectory&&JSON.stringify((fresh.state._meta?.['amplifier.dev/acp'] as Json|undefined)?.capabilities)!==JSON.stringify(init.agentCapabilities)) {
        this.emit(record.uri,{type:'session/metaChanged',_meta:{...fresh.state._meta,'amplifier.dev/acp':{...(fresh.state._meta?.['amplifier.dev/acp'] as Json),capabilities:init.agentCapabilities}}} as StateAction);
      }
      return {turns,nextCursor,revision,diagnostics};
    } finally {this.passiveReads--;await agent.retire();}
  }
  private rememberMixedCursor(chat:string,page:{turns:Turn[];hasOlder:boolean;revision:string}) {
    if(!page.hasOlder||!page.turns.length)return;
    const token=randomUUID();this.mixedCursors.set(token,{chat,count:page.turns.length,first:page.turns[0].id,hash:turnIdentityHash(page.turns),revision:page.revision});
    if(this.mixedCursors.size>4096)this.mixedCursors.delete(this.mixedCursors.keys().next().value!);return token;
  }
  /** Only selected pages are read. Canonical order and live receipts have separate authority. */
  private async selectedHistory(record:SessionRecord,limit?:number) {
    const native=await this.nativeHistory(record,limit===undefined?undefined:limit*2),live=this.store.turns(record.chat.resource,limit);
    // A page containing only native-only rows has no proof of where an unmatched
    // host receipt belongs. Request a wider explicit view instead of scanning the
    // whole transcript, inventing timestamps, or treating omission as deletion.
    const liveIds=new Set(live.turns.map(turn=>turn.id));
    if(native.nextCursor&&native.turns.length&&live.turns.length&&!native.turns.some(turn=>liveIds.has(turn.id)))throw new RpcFault(-32013,'History ordering boundary is outside this view; subscribe with a wider view or explicitly request all retained history',{reason:'unindexed-ordering-boundary',available:false});
    const activeId=this.getRecord(record.uri)?.chat.activeTurn?.id;
    const indexed=this.store.db.prepare('SELECT payload FROM turns WHERE chat=? AND turn_id=?');
    const canonical=native.turns.filter(turn=>turn.id!==activeId).map(turn=>{const row=indexed.get(record.chat.resource,turn.id);return row?JSON.parse(String(row.payload)) as Turn:turn;});
    let merged:Turn[];try{merged=mergeHistoryTurns(canonical,live.turns);}catch(error){throw new RpcFault(-32013,'Native and host history have an unindexed ordering interval; preserve both sources and reconcile their boundary',{reason:'unindexed-ordering-boundary',available:false,detail:String(error)});}
    const turns=limit===undefined?merged:merged.slice(-limit);
    return {turns,hasOlder:!!native.nextCursor||!!live.before||merged.length>turns.length,revision:native.revision,diagnostics:native.diagnostics};
  }
  private async snapshot(uri:string,turns?:number):Promise<Snapshot> {
    let state:any;
    if(uri===ROOT)state=this.root();else if(this.watches.has(uri)){const {root,recursive}=this.watches.get(uri)!;state={root,recursive};}else if(uri.startsWith('ahp-terminal:/')){state=this.terminalState(uri);if(!state)throw new RpcFault(-32008,'Unknown terminal');}else {
      const record=await this.record(uri);
      if(uri===record.uri)state=record.state;
      else {
        const page=this.store.turns(uri,turns);
        if((record.chat._meta?.['amplifier.dev/history'] as Json)?.source==='native') {
          const previous=this.nativeWindows.get(uri),unbounded=turns===undefined||previous?.unbounded===true;
          const page=await this.selectedHistory(record,unbounded?undefined:Math.max(turns!,previous?.ids.length??0)),fresh=this.getRecord(record.uri)!;
          const nextCursor=this.rememberMixedCursor(uri,page),ids=page.turns.map(turn=>turn.id);
          if(previous?.ids.length){const offset=ids.indexOf(previous.ids[0]);if(offset>0&&turnIdentityHash(ids.slice(offset,offset+previous.ids.length))===turnIdentityHash(previous.ids))this.emit(uri,{type:'chat/turnsLoaded',turns:page.turns.slice(0,offset),turnsNextCursor:nextCursor} as StateAction);}
          this.nativeWindows.set(uri,{ids,unbounded});
          state={...fresh.chat,turns:page.turns,turnsNextCursor:nextCursor,_meta:{...fresh.chat._meta,'amplifier.dev/history':{source:'native',available:true,revision:page.revision,diagnostics:page.diagnostics}}};
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
    if(this.retentionChanging.has(uri))throw new RpcFault(-32011,'Selected session has an admitted retention operation');
    const snapshot=await this.snapshot(uri,turns);const attach=async()=>{if(this.retentionChanging.has(uri))throw new RpcFault(-32011,'Selected session has an admitted retention operation');peer.subscriptions.add(uri);this.refreshAgentInterest(uri);return snapshot;};const session=uri.replace('ahp-chat:','ahp-session:');return this.presentationSelections.has(session)?this.withLock(session,attach):attach();
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
      return {protocolVersion:'0.9.0',serverSeq:this.store.seq,defaultDirectory:pathToFileURL(this.defaultWorkingDirectory).href,serverInfo:{name:'amplifier-unified-host',version:'0.1.0'},snapshots,_meta:{...metadata,'amplifier.dev/host':{version:1,incarnation:this.store.incarnation,receipts:{method:'x-commandReceipt'},features:this.root()._meta['amplifier.dev/host'].features},...(this.managed?{'amplifier.dev/managedCreation':{version:1,method:'x-amplifier/managedSession',operations:['options','defaults','models','create','receipt'],passive:true,typedSelection:true}}:{}),'amplifier.dev/sessionLifecycle':{version:1,method:'x-amplifier/sessionLifecycle',deletion:'preserve-history',export:{pageBytes:65536}},...(this.config.capabilities?{'amplifier.dev/capabilities':this.config.capabilities.manifest}:{})}};
    }
    if(method==='reconnect') {
      if(peer.initialized)throw new RpcFault(-32600,'Reconnect must open a fresh connection');
      if(typeof p.clientId!=='string'||!Number.isSafeInteger(p.lastSeenServerSeq)||!Array.isArray(p.subscriptions))throw new RpcFault(-32602,'Invalid reconnect');
      if([...this.peers].some(other=>other!==peer&&other.clientId===p.clientId))throw new RpcFault(-32602,'Client identity already connected');
      peer.clientId=p.clientId;peer.initialized=true;
      const missing:string[]=[];
      if(p.subscriptions.length>(this.config.maxSubscriptions??64))throw new RpcFault(-32000,'Subscription capacity reached');
      for(const uri of p.subscriptions)try {if(this.retentionChanging.has(uri))throw new Error('Retention operation in progress');if(uri!==ROOT&&!this.watches.has(uri)&&!this.terminalState(uri))await this.record(uri);peer.subscriptions.add(uri);this.refreshAgentInterest(uri);}catch{missing.push(uri);}
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
      case 'unsubscribe':peer.subscriptions.delete(p.channel);this.refreshAgentInterest(p.channel);this.removeActiveClient(p.channel,peer.clientId);if(!this.hasSubscribers(p.channel)){this.loadedFloors.delete(p.channel);this.nativeWindows.delete(p.channel);this.watches.delete(p.channel);}return null;
      case 'listSessions': {
        const limit=bounded(p.limit,50,200);
        if(this.config.catalog) {const result=await this.withConversationCatalogRead(()=>this.config.catalog!.list({connectionId:peer.connectionId,limit,cursor:p.cursor,allowedWorkspaceRoots:this.roots,...(this.managed?{allowedManagedRoots:[this.managed.root]}:{})}));return {...result,items:result.items.filter(row=>!this.store.db.prepare('SELECT 1 FROM session_visibility WHERE uri=? AND deleted=1').get(row.uri)).map(row=>this.catalogSummary(row))};}
        const cursor=p.cursor?peer.cursors.get(p.cursor):undefined;if(p.cursor&&!cursor)throw new RpcFault(-32602,'Unknown cursor for this connection');
        const rows=this.store.list(limit+1,cursor as any),items=rows.slice(0,limit);let nextCursor;
        if(rows.length>limit){nextCursor=randomUUID();const last=items.at(-1)!;peer.cursors.set(nextCursor,{modified:last.modifiedAt,uri:last.resource});if(peer.cursors.size>256)peer.cursors.delete(peer.cursors.keys().next().value!);}
        return {items,nextCursor};
      }
      case 'createSession':return this.createSessionResource(p);
      case 'fetchTurns': {
        const record=await this.record(p.channel);if(p.channel!==record.chat.resource)throw new RpcFault(-32602,'fetchTurns requires chat channel');
        const mixed=this.mixedCursors.get(p.cursor);
        if(mixed){
          if(mixed.chat!==p.channel)throw new RpcFault(-32602,'History cursor belongs to another chat');
          const window=this.nativeWindows.get(p.channel),page=await this.selectedHistory(record,window?.unbounded?undefined:Math.max(mixed.count+50,window?.ids.length??0));
          const offset=page.turns.findIndex(turn=>turn.id===mixed.first);
          if(page.revision!==mixed.revision||offset<0||turnIdentityHash(page.turns.slice(offset,offset+mixed.count))!==mixed.hash)throw new RpcFault(-32013,'History changed; subscribe for a fresh canonical baseline before paging',{reason:'history-baseline-changed'});
          const nextCursor=this.rememberMixedCursor(p.channel,page);this.nativeWindows.set(p.channel,{ids:page.turns.map(turn=>turn.id),unbounded:window?.unbounded??false});
          this.emit(p.channel,{type:'chat/turnsLoaded',turns:page.turns.slice(0,offset),turnsNextCursor:nextCursor} as StateAction);return {};
        }
        const prefix=this.prefixCursors.get(p.cursor);if(prefix){if(prefix.chat!==p.channel)throw new RpcFault(-32602,'History prefix cursor belongs to another chat');const current=await this.inspectSessionHistory(record.uri),page=await this.nativeHistory(record,50,undefined,{beforeTurnId:prefix.beforeTurnId,expectedRevision:current.historyRevision});this.emit(p.channel,{type:'chat/turnsLoaded',turns:page.turns,turnsNextCursor:this.rememberPrefixCursor(record.chat.resource,page)} as StateAction);return {};}
        const native=this.nativeCursors.get(p.cursor);
        if(native&&native.chat===p.channel){const page=await this.nativeHistory(record,50,native.cursor);this.emit(p.channel,{type:'chat/turnsLoaded',turns:page.turns,turnsNextCursor:page.nextCursor} as StateAction);return {};}
        const cursor=this.cursors.get(p.cursor);if(!cursor||cursor.chat!==p.channel)throw new RpcFault(-32602,'Unknown history cursor; subscribe for current state');
        const page=this.store.turns(p.channel,50,cursor.before);
        this.loadedFloors.set(p.channel,Math.min(this.loadedFloors.get(p.channel)??Number.MAX_SAFE_INTEGER,page.first??Number.MAX_SAFE_INTEGER));
        this.emit(p.channel,{type:'chat/turnsLoaded',turns:page.turns,turnsNextCursor:this.turnCursor(p.channel,page.before)} as StateAction);return {};
      }
      case 'dispatchAction':await this.dispatch(peer,p);return null;
      case 'x-amplifier/managedSession':if(p.channel!==ROOT)throw new RpcFault(-32602,'Managed creation uses the root channel');if(p.operation==='options')return this.managedSessionOptions(p.args);if(p.operation==='defaults')return this.managedSessionDefaults(p.args);if(p.operation==='models')return this.managedSessionModels(p.args);if(p.operation==='create')return this.createManagedSession(p.args);if(p.operation==='receipt'&&Object.keys(p.args??{}).length===1)return this.managedSessionReceipt(p.args.commandId);throw new RpcFault(-32602,'Unknown managed creation operation');
      case 'x-amplifier/sessionLifecycle':return this.sessionLifecycleRequest(p.channel,p.operation,p.args??{},{actorId:peer.clientId!,clientId:peer.clientId!});
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
        if(typeof p.uri==='string'&&p.uri.startsWith('amplifier-export:/'))return {data:JSON.stringify(await this.readExportResource(p.uri)),encoding:'utf-8',contentType:'application/json'};
        const topic=this.capability(p.uri);
        if(topic){const data=await this.config.capabilities!.read({uri:p.uri,...topic,clientId:peer.clientId!});const json=JSON.stringify(data);if(Buffer.byteLength(json)>1024*1024)throw new RpcFault(-32000,'Capability exceeds bounded topic size');return {data:json,encoding:'utf-8',contentType:'application/json'};}
        const provider=this.resourceProvider(p.uri);if(provider?.read)return provider.read(p,{clientId:peer.clientId!});
        if(typeof p.uri==='string'&&p.uri.startsWith('file:')){const path=await this.resourcePath(p.uri),info=await stat(path);if(info.size>16*1024*1024)throw new RpcFault(-32000,'Resource exceeds read budget');const body=await readFile(path);return {data:body.toString(p.encoding==='utf-8'?'utf8':'base64'),encoding:p.encoding==='utf-8'?'utf-8':'base64'};}
        if(typeof p.uri!=='string'||!/^ahp-content:\/[a-f0-9]{64}$/.test(p.uri))throw new RpcFault(-32009,'Only host-issued content resources are readable');
        const key=p.uri.slice('ahp-content:/'.length),body=await readFile(join(this.config.stateDirectory,'content',key));
        const metadata=JSON.parse(await readFile(join(this.config.stateDirectory,'content',key+'.json'),'utf8'));
        return {data:body.toString(p.encoding==='utf-8'?'utf8':'base64'),encoding:p.encoding==='utf-8'?'utf-8':'base64',contentType:metadata.contentType};
      }
      case 'resourceWrite':return this.intake.run(async()=>{const provider=this.resourceProvider(p.uri);if(provider?.write)return provider.write(p,{clientId:peer.clientId!});throw new RpcFault(-32009,'No authorized resource writer is registered for this URI');});
      default:throw new RpcFault(-32601,`Unsupported AHP method: ${method}`);
    }
  }
  private async managedAgent<T>(engineId:string,work:(agent:AcpProcess)=>Promise<T>):Promise<T>{
    const engine=this.config.engines.find(e=>e.id===engineId);if(!engine)throw new RpcFault(-32602,'Unknown configured provider',{executed:false});
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive native capacity reached',{executed:false});
    this.passiveReads++;const agent=new AcpProcess(engine,this.defaultWorkingDirectory,{update:async()=>{throw new RpcFault(-32009,'Passive creation cannot stream execution');},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive creation cannot use client effects');}});
    try{await agent.initialize();const capability=(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.managedCreation;if(capability?.version!==1||capability.passive!==true||capability.configurationScope!=='global-and-session'||capability.typedSelection!==true)throw new RpcFault(-32601,'Configured engine does not support passive managed creation',{executed:false});return await work(agent);}finally{this.passiveReads--;await agent.retire();}
  }
  private managedNativeParams(receipt:Json,operation:string):Json{return {operation,sessionId:receipt.marker.id,cwd:receipt.marker.workspace,commandId:receipt.commandId,allocationHash:receipt.marker.allocationHash,...(operation==='create'?Object.fromEntries(Object.entries(receipt.request).filter(([key])=>['title','bundle','bundleRevision','selection'].includes(key))):{})};}
  private async confirmManaged(receipt:Json,proof:Json){
    const native=proof?.result,location=this.managed!.location(receipt);
    if(proof?.commandId!==receipt.commandId||proof.status!=='completed'||native?.sessionId!==location.allocationId||native.historyCwd!==receipt.marker.workspace||native.executionDirectory!==receipt.marker.workspace||native.creationConfirmed!==true||native.workReplayed!==false||native.runtimeStarted!==false||native.configurationScope!=='global-and-session'||managedHash(native.location)!==managedHash(location))throw new RpcFault(-32011,'Native managed creation proof is unavailable or differs; original allocation preserved');
    if(receipt.copySource&&managedHash(native.source)!==managedHash(receipt.copySource))throw new RpcFault(-32011,'Managed copy source differs from its retained command authority');
    await this.managed!.inspect(receipt);
    const existing=this.getRecord(receipt.session),indexed=await this.config.catalog?.get(receipt.session);
    for(const row of [existing,indexed])if(row&&(row.nativeSessionId!==location.allocationId||row.workingDirectory!==receipt.marker.workspace||row.engineId!==receipt.request.provider))throw new RpcFault(-32011,'Managed session identity collides with an existing mapping');
    if(!existing){const timestamp=now(),meta={'amplifier.dev/location':location},chat:ChatState={resource:chatURI(receipt.session),title:receipt.request.title??'New chat',status:1,modifiedAt:timestamp,turns:[],...(native.source?.operation==='fork'?{_meta:{'amplifier.dev/history':{source:'native',available:true}}}:{})};
      const summary:SessionSummary={resource:receipt.session,provider:receipt.request.provider,title:chat.title,status:1,createdAt:timestamp,modifiedAt:timestamp,workingDirectories:[pathToFileURL(receipt.marker.workspace).href],_meta:meta};
      const state:SessionState={provider:receipt.request.provider,title:chat.title,status:1,lifecycle:SessionLifecycle.Ready,activeClients:[],chats:[this.chatSummary(chat)],defaultChat:chat.resource,workingDirectories:summary.workingDirectories,_meta:meta};
      this.store.save({uri:receipt.session,engineId:receipt.request.provider,nativeSessionId:location.allocationId,workingDirectory:receipt.marker.workspace,executionDirectory:receipt.marker.workspace,summary,state,chat});
    }
    const result={session:receipt.session,uri:receipt.session,creationConfirmed:true,location,configurationScope:'global-and-session',runtimeStarted:false,workReplayed:false,receipt:receipt.commandId};
    // Native creation is complete; retrying catalog projection can never replay it.
    await this.syncCatalog(this.getRecord(receipt.session)!);this.managed!.settle(receipt.commandId,'completed',result);
    if(receipt.copySource?.operation==='configuration-clone'&&this.store.db.prepare('SELECT 1 FROM creation_keys WHERE command_id=? AND uri=?').get(receipt.commandId,receipt.session))this.store.finish(receipt.commandId,'completed');
    if(!existing){this.emit(ROOT,{type:'root/activeSessionsChanged',activeSessions:this.store.count} as StateAction);this.notify('root/sessionAdded',{channel:ROOT,summary:this.getRecord(receipt.session)!.summary});}
    return result;
  }
  /** Selected configured engine choices only; no allocation or runtime preparation. */
  async managedSessionOptions(input:{provider?:string}={}){
    if(!this.managed)throw new RpcFault(-32601,'Managed allocation is not configured',{executed:false});
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='provider')||input.provider!==undefined&&(typeof input.provider!=='string'||!input.provider||input.provider.length>200))throw new RpcFault(-32602,'Configured provider selector required',{executed:false});
    const provider=input.provider??this.config.engines[0].id;
    return this.intake.inspectOnly(()=>this.managedAgent(provider,async agent=>{const value:Json=await agent.client.extMethod('_amplifier/managed',{operation:'options'});if(value.version!==1||value.runtimeStarted!==false||value.configurationScope!=='global-and-session'||!Array.isArray(value.bundles)||value.bundles.length>64||value.bundles.some((row:Json)=>typeof row.id!=='string'||!row.id||row.id.length>200||row.name!==row.id||typeof row.revision!=='string'||!/^[a-f0-9]{64}$/.test(row.revision)))throw new RpcFault(-32000,'Invalid configured managed choices');return {provider,version:1,bundles:value.bundles,defaultBundle:{kind:'engine-default'},configurationScope:'global-and-session',runtimeStarted:false};}));
  }
  async managedSessionDefaults(input:{provider?:string;bundle?:string;bundleRevision?:string}={}){
    if(!this.managed)throw new RpcFault(-32601,'Managed allocation is not configured',{executed:false});
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['provider','bundle','bundleRevision'].includes(k))||input.provider!==undefined&&(typeof input.provider!=='string'||!input.provider||input.provider.length>200)||input.bundle!==undefined&&(typeof input.bundle!=='string'||!input.bundle||input.bundle.length>200||! /^[a-f0-9]{64}$/.test(input.bundleRevision??''))||input.bundle===undefined&&input.bundleRevision!==undefined)throw new RpcFault(-32602,'Exact configured provider/bundle choice required',{executed:false});
    const provider=input.provider??this.config.engines[0].id;
    return this.intake.inspectOnly(()=>this.managedAgent(provider,async agent=>{if((agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.managedCreation?.defaults?.version!==1)throw new RpcFault(-32601,'Engine does not expose managed defaults',{executed:false});const {provider:_,...args}=input;const value:Json=await agent.client.extMethod('_amplifier/managed',{operation:'defaults',...args});if(value.runtimeStarted!==false||value.configurationScope!=='global-and-session'||!Array.isArray(value.providers)||value.providers.length>64||Buffer.byteLength(JSON.stringify(value))>262144||input.bundle!==undefined&&(value.bundleSelection?.id!==input.bundle||value.bundleSelection?.revision!==input.bundleRevision))throw new RpcFault(-32000,'Invalid managed provider defaults');return {provider,...value};}));
  }
  /** Explicit selected-bundle model discovery; no allocation or runtime mount. */
  async managedSessionModels(input:{provider?:string;bundle?:string;bundleRevision?:string;instance:string;limit?:number;cursor?:string}){
    if(!this.managed)throw new RpcFault(-32601,'Managed allocation is not configured',{executed:false});
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['provider','bundle','bundleRevision','instance','limit','cursor'].includes(k))||typeof input.instance!=='string'||!input.instance||input.instance.length>200||input.provider!==undefined&&(typeof input.provider!=='string'||!input.provider||input.provider.length>200)||input.bundle!==undefined&&(typeof input.bundle!=='string'||!input.bundle||input.bundle.length>200||! /^[a-f0-9]{64}$/.test(input.bundleRevision??''))||input.bundle===undefined&&input.bundleRevision!==undefined||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)||input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>1024))throw new RpcFault(-32602,'Exact configured bundle/provider instance and bounded model page required',{executed:false});
    const provider=input.provider??this.config.engines[0].id;
    return this.intake.inspectOnly(()=>this.managedAgent(provider,async agent=>{
      if((agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.managedCreation?.models?.version!==1)throw new RpcFault(-32601,'Engine does not expose selected managed model discovery',{executed:false});
      const {provider:_,...args}=input;const value:Json=await agent.client.extMethod('_amplifier/managed',{operation:'models',...args});
      if(value.runtimeStarted!==false||value.globalOnly!==true||value.configurationScope!=='global-and-session'||value.instance!==input.instance||typeof value.modelsSupported!=='boolean'||!Array.isArray(value.models)||value.models.length>(input.limit??50)||value.models.some((row:Json)=>!row||typeof row.id!=='string'||!row.id||row.id.length>512)||typeof value.revision!=='string'||! /^[a-f0-9]{64}$/.test(value.revision)||value.nextCursor!==undefined&&(typeof value.nextCursor!=='string'||value.nextCursor.length>1024)||Buffer.byteLength(JSON.stringify(value))>524288||input.bundle!==undefined&&(value.bundleSelection?.id!==input.bundle||value.bundleSelection?.revision!==input.bundleRevision)||input.bundle===undefined&&value.bundleSelection?.kind!=='engine-default')throw new RpcFault(-32000,'Invalid managed model catalog');
      return {provider,...value};
    }));
  }
  /** Allocates only upon an explicit creation command; never mounts a native runtime. */
  async createManagedSession(input:ManagedSessionCreate){
    if(!this.managed)throw new RpcFault(-32601,'Managed chat allocation is not configured',{executed:false});
    const request={...input,provider:input?.provider??this.config.engines[0].id};this.managed.validate(request);
    return this.intake.run(()=>this.withLock(request.session,async()=>{
      const prior=this.managed!.receipt(request.commandId);
      if(prior){if(prior.signature!==managedHash(request))throw new RpcFault(-32011,'Managed command conflicts with its original request',{executed:false});if(prior.state==='completed')return prior.result;throw new RpcFault(-32011,'Managed creation outcome is unresolved; inspect its exact receipt without replay',{receipt:request.commandId,outcome:'unknown'});}
      if(this.getRecord(request.session))throw new RpcFault(-32003,'Session already exists',{executed:false});
      return this.managedAgent(request.provider,async agent=>this.withLock('@directory-reservations',async()=>{
        const receipt=this.managed!.reserve(request);
        try{await this.managed!.allocate(receipt);this.managed!.settle(request.commandId,'dispatching');const proof:Json=await agent.client.extMethod('_amplifier/managed',this.managedNativeParams(receipt,'create'));return await this.confirmManaged(receipt,proof);}
        catch(error){this.managed!.settle(request.commandId,'unknown');throw new RpcFault(-32011,(error as Error).message,{receipt:request.commandId,outcome:'unknown',allocationOccurred:true});}
      }));
    }));
  }
  /** Passive exact native proof can repair a lost acknowledgement; never repeats creation. */
  async managedSessionReceipt(commandId:string){
    if(!this.managed)throw new RpcFault(-32601,'Managed allocation is not configured');const receipt=this.managed.receipt(commandId);if(!receipt)return null;
    if(receipt.state==='completed')return {commandId,status:'completed',result:receipt.result,replayed:false};
    return this.intake.inspectOnly(()=>this.withLock(receipt.session,async()=>{
      const current=this.managed!.receipt(commandId)!;if(current.state==='completed')return {commandId,status:'completed',result:current.result,replayed:false};
      try{await this.managed!.inspect(current);return await this.managedAgent(current.request.provider,async agent=>{const proof:Json=await agent.client.extMethod('_amplifier/managed',this.managedNativeParams(current,'receipt'));if(proof?.status==='completed'){if(this.intake.inspect().intakeClosed)return {commandId,status:'unknown',session:current.session,nativeStatus:'completed',metadataRepairPending:true,replayed:false};return this.intake.run(async()=>({commandId,status:'completed',result:await this.confirmManaged(current,proof),replayed:false}));}return {commandId,status:'unknown',session:current.session,nativeStatus:proof?.status??'not-recorded',replayed:false};});}
      catch(error){return {commandId,status:'unknown',session:current.session,detail:(error as Error).message,replayed:false};}
    }));
  }
  private async createSessionResource(p:Json,creation?:{sessionId:string;source:Json;commandId:string}) {
    return this.intake.run(async()=>{
    this.guardSessionLifecycle(p.channel);
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
      catch(error){this.store.finish(creationCommand,'unknown',(error as Error).message);this.emit(p.channel,{type:'session/creationFailed',error:{errorType:'SESSION_CREATION_FAILED',message:(error as Error).message}} as StateAction);throw error;}
      await this.syncCatalog(this.getRecord(p.channel)!);return null;
    });
      });
  }
  private rememberPrefixCursor(chat:string,page:{turns:Turn[];nextCursor?:string}) {
    if(!page.nextCursor||!page.turns.length)return;
    const id=randomUUID();this.prefixCursors.set(id,{chat,beforeTurnId:page.turns[0].id});if(this.prefixCursors.size>4096)this.prefixCursors.delete(this.prefixCursors.keys().next().value!);return id;
  }
  private confirmHistoryRevision(uri:string,active:Active,event:Json) {
    const revision=active.historyRevision;if(!active.busy||!revision||revision.confirmed)return;
    const args=revision.args,last=revision.prefix.turns.at(-1)?.id??null;
    if(event.inputId!==active.turnId||event.operationId!==args.operationId||event.targetMessageId!==args.targetMessageId||event.previousRevision!==args.expectedHistoryRevision||typeof event.beforeTurnId!=='string'||event.retainedThroughTurnId!==last||typeof event.historyRevision!=='string'||event.eventsPreserved!==true)throw new Error('Native history revision proof does not match the admitted boundary');
    const record=this.getRecord(uri)!,chat=record.chat.resource;
    this.store.transaction(()=>{
      const target=this.store.db.prepare('SELECT ordinal FROM turns WHERE chat=? AND turn_id=?').get(chat,event.beforeTurnId);
      this.store.db.prepare('INSERT INTO history_edit_archives SELECT ?,chat,ordinal,turn_id,payload FROM turns WHERE chat=? AND ordinal>=?').run(args.operationId,chat,target?.ordinal??0);
      this.store.db.prepare('DELETE FROM turns WHERE chat=? AND ordinal>=?').run(chat,target?.ordinal??0);
      this.store.db.prepare('DELETE FROM coordination_results WHERE chat=? AND sequence>=?').run(chat,target?.ordinal??0);
      this.store.db.prepare("UPDATE history_edits SET status='rewritten' WHERE operation_id=?").run(args.operationId);
      record.chat._meta={...record.chat._meta,'amplifier.dev/history':{source:'native',available:true,revision:event.historyRevision}};this.store.save(record);
      this.emit(chat,{type:'chat/truncated'} as StateAction);
      this.emit(chat,{type:'chat/turnsLoaded',turns:revision.prefix.turns,turnsNextCursor:this.rememberPrefixCursor(chat,revision.prefix)} as StateAction);
    });
    for(const [id,cursor] of this.nativeCursors)if(cursor.chat===chat)this.nativeCursors.delete(id);
    for(const [id,cursor] of this.cursors)if(cursor.chat===chat)this.cursors.delete(id);
    this.loadedFloors.delete(chat);this.nativeWindows.delete(chat);for(const [id,cursor] of this.mixedCursors)if(cursor.chat===chat)this.mixedCursors.delete(id);revision.confirmed=true;this.projectPendingTurn(uri,active);
  }
  /** Canonical native rewind plus one replacement execution; never accepts a host transcript. */
  async reviseHistory(session:string,input:{commandId:string;operationId:string;targetMessageId:string;expectedHistoryRevision:string;text:string}) {
    return this.intake.run(async()=>{
    if(!input||Object.keys(input).some(key=>!['commandId','operationId','targetMessageId','expectedHistoryRevision','text'].includes(key))||![input.commandId,input.operationId,input.targetMessageId,input.expectedHistoryRevision].every(value=>typeof value==='string'&&value.length>0&&value.length<=200)||typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>1024*1024)throw new RpcFault(-32602,'Exact bounded native history boundary, revision and replacement input required');
    const record=await this.record(session);
    return this.withLock(record.uri,async()=>{
      if(this.store.receipt(input.commandId)||this.store.db.prepare('SELECT 1 FROM history_edits WHERE operation_id=?').get(input.operationId))throw new RpcFault(-32011,'History revision was already attempted; inspect its original receipts without replay');
      try{await this.admitTurn(record,record.chat.resource,{type:'chat/turnStarted',turnId:input.commandId,startedAt:now(),message:{text:input.text,origin:{kind:'user'},_meta:{'amplifier.dev/input':{inputOrigin:'history-edit',historyOperationId:input.operationId,editedMessageId:input.targetMessageId}}}} as any,{clientId:'host:history-edit',clientSeq:this.store.extensionSequence('host:history-edit')},{operation:'history.revise',args:{operationId:input.operationId,targetMessageId:input.targetMessageId,expectedHistoryRevision:input.expectedHistoryRevision,text:input.text}});return {accepted:true,turnId:input.commandId,receipt:this.store.receipt(input.commandId)};}
      catch(error){if(this.store.receipt(input.commandId))throw new RpcFault(-32011,(error as Error).message,{receipt:input.commandId,outcome:'unknown'});return {accepted:false,executed:false,reason:(error as Error).message};}
    });
      });
  }
  private transferFence(session:string):Json|undefined {
    const row=this.store.db.prepare("SELECT transfer_id,source,destination,status,payload FROM transfer_fences WHERE session=? AND status NOT IN ('cancelled','rejected','adopted')").get(session);
    return row?{transferId:row.transfer_id,source:row.source,destination:row.destination,status:row.status,...JSON.parse(String(row.payload))}:undefined;
  }
  private guardTransfer(session:string) {if(this.transferFence(session))throw new RpcFault(-32011,'Session transfer is fenced; inspect its signed receipt without replay',{executed:false});}
  private transferInput(input:TransferCommand) {
    if(!this.config.transferIdentity)throw new RpcFault(-32601,'This host has no configured transfer identity',{executed:false});
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>200||typeof input.transferId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.transferId))throw new RpcFault(-32602,'A bounded command ID and canonical transfer UUID are required',{executed:false});
  }
  private async transferAgent<T>(record:SessionRecord,work:(agent:AcpProcess)=>Promise<T>) {
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive native read capacity reached',{executed:false});
    const engine=this.config.engines.find(engine=>engine.id===record.engineId);if(!engine||!record.nativeSessionId)throw new RpcFault(-32601,'Native transfer identity is unavailable',{executed:false});
    this.passiveReads++;const agent=new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive native inspection cannot perform filesystem or terminal effects');}});
    try{const init=await agent.initialize(),capability=(init.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.transfer;if(capability?.version!==1||capability.passiveInspection!==true)throw new RpcFault(-32601,'Agent does not advertise passive native transfer authority',{executed:false});return await work(agent);}finally{this.passiveReads--;await agent.retire();}
  }
  private async nativeTransfer(agent:AcpProcess,record:SessionRecord,operation:string,transferId:string):Promise<Json> {
    const result=await agent.client.extMethod('_amplifier/transfer',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,operation,args:{transferId}});
    if(!result||typeof result!=='object'||Array.isArray(result)||Buffer.byteLength(JSON.stringify(result))>65536)throw new Error('Invalid or oversized native transfer proof');return result;
  }
  private verifyTransferProof(record:SessionRecord,transferId:string,source:string,destination:string,proof:Json,phase:string) {
    if(!proof||proof.version!==1||proof.transferId!==transferId||proof.nativeSessionId!==record.nativeSessionId||proof.historyCwd!==record.workingDirectory||proof.executionDirectory!==(record.executionDirectory??record.workingDirectory)||proof.source!==source||proof.destination!==destination||proof.phase!==phase||proof.inputsReplayed!==false||proof.authority!=='foundation-transfer-fence')throw new Error('Native transfer proof does not match the exact bound session and hosts');
    if(phase==='source-fenced'||phase==='source-committed'){const fence=proof.fence;if(!fence||fence.transfer_id!==transferId||fence.role!=='source'||fence.destination_host!==destination||phase==='source-committed'&&fence.phase!=='committed')throw new Error('Exact native source writer fence was not confirmed');}
  }
  private completeTransfer(record:SessionRecord,entry:Json,proof:Json) {
    const result={session:record.uri,transferId:entry.transfer_id,phase:proof.phase,inputsReplayed:false,receipt:entry.command_id,nativeReceipt:proof};
    this.store.transaction(()=>{if(entry.operation==='source.fence'&&this.store.db.prepare('SELECT status FROM transfer_commands WHERE command_id=?').get(entry.command_id)?.status!=='completed'){this.store.bump(record.uri,'execution');this.store.bump(record.uri,'interruption');}this.store.db.prepare('UPDATE transfer_commands SET status=\'completed\',result=? WHERE command_id=?').run(JSON.stringify(result),entry.command_id);this.store.db.prepare('UPDATE transfer_fences SET status=?,payload=? WHERE session=? AND transfer_id=?').run(proof.phase,JSON.stringify({nativeReceipt:proof}),record.uri,entry.transfer_id);this.store.finish(String(entry.command_id),'completed');});return result;
  }
  private async sourceTransfer(session:string,operation:'source.fence'|'source.commit'|'source.cancel',input:BeginTransfer|TransferCommand) {
    return this.intake.run(async()=>{
    this.transferInput(input);const record=await this.record(session);
    if(record.state._meta?.['amplifier.dev/location'])throw new RpcFault(-32601,'Managed transfer requires destination allocation adoption',{executed:false});
    return this.withLock(record.uri,async()=>{
      if(this.closing)throw new RpcFault(-32008,'Host is shutting down',{executed:false});
      const previous=this.store.db.prepare('SELECT * FROM transfer_commands WHERE command_id=?').get(input.commandId),payload=JSON.stringify(input);
      if(previous){if(previous.session!==record.uri||previous.operation!==operation||previous.payload!==payload)throw new RpcFault(-32011,'Transfer command conflicts with its original request',{executed:false});if(previous.status==='completed')return JSON.parse(String(previous.result));throw new RpcFault(-32011,'Transfer already attempted; inspect its original receipt without replay',{receipt:input.commandId,outcome:previous.status});}
      const current=this.getRecord(record.uri)!,fence=this.transferFence(record.uri),source=this.config.transferIdentity!,destination=operation==='source.fence'?(input as BeginTransfer).destination:fence?.destination;
      if(operation==='source.fence'){
        if(typeof destination!=='string'||!/^[a-f0-9]{64}$/.test(destination)||destination===source||!Number.isSafeInteger((input as BeginTransfer).expectedExecutionRevision))throw new RpcFault(-32602,'Exact remote fingerprint and execution revision required',{executed:false});
        this.guardSessionLifecycle(record.uri);
        if(this.store.revisions(record.uri).executionRevision!==(input as BeginTransfer).expectedExecutionRevision||this.relocationFence(record.uri)||this.store.unknown(current.chat.resource)||current.chat.activeTurn||this.active.get(record.uri)?.busy||this.starting.has(record.uri))throw new RpcFault(-32011,'Session must be conclusively idle at the expected execution revision',{executed:false});
      }else if(!fence||fence.transferId!==input.transferId||fence.source!==source||fence.status==='source-committed'||operation==='source.commit'&&fence.status!=='source-fenced')throw new RpcFault(-32011,'No matching confirmed reversible source transfer fence',{executed:false});
      return this.transferAgent(current,async agent=>{
        const entry={command_id:input.commandId,session:record.uri,transfer_id:input.transferId,operation,payload};
        this.store.transaction(()=>{this.store.admission(record.uri,{operation,input},input.commandId,'host:transfer',this.store.extensionSequence('host:transfer'));this.store.db.prepare('INSERT INTO transfer_commands(command_id,session,transfer_id,operation,status,payload) VALUES(?,?,?,?,?,?)').run(input.commandId,record.uri,input.transferId,operation,'dispatching',payload);this.store.db.prepare('INSERT INTO transfer_fences VALUES(?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET transfer_id=excluded.transfer_id,source=excluded.source,destination=excluded.destination,status=excluded.status,payload=excluded.payload').run(record.uri,input.transferId,source,destination,'dispatching',JSON.stringify({commandId:input.commandId,operation}));this.store.finish(input.commandId,'dispatching');});
        let nativeDispatched=false;
        try{
          await this.quiesceLifecycle(current);
          this.holdQueue(current.chat.resource,'session-transfer');nativeDispatched=true;
          const proof=await this.nativeTransfer(agent,current,operation,input.transferId),phase={'source.fence':'source-fenced','source.commit':'source-committed','source.cancel':'cancelled'}[operation];
          this.verifyTransferProof(current,input.transferId,source,destination,proof,phase);
          if(operation==='source.cancel'){const inspected=await this.nativeTransfer(agent,current,'inspect',input.transferId);if(inspected.fence!==null)throw new Error('Native source fence remains active');this.verifyTransferProof(current,input.transferId,source,destination,inspected.receipt,phase);}
          return this.completeTransfer(current,entry,proof);
        }catch(error){
          const known=!nativeDispatched&&((error as RpcFault).data as Json|undefined)?.executed===false,status=known?'failed':'unknown';
          this.store.transaction(()=>{this.store.db.prepare('UPDATE transfer_commands SET status=? WHERE command_id=?').run(status,input.commandId);this.store.db.prepare('UPDATE transfer_fences SET status=? WHERE session=?').run(known&&operation==='source.fence'?'rejected':'unknown',record.uri);this.store.finish(input.commandId,status,(error as Error).message);});
          throw new RpcFault(-32011,(error as Error).message,{receipt:input.commandId,outcome:status,...(known?{executed:false}:{})});
        }
      });
    });
      });
  }
  /** Source admission is fenced durably before native quiescence or any transfer effect. */
  async beginTransfer(session:string,input:BeginTransfer) {return this.sourceTransfer(session,'source.fence',input);}
  async commitTransfer(session:string,input:TransferCommand) {return this.sourceTransfer(session,'source.commit',input);}
  async cancelTransfer(session:string,input:TransferCommand) {return this.sourceTransfer(session,'source.cancel',input);}
  /** Inspection may confirm durable native proof; it never resubmits a transition. */
  async inspectTransfer(session:string,transferId:string) {
    this.transferInput({commandId:'inspect',transferId});const record=await this.record(session);
    return this.withLock(record.uri,()=>this.transferAgent(record,async agent=>{
      const result=await this.nativeTransfer(agent,record,'inspect',transferId),fence=this.transferFence(record.uri);
      if(result.receipt&&fence?.transferId===transferId){
        const phase=result.receipt.phase,operations:Record<string,string>={'source-fenced':'source.fence','source-committed':'source.commit',cancelled:'source.cancel'};
        if(operations[phase]){this.verifyTransferProof(record,transferId,fence.source,fence.destination,result.receipt,phase);if(phase==='cancelled'?result.fence!==null:JSON.stringify(result.fence)!==JSON.stringify(result.receipt.fence))throw new Error('Transfer receipt differs from the actual native writer fence');
          const entry=this.store.db.prepare('SELECT * FROM transfer_commands WHERE session=? AND transfer_id=? AND operation=? ORDER BY rowid DESC LIMIT 1').get(record.uri,transferId,operations[phase]);
          if(entry&&fence.status!=='source-committed')this.completeTransfer(record,entry,result.receipt);
        }
        if(phase==='activated'){
          const entry=this.store.db.prepare("SELECT * FROM transfer_commands WHERE session=? AND transfer_id=? AND operation='destination.adopt' ORDER BY rowid DESC LIMIT 1").get(record.uri,transferId);
          if(entry){const args=JSON.parse(String(entry.payload));this.verifyTransferProof(record,transferId,args.source,args.destination,result.receipt,'activated');if(result.fence!==null||result.receipt.releaseHash!==args.releaseHash||args.destination!==this.config.transferIdentity)throw new Error('Destination activation does not match the reserved release');
            await this.syncCatalog(record);const adopted={uri:record.uri,nativeSessionId:record.nativeSessionId,transferId,adopted:true,inputsReplayed:false,receipt:entry.command_id};
            this.store.transaction(()=>{this.store.db.prepare("UPDATE transfer_commands SET status='completed',result=? WHERE command_id=?").run(JSON.stringify(adopted),entry.command_id);this.store.db.prepare("UPDATE transfer_fences SET status='adopted',payload=? WHERE session=?").run(JSON.stringify({nativeReceipt:result.receipt}),record.uri);this.store.finish(String(entry.command_id),'completed');});this.notify('root/sessionAdded',{channel:ROOT,summary:record.summary});
          }
        }
      }
      return {session:record.uri,transferId,hostFence:this.transferFence(record.uri)??null,native:result,replayed:false};
    }));
  }
  private validateImport(input:AdoptImport) {
    const keys=['commandId','session','engineId','workingDirectory','importCommandId','sourceSha256','previewHash'];
    if(!input||Object.keys(input).some(key=>!keys.includes(key))||keys.some(key=>typeof (input as unknown as Json)[key]!=='string'||!(input as unknown as Json)[key])||input.commandId.length>200||input.importCommandId.length>200||input.engineId.length>128||!/^ahp-session:\/[A-Za-z0-9_-]{1,200}$/.test(input.session)||!isAbsolute(input.workingDirectory)||!/^[a-f0-9]{64}$/.test(input.sourceSha256)||!/^[a-f0-9]{64}$/.test(input.previewHash))throw new RpcFault(-32602,'Bounded exact import receipt identity required',{executed:false});
  }
  private async verifiedImport(input:AdoptImport):Promise<Json> {
    const engine=this.config.engines.find(engine=>engine.id===input.engineId);
    if(!engine)throw new RpcFault(-32601,'Import engine is not configured',{executed:false});
    const cwd=await this.workspace(pathToFileURL(input.workingDirectory).href);
    if(cwd!==input.workingDirectory)throw new RpcFault(-32602,'Import workspace must be canonical',{executed:false});
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive native read capacity reached',{executed:false});
    this.passiveReads++;
    const agent=new AcpProcess(engine,cwd,{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Import receipt inspection cannot perform filesystem or terminal effects');}});
    try {
      const initialized=await agent.initialize(),capability=(initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.admin?.historyImport;
      if(capability?.version!==1||capability.staged!==true)throw new RpcFault(-32601,'Configured agent does not advertise staged native history import',{executed:false});
      const receipt=await agent.client.extMethod('_amplifier/admin',{cwd,operation:'history.import.receipt',args:{commandId:input.importCommandId}}),proof=receipt?.result as Json|undefined;
      if(!receipt||Buffer.byteLength(JSON.stringify(receipt))>32768||receipt.commandId!==input.importCommandId||receipt.operation!=='history.import.commit'||receipt.status!=='succeeded'||receipt.replayed!==false||!proof||proof.importCommandId!==input.importCommandId||proof.creationConfirmed!==true||proof.workReplayed!==false||proof.sourceSha256!==input.sourceSha256||proof.previewHash!==input.previewHash||proof.historyCwd!==cwd||proof.executionDirectory!==cwd||typeof proof.nativeSessionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(proof.nativeSessionId)||typeof proof.historyRevision!=='string'||!proof.historyRevision||proof.historyRevision.length>512||typeof proof.title!=='string'||proof.title.length>1000)throw new RpcFault(-32011,'Exact successful native import creation receipt is unavailable',{executed:false});
      // Persist only the verified creation tuple; an extension may gain other
      // fields later, but transcript/source payloads never belong in this journal.
      return {nativeSessionId:proof.nativeSessionId,historyCwd:proof.historyCwd,executionDirectory:proof.executionDirectory,historyRevision:proof.historyRevision,title:proof.title,creationConfirmed:true,workReplayed:false,sourceSha256:proof.sourceSha256,previewHash:proof.previewHash,importCommandId:proof.importCommandId};
    }finally{this.passiveReads--;await agent.retire();}
  }
  private async finishImportAdoption(entry:Json,proof:Json) {
    const input=JSON.parse(String(entry.payload)) as AdoptImport;
    return this.withLock('@directory-reservations',async()=>{
      await this.workspace(pathToFileURL(input.workingDirectory).href);
      let uri=String(entry.session),existing=this.getRecord(uri),timestamp=now(),title=proof.title,createdAt=timestamp,modifiedAt=timestamp,status=SessionStatus.Idle;
      const catalogRecord:CatalogRecord={uri,engineId:input.engineId,nativeSessionId:proof.nativeSessionId,workingDirectory:input.workingDirectory,title:proof.title,createdAt:timestamp,modifiedAt:timestamp,kind:'root',availability:'available',workspaceAvailability:'present'};
      // Native import and background discovery can race. The catalog atomically
      // claims an exact native identity, reusing an already discovered URI.
      if(this.config.catalog){
        if(!this.config.catalog.claimNative)throw new RpcFault(-32601,'Catalog lacks atomic native import registration');
        const claimed=await this.config.catalog.claimNative({record:catalogRecord,commandId:String(entry.command_id),evidence:'verified-native-import'});
        if(!claimed||claimed.engineId!==input.engineId||claimed.nativeSessionId!==proof.nativeSessionId||claimed.workingDirectory!==input.workingDirectory||!/^ahp-session:\/[A-Za-z0-9_-]{1,200}$/.test(claimed.uri))throw new Error('Catalog returned a different native import identity');
        uri=claimed.uri;existing=this.getRecord(uri);title=claimed.title;createdAt=claimed.createdAt;modifiedAt=claimed.modifiedAt;status=SessionStatus.Idle|(claimed.isArchived?SessionStatus.IsArchived:0);
      }
      if(existing&&(existing.engineId!==input.engineId||existing.nativeSessionId!==proof.nativeSessionId||existing.workingDirectory!==input.workingDirectory))throw new Error('Import target already maps to a different native identity');
      const duplicates=this.store.db.prepare('SELECT uri FROM sessions WHERE engine_id=? AND native_id=? AND cwd=? AND uri<>? LIMIT 1').get(input.engineId,proof.nativeSessionId,input.workingDirectory,uri);
      if(duplicates)throw new Error('Native import already has another host mapping');
      const summary:SessionSummary={resource:uri,provider:input.engineId,title,status,createdAt,modifiedAt,workingDirectories:[pathToFileURL(input.workingDirectory).href]};
      const chat:ChatState={resource:chatURI(uri),title,status,modifiedAt,turns:[],_meta:{'amplifier.dev/history':{source:'native',available:true},'amplifier.dev/import':{sourceSha256:input.sourceSha256,workReplayed:false}}};
      const record:SessionRecord=existing??{uri,engineId:input.engineId,nativeSessionId:proof.nativeSessionId,workingDirectory:input.workingDirectory,executionDirectory:input.workingDirectory,summary,chat,state:{provider:input.engineId,title,status,lifecycle:SessionLifecycle.Ready,activeClients:[],chats:[this.chatSummary(chat)],defaultChat:chat.resource,workingDirectories:summary.workingDirectories}};
      const result={uri,nativeSessionId:proof.nativeSessionId,importCommandId:input.importCommandId,sourceSha256:input.sourceSha256,historyRevision:proof.historyRevision,creationConfirmed:true,workReplayed:false,receipt:String(entry.command_id)};
      this.store.transaction(()=>{this.store.save(record);this.store.db.prepare("UPDATE import_adoptions SET session=?,status='completed',result=? WHERE command_id=?").run(uri,JSON.stringify(result),entry.command_id);this.store.finish(String(entry.command_id),'completed');});
      this.notify('root/sessionAdded',{channel:ROOT,summary:record.summary});return result;
    });
  }
  /** Verify the configured native owner; caller identity fields never prove creation. */
  async adoptImportedSession(input:AdoptImport) {
    return this.intake.run(async()=>{
      this.validateImport(input);const payload=JSON.stringify(input);
      return this.withLock('@native-import:'+input.engineId+':'+input.importCommandId,async()=>{
        if(this.closing)throw new RpcFault(-32008,'Host is shutting down',{executed:false});
        const prior=this.store.db.prepare('SELECT * FROM import_adoptions WHERE command_id=? OR (engine_id=? AND import_command_id=?)').all(input.commandId,input.engineId,input.importCommandId);
        if(prior.length){
          const row=prior[0]!,original=JSON.parse(String(row.payload));
          if(prior.length!==1||row.command_id===input.commandId&&row.payload!==payload||original.engineId!==input.engineId||original.importCommandId!==input.importCommandId||original.workingDirectory!==input.workingDirectory||original.sourceSha256!==input.sourceSha256||original.previewHash!==input.previewHash)throw new RpcFault(-32011,'Import adoption command or receipt identity conflicts',{executed:false});
          if(row.status==='completed')return JSON.parse(String(row.result));
          throw new RpcFault(-32011,'Original import mapping is unresolved; inspect its receipt without repeating native import',{receipt:row.command_id,outcome:row.status});
        }
        if(this.config.catalog&&!this.config.catalog.claimNative)throw new RpcFault(-32601,'Catalog lacks atomic native import registration',{executed:false});
        const proof=await this.verifiedImport(input);
        return this.withLock(input.session,async()=>{
          const existing=this.getRecord(input.session)??await this.exactCatalogRecord(input.session);
          if(existing&&(existing.engineId!==input.engineId||existing.nativeSessionId!==proof.nativeSessionId||existing.workingDirectory!==input.workingDirectory))throw new RpcFault(-32011,'Requested AHP identity belongs to another native session',{executed:false});
          const duplicate=this.store.db.prepare('SELECT uri FROM sessions WHERE engine_id=? AND native_id=? AND cwd=? LIMIT 1').get(input.engineId,proof.nativeSessionId,input.workingDirectory);
          if(duplicate&&duplicate.uri!==input.session)throw new RpcFault(-32011,'Imported native identity already has a host mapping',{executed:false});
          const entry={command_id:input.commandId,session:input.session,payload};
          this.store.transaction(()=>{this.store.admission(input.session,{kind:'import.adopt',input},input.commandId,'host:import',this.store.extensionSequence('host:import'));this.store.db.prepare('INSERT INTO import_adoptions VALUES(?,?,?,?,?,?,?,?)').run(input.commandId,input.engineId,input.importCommandId,input.session,'dispatching',payload,JSON.stringify(proof),null);this.store.finish(input.commandId,'dispatching');});
          try{return await this.finishImportAdoption(entry,proof);}catch{this.store.transaction(()=>{this.store.db.prepare("UPDATE import_adoptions SET status='unknown' WHERE command_id=?").run(input.commandId);this.store.finish(input.commandId,'unknown','Derived import registration is unresolved; native creation is not replayed');});throw new RpcFault(-32011,'Import mapping outcome unknown; reconcile original receipt',{receipt:input.commandId,outcome:'unknown'});}
        });
      });
    });
  }
  /** Explicit metadata-only repair, using the original native receipt, never commit again. */
  async importAdoptionReceipt(commandId:string,{reconcile=false}:{reconcile?:boolean}={}) {
    if(typeof commandId!=='string'||!commandId||commandId.length>200)throw new RpcFault(-32602,'Exact import adoption command required');
    const row=this.store.db.prepare('SELECT * FROM import_adoptions WHERE command_id=?').get(commandId);
    if(!row)return null;
    if(row.status==='completed'||!reconcile)return {status:row.status,result:row.result?JSON.parse(String(row.result)):undefined,receipt:this.store.receipt(commandId),replayed:false};
    return this.intake.run(()=>this.withLock('@native-import:'+row.engine_id+':'+row.import_command_id,async()=>{
      const current=this.store.db.prepare('SELECT * FROM import_adoptions WHERE command_id=?').get(commandId)!;
      if(current.status==='completed')return {status:'completed',result:JSON.parse(String(current.result)),receipt:this.store.receipt(commandId),replayed:false};
      const input=JSON.parse(String(current.payload)),proof=await this.verifiedImport(input);
      if(JSON.stringify(proof)!==current.proof)throw new RpcFault(-32011,'Native import proof changed; registration remains unresolved');
      const result=await this.withLock(String(current.session),()=>this.finishImportAdoption(current,proof));return {status:'completed',result,receipt:this.store.receipt(commandId),replayed:false};
    }));
  }
  /** Trusted composition boundary: preserve the AHP identity from a verified signed envelope. */
  async adoptTransferredSession(input:AdoptTransfer) {
    return this.intake.run(async()=>{
    this.transferInput(input);
    if(!/^ahp-session:\/[A-Za-z0-9_-]{1,200}$/.test(input.session)||typeof input.nativeSessionId!=='string'||!input.nativeSessionId||input.nativeSessionId.length>200||input.destination!==this.config.transferIdentity||!['source','releaseHash'].every(key=>/^[a-f0-9]{64}$/.test(input[key as 'source'|'releaseHash']))||input.source===input.destination||typeof input.title!=='undefined'&&(typeof input.title!=='string'||input.title.length>1000))throw new RpcFault(-32602,'Exact signed transfer identity and destination proof required',{executed:false});
    const historyHome=await this.workspace(pathToFileURL(input.historyHome).href),executionDirectory=await this.workspace(pathToFileURL(input.executionDirectory).href);
    return this.withLock(input.session,async()=>{
      if(this.closing)throw new RpcFault(-32008,'Host is shutting down',{executed:false});
      const payload=JSON.stringify(input),prior=this.store.db.prepare('SELECT * FROM transfer_commands WHERE command_id=?').get(input.commandId);
      if(prior){if(prior.operation!=='destination.adopt'||prior.payload!==payload)throw new RpcFault(-32011,'Transfer adoption ID was reused',{executed:false});if(prior.status==='completed')return JSON.parse(String(prior.result));throw new RpcFault(-32011,'Adoption already attempted; inspect the original receipt without replay',{receipt:input.commandId,outcome:prior.status});}
      const existing=this.getRecord(input.session)??await this.exactCatalogRecord(input.session);
      if(existing&&(existing.nativeSessionId!==input.nativeSessionId||existing.engineId!==input.engineId||existing.workingDirectory!==historyHome))throw new RpcFault(-32011,'Existing AHP identity belongs to a different native session',{executed:false});
      if(this.active.has(input.session)||this.starting.has(input.session)||this.transferFence(input.session))throw new RpcFault(-32011,'Destination session already has an owner or unresolved transition',{executed:false});
      const timestamp=now(),title=input.title??(existing&&'summary' in existing?existing.summary.title:existing?.title)??'Transferred conversation';
      const summary:SessionSummary={resource:input.session,provider:input.engineId,title,status:SessionStatus.Idle,createdAt:timestamp,modifiedAt:timestamp,workingDirectories:[pathToFileURL(historyHome).href]};
      const chat:ChatState={resource:chatURI(input.session),title,status:SessionStatus.Idle,modifiedAt:timestamp,turns:[],_meta:{'amplifier.dev/history':{source:'native',available:true}}};
      const record:SessionRecord={uri:input.session,engineId:input.engineId,nativeSessionId:input.nativeSessionId,workingDirectory:historyHome,executionDirectory,summary,chat,state:{provider:input.engineId,title,status:SessionStatus.Idle,lifecycle:SessionLifecycle.Ready,activeClients:[],chats:[this.chatSummary(chat)],defaultChat:chat.resource,workingDirectories:summary.workingDirectories}};
      return this.transferAgent(record,async agent=>{
        const proof=await this.nativeTransfer(agent,record,'inspect',input.transferId);
        this.verifyTransferProof(record,input.transferId,input.source,input.destination,proof.receipt,'activated');
        if(proof.fence!==null||proof.receipt.releaseHash!==input.releaseHash||typeof proof.receipt.historyRevision!=='string')throw new RpcFault(-32011,'Destination activation and release are not proven',{executed:false});
        return this.withLock('@directory-reservations',async()=>{
          await this.workspace(pathToFileURL(historyHome).href);await this.workspace(pathToFileURL(executionDirectory).href);
          const result={uri:record.uri,nativeSessionId:record.nativeSessionId,transferId:input.transferId,adopted:true,inputsReplayed:false,receipt:input.commandId};
          this.store.transaction(()=>{this.store.admission(record.uri,{operation:'destination.adopt',input},input.commandId,'host:transfer',this.store.extensionSequence('host:transfer'));this.store.db.prepare('INSERT INTO transfer_commands VALUES(?,?,?,?,?,?,?)').run(input.commandId,record.uri,input.transferId,'destination.adopt','dispatching',payload,null);this.store.save(this.getRecord(record.uri)??record);this.store.db.prepare('INSERT INTO transfer_fences VALUES(?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET transfer_id=excluded.transfer_id,source=excluded.source,destination=excluded.destination,status=excluded.status,payload=excluded.payload').run(record.uri,input.transferId,input.source,input.destination,'dispatching',JSON.stringify({nativeReceipt:proof.receipt}));});
          try{await this.syncCatalog(record);this.store.transaction(()=>{this.store.db.prepare("UPDATE transfer_commands SET status='completed',result=? WHERE command_id=?").run(JSON.stringify(result),input.commandId);this.store.db.prepare("UPDATE transfer_fences SET status='adopted' WHERE session=?").run(record.uri);this.store.finish(input.commandId,'completed');});this.notify('root/sessionAdded',{channel:ROOT,summary});return result;}
          catch(error){this.store.transaction(()=>{this.store.db.prepare("UPDATE transfer_commands SET status='unknown' WHERE command_id=?").run(input.commandId);this.store.db.prepare("UPDATE transfer_fences SET status='unknown' WHERE session=?").run(record.uri);this.store.finish(input.commandId,'unknown',(error as Error).message);});throw new RpcFault(-32011,'Destination metadata synchronization is unknown; inspect without replay',{receipt:input.commandId,outcome:'unknown'});}
        });
      });
    });
      });
  }
  /** Cold bounded candidate reviews; no ACP process or selected history startup. */
  previewRetention(input:RetentionPreviewRequest){return this.retention.preview(input);}
  applyRetention(input:RetentionApplyRequest){return this.intake.run(()=>this.retention.apply(input));}
  retentionReceipt(commandId:string){const batch=this.retention.receipt(commandId);if(batch)for(const item of batch.items)this.retentionItemReceipt(item.commandId);return this.retention.receipt(commandId);}
  retentionItemReceipt(commandId:string){
    const item=this.retention.itemReceipt(commandId);if(!item||item.status==='hidden')return item;
    const proof=this.store.db.prepare("SELECT result FROM lifecycle_commands WHERE command_id=? AND session=? AND operation='retention.hide' AND status='completed'").get(commandId,item.session);
    if(proof){const result=JSON.parse(String(proof.result));this.retention.settleItem(commandId,{status:'hidden',executed:true,result,protectionRelease:'unconfirmed'});return this.retention.itemReceipt(commandId);}
    return item;
  }
  private retentionProtected(row:CatalogRecord,protect:string[]):string|undefined {
    const uri=row.uri,chat=uri.replace('ahp-session:','ahp-chat:');
    if(protect.includes(uri)||this.hasSubscribers(uri)||this.hasSubscribers(chat))return 'selected-or-subscribed';
    if(this.retentionChanging.has(uri))return 'retention-in-progress';
    if(this.active.get(uri)?.busy||this.active.get(uri)?.controlDepth||this.starting.has(uri))return 'active-work';
    if(this.store.unknown(chat))return 'unknown-input';
    if(this.store.db.prepare("SELECT 1 FROM queue_intents WHERE chat=? AND status='pending' UNION ALL SELECT 1 FROM steering_intents WHERE chat=? AND status IN ('pending','dispatching','unknown') LIMIT 1").get(chat,chat))return 'pending-input';
    if(this.relocationFence(uri)||this.transferFence(uri))return 'ownership-transition';
    if(this.store.db.prepare("SELECT 1 FROM lifecycle_commands WHERE (session=? OR target=?) AND status IN ('dispatching','unknown') LIMIT 1").get(uri,uri))return 'unknown-lifecycle';
    if(this.store.db.prepare('SELECT 1 FROM session_visibility WHERE uri=? AND deleted=1').get(uri))return 'already-hidden';
    const current=this.store.db.prepare('SELECT modified,engine_id,native_id,cwd FROM sessions WHERE uri=?').get(uri) as Json|undefined;
    if(current&&(current.engine_id!==row.engineId||current.native_id!==row.nativeSessionId||current.cwd!==row.workingDirectory))return 'changed-identity';
    if(current&&row.modifiedAt&&Date.parse(current.modified)>Date.parse(row.modifiedAt))return 'new-host-activity';
    return undefined;
  }
  private async hideRetained(reviewed:CatalogRecord,input:{commandId:string;modifiedBefore:number;protectSessionIds:string[]}) {
    return this.withLock(reviewed.uri,async()=>{
      const fail=(message:string)=>new RpcFault(-32011,message,{executed:false});
      if(!this.config.retentionProtection)throw fail('Dependent-owner retention protection is unavailable');
      const current=await this.config.catalog?.get(reviewed.uri);
      if(!current||current.nativeSessionId!==reviewed.nativeSessionId||current.engineId!==reviewed.engineId||current.workingDirectory!==reviewed.workingDirectory||current.modifiedAt!==reviewed.modifiedAt||current.createdAt!==reviewed.createdAt||current.nativeDeleted||current.workspaceAvailability!=='present')throw fail('Reviewed catalog identity or activity changed');
      const protectedReason=this.retentionProtected(current,input.protectSessionIds);if(protectedReason)throw fail(protectedReason);
      const record=await this.record(current.uri);this.guardSessionLifecycle(record.uri);
      const fenced=new Set<string>(),fence=(row:CatalogRecord)=>{const reason=this.retentionProtected(row,input.protectSessionIds);if(reason)throw fail(reason);for(const uri of [row.uri,row.uri.replace('ahp-session:','ahp-chat:')]){this.retentionChanging.add(uri);fenced.add(uri);}};
      fence(current);
      try{
        await this.quiesceLifecycle(record);
        return await this.withLifecycleFamily(record,true,async(descendants,sessions)=>{
          const lease=await this.config.retentionProtection!.acquire({commandId:input.commandId,session:record.uri,descendants:sessions,operation:'hide'});
          if(!lease||!Array.isArray(lease.ownerIds)||!lease.ownerIds.length||lease.ownerIds.length>64||lease.ownerIds.some(id=>typeof id!=='string'||!id)||typeof lease.release!=='function')throw new Error('Dependent-owner protection did not return held coverage');
          try{const confirmed=await this.lifecycleAgent(record,async agent=>{
            const capability=(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.sessionLifecycle;
            if(capability?.retention?.version!==1||capability?.descendantGuard?.version!==1)throw fail('Native guarded retention hide is unavailable');
            const inspected=await this.nativeLifecycle(agent,record,'inspect'),args={commandId:input.commandId,expectedHistoryRevision:inspected.historyRevision,modifiedBefore:input.modifiedBefore,descendants};
            const entry={command_id:input.commandId,session:record.uri,operation:'retention.hide',target:null,status:'dispatching',payload:JSON.stringify(args)};
            this.store.transaction(()=>{this.store.admission(record.uri,{operation:entry.operation,args},input.commandId,'host:retention',this.store.extensionSequence('host:retention'));this.store.db.prepare('INSERT INTO lifecycle_commands(command_id,session,operation,target,status,payload) VALUES(?,?,?,?,?,?)').run(entry.command_id,entry.session,entry.operation,null,entry.status,entry.payload);this.store.finish(input.commandId,'dispatching');});
            try{return await this.applyLifecycleResult(record,entry,await this.nativeLifecycle(agent,record,'retention.hide',args));}
            catch(error){let proof:Json|undefined;try{proof=await this.nativeLifecycle(agent,record,'receipt',{commandId:input.commandId});}catch{}
              if(proof?.receipt?.status==='completed'){try{return await this.applyLifecycleResult(record,entry,{...proof.receipt.result,receipt:proof.receipt});}catch{}}
              const status=proof?.receipt===null?'failed':'unknown';this.store.transaction(()=>{this.store.db.prepare('UPDATE lifecycle_commands SET status=? WHERE command_id=?').run(status,input.commandId);this.store.finish(input.commandId,status,(error as Error).message);});throw new RpcFault(-32011,(error as Error).message,{receipt:input.commandId,outcome:status,...(status==='failed'?{executed:false}:{})});
            }
          });this.retention.settleItem(input.commandId,{status:'hidden',executed:true,result:confirmed});return confirmed;
          }catch(error){const known=(error as any)?.data?.executed===false;this.retention.settleItem(input.commandId,{status:known?'refused':'unknown',...(known?{executed:false}:{}),reason:(error as Error).message.slice(0,1000)});throw error;}finally{await lease.release();}
        },fence);
      }finally{for(const uri of fenced)this.retentionChanging.delete(uri);}
    });
  }
  private guardSessionLifecycle(session:string) {
    this.guardTransfer(session);
    if(this.managedFiles.fence(session))throw new RpcFault(-32011,'Managed files disposal is fenced; inspect its receipt or create an independent recovery copy');
    const allocation=this.managed?.bySession(session);if(allocation&&allocation.state!=='completed')throw new RpcFault(-32011,'Managed creation is unresolved; inspect its original receipt without replay');
    if(this.store.db.prepare("SELECT 1 FROM import_adoptions WHERE session=? AND status<>'completed' LIMIT 1").get(session))throw new RpcFault(-32011,'Imported session registration is unresolved; inspect its exact receipt');
    if(this.store.db.prepare("SELECT 1 FROM lifecycle_commands WHERE (session=? OR target=?) AND status IN ('dispatching','unknown') LIMIT 1").get(session,session))throw new RpcFault(-32011,'Session lifecycle outcome is unresolved; inspect the original receipt without replay');
    if(this.store.db.prepare('SELECT 1 FROM session_visibility WHERE uri=? AND deleted=1').get(session))throw new RpcFault(-32008,'Session was removed from discovery; restore it before execution');
  }
  private passiveProcessDirectory(record:SessionRecord){return this.managedFiles.fence(record.uri)?this.defaultWorkingDirectory:record.workingDirectory;}
  private async lifecycleAgent<T>(record:SessionRecord,work:(agent:AcpProcess)=>Promise<T>):Promise<T> {
    if(this.passiveReads>=4)throw new RpcFault(-32000,'Passive native read capacity reached');
    const engine=this.config.engines.find(engine=>engine.id===record.engineId);if(!engine||!record.nativeSessionId)throw new RpcFault(-32601,'Native lifecycle identity is unavailable');
    this.passiveReads++;const agent=new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive native inspection cannot perform filesystem or terminal effects');}});
    try{const initialized=await agent.initialize(),capability=(initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.sessionLifecycle;if(capability?.version!==1||capability.passive!==true||capability.deletion!=='preserve-history')throw new RpcFault(-32601,'Agent does not advertise passive preserve-history lifecycle');return await work(agent);}finally{this.passiveReads--;await agent.retire();}
  }
  private async nativeLifecycle(agent:AcpProcess,record:SessionRecord,operation:string,args:Json={}) {
    const result:Json=await agent.client.extMethod('_amplifier/session',{sessionId:record.nativeSessionId,cwd:record.workingDirectory,operation,args});
    if(!result||typeof result!=='object'||Array.isArray(result)||Buffer.byteLength(JSON.stringify(result))>256*1024)throw new RpcFault(-32000,'Invalid or oversized native lifecycle response');return result;
  }
  /** Native storage owner inspection; no transcript body or prepared runtime. */
  async inspectSessionHistory(session:string):Promise<Json> {
    const record=await this.record(session),result:Json=await this.lifecycleAgent(record,async agent=>{const inspected=await this.nativeLifecycle(agent,record,'inspect');return {...inspected,lifecycleCapabilities:(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.sessionLifecycle};});
    if(result.sessionId!==record.nativeSessionId||typeof result.historyRevision!=='string'||result.historyRevision.length>512||result.location?.historyCwd!==record.workingDirectory)throw new RpcFault(-32000,'Native lifecycle inspection returned a different identity');
    return {session:record.uri,...result,lifecycleFence:this.store.db.prepare("SELECT command_id,operation,status FROM lifecycle_commands WHERE session=? AND status IN ('dispatching','unknown') LIMIT 1").get(record.uri)};
  }
  /** Explicit bounded canonical rebaseline; clients request a fresh standard snapshot afterwards. */
  async refreshSessionHistory(session:string,input:{limit?:number;expectedHistoryRevision?:string}={}) {
    return this.intake.run(async()=>{
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['limit','expectedHistoryRevision'].includes(key))||input.expectedHistoryRevision!==undefined&&(typeof input.expectedHistoryRevision!=='string'||input.expectedHistoryRevision.length>512))throw new RpcFault(-32602,'Bounded selected history refresh options required');
    const limit=bounded(input.limit,50,50),selected=await this.record(session);
    return this.withLock(selected.uri,async()=>{
      const record=this.getRecord(selected.uri)!;
      if(this.active.get(record.uri)?.busy||this.active.get(record.uri)?.controlDepth||record.chat.activeTurn||this.store.unknown(record.chat.resource)||this.relocationFence(record.uri)||this.transferFence(record.uri))throw new RpcFault(-32011,'History refresh requires conclusively idle execution; active or unknown inputs were preserved',{executed:false});
      const page=await this.nativeHistory(record,limit);
      if(input.expectedHistoryRevision!==undefined&&page.revision!==input.expectedHistoryRevision)throw new RpcFault(-32011,'Native history changed before selected refresh',{executed:false});
      if((await this.inspectSessionHistory(record.uri)).historyRevision!==page.revision)throw new RpcFault(-32011,'Native history changed during selected refresh',{executed:false});
      let refreshedTurns=0;
      this.store.transaction(()=>{
        for(const canonical of page.turns){
          const row=this.store.db.prepare('SELECT payload FROM turns WHERE chat=? AND turn_id=?').get(record.chat.resource,canonical.id);
          if(!row||this.store.receipt(canonical.id)?.status!=='completed')continue;
          const live=JSON.parse(String(row.payload)) as Turn;
          // Native history is canonical for persisted response boundaries; the
          // live host remains authority for admission outcome and input provenance.
          const responseParts=canonical.responseParts.filter(part=>part.kind!=='error'||(part as any).error?.errorType!=='NATIVE_OUTCOME_UNKNOWN');
          const boundary=canonical.message._meta?.['amplifier.dev/history'] as Json|undefined;
          const {messageReference:_oldReference,replyTo:_oldQuote,...liveBoundary}=(live.message._meta?.['amplifier.dev/history'] as Json)??{};
          this.store.saveTurn(record.chat.resource,{...live,responseParts,message:{...live.message,_meta:{...live.message._meta,'amplifier.dev/history':{...liveBoundary,messageId:boundary?.messageId,turnId:canonical.id,boundaryRevision:page.revision,...(boundary?.messageReference?{messageReference:boundary.messageReference}:{}),...(boundary?.replyTo?{replyTo:boundary.replyTo}:{})}}}});refreshedTurns++;
        }
        record.chat._meta={...record.chat._meta,'amplifier.dev/history':{source:'native',available:true,revision:page.revision,diagnostics:page.diagnostics}};this.store.save(record);
      });
      return {refreshed:true,chat:record.chat.resource,revision:page.revision,refreshedTurns,view:{turns:limit},requiresSubscribe:true};
    });
      });
  }
  /** Shared organization is host-owned; native history remains unchanged. */
  async archiveSession(session:string,isArchived:boolean) {
    return this.intake.run(async()=>{
    if(typeof isArchived!=='boolean')throw new RpcFault(-32602,'isArchived must be boolean');const record=await this.record(session);
    return this.withLock(record.uri,async()=>{this.emit(record.uri,{type:'session/isArchivedChanged',isArchived} as StateAction);const current=this.getRecord(record.uri)!;this.notify('root/sessionSummaryChanged',{channel:ROOT,session:record.uri,changes:{status:current.summary.status}});await this.syncCatalog(current);return {session:record.uri,isArchived};});
      });
  }
  private async quiesceLifecycle(record:Pick<SessionRecord,'uri'>) {
    const current=this.getRecord(record.uri);if(current)this.guardRetirementRecord(current);
    const active=this.active.get(record.uri);if(!active)return;
    this.guardRetirement(active);
    if(active.busy||active.controlDepth||this.starting.has(record.uri))throw new RpcFault(-32008,'Session has active work; lifecycle change was not executed',{executed:false});
    active.controlDepth=(active.controlDepth??0)+1;
    try{if(!active.agent.closed&&!await this.retireActive(record.uri,active))throw new RpcFault(-32008,'Native session still owns work; lifecycle change was not executed',{executed:false});active.retireReason='session-lifecycle';await active.agent.retire();await active.stopCallback;this.active.delete(record.uri);}finally{active.controlDepth--;}
  }
  async previewDeleteSession(session:string) {const record=await this.record(session);return this.lifecycleAgent(record,agent=>this.nativeLifecycle(agent,record,'delete.preview'));}
  private lifecycleArgs(operation:string,args:Json) {
    const allowed:Record<string,string[]>={fork:['commandId','expectedHistoryRevision','throughMessageId','title','mode','bundle','bundleRevision','resetModel'],export:['commandId','expectedHistoryRevision','format','scope','fromMessageId','throughMessageId','minimal'],delete:['commandId','expectedHistoryRevision','confirmationToken'],restore:['commandId','expectedHistoryRevision'],'legacyCopy.purge':['commandId','expectedHistoryRevision','previewId','previewHash']};
    if(!allowed[operation]||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!allowed[operation].includes(key))||Buffer.byteLength(JSON.stringify(args))>32768||typeof args.commandId!=='string'||!args.commandId||args.commandId.length>200||typeof args.expectedHistoryRevision!=='string'||!args.expectedHistoryRevision||args.expectedHistoryRevision.length>512)throw new RpcFault(-32602,'Exact lifecycle operation, bounded command identity and history revision required');
    for(const key of ['throughMessageId','fromMessageId','title','confirmationToken'])if(args[key]!==undefined&&(typeof args[key]!=='string'||!args[key]||args[key].length>1000))throw new RpcFault(-32602,'Invalid lifecycle boundary or title');
    if(operation==='fork'&&(args.mode!==undefined&&!['complete','recovery'].includes(args.mode)||args.bundle!==undefined&&(typeof args.bundle!=='string'||!args.bundle||args.bundle.length>200)||args.resetModel!==undefined&&typeof args.resetModel!=='boolean'||args.bundle!==undefined&&!/^[a-f0-9]{64}$/.test(args.bundleRevision??'')||args.bundle===undefined&&(args.bundleRevision!==undefined||args.resetModel===true)))throw new RpcFault(-32602,'Negotiated fork mode and configured bundle identity required');
    if(operation==='export'&&(!['markdown','json'].includes(args.format)||args.scope!==undefined&&!['all','from','range'].includes(args.scope)||args.minimal!==undefined&&typeof args.minimal!=='boolean'))throw new RpcFault(-32602,'Unsupported native export shape');
    if(operation==='legacyCopy.purge'&&(typeof args.previewId!=='string'||!/^[a-f0-9-]{36}$/.test(args.previewId)||typeof args.previewHash!=='string'||!/^[a-f0-9]{64}$/.test(args.previewHash)))throw new RpcFault(-32602,'Exact retired-copy preview identity and hash required');
    if(operation==='delete'&&typeof args.confirmationToken!=='string')throw new RpcFault(-32602,'Exact native delete preview token required');
  }
  private async applyLifecycleResult(record:SessionRecord,entry:Json,native:Json) {
    if(native.receipt?.status!=='completed'||native.receipt.commandId!==entry.command_id)throw new Error('Native lifecycle outcome lacks completed receipt proof');
    if(entry.operation==='retention.hide'&&(native.receipt.operation!=='retention.hide'||native.retention?.modifiedBefore!==JSON.parse(String(entry.payload)).modifiedBefore||native.retention?.canonicalFilesDeleted!==0||native.familyGuard?.ownersHeld!==true))throw new Error('Native retention outcome lacks exact preserve-history cutoff and family proof');
    const operation=String(entry.operation),args=JSON.parse(String(entry.payload)),timestamp=now();let result:Json;
    if(operation==='fork') {
      if(args.mode==='recovery'&&(native.mode!=='recovery'||native.preservedSource!==true)||args.bundle!==undefined&&native.bundleSelection!==args.bundle)throw new Error('Native copy mode does not match the reviewed request');
      const allocation=this.managed?.bySession(String(entry.target));
      const historyCwd=allocation?.marker.workspace??record.workingDirectory;
      if(native.creationConfirmed!==true||native.sessionId!==entry.target?.slice('ahp-session:/'.length)||native.historyCwd!==historyCwd||native.workReplayed!==false||native.source?.sessionId!==record.nativeSessionId||native.source?.historyRevision!==args.expectedHistoryRevision||typeof native.executionDirectory!=='string')throw new Error('Native fork confirmation does not match reserved identity');
      if(record.state._meta?.['amplifier.dev/location']){
        if(!allocation||native.executionDirectory!==historyCwd||managedHash(native.location)!==managedHash(this.managed!.location(allocation))||native.generatedFilesCopied!==false)throw new Error('Managed copy lacks its fresh allocation proof');
        const proof:Json=await this.managedAgent(record.engineId,agent=>agent.client.extMethod('_amplifier/managed',this.managedNativeParams(allocation,'receipt')));
        if(proof.result?.source?.operation!=='fork'||proof.result.source.commandId!==entry.command_id||proof.result.source.sessionId!==record.nativeSessionId||proof.result.source.historyRevision!==args.expectedHistoryRevision)throw new Error('Managed copy receipt differs from original source command');
        await this.confirmManaged(allocation,proof);
      }else{if(allocation)throw new Error('Ordinary copy cannot adopt a managed allocation');await this.workspace(pathToFileURL(native.executionDirectory).href);}
      const uri=String(entry.target),existing=this.getRecord(uri),title=args.title??record.summary.title;
      const chat:ChatState={resource:chatURI(uri),title,status:SessionStatus.Idle,modifiedAt:timestamp,turns:[],_meta:{'amplifier.dev/history':{source:'native',available:true}}};
      const summary:SessionSummary={resource:uri,provider:record.engineId,title,status:SessionStatus.Idle,createdAt:timestamp,modifiedAt:timestamp,workingDirectories:[pathToFileURL(record.workingDirectory).href]};
      const target:SessionRecord=existing??{uri,engineId:record.engineId,nativeSessionId:native.sessionId,workingDirectory:record.workingDirectory,executionDirectory:native.executionDirectory,summary,chat,state:{provider:record.engineId,title,status:SessionStatus.Idle,lifecycle:SessionLifecycle.Ready,activeClients:[],chats:[this.chatSummary(chat)],defaultChat:chat.resource,workingDirectories:summary.workingDirectories}};
      if(target.nativeSessionId!==native.sessionId||target.workingDirectory!==historyCwd)throw new Error('Reserved fork target now has a different identity');
      this.store.save(target);await this.syncCatalog(target);result={uri,creationConfirmed:true,historyRevision:native.historyRevision,source:native.source,workReplayed:false,...(allocation?{location:native.location,generatedFilesCopied:false}:{}),mode:native.mode??'complete',...(native.bundleSelection!==undefined?{bundleSelection:native.bundleSelection}:{}),preservedSource:true,receipt:native.receipt};
      this.notify('root/sessionAdded',{channel:ROOT,summary:target.summary});
    }else if(operation==='legacyCopy.purge'){
      if(native.receipt.operation!==operation||native.sessionId!==record.nativeSessionId||native.historyCwd!==record.workingDirectory||native.historyRevision!==args.expectedHistoryRevision||native.previewId!==args.previewId||native.previewHash!==args.previewHash||native.canonicalFilesDeleted!==0||native.eventsDeleted!==0||native.legacyWriterCoverage!=='launcher-attested-retired'||!Array.isArray(native.removed)||!native.removed.length||native.removed.length>3||new Set(native.removed.map((f:Json)=>f.name)).size!==native.removed.length||native.removed.some((f:Json)=>!['transcript.jsonl','metadata.json','checkpoint.json'].includes(f.name)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>64*1024*1024||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)))throw new Error('Retired-copy effect lacks exact duplicate-only native receipt proof');
      result={...native,session:record.uri};
    }else if(operation==='export'){
      if(typeof native.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(native.snapshotId)||!Number.isSafeInteger(native.summary?.bytes)||native.summary.bytes<0||native.summary.bytes>64*1024*1024||native.historyRevision!==args.expectedHistoryRevision||typeof native.contentHash!=='string')throw new Error('Invalid native immutable export confirmation');
      const uri='amplifier-export:/'+createHash('sha256').update(record.uri+'\0'+native.snapshotId).digest('hex');
      result={resource:uri,filename:native.filename,mimeType:native.mimeType,summary:native.summary,capturedAt:native.capturedAt,historyRevision:native.historyRevision,contentHash:native.contentHash,receipt:native.receipt};
      this.store.db.prepare('INSERT OR IGNORE INTO export_resources VALUES(?,?,?,?)').run(uri,record.uri,native.snapshotId,JSON.stringify(result));
    }else{
      if(native.sessionId!==record.nativeSessionId||native.historyCwd!==record.workingDirectory||native.deleted!==(['delete','retention.hide'].includes(operation)))throw new Error('Native visibility confirmation does not match selected identity');
      this.store.db.prepare('INSERT INTO session_visibility VALUES(?,?,?) ON CONFLICT(uri) DO UPDATE SET deleted=excluded.deleted,command_id=excluded.command_id').run(record.uri,native.deleted?1:0,entry.command_id);
      if(this.config.catalog){if(!this.config.catalog.setVisibility)throw new Error('Catalog does not support confirmed native visibility');await this.config.catalog.setVisibility({uri:record.uri,nativeSessionId:record.nativeSessionId!,workingDirectory:record.workingDirectory,deleted:native.deleted,commandId:String(entry.command_id),evidence:'native-completed-receipt'});}
      this.store.db.prepare('UPDATE sessions SET hidden=? WHERE uri=?').run(native.deleted?1:0,record.uri);
      this.emit(record.uri,{type:'session/metaChanged',_meta:{...this.getRecord(record.uri)!.state._meta,'amplifier.dev/lifecycle':{version:1,deleted:native.deleted,preserved:native.preserved,receipt:entry.command_id}}} as StateAction);
      result={session:record.uri,deleted:native.deleted,preserved:native.preserved,historyRevision:native.historyRevision,receipt:native.receipt};
      if(native.deleted){this.holdQueue(record.chat.resource,'session-removed');this.notify('root/sessionRemoved',{channel:ROOT,session:record.uri});}else this.notify('root/sessionAdded',{channel:ROOT,summary:record.summary});
    }
    this.store.transaction(()=>{this.store.db.prepare("UPDATE lifecycle_commands SET status='completed',result=? WHERE command_id=?").run(JSON.stringify(result),entry.command_id);this.store.finish(String(entry.command_id),'completed');});return result;
  }
  /** Caller holds source admission; indexed facts never stand in for native ownership. */
  private async withLifecycleFamily<T>(record:SessionRecord,required:boolean,work:(descendants:Json[],sessions:string[])=>Promise<T>,validate?:(row:CatalogRecord)=>void):Promise<T> {
    const catalog=this.config.catalog;
    if(!catalog){if(required)throw new RpcFault(-32601,'Recovery and bundle copies require indexed family coverage',{executed:false});return work([],[]);}
    if(!catalog.descendants)throw new RpcFault(-32601,'Catalog cannot provide bounded descendant coverage',{executed:false});
    let family:CatalogFamily|undefined,scoped=false;
    if(catalog.reconcileFamily){
      try{const discover=()=>catalog.reconcileFamily!({parentUri:record.uri,limit:100,maxEntries:512});family=await (this.presentation?this.presentation.discoverFamily(record.uri,discover):discover());scoped=true;}
      catch(error){if((error as {code?:number}).code!==-32601)throw new RpcFault(-32011,'Selected family discovery could not be confirmed; copy was not executed',{executed:false});}
    }
    family??=await catalog.descendants({parentUri:record.uri,limit:100});
    const proof=family.familyDiscovery,fresh=family.freshness,age=Date.now()-Date.parse((scoped?proof?.completedAt:fresh?.completedAt)??'');
    const bounded=(value:unknown,max:number)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
    const discoveryValid=scoped?!!proof&&proof.version===1&&proof.scope==='selected-native-project-namespaces'&&proof.phase==='complete'&&Array.isArray(proof.issues)&&proof.issues.length===0&&proof.indexRevision===family.revision&&proof.maxEntries===512&&proof.metadataByteLimit===8388608&&proof.metadataFileLimit===2048&&typeof proof.verificationToken==='string'&&proof.verificationToken.length>0&&proof.verificationToken.length<=2048&&typeof proof.inventoryHash==='string'&&/^[a-f0-9]{64}$/.test(proof.inventoryHash)&&!!catalog.verifyFamily&&bounded(proof.entriesExamined,512)&&bounded(proof.metadataReads,2048)&&bounded(proof.metadataBytesAdmitted,8388608)&&Array.isArray(proof.namespaces)&&proof.namespaces.length>0&&proof.namespaces.length<=101&&proof.namespaces.every(path=>typeof path==='string'&&path.length>0)&&new Set(proof.namespaces).size===proof.namespaces.length&&proof.externalWriterCoverage===false&&proof.transcriptBodiesRead===false&&proof.nativeOwnershipVerified===false:fresh?.phase==='complete'&&fresh.issues===0;
    if(family.parentUri!==record.uri||family.root?.uri!==record.uri||family.rootKnown!==true||family.completeIndexedCoverage!==true||family.truncated!==false||!Array.isArray(family.issues)||family.issues.length||!Array.isArray(family.excludedKinds)||family.excludedKinds.length||family.coverage!=='indexed-native-history'||family.root?.nativeSessionId!==record.nativeSessionId||family.root?.engineId!==record.engineId||family.root?.workingDirectory!==record.workingDirectory||!Array.isArray(family.items)||family.items.length>100||!discoveryValid||family.externalWriterCoverage!==false||typeof family.revision!=='string'||!family.revision||!Number.isFinite(age)||age<0||age>600000)throw new RpcFault(-32011,'Indexed family coverage is incomplete or stale; copy was not executed',{executed:false});
    const rows=new Map<string,CatalogRecord>([[record.uri,family.root],...family.items.map(row=>[row.uri,row] as [string,CatalogRecord])]);
    if(rows.size!==family.items.length+1)throw new RpcFault(-32011,'Indexed family contains conflicting identities',{executed:false});
    const descendants:Json[]=[];
    for(const row of family.items){
      const parent=row.parentUri&&rows.get(row.parentUri);if(!parent||!parent.nativeSessionId||!row.nativeSessionId||row.engineId!==record.engineId||parent.engineId!==row.engineId)throw new RpcFault(-32011,'Descendant ownership belongs to an unavailable engine or parent',{executed:false});
      // A proved allocation authorizes only this bounded native family check,
      // never browsing, hydration, or execution of an arbitrary child cwd.
      if(record.state._meta?.['amplifier.dev/location']&&row.workingDirectory===record.workingDirectory)await this.selectedWorkspace(record);
      else await this.workspace(pathToFileURL(row.workingDirectory).href);
      descendants.push({sessionId:row.nativeSessionId,cwd:row.workingDirectory,parentSessionId:parent.nativeSessionId});
    }
    const lock=async(index:number):Promise<T>=>{
      if(index<family.items.length)return this.withLock(family.items[index].uri,()=>lock(index+1));
      for(const row of family.items){validate?.(row);const child=this.getRecord(row.uri);if(child&&(child.engineId!==row.engineId||child.nativeSessionId!==row.nativeSessionId||child.workingDirectory!==row.workingDirectory))throw new RpcFault(-32011,'Indexed descendant differs from its admitted identity',{executed:false});this.guardSessionLifecycle(row.uri);if(this.store.unknown(chatURI(row.uri))||child?.chat.activeTurn||this.relocationFence(row.uri))throw new RpcFault(-32011,'A descendant has unresolved or active work',{executed:false});await this.quiesceLifecycle({uri:row.uri});}
      if(scoped){
        let checked:Awaited<ReturnType<NonNullable<Catalog['verifyFamily']>>>;
        try{checked=await catalog.verifyFamily!({parentUri:record.uri,verificationToken:proof!.verificationToken});}
        catch{throw new RpcFault(-32011,'Selected family discovery could not be revalidated; copy was not executed',{executed:false});}
        const checkedAge=Date.now()-Date.parse(checked?.completedAt??'');
        if(checked?.version!==1||checked.scope!=='selected-native-project-namespaces'||checked.valid!==true||checked.parentUri!==record.uri||checked.indexRevision!==family.revision||checked.inventoryHash!==proof!.inventoryHash||!Array.isArray(checked.issues)||checked.issues.length||checked.externalWriterCoverage!==false||checked.nativeOwnershipVerified!==false||checked.transcriptBodiesRead!==false||!Number.isFinite(checkedAge)||checkedAge<0||checkedAge>600000)throw new RpcFault(-32011,'Selected family changed while acquiring ownership; copy was not executed',{executed:false});
      }
      if((await catalog.descendants!({parentUri:record.uri,limit:100})).revision!==family.revision)throw new RpcFault(-32011,'Indexed family changed while acquiring ownership',{executed:false});
      return work(descendants,family.items.map(row=>row.uri));
    };
    family.items.sort((a,b)=>a.uri.localeCompare(b.uri));return lock(0);
  }
  private async mutateLifecycle(session:string,operation:string,args:Json) {
    return this.intake.run(async()=>{
    this.lifecycleArgs(operation,args);const record=await this.record(session);
    return this.withLock(record.uri,async()=>{
      if(this.closing)throw new RpcFault(-32008,'Host is shutting down',{executed:false});
      const previous=this.store.db.prepare('SELECT * FROM lifecycle_commands WHERE command_id=?').get(args.commandId);
      if(previous){if(previous.session!==record.uri||previous.operation!==operation||previous.payload!==JSON.stringify(args))throw new RpcFault(-32011,'Lifecycle command ID conflicts with its original request');if(previous.status==='completed')return JSON.parse(String(previous.result));throw new RpcFault(-32011,'Original lifecycle receipt is not completed; inspect it without replay',{receipt:args.commandId,outcome:previous.status,executed:previous.status==='failed'?false:undefined});}
      this.guardTransfer(record.uri);
      if(!['restore','legacyCopy.purge'].includes(operation)&&!((operation==='export'||operation==='fork'&&args.mode==='recovery')&&this.managedFiles.fence(record.uri)?.status==='completed'))this.guardSessionLifecycle(record.uri);else if(this.store.db.prepare("SELECT 1 FROM lifecycle_commands WHERE session=? AND status IN ('dispatching','unknown')").get(record.uri))throw new RpcFault(-32011,'Resolve prior lifecycle receipt first');
      if(this.store.unknown(record.chat.resource)&&!(operation==='fork'&&args.mode==='recovery')||this.relocationFence(record.uri))throw new RpcFault(-32011,'Unresolved execution or relocation must be inspected before lifecycle changes',{executed:false});
      if(this.config.catalog&&['delete','restore'].includes(operation)&&!this.config.catalog.setVisibility)throw new RpcFault(-32601,'Catalog cannot project native visibility',{executed:false});
      await this.quiesceLifecycle(record);
      const execute=async(descendants:Json[])=>this.lifecycleAgent(record,async agent=>{
        const capability=(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.sessionLifecycle;
        if(args.mode==='recovery'&&capability?.recoveryCopy?.version!==1||args.bundle!==undefined&&capability?.bundleFork?.version!==1||descendants.length&&capability?.descendantGuard?.version!==1)throw new RpcFault(-32601,'Configured engine does not support this guarded copy operation',{executed:false});
        if(operation==='legacyCopy.purge'&&(capability?.retiredCopies?.version!==1||capability.retiredCopies.duplicateFilesOnly!==true))throw new RpcFault(-32601,'Configured engine does not support verified retired-copy purge',{executed:false});
        const inspected=await this.nativeLifecycle(agent,record,'inspect');if(inspected.historyRevision!==args.expectedHistoryRevision)throw new RpcFault(-32011,'Native history changed; inspect a fresh revision',{executed:false});
        const managedCopy=operation==='fork'&&!!record.state._meta?.['amplifier.dev/location'];
        if(managedCopy&&(!this.managed||(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.managedCreation?.historyCopy?.version!==1))throw new RpcFault(-32601,'Configured engine does not support fresh managed history copies',{executed:false});
        const target=operation==='fork'?'ahp-session:/'+randomUUID():null;
        const allocationRequest=managedCopy?{session:target!,provider:record.engineId,commandId:'managed-copy:'+managedHash([record.uri,args.commandId]),title:args.title??record.summary.title}:null;
        if(allocationRequest)this.managed!.validate(allocationRequest);
        const entry={command_id:args.commandId,session:record.uri,operation,target,status:'dispatching',payload:JSON.stringify(args)};
        this.store.transaction(()=>{this.store.admission(record.uri,{operation,args},args.commandId,'host:lifecycle',this.store.extensionSequence('host:lifecycle'));this.store.db.prepare('INSERT INTO lifecycle_commands(command_id,session,operation,target,status,payload) VALUES(?,?,?,?,?,?)').run(entry.command_id,entry.session,operation,target,entry.status,entry.payload);this.store.finish(args.commandId,'dispatching');});
        const {title,...nativeArgs}=args;
        let allocation:Json|undefined;
        try{
          if(allocationRequest)await this.withLock('@directory-reservations',async()=>{allocation=this.managed!.reserve(allocationRequest,{operation:'fork',sessionId:record.nativeSessionId,historyRevision:args.expectedHistoryRevision,commandId:args.commandId});await this.managed!.allocate(allocation);this.managed!.settle(allocation.commandId,'dispatching');});
          return await this.applyLifecycleResult(record,entry,await this.nativeLifecycle(agent,record,operation,{...nativeArgs,...(target?{targetSessionId:target.slice('ahp-session:/'.length),...(capability?.descendantGuard?.version===1?{descendants}: {})}:{ }),...(allocation?{managedTarget:{cwd:allocation.marker.workspace,commandId:allocation.commandId,allocationHash:allocation.marker.allocationHash}}:{})}));
        }
        catch(error){
          if(allocation&&this.managed!.receipt(allocation.commandId)?.state!=='completed')this.managed!.settle(allocation.commandId,'unknown');
          let proof:Json|undefined;try{proof=await this.nativeLifecycle(agent,record,'receipt',{commandId:args.commandId});}catch{}
          if(proof?.receipt?.status==='completed'){try{return await this.applyLifecycleResult(record,entry,{...proof.receipt.result,receipt:proof.receipt});}catch{}}
          const status=proof?.receipt===null?'failed':'unknown';this.store.transaction(()=>{this.store.db.prepare('UPDATE lifecycle_commands SET status=? WHERE command_id=?').run(status,args.commandId);this.store.finish(args.commandId,status,(error as Error).message);});throw new RpcFault(-32011,(error as Error).message,{receipt:args.commandId,outcome:status,...(status==='failed'?{executed:false}: {})});
        }
      });
      return operation==='fork'?this.withLifecycleFamily(record,!!(args.mode==='recovery'||args.bundle||record.state._meta?.['amplifier.dev/location']),execute):execute([]);
    });
      });
  }
  async forkSession(session:string,args:{commandId:string;expectedHistoryRevision:string;throughMessageId?:string;title?:string;mode?:'complete'|'recovery';bundle?:string;bundleRevision?:string;resetModel?:boolean}) {return this.mutateLifecycle(session,'fork',args);}
  private managedFilesActor(actor:ManagedFilesActor){if(!actor||typeof actor.actorId!=='string'||!actor.actorId||actor.actorId.length>200||actor.clientId!==undefined&&(typeof actor.clientId!=='string'||!actor.clientId||actor.clientId.length>200))throw new RpcFault(-32602,'Trusted actor identity required',{executed:false});}
  private managedFilesMember(uri:string,protect:string[],actor:ManagedFilesActor){
    const chat=uri.replace('ahp-session:','ahp-chat:');
    if(protect.includes(uri)||[...this.peers].some(peer=>peer.clientId!==actor.clientId&&(peer.subscriptions.has(uri)||peer.subscriptions.has(chat))))throw new RpcFault(-32008,'Another selected client or protected session retains this allocation',{executed:false});
    if(this.retentionChanging.has(uri)||this.active.get(uri)?.busy||this.active.get(uri)?.controlDepth||this.starting.has(uri)||this.store.unknown(chat)||this.store.db.prepare("SELECT 1 FROM queue_intents WHERE chat=? AND status='pending' UNION ALL SELECT 1 FROM steering_intents WHERE chat=? AND status IN ('pending','dispatching','unknown') LIMIT 1").get(chat,chat))throw new RpcFault(-32008,'Active, pending or unknown work protects managed files',{executed:false});
    this.guardSessionLifecycle(uri);if(this.relocationFence(uri))throw new RpcFault(-32008,'Execution ownership transition protects managed files',{executed:false});
  }
  private managedFilesGuard(record:SessionRecord,protect:string[],actor:ManagedFilesActor){
    if(!record.state._meta?.['amplifier.dev/location']||!this.managed)throw new RpcFault(-32601,'Only proved managed allocation files can be disposed',{executed:false});
    const coverage=this.config.managedFilesProtection?.managedFiles;if(coverage?.version!==1||coverage.preservesCanonical!==true)throw new RpcFault(-32601,'Distinct dependent-owner managed-files protection is unavailable',{executed:false});
    this.managedFilesMember(record.uri,protect,actor);
  }
  private managedFilesProtect(value:unknown){if(value===undefined)return [];if(!Array.isArray(value)||value.length>200||value.some(id=>typeof id!=='string'||!id.startsWith('ahp-session:/')||id.length>500))throw new RpcFault(-32602,'Bounded protected session IDs required',{executed:false});return value as string[];}
  async previewManagedFiles(session:string,input:{protectSessionIds?:string[]}={},actor:ManagedFilesActor){
    return this.intake.run(async()=>{this.managedFilesActor(actor);if(!input||Object.keys(input).some(k=>k!=='protectSessionIds'))throw new RpcFault(-32602,'Managed files preview accepts protected identities only',{executed:false});const protect=this.managedFilesProtect(input.protectSessionIds),record=await this.record(session);
      return this.withLock(record.uri,async()=>{this.managedFilesGuard(record,protect,actor);await this.quiesceLifecycle(record);return this.withLifecycleFamily(record,true,()=>this.lifecycleAgent(record,async agent=>{
        const cap=(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.sessionLifecycle?.managedFiles;if(cap?.version!==1||cap.preservesCanonical!==true)throw new RpcFault(-32601,'Configured engine has no reviewed managed-file disposal',{executed:false});
        const result=await this.nativeLifecycle(agent,record,'managedFiles.preview'),allocation=this.managed!.bySession(record.uri)!;
        if(result.sessionId!==record.nativeSessionId||result.historyCwd!==record.workingDirectory||result.allocationId!==record.nativeSessionId||result.allocationHash!==allocation.marker.allocationHash||result.preservesCanonical!==true||result.manifestComplete!==true||result.canonicalFilesDeleted!==0||result.eventsDeleted!==0||typeof result.reviewId!=='string'||!result.reviewId||result.reviewId.length>200||typeof result.historyRevision!=='string'||!result.historyRevision||result.historyRevision.length>200||![result.reviewHash,result.treeHash].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||!Number.isFinite(result.expiresAt)||result.expiresAt<=Date.now()/1000||result.expiresAt>Date.now()/1000+601||!Number.isSafeInteger(result.entryCount)||result.entryCount<1||result.entryCount>10000||!Number.isSafeInteger(result.bytes)||result.bytes<0||result.bytes>256*1024*1024)throw new RpcFault(-32000,'Invalid bounded native managed-files review');
        const saved={...result,session:record.uri,actorId:actor.actorId,protectSessionIds:protect};this.managedFiles.saveReview(saved);return {...result,session:record.uri,operation:'dispose-owned-files',dependencyCheck:'held-at-apply'};
      }),row=>this.managedFilesMember(row.uri,protect,actor));});});
  }
  managedFilesEffectReceipt(session:string,commandId:string){return this.managedFiles.receipt(session,commandId)??null;}
  readManagedFilesEffectReceipt(session:string,commandId:string){return this.managedFilesEffectReceipt(session,commandId);}
  private async projectManagedFiles(record:SessionRecord,effect:Json){
    this.store.db.prepare('INSERT INTO session_visibility VALUES(?,?,?) ON CONFLICT(uri) DO UPDATE SET deleted=1,command_id=excluded.command_id').run(record.uri,1,effect.commandId);
    if(this.config.catalog){if(!this.config.catalog.setVisibility)throw new Error('Catalog cannot project confirmed disposal');await this.config.catalog.setVisibility({uri:record.uri,nativeSessionId:record.nativeSessionId!,workingDirectory:record.workingDirectory,deleted:true,commandId:effect.commandId,evidence:'native-completed-receipt'});}
    this.store.db.prepare('UPDATE sessions SET hidden=1 WHERE uri=?').run(record.uri);this.emit(record.uri,{type:'session/metaChanged',_meta:{...record.state._meta,'amplifier.dev/lifecycle':{version:1,deleted:true,managedFilesDisposed:true,preservesCanonical:true,receipt:effect.commandId}}} as StateAction);this.notify('root/sessionRemoved',{channel:ROOT,session:record.uri});this.managedFiles.update({...effect,projection:'completed'});this.store.finish(effect.commandId,'completed');
  }
  private confirmManagedFiles(record:SessionRecord,effect:Json,native:Json){
    const result=native?.receipt?.result??native,allocation=effect.allocation;
    if(native.receipt?.status!=='completed'||native.receipt.commandId!==effect.commandId||native.receipt.operation!=='managedFiles.dispose'||result.commandId!==effect.commandId||result.sessionId!==record.nativeSessionId||result.historyCwd!==record.workingDirectory||result.reviewHash!==effect.reviewHash||result.reviewId!==effect.request.reviewId||result.historyRevision!==effect.request.expectedHistoryRevision||result.allocationId!==allocation.allocationId||result.allocationHash!==allocation.allocationHash||result.treeHash!==allocation.treeHash||result.entryCount!==allocation.entryCount||result.bytes!==allocation.bytes||result.preservesCanonical!==true||result.directoryRemoved!==true||result.canonicalFilesDeleted!==0||result.eventsDeleted!==0||result.familyGuard?.ownersHeld!==true||result.familyGuard.count!==effect.familyCount)throw new Error('Managed disposal has no exact durable native completion proof');
    const confirmed={...effect,status:'completed',projection:'pending',native:result};this.managedFiles.update(confirmed);return confirmed;
  }
  async disposeManagedFiles(session:string,input:ManagedFilesApply,actor:ManagedFilesActor){
    return this.intake.run(async()=>{
      this.managedFilesActor(actor);if(!input||Object.keys(input).some(k=>!['commandId','reviewId','reviewHash','expectedHistoryRevision','protectSessionIds'].includes(k))||![input.commandId,input.reviewId,input.expectedHistoryRevision].every(v=>typeof v==='string'&&v.length>0&&v.length<=200)||typeof input.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(input.reviewHash))throw new RpcFault(-32602,'Exact managed-files review and command required',{executed:false});
      const protect=this.managedFilesProtect(input.protectSessionIds),signature=managedHash({input,actorId:actor.actorId});
      const previous=()=>{const prior=this.managedFiles.command(input.commandId);if(!prior)return;if(prior.session!==session||prior.signature!==signature)throw new RpcFault(-32011,'Disposal command differs from its original request',{executed:false});return this.managedFilesEffectReceipt(session,input.commandId);};
      const record=await this.record(session),prior=previous();if(prior)return prior;
      return this.withLock(record.uri,async()=>{
        const prior=previous();if(prior)return prior;
        this.managedFilesGuard(record,protect,actor);const review=this.managedFiles.review(input.reviewId);if(!review||review.session!==session||review.actorId!==actor.actorId||review.reviewHash!==input.reviewHash||review.historyRevision!==input.expectedHistoryRevision||review.expiresAt<=Date.now()/1000||managedHash(review.protectSessionIds)!==managedHash(protect))throw new RpcFault(-32011,'Managed files review expired, changed or belongs to another actor',{executed:false});
        const allocation={allocationId:review.allocationId,executionDirectory:record.workingDirectory,allocationHash:review.allocationHash,treeHash:review.treeHash,entryCount:review.entryCount,bytes:review.bytes};
        const effect:Json={commandId:input.commandId,session,reviewHash:input.reviewHash,operation:'dispose-owned-files',status:'unknown',preservesCanonical:true,request:input,allocation,projection:'pending'};
        const fenced=new Set<string>();const fence=(uri:string)=>{this.retentionChanging.add(uri);this.retentionChanging.add(uri.replace('ahp-session:','ahp-chat:'));fenced.add(uri);};fence(session);
        try{await this.quiesceLifecycle(record);return await this.withLifecycleFamily(record,true,async(descendants,sessions)=>{
          effect.descendants=sessions;effect.familyCount=descendants.length;
          this.store.transaction(()=>{this.store.admission(session,{operation:'dispose-owned-files',input},input.commandId,'host:managed-files',this.store.extensionSequence('host:managed-files'));this.managedFiles.reserve(session,input.commandId,signature,effect);this.store.finish(input.commandId,'dispatching');});
          let lease:Awaited<ReturnType<ManagedFilesProtection['acquire']>>|undefined,dispatched=false;
          const settleError=(error:any,known:boolean)=>{this.managedFiles.update({...effect,status:known?'refused':'unknown',...(known?{executed:false}:{}),reason:String(error.message).slice(0,1000)});this.store.finish(input.commandId,known?'failed':'unknown');return new RpcFault(-32011,String(error.message),{receipt:input.commandId,outcome:known?'refused':'unknown',...(known?{executed:false}:{})});};
          try{
            lease=await this.config.managedFilesProtection!.acquire({commandId:input.commandId,session,descendants:sessions,operation:'dispose-owned-files',reviewHash:input.reviewHash,allocation});
            if(!lease||!Array.isArray(lease.ownerIds)||!lease.ownerIds.length||lease.ownerIds.length>64||lease.ownerIds.some(id=>typeof id!=='string'||!id)||typeof lease.release!=='function')throw new Error('Managed files protection did not supply held owner coverage');
            return await this.lifecycleAgent(record,async agent=>{
              try{
                const cap=(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.sessionLifecycle?.managedFiles;if(cap?.version!==1||cap.preservesCanonical!==true)throw new RpcFault(-32601,'Native reviewed disposal is unavailable',{executed:false});
                dispatched=true;const native=await this.nativeLifecycle(agent,record,'managedFiles.dispose',{commandId:input.commandId,reviewId:input.reviewId,reviewHash:input.reviewHash,expectedHistoryRevision:input.expectedHistoryRevision,descendants});const confirmed=this.confirmManagedFiles(record,effect,native);await this.projectManagedFiles(record,confirmed);return this.managedFilesEffectReceipt(session,input.commandId);
              }catch(error){
                let proof:Json|undefined;if(dispatched)try{proof=await this.nativeLifecycle(agent,record,'managedFiles.receipt',{commandId:input.commandId});}catch{}
                if(proof?.receipt?.status==='completed'){const confirmed=this.confirmManagedFiles(record,effect,{...proof.receipt.result,receipt:proof.receipt});try{await this.projectManagedFiles(record,confirmed);}catch{}return this.managedFilesEffectReceipt(session,input.commandId);}
                // A missing receipt alone does not prove no effect: an earlier
                // request may still be running after a transport timeout.
                throw settleError(error,!dispatched||(error as any)?.data?.executed===false&&proof?.receipt===null);
              }
            });
          }catch(error){
            if(this.managedFilesEffectReceipt(session,input.commandId)?.status==='unknown'&&!dispatched)throw settleError(error,(error as any)?.data?.executed===false||!!lease&&typeof lease.release==='function');
            throw error;
          }finally{
            if(lease&&typeof lease.release==='function')try{await lease.release();this.managedFiles.update({...this.managedFilesEffectReceipt(session,input.commandId),protectionRelease:'confirmed'});}catch(error){this.managedFiles.update({...this.managedFilesEffectReceipt(session,input.commandId),protectionRelease:'unconfirmed'});throw new RpcFault(-32011,'Managed files protection release is unresolved; inspect original receipt',{receipt:input.commandId,outcome:this.managedFilesEffectReceipt(session,input.commandId)?.status,protectionRelease:'unconfirmed'});}
          }
        },row=>{this.managedFilesMember(row.uri,protect,actor);fence(row.uri);});}finally{for(const uri of fenced){this.retentionChanging.delete(uri);this.retentionChanging.delete(uri.replace('ahp-session:','ahp-chat:'));}}
      });
    });
  }
  async managedFilesReceipt(session:string,commandId:string){
    if(typeof commandId!=='string'||!commandId||commandId.length>200)throw new RpcFault(-32602,'Bounded original managed-files command required');
    const record=await this.record(session),effect=this.managedFilesEffectReceipt(session,commandId);if(!effect)return null;if(effect.status==='refused'||effect.status==='completed'&&effect.projection==='completed')return effect;
    return this.intake.inspectOnly(()=>this.withLock(session,async()=>{let confirmed=effect;if(effect.status!=='completed'){const proof=await this.lifecycleAgent(record,agent=>this.nativeLifecycle(agent,record,'managedFiles.receipt',{commandId}));if(proof?.receipt?.status==='completed')confirmed=this.confirmManagedFiles(record,effect,{...proof.receipt.result,receipt:proof.receipt});}
      if(confirmed.status==='completed'&&!this.intake.inspect().intakeClosed)await this.intake.run(()=>this.projectManagedFiles(record,confirmed));return this.managedFilesEffectReceipt(session,commandId);}));
  }
  /** Selected retired copy operations never accept filesystem paths or start an agent runtime. */
  async inventoryRetiredCopies(session:string) {return this.readRetiredCopies(session,'legacyCopy.inventory',{});}
  async previewRetiredCopyPurge(session:string,input:{rootId:string}) {
    if(!input||Object.keys(input).some(key=>key!=='rootId')||typeof input.rootId!=='string'||!input.rootId||input.rootId.length>200)throw new RpcFault(-32602,'Explicit configured retired root ID required');
    return this.readRetiredCopies(session,'legacyCopy.preview',input);
  }
  private async readRetiredCopies(session:string,operation:string,args:Json){const record=await this.record(session);return this.lifecycleAgent(record,async agent=>{const capability=(agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.sessionLifecycle?.retiredCopies;if(capability?.version!==1||capability.duplicateFilesOnly!==true)throw new RpcFault(-32601,'Configured engine has no retired-copy authority',{executed:false});const result=await this.nativeLifecycle(agent,record,operation,args);if(operation==='legacyCopy.preview'&&(result.sessionId!==record.nativeSessionId||result.rootId!==args.rootId||result.canonicalFilesDeleted!==0||result.legacyWriterCoverage!=='launcher-attested-retired'))throw new RpcFault(-32000,'Retired-copy preview identity differs');return result;});}
  async purgeRetiredCopy(session:string,input:{commandId:string;expectedHistoryRevision:string;previewId:string;previewHash:string}) {return this.mutateLifecycle(session,'legacyCopy.purge',input);}
  /** Passive exact receipt reconciliation; never retries a prior removal. */
  async retiredCopyPurgeReceipt(session:string,commandId:string){const row=this.store.db.prepare('SELECT operation,session FROM lifecycle_commands WHERE command_id=?').get(commandId);if(!row||row.operation!=='legacyCopy.purge'||row.session!==session)throw new RpcFault(-32008,'No exact selected retired-copy receipt');return this.inspectSessionLifecycleReceipt(session,commandId);}
  async exportSession(session:string,args:{commandId:string;expectedHistoryRevision:string;format:'markdown'|'json';scope?:'all'|'from'|'range';fromMessageId?:string;throughMessageId?:string;minimal?:boolean}) {return this.mutateLifecycle(session,'export',args);}
  async deleteSession(session:string,args:{commandId:string;expectedHistoryRevision:string;confirmationToken:string}) {return this.mutateLifecycle(session,'delete',args);}
  async restoreSession(session:string,args:{commandId:string;expectedHistoryRevision:string}) {return this.mutateLifecycle(session,'restore',args);}
  /** Explicit exact receipt recovery; never repeats a native lifecycle mutation. */
  async inspectSessionLifecycleReceipt(session:string,commandId:string) {
    if(typeof commandId!=='string'||!commandId||commandId.length>200)throw new RpcFault(-32602,'Bounded lifecycle command ID required');const record=await this.record(session);
    return this.withLock(record.uri,async()=>{const row=this.store.db.prepare('SELECT * FROM lifecycle_commands WHERE command_id=? AND session=?').get(commandId,record.uri);if(!row)throw new RpcFault(-32008,'No selected lifecycle receipt');if(row.status==='completed')return {status:row.status,result:JSON.parse(String(row.result)),receipt:this.store.receipt(commandId)};
      const proof=await this.lifecycleAgent(record,agent=>this.nativeLifecycle(agent,record,'receipt',{commandId}));if(proof.receipt?.status==='completed'){const result=await this.applyLifecycleResult(record,row,{...proof.receipt.result,receipt:proof.receipt});return {status:'completed',result,receipt:this.store.receipt(commandId)};}return {status:row.status,receipt:this.store.receipt(commandId),nativeReceipt:proof.receipt??null,replayed:false};});
  }
  /** Immutable host metadata only; selected ownership is checked before any bytes are read. */
  async inspectExportResource(uri:string,expectedSession:string) {
    const parsed=new URL(uri);if(parsed.protocol!=='amplifier-export:'||parsed.host||parsed.search||parsed.hash)throw new RpcFault(-32602,'An exact immutable export resource is required');
    const row=this.store.db.prepare('SELECT session,metadata FROM export_resources WHERE uri=?').get(uri);if(!row||row.session!==expectedSession)throw new RpcFault(-32008,'Export is unavailable for the selected session');
    await this.record(expectedSession);const metadata=JSON.parse(String(row.metadata));
    if(metadata.resource!==uri||typeof metadata.mimeType!=='string'||typeof metadata.contentHash!=='string'||!metadata.summary||typeof metadata.summary!=='object'||!['markdown','json'].includes(metadata.summary.format)||!['all','from','range'].includes(metadata.summary.scope)||typeof metadata.summary.minimal!=='boolean'||!Number.isSafeInteger(metadata.summary.bytes))throw new RpcFault(-32008,'Immutable export metadata is unavailable');
    return structuredClone({...metadata,session:expectedSession});
  }
  async readExportResource(uri:string) {
    const parsed=new URL(uri);if(parsed.protocol!=='amplifier-export:'||parsed.host||parsed.hash||[...parsed.searchParams.keys()].some(key=>!['offset','limit'].includes(key)))throw new RpcFault(-32602,'Invalid host export resource');
    const base='amplifier-export:'+parsed.pathname,row=this.store.db.prepare('SELECT * FROM export_resources WHERE uri=?').get(base);if(!row)throw new RpcFault(-32008,'Unknown authorized export resource');
    const offset=Number(parsed.searchParams.get('offset')??0),limit=bounded(parsed.searchParams.has('limit')?Number(parsed.searchParams.get('limit')):undefined,65536,65536),metadata=JSON.parse(String(row.metadata));if(!Number.isSafeInteger(offset)||offset<0||offset>metadata.summary.bytes)throw new RpcFault(-32602,'Invalid export byte offset');
    const record=await this.record(String(row.session)),result=await this.lifecycleAgent(record,agent=>this.nativeLifecycle(agent,record,'export.read',{snapshotId:row.snapshot_id,offset,limit}));
    if(result.offset!==offset||result.encoding!=='base64'||typeof result.data!=='string'||Buffer.byteLength(result.data,'base64')>limit||result.contentHash!==metadata.contentHash||result.nextOffset!==null&&result.nextOffset!==offset+Buffer.byteLength(result.data,'base64'))throw new RpcFault(-32000,'Native export page failed its immutable bounded contract');
    return {data:result.data,encoding:'base64',offset:result.offset,nextOffset:result.nextOffset,contentHash:metadata.contentHash,mimeType:metadata.mimeType,totalBytes:metadata.summary.bytes};
  }
  private sessionLifecycleRequest(session:string,operation:string,args:Json,actor?:ManagedFilesActor) {
    if(typeof session!=='string'||!session.startsWith('ahp-session:/'))throw new RpcFault(-32602,'Selected session channel required');
    if(operation==='managedFiles.preview')return this.previewManagedFiles(session,args,actor!);if(operation==='managedFiles.dispose')return this.disposeManagedFiles(session,args as ManagedFilesApply,actor!);if(operation==='managedFiles.receipt')return this.managedFilesReceipt(session,args.commandId);
    if(operation==='history.refresh')return this.refreshSessionHistory(session,args);if(operation==='history.revise')return this.reviseHistory(session,args as any);if(operation==='inspect')return this.inspectSessionHistory(session);if(operation==='delete.preview')return this.previewDeleteSession(session);if(operation==='receipt')return this.inspectSessionLifecycleReceipt(session,args.commandId);
    if(operation==='legacyCopy.inventory')return this.inventoryRetiredCopies(session);if(operation==='legacyCopy.preview')return this.previewRetiredCopyPurge(session,args as any);if(operation==='legacyCopy.receipt')return this.retiredCopyPurgeReceipt(session,args.commandId);
    if(['fork','export','delete','restore','legacyCopy.purge'].includes(operation))return this.mutateLifecycle(session,operation,args);throw new RpcFault(-32601,'Unsupported negotiated lifecycle operation');
  }
  private titleAdapter(record:SessionRecord) {return this.config.engines.find(engine=>engine.id===record.engineId)?.sessionMetadata;}
  private titleContext(record:SessionRecord) {return Object.freeze({session:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory});}
  private titleToken(value:unknown,label:string):asserts value is string {if(typeof value!=='string'||!value||value.length>200||/[\x00-\x1f]/.test(value))throw new RpcFault(-32602,`Bounded ${label} required`);}
  private titleValue(value:unknown):asserts value is string {if(typeof value!=='string'||value.length>1000)throw new RpcFault(-32602,'Bounded title required');}
  private titleMetadata(value:unknown):Record<string,unknown>|undefined {
    if(value===undefined)return;
    if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>65536)throw new RpcFault(-32602,'Bounded session metadata required');
    return structuredClone(value) as Record<string,unknown>;
  }
  private titleRevision(record:SessionRecord) {
    const revision=(record.state._meta?.['amplifier.dev/sessionTitle'] as Json|undefined)?.revision??0;
    if(!Number.isSafeInteger(revision)||revision<0)throw new RpcFault(-32000,'Stored title revision is invalid');
    return revision;
  }
  private async titleSnapshot(record:SessionRecord):Promise<SessionTitleSnapshot> {
    const adapter=this.titleAdapter(record);
    if(!adapter){this.titleValue(record.state.title);return {title:record.state.title,titleRevision:String(this.titleRevision(record)),metadata:this.titleMetadata(record.state._meta?.[SESSION_METADATA_KEY])};}
    this.passiveReads++;
    try {const snapshot=await adapter.readTitle(this.titleContext(record));this.titleValue(snapshot?.title);this.titleToken(snapshot?.titleRevision,'title revision');return {title:snapshot.title,titleRevision:snapshot.titleRevision,metadata:this.titleMetadata(snapshot.metadata)};}
    finally {this.passiveReads--;this.intake.workChanged();}
  }
  private projectTitleMetadata(uri:string,metadata:Record<string,unknown>|undefined) {
    if(metadata===undefined)return;
    const record=this.getRecord(uri)!;
    if(JSON.stringify(record.state._meta?.[SESSION_METADATA_KEY])!==JSON.stringify(metadata))this.emit(uri,{type:'session/metaChanged',_meta:{...record.state._meta,[SESSION_METADATA_KEY]:metadata}} as StateAction);
  }
  private async projectCanonicalTitle(record:SessionRecord,snapshot:SessionTitleSnapshot,origin?:ActionEnvelope['origin'],force=false) {
    this.projectTitleMetadata(record.uri,snapshot.metadata);
    if(force||this.getRecord(record.uri)!.state.title!==snapshot.title){this.emit(record.uri,{type:'session/titleChanged',title:snapshot.title} as StateAction,origin);this.notify('root/sessionSummaryChanged',{channel:ROOT,session:record.uri,changes:{title:snapshot.title}});await this.syncCatalog(this.getRecord(record.uri)!);}
  }
  /** Passive canonical title read. No execution runtime is mounted. */
  async readSessionTitle(session:string):Promise<SessionTitleSnapshot> {
    return this.intake.inspectOnly(async()=>{const record=await this.record(session);return this.withLock(record.uri,()=>this.titleSnapshot(this.getRecord(record.uri)!));});
  }
  /** Trusted persistence callback runs only after the selected title CAS passes. */
  async commitSessionTitle(session:string,expected:{commandId:string;expectedTitleRevision?:string},persist:(context:Readonly<SessionTitleCommitContext>)=>Promise<SessionTitleCommitResult>):Promise<SessionTitleCommitResult> {
    const commandId=expected?.commandId,expectedTitleRevision=expected?.expectedTitleRevision;this.titleToken(commandId,'original command identity');if(expectedTitleRevision!==undefined)this.titleToken(expectedTitleRevision,'expected title revision');if(typeof persist!=='function')throw new RpcFault(-32602,'Trusted title persistence callback required');
    return this.intake.run(async()=>{const record=await this.record(session);return this.withLock(record.uri,async()=>{
      const current=this.getRecord(record.uri)!,before=await this.titleSnapshot(current);
      if(expectedTitleRevision!==undefined&&before.titleRevision!==expectedTitleRevision)return {applied:false,...before};
      const result=await persist(Object.freeze({...this.titleContext(current),...structuredClone(before),commandId}));
      if(typeof result?.applied!=='boolean')throw new RpcFault(-32000,'Title persistence did not return a confirmed outcome');
      if(result.title!==undefined)this.titleValue(result.title);const metadata=this.titleMetadata(result.metadata);
      if(this.titleAdapter(current)){
        const latest=await this.titleSnapshot(this.getRecord(record.uri)!);
        this.projectTitleMetadata(record.uri,latest.metadata);
        if(result.title!==undefined)await this.projectCanonicalTitle(current,latest);
        return {applied:result.applied,...(result.title!==undefined?{title:latest.title}:{}),titleRevision:latest.titleRevision,metadata:latest.metadata};
      }
      this.projectTitleMetadata(record.uri,metadata);
      if(result.applied&&result.title!==undefined)await this.projectCanonicalTitle(current,{title:result.title,titleRevision:before.titleRevision},undefined,true);
      return {applied:result.applied,...(result.title!==undefined?{title:this.getRecord(record.uri)!.state.title}:{}),titleRevision:String(this.titleRevision(this.getRecord(record.uri)!)),metadata};
    });});
  }
  private async manualTitle(record:SessionRecord,title:string,origin:NonNullable<ActionEnvelope['origin']>) {
    this.titleValue(title);const adapter=this.titleAdapter(record)!;const before=await this.titleSnapshot(this.getRecord(record.uri)!);
    const commandId='title-'+createHash('sha256').update(JSON.stringify([record.uri,origin.clientId,origin.clientSeq])).digest('hex');
    const result=await adapter.writeTitle(Object.freeze({...this.titleContext(record),...structuredClone(before),commandId,expectedTitleRevision:before.titleRevision}),Object.freeze({title}));
    if(result?.applied!==true)throw new RpcFault(-32011,'The title change was not confirmed. Inspect its original outcome before retrying.');
    await this.projectCanonicalTitle(record,await this.titleSnapshot(this.getRecord(record.uri)!),origin,true);
  }
  private retirementFence(record:SessionRecord):Json|undefined {return record.state._meta?.['amplifier.dev/retirement'] as Json|undefined;}
  private retirementFenceMatches(record:SessionRecord,active:Active,commandId?:string) {
    const fence=this.retirementFence(record);
    const receipt=typeof fence?.commandId==='string'?this.store.receipt(fence.commandId):undefined;
    return fence?.version===1&&fence.commandId===active.retirementCommandId&&receipt?.clientId==='host:retirement'&&receipt.channel===record.uri&&['admitted','unknown'].includes(receipt.status)&&(!commandId||fence.commandId===commandId)&&fence.connectionId===active.agent.connectionId&&fence.nativeSessionId===active.agent.nativeId&&fence.nativeSessionId===record.nativeSessionId&&fence.engineId===record.engineId&&fence.engineId===active.agent.engine.id&&fence.workingDirectory===record.workingDirectory;
  }
  private guardRetirementRecord(record:SessionRecord) {
    if(this.retirementFence(record)!==undefined)throw new RpcFault(-32011,'This chat is waiting for confirmation that its previous runtime stopped. Your new message was not sent.',{executed:false,replayed:false,outcome:'unknown'});
  }
  private saveRetirementFence(record:SessionRecord,active:Active,outcome:'pending'|'unknown'|'clear') {
    const current=this.getRecord(record.uri)!;
    const prior=this.retirementFence(current);
    if(outcome==='pending') {
      this.guardRetirementRecord(current);
      const fence={version:1,outcome,commandId:'host-retirement:'+randomUUID(),connectionId:active.agent.connectionId,nativeSessionId:active.agent.nativeId,engineId:current.engineId,workingDirectory:current.workingDirectory};
      active.retirementCommandId=fence.commandId;
      current.state._meta={...current.state._meta,'amplifier.dev/retirement':fence};
      this.store.transaction(()=>{this.store.admission(current.uri,{operation:'retire',fence},fence.commandId,'host:retirement',this.store.extensionSequence('host:retirement'));this.store.saveSessionMetadata(current);});
    }else {
      if(!this.retirementFenceMatches(current,active))return;
      current.state._meta={...current.state._meta};
      if(outcome==='clear')delete current.state._meta['amplifier.dev/retirement'];
      else current.state._meta['amplifier.dev/retirement']={...prior,outcome};
      this.store.transaction(()=>{this.store.finish(prior!.commandId,outcome==='unknown'?'unknown':active.agent.retirementOutcome==='retired'?'completed':'failed');this.store.saveSessionMetadata(current);});
    }
  }

  private async retireActive(uri:string,active:Active,timeoutMs=10000) {
    const record=this.getRecord(uri)!;
    const retired=await active.agent.retireIfIdle(timeoutMs,()=>this.saveRetirementFence(record,active,'pending'));
    this.saveRetirementFence(record,active,active.agent.retirementOutcome==='unknown'||active.agent.retirementOutcome==='pending'?'unknown':'clear');
    return retired;
  }
  private async reconcileRetirementUnderLock(record:SessionRecord) {
    const active=this.active.get(record.uri);
    if(!active||active.agent.retirementOutcome!=='unknown'||active.agent.nativeId!==record.nativeSessionId||!this.retirementFenceMatches(record,active))return {retired:false,connectionClosed:false,workReplayed:false,reason:'not-fenced'};
    const commandId=this.retirementFence(record)!.commandId;
    const status=await active.agent.inspectRetirement();
    if(!status.retired)return {retired:false,connectionClosed:false,workReplayed:false,reason:status.reason};
    if(!this.retirementFenceMatches(this.getRecord(record.uri)!,active,commandId))return {retired:false,connectionClosed:false,workReplayed:false,reason:'changed-fence'};
    this.saveRetirementFence(record,active,'clear');
    // The negotiated native status owner proves the exact handle retired. A
    // worker-closed notification or an absent reply never reaches this branch.
    active.retireReason='idle-retired';await active.agent.retire();await active.stopCallback;
    if(this.active.get(record.uri)===active)this.active.delete(record.uri);
    return {retired:true,connectionClosed:true,workReplayed:false};
  }
  /** Trusted selected-session proof recheck. No input or retirement is replayed. */
  async reconcileSessionRetirement(session:string) {
    return this.intake.run(async()=>{const record=await this.record(session);return this.withLock(record.uri,()=>this.reconcileRetirementUnderLock(this.getRecord(record.uri)!));});
  }
  private guardRetirement(active:Active) {
    if(['pending','unknown','retired'].includes(active.agent.retirementOutcome))throw new RpcFault(-32011,'This chat is waiting for confirmation that its previous runtime stopped. Your new message was not sent.',{executed:false,replayed:false,outcome:'unknown'});
  }
  private async ensureAgent(uri:string,creation?:{sessionId:string;source:Json;commandId:string}):Promise<Active> {
    return this.intake.run(async()=>{
    if(this.relocationFence(uri))throw new RpcFault(-32011,'Session relocation outcome is fenced; inspect and reconcile without replay');
    this.guardSessionLifecycle(uri);
    const existing=this.active.get(uri);if(existing?.stopCallback)await existing.stopCallback;if(existing)this.guardRetirement(existing);this.guardRetirementRecord(await this.record(uri));if(existing&&!existing.agent.closed)return existing;
    if(existing?.agent.closed)this.active.delete(uri);
    if(this.starting.has(uri))return this.starting.get(uri)!;
    const pending=(async()=>{
      // Publish pending deduplication before admitting a process-start reservation.
      await Promise.resolve();
      await this.withAgentCapacity(async()=>{
        const count=()=>new Set([...this.active.keys(),...this.admittedStarts]).size;
        while(count()>=(this.config.maxActiveAgents??8)) {
          if(!await this.retireIdleUnderCapacity(true))throw new RpcFault(-32000,'Active agent capacity reached; no safe cached agent can be retired');
        }
        this.admittedStarts.add(uri);
      });
      const record=await this.record(uri),engine=this.config.engines.find(e=>e.id===record.engineId);
      if(!engine)throw new RpcFault(-32002,'Session engine is not configured');
      await this.selectedWorkspace(record,true);
      const active:Active={agent:null as any,busy:false,lastUsed:performance.now(),uninterestedSince:performance.now(),interested:this.agentInterested(uri),tools:new Set(),permissions:new Map()};
      const agent=new AcpProcess(engine,record.executionDirectory??record.workingDirectory,{
        hostCapabilities:this.config.nativeHostCapabilities,
        hostRuntimeRetention:true,
        admitEffect:work=>this.intake.run(work),
        update:params=>{
          const bytes=Buffer.byteLength(JSON.stringify(params));active.updateCount=(active.updateCount??0)+1;active.updateBytes=(active.updateBytes??0)+bytes;
          if(active.updateCount>512||active.updateBytes>8*1024*1024){agent.process.kill();return Promise.reject(new Error('ACP update queue capacity exceeded; execution outcome requires reconciliation'));}
          const update=(active.updates??Promise.resolve()).then(()=>this.update(uri,params)).finally(()=>{active.updateCount!--;active.updateBytes!-=bytes;});active.updates=update;return update;
        },permission:async params=>{await active.updates;return this.permission(uri,params);},
        terminal:event=>this.terminalEvent(uri,event),
        stopped:event=>this.notifyAgentStopped(uri,active,active.retireReason??'process-closed',event),
        nativeEvent:async params=>{
          const event=params.event as Json|undefined;
          if(event) this.steeringEvent(uri,active,event);
          if(event?.type==='history.revised')this.confirmHistoryRevision(uri,active,event);
          if(active.busy&&((event?.type==='input.accepted'&&event.input_id===active.turnId)||(event?.type==='generation.started'&&event.activeInputId===active.turnId)))this.projectPendingTurn(uri,active);
          if(event?.type==='runtime.ready')active.stopNotified=false;
          if(event?.type==='runtime.closed')this.notifyAgentStopped(uri,active,active.retireReason??'runtime-closed');
          if(event?.type==='history.persisted'&&typeof event.metadataPath==='string'&&isAbsolute(event.metadataPath)&&basename(event.metadataPath)==='metadata.json') {
            // The independent catalog validates its configured native roots and reloads metadata.
            if(!this.getRecord(uri)?.nativeSessionId){active.pendingHints??=[];if(active.pendingHints.length<64)active.pendingHints.push(dirname(event.metadataPath));}
            else await this.catalogHint(dirname(event.metadataPath));
          }
          if(agent.nativeId&&this.config.nativeEvent)await this.intake.continuation(()=>this.config.nativeEvent!({session:uri,nativeSessionId:agent.nativeId!,workingDirectory:record.executionDirectory??record.workingDirectory},params));
        },
        ...(this.config.nativeHostRequest?{hostRequest:async(_method:string,params:Json)=>{
          const observation=params.operation==='operations.observe'&&this.config.nativeHostCapabilities?.features?.operations===true;
          if(!agent.nativeId||agent.closed||this.active.get(uri)!==active||active.stopNotified||(!active.busy&&!active.controlDepth&&!observation))throw new Error('Host capability requires an admitted native turn, scoped native control or negotiated owned-operation observation');
          let bytes=0;
          if(observation){const args=params.args as Json|undefined;bytes=Buffer.byteLength(JSON.stringify(args??{}));if(typeof args?.runtimeSessionId!=='string'||!args.runtimeSessionId||args.runtimeSessionId.length>512||!args.event||typeof args.event!=='object'||Array.isArray(args.event)||bytes>256*1024||(active.observationPending??0)>=32||(active.observationBytes??0)+bytes>1024*1024)throw new Error('Owned operation observation exceeded its scoped callback bounds');active.observationPending=(active.observationPending??0)+1;active.observationBytes=(active.observationBytes??0)+bytes;}
          try{return await this.intake.continuation(()=>this.config.nativeHostRequest!({session:uri,nativeSessionId:agent.nativeId!,workingDirectory:record.executionDirectory??record.workingDirectory},params));}finally{if(observation){active.observationPending!--;active.observationBytes!-=bytes;}}
        }}:{}),
      });active.agent=agent;this.touchAgent(active);this.active.set(uri,active);
      try {const response=await agent.start(record.nativeSessionId,creation,record.workingDirectory);const fresh=this.getRecord(uri)!,location=response?._meta?.['amplifier.dev/native'] as Json|undefined;if(location?.executionDirectory!==undefined){if(location.historyCwd!==record.workingDirectory||location.executionDirectory!==(record.executionDirectory??record.workingDirectory)||!Number.isSafeInteger(location.executionRevision))throw new Error('Native execution location differs from the authorized host mapping; reconcile before executing');fresh.nativeLocationRevision=location.executionRevision;}fresh.nativeSessionId=agent.nativeId;fresh.state._meta={...fresh.state._meta,'amplifier.dev/acp':{...(fresh.state._meta?.['amplifier.dev/acp'] as Json),capabilities:agent.initialized.agentCapabilities,configOptions:response?.configOptions??[],configOptionsProtocol:response?.configOptions===undefined&&response?.modes?'legacy-mode':'standard',...(response?.modes?{legacyModes:response.modes}: {})}};this.store.save(fresh);await this.syncCatalog(fresh);for(const path of active.pendingHints??[])await this.catalogHint(path);active.pendingHints=[];this.configState(uri,response?.configOptions??this.legacyModeOptions(response?.modes));this.touchAgent(active);return active;}
      catch(error){active.retireReason='startup-failed';this.active.delete(uri);await agent.retire();throw error;}
    })();this.starting.set(uri,pending);try{return await pending;}finally{this.starting.delete(uri);this.admittedStarts.delete(uri);}
      });
  }
  private async catalogHint(path:string){if(this.presentation)this.presentation.enqueueHint(path);else await this.config.catalog?.hint?.(path);}
  private async repairArchiveProjection() {
    const catalog=this.config.catalog;if(!catalog?.projectSessionArchives)return;
    while(true){const rows=this.store.db.prepare('SELECT uri,is_archived FROM archive_projection_pending ORDER BY uri LIMIT 100').all();if(!rows.length)return;
      await catalog.projectSessionArchives({items:rows.map(row=>({uri:String(row.uri),isArchived:!!row.is_archived}))});
      this.store.transaction(()=>{for(const row of rows)this.store.db.prepare('DELETE FROM archive_projection_pending WHERE uri=? AND is_archived=?').run(row.uri,row.is_archived);});
    }
  }
  private libraryUnknown(uri:string):boolean {
    const chat=chatURI(uri);
    return !!this.store.db.prepare("SELECT 1 FROM receipts WHERE channel IN (?,?) AND json_extract(payload,'$.status')='unknown' LIMIT 1").get(uri,chat)
      || !!this.store.db.prepare("SELECT 1 FROM relocations WHERE uri=? AND status='unknown' UNION ALL SELECT 1 FROM transfer_fences WHERE session=? AND status='unknown' UNION ALL SELECT 1 FROM transfer_commands WHERE session=? AND status='unknown' UNION ALL SELECT 1 FROM lifecycle_commands WHERE (session=? OR target=?) AND status='unknown' UNION ALL SELECT 1 FROM history_edits WHERE session=? AND status='unknown' UNION ALL SELECT 1 FROM steering_intents WHERE chat=? AND status='unknown' UNION ALL SELECT 1 FROM import_adoptions WHERE session=? AND status='unknown' LIMIT 1").get(uri,uri,uri,uri,uri,uri,chat,uri);
  }
  private libraryMetadata(uri:string):CatalogRecord|undefined {
    const row=this.store.db.prepare('SELECT engine_id,native_id,cwd,summary,state FROM sessions WHERE uri=?').get(uri);if(!row)return;
    const summary=JSON.parse(String(row.summary)),state=JSON.parse(String(row.state));
    return {uri,engineId:String(row.engine_id),nativeSessionId:row.native_id?String(row.native_id):undefined,workingDirectory:String(row.cwd),title:summary.title,createdAt:summary.createdAt,modifiedAt:summary.modifiedAt,status:summary.status,isArchived:!!(summary.status&SessionStatus.IsArchived),availability:'available',workspaceAvailability:'present',...(state._meta?.['amplifier.dev/location']?{location:state._meta['amplifier.dev/location']}:{})};
  }
  private libraryLiveFacts():LiveFact[] {
    const uris=new Set([...this.active.keys(),...this.starting.keys()]);if(uris.size>64)throw Error('Live library fact capacity exceeded');
    const items:LiveFact[]=[];
    for(const uri of uris){const row=this.libraryMetadata(uri);if(!row)continue;const status=Number(row.status)||0,active=this.active.get(uri),unknown=this.libraryUnknown(uri);
      items.push({uri,runtime:unknown?'unknown':status&16?'input-needed':active?.busy||active?.finishing||this.starting.has(uri)?'working':'idle',effect:unknown?'unknown':status&SessionStatus.Error?'error':active?.busy?'unverified':'settled',modifiedAt:active?.busy&&active.started?active.started/1000:Date.parse(row.modifiedAt)/1000});}
    return items;
  }
  /** Trusted Workspace callback. Grants are intersected, never widened by caller roots. */
  async queryLibrary(params:LibraryQuery){
    if(!this.library)throw new RpcFault(-32601,'Versioned library query unavailable');
    if(!Array.isArray(params.allowedWorkspaceRoots)||params.allowedWorkspaceRoots.length>128)throw new RpcFault(-32602,'Workspace owner grants required');
    const roots=new Set<string>();for(const grant of params.allowedWorkspaceRoots){if(typeof grant!=='string'||!isAbsolute(grant))throw new RpcFault(-32602,'Absolute workspace grant required');const candidate=resolve(grant);for(const host of this.roots){const within=(child:string,parent:string)=>child===parent||child.startsWith(parent.endsWith('/')?parent:parent+'/');if(within(candidate,host))roots.add(candidate);else if(within(host,candidate))roots.add(host);}}
    try{return await this.withConversationCatalogRead(()=>this.library!.query({...params,allowedWorkspaceRoots:[...roots],allowedManagedRoots:this.managed?[this.managed.root]:[]}));}
    catch(error){if((error as any).code===-32014)return {version:1 as const,items:[],available:false,refreshRequired:true,reason:'library-changed-or-expired'};throw error;}
  }
  reconcileLibrary(){return this.library?.reconcile()??Promise.resolve();}
  private async syncCatalog(record:SessionRecord) {
    if(!this.config.catalog)return;
    const projection:CatalogRecord={uri:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory,title:record.summary.title,createdAt:record.summary.createdAt,modifiedAt:record.summary.modifiedAt,status:record.summary.status,isArchived:!!(record.summary.status & SessionStatus.IsArchived),availability:'available',workspaceAvailability:'present',...((record.state._meta?.['amplifier.dev/location'])?{location:record.state._meta!['amplifier.dev/location'] as ManagedLocation}:{})};
    if(this.library)await this.library.write(projection);else await this.config.catalog.upsert(projection);
    if(this.presentation){const indexed=await this.config.catalog.get(record.uri);if(indexed?.nativeSessionId)this.presentation.retainMapping(indexed as unknown as Json);}
    if(this.config.catalog.projectSessionArchives)this.store.db.prepare('DELETE FROM archive_projection_pending WHERE uri=? AND is_archived=?').run(record.uri,Number(!!(record.summary.status & SessionStatus.IsArchived)));
  }
  private emit(channel:string,action:StateAction,origin?:ActionEnvelope['origin'],rejectionReason?:string):ActionEnvelope {
    let previous=this.getRecord(channel);
    // Read is shared session metadata. Record a standard unread action at work
    // boundaries so the session reducer cannot preserve an obsolete read flag.
    // History loading and token deltas never create read-state write traffic.
    const unread=previous&&!rejectionReason&&(
      channel===previous.uri&&action.type==='session/inputNeededSet'||
      channel===previous.chat.resource&&(action.type==='chat/turnStarted'||
        action.type==='chat/turnResume'||action.type==='chat/inputRequested'||
        ['chat/turnComplete','chat/turnCancelled','chat/error'].includes(action.type)&&
          'turnId' in action&&action.turnId===previous.chat.activeTurn?.id));
    if(unread&&(previous!.state.status&SessionStatus.IsRead)!==0){
      this.emit(previous!.uri,{type:'session/isReadChanged',isRead:false} as StateAction);
      previous=this.getRecord(channel)!;
      this.notify('root/sessionSummaryChanged',{channel:ROOT,session:previous.uri,changes:{status:previous.summary.status}});
    }
    let record=previous?{...previous}:undefined;
    const priorSummary=record&&JSON.stringify(this.chatSummary(record.chat));
    const envelope=this.store.transaction(()=>{
      const terminal=this.terminalState(channel);
      if(terminal&&!rejectionReason){const next=terminalReducer(terminal,action as any);this.store.db.prepare('UPDATE terminals SET payload=?,modified=?,lifecycle=? WHERE uri=?').run(JSON.stringify(next),now(),next.lifecycle.status,channel);}
      if(record&&!rejectionReason) {
        if(channel===record.chat.resource) {
          // The projection holds only the active turn. Completed history is independently indexed.
          const reduced=chatReducer({...record.chat,turns:[]},action as any);
          if(action.type!=='chat/turnsLoaded')for(const turn of reduced.turns){const ordinal=this.store.saveTurn(channel,turn);if(this.loadedFloors.has(channel))this.loadedFloors.set(channel,Math.min(this.loadedFloors.get(channel)!,ordinal));const window=this.nativeWindows.get(channel);if(window&&!window.ids.includes(turn.id))window.ids.push(turn.id);}
          record.chat={...reduced,turns:[]};
        } else {record.state=sessionReducer(record.state,action as any);if(action.type==='session/titleChanged'&&!this.titleAdapter(record)){const revision=this.titleRevision(previous!)+1;if(!Number.isSafeInteger(revision))throw new RpcFault(-32000,'Title revision capacity reached');record.state._meta={...record.state._meta,'amplifier.dev/sessionTitle':{revision}};}}
        record.summary={...record.summary,title:record.state.title,status:(record.chat.status & ~(SessionStatus.IsArchived|SessionStatus.IsRead)) | (record.state.status & (SessionStatus.IsArchived|SessionStatus.IsRead)),modifiedAt:record.chat.modifiedAt};
        if(channel===record.uri)this.store.saveSessionMetadata(record);
        else if(record.chat.activeTurn&&action.type!=='chat/turnStarted'&&action.type!=='chat/turnsLoaded')this.store.appendActive(channel,action);
        else this.store.save(record);
      }
      return this.store.append(channel,action,origin,rejectionReason);
    });
    if(record&&!rejectionReason){if(record.chat.activeTurn)this.hotRecords.set(record.uri,record);else this.hotRecords.delete(record.uri);}
    if(record&&!rejectionReason&&['chat/turnStarted','chat/turnResume','chat/turnComplete','chat/turnCancelled','chat/error','chat/inputRequested','session/inputNeededSet','session/inputNeededRemoved'].includes(action.type))this.library?.point(record.uri);
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
      this.notify('root/sessionSummaryChanged',{channel:ROOT,session:record.uri,changes:{status:this.getRecord(record.uri)!.summary.status,modifiedAt:record.chat.modifiedAt}});
    }
    return envelope;
  }
  private queueMessage(message:Message,held:boolean,reason?:string):Message {
    return {...message,_meta:{...message._meta,'amplifier.dev/queue':{held,...(reason?{reason}:{})}}};
  }
  private holdQueue(chat:string,reason:string) {
    this.store.transaction(()=>{
      for(const row of this.store.db.prepare("SELECT id,message FROM queue_intents WHERE chat=? AND status='pending' ORDER BY position").all(chat)){
        this.store.db.prepare("UPDATE queue_intents SET held=1,reason=? WHERE id=?").run(reason,row.id);
        this.emit(chat,{type:'chat/pendingMessageSet',kind:'queued',id:String(row.id),message:this.queueMessage(JSON.parse(String(row.message)),true,reason)} as PendingQueueAction);
      }
    });
  }
  /** Trusted user/agent owners share the same standard AHP queue admission as connected clients. */
  async updatePendingQueue(session:string,action:PendingQueueAction,context:{clientId:string}) {
    return this.intake.run(async()=>{
    if(!context||typeof context.clientId!=='string'||!context.clientId||context.clientId.length>256)throw new RpcFault(-32602,'Queue actor identity required');
    const record=await this.record(session);
    return this.withLock(record.uri,()=>this.applyQueueAction(record,action,{clientId:context.clientId,clientSeq:this.store.extensionSequence(context.clientId)}));
      });
  }
  private async applyQueueAction(record:SessionRecord,action:PendingQueueAction,origin:NonNullable<ActionEnvelope['origin']>) {
    if(this.closing)throw new RpcFault(-32011,'Host is shutting down');
    const channel=record.chat.resource;
    if((action.type==='chat/pendingMessageSet'||action.type==='chat/pendingMessageRemoved')&&action.kind==='steering')return this.applySteeringAction(record,action,origin);
    if(action.type==='chat/pendingMessageSet'){
      if(action.kind!=='queued')throw new RpcFault(-32601,'Active steering requires a negotiated native admission lifecycle');
      if(typeof action.id!=='string'||!action.id||action.id.length>128||!action.message||typeof action.message.text!=='string'||action.message.origin?.kind!=='user')throw new RpcFault(-32602,'Bounded pending user message required');
      await this.prompt(action.message,record,false);
      const message=this.queueMessage(action.message,false),payload=JSON.stringify(message),bytes=Buffer.byteLength(payload);
      const prior=this.store.db.prepare('SELECT chat,status,position FROM queue_intents WHERE id=?').get(action.id);
      if(prior&&(prior.chat!==channel||prior.status!=='pending')||this.store.receipt(action.id)||this.store.db.prepare('SELECT 1 FROM steering_intents WHERE id=?').get(action.id))throw new RpcFault(-32011,'Queue identity was already consumed, removed or belongs to another conversation; it cannot be replayed');
      const local=this.store.db.prepare("SELECT count(*) n,coalesce(sum(length(CAST(message AS BLOB))),0) bytes FROM queue_intents WHERE status='pending' AND chat=? AND id!=?").get(channel,action.id)!;
      const global=this.store.db.prepare("SELECT count(*) n,coalesce(sum(length(CAST(message AS BLOB))),0) bytes FROM queue_intents WHERE status='pending' AND id!=?").get(action.id)!;
      if(Number(local.n)>=50||Number(local.bytes)+bytes>1024*1024||Number(global.n)>=1024||Number(global.bytes)+bytes>16*1024*1024)throw new RpcFault(-32000,'Pending queue count/byte capacity reached');
      const held=!!this.store.unknown(channel),reason=held?'prior-execution-unknown':undefined;
      const position=prior?.position??Number(this.store.db.prepare("SELECT coalesce(max(position),-1)+1 n FROM queue_intents WHERE chat=? AND status='pending'").get(channel)!.n);
      this.store.transaction(()=>{
        this.store.db.prepare("INSERT INTO queue_intents(id,chat,message,origin,position,status,held,reason) VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(id) DO UPDATE SET message=excluded.message,origin=excluded.origin,held=excluded.held,reason=excluded.reason").run(action.id,channel,payload,JSON.stringify(origin),position,held?1:0,reason??null);
        this.emit(channel,{...action,message:this.queueMessage(message,held,reason)},origin.clientSeq>=0?origin:undefined);
      });
      await this.drainQueue(record.uri);return {accepted:true,id:action.id,pending:!this.store.receipt(action.id)};
    }
    if(action.type==='chat/pendingMessageRemoved'){
      if(action.kind!=='queued'||typeof action.id!=='string'||!action.id||action.id.length>128)throw new RpcFault(-32602,'Queued message identity required');
      const row=this.store.db.prepare('SELECT chat,status FROM queue_intents WHERE id=?').get(action.id);
      if(row?.chat&&row.chat!==channel)throw new RpcFault(-32009,'Queued message belongs to another conversation');
      if(!row||row.status==='removed')throw new RpcFault(-32008,'No pending queued message with this identity');
      if(row?.status==='consumed'||this.store.receipt(action.id))throw new RpcFault(-32011,'Queued input is already admitted; cancel its active turn instead');
      this.store.transaction(()=>{this.store.db.prepare("INSERT INTO queue_intents(id,chat,message,origin,position,status,held,reason) VALUES(?,?,NULL,?,0,'removed',1,'removed') ON CONFLICT(id) DO UPDATE SET message=NULL,status='removed',held=1,reason='removed'").run(action.id,channel,JSON.stringify(origin));this.emit(channel,action,origin.clientSeq>=0?origin:undefined);});return {accepted:true,id:action.id,pending:false};
    }
    if(action.type!=='chat/queuedMessagesReordered'||!Array.isArray(action.order)||action.order.length>50||action.order.some(id=>typeof id!=='string'||id.length>128))throw new RpcFault(-32602,'Bounded queue order required');
    const rows=this.store.db.prepare("SELECT id FROM queue_intents WHERE chat=? AND status='pending' ORDER BY position").all(channel),ids=rows.map(row=>String(row.id)),order=[...new Set([...action.order.filter(id=>ids.includes(id)),...ids])];
    this.store.transaction(()=>{order.forEach((id,index)=>this.store.db.prepare('UPDATE queue_intents SET position=? WHERE id=?').run(index,id));this.emit(channel,action,origin.clientSeq>=0?origin:undefined);});return {accepted:true};
  }
  private async applySteeringAction(record:SessionRecord,action:Extract<PendingQueueAction,{type:'chat/pendingMessageSet'|'chat/pendingMessageRemoved'}>,origin:NonNullable<ActionEnvelope['origin']>) {
    const chat=record.chat.resource;
    if(typeof action.id!=='string'||!action.id||action.id.length>128)throw new RpcFault(-32602,'Bounded steering identity required');
    const prior=this.store.db.prepare('SELECT * FROM steering_intents WHERE id=?').get(action.id);
    if(prior&&prior.chat!==chat)throw new RpcFault(-32009,'Steering identity belongs to another conversation');
    if(action.type==='chat/pendingMessageRemoved'){
      if(!prior||prior.status!=='pending')throw new RpcFault(-32011,'No unconsumed steering input; already consumed input cannot be retracted');
      this.store.transaction(()=>{this.store.db.prepare("UPDATE steering_intents SET status='removed',message=NULL WHERE id=?").run(action.id);this.emit(chat,action,origin.clientSeq>=0?origin:undefined);});return {accepted:true,id:action.id,pending:false};
    }
    const native=(record.state._meta?.['amplifier.dev/acp'] as Json)?.capabilities?._meta?.['amplifier.dev/native'];
    if(native?.activeSteering?.version!==1||native.activeSteering.mode!=='request_boundary')throw new RpcFault(-32601,'Agent does not advertise generation-anchored request-boundary steering');
    if(!action.message||typeof action.message.text!=='string'||!action.message.text.trim()||action.message.text.length>16000||action.message.origin?.kind!=='user'||action.message.attachments?.length||action.message.model||action.message.agent)throw new RpcFault(-32602,'Steering supports bounded user text; multimodal or per-message configuration is not negotiated');
    if(supportsPublicOriginal(native?.publicMessagePreservation,'steer.submit'))capturePublicMessage(action.message,action.id);
    const payload=JSON.stringify(action.message);if(Buffer.byteLength(payload)>65536)throw new RpcFault(-32000,'Steering message exceeds byte bound');
    if(prior&&prior.status!=='pending'||this.store.receipt(action.id)||this.store.db.prepare('SELECT 1 FROM queue_intents WHERE id=?').get(action.id))throw new RpcFault(-32011,'Steering identity already consumed or removed; inspect its receipt without replay');
    const capacity=this.store.db.prepare("SELECT count(*) n,coalesce(sum(length(CAST(message AS BLOB))),0) bytes FROM steering_intents WHERE status IN ('pending','dispatching') AND id!=?").get(action.id)!;
    if(Number(capacity.n)>=1024||Number(capacity.bytes)+Buffer.byteLength(payload)>16*1024*1024)throw new RpcFault(-32000,'Pending steering capacity reached');
    const held=!!this.store.unknown(chat),activeTurnId=this.getRecord(record.uri)!.chat.activeTurn?.id??null;
    this.store.transaction(()=>{
      this.store.db.prepare("UPDATE steering_intents SET status='removed',message=NULL WHERE chat=? AND status='pending' AND id!=?").run(chat,action.id);
      this.store.db.prepare("INSERT INTO steering_intents(id,chat,message,origin,status,held,active_turn_id) VALUES(?,?,?,?,'pending',?,?) ON CONFLICT(id) DO UPDATE SET message=excluded.message,origin=excluded.origin,held=excluded.held,active_turn_id=excluded.active_turn_id").run(action.id,chat,payload,JSON.stringify(origin),held?1:0,activeTurnId);
      this.emit(chat,{...action,message:{...action.message,_meta:{...action.message._meta,'amplifier.dev/steering':{held,...(held?{reason:'prior-execution-unknown'}:{})}}}},origin.clientSeq>=0?origin:undefined);
    });
    this.consumeSteering(record.uri);return {accepted:true,id:action.id,pending:!this.store.receipt(action.id)};
  }
  /** Only the immutable current generation may consume an intent. No new prompt collector. */
  private consumeSteering(session:string) {
    const record=this.getRecord(session)!,active=this.active.get(session);
    if(this.closing||!active?.busy||!active.generationId||active.cancel||!record.chat.activeTurn||active.turnId!==record.chat.activeTurn.id||this.store.unknown(record.chat.resource))return;
    const capability=(active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.activeSteering;
    if(capability?.version!==1||capability.mode!=='request_boundary')return;
    const row=this.store.db.prepare("SELECT * FROM steering_intents WHERE chat=? AND status='pending' AND held=0 LIMIT 1").get(record.chat.resource);if(!row||row.active_turn_id&&row.active_turn_id!==active.turnId)return;
    if((active.steeringRuns?.size??0)>=16||Number(this.store.db.prepare("SELECT count(*) n FROM steering_intents WHERE chat=? AND active_turn_id=? AND status='dispatching'").get(record.chat.resource,active.turnId)!.n)>=50)return;
    const id=String(row.id),message=JSON.parse(String(row.message)),origin=JSON.parse(String(row.origin)),activeInputId=active.turnId!,generationId=active.generationId;
    const original=this.captureOriginal(active,message,id,'steer.submit');
    this.store.transaction(()=>{this.store.admission(record.chat.resource,{kind:'steering',id,message,activeInputId,generationId},id,origin.clientId,origin.clientSeq);this.store.db.prepare("UPDATE steering_intents SET status='dispatching',active_turn_id=?,generation_id=?,projected=0 WHERE id=?").run(activeInputId,generationId,id);});
    this.emit(record.chat.resource,{type:'chat/pendingMessageRemoved',kind:'steering',id} as PendingQueueAction);this.store.db.prepare('UPDATE steering_intents SET projected=1 WHERE id=?').run(id);this.store.finish(id,'dispatching');
    let acceptanceTimer:ReturnType<typeof setTimeout>|undefined;
    const request=this.withAgentUse(active,()=>active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation:'steer.submit',args:{inputId:id,activeInputId,text:message.text},...(original?{_meta:{[PUBLIC_MESSAGE_META]:original}}:{})}));
    const pending=Promise.race([request,new Promise<never>((_resolve,reject)=>{acceptanceTimer=setTimeout(()=>reject(new Error('Native steering acceptance deadline expired')),bounded(this.config.steeringOutcomeTimeoutMs,10000,60000));acceptanceTimer.unref();})]).then(result=>{
      if(result.accepted===false&&result.executed===false){this.settleSteering(session,id,'held',String(result.reason??'Native steering refused before execution'));return;}
      if(result.accepted!==true||result.inputId!==id||result.activeInputId!==activeInputId||result.generationId!==generationId||!['queued','applied','held','unknown'].includes(String(result.disposition)))throw new Error('Invalid native steering disposition');
      if(result.disposition!=='queued')this.settleSteering(session,id,result.disposition as 'applied'|'held'|'unknown',String(result.reason??result.disposition));
    }).catch(error=>this.settleSteering(session,id,'unknown',(error as Error).message)).finally(()=>{clearTimeout(acceptanceTimer);active.steeringRuns?.delete(pending);});
    active.steeringRuns??=new Set();active.steeringRuns.add(pending);
  }
  private steeringEvent(session:string,active:Active,event:Json) {
    if(event.type==='generation.started'&&active.busy&&event.activeInputId===active.turnId&&typeof event.generation_id==='string'&&event.generation_id.length<=128){
      active.generationId=event.generation_id;
      void this.withLock(session,async()=>this.consumeSteering(session)).catch(()=>{});return;
    }
    if(!['steering.applied','steering.held','steering.unknown'].includes(event.type)||typeof event.input_id!=='string')return;
    const row=this.store.db.prepare('SELECT * FROM steering_intents WHERE id=? AND chat=?').get(event.input_id,chatURI(session));
    if(!row||row.active_turn_id!==event.activeInputId||row.generation_id!==event.target_generation_id)return;
    this.settleSteering(session,event.input_id,event.type.slice('steering.'.length) as 'applied'|'held'|'unknown',String(event.reason??event.type).slice(0,512));
  }
  private settleSteering(session:string,id:string,disposition:'applied'|'held'|'unknown',reason:string) {
    const chat=chatURI(session),row=this.store.db.prepare('SELECT * FROM steering_intents WHERE id=? AND chat=?').get(id,chat);
    if(!row||row.status!=='dispatching')return;
    clearTimeout(this.steeringTimers.get(id));this.steeringTimers.delete(id);
    const active=this.active.get(session);if(active?.turnId===row.active_turn_id)this.touchAgent(active);
    this.store.transaction(()=>{this.store.db.prepare('UPDATE steering_intents SET status=?,held=1,reason=? WHERE id=?').run(disposition,reason.slice(0,1024),id);this.store.finish(id,disposition==='applied'?'completed':disposition==='held'?'failed':'unknown','steering:'+disposition+': '+reason.slice(0,512));});
    if(active&&!active.busy&&!active.cancel&&!active.controlDepth&&!this.closing&&this.store.receipt(active.turnId!)?.detail==='end_turn')void this.withLock(session,()=>this.drainQueue(session)).catch(()=>{});
    this.intake.workChanged();
  }
  /** Caller holds the session mutex. Never drains held/unknown inputs or replays a receipt. */
  private async drainQueue(session:string) {
    if(this.closing)return;
    const record=this.getRecord(session),active=this.active.get(session);
    if(!record||record.chat.activeTurn||active?.busy||active?.controlDepth)return;
    const row=this.store.db.prepare("SELECT * FROM queue_intents WHERE chat=? AND status='pending' ORDER BY position LIMIT 1").get(record.chat.resource);
    if(!row||row.held)return;
    try{
      const action={type:'chat/turnStarted',turnId:String(row.id),queuedMessageId:String(row.id),startedAt:now(),message:JSON.parse(String(row.message))} as Extract<StateAction,{type:'chat/turnStarted'}>;
      await this.admitTurn(record,record.chat.resource,action,JSON.parse(String(row.origin)));
    }catch(error){if(['admitted','dispatching'].includes(this.store.receipt(String(row.id))?.status??''))this.store.finish(String(row.id),'unknown',(error as Error).message);this.holdQueue(record.chat.resource,'admission-refused: '+(error as Error).message.slice(0,256));}
  }
  /** Caller holds the selected session mutex; cancellation never mounts a runtime. */
  private async requestCancellation(record:SessionRecord,action:Extract<StateAction,{type:'chat/turnCancelled'}>,origin:ActionEnvelope['origin']) {
    const active=this.active.get(record.uri);
    if(!active?.busy||active.turnId!==action.turnId)throw new RpcFault(-32011,'No matching active turn',{executed:false});
    if(active.cancel)throw new RpcFault(-32011,'Cancellation already requested',{executed:false});
    this.store.bump(record.uri,'interruption');this.holdQueue(record.chat.resource,'turn-cancelled');active.cancel={action,origin};
    for(const pending of active.permissions.values())pending.resolve({outcome:{outcome:'cancelled'}});active.permissions.clear();
    await this.withAgentUse(active,()=>active.agent.client.cancel({sessionId:active.agent.nativeId!}));
    // The standard cancellation action is emitted only when ACP settles.
  }
  async interruptSession(session:string,input:{commandId:string;turnId:string;clientId:string;origin?:'agent'|'ui'}) {
    return this.intake.run(async()=>{
    if(!input||[input.commandId,input.turnId,input.clientId].some(value=>typeof value!=='string'||!value||value.length>512)||input.origin!==undefined&&!['agent','ui'].includes(input.origin))throw new RpcFault(-32602,'Bounded interruption identity and exact turn are required');
    const record=await this.record(session),signature=createHash('sha256').update(JSON.stringify([record.uri,input.turnId,input.clientId,input.origin??'ui'])).digest('hex');
    return this.withLock(record.uri,async()=>{
      const prior=this.store.receipt(input.commandId);if(prior){if(prior.channel!==record.chat.resource||prior.requestSignature!==signature)throw new RpcFault(-32011,'Interruption command identity changed');return {accepted:prior.status==='completed',delivery:prior.status==='completed'?'requested':'unknown',turnId:input.turnId,receipt:prior,replayed:false};}
      const active=this.active.get(record.uri);if(this.closing||!active?.busy||active.turnId!==input.turnId||active.cancel)return {accepted:false,executed:false,reason:'No matching uncancelled active turn',turnId:input.turnId};
      const action={type:'chat/turnCancelled',turnId:input.turnId,duration:0} as Extract<StateAction,{type:'chat/turnCancelled'}>,origin={clientId:input.clientId,clientSeq:this.store.extensionSequence(input.clientId)};
      this.store.transaction(()=>{this.store.admission(record.chat.resource,{operation:'interrupt',action,origin:input.origin??'ui'},input.commandId,input.clientId,origin.clientSeq);this.store.annotateReceipt(input.commandId,{requestSignature:signature});this.store.finish(input.commandId,'dispatching');});
      try{await this.requestCancellation(record,action,undefined);this.store.finish(input.commandId,'completed','Cancellation requested; consult the original turn outcome');return {accepted:true,delivery:'requested',turnId:input.turnId,receipt:this.store.receipt(input.commandId),replayed:false};}
      catch(error){this.store.finish(input.commandId,'unknown',String(error));throw new RpcFault(-32011,'Interruption delivery is unknown; do not replay',{receipt:input.commandId,outcome:'unknown'});}
    });
      });
  }
  private async dispatch(peer:Peer,p:Json) {
    if(!Number.isSafeInteger(p.clientSeq)||p.clientSeq<0||!p.action||typeof p.action.type!=='string')throw new RpcFault(-32602,'Invalid dispatch');
    const origin={clientId:peer.clientId!,clientSeq:p.clientSeq},action=p.action as StateAction;
    try {
      await this.intake.run(async()=>{
      if(peer.seenClientSeq.has(p.clientSeq)||p.clientSeq<=peer.lastClientSeq-1024)throw new Error('Client action sequence was already used or expired');peer.lastClientSeq=Math.max(peer.lastClientSeq,p.clientSeq);peer.seenClientSeq.add(p.clientSeq);for(const seq of peer.seenClientSeq)if(seq<=peer.lastClientSeq-1024)peer.seenClientSeq.delete(seq);
      const record=await this.record(p.channel);
      await this.withLock(record.uri,async()=>{
        if(['chat/pendingMessageSet','chat/pendingMessageRemoved','chat/queuedMessagesReordered'].includes(action.type)){if(p.channel!==record.chat.resource)throw new Error('Queue action requires chat channel');await this.applyQueueAction(record,action as PendingQueueAction,origin);return;}
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
          if(action.queuedMessageId)throw new Error('Only the host can consume a queued message');
          await this.admitTurn(record,p.channel,action,origin);return;
        }
        if(action.type==='chat/turnCancelled') {
          await this.requestCancellation(record,action,origin);return;
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
        if(action.type==='session/titleChanged'&&this.titleAdapter(record)){if(p.channel!==record.uri)throw new Error('Action requires session channel');await this.manualTitle(record,action.title,origin);return;}
        if(action.type==='session/titleChanged'||action.type==='session/isReadChanged'||action.type==='session/isArchivedChanged') {
          if(p.channel!==record.uri)throw new Error('Action requires session channel');
          this.emit(p.channel,action,origin);this.notify('root/sessionSummaryChanged',{channel:ROOT,session:record.uri,changes:{title:this.getRecord(record.uri)!.summary.title,status:this.getRecord(record.uri)!.summary.status}});await this.syncCatalog(this.getRecord(record.uri)!);return;
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
            await this.withAgentUse(active,()=>active.agent.client.setSessionMode({sessionId:active.agent.nativeId!,modeId:value}));
            this.configState(record.uri,this.legacyModeOptions({...modes,currentModeId:value}));
          }else{const response=await this.withAgentUse(active,()=>active.agent.client.setSessionConfigOption({sessionId:active.agent.nativeId!,configId,value}));this.configState(record.uri,response.configOptions);}
          this.emit(p.channel,action,origin);return;
        }
        throw new Error(`Action is unsupported: ${action.type}`);
      });
      });
    } catch(error) {this.emit(p.channel,action,origin,(error as Error).message);}
  }
  private async admitTurn(record:SessionRecord,channel:string,action:Extract<StateAction,{type:'chat/turnStarted'}>,origin:NonNullable<ActionEnvelope['origin']>,special?:SettledInput,trustedAgent=false) {
    return this.intake.run(async()=>{
    record=this.getRecord(record.uri)!;
    if(this.closing)throw new Error('Host is shutting down');
    this.guardSessionLifecycle(record.uri);
    if(this.store.db.prepare('SELECT 1 FROM steering_intents WHERE id=?').get(action.turnId))throw new Error('Command identity is reserved by a steering intent');
    const reservedQueue=this.store.db.prepare('SELECT chat,status FROM queue_intents WHERE id=?').get(action.turnId);
    if(reservedQueue&&(action.queuedMessageId!==action.turnId||reservedQueue.chat!==channel||reservedQueue.status!=='pending'))throw new Error('Command identity is reserved by a queued intent; use queue controls');
    if(channel!==record.chat.resource||!action.turnId||typeof action.message?.text!=='string'||(action.message.origin?.kind!=='user'&&!(trustedAgent&&action.message.origin?.kind==='agent')&&!(special?.operation==='observation.submit'&&action.message.origin?.kind==='systemNotification'))||!Number.isFinite(Date.parse(action.startedAt)))throw new Error('Malformed user turn');
    if(record.state.lifecycle!==SessionLifecycle.Ready)throw new Error('Session creation has not completed; reconcile its outcome before execution');
    if(this.store.db.prepare("SELECT 1 FROM steering_intents WHERE chat=? AND status='dispatching' LIMIT 1").get(channel))throw new Error('A prior steering disposition is pending; wait for its receipt');
    if(this.store.unknown(channel))throw new Error('A prior execution outcome is unknown; reconcile native history first');
    if(this.getRecord(record.uri)!.chat.activeTurn)throw new Error('A turn is already running; use pending message actions');
    if(special?.operation!=='observation.submit'&&this.active.get(record.uri)?.agent.retirementOutcome==='unknown')await this.reconcileRetirementUnderLock(record);
    const active=special?.operation==='observation.submit'?this.active.get(record.uri):await this.ensureAgent(record.uri);
    if(!active||active.agent.closed||special?.operation==='observation.submit'&&active.stopNotified)throw new RpcFault(-32008,'waiting_worker',{executed:false});
    this.guardRetirement(active);
    if(this.closing)throw new Error('Host is shutting down');
    if(active.busy)throw new Error('The previous ACP turn has not finished; wait for its authoritative outcome');
    const publicOriginal=this.captureOriginal(active,action.message,action.turnId,special?.operation??'prompt');
    const blocks=await this.prompt(action.message,record);
    this.checkContentCapabilities(active,blocks);
    const reply=this.messageReply(action.message);
    if(reply){
      const native=active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined,capability=native?.messageInteractions;
      if(special||active.agent.engine.messagePrincipal===undefined||native?.version!==1||capability?.version!==1||capability.quoteMeta!=='amplifier.dev/messageReply'||!record.nativeSessionId||active.agent.nativeId!==record.nativeSessionId)throw new RpcFault(-32601,'Configured engine does not support quoted message inputs',{executed:false,replayed:false});
    }
    if(special){
      const native=active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined,capability=native?.[special.operation==='schedule.submit'?'scheduledTurns':special.operation==='question.submit'?'questionTurns':special.operation==='history.revise'?'historyEdits':'observationTurns'];
      if(capability?.version!==1||capability.completion!=='settled')throw new Error(`Agent does not advertise settled ${special.operation}`);
      if(special.expected){const current=await this.inspectSession(record.uri);if(current.interruptionRevision!==special.expected.interruptionRevision||current.executionRevision!==special.expected.executionRevision||current.configurationHash!==special.expected.configurationHash)throw new Error('Scheduled admission revisions changed');}
    }
    const historyPrefix=special?.operation==='history.revise'?await this.nativeHistory(record,50,undefined,{beforeTurnId:special.args.targetMessageId,expectedRevision:special.args.expectedHistoryRevision}):undefined;
    this.store.transaction(()=>{if(special?.operation==='history.revise'){this.store.db.prepare('INSERT INTO history_edits VALUES(?,?,?,?,?)').run(special.args.operationId,record.uri,action.turnId,'admitted',JSON.stringify(special.args));this.store.bump(record.uri,'interruption');}if(special?.operation==='observation.submit')this.store.reopenKnownRefusal(action.turnId,channel,special.requestSignature!);this.store.admission(channel,action,action.turnId,origin.clientId,origin.clientSeq);if(special?.requestSignature)this.store.annotateReceipt(action.turnId,{requestSignature:special.requestSignature});if(action.queuedMessageId){const changed=this.store.db.prepare("UPDATE queue_intents SET status='consumed',message=NULL,projected=0 WHERE id=? AND chat=? AND status='pending' AND held=0").run(action.queuedMessageId,channel);if(changed.changes!==1)throw new Error('Queued intent changed before admission');}this.store.bump(record.uri,'execution');});
    this.store.db.prepare("UPDATE steering_intents SET active_turn_id=? WHERE chat=? AND status='pending' AND held=0 AND active_turn_id IS NULL").run(action.turnId,channel);
    this.touchAgent(active);active.publicOriginal=publicOriginal;active.busy=true;active.generationId=undefined;active.steeringRuns=new Set();active.cancel=undefined;active.projectionBytes=Buffer.byteLength(JSON.stringify(action));active.turnId=action.turnId;active.started=Date.now();active.textPart=undefined;active.textMessageId=undefined;active.reasoningPart=undefined;active.tools.clear();active.toolStates=new Map();
    if(action.queuedMessageId)this.emit(channel,{type:'chat/pendingMessageRemoved',kind:'queued',id:action.queuedMessageId} as PendingQueueAction);
    active.historyRevision=historyPrefix?{args:special!.args,prefix:historyPrefix,confirmed:false}:undefined;
    if(special?.operation==='history.revise')active.pendingTurn={action,origin:origin.clientSeq>=0?origin:undefined};
    else if(special?.operation==='observation.submit'){active.pendingTurn={action,origin:origin.clientSeq>=0?origin:undefined};active.observationAdmission={inputId:action.turnId,watchId:special.args.watchId,taskId:special.args.taskId,taskRevision:special.args.taskRevision,outcomeDigest:createHash('sha256').update(JSON.stringify(special.args.outcome)).digest('hex'),expectedExecutionRevision:special.expected!.executionRevision,expectedInterruptionRevision:special.expected!.interruptionRevision,expectedConfigurationHash:special.expected!.configurationHash,admittedExecutionRevision:this.store.revisions(record.uri).executionRevision};this.store.annotateReceipt(action.turnId,{observationAdmission:active.observationAdmission});}else this.emit(channel,action,origin.clientSeq>=0?origin:undefined);if(action.queuedMessageId)this.store.db.prepare('UPDATE queue_intents SET projected=1 WHERE id=?').run(action.queuedMessageId);this.store.finish(action.turnId,'dispatching');active.run=this.run(record.uri,active,blocks,special);
      });
  }
  /** Trusted capability owners submit user-authorized inputs through ordinary admission. */
  async submitTurn(session:string,input:{commandId:string;text:string;clientId:string;attachments?:Message['attachments'];origin?:'agent'|'ui'}) {
    return this.intake.run(async()=>{
    if(typeof input.commandId!=='string'||!input.commandId||input.commandId.length>512||typeof input.clientId!=='string'||!input.clientId||typeof input.text!=='string'||Buffer.byteLength(input.text)>1024*1024)throw new RpcFault(-32602,'Bounded command, client identity and text are required');
    if(input.origin!==undefined&&!['agent','ui'].includes(input.origin))throw new RpcFault(-32602,'Unsupported turn origin');
    if(input.attachments&&(!Array.isArray(input.attachments)||input.attachments.length>16||Buffer.byteLength(JSON.stringify(input.attachments))>8*1024*1024))throw new RpcFault(-32602,'Attachments exceed the admitted input bound');
    const record=await this.record(session);
    await this.withLock(record.uri,async()=>{if(this.store.receipt(input.commandId))throw new RpcFault(-32011,'Command already admitted; inspect its durable receipt before new work');await this.admitTurn(record,record.chat.resource,{type:'chat/turnStarted',turnId:input.commandId,startedAt:now(),message:{text:input.text,origin:{kind:input.origin==='agent'?'agent':'user'},...(input.origin==='agent'?{_meta:{'amplifier.dev/input':{inputOrigin:'coordination'}}}:{}),...(input.attachments?{attachments:input.attachments}:{})}} as any,{clientId:input.clientId,clientSeq:this.store.extensionSequence(input.clientId)},undefined,input.origin==='agent');});
    return {accepted:true,inputId:input.commandId,sessionId:record.uri,delivery:'sending',receipt:this.store.receipt(input.commandId)};
      });
  }
  /** Durable common creation for a configured source; no native history or goals are copied. */
  async createSession(input:{commandId:string;idempotencyKey:string;sourceSession:string;expectedConfigurationHash:string;title?:string}) {
    return this.intake.run(async()=>{
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||typeof input.idempotencyKey!=='string'||!input.idempotencyKey||input.idempotencyKey.length>512||typeof input.expectedConfigurationHash!=='string'||(input.title!==undefined&&(typeof input.title!=='string'||input.title.length>1000)))throw new RpcFault(-32602,'Bounded creation identity and expected configuration required');
    const source=await this.record(input.sourceSession);const identity=createHash('sha256').update(JSON.stringify([source.uri,input.idempotencyKey])).digest('hex');
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
      if(source.state._meta?.['amplifier.dev/location'])return this.cloneManagedSession(source,input,uri,identity,fingerprint);
      const active=await this.ensureAgent(source.uri);
      if((active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.configurationClone?.version!==1)throw new RpcFault(-32601,'Agent does not advertise exact configuration cloning');
      if(active.busy)throw new RpcFault(-32011,'Source must be idle while its configuration is captured');
      const snapshot=await this.withAgentUse(active,()=>active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation:'configuration.snapshot',args:{}}));
      if(snapshot.version!==1||snapshot.sourceSessionId!==active.agent.nativeId||snapshot.sourceCwd!==source.workingDirectory||typeof snapshot.configurationHash!=='string'||Buffer.byteLength(JSON.stringify(snapshot))>65536)throw new RpcFault(-32000,'Invalid native configuration snapshot reference');
      if((await this.inspectSession(source.uri)).configurationHash!==input.expectedConfigurationHash)throw new RpcFault(-32011,'Source configuration changed while preparing creation');
      this.store.db.prepare('INSERT INTO creation_keys VALUES(?,?,?,?)').run(identity,input.commandId,uri,fingerprint);
      await this.createSessionResource({channel:uri,provider:source.engineId,workingDirectories:[pathToFileURL(source.workingDirectory).href],title:input.title},{sessionId:nativeId,source:snapshot,commandId:input.commandId});
      return {uri,creationConfirmed:true as const,receipt:this.store.receipt(input.commandId)};
    });
      });
  }
  private async cloneManagedSession(source:SessionRecord,input:{commandId:string;title?:string;expectedConfigurationHash:string},uri:string,identity:string,fingerprint:string){
    this.guardSessionLifecycle(source.uri);this.guardTransfer(source.uri);
    if(this.store.unknown(source.chat.resource)||this.relocationFence(source.uri))throw new RpcFault(-32011,'Source execution is unresolved; configuration cannot be copied',{executed:false});
    const request={session:uri,commandId:input.commandId,provider:source.engineId,title:input.title??source.summary.title};this.managed!.validate(request);
    await this.quiesceLifecycle(source);
    return this.managedAgent(source.engineId,async agent=>{
      if((agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.managedCreation?.configurationCopy?.version!==1)throw new RpcFault(-32601,'Engine does not support passive managed configuration copies',{executed:false});
      const snapshot:Json=await agent.client.extMethod('_amplifier/managed',{operation:'configuration.snapshot',sessionId:source.nativeSessionId,cwd:source.workingDirectory});
      if(snapshot.version!==1||snapshot.sourceSessionId!==source.nativeSessionId||snapshot.sourceCwd!==source.workingDirectory||snapshot.executionDirectory!==source.workingDirectory||typeof snapshot.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.configurationHash))throw new RpcFault(-32000,'Invalid exact native configuration reference');
      if((await this.inspectSession(source.uri)).configurationHash!==input.expectedConfigurationHash)throw new RpcFault(-32011,'Source configuration changed while preparing creation',{executed:false});
      this.store.transaction(()=>{this.store.db.prepare('INSERT INTO creation_keys VALUES(?,?,?,?)').run(identity,input.commandId,uri,fingerprint);this.store.admission(uri,{operation:'managed.configuration-clone',source:source.uri,snapshot},input.commandId,'host:create',this.store.extensionSequence('host:create'));this.store.finish(input.commandId,'dispatching');});
      let allocation:Json|undefined;
      try{
        await this.withLock('@directory-reservations',async()=>{allocation=this.managed!.reserve(request,{operation:'configuration-clone',sessionId:source.nativeSessionId,configurationHash:snapshot.configurationHash});await this.managed!.allocate(allocation);this.managed!.settle(input.commandId,'dispatching');});
        const proof:Json=await agent.client.extMethod('_amplifier/managed',{...this.managedNativeParams(allocation!,'create'),operation:'clone',source:snapshot});
        await this.confirmManaged(allocation!,proof);return {uri,creationConfirmed:true as const,receipt:this.store.receipt(input.commandId)};
      }catch(error){if(allocation)this.managed!.settle(input.commandId,'unknown');this.store.finish(input.commandId,'unknown');throw new RpcFault(-32011,(error as Error).message,{receipt:input.commandId,outcome:'unknown',allocationOccurred:!!allocation});}
    });
  }
  /** Compare-and-admit scheduled work under the same session lock as user turns and stop. */
  async submitScheduled(session:string,input:{commandId:string;text:string;taskId:string;taskRevision:number;kind:'task'|'monitor';expectedInterruptionRevision:number;expectedExecutionRevision:number;expectedConfigurationHash:string;scheduledRunId?:string}) {
    return this.intake.run(async()=>{
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||typeof input.text!=='string'||Buffer.byteLength(input.text)>1024*1024||typeof input.taskId!=='string'||!input.taskId||input.taskId.length>512||!['task','monitor'].includes(input.kind)||![input.taskRevision,input.expectedInterruptionRevision,input.expectedExecutionRevision].every(n=>Number.isSafeInteger(n)&&n>=0)||typeof input.expectedConfigurationHash!=='string')throw new RpcFault(-32602,'Malformed bounded scheduled admission');
    const record=await this.record(session);
    return this.withLock(record.uri,async()=>{
      if(this.store.receipt(input.commandId))throw new RpcFault(-32011,'Scheduled command already admitted; inspect its receipt without replay');
      try {
        const meta={inputOrigin:'scheduled',scheduledRunId:input.scheduledRunId??input.commandId,taskId:input.taskId,taskRevision:input.taskRevision,kind:input.kind};
        await this.admitTurn(record,record.chat.resource,{type:'chat/turnStarted',turnId:input.commandId,startedAt:now(),message:{text:input.text,origin:{kind:'user'},_meta:{'amplifier.dev/scheduled':meta}}} as any,{clientId:'host:schedule',clientSeq:this.store.extensionSequence('host:schedule')},{operation:'schedule.submit',args:{taskId:input.taskId,taskRevision:input.taskRevision,text:input.text,kind:input.kind,interruptionRevision:input.expectedInterruptionRevision},expected:{executionRevision:input.expectedExecutionRevision,interruptionRevision:input.expectedInterruptionRevision,configurationHash:input.expectedConfigurationHash}});
        return {accepted:true,turnId:input.commandId,receipt:this.store.receipt(input.commandId)};
      }catch(error){if(this.store.receipt(input.commandId))throw error;return {accepted:false,reason:(error as Error).message};}
    });
      });
  }
  /** Saved answer authority is checked by the native questions owner before execution. Idle only. */
  async submitQuestionAnswer(session:string,input:{commandId:string;text:string;questionId:string;questionRevision:number;answerProvenance:Json}) {
    return this.intake.run(async()=>{
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>1024*1024||typeof input.questionId!=='string'||!input.questionId||input.questionId.length>200||!Number.isSafeInteger(input.questionRevision)||input.questionRevision<0||!input.answerProvenance||typeof input.answerProvenance!=='object'||Array.isArray(input.answerProvenance)||Buffer.byteLength(JSON.stringify(input.answerProvenance))>8192)throw new RpcFault(-32602,'Bounded question identity, revision, answer and provenance required');
    const record=await this.record(session);
    return this.withLock(record.uri,async()=>{
      if(this.store.receipt(input.commandId))throw new RpcFault(-32011,'Question command already admitted; inspect its receipt without replay');
      try{
        const metadata={inputOrigin:'question',questionId:input.questionId,questionRevision:input.questionRevision,answerProvenance:input.answerProvenance};
        await this.admitTurn(record,record.chat.resource,{type:'chat/turnStarted',turnId:input.commandId,startedAt:now(),message:{text:input.text,origin:{kind:'user'},_meta:{'amplifier.dev/input':metadata}}} as any,{clientId:'host:question',clientSeq:this.store.extensionSequence('host:question')},{operation:'question.submit',args:{text:input.text,questionId:input.questionId,questionRevision:input.questionRevision,answerProvenance:input.answerProvenance}});
        return {accepted:true,turnId:input.commandId,receipt:this.store.receipt(input.commandId)};
      }catch(error){if(this.store.receipt(input.commandId))throw new RpcFault(-32011,(error as Error).message,{receipt:input.commandId,outcome:'unknown',executed:true});return {accepted:false,executed:false,reason:(error as Error).message};}
    });
      });
  }
  /** A finite typed observation, never a user prompt or authority to execute embedded instructions. */
  async submitObservation(session:string,input:{commandId:string;watchId:string;taskId:string;taskRevision:number;outcome:Json;expectedExecutionRevision:number;expectedInterruptionRevision:number;expectedConfigurationHash:string}) {
    return this.intake.run(async()=>{
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||![input.watchId,input.taskId].every(id=>typeof id==='string'&&id.length>0&&id.length<=200)||![input.taskRevision,input.expectedExecutionRevision,input.expectedInterruptionRevision].every(value=>Number.isSafeInteger(value)&&value>=0)||typeof input.expectedConfigurationHash!=='string'||!input.outcome||typeof input.outcome!=='object'||Array.isArray(input.outcome)||Buffer.byteLength(JSON.stringify(input.outcome))>65536)throw new RpcFault(-32602,'Bounded typed observation and expected admission revisions required');
    const record=await this.record(session);
    return this.withLock(record.uri,async()=>{
      const requestSignature=createHash('sha256').update(JSON.stringify([input.commandId,input.watchId,input.taskId,input.taskRevision,input.outcome])).digest('hex'),prior=this.store.receipt(input.commandId);
      if(prior&&(prior.channel!==record.chat.resource||prior.status!=='failed'||prior.retryEligibility!=='waiting_worker'||prior.requestSignature!==requestSignature))throw new RpcFault(-32011,'Observation command already admitted; only an exact explicitly retryable no-effect refusal may be retried');
      try{
        const metadata={inputOrigin:'observation',watchId:input.watchId,taskId:input.taskId,taskRevision:input.taskRevision};
        await this.admitTurn(record,record.chat.resource,{type:'chat/turnStarted',turnId:input.commandId,startedAt:now(),message:{text:JSON.stringify({contract:'amplifier.observation.v1',watchId:input.watchId,result:input.outcome}),origin:{kind:'systemNotification'},_meta:{'amplifier.dev/input':metadata}}} as any,{clientId:'host:observation',clientSeq:this.store.extensionSequence('host:observation')},{operation:'observation.submit',requestSignature,args:{watchId:input.watchId,taskId:input.taskId,taskRevision:input.taskRevision,outcome:input.outcome},expected:{executionRevision:input.expectedExecutionRevision,interruptionRevision:input.expectedInterruptionRevision,configurationHash:input.expectedConfigurationHash}});
        return {accepted:true,turnId:input.commandId,receipt:this.store.receipt(input.commandId)};
      }catch(error){const current=this.store.receipt(input.commandId);if(current&&current.retryEligibility!=='waiting_worker')throw new RpcFault(-32011,(error as Error).message,{receipt:input.commandId,outcome:'unknown',executed:true});return {accepted:false,executed:false,reason:(error as Error).message,...(current?.retryEligibility?{receipt:current}: {})};}
    });
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
    return {generation_id:commandId,status:current.status,completed:current.status==='completed',text,detail:current.detail,...(current.retryEligibility?{executed:false,retryEligibility:current.retryEligibility,observationAdmission:current.observationAdmission}:{}),workContinues:['admitted','dispatching'].includes(current.status)};
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
      const steering=this.store.db.prepare("SELECT length(CAST(message AS BLOB)) bytes,CASE WHEN length(CAST(message AS BLOB))<=? THEN message END message FROM steering_intents WHERE chat=? AND id=? AND status IN ('applied','held','unknown','dispatching')").get(maxBytes,record.chat.resource,messageId);
      const row:Json|undefined=steering?{...steering,created_at:this.store.receipt(messageId)?.createdAt}:this.store.db.prepare("SELECT length(CAST(json_extract(payload,'$.message') AS BLOB)) AS bytes, CASE WHEN length(CAST(json_extract(payload,'$.message') AS BLOB))<=? THEN json_extract(payload,'$.message') END AS message, json_extract(payload,'$.startedAt') AS created_at FROM turns WHERE chat=? AND turn_id=?").get(maxBytes,record.chat.resource,messageId);
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
    limit=bounded(limit,12,50);const record=await this.record(session);let turns:Array<Turn|NonNullable<ChatState['activeTurn']>>=this.store.turns(record.chat.resource,limit).turns;
    if((record.chat._meta?.['amplifier.dev/history'] as Json)?.source==='native')turns=(await this.selectedHistory(record,limit)).turns;
    const current=this.getRecord(record.uri)!.chat.activeTurn;
    if(current)turns=[...turns.filter(turn=>turn.id!==current.id),current].slice(-limit);
    const messages:Json[]=[];
    for(const turn of turns){
      const history=turn.message._meta?.['amplifier.dev/history'] as Json|undefined,scheduled=turn.message._meta?.['amplifier.dev/scheduled'] as Json|undefined,input=turn.message._meta?.['amplifier.dev/input'] as Json|undefined,receipt=this.store.receipt(turn.id);
      const questionId=input?.questionId??history?.questionId,scheduledRunId=scheduled?.scheduledRunId??input?.scheduledRunId??history?.scheduledRunId;
      const provenance={createdAt:history?.createdAt??turn.startedAt,inputOrigin:scheduled||scheduledRunId?'scheduled':questionId?'question':history?.via==='call'?'voice':input?.inputOrigin??history?.inputOrigin??(receipt?.channel===record.chat.resource?'user':'unknown'),...(questionId?{questionId}:{}),...(scheduledRunId?{scheduledRunId}:{}),...(history?.via==='call'?{voiceId:history.callId,voiceItemId:history.itemId}:{}),...(history?.authorization?{authorization:history.authorization}:{})};
      if(turn.message.text)messages.push({id:turn.id,role:turn.message.origin?.kind==='agent'?'assistant':turn.message.origin?.kind==='systemNotification'?'system':'user',text:turn.message.text.slice(0,5000),truncated:turn.message.text.length>5000,...provenance});
      for(const steering of this.store.db.prepare("SELECT id,message FROM steering_intents WHERE chat=? AND active_turn_id=? AND status='applied' ORDER BY rowid DESC LIMIT ?").all(record.chat.resource,turn.id,limit).reverse()){
        const correction=JSON.parse(String(steering.message)),admitted=this.store.receipt(String(steering.id));
        messages.push({id:String(steering.id),role:'user',text:correction.text.slice(0,5000),truncated:correction.text.length>5000,createdAt:admitted?.createdAt,inputOrigin:'user',activeTurnId:turn.id,delivery:'steering'});
      }
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
    const observer={session:record.uri,chat:record.chat.resource,queue:[] as ActionEnvelope[],bytes:0,running:false,closed:false,listener,onError};if(this.presentationSelections.has(record.uri))await this.withLock(record.uri,async()=>{this.observers.add(observer);});else this.observers.add(observer);
    return ()=>{observer.closed=true;observer.queue=[];this.observers.delete(observer);};
  }
  /** Only bounded native locators and frozen quotes cross into selectable history metadata. */
  private nativeMessageHistory(record:SessionRecord,value:Json|undefined):Json|undefined {
    if(value===undefined)return;
    const fail=()=>{throw new RpcFault(-32000,'Native message quote metadata is invalid or exceeds its bound');};
    if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>32768)return fail();
    const result={...value};delete result.messageReference;delete result.replyTo;
    if(value.messageReference!==undefined&&!value.historicalOnly){
      const locator=value.messageReference;if(!locator||typeof locator!=='object'||Array.isArray(locator)||locator.sessionId!==record.nativeSessionId||locator.messageId!==value.messageId||typeof locator.sourceDigest!=='string')return fail();
      const {sessionId,...reference}=locator;
      try{result.messageReference={sessionId,...this.messageReply({_meta:{'amplifier.dev/messageReply':reference}})};}catch{return fail();}
    }
    if(value.replyTo!==undefined){
      const quote=value.replyTo,token=(item:unknown)=>typeof item==='string'&&item.length>0&&[...item].length<=200&&!/[\x00-\x1f]/.test(item),hex=(item:unknown)=>typeof item==='string'&&/^[a-f0-9]{64}$/.test(item);
      if(!quote||typeof quote!=='object'||Array.isArray(quote)||Object.keys(quote).sort().join(',')!=='excerpt,historyEpoch,id,inputId,messageId,role,sessionId,sourceDigest,truncated'||!hex(quote.id)||!token(quote.sessionId)||!token(quote.messageId)||!['user','assistant'].includes(quote.role)||!hex(quote.sourceDigest)||(quote.historyEpoch!==null&&!token(quote.historyEpoch))||!token(quote.inputId)||typeof quote.excerpt!=='string'||[...quote.excerpt].length>4000||typeof quote.truncated!=='boolean')return fail();
      result.replyTo=structuredClone(quote);
    }
    return result;
  }
  /** Browser references locate native public text; they never supply quote or actor authority. */
  private messageReply(message:Pick<Message,'_meta'>):Json|undefined {
    const value=message._meta?.['amplifier.dev/messageReply'] as Json|undefined;if(value===undefined)return;
    const validToken=(item:unknown)=>typeof item==='string'&&item.length>0&&[...item].length<=200&&!/[\x00-\x1f]/.test(item);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['messageId','position','historyEpoch','sourceDigest'].includes(key))||!['messageId','position','historyEpoch'].every(key=>Object.hasOwn(value,key))||!validToken(value.messageId)||!Number.isSafeInteger(value.position)||Number(value.position)<0||(value.historyEpoch!==null&&!validToken(value.historyEpoch))||(Object.hasOwn(value,'sourceDigest')&&(typeof value.sourceDigest!=='string'||!/[a-f0-9]{64}/.test(value.sourceDigest)||value.sourceDigest.length!==64))||Buffer.byteLength(JSON.stringify(value))>2048)throw new RpcFault(-32602,'Exact bounded native message reply reference required',{executed:false,replayed:false});
    return structuredClone(value);
  }
  private captureOriginal(active:Active,message:Message,inputId:string,route:string):PublicMessageV1|undefined {
    const capability=(active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json|undefined)?.publicMessagePreservation;
    if(!supportsPublicOriginal(capability,route,!!message.attachments?.length))return;
    return capturePublicMessage(message,inputId);
  }
  private async prompt(message:Message,record:SessionRecord,resolveReferences=true):Promise<ContentBlock[]> {
    this.messageReply(message);
    if(message.model||message.agent)throw new Error('Per-message model/custom-agent selection is not advertised; use session configuration');
    const blocks:ContentBlock[]=[{type:'text',text:message.text}];
    if((message.attachments?.length??0)>16)throw new RpcFault(-32602,'At most sixteen attachments per input');
    for(const attachment of message.attachments??[]) {
      if(attachment.type==='resource'&&resolveReferences&&this.config.resolvePromptAttachment){const resolved=await this.config.resolvePromptAttachment({session:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.executionDirectory??record.workingDirectory},structuredClone(attachment));if(resolved!==undefined){if(!Array.isArray(resolved)||resolved.length>16)throw new RpcFault(-32602,'Attachment resolver exceeded block count');blocks.push(...resolved);continue;}}
      if(attachment.type==='simple'&&attachment.modelRepresentation)blocks.push({type:'text',text:attachment.modelRepresentation});
      else if(attachment.type==='resource')blocks.push({type:'resource_link',uri:attachment.uri,name:attachment.label,mimeType:attachment.contentType});
      else if(attachment.type==='embeddedResource') {
        if(attachment.contentType.startsWith('image/'))blocks.push({type:'image',mimeType:attachment.contentType,data:attachment.data});
        else if(attachment.contentType.startsWith('audio/'))blocks.push({type:'audio',mimeType:attachment.contentType,data:attachment.data});
        else blocks.push({type:'resource',resource:{uri:`amplifier-input:/${createHash('sha256').update(attachment.data).digest('hex')}#${encodeURIComponent(attachment.label??'Attachment')}`,mimeType:attachment.contentType,blob:attachment.data}});
      } else throw new Error(`Attachment type unsupported: ${attachment.type}`);
    }if(Buffer.byteLength(JSON.stringify(blocks))>8*1024*1024)throw new RpcFault(-32602,'Resolved ACP prompt exceeds the eight MiB wire budget');return blocks;
  }
  private checkContentCapabilities(active:Active,blocks:ContentBlock[]) {
    const capabilities=active.agent.initialized.agentCapabilities?.promptCapabilities;
    for(const block of blocks) {
      if(block.type==='image'&&!capabilities?.image)throw new Error('Agent did not advertise image prompts');
      if(block.type==='audio'&&!capabilities?.audio)throw new Error('Agent did not advertise audio prompts');
      if(block.type==='resource'&&!capabilities?.embeddedContext)throw new Error('Agent did not advertise embedded context');
    }
  }
  private projectPendingTurn(uri:string,active:Active) {
    if(!active.pendingTurn)return;
    if(active.historyRevision&&!active.historyRevision.confirmed)throw new Error('Native history rewrite is not confirmed; replacement projection must not precede canonical authority');
    const pending=active.pendingTurn;active.pendingTurn=undefined;this.emit(chatURI(uri),pending.action,pending.origin);
  }
  private async run(uri:string,active:Active,blocks:ContentBlock[],special?:SettledInput) {
    const channel=chatURI(uri),turnId=active.turnId!;let drain=false;
    const message=(active.pendingTurn?.action.message??this.getRecord(uri)!.chat.activeTurn!.message),meta=message._meta as Json|undefined;
    const inputOrigin=special?.operation==='schedule.submit'?'scheduled':special?.operation==='question.submit'?'question':special?.operation==='observation.submit'?'observation':special?.operation==='history.revise'?'history-edit':String(meta?.['amplifier.dev/input']?.inputOrigin??(message.origin?.kind==='user'?'user':'unknown'));
    try {
      const reply=this.messageReply(message);
      const originalMeta=active.publicOriginal?{[PUBLIC_MESSAGE_META]:active.publicOriginal}:{};
      const params=special?{sessionId:active.agent.nativeId!,operation:special.operation,args:{...special.args,inputId:turnId},_meta:{...originalMeta,...(special.operation==='observation.submit'?{'amplifier.dev/native':{requireExisting:true}}:{})}}:{sessionId:active.agent.nativeId!,prompt:blocks,_meta:{'amplifier.dev/command':{commandId:turnId},...originalMeta,...(inputOrigin==='coordination'?{'amplifier.dev/input':{inputOrigin}}:{}),...(reply?{'amplifier.dev/messageReply':{...reply,sessionId:this.getRecord(uri)!.nativeSessionId}}:{})}};
      if(Buffer.byteLength(JSON.stringify(params))>8*1024*1024)throw new RpcFault(-32602,'ACP input including public original exceeds the eight MiB wire budget');
      const response:Json=special?await active.agent.client.extMethod('_amplifier/native',params):await active.agent.client.prompt(params as any);
      if(special&&response.accepted!==true){
        if(response.accepted!==false)throw new Error('Native admitted input outcome was not conclusive');
        await active.updates;this.store.finish(turnId,'failed',String(response.reason??'Native input rejected'));
        if(['observation.submit','history.revise'].includes(special.operation)&&!active.pendingTurn)throw new Error('Native refused observation after execution evidence');
        if(special.operation==='observation.submit'&&response.executed===false&&response.reason==='waiting_worker')this.store.annotateReceipt(turnId,{retryEligibility:'waiting_worker'});
        if(!active.pendingTurn)this.emit(channel,{type:'chat/error',turnId,duration:Date.now()-active.started!,part:{kind:'error',error:{errorType:'INPUT_REJECTED',message:String(response.reason??'Native input rejected before execution')}}} as StateAction);return;
      }
      if(typeof response.stopReason!=='string')throw new Error('Native execution did not provide a settled stop reason');
      await active.updates;this.projectPendingTurn(uri,active);
      if(response.usage&&this.getRecord(uri)!.chat.activeTurn)this.emit(channel,{type:'chat/usage',turnId,usage:{inputTokens:response.usage.inputTokens,outputTokens:response.usage.outputTokens,cacheReadTokens:response.usage.cachedReadTokens??undefined,_meta:{'amplifier.dev/acp':{usage:response.usage,experimental:true}}}} as StateAction);
      if(active.cancel&&response.stopReason!=='cancelled')this.emit(channel,active.cancel.action,active.cancel.origin,'Turn finished before cancellation took effect');
      if(this.getRecord(uri)!.chat.activeTurn) this.emit(channel,{type:response.stopReason==='cancelled'?'chat/turnCancelled':'chat/turnComplete',turnId,duration:Date.now()-active.started!,_meta:{'amplifier.dev/acp':{stopReason:response.stopReason}}} as StateAction,response.stopReason==='cancelled'?active.cancel?.origin:undefined);
      this.store.finish(turnId,response.stopReason==='cancelled'?'cancelled':'completed',response.stopReason);drain=response.stopReason==='end_turn'&&!active.cancel;
    } catch(error) {
      if(special?.operation==='observation.submit'&&active.pendingTurn&&(error as Json).code===-32008&&(error as Json).data?.executed===false){
        this.store.finish(turnId,'failed','waiting_worker');this.store.annotateReceipt(turnId,{retryEligibility:'waiting_worker'});
        if(this.getRecord(uri)!.chat.activeTurn)this.emit(channel,{type:'chat/error',turnId,duration:Date.now()-active.started!,part:{kind:'error',error:{errorType:'WAITING_WORKER',message:'Observation was not executed; its original native worker is unavailable.'}}} as StateAction);
        return;
      }
      const failed=!special&&nativeFailedInput(error,active.agent.initialized.agentCapabilities,active.agent.nativeId,turnId);
      let failureUpdatesJoined=false;if(failed)try{await active.updates;failureUpdatesJoined=true;}catch{}
      if(failed&&failureUpdatesJoined){
        this.store.transaction(()=>{this.store.finish(turnId,'failed',failed.error.message);this.store.annotateReceipt(turnId,{nativeInputOutcome:failed});});
        this.projectPendingTurn(uri,active);
        if(this.getRecord(uri)!.chat.activeTurn)this.emit(channel,{type:'chat/error',turnId,duration:Date.now()-active.started!,part:{kind:'error',error:{errorType:'NATIVE_INPUT_FAILED',message:failed.error.message,_meta:{'amplifier.dev/inputOutcome':failed}}}} as StateAction);
        return;
      }
      this.store.finish(turnId,'unknown',(error as Error).message);if(!active.historyRevision||active.historyRevision.confirmed)this.projectPendingTurn(uri,active);
      if(this.getRecord(uri)!.chat.activeTurn)this.emit(channel,{type:'chat/error',turnId,duration:Date.now()-active.started!,part:{kind:'error',error:{errorType:'EXECUTION_OUTCOME_UNKNOWN',message:`Execution outcome unknown: ${(error as Error).message}`}}} as StateAction);
    } finally {
      active.finishing=true;
      await Promise.allSettled([...(active.steeringRuns??[])]);
      for(const row of this.store.db.prepare("SELECT id FROM steering_intents WHERE chat=? AND active_turn_id=? AND status='dispatching'").all(channel,turnId)){
        const id=String(row.id);
        if(!drain||this.closing)this.settleSteering(uri,id,'unknown','Turn interrupted without confirmed steering disposition');
        else{const timer=setTimeout(()=>this.settleSteering(uri,id,'unknown','Native steering disposition deadline expired'),bounded(this.config.steeringOutcomeTimeoutMs,10000,60000));timer.unref();this.steeringTimers.set(id,timer);}
      }
      for(const row of this.store.db.prepare("SELECT id,message FROM steering_intents WHERE chat=? AND active_turn_id=? AND status='pending'").all(channel,turnId)){this.store.db.prepare('UPDATE steering_intents SET held=1,reason=? WHERE id=?').run('target-turn-ended',row.id);const message=JSON.parse(String(row.message));this.emit(channel,{type:'chat/pendingMessageSet',kind:'steering',id:String(row.id),message:{...message,_meta:{...message._meta,'amplifier.dev/steering':{held:true,reason:'target-turn-ended'}}}} as PendingQueueAction);}
      if(active.historyRevision){const receipt=this.store.receipt(turnId)!;this.store.db.prepare('UPDATE history_edits SET status=? WHERE operation_id=?').run(receipt.status,active.historyRevision.args.operationId);}
      active.historyRevision=undefined;active.generationId=undefined;active.pendingTurn=undefined;active.observationAdmission=undefined;
      for(const pending of active.permissions.values())pending.resolve({outcome:{outcome:'cancelled'}});active.permissions.clear();active.busy=false;
      if(drain&&!this.closing)void this.withLock(uri,()=>this.drainQueue(uri)).catch(()=>{});else this.holdQueue(channel,this.closing?'host-shutdown':'turn-not-naturally-completed');
      this.notifyTurnSettled(uri,turnId,inputOrigin);
      let updatesJoined=true;
      try{
        await this.syncCatalog(this.getRecord(uri)!).catch(()=>{});
        try{await active.updates;}catch{updatesJoined=false;}
      }finally{this.touchAgent(active);active.finishing=false;this.intake.workChanged();}
      if(updatesJoined&&!active.busy&&this.store.receipt(turnId)?.status==='completed'&&turnId.length<=512)this.acpMetadata(uri,{lastSettledTurnId:turnId});
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
    for(const option of options) {
      if(option.type!=='select')continue;
      const choices=(option.options??[]).flatMap((o:any)=>o.options??[o]);
      // Keep ordinary enum consumers compatible while retaining the standard
      // ACP choices, including groups and opaque vendor metadata, for rich clients.
      properties[option.id]={type:'string',title:option.name,description:option.description,enum:choices.map((o:any)=>o.value),enumLabels:choices.map((o:any)=>o.name),sessionMutable:true,
        options:structuredClone(option.options??[]),...(option.category!==undefined?{category:option.category}:{}),...(option._meta!==undefined?{_meta:structuredClone(option._meta)}:{})};
      values[option.id]=option.currentValue;
    }
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
        if(update.title!==undefined){if(this.titleAdapter(this.getRecord(uri)!))await this.withLock(uri,async()=>{const current=this.getRecord(uri)!;await this.projectCanonicalTitle(current,await this.titleSnapshot(current));});else this.emit(uri,{type:'session/titleChanged',title:update.title??''} as StateAction);}
        await this.syncCatalog(this.getRecord(uri)!);
      }
      return;
    }
    if(active.agent.loading)return; // load replay never executes or duplicates the persisted host projection.
    if(!active.busy||!active.turnId)return;
    if(!projection&&['agent_message_chunk','agent_thought_chunk','tool_call','tool_call_update','plan'].includes(update.sessionUpdate))this.projectPendingTurn(uri,active);
    if(!projection){active.projectionBytes=(active.projectionBytes??0)+Buffer.byteLength(JSON.stringify(update));if(active.projectionBytes>(this.config.maxActiveProjectionBytes??8*1024*1024)){void active.agent.client.cancel({sessionId:active.agent.nativeId!}).catch(()=>{});throw new Error('Active view exceeded its byte budget; native history is preserved and execution outcome requires reconciliation');}}
    const channel=chatURI(uri),turnId=active.turnId;
    const emit=(action:StateAction)=>projection?projection.emit(action):this.emit(channel,action);
    if(update.sessionUpdate==='agent_message_chunk') {
      const nativeMessageId=update._meta?.['amplifier.dev/history']?.messageId;if(nativeMessageId&&nativeMessageId!==active.textMessageId){active.textPart=undefined;active.textMessageId=nativeMessageId;}
      if(update.content.type==='text') {
        if(!active.textPart){active.textPart=randomUUID();emit({type:'chat/responsePart',turnId,part:{kind:'markdown',id:active.textPart,content:'',...(update._meta?{_meta:update._meta}:{})}} as StateAction);}
        emit({type:'chat/delta',turnId,partId:active.textPart,content:update.content.text} as StateAction);
      } else {active.textPart=undefined;emit({type:'chat/responsePart',turnId,part:await this.content(update.content)} as StateAction);}
    } else if(update.sessionUpdate==='agent_thought_chunk') {
      active.textPart=undefined;
      if(update.content.type==='text'){if(!active.reasoningPart){active.reasoningPart=randomUUID();emit({type:'chat/responsePart',turnId,part:{kind:'reasoning',id:active.reasoningPart,content:'',...(update._meta?{_meta:update._meta}:{})}} as StateAction);}emit({type:'chat/reasoning',turnId,partId:active.reasoningPart,content:update.content.text} as StateAction);}
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
    this.projectPendingTurn(uri,active);
    const channel=chatURI(uri),turnId=active.turnId,id=params.toolCall.toolCallId;
    if(active.permissions.has(id))throw new Error('Duplicate pending permission identity');
    if(!active.tools.has(id)){active.tools.add(id);this.emit(channel,{type:'chat/toolCallStart',turnId,toolCallId:id,toolName:params.toolCall.kind??'tool',displayName:params.toolCall.title??'Tool'} as StateAction);}
    const result=new Promise<RequestPermissionResponse>(resolve=>active.permissions.set(id,{params,resolve}));
    this.emit(channel,{type:'chat/toolCallReady',turnId,toolCallId:id,invocationMessage:params.toolCall.title??'Agent requests permission',toolInput:params.toolCall.rawInput===undefined?(active.toolStates?.get(id)?.rawInput===undefined?undefined:JSON.stringify(active.toolStates.get(id)!.rawInput)):JSON.stringify(params.toolCall.rawInput),options:params.options.map(o=>({id:o.optionId,label:o.name,kind:o.kind.startsWith('allow_')?'approve':'deny'}))} as StateAction);
    const tool=this.getRecord(uri)!.chat.activeTurn?.responseParts.find((p:any)=>p.kind==='toolCall'&&p.toolCall.toolCallId===id) as any;
    if(tool)this.emit(uri,{type:'session/inputNeededSet',request:{id,chat:channel,kind:'toolConfirmation',turnId,toolCall:tool.toolCall}} as StateAction);
    return result;
  }
  private notifyTurnSettled(session:string,commandId:string,inputOrigin:string) {
    if(!this.config.turnSettled)return;
    const status=this.store.receipt(commandId)?.status;
    if(!status||!['completed','cancelled','failed','unknown'].includes(status))return;
    if(this.settledCallbacks.size>=64){this.settledCallbackDropped++;return;}
    const event=Object.freeze({session,commandId,status:status as TurnSettled['status'],inputOrigin});
    // A barrier only: never invoke a capability owner while holding admission's mutex.
    const pending=this.withLock(session,async()=>{}).then(()=>this.config.turnSettled!(event)).catch(()=>{this.settledCallbackFailures++;}).finally(()=>{this.settledCallbacks.delete(pending);this.intake.workChanged();});
    this.settledCallbacks.add(pending);
  }
  private notifyAgentStopped(session:string,active:Active,reason:AgentStopped['reason'],details:{exitCode?:number;signal?:string}={}) {
    if(active.stopNotified)return;active.stopNotified=true;
    for(const row of this.store.db.prepare("SELECT id FROM steering_intents WHERE chat=? AND status='dispatching'").all(chatURI(session)))this.settleSteering(session,String(row.id),'unknown','Native runtime stopped without confirmed steering disposition');
    if(!this.config.agentStopped)return;
    const event=Object.freeze({session,nativeSessionId:active.agent.nativeId,engineId:active.agent.engine.id,workingDirectory:active.agent.cwd,reason,...details});
    const pending=Promise.resolve().then(()=>this.config.agentStopped!(event)).catch(()=>{this.stoppedCallbackFailures++;}).finally(()=>{this.stoppedCallbacks.delete(pending);this.intake.workChanged();});this.stoppedCallbacks.add(pending);active.stopCallback=pending;
  }
  private cachedAgentProtected(uri:string,active:Active,underSelectedLock=false) {
    const chat=chatURI(uri);
    if(['pending','unknown'].includes(active.agent.retirementOutcome)||active.busy||active.finishing||active.controlDepth||active.permissions.size||active.updateCount||active.observationPending||this.starting.has(uri)||(!underSelectedLock&&this.resourceLocks.has(uri)))return true;
    if(this.settledCallbacks.size||this.stoppedCallbacks.size||[...this.clientTools.values()].some(tool=>tool.session===uri)||this.store.db.prepare("SELECT 1 FROM receipts WHERE channel=? AND json_extract(payload,'$.status') IN ('admitted','dispatching','unknown') LIMIT 1").get(chat)||this.relocationFence(uri)||this.transferFence(uri)||this.retentionChanging.has(uri))return true;
    try{this.guardSessionLifecycle(uri);}catch{return true;}
    return !!this.store.db.prepare("SELECT 1 FROM queue_intents WHERE chat=? AND status='pending' UNION ALL SELECT 1 FROM steering_intents WHERE chat=? AND status IN ('pending','dispatching','unknown') UNION ALL SELECT 1 FROM history_edits WHERE session=? AND status IN ('admitted','unknown') LIMIT 1").get(chat,chat,uri);
  }
  private async retireIdle(force=false) {
    return this.withAgentCapacity(()=>this.retireIdleUnderCapacity(force));
  }
  private async retireIdleUnderCapacity(force=false):Promise<boolean> {
    if(this.intake.inspect().intakeClosed)return false;
    for(const [uri] of this.active)this.refreshAgentInterest(uri);
    const candidates=[...this.active].map(([uri,active])=>({uri,active,priorOrder:active.useOrder,priorInterest:active.interested}));
    candidates.sort((a,b)=>Number(!!a.priorInterest)-Number(!!b.priorInterest)||(a.priorOrder??0)-(b.priorOrder??0)||a.uri.localeCompare(b.uri));
    let retiredAny=false;
    for(const {uri,active,priorOrder,priorInterest} of candidates) {
      if(this.cachedAgentProtected(uri,active))continue;
      if(!force&&(active.interested||performance.now()-Math.max(active.lastUsed,active.uninterestedSince??active.lastUsed)<(this.config.idleAgentMs??900000)))continue;
      if(!active.agent.initialized?.agentCapabilities?.sessionCapabilities?.resume&&!active.agent.initialized?.agentCapabilities?.loadSession)continue;
      const retirement=this.withLock(uri,async()=>{
        this.refreshAgentInterest(uri);
        // This lock itself is expected; any queued successor must also protect use.
        if(this.resourceLocks.get(uri)!==retirement||this.active.get(uri)!==active||active.useOrder!==priorOrder||active.interested!==priorInterest||active.busy||active.finishing||active.controlDepth||active.permissions.size||this.starting.has(uri))return false;
        // Recheck durable protection after the asynchronous lock boundary.
        if(this.cachedAgentProtected(uri,active,true))return false;
        if(!force&&(active.interested||performance.now()-Math.max(active.lastUsed,active.uninterestedSince??active.lastUsed)<(this.config.idleAgentMs??900000)))return false;
        active.controlDepth=(active.controlDepth??0)+1;
        try {
          if(!await this.retireActive(uri,active))return false;
          active.retireReason='idle-retired';await active.agent.retire();await active.stopCallback;this.active.delete(uri);return true;
        }finally{active.controlDepth--;}
      });
      const retired=await retirement;
      if(retired)retiredAny=true;
      if(force&&retired)return true;
    }
    return retiredAny;
  }
  private quiescenceWork() {
    const active=[...this.active.values()];
    return {counts:{shuttingDown:this.closing?1:0,startingAgents:this.starting.size,activeTurns:active.filter(a=>a.busy).length,finishingTurns:active.filter(a=>a.finishing).length,activeControls:active.reduce((n,a)=>n+(a.controlDepth??0),0),nativeUpdates:active.reduce((n,a)=>n+(a.updateCount??0)+(a.observationPending??0),0),permissions:active.reduce((n,a)=>n+a.permissions.size,0),clientTools:this.clientTools.size,settledCallbacks:this.settledCallbacks.size,stoppedCallbacks:this.stoppedCallbacks.size,steeringDispositions:this.steeringTimers.size,terminalJobs:Number(this.store.db.prepare("SELECT count(*) n FROM terminals WHERE lifecycle='running'").get()!.n),pendingQueue:Number(this.store.db.prepare("SELECT count(*) n FROM queue_intents WHERE status='pending'").get()!.n),pendingSteering:Number(this.store.db.prepare("SELECT count(*) n FROM steering_intents WHERE status IN ('pending','dispatching')").get()!.n)},gaps:active.filter(a=>!a.agent.closed&&((a.agent.initialized?.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.lifecycle?.gracefulRetire!==true)).length?['resident-agent-has-no-atomic-retirement']:[]};
  }
  private async quiesceAgents():Promise<{ready:boolean;reason?:string;unknown?:boolean}> {
    if(this.store.db.prepare("SELECT 1 FROM receipts WHERE client_id='host:retirement' AND json_extract(payload,'$.status') IN ('admitted','unknown') LIMIT 1").get())return {ready:false,unknown:true,reason:'native-retirement-unconfirmed'};
    for(const [session,active] of this.active){
      const result=await this.withLock(session,async()=>{
        if(this.active.get(session)!==active)return {ready:true};
        if(active.busy||active.finishing||active.controlDepth||this.starting.has(session)||active.permissions.size||active.observationPending)return {ready:false,reason:'native-work-became-active'};
        if(this.retirementFence(this.getRecord(session)!)!==undefined||['pending','unknown'].includes(active.agent.retirementOutcome))return {ready:false,unknown:true,reason:'native-retirement-unconfirmed'};
        if(active.agent.closed){this.active.delete(session);return {ready:true};}
        const lifecycle=(active.agent.initialized?.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.lifecycle;
        if(lifecycle?.version!==1||lifecycle.gracefulRetire!==true||!active.agent.nativeId)return {ready:false,reason:'native-atomic-retirement-unavailable'};
        active.controlDepth=(active.controlDepth??0)+1;
        try{
          if(!await this.retireActive(session,active,this.config.quiescence?.timeoutMs??10000))return active.agent.retirementOutcome==='refused'?{ready:false,reason:'native-owned-work'}:{ready:false,unknown:true,reason:'native-retirement-unconfirmed'};
          active.retireReason='quiesced';await active.agent.retire();await active.stopCallback;this.active.delete(session);return {ready:true};
        }catch{return {ready:false,unknown:true,reason:'native-retirement-transport-unknown'};}finally{active.controlDepth!--;}
      });
      if(!result.ready)return result;
    }
    return {ready:true};
  }
  /** Trusted supervisor seam, never an AHP action or a client-supplied readiness claim. */
  private requirePresentation(){if(!this.presentation)throw new RpcFault(-32601,'Conversation presentation reset is unavailable',{executed:false});return this.presentation;}
  inspectConversationPresentation(){return this.presentation?.inspect()??{enabled:false,ready:true,revision:0,phase:'disabled'};}
  withConversationCatalogRead<T>(work:()=>Promise<T>):Promise<T>{return this.presentation?this.presentation.read(work):work();}
  prepareConversationPresentation(input:PresentationPrepare,actor:PresentationActor){return this.intake.run(()=>this.requirePresentation().prepare(input,actor));}
  readConversationPresentationReview(input:{reviewId:string;cursor?:string;limit?:number},actor:PresentationActor){return this.requirePresentation().page(input,actor);}
  applyConversationPresentation(input:PresentationApply,actor:PresentationActor){return this.intake.run(()=>this.requirePresentation().apply(input,actor));}
  conversationPresentationReceipt(commandId:string,actor:PresentationActor){return this.requirePresentation().receipt(commandId,actor);}
  /** Trusted release verifier only; never exposes the retained private before-images. */
  readConversationPresentationEffectReceipt(commandId:string){return this.requirePresentation().effect(commandId);}
  reconcileConversationPresentation(commandId:string,actor:PresentationActor){return this.requirePresentation().reconcile(commandId,actor);}
  rebuildConversationPresentation(input:PresentationRebuild,actor:PresentationActor){return this.intake.run(()=>this.requirePresentation().rebuild(input,actor));}
  reconcileConversationPresentationRebuild(commandId:string,actor:PresentationActor){return this.requirePresentation().reconcileRebuild(commandId,actor);}
  /** Exact-ID access is authorized independently of discovery visibility/reconstruction. */
  private async exactCatalogRecord(session:string):Promise<CatalogRecord|undefined>{
    const retained=this.presentation?.mapping(session) as CatalogRecord|undefined;
    const indexed=await this.config.catalog?.get(session).catch(error=>{if(retained)return undefined;throw error;});
    if(retained&&indexed){for(const key of ['uri','engineId','nativeSessionId','workingDirectory'] as const)if(indexed[key]!==retained[key])throw new RpcFault(-32011,'Indexed identity differs from retained canonical mapping');if(retained.storagePath&&indexed.storagePath&&retained.storagePath!==indexed.storagePath)throw new RpcFault(-32011,'Indexed native storage differs from retained mapping');}
    return indexed?{...indexed,...(retained?.storagePath?{storagePath:retained.storagePath}:{})}:retained;
  }
  private withPresentationSelection<T>(sessions:string[],work:()=>Promise<T>):Promise<T>{
    const ordered=[...new Set(sessions)].sort();
    // Reserve all idle selected mutexes synchronously. Never hold a subset while waiting on a family lock.
    if(ordered.some(session=>this.resourceLocks.has(session)))return Promise.reject(new RpcFault(-32011,'Selected session admission is in progress',{executed:false}));
    let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});for(const session of ordered){this.resourceLocks.set(session,barrier);this.presentationSelections.add(session);}
    return (async()=>{try{return await work();}finally{for(const session of ordered)this.presentationSelections.delete(session);release();for(const session of ordered)if(this.resourceLocks.get(session)===barrier)this.resourceLocks.delete(session);}})();
  }
  private async presentationMetadata(session:string):Promise<PresentationMetadata>{
    const indexed=await this.exactCatalogRecord(session),record=this.getRecord(session);if(!indexed?.nativeSessionId||indexed.uri!==session||!this.config.engines.some(engine=>engine.id===indexed.engineId))throw new RpcFault(-32008,'Selected indexed native mapping is unavailable',{executed:false});
    if(record&&(record.nativeSessionId!==indexed.nativeSessionId||record.engineId!==indexed.engineId||record.workingDirectory!==indexed.workingDirectory))throw new RpcFault(-32011,'Catalog and retained host identity conflict',{executed:false});
    if(record)await this.selectedWorkspace(record);else if(indexed.location?.kind==='managed')throw new RpcFault(-32011,'Managed mapping requires its original local allocation receipt',{executed:false});else if(await this.workspace(pathToFileURL(indexed.workingDirectory).href)!==indexed.workingDirectory)throw new RpcFault(-32011,'Canonical workspace identity differs',{executed:false});
    return {identity:{session,engineId:indexed.engineId,nativeSessionId:indexed.nativeSessionId,workingDirectory:indexed.workingDirectory},title:record?.summary.title??indexed.title,catalog:indexed,...(record?{hostBeforeImage:{summary:record.summary}}:{})};
  }
  private async validatePresentationSelection(sessions:PresentationIdentity[]){
    for(const item of sessions){const session=item.session,chat=chatURI(session),record=this.getRecord(session);
      if(this.hasSubscribers(session)||this.hasSubscribers(chat)||this.observers.size&&[...this.observers].some(observer=>observer.session===session))throw new RpcFault(-32011,'Selected viewer protects conversation presentation',{executed:false});
      if(this.active.get(session)?.busy||this.active.get(session)?.controlDepth||this.starting.has(session)||record?.chat.activeTurn||this.store.unknown(chat))throw new RpcFault(-32011,'Active or unknown work protects conversation presentation',{executed:false});
      if(this.store.db.prepare("SELECT 1 FROM queue_intents WHERE chat=? AND status='pending' UNION ALL SELECT 1 FROM steering_intents WHERE chat=? AND status IN ('pending','dispatching','unknown') LIMIT 1").get(chat,chat)||this.relocationFence(session)||this.transferFence(session)||this.retentionChanging.has(session)||this.store.db.prepare("SELECT 1 FROM lifecycle_commands WHERE (session=? OR target=?) AND status IN ('dispatching','unknown') LIMIT 1").get(session,session))throw new RpcFault(-32011,'Retained work or ownership transition protects conversation presentation',{executed:false});
    }
  }
  admitQuiescence(input:{commandId:string;purpose:Exclude<QuiescencePurpose,'service-stop'|'retention-hide'>;retryRefused?:boolean}) {return this.intake.admit(input);}
  admitServiceStop(input:ServiceStopRequest) {return this.intake.admitServiceStop(input);}
  serviceStopReceipt(commandId:string) {return this.intake.serviceStopReceipt(commandId);}
  inspectServiceLifecycle() {return this.intake.inspectServiceLifecycle();}
  releaseServiceStop(input:ServiceStopReleaseRequest) {return this.intake.releaseServiceStop(input);}
  inspectQuiescence() {return this.intake.inspect();}
  quiescenceReceipt(commandId:string) {return this.intake.receipt(commandId);}
  quiescenceAdmissionAbortReceipt(commandId:string) {return this.intake.admissionAbortReceipt(commandId);}
  abortQuiescenceAdmission(input:AdmissionAbortRequest) {return this.intake.abortAdmission(input);}
  releaseQuiescence(input:{fenceId:string;commandId:string;outcome:QuiescenceOutcome;evidence?:unknown}) {return this.intake.release(input);}
  /** Trusted recovery owner only. This does not permit ordinary nested host mutations. */
  withQuiescenceMaintenance<T>(input:{fenceId:string;commandId:string},work:()=>Promise<T>):Promise<T> {return this.intake.maintain(input,work);}
  /** Composition uses this for native-admin and other effects outside normal AHP methods. */
  withExternalMutation<T>(ownerId:string,work:()=>Promise<T>):Promise<T> {return this.intake.external(ownerId,work);}
  diagnostics(){return {...(this.presentation?{catalogHints:this.presentation.hintDiagnostics()}:{}),steeringDispositionPending:this.steeringTimers.size,turnSettledPending:this.settledCallbacks.size,turnSettledFailures:this.settledCallbackFailures,turnSettledDropped:this.settledCallbackDropped,agentStoppedPending:this.stoppedCallbacks.size,agentStoppedFailures:this.stoppedCallbackFailures,clients:this.peers.size,activeAgents:this.active.size,startingAgents:this.admittedStarts.size,pendingAgentAdmissions:this.starting.size,agentCache:{capacity:this.config.maxActiveAgents??8,graceMs:this.config.idleAgentMs??900000,hostManaged:[...this.active.values()].filter(a=>a.agent.runtimeRetention==='host').length,unmanaged:[...this.active.values()].filter(a=>a.agent.runtimeRetention!=='host').length},subscriptions:[...this.peers].reduce((n,p)=>n+p.subscriptions.size,0),serverSeq:this.store.seq,
    workingSet:{hotRecords:this.hotRecords.size,passiveReads:this.passiveReads,selectedNativeWindows:this.nativeWindows.size,selectedNativeTurnIds:[...this.nativeWindows.values()].reduce((sum,window)=>sum+window.ids.length,0),selectedHostWindows:this.loadedFloors.size,cursors:{turns:this.cursors.size,native:this.nativeCursors.size,mixed:this.mixedCursors.size,prefix:this.prefixCursors.size,recall:this.recallCursors.size,coordination:this.coordinationCursors.size},peerBufferedBytes:[...this.peers].reduce((sum,peer)=>sum+peer.socket.bufferedAmount,0),handshakeQueuedEvents:[...this.peers].reduce((sum,peer)=>sum+peer.buffer.length,0),handshakeQueuedBytes:[...this.peers].reduce((sum,peer)=>sum+peer.bufferBytes,0)},
    retainedReplay:this.store.db.prepare('SELECT count(*) events,coalesce(sum(bytes),0) bytes FROM actions').get(),
    pendingQueue:this.store.db.prepare("SELECT count(*) messages,coalesce(sum(length(CAST(message AS BLOB))),0) bytes FROM queue_intents WHERE status='pending'").get()
  };}
  async inspectSession(session:string) {
    const record=await this.record(session),revisions=this.store.revisions(record.uri);
    const engine=this.config.engines.find(e=>e.id===record.engineId);
    const configurationHash=createHash('sha256').update(JSON.stringify({engine,values:record.state.config?.values,revision:revisions.configurationRevision})).digest('hex');
    const active=this.active.get(record.uri),admission=active?.busy&&active.turnId?this.store.receipt(active.turnId):undefined;
    const observationAdmission=admission?.status==='dispatching'&&active?.observationAdmission?{...active.observationAdmission,status:admission.status}:undefined;
    return {session:record.uri,uri:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory,historyHome:record.workingDirectory,executionDirectory:record.executionDirectory??record.workingDirectory,nativeLocationRevision:record.nativeLocationRevision??0,relocationFence:this.relocationFence(record.uri),transferFence:this.transferFence(record.uri),title:record.summary.title,location:record.state._meta?.['amplifier.dev/location'],activeTurnId:admission?active!.turnId:record.chat.activeTurn?.id,observationAdmission,status:active?.busy||record.chat.activeTurn?'working':'idle',...revisions,configurationHash};
  }
  /** Hold the selected session mapping through bounded trusted I/O. No filesystem snapshot is implied. */
  async withSessionWorkspace<T>(session:string,expected:SessionWorkspaceExpectation,capture:(workspace:Readonly<SessionWorkspace>)=>Promise<T>):Promise<T> {
    return this.intake.run(async()=>{
    if(!expected||typeof expected!=='object'||typeof capture!=='function'||(expected.expectedExecutionRevision!==undefined&&(!Number.isSafeInteger(expected.expectedExecutionRevision)||expected.expectedExecutionRevision<0))||(expected.expectedDirectory!==undefined&&(typeof expected.expectedDirectory!=='string'||!isAbsolute(expected.expectedDirectory))))throw new RpcFault(-32602,'An optional execution revision and absolute directory are required');
    const selected=await this.record(session);
    return this.withLock(selected.uri,async()=>{
      const record=await this.record(selected.uri);
      this.guardTransfer(record.uri);
      if(this.relocationFence(record.uri))throw new RpcFault(-32011,'Session relocation is fenced; workspace capture was not started',{executed:false});
      const executionDirectory=await this.selectedWorkspace(record,true),executionRevision=this.store.revisions(record.uri).executionRevision;
      if(expected.expectedExecutionRevision!==undefined&&expected.expectedExecutionRevision!==executionRevision)throw new RpcFault(-32011,'Execution revision changed; workspace capture was not started',{executed:false});
      if(expected.expectedDirectory!==undefined&&await realpath(expected.expectedDirectory)!==executionDirectory)throw new RpcFault(-32011,'Execution directory changed; workspace capture was not started',{executed:false});
      // The caller owns byte/time limits and may read files, but must not reenter host mutations.
      // Keep the mutex until its promise settles: a timeout must not free mapping while I/O runs.
      return capture(Object.freeze({session:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,historyHome:record.workingDirectory,executionDirectory,executionRevision}));
    });
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
    this.passiveReads++;const agent=new AcpProcess(engine,this.passiveProcessDirectory(record),{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),admitEffect:async()=>{throw new RpcFault(-32009,'Passive native inspection cannot perform filesystem or terminal effects');}});
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
    return this.intake.run(async()=>{
    const target=await this.workspace(pathToFileURL(path).href);
    return this.withLock('@directory-reservations',async()=>{const result=await this.directoryInUse(target);if(result.inUse)throw new RpcFault(-32011,'Directory is referenced by a session, history or unresolved transition',result);return remove();});
      });
  }
  async relocateSession(session:string,input:{commandId:string;target:string;expectedExecutionRevision:number;reconciles?:string;evidence?:unknown}) {
    return this.intake.run(async()=>{
    if(!input||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>128||typeof input.target!=='string'||!isAbsolute(input.target)||!Number.isSafeInteger(input.expectedExecutionRevision)||input.expectedExecutionRevision<0||Buffer.byteLength(JSON.stringify(input.evidence??null))>65536)throw new RpcFault(-32602,'Bounded relocation command, target and expected revision required');
    let record:SessionRecord,target:string;
    try{record=await this.record(session);if(record.state._meta?.['amplifier.dev/location'])throw new RpcFault(-32601,'Managed execution relocation requires an allocation transition',{executed:false});target=await this.workspace(pathToFileURL(input.target).href);}catch(error){return {applied:false,executed:false,reason:(error as Error).message};}
    return this.withLock(record.uri,async()=>{
      let admitted=false;
      try {
      this.guardTransfer(record.uri);
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
        if(active)result=await this.withAgentUse(active,()=>active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation:'session.relocate',args:{commandId:input.commandId,target,expectedExecutionRevision:native.executionRevision}}));
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
      });
  }
  /** Advertised tools only: no client drafts, DOM, editing buffers or rendered state. */
  async listClientTools(session:string) {const record=await this.record(session);return structuredClone(record.state.activeClients);}
  /** Shared admission path for authenticated clients and trusted native-host callbacks. */
  async invokeCapability(request:Json,actor:{actorId:string;clientId?:string;origin?:'agent'|'ui';session?:string}) {
    const provider=this.config.capabilities;
    const namedAction=Object.entries(provider?.manifest.actions??{}).find(([,action])=>action.topic===request.topic&&action.operation===request.operation&&action.method==='x-amplifier/capabilityAction');
    const access=namedAction&&provider?.quiescenceAccess?.[namedAction[0]];
    const execute=async()=>{
    if(!provider||request.version!==1||!Object.values(provider.manifest.actions).some(action=>action.topic===request.topic&&action.operation===request.operation&&action.method==='x-amplifier/capabilityAction'))throw new RpcFault(-32601,'Capability action/version not advertised');
    if(typeof request.commandId!=='string'||!request.commandId||request.commandId.length>512||[...request.commandId].length>256||typeof actor.actorId!=='string'||!actor.actorId)throw new RpcFault(-32602,'Capability commandId must contain 1 to 256 characters and actor identity is required',{executed:false});
    if(provider.manifest.topics[request.topic]?.scope==='host'&&request.channel!==ROOT)throw new RpcFault(-32602,'Host capability action requires the root channel',{executed:false});
    if(actor.session!==undefined&&(actor.origin!=='agent'||typeof actor.session!=='string'||!actor.session.startsWith('ahp-session:/')))throw new RpcFault(-32602,'Only trusted agent embedding may bind an originating session',{executed:false});
    const channelSession=request.channel===ROOT?undefined:await this.record(request.channel);
    const session=actor.session===undefined?channelSession:await this.record(actor.session);
    if(channelSession&&session?.uri!==channelSession.uri)throw new RpcFault(-32602,'Capability channel differs from the trusted agent session',{executed:false});
    this.store.transaction(()=>this.store.admission(request.channel,request,request.commandId,actor.actorId,this.store.extensionSequence(actor.actorId)));
    this.store.finish(request.commandId,'dispatching');
    try {const result=await provider.action(request,{actorId:actor.actorId,clientId:actor.clientId??'',origin:actor.origin??'ui',session});this.store.finish(request.commandId,result.accepted?'completed':'failed');for(const topic of result.invalidate??[])this.invalidateCapability(topic,request.channel===ROOT?'host':request.channel);for(const update of result.updates??[])this.invalidateCapability(update.topic,update.scope);return result;}
    catch(error){this.store.finish(request.commandId,'unknown',(error as Error).message);throw error;}
    };
    return access?this.intake.inspectOnly(execute):this.intake.run(execute);
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
    return this.intake.run(async()=>{
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
      });
  }
  /** Used by capability owners; all native controls retain the ACP execution boundary. */
  async nativeControlExisting(session:string,operation:string,args:Json):Promise<Json> {return this.nativeControl(session,operation,args,{requireExisting:true});}
  async nativeControl(session:string,operation:string,args:Json,options:{requireExisting?:boolean}={}):Promise<Json> {
    return this.intake.run(async()=>{
    session=(await this.record(session)).uri;
    if(this.relocationFence(session))throw new RpcFault(-32011,'Session relocation is fenced; no runtime control was dispatched');
    if(operation==='history.edit')throw new RpcFault(-32601,'Canonical history editing requires an admitted lifecycle; generic dispatch is unavailable');
    if(operation==='session.relocate')throw new RpcFault(-32602,'Relocation requires relocateSession admission');
    const admissionMethod:Record<string,string>={'steer':'updatePendingQueue','steer.submit':'updatePendingQueue','schedule.submit':'submitScheduled','question.submit':'submitQuestionAnswer','observation.submit':'submitObservation','history.revise':'reviseHistory'};
    if(admissionMethod[operation])throw new RpcFault(-32602,`Execution requires ${admissionMethod[operation]} admission`);
    const execute=async()=>{
      this.guardTransfer(session);
      const active=options.requireExisting?this.active.get(session):await this.ensureAgent(session);
      this.guardTransfer(session);
      if(!active||active.agent.closed||!active.agent.nativeId)throw new RpcFault(-32008,'No existing owned native runtime; no process was started');
      this.guardRetirement(active);
      if((active.agent.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as Json)?.version!==1)throw new RpcFault(-32601,'Native control extension not negotiated');
      if(['configuration.apply','configuration.toggle','bundle.switch','provider.select','provider.reset','mode.set','mode.clear','budget.set','capacity.set','capacity.quota'].includes(operation))this.store.bump(session,'configuration');
      if(['worker.stop','operations.cancel'].includes(operation))this.store.bump(session,'interruption');
      return this.withAgentUse(active,()=>active.agent.client.extMethod('_amplifier/native',{sessionId:active.agent.nativeId!,operation,args,...(options.requireExisting?{_meta:{'amplifier.dev/native':{requireExisting:true}}}:{})}),this.nativeControlIsUse(operation));
    };
    return ['configuration.apply','configuration.toggle','bundle.switch','provider.select','provider.reset','mode.set','mode.clear','budget.set','capacity.set','capacity.quota','worker.stop','operations.cancel'].includes(operation)?this.withLock(session,execute):execute();
      });
  }
  async close() {
    this.closing=true;
    clearInterval(this.retireTimer);
    for(const observer of this.observers){observer.closed=true;observer.queue=[];}this.observers.clear();
    for(const peer of this.peers)peer.socket.terminate();
    const agents=[...this.active.values()];await Promise.all(agents.map(active=>{active.retireReason='host-shutdown';return active.agent.retire();}));await Promise.all([...this.stoppedCallbacks]);await Promise.allSettled(agents.map(active=>active.run));await Promise.all([...this.settledCallbacks]);this.active.clear();
    await new Promise<void>(resolve=>this.ws.close(()=>resolve()));await new Promise<void>(resolve=>this.http.close(()=>resolve()));
    this.store.onReceiptChanged=undefined;await this.library?.close();await this.presentation?.close();await this.config.catalog?.close?.();this.managed?.close();this.store.close();
  }
}

export async function createHost(config:HostConfig) {return new AmplifierHost(config).listen();}
