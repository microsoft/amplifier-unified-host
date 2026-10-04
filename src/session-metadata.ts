/** Generic selected-session metadata ports. Engines own canonical persistence. */
export interface SessionMetadataContext {session:string;engineId:string;nativeSessionId?:string;workingDirectory:string;}
export interface SessionTitleSnapshot {title:string;titleRevision:string;metadata?:Record<string,unknown>;}
export interface SessionTitleCommitContext extends SessionMetadataContext,SessionTitleSnapshot {commandId:string;}
export interface SessionTitleWriteContext extends SessionTitleCommitContext {expectedTitleRevision:string;}
export interface SessionTitleCommitResult {applied:boolean;title?:string;titleRevision?:string;metadata?:Record<string,unknown>;}
export interface SessionMetadataAdapter {
  /** Passive metadata read; never starts an execution runtime or model. */
  readTitle(context:Readonly<SessionMetadataContext>):Promise<SessionTitleSnapshot>;
  /** Canonical metadata first. Unknown writes must not be automatically replayed. */
  writeTitle(context:Readonly<SessionTitleWriteContext>,input:Readonly<{title:string}>):Promise<SessionTitleCommitResult>;
}
export const SESSION_METADATA_KEY='amplifier.dev/sessionMetadata';
