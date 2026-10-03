/** Trusted embedding identity. Wire arguments cannot assert this context. */
export interface PresentationActor {actorId:string;origin:'ui'|'agent';session?:string;}
export interface PresentationIdentity {session:string;engineId:string;nativeSessionId:string;workingDirectory:string;}
export interface PresentationPrepare {
 commandId:string;operation:'reset'|'restore';selection:{kind:'explicit';sessionIds:string[]};
 resetCommandId?:string;
}
/** No caller fence or owner proof: only the host's selected admission locks protect this transaction. */
export interface PresentationApply {commandId:string;reviewId:string;reviewHash:string;}
export interface PresentationEffectReceipt {
 commandId:string;operation:'reset'|'restore';part:'conversation-presentation';
 reviewId:string;reviewHash:string;selectionHash:string;count:number;
 previousRevision:number;revision?:number;
 status:'completed'|'refused'|'unknown';executed?:false;
 preservesCanonical:true;preservesAuthority:true;
 reason?:string;
}
export interface PresentationReceipt {
 commandId:string;effect:PresentationEffectReceipt;
 projection:{status:'pending'|'ready'|'unknown';source:string;revision?:number};
}
export interface PresentationReviewPage {
 reviewId:string;reviewHash:string;commandId:string;operation:'reset'|'restore';
 /** expiresAt is Unix milliseconds. */
 selectionHash:string;count:number;bytes:number;expiresAt:number;observedRevision:number;resetCommandId?:string;
 preservesCanonical:true;preservesAuthority:true;eligibility:'requires-selected-validation';
 items:Array<{session:string;title:string;priorHidden:boolean;targetHidden:boolean}>;nextCursor:string|null;
}
export interface VisibilityProjectionRequest {
 source:string;commandId:string;afterRevision:number;throughRevision:number;
 items:Array<{uri:string;hidden:boolean;revision:number}>;
}
export interface VisibilityProjectionReceipt {source:string;commandId:string;revision:number;projected:number;}
export interface PresentationReadiness {
 enabled:boolean;ready:boolean;revision:number;source?:string;projectionRevision?:number;
 phase:'disabled'|'checking'|'ready'|'applying'|'unknown'|'rebuilding';reason?:string;
}
export interface PresentationRebuild {commandId:string;expectedRevision:number;}
/** Private metadata only; never includes native transcript/event bodies. */
export interface PresentationMappingPage {items:ReadonlyArray<Record<string,unknown>>;count:number;manifestHash:string;nextCursor:string|null;}
/** Private callback context: a derived hint, never a native execution command. */
export interface CatalogDiscoveryAttempt {attemptId:string;sessionDirectory:string;}
/** Trusted catalog owner must retain real response/exit evidence for this exact attempt. */
export interface CatalogDiscoverySettlement {attemptId:string;evidence:'response-settled'|'process-exited';ownerReceipt:string;}
export interface ConversationPresentationConfig {
 /** Optional recovery for a hint interrupted by host loss or an unclassified adapter failure.
  * A new catalog process alone does not prove the old writer stopped. No wire caller supplies this proof. */
 settleDiscovery?:(attempt:CatalogDiscoveryAttempt)=>Promise<CatalogDiscoverySettlement>;
 /** Owns scan/hint scheduling. Seed exact mappings BEFORE explicit complete native discovery. */
 reconstructMetadata?:(request:{commandId:string;source:string;readMappings:(cursor?:string)=>PresentationMappingPage})=>Promise<void>;
}
