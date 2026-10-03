/** Trusted embedding identity. Wire arguments cannot assert this context. */
export interface PresentationActor {actorId:string;origin:'ui'|'agent';session?:string;}
export interface PresentationIdentity {session:string;engineId:string;nativeSessionId:string;workingDirectory:string;}
export interface PresentationPrepare {
 commandId:string;operation:'reset'|'restore';selection:{kind:'explicit';sessionIds:string[]};
 expectedRevision:number;resetCommandId?:string;
}
export interface PresentationMaintenance {fenceId:string;commandId:string;}
export interface PresentationApply {
 commandId:string;reviewId:string;reviewHash:string;
 /** Actual held host recovery fence, supplied inside its trusted maintenance callback. */
 maintenance:PresentationMaintenance;
}
export interface PresentationProtectionContext {
 commandId:string;reviewId:string;reviewHash:string;operation:'reset'|'restore';
 selectionHash:string;expectedRevision:number;maintenance:PresentationMaintenance;
 /** Exact already-held recovery participant census. No new global acquisition. */
 ownerIds:ReadonlyArray<string>;sessions:ReadonlyArray<Readonly<PresentationIdentity>>;
}
export interface PresentationProtectedReference {session:string;ownerId:string;reasons:string[];}
/** Selected reference inspection derived from the already-held recovery leases. */
export interface PresentationProtectionLease {
 leaseId:string;hostFenceId:string;selectionHash:string;ownerIds:string[];
 coverage:'complete';protected:PresentationProtectedReference[];
 /** Consult the exact passive host effect receipt. Unknown retains the selected hold. */
 release():Promise<void>;
}
export interface ConversationPresentationProtection {
 presentationReset:{version:1;preservesCanonical:true;preservesAuthority:true};
 acquire(context:Readonly<PresentationProtectionContext>):Promise<PresentationProtectionLease>;
 /** Observe original host effect + projection readiness; never repeat reset/restore. */
 reconcile(context:Readonly<PresentationProtectionContext>&{leaseId:string}):Promise<void>;
}
export interface PresentationEffectReceipt {
 commandId:string;operation:'reset'|'restore';part:'conversation-presentation';
 reviewId:string;reviewHash:string;selectionHash:string;count:number;
 previousRevision:number;revision?:number;
 status:'completed'|'refused'|'unknown';executed?:false;
 preservesCanonical:true;preservesAuthority:true;
 catalog?:{source:string;revision:number;ready:boolean};reason?:string;
}
export interface PresentationReceipt {
 commandId:string;effect:PresentationEffectReceipt;
 protection:'held'|'released'|'unknown';leaseId?:string;
}
export interface PresentationReviewPage {
 reviewId:string;reviewHash:string;commandId:string;operation:'reset'|'restore';
 /** expiresAt is Unix milliseconds. */
 selectionHash:string;count:number;bytes:number;expiresAt:number;expectedRevision:number;resetCommandId?:string;
 preservesCanonical:true;preservesAuthority:true;eligibility:'requires-held-validation';
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
export interface PresentationRebuild {commandId:string;expectedRevision:number;maintenance:PresentationMaintenance;}
/** Private metadata only; never includes native transcript/event bodies. */
export interface PresentationMappingPage {items:ReadonlyArray<Record<string,unknown>>;count:number;manifestHash:string;nextCursor:string|null;}
export interface ConversationPresentationConfig {
 protection:ConversationPresentationProtection;
 /** Owns scan/hint scheduling. Seed exact mappings BEFORE explicit complete native discovery. */
 reconstructMetadata?:(request:{commandId:string;source:string;readMappings:(cursor?:string)=>PresentationMappingPage})=>Promise<void>;
}
