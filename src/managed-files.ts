import {initializeAuthority} from './authoritative-schema.js';
import type {DatabaseSync} from 'node:sqlite';
export interface ManagedFilesActor {actorId:string;clientId?:string;}
export interface ManagedFilesApply {commandId:string;reviewId:string;reviewHash:string;expectedHistoryRevision:string;protectSessionIds?:string[];}
export interface ManagedFilesProtection {
 managedFiles:{version:1;preservesCanonical:true};
 acquire(context:{commandId:string;session:string;descendants:string[];operation:'dispose-owned-files';reviewHash:string;allocation:{allocationId:string;executionDirectory:string;allocationHash:string;treeHash:string;entryCount:number;bytes:number}}):Promise<{ownerIds:string[];release():Promise<void>}>;
}
type Json=Record<string,any>;
/** Exact review/effect evidence; file payloads and transcript bodies never enter this journal. */
export class ManagedFilesJournal {
 constructor(private db:DatabaseSync){initializeAuthority(db,'managedFiles',()=>{db.exec(`CREATE TABLE IF NOT EXISTS managed_file_reviews(id TEXT PRIMARY KEY,session TEXT NOT NULL,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS managed_file_effects(command_id TEXT PRIMARY KEY,session TEXT NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL);CREATE INDEX IF NOT EXISTS managed_file_effects_session ON managed_file_effects(session);`);});}
 review(id:string):Json|undefined{const row=this.db.prepare('SELECT body FROM managed_file_reviews WHERE id=?').get(id);return row?JSON.parse(String(row.body)):undefined;}
 saveReview(value:Json){this.db.prepare("DELETE FROM managed_file_reviews WHERE json_extract(body,'$.expiresAt')<?").run(Date.now()/1000);if(Number(this.db.prepare('SELECT count(*) AS n FROM managed_file_reviews').get()!.n)>=1000)throw new Error('Managed review capacity reached');this.db.prepare('INSERT INTO managed_file_reviews VALUES(?,?,?)').run(value.reviewId,value.session,JSON.stringify(value));}
 receipt(session:string,commandId:string):Json|undefined{const row=this.db.prepare('SELECT body FROM managed_file_effects WHERE session=? AND command_id=?').get(session,commandId);return row?JSON.parse(String(row.body)):undefined;}
 command(commandId:string){return this.db.prepare('SELECT session,signature FROM managed_file_effects WHERE command_id=?').get(commandId);}
 fence(session:string):Json|undefined{const row=this.db.prepare("SELECT body FROM managed_file_effects WHERE session=? AND json_extract(body,'$.status') IN ('unknown','completed') LIMIT 1").get(session);return row?JSON.parse(String(row.body)):undefined;}
 reserve(session:string,commandId:string,signature:string,body:Json){this.db.prepare('INSERT INTO managed_file_effects VALUES(?,?,?,?)').run(commandId,session,signature,JSON.stringify(body));}
 update(value:Json){this.db.prepare('UPDATE managed_file_effects SET body=? WHERE session=? AND command_id=?').run(JSON.stringify(value),value.session,value.commandId);}
}
