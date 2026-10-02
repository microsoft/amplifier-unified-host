import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable, Transform } from 'node:stream';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClientSideConnection, ndJsonStream, type InitializeResponse, type Client, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';

export interface EngineConfig { id: string; label: string; command: string; args?: string[]; env?: Record<string,string>; }
export interface AgentHandlers {
  update(params: SessionNotification): Promise<void>;
  permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  hostRequest?(method: string, params: Record<string,unknown>): Promise<Record<string,unknown>>;
  nativeEvent?(params:Record<string,unknown>):Promise<void>;
  hostCapabilities?:Record<string,unknown>;
  terminal?(event:{terminalId:string;kind:'created'|'data'|'exited';title?:string;cwd?:string;data?:string;exitCode?:number}):void;
}
interface Terminal {
  process: ChildProcessWithoutNullStreams; output: Buffer; truncated: boolean;
  exit?: {exitCode?: number; signal?: string}; done: Promise<void>;
}

/** One process per active agent session. Sessions are not tied to viewers. */
export class AcpProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly client: ClientSideConnection;
  initialized!: InitializeResponse;
  nativeId?: string;
  closed = false;
  loading = false;
  private terminals = new Map<string,Terminal>();
  private stderr = '';
  constructor(readonly engine: EngineConfig, readonly cwd: string, readonly handlers: AgentHandlers) {
    this.process = spawn(engine.command, engine.args ?? [], {cwd, env: {...process.env,...engine.env}, stdio:'pipe'});
    this.process.stderr.on('data', data => {this.stderr=(this.stderr+data.toString()).slice(-8192);});
    let lineBytes = 0;
    const framingGuard = new Transform({transform(chunk: Buffer,_encoding,callback) {
      for (const byte of chunk) { lineBytes = byte === 10 ? 0 : lineBytes + 1; if (lineBytes > 16 * 1024 * 1024) { callback(new Error('ACP frame exceeds 16 MiB')); return; } }
      callback(null,chunk);
    }});
    framingGuard.on('error', () => this.process.kill());
    this.process.stdout.pipe(framingGuard);
    const stream = ndJsonStream(Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>, Readable.toWeb(framingGuard) as ReadableStream<Uint8Array>);
    const callbacks: Client = {
      sessionUpdate: async params => {this.validateSession(params.sessionId); await handlers.update(params);},
      requestPermission: async params => {this.validateSession(params.sessionId); return handlers.permission(params);},
      readTextFile: async params => {
        this.validateSession(params.sessionId);
        const path = await this.scoped(params.path);
        if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error('File exceeds 8 MiB callback limit; use a scoped resource reader');
        const data = await readFile(path,'utf8');
        const lines = data.split('\n');
        const start = Math.max(0,(params.line ?? 1)-1);
        return {content: lines.slice(start,params.limit == null ? undefined : start+params.limit).join('\n')};
      },
      writeTextFile: async params => {
        this.validateSession(params.sessionId);
        if (Buffer.byteLength(params.content)>8*1024*1024) throw new Error('File exceeds 8 MiB callback limit');
        await writeFile(await this.scoped(params.path,true),params.content); return {};
      },
      createTerminal: async params => {
        this.validateSession(params.sessionId);
        if (this.terminals.size>=16) throw new Error('Session terminal limit reached');
        const cwd = params.cwd ? await this.scoped(params.cwd) : this.cwd;
        const terminalId=randomUUID();
        const child = spawn(params.command,params.args ?? [],{cwd,env:{...process.env,...Object.fromEntries((params.env??[]).map(e=>[e.name,e.value]))},stdio:'pipe'});
        const terminal: Terminal = {process:child,output:Buffer.alloc(0),truncated:false,done:Promise.resolve()};
        const limit = Math.min(params.outputByteLimit??65536,1024*1024);
        this.handlers.terminal?.({terminalId,kind:'created',title:params.command,cwd});
        const append = (data: Buffer) => { const combined=Buffer.concat([terminal.output,data]); terminal.truncated ||= combined.length>limit; terminal.output=combined.subarray(Math.max(0,combined.length-limit));this.handlers.terminal?.({terminalId,kind:'data',data:data.toString('utf8')}); };
        child.stdout.on('data',append); child.stderr.on('data',append);
        terminal.done = new Promise(resolveDone=>{child.once('close',(code,signal)=>{terminal.exit={...(code!==null?{exitCode:code}:{}),...(signal?{signal}:{})};this.handlers.terminal?.({terminalId,kind:'exited',exitCode:code??undefined});resolveDone();});child.once('error',()=>{terminal.exit={exitCode:127};resolveDone();});});
        this.terminals.set(terminalId,terminal);return {terminalId};
      },
      terminalOutput: async params => {this.validateSession(params.sessionId);const t=this.terminal(params.terminalId);return {output:t.output.toString('utf8'),truncated:t.truncated,...(t.exit?{exitStatus:t.exit}:{})};},
      waitForTerminalExit: async params => {this.validateSession(params.sessionId);const t=this.terminal(params.terminalId);await t.done;return t.exit!;},
      killTerminal: async params => {this.validateSession(params.sessionId);this.terminal(params.terminalId).process.kill();return {};},
      releaseTerminal: async params => {this.validateSession(params.sessionId);const t=this.terminal(params.terminalId);t.process.kill();this.terminals.delete(params.terminalId);return {};},
      extMethod: async (method,params) => {
        if (!handlers.hostRequest || method !== '_amplifier/host') throw new Error(`Unsupported client extension: ${method}`);
        this.validateSession(String(params.sessionId)); return handlers.hostRequest(method,params);
      },
      extNotification:async(method,params)=>{if(method==='_amplifier/event'){this.validateSession(String(params.sessionId));await handlers.nativeEvent?.(params);}},
    };
    this.client = new ClientSideConnection(()=>callbacks,stream);
    this.process.once('close',()=>{this.closed=true;for(const terminal of this.terminals.values())terminal.process.kill();});
    this.process.once('error',()=>{this.closed=true;});
  }
  private validateSession(sessionId:string) {
    // session/new can emit updates before returning the newly allocated identity.
    if (this.nativeId && sessionId!==this.nativeId) throw new Error('Agent callback references another native session');
  }
  private terminal(id:string):Terminal {const t=this.terminals.get(id);if(!t)throw new Error('Unknown terminal');return t;}
  private async scoped(path:string,allowMissing=false):Promise<string> {
    const candidate=resolve(this.cwd,path);
    let canonical:string;
    try {canonical=await realpath(candidate);} catch(error) {
      if(!allowMissing || (error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      canonical=resolve(await realpath(dirname(candidate)),candidate.slice(dirname(candidate).length+1));
    }
    const root=await realpath(this.cwd), rel=relative(root,canonical);
    if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('ACP filesystem request outside execution workspace');
    return canonical;
  }
  async initialize() {
    this.initialized=await this.client.initialize({protocolVersion:1,clientInfo:{name:'amplifier-unified-host',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true,_meta:{'amplifier.dev/native':{version:1},...(this.handlers.hostRequest?{'amplifier.dev/host':{...this.handlers.hostCapabilities,version:1}}:{})}}});
    if(this.initialized.protocolVersion!==1)throw new Error('Agent did not negotiate stable ACP version 1');
    return this.initialized;
  }
  async start(nativeId?:string) {
    await this.initialize();
    this.loading=!!nativeId;
    try {
      if(nativeId) {
        this.nativeId=nativeId;
        if(this.initialized.agentCapabilities?.sessionCapabilities?.resume) return await this.client.resumeSession({sessionId:nativeId,cwd:this.cwd,mcpServers:[]});
        if(this.initialized.agentCapabilities?.loadSession) return await this.client.loadSession({sessionId:nativeId,cwd:this.cwd,mcpServers:[]});
        throw new Error('Agent cannot resume this native session; history remains readable');
      }
      const created=await this.client.newSession({cwd:this.cwd,mcpServers:[]});this.nativeId=created.sessionId;return created;
    } finally {this.loading=false;}
  }
  async retire() {
    if(this.nativeId&&this.initialized?.agentCapabilities?.sessionCapabilities?.close&&!this.closed) {
      await Promise.race([this.client.closeSession({sessionId:this.nativeId}),new Promise(resolve=>setTimeout(resolve,2000))]).catch(()=>{});
    }
    this.process.kill();for(const t of this.terminals.values())t.process.kill();
    if(this.process.exitCode===null&&!this.closed)await Promise.race([new Promise<void>(resolve=>this.process.once('close',()=>resolve())),new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.process.kill('SIGKILL');resolve();},1000);timer.unref();})]);
  }
  diagnostics() {return {closed:this.closed,stderrTail:this.stderr,terminals:this.terminals.size};}
}
