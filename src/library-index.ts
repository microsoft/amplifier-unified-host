import {SessionStatus} from '@microsoft/agent-host-protocol';
import type {Catalog,CatalogRecord} from './host.js';
import type {NavigationProjection} from './navigation.js';
export interface HostObservation {version:1;source:string;incarnation:string;revision:number;observedAt:string;effect:'unknown'|'error'|'settled'|'unverified';unknownChecked:true;navigation?:NavigationProjection;}
export interface LibraryQuery {connectionId:string;allowedWorkspaceRoots:string[];limit?:number;cursor?:string;workingDirectory?:string;search?:string;parentUri?:string;archive?:'active'|'all'|'archived';sort?:'activity'|'created'|'name'|'recent';activity?:'all'|'working'|'attention';location?:'all'|'managed'|'missing';allowedManagedRoots?:string[];navigationVersion?:1;includeAgentCreated?:boolean;selectedUri?:string;}
export interface LiveFact {uri:string;runtime:'working'|'input-needed'|'idle'|'unknown';effect:HostObservation['effect'];modifiedAt:number;navigation?:NavigationProjection;}
export interface LibraryRead extends LibraryQuery {liveFacts:{source:string;incarnation:string;items:LiveFact[]};observationFreshness:{phase:'complete'|'reconciling'|'degraded';issues:string[]};}
export interface LibraryHooks {
 /** Metadata-only URIs and row reads; no Store.get/active-event/history replay. */
 page:(after:string)=>string[];record:(uri:string)=>CatalogRecord|undefined;
 unknown:(uri:string)=>boolean;live:()=>LiveFact[];changed:()=>void;
 navigation?:(record:CatalogRecord)=>NavigationProjection;
}
/** Rebuildable observations using existing Catalog writes; no durable delivery queue. */
export class LibraryIndex {
 private revision=0;private failureRevision=0;private requests=new Set<Promise<unknown>>();private stopping=false;private pass?:Promise<void>;
 private jobs=new Set<Promise<void>>();private failures=new Set<string>();
 private writes=new Map<string,{latest:number;pending:number}>();
 private phase:'complete'|'reconciling'|'degraded'='reconciling';
 constructor(private catalog:Catalog,private hooks:LibraryHooks,readonly source:string,readonly incarnation:string){}
 observation(record:CatalogRecord):HostObservation {
  const status=Number(record.status)||0;
  const effect=this.hooks.unknown(record.uri)?'unknown':status&SessionStatus.Error?'error':status&SessionStatus.InProgress?'unverified':'settled';
  return {version:1,source:this.source,incarnation:this.incarnation,revision:++this.revision,observedAt:new Date().toISOString(),effect,unknownChecked:true,...(this.hooks.navigation?{navigation:this.hooks.navigation(record)}:{})};
 }
 /** Awaited callers retain their existing effect semantics; no retry or mutation replay. */
 async write(record:CatalogRecord,observationOnly=false){
  if(this.stopping)throw Error('Library observation intake is closed');
  const projected={...record,hostObservation:this.observation(record),...(observationOnly?{hostObservationOnly:true as const}:{})};
  if(!this.writes.has(record.uri)&&this.writes.size>=128){this.degraded();throw Error('Library observation write capacity exceeded');}
  const state=this.writes.get(record.uri)??{latest:0,pending:0};state.latest=projected.hostObservation.revision;state.pending++;this.writes.set(record.uri,state);
  let request:Promise<unknown>|undefined;
  try{request=this.catalog.upsert(projected);this.requests.add(request);await request;if(state.latest===projected.hostObservation.revision)this.failures.delete(record.uri);}
  catch(error){if(state.latest===projected.hostObservation.revision){if(this.failures.size<64)this.failures.add(record.uri);else this.failures.add('*capacity');this.phase='degraded';this.failureRevision++;}throw error;}
  finally{if(request)this.requests.delete(request);if(--state.pending===0)this.writes.delete(record.uri);this.hooks.changed();}
 }
 degraded(){this.failureRevision++;this.failures.add('*capacity');this.phase='degraded';this.hooks.changed();}
 point(uri:string){
  if(this.stopping)return;
  if(this.jobs.size>=64){this.degraded();return;}
  let record:CatalogRecord|undefined;
  try{record=this.hooks.record(uri);}catch{this.degraded();return;}
  if(!record?.nativeSessionId)return;
  const job=this.write(record,true).catch(()=>{}).finally(()=>this.jobs.delete(job));this.jobs.add(job);
 }
 reconcile(){
  if(this.pass)return this.pass;
  if(this.stopping)return Promise.resolve();
  this.phase='reconciling';const repairAt=this.failureRevision;
  this.pass=(async()=>{
   let after='';
   while(!this.stopping){
    const uris=this.hooks.page(after);if(!uris.length)break;
    for(const uri of uris){if(this.stopping)break;const record=this.hooks.record(uri);if(record?.nativeSessionId)try{await this.write(record,true);}catch{};after=uri;}
    await new Promise<void>(resolve=>setImmediate(resolve));
   }
   if(!this.stopping){if(this.failureRevision===repairAt)this.failures.delete('*capacity');this.phase=this.failures.size?'degraded':'complete';}
  })().catch(()=>{this.degraded();}).finally(()=>{this.pass=undefined;this.hooks.changed();});return this.pass;
 }
 async query(params:LibraryQuery){
  if(!this.catalog.libraryQuery)throw Error('Library query is not supported');
  const items=this.hooks.live();if(items.length>64||Buffer.byteLength(JSON.stringify(items))>65536)throw Error('Live library fact capacity exceeded; no truncation');
  return this.catalog.libraryQuery({...params,liveFacts:{source:this.source,incarnation:this.incarnation,items},observationFreshness:{phase:this.jobs.size&&this.phase==='complete'?'reconciling':this.phase,issues:this.failures.size?['host-observation-delivery-incomplete']:[]}});
 }
 async close(){this.stopping=true;await this.pass;await Promise.all(this.jobs);await Promise.allSettled(this.requests);}
}
