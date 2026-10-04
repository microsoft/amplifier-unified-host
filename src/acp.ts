import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable, Transform } from 'node:stream';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClientSideConnection, RequestError, ndJsonStream, type InitializeResponse, type Client, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';

export interface EngineConfig { id: string; label: string; command: string; args?: string[]; env?: Record<string,string>; /** Server-only authenticated account assertion for native message adjuncts. */ messagePrincipal?:string; }
export interface AgentHandlers {
  update(params: SessionNotification): Promise<void>;
  permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  hostRequest?(method: string, params: Record<string,unknown>): Promise<Record<string,unknown>>;
  nativeEvent?(params:Record<string,unknown>):Promise<void>;
  hostCapabilities?:Record<string,unknown>;
  /** Request connection-scoped Host retention only for owned resident agents. */
  hostRuntimeRetention?:boolean;
  /** Host admission for filesystem and terminal effects, including idle peer callbacks. */
  admitEffect?<T>(work:()=>Promise<T>):Promise<T>;
  stopped?(event:{exitCode?:number;signal?:string}):void;
  terminal?(event:{terminalId:string;kind:'created'|'data'|'exited';title?:string;cwd?:string;data?:string;exitCode?:number}):void;
}
interface Terminal {
  process: ChildProcessWithoutNullStreams; output: Buffer; truncated: boolean;
  exit?: {exitCode?: number; signal?: string}; done: Promise<void>;
}

/** One process per active agent session. Sessions are not tied to viewers. */
export class AcpProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly connectionId = randomUUID();
  readonly client: ClientSideConnection;
  initialized!: InitializeResponse;
  /** Immutable outcome of the initial connection handshake. */
  private negotiatedRetention: 'host'|'unmanaged' = 'unmanaged';
  get runtimeRetention(){return this.negotiatedRetention;}
  nativeId?: string;
  closed = false;
  loading = false;
  private terminals = new Map<string,Terminal>();
  // Released terminal handles still own callbacks until their stdio closes.
  private terminalLifetimes = new Set<Terminal>();
  private retiring = false;
  retirementOutcome: 'active'|'pending'|'refused'|'retired'|'unknown' = 'active';
  private retirement?:Promise<void>;
  private stderr = '';
  constructor(readonly engine: EngineConfig, readonly cwd: string, readonly handlers: AgentHandlers) {
    if(engine.messagePrincipal!==undefined&&(typeof engine.messagePrincipal!=='string'||!engine.messagePrincipal.trim()||[...engine.messagePrincipal].length>200||/[\x00-\x1f]/.test(engine.messagePrincipal)))throw Error('Server message principal must be a bounded nonempty account string');
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
      writeTextFile: async params => this.effect(async()=>{
        this.validateSession(params.sessionId);
        if (Buffer.byteLength(params.content)>8*1024*1024) throw new Error('File exceeds 8 MiB callback limit');
        await writeFile(await this.scoped(params.path,true),params.content); return {};
      }),
      createTerminal: async params => this.effect(async()=>{
        this.validateSession(params.sessionId);
        if (this.terminals.size>=16||this.terminalLifetimes.size>=16) throw new Error('Session terminal limit reached');
        const cwd = params.cwd ? await this.scoped(params.cwd) : this.cwd;
        if(this.retiring||this.closed)throw new Error('Agent is retiring; no new terminal was started');
        const terminalId=randomUUID();
        const child = spawn(params.command,params.args ?? [],{cwd,env:{...process.env,...Object.fromEntries((params.env??[]).map(e=>[e.name,e.value]))},stdio:'pipe'});
        const terminal: Terminal = {process:child,output:Buffer.alloc(0),truncated:false,done:Promise.resolve()};
        const limit = Math.min(params.outputByteLimit??65536,1024*1024);
        this.terminalLifetimes.add(terminal);
        this.handlers.terminal?.({terminalId,kind:'created',title:params.command,cwd});
        const append = (data: Buffer) => { const combined=Buffer.concat([terminal.output,data]); terminal.truncated ||= combined.length>limit; terminal.output=combined.subarray(Math.max(0,combined.length-limit));this.handlers.terminal?.({terminalId,kind:'data',data:data.toString('utf8')}); };
        child.stdout.on('data',append); child.stderr.on('data',append);
        terminal.done = new Promise(resolveDone=>{child.once('close',(code,signal)=>{terminal.exit={...(code!==null?{exitCode:code}:{}),...terminal.exit,...(signal?{signal}:{})};try{this.handlers.terminal?.({terminalId,kind:'exited',exitCode:terminal.exit.exitCode});}finally{this.terminalLifetimes.delete(terminal);resolveDone();}});child.once('error',()=>{terminal.exit={exitCode:127};});});
        this.terminals.set(terminalId,terminal);return {terminalId};
      }),
      terminalOutput: async params => {this.validateSession(params.sessionId);const t=this.terminal(params.terminalId);return {output:t.output.toString('utf8'),truncated:t.truncated,...(t.exit?{exitStatus:t.exit}:{})};},
      waitForTerminalExit: async params => {this.validateSession(params.sessionId);const t=this.terminal(params.terminalId);await t.done;return t.exit!;},
      killTerminal: async params => this.effect(async()=>{this.validateSession(params.sessionId);this.terminal(params.terminalId).process.kill();return {};}),
      releaseTerminal: async params => this.effect(async()=>{this.validateSession(params.sessionId);const t=this.terminal(params.terminalId);t.process.kill();this.terminals.delete(params.terminalId);return {};}),
      extMethod: async (method,params) => {
        if (!handlers.hostRequest || method !== '_amplifier/host') throw new Error(`Unsupported client extension: ${method}`);
        this.validateSession(String(params.sessionId)); return handlers.hostRequest(method,params);
      },
      extNotification:async(method,params)=>{if(method==='_amplifier/event'){this.validateSession(String(params.sessionId));await handlers.nativeEvent?.(params);}},
    };
    this.client = new ClientSideConnection(()=>callbacks,stream);
    let stopped=false;const reportStopped=(event:{exitCode?:number;signal?:string})=>{if(stopped)return;stopped=true;this.closed=true;for(const terminal of this.terminalLifetimes)terminal.process.kill();handlers.stopped?.(event);};
    this.process.once('close',(code,signal)=>reportStopped({...(code!==null?{exitCode:code}:{}),...(signal?{signal}:{})}));
    this.process.once('error',()=>reportStopped({}));
  }
  private async effect<T>(work:()=>Promise<T>):Promise<T> {
    try{return await (this.handlers.admitEffect?this.handlers.admitEffect(work):work());}
    catch(error){const fault=error as {code?:unknown;message?:string;data?:unknown};if(Number.isSafeInteger(fault?.code))throw new RequestError(fault.code as number,fault.message??'Host effect was refused',fault.data);throw error;}
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
    this.initialized=await this.client.initialize({protocolVersion:1,clientInfo:{name:'amplifier-unified-host',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true,_meta:{'amplifier.dev/native':{version:1},...(this.engine.messagePrincipal!==undefined?{'amplifier.dev/messagePrincipal':{version:1,account:this.engine.messagePrincipal}}:{}),...(this.handlers.hostRequest||this.handlers.hostRuntimeRetention?{'amplifier.dev/host':{...this.handlers.hostCapabilities,version:1,...(this.handlers.hostRuntimeRetention?{runtimeRetention:{version:1,owner:'host',lifetime:'connection'}}:{})}}:{})}}});
    const native=this.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as any;
    const retention=native?.lifecycle?.runtimeRetention;
    this.negotiatedRetention=this.handlers.hostRuntimeRetention===true&&native?.version===1&&native.lifecycle?.version===1&&retention&&typeof retention==='object'&&!Array.isArray(retention)&&Object.keys(retention).sort().join(',')==='lifetime,owner,standaloneIdleSeconds,version'&&retention.version===1&&retention.owner==='host'&&retention.lifetime==='connection'&&typeof retention.standaloneIdleSeconds==='number'&&Number.isFinite(retention.standaloneIdleSeconds)&&retention.standaloneIdleSeconds>0?'host':'unmanaged';
    if(this.initialized.protocolVersion!==1)throw new Error('Agent did not negotiate stable ACP version 1');
    return this.initialized;
  }
  async start(nativeId?:string,creation?:{sessionId:string;source:Record<string,unknown>;commandId:string},historyCwd?:string) {
    await this.initialize();
    this.loading=!!nativeId;
    const nativeHistory=historyCwd&&(this.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as any)?.version===1?{_meta:{'amplifier.dev/native':{historyCwd}}}:{};
    try {
      if(nativeId) {
        this.nativeId=nativeId;
        if(this.initialized.agentCapabilities?.sessionCapabilities?.resume) return await this.client.resumeSession({sessionId:nativeId,cwd:this.cwd,mcpServers:[],...nativeHistory});
        if(this.initialized.agentCapabilities?.loadSession) return await this.client.loadSession({sessionId:nativeId,cwd:this.cwd,mcpServers:[],...nativeHistory});
        throw new Error('Agent cannot resume this native session; history remains readable');
      }
      if(creation){
        if((this.initialized.agentCapabilities?._meta?.['amplifier.dev/native'] as any)?.configurationClone?.version!==1)throw new Error('Agent does not advertise exact configuration cloning');
        const created=await this.client.extMethod('_amplifier/session/new',{...creation,cwd:creation.source.sourceCwd??this.cwd,mcpServers:[]});
        if(created.sessionId!==creation.sessionId||(created._meta as any)?.['amplifier.dev/native']?.creationConfirmed!==true)throw new Error('Native creation was not conclusively confirmed');
        this.nativeId=String(created.sessionId);return created as {sessionId:string;configOptions?:any[];modes?:any;_meta?:Record<string,unknown>};
      }
      const created=await this.client.newSession({cwd:this.cwd,mcpServers:[]});this.nativeId=created.sessionId;return created;
    } finally {this.loading=false;}
  }
  /** Native atomic graceful retirement; refusal/uncertainty never force-closes owned work. */
  async retireIfIdle(timeoutMs=10000,beforeDispatch?:()=>void):Promise<boolean> {
    if(this.retirementOutcome==='unknown'||this.retirementOutcome==='pending')return false;
    if(this.retirementOutcome==='retired')return true;
    if(this.terminalLifetimes.size)return false;
    if(this.closed)return true;
    const lifecycle=(this.initialized?.agentCapabilities?._meta?.['amplifier.dev/native'] as any)?.lifecycle;
    if(!this.nativeId||lifecycle?.version!==1||lifecycle.gracefulRetire!==true)return false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    this.retirementOutcome='pending';
    try {
      beforeDispatch?.();
      const result=await Promise.race([this.client.extMethod('_amplifier/retire',{sessionId:this.nativeId}),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),timeoutMs);timer.unref();})]);
      if(result?.retired===true){this.retirementOutcome='retired';return true;}
      this.retirementOutcome=result?.retired===false&&['owned_work','active_request'].includes(String(result.reason))?'refused':'unknown';
      return false;
    }catch{this.retirementOutcome='unknown';return false;}finally{clearTimeout(timer);}
  }
  /** Passive proof read on this same connection; never repeats retirement. */
  async inspectRetirement(timeoutMs=1000):Promise<{retired:boolean;reason?:string}> {
    if(this.retirementOutcome==='retired')return {retired:true};
    if(this.retirementOutcome!=='unknown'||this.closed||!this.nativeId)return {retired:false,reason:'not-fenced'};
    const status=(this.initialized?.agentCapabilities?._meta?.['amplifier.dev/native'] as any)?.lifecycle?.retirementStatus;
    if(status?.version!==1||status.method!=='_amplifier/retire/status'||status.passive!==true)return {retired:false,reason:'unsupported'};
    const nativeId=this.nativeId;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([this.client.extMethod('_amplifier/retire/status',{sessionId:nativeId}),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),timeoutMs);timer.unref();})]);
      if(!this.closed&&this.nativeId===nativeId&&result?.sessionId===nativeId&&result.retired===true){this.retirementOutcome='retired';return {retired:true};}
      return {retired:false,reason:'unconfirmed'};
    }catch{return {retired:false,reason:'transport-unknown'};}finally{clearTimeout(timer);}
  }
  retire():Promise<void> {
    this.retiring=true;
    return this.retirement??=this.finishRetirement();
  }
  private async finishRetirement() {
    if(this.nativeId&&this.initialized?.agentCapabilities?.sessionCapabilities?.close&&!this.closed) {
      await Promise.race([this.client.closeSession({sessionId:this.nativeId}),new Promise(resolve=>setTimeout(resolve,2000))]).catch(()=>{});
    }
    this.process.kill();for(const t of this.terminalLifetimes)t.process.kill();
    // Do not close the host store while terminal output/exit callbacks remain.
    // SIGKILL bounds a direct child that ignores the first shutdown signal;
    // completion still requires its real close event, not the timer.
    const terminalKill=setTimeout(()=>{for(const t of this.terminalLifetimes)t.process.kill('SIGKILL');},1000);terminalKill.unref();
    try {
      if(this.process.exitCode===null&&!this.closed)await Promise.race([new Promise<void>(resolve=>this.process.once('close',()=>resolve())),new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.process.kill('SIGKILL');resolve();},1000);timer.unref();})]);
      await Promise.all([...this.terminalLifetimes].map(t=>t.done));
    }finally{clearTimeout(terminalKill);}
  }
  diagnostics() {return {closed:this.closed,stderrTail:this.stderr,terminals:this.terminals.size};}
}
