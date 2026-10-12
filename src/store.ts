import {UsageReceipts} from './usage.js';
import {initializeAuthority,preflightAuthorityFile,AuthoritativeSchemaError} from './authoritative-schema.js';
import type {NativeFailedInput} from './input-outcome.js';
import {NavigationIndex} from './navigation.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,realpathSync } from 'node:fs';
import { OwnerLease } from './owner-lease.js';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chatReducer, type ActionEnvelope, type ChatState, type SessionState, type SessionSummary, type Turn } from '@microsoft/agent-host-protocol';

export interface SessionRecord {
  uri: string; engineId: string; nativeSessionId?: string; workingDirectory: string; executionDirectory?:string; nativeLocationRevision?:number;
  summary: SessionSummary; state: SessionState; chat: ChatState;
}
export interface Receipt {
  peerTerminals?:Record<string,any>[];
  commandId: string; channel: string; clientId: string; clientSeq: number;
  status: 'admitted' | 'dispatching' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  fingerprint: string; createdAt: string; updatedAt: string; detail?: string;requestSignature?:string;retryEligibility?:'waiting_worker';observationAdmission?:Record<string,unknown>;nativeInputOutcome?:NativeFailedInput;
}

/** Host projections and admission only. Native agent history is never rewritten here. */
export class Store {
  readonly db: DatabaseSync;
  readonly navigation:NavigationIndex;
  readonly usage:UsageReceipts;
  readonly incarnation = randomUUID();
  private replayBytes=0;
  private lease:OwnerLease;
  private transactionOpen=false;
  onReceiptChanged?:(channel:string)=>void;
  private receiptChanges=new Set<string>();
  private notifyReceipt(channel:string){try{this.onReceiptChanged?.(channel);}catch{/* Observers cannot change a committed receipt. */}}
  constructor(directory: string, readonly replayLimit = 4096) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    this.lease=new OwnerLease(directory);
    let opened:DatabaseSync|undefined;
    try{
    const path=join(directory,'host.sqlite'),existingFile=preflightAuthorityFile(path,'store');
    this.db = opened = new DatabaseSync(path);
    initializeAuthority(this.db,'store',()=>{
    // Established stores must retain their identity, even after a stopped copy
    // moves directories. Only the recognized pre-identity schema can mint it.
    const hadIdentity=!!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='library_identity'").get();
    this.db.exec('CREATE TABLE IF NOT EXISTS library_identity(id INTEGER PRIMARY KEY CHECK(id=1),source TEXT NOT NULL)');
    if(!hadIdentity)this.db.prepare('INSERT INTO library_identity VALUES(1,?)').run(createHash('sha256').update(realpathSync(directory)).digest('hex'));
    const identities=this.db.prepare('SELECT id,source FROM library_identity LIMIT 2').all();
    if(identities.length!==1||identities[0].id!==1||typeof identities[0].source!=='string'||!/^[a-f0-9]{64}$/.test(identities[0].source))throw new AuthoritativeSchemaError('library identity missing or invalid');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_usage(session TEXT NOT NULL,call_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session,call_id));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('seq',0);
      CREATE TABLE IF NOT EXISTS sessions(uri TEXT PRIMARY KEY,chat_uri TEXT UNIQUE NOT NULL,engine_id TEXT NOT NULL,native_id TEXT,cwd TEXT NOT NULL,modified TEXT NOT NULL,summary TEXT NOT NULL,state TEXT NOT NULL,chat TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_projection_pending(uri TEXT PRIMARY KEY,is_archived INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS archived_session_projection ON sessions(uri) WHERE (json_extract(summary,'$.status') & 64)<>0;
      INSERT OR IGNORE INTO archive_projection_pending SELECT uri,1 FROM sessions WHERE (json_extract(summary,'$.status') & 64)<>0;
      CREATE TRIGGER IF NOT EXISTS archive_projection_changed AFTER UPDATE OF summary ON sessions
        WHEN (json_extract(OLD.summary,'$.status') & 64)<>(json_extract(NEW.summary,'$.status') & 64) BEGIN
          INSERT INTO archive_projection_pending VALUES(NEW.uri,(json_extract(NEW.summary,'$.status') & 64)<>0) ON CONFLICT(uri) DO UPDATE SET is_archived=excluded.is_archived;
        END;
      CREATE INDEX IF NOT EXISTS sessions_order ON sessions(modified DESC,uri DESC);
      CREATE TABLE IF NOT EXISTS turns(chat TEXT NOT NULL,ordinal INTEGER PRIMARY KEY AUTOINCREMENT,turn_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(chat,turn_id));
      CREATE INDEX IF NOT EXISTS turns_page ON turns(chat,ordinal);
      CREATE TABLE IF NOT EXISTS coordination_results(chat TEXT NOT NULL,turn_id TEXT NOT NULL,sequence INTEGER NOT NULL,text TEXT NOT NULL,truncated INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(chat,turn_id));
      CREATE INDEX IF NOT EXISTS coordination_results_sequence ON coordination_results(chat,sequence);
      INSERT OR IGNORE INTO meta SELECT 'coordination_start_ordinal',coalesce(max(ordinal),0) FROM turns;
      CREATE TABLE IF NOT EXISTS actions(seq INTEGER PRIMARY KEY,channel TEXT NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(command_id TEXT PRIMARY KEY,channel TEXT NOT NULL,client_id TEXT NOT NULL,client_seq INTEGER NOT NULL,payload TEXT NOT NULL);
      DROP INDEX IF EXISTS receipt_origin;
      CREATE TABLE IF NOT EXISTS receipt_attempts(command_id TEXT NOT NULL,attempt INTEGER NOT NULL,receipt TEXT NOT NULL,turn_payload TEXT,PRIMARY KEY(command_id,attempt));
      CREATE INDEX IF NOT EXISTS receipt_origin_lookup ON receipts(client_id,client_seq);
      CREATE INDEX IF NOT EXISTS receipt_status_channel ON receipts(json_extract(payload,'$.status'),channel);
      CREATE TABLE IF NOT EXISTS terminals(uri TEXT PRIMARY KEY,session TEXT NOT NULL,modified TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_admission(uri TEXT PRIMARY KEY,execution INTEGER NOT NULL DEFAULT 0,interruption INTEGER NOT NULL DEFAULT 0,configuration INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS relocations(command_id TEXT PRIMARY KEY,uri TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS relocations_session ON relocations(uri,status);
      CREATE INDEX IF NOT EXISTS relocations_source ON relocations(source,status);
      CREATE INDEX IF NOT EXISTS relocations_target ON relocations(target,status);
      CREATE TABLE IF NOT EXISTS history_edit_archives(operation_id TEXT NOT NULL,chat TEXT NOT NULL,ordinal INTEGER NOT NULL,turn_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(operation_id,chat,turn_id));
      CREATE TABLE IF NOT EXISTS history_edits(operation_id TEXT PRIMARY KEY,session TEXT NOT NULL,input_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_edits_session ON history_edits(session,status);
      CREATE TABLE IF NOT EXISTS lifecycle_commands(command_id TEXT PRIMARY KEY,session TEXT NOT NULL,operation TEXT NOT NULL,target TEXT,status TEXT NOT NULL,payload TEXT NOT NULL,result TEXT);
      CREATE INDEX IF NOT EXISTS lifecycle_session_status ON lifecycle_commands(session,status);
      CREATE INDEX IF NOT EXISTS lifecycle_target_status ON lifecycle_commands(target,status);
      CREATE TABLE IF NOT EXISTS session_visibility(uri TEXT PRIMARY KEY,deleted INTEGER NOT NULL,command_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS export_resources(uri TEXT PRIMARY KEY,session TEXT NOT NULL,snapshot_id TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transfer_fences(session TEXT PRIMARY KEY,transfer_id TEXT NOT NULL,source TEXT NOT NULL,destination TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS transfer_identity ON transfer_fences(transfer_id);
      CREATE TABLE IF NOT EXISTS transfer_commands(command_id TEXT PRIMARY KEY,session TEXT NOT NULL,transfer_id TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS import_adoptions(command_id TEXT PRIMARY KEY,engine_id TEXT NOT NULL,import_command_id TEXT NOT NULL,session TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,proof TEXT NOT NULL,result TEXT,UNIQUE(engine_id,import_command_id));
      CREATE INDEX IF NOT EXISTS import_adoptions_session ON import_adoptions(session,status);
      CREATE INDEX IF NOT EXISTS sessions_native_identity ON sessions(engine_id,native_id,cwd);
      CREATE TABLE IF NOT EXISTS creation_keys(identity TEXT PRIMARY KEY,command_id TEXT NOT NULL,uri TEXT NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_intents(id TEXT PRIMARY KEY,chat TEXT NOT NULL,message TEXT,origin TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL,held INTEGER NOT NULL DEFAULT 0,reason TEXT,projected INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS queue_pending ON queue_intents(status,chat,position);
      CREATE TABLE IF NOT EXISTS steering_intents(id TEXT PRIMARY KEY,chat TEXT NOT NULL,message TEXT,origin TEXT NOT NULL,status TEXT NOT NULL,held INTEGER NOT NULL DEFAULT 0,active_turn_id TEXT,generation_id TEXT,reason TEXT,projected INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS steering_pending ON steering_intents(chat,status);
      CREATE INDEX IF NOT EXISTS steering_status ON steering_intents(status,chat);
      CREATE INDEX IF NOT EXISTS steering_unprojected ON steering_intents(id) WHERE projected=0;
      CREATE INDEX IF NOT EXISTS steering_turn ON steering_intents(chat,active_turn_id,status);
      CREATE TABLE IF NOT EXISTS active_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,action TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS active_events_channel ON active_events(channel,seq);
    `);
    if(!this.db.prepare('PRAGMA table_info(session_admission)').all().some(column=>column.name==='navigation'))this.db.exec('ALTER TABLE session_admission ADD COLUMN navigation TEXT');
    if(!this.db.prepare('PRAGMA table_info(terminals)').all().some(column=>column.name==='lifecycle'))this.db.exec("ALTER TABLE terminals ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'exited'; UPDATE terminals SET lifecycle=json_extract(payload,'$.lifecycle.status');");
    if(!this.db.prepare('PRAGMA table_info(sessions)').all().some(column=>column.name==='execution_cwd'))this.db.exec('ALTER TABLE sessions ADD COLUMN execution_cwd TEXT; ALTER TABLE sessions ADD COLUMN native_location_revision INTEGER NOT NULL DEFAULT 0; UPDATE sessions SET execution_cwd=cwd');
    if(!this.db.prepare('PRAGMA table_info(sessions)').all().some(column=>column.name==='hidden'))this.db.exec('ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_visible_order ON sessions(hidden,modified DESC,uri DESC)');
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_execution ON sessions(execution_cwd); CREATE INDEX IF NOT EXISTS sessions_history ON sessions(cwd); UPDATE relocations SET status='unknown' WHERE status='admitted';");
    if(!this.db.prepare('PRAGMA table_info(queue_intents)').all().some(column=>column.name==='projected'))this.db.exec('ALTER TABLE queue_intents ADD COLUMN projected INTEGER NOT NULL DEFAULT 1');
    this.db.exec("UPDATE import_adoptions SET status='unknown' WHERE status='dispatching'");
    this.db.exec("UPDATE lifecycle_commands SET status='unknown' WHERE status='dispatching'");
    this.db.exec("UPDATE transfer_commands SET status='unknown' WHERE status='dispatching'; UPDATE transfer_fences SET status='unknown' WHERE status='dispatching'");
    this.db.exec('CREATE INDEX IF NOT EXISTS queue_projection_pending ON queue_intents(projected)');
    this.db.exec("UPDATE queue_intents SET held=1,reason='host-restarted' WHERE status='pending'");
    this.db.exec("UPDATE steering_intents SET status='unknown',reason='host-restarted' WHERE status='dispatching'; UPDATE steering_intents SET held=1,reason='host-restarted' WHERE status='pending'");
    this.db.exec('CREATE INDEX IF NOT EXISTS terminals_lifecycle ON terminals(lifecycle,modified DESC)');
    this.replayBytes=Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM actions').get()!.n);
    // An interrupted admitted/dispatching command is never sent again automatically.
    for (const row of this.db.prepare("SELECT payload FROM receipts WHERE json_extract(payload,'$.status') IN ('admitted','dispatching')").iterate()) {
      const receipt = JSON.parse(row.payload as string) as Receipt;
      this.finish(receipt.commandId, 'unknown', 'Host restarted before a conclusive ACP outcome; reconcile native history before new work.');
    }
    },{existingFile,configure:'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;'});
    this.usage=new UsageReceipts(this.db);
    this.transaction(()=>{this.usage.backfill();this.usage.interrupted();});
    this.navigation=new NavigationIndex(this.db);
    }catch(error){opened?.close();this.lease.close();throw error;}
  }
  get seq(): number { return Number(this.db.prepare("SELECT value FROM meta WHERE key='seq'").get()!.value); }
  get librarySource():string {return String(this.db.prepare('SELECT source FROM library_identity WHERE id=1').get()!.source);}
  get count(): number { return Number(this.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n); }
  transaction<T>(work: () => T): T {
    if(this.transactionOpen)return work();
    const replayBytes=this.replayBytes;
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionOpen=true;
    try { const result = work(); this.db.exec('COMMIT');this.transactionOpen=false;const channels=[...this.receiptChanges];this.receiptChanges.clear();for(const channel of channels)this.notifyReceipt(channel);return result; }
    catch (error) {this.replayBytes=replayBytes;this.receiptChanges.clear();if(this.transactionOpen)this.db.exec('ROLLBACK');throw error;}
    finally {this.transactionOpen=false;}
  }
  /** Navigation needs metadata only, never the active event log or chat snapshot. */
  summary(uri:string):SessionSummary|undefined {
    const row=this.db.prepare('SELECT summary FROM sessions WHERE uri=? OR chat_uri=?').get(uri,uri);
    return row?JSON.parse(row.summary as string):undefined;
  }
  get(uri: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE uri=? OR chat_uri=?').get(uri, uri);
    if (!row) return;
    let chat=JSON.parse(row.chat as string) as ChatState;
    for(const event of this.db.prepare('SELECT action FROM active_events WHERE channel=? ORDER BY seq').iterate(chat.resource))chat=chatReducer(chat,JSON.parse(event.action as string));
    return {uri: row.uri as string, engineId: row.engine_id as string, nativeSessionId: row.native_id as string | undefined,
      workingDirectory: row.cwd as string,executionDirectory:(row.execution_cwd??row.cwd) as string,nativeLocationRevision:Number(row.native_location_revision??0), summary: JSON.parse(row.summary as string), state: JSON.parse(row.state as string), chat};
  }
  save(record: SessionRecord) {
    if(!this.transactionOpen){this.transaction(()=>this.save(record));return;}
    this.db.prepare(`INSERT INTO sessions(uri,chat_uri,engine_id,native_id,cwd,modified,summary,state,chat,execution_cwd,native_location_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uri) DO UPDATE SET native_id=excluded.native_id,modified=excluded.modified,summary=excluded.summary,state=excluded.state,chat=excluded.chat,execution_cwd=excluded.execution_cwd,native_location_revision=excluded.native_location_revision`)
      .run(record.uri, record.chat.resource, record.engineId, record.nativeSessionId ?? null, record.workingDirectory, record.summary.modifiedAt, JSON.stringify(record.summary), JSON.stringify(record.state), JSON.stringify({...record.chat, turns: []}),record.executionDirectory??record.workingDirectory,record.nativeLocationRevision??0);
    this.db.prepare('DELETE FROM active_events WHERE channel=?').run(record.chat.resource);
  }
  saveSessionMetadata(record:SessionRecord) {
    this.db.prepare('UPDATE sessions SET modified=?,summary=?,state=? WHERE uri=?').run(record.summary.modifiedAt,JSON.stringify(record.summary),JSON.stringify(record.state),record.uri);
  }
  appendActive(channel:string,action:unknown){this.db.prepare('INSERT INTO active_events(channel,action) VALUES(?,?)').run(channel,JSON.stringify(action));}
  list(limit: number, after?: {modified: string; uri: string}): SessionSummary[] {
    const rows = after ? this.db.prepare('SELECT summary FROM sessions WHERE hidden=0 AND (modified,uri)<(?,?) ORDER BY modified DESC,uri DESC LIMIT ?').all(after.modified, after.uri, limit)
      : this.db.prepare('SELECT summary FROM sessions WHERE hidden=0 ORDER BY modified DESC,uri DESC LIMIT ?').all(limit);
    return rows.map(row => JSON.parse(row.summary as string));
  }
  saveTurn(chat: string, turn: Turn):number {
    if(!this.transactionOpen)return this.transaction(()=>this.saveTurn(chat,turn));
    this.db.prepare('INSERT INTO turns(chat,turn_id,payload) VALUES(?,?,?) ON CONFLICT(chat,turn_id) DO UPDATE SET payload=excluded.payload').run(chat, turn.id, JSON.stringify(turn));
    const identity=this.db.prepare('SELECT uri,native_id FROM sessions WHERE chat_uri=?').get(chat);
    if(identity?.native_id)this.usage.observeTurn(String(identity.uri),String(identity.native_id),turn);
    const ordinal=Number(this.db.prepare('SELECT ordinal FROM turns WHERE chat=? AND turn_id=?').get(chat,turn.id)!.ordinal);
    const text=turn.responseParts.filter(part=>part.kind==='markdown').map(part=>(part as {content:string}).content).join('\n'),bytes=Buffer.from(text),preview=bytes.subarray(0,20000).toString('utf8');
    this.db.prepare('INSERT INTO coordination_results VALUES(?,?,?,?,?,?) ON CONFLICT(chat,turn_id) DO UPDATE SET text=excluded.text,truncated=excluded.truncated,state=excluded.state').run(chat,turn.id,ordinal,preview,bytes.length>20000?1:0,turn.state);
    return ordinal;
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
    if(receipt.status!==status){if(this.transactionOpen){if(this.receiptChanges.size<128)this.receiptChanges.add(receipt.channel);else this.receiptChanges.add('*capacity');}else this.notifyReceipt(receipt.channel);}
  }
  annotateReceipt(commandId:string,values:Pick<Receipt,'requestSignature'|'retryEligibility'|'observationAdmission'|'nativeInputOutcome'|'peerTerminals'>) {
    const receipt=this.receipt(commandId);if(!receipt)throw new Error('Unknown command identity');
    this.db.prepare('UPDATE receipts SET payload=? WHERE command_id=?').run(JSON.stringify({...receipt,...values}),commandId);
  }
  reopenKnownRefusal(commandId:string,channel:string,signature:string) {
    if(!this.transactionOpen)throw new Error('Known-refusal retry must share an atomic admission transaction');
    const receipt=this.receipt(commandId);if(!receipt)return;
    if(receipt.channel!==channel||receipt.status!=='failed'||receipt.retryEligibility!=='waiting_worker'||receipt.requestSignature!==signature)throw new Error('Command is not an exact retryable no-effect observation');
    const turn=this.db.prepare('SELECT payload FROM turns WHERE chat=? AND turn_id=?').get(channel,commandId);
    const attempt=Number(this.db.prepare('SELECT coalesce(max(attempt),0)+1 n FROM receipt_attempts WHERE command_id=?').get(commandId)!.n);
    this.db.prepare('INSERT INTO receipt_attempts VALUES(?,?,?,?)').run(commandId,attempt,JSON.stringify(receipt),turn?.payload??null);
    this.db.prepare('DELETE FROM turns WHERE chat=? AND turn_id=?').run(channel,commandId);
    this.db.prepare('DELETE FROM coordination_results WHERE chat=? AND turn_id=?').run(channel,commandId);
    this.db.prepare('DELETE FROM receipts WHERE command_id=?').run(commandId);
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
  close() { try{this.db.close();}finally{this.lease.close();} }
}
