/** Trusted owner requests still bind every recipient and generation revision. */
export type PeerSteeringInput = {
  commandId:string; grantId:string; text:string; peerEnvelope:Record<string,any>;
  taskId:string|null; taskRevision:number|null; activeTurnId:string; targetGenerationId:string;
  expectedExecutionRevision:number; expectedInterruptionRevision:number;
  expectedConfigurationHash:string; expectedNativeSessionId:string; expectedNativeLocationRevision:number;
};
export function validatePeerSteering(input:PeerSteeringInput) {
  if(!input || !['commandId','grantId','activeTurnId','targetGenerationId','expectedNativeSessionId'].every(key=>{
    const value=input[key as keyof PeerSteeringInput];return typeof value==='string'&&value.length>0&&value.length<=(key==='grantId'?200:128);
  }) || typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>32000
    ||!input.peerEnvelope||input.peerEnvelope.requestId!==input.commandId||input.peerEnvelope.grantId!==input.grantId||input.peerEnvelope.mode!=='steer'
    ||Buffer.byteLength(JSON.stringify(input.peerEnvelope))>12000
    ||![input.expectedExecutionRevision,input.expectedInterruptionRevision,input.expectedNativeLocationRevision].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||typeof input.expectedConfigurationHash!=='string')throw Error('Bounded saved peer steering and exact recipient revisions required');
}
