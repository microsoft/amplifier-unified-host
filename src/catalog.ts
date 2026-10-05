import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Catalog, CatalogRecord } from './host.js';

export interface CatalogProcessConfig {command:string;args?:string[];env?:Record<string,string>;maintenanceMs?:number;}
/** Independently versioned catalog protocol, with a single long-lived process. */
export class StdioCatalog implements Catalog {
  private process:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private next=1;
  private buffer='';
  private stderr='';
  private maintenance?:ReturnType<typeof setInterval>;
  private closed=false;
  private exited:Promise<void>;
  private shutdown?:Promise<void>;
  constructor(readonly config:CatalogProcessConfig) {
    this.process=spawn(config.command,config.args??[],{env:{...process.env,...config.env},stdio:'pipe'});
    this.exited=new Promise(resolve=>this.process.once('close',()=>resolve()));
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-8192);});
    this.process.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;
      if(Buffer.byteLength(this.buffer)>8*1024*1024){this.fail(new Error('Catalog frame exceeded 8 MiB'));this.process.kill();return;}
      let newline;while((newline=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
        let message;try{message=JSON.parse(line);}catch{this.fail(new Error('Malformed catalog protocol frame'));this.process.kill();return;}
        const pending=this.pending.get(message.id);if(!pending)continue;this.pending.delete(message.id);clearTimeout(pending.timer);
        if(message.error)pending.reject(Object.assign(new Error(message.error.message),{code:message.error.code,data:message.error.data,catalogResponseSettled:true}));else pending.resolve(message.result);
      }
    });
    this.process.on('error',error=>this.fail(error));this.process.on('close',()=>this.fail(new Error('Catalog process closed')));
    let tick=0;
    if(config.maintenanceMs){this.maintenance=setInterval(()=>{if(this.closed)return;void this.request(++tick%10===0?'scan':'recheck',tick%10===0?{}:{limit:64}).catch(()=>{});},config.maintenanceMs);this.maintenance.unref();}
  }
  private fail(error:Error){this.closed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();}
  request(method:string,params:Record<string,unknown>):Promise<any> {
    if(this.closed)return Promise.reject(new Error('Catalog is unavailable; no source scan is substituted'));
    if(this.pending.size>=32)return Promise.reject(new Error('Catalog request capacity reached'));
    const id=this.next++,frame=JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n';
    if(Buffer.byteLength(frame)>1024*1024)return Promise.reject(new Error('Catalog request exceeded 1 MiB'));
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Catalog response timed out'));},10000);timer.unref();this.pending.set(id,{resolve,reject,timer});this.process.stdin.write(frame,error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});});
  }
  async supportsLibraryQuery(){try{return (await this.request('libraryCapabilities',{})).version===1;}catch(error){if((error as any).code===-32601)return false;throw error;}}
  libraryQuery(params:import('./library-index.js').LibraryRead){return this.request('libraryQuery',{...params});}
  list(params:Parameters<Catalog['list']>[0]) {return this.request('list',params);}
  async get(uri:string):Promise<CatalogRecord|undefined>{return await this.request('get',{uri})??undefined;}
  projectSessionVisibility(params:Parameters<NonNullable<Catalog['projectSessionVisibility']>>[0]){return this.request('projectSessionVisibility',{...params});}
  sessionVisibilityProjectionStatus(params:{source:string}){return this.request('sessionVisibilityProjectionStatus',params);}
  sessionVisibilityProjectionReceipt(params:{source:string;commandId:string}){return this.request('sessionVisibilityProjectionReceipt',params);}
  status(){return this.request('status',{});}
  projectSessionArchives(params:{items:Array<{uri:string;isArchived:boolean}>}){return this.request('projectSessionArchives',params);}
  upsert(record:CatalogRecord){return this.request('upsert',{record});}
  claimNative(params:Parameters<NonNullable<Catalog['claimNative']>>[0]):Promise<CatalogRecord>{return this.request('claimNative',params);}
  setVisibility(params:Parameters<NonNullable<Catalog['setVisibility']>>[0]){return this.request('setVisibility',params);}
  retentionCandidates(params:Parameters<NonNullable<Catalog['retentionCandidates']>>[0]){const {protectSessionIds,...query}=params;return this.request('retentionCandidates',query);}
  descendants(params:{parentUri:string;limit:number}){return this.request('descendants',params);}
  reconcileFamily(params:{parentUri:string;limit:number;maxEntries:number}){return this.discovery('reconcileFamily',params);}
  verifyFamily(params:{parentUri:string;verificationToken:string}){return this.request('verifyFamily',params);}
  directoryInUse(path:string){return this.request('directoryInUse',{path});}
  hint(sessionDirectory:string,_context?:{attemptId:string}){return this.discovery('hint',{sessionDirectory});}
  private async discovery(method:string,params:Record<string,unknown>){try{return await this.request(method,params);}catch(error){
    // A timed-out RPC can still be writing. Join this owned process's actual exit
    // before claiming discovery is quiet; a kill signal or new PID is not proof.
    if(!(error as any)?.catalogResponseSettled)await this.close();throw Object.assign(error instanceof Error?error:new Error(String(error)),{catalogDiscoverySettled:true});
  }}
  listWorkspaces(params:Record<string,unknown>){return this.request('listWorkspaces',params);}
  getWorkspace(params:{id:string}){return this.request('getWorkspace',params);}
  projectWorkspaces(params:Record<string,unknown>){return this.request('projectWorkspaces',params);}
  workspaceProjectionStatus(params:{source:string}){return this.request('workspaceProjectionStatus',params);}
  diagnostics(){return {closed:this.closed,pending:this.pending.size,stderrTail:this.stderr};}
  async close(){
    if(this.shutdown)return this.shutdown;
    this.shutdown=(async()=>{clearInterval(this.maintenance);this.fail(new Error('Catalog closed by owner'));this.process.stdin.end();
      const terminate=setTimeout(()=>this.process.kill('SIGTERM'),1000),kill=setTimeout(()=>this.process.kill('SIGKILL'),2000);
      try{await this.exited;}finally{clearTimeout(terminate);clearTimeout(kill);}
    })();return this.shutdown;
  }
}
