import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chatReducer, type ActionEnvelope, type ChatState, type SessionState, type SessionSummary, type Turn } from '@microsoft/agent-host-protocol';

export interface SessionRecord {
  uri: string; engineId: string; nativeSessionId?: string; workingDirectory: string;
  summary: SessionSummary; state: SessionState; chat: ChatState;
}
export interface Receipt {
  commandId: string; channel: string; clientId: string; clientSeq: number;
  status: 'admitted' | 'dispatching' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  fingerprint: string; createdAt: string; updatedAt: string; detail?: string;
}

/** Host projections and admission only. Native agent history is never rewritten here. */
export class Store {
  readonly db: DatabaseSync;
  readonly incarnation = randomUUID();
  private replayBytes=0;
  private lease:number|undefined;
  private leasePath:string;
  private transactionOpen=false;
  constructor(directory: string, readonly replayLimit = 4096) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    this.leasePath=join(directory,'host.lock');
    try {this.lease=openSync(this.leasePath,'wx',0o600);}catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const previous=JSON.parse(readFileSync(this.leasePath,'utf8'));
      try{process.kill(previous.pid,0);}catch(probe){if((probe as NodeJS.ErrnoException).code==='ESRCH'){unlinkSync(this.leasePath);this.lease=openSync(this.leasePath,'wx',0o600);}else throw probe;}
      if(this.lease===undefined)throw new Error('Host state directory already has a live owner');
    }
    writeFileSync(this.lease!,JSON.stringify({pid:process.pid,incarnation:this.incarnation}));
    this.db = new DatabaseSync(join(directory, 'host.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('seq',0);
      CREATE TABLE IF NOT EXISTS sessions(uri TEXT PRIMARY KEY,chat_uri TEXT UNIQUE NOT NULL,engine_id TEXT NOT NULL,native_id TEXT,cwd TEXT NOT NULL,modified TEXT NOT NULL,summary TEXT NOT NULL,state TEXT NOT NULL,chat TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_order ON sessions(modified DESC,uri DESC);
      CREATE TABLE IF NOT EXISTS turns(chat TEXT NOT NULL,ordinal INTEGER PRIMARY KEY AUTOINCREMENT,turn_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(chat,turn_id));
      CREATE INDEX IF NOT EXISTS turns_page ON turns(chat,ordinal);
      CREATE TABLE IF NOT EXISTS actions(seq INTEGER PRIMARY KEY,channel TEXT NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(command_id TEXT PRIMARY KEY,channel TEXT NOT NULL,client_id TEXT NOT NULL,client_seq INTEGER NOT NULL,payload TEXT NOT NULL);
      DROP INDEX IF EXISTS receipt_origin;
      CREATE INDEX IF NOT EXISTS receipt_origin_lookup ON receipts(client_id,client_seq);
      CREATE TABLE IF NOT EXISTS terminals(uri TEXT PRIMARY KEY,session TEXT NOT NULL,modified TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_admission(uri TEXT PRIMARY KEY,execution INTEGER NOT NULL DEFAULT 0,interruption INTEGER NOT NULL DEFAULT 0,configuration INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS creation_keys(identity TEXT PRIMARY KEY,command_id TEXT NOT NULL,uri TEXT NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS active_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,action TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS active_events_channel ON active_events(channel,seq);
    `);
    if(!this.db.prepare('PRAGMA table_info(terminals)').all().some(column=>column.name==='lifecycle'))this.db.exec("ALTER TABLE terminals ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'exited'; UPDATE terminals SET lifecycle=json_extract(payload,'$.lifecycle.status');");
    this.db.exec('CREATE INDEX IF NOT EXISTS terminals_lifecycle ON terminals(lifecycle,modified DESC)');
    this.replayBytes=Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM actions').get()!.n);
    // An interrupted admitted/dispatching command is never sent again automatically.
    for (const row of this.db.prepare("SELECT payload FROM receipts WHERE json_extract(payload,'$.status') IN ('admitted','dispatching')").iterate()) {
      const receipt = JSON.parse(row.payload as string) as Receipt;
      this.finish(receipt.commandId, 'unknown', 'Host restarted before a conclusive ACP outcome; reconcile native history before new work.');
    }
  }
  get seq(): number { return Number(this.db.prepare("SELECT value FROM meta WHERE key='seq'").get()!.value); }
  get count(): number { return Number(this.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n); }
  transaction<T>(work: () => T): T {
    if(this.transactionOpen)return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionOpen=true;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally {this.transactionOpen=false;}
  }
  get(uri: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE uri=? OR chat_uri=?').get(uri, uri);
    if (!row) return;
    let chat=JSON.parse(row.chat as string) as ChatState;
    for(const event of this.db.prepare('SELECT action FROM active_events WHERE channel=? ORDER BY seq').iterate(chat.resource))chat=chatReducer(chat,JSON.parse(event.action as string));
    return {uri: row.uri as string, engineId: row.engine_id as string, nativeSessionId: row.native_id as string | undefined,
      workingDirectory: row.cwd as string, summary: JSON.parse(row.summary as string), state: JSON.parse(row.state as string), chat};
  }
  save(record: SessionRecord) {
    if(!this.transactionOpen){this.transaction(()=>this.save(record));return;}
    this.db.prepare(`INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(uri) DO UPDATE SET native_id=excluded.native_id,modified=excluded.modified,summary=excluded.summary,state=excluded.state,chat=excluded.chat`)
      .run(record.uri, record.chat.resource, record.engineId, record.nativeSessionId ?? null, record.workingDirectory, record.summary.modifiedAt, JSON.stringify(record.summary), JSON.stringify(record.state), JSON.stringify({...record.chat, turns: []}));
    this.db.prepare('DELETE FROM active_events WHERE channel=?').run(record.chat.resource);
  }
  appendActive(channel:string,action:unknown){this.db.prepare('INSERT INTO active_events(channel,action) VALUES(?,?)').run(channel,JSON.stringify(action));}
  list(limit: number, after?: {modified: string; uri: string}): SessionSummary[] {
    const rows = after ? this.db.prepare('SELECT summary FROM sessions WHERE (modified,uri)<(?,?) ORDER BY modified DESC,uri DESC LIMIT ?').all(after.modified, after.uri, limit)
      : this.db.prepare('SELECT summary FROM sessions ORDER BY modified DESC,uri DESC LIMIT ?').all(limit);
    return rows.map(row => JSON.parse(row.summary as string));
  }
  saveTurn(chat: string, turn: Turn) {
    this.db.prepare('INSERT INTO turns(chat,turn_id,payload) VALUES(?,?,?) ON CONFLICT(chat,turn_id) DO UPDATE SET payload=excluded.payload').run(chat, turn.id, JSON.stringify(turn));
    return Number(this.db.prepare('SELECT ordinal FROM turns WHERE chat=? AND turn_id=?').get(chat,turn.id)!.ordinal);
  }
  turns(chat: string, limit?: number, before?: number): {turns: Turn[]; before?: number; first?:number} {
    const rows = this.db.prepare('SELECT ordinal,payload FROM turns WHERE chat=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?')
      .all(chat, before ?? Number.MAX_SAFE_INTEGER, limit ?? -1);
    const first = rows.at(-1)?.ordinal as number | undefined;
    const older = first && this.db.prepare('SELECT 1 FROM turns WHERE chat=? AND ordinal<? LIMIT 1').get(chat, first);
    return {turns: rows.reverse().map(row => JSON.parse(row.payload as string)), before: older ? first : undefined, first};
  }
  turnsFrom(chat:string,first:number,before=Number.MAX_SAFE_INTEGER):Turn[] {return this.db.prepare('SELECT payload FROM turns WHERE chat=? AND ordinal>=? AND ordinal<? ORDER BY ordinal').all(chat,first,before).map(row=>JSON.parse(row.payload as string));}
  append(channel: string, action: ActionEnvelope['action'], origin?: ActionEnvelope['origin'], rejectionReason?: string): ActionEnvelope {
    this.db.prepare("UPDATE meta SET value=value+1 WHERE key='seq'").run();
    const envelope: ActionEnvelope = {channel, action, serverSeq: this.seq, origin, ...(rejectionReason ? {rejectionReason} : {})};
    const payload = JSON.stringify(envelope);
    const bytes=Buffer.byteLength(payload);
    this.db.prepare('INSERT INTO actions VALUES(?,?,?,?)').run(envelope.serverSeq, channel, payload, bytes);
    this.replayBytes+=bytes;
    for(const row of this.db.prepare('DELETE FROM actions WHERE seq<=? RETURNING bytes').all(envelope.serverSeq - this.replayLimit))this.replayBytes-=Number(row.bytes);
    // Count and byte bounds; a single oversized envelope is still durably projected, but cannot be replayed.
    while(this.replayBytes>16*1024*1024) {
      const rows=this.db.prepare('DELETE FROM actions WHERE seq IN (SELECT seq FROM actions ORDER BY seq LIMIT 64) RETURNING bytes').all();
      for(const row of rows)this.replayBytes-=Number(row.bytes);
    }
    return envelope;
  }
  replay(after: number, subscriptions: Set<string>): ActionEnvelope[] | undefined {
    const first = this.db.prepare('SELECT min(seq) AS n FROM actions').get()?.n;
    if (after > this.seq || after < this.seq && (first === null || after < Number(first) - 1)) return;
    return this.db.prepare('SELECT payload FROM actions WHERE seq>? ORDER BY seq').all(after)
      .map(row => JSON.parse(row.payload as string) as ActionEnvelope)
      .filter(action => subscriptions.has(action.channel));
  }
  receipt(commandId: string): Receipt | undefined {
    const row = this.db.prepare('SELECT payload FROM receipts WHERE command_id=?').get(commandId);
    return row && JSON.parse(row.payload as string);
  }
  extensionSequence(clientId:string):number {
    const row=this.db.prepare('SELECT min(client_seq) AS n FROM receipts WHERE client_id=?').get(clientId);
    return Math.min(-1,Number(row?.n??0)-1);
  }
  admission(channel: string, action: unknown, commandId: string, clientId: string, clientSeq: number): Receipt {
    const fingerprint = createHash('sha256').update(JSON.stringify({channel, action})).digest('hex');
    const existing = this.receipt(commandId);
    if (existing) throw new Error(existing.fingerprint === fingerprint ? `Command already admitted: ${existing.status}` : 'Command identity reused with different content');
    const now = new Date().toISOString();
    const receipt: Receipt = {commandId, channel, clientId, clientSeq, fingerprint, status: 'admitted', createdAt: now, updatedAt: now};
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(commandId,channel,clientId,clientSeq,JSON.stringify(receipt));
    return receipt;
  }
  finish(commandId: string, status: Receipt['status'], detail?: string) {
    const receipt = this.receipt(commandId);
    if (!receipt) throw new Error('Unknown command identity');
    this.db.prepare('UPDATE receipts SET payload=? WHERE command_id=?').run(JSON.stringify({...receipt,status,detail,updatedAt:new Date().toISOString()}),commandId);
  }
  unknown(channel: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM receipts WHERE channel=? AND json_extract(payload,'$.status')='unknown' LIMIT 1").get(channel);
  }
  revisions(uri:string):{executionRevision:number;interruptionRevision:number;configurationRevision:number} {
    const row=this.db.prepare('SELECT * FROM session_admission WHERE uri=?').get(uri);
    return {executionRevision:Number(row?.execution??0),interruptionRevision:Number(row?.interruption??0),configurationRevision:Number(row?.configuration??0)};
  }
  bump(uri:string,kind:'execution'|'interruption'|'configuration') {
    this.db.prepare('INSERT OR IGNORE INTO session_admission(uri) VALUES(?)').run(uri);
    this.db.prepare(`UPDATE session_admission SET ${kind}=${kind}+1 WHERE uri=?`).run(uri);
  }
  close() { this.db.close();closeSync(this.lease!);if(JSON.parse(readFileSync(this.leasePath,'utf8')).incarnation===this.incarnation)unlinkSync(this.leasePath); }
}
