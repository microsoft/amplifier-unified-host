/** Exact negotiated native terminal failure, never a no-effect or retry grant. */
export interface NativeFailedInput {
  version:1;sessionId:string;inputId:string;status:'failed';terminal:true;noReplay:true;inputPersisted:true;
  effectBoundary:'unknown'|'input-persisted'|'provider-request'|'model-output'|'tool-effects';
  error:{type:string;message:string};
}
export function nativeFailedInput(error:unknown,capabilities:any,sessionId:string|undefined,inputId:string):NativeFailedInput|undefined {
  try {
    const native=capabilities?._meta?.['amplifier.dev/native'],grant=native?.inputOutcome;
    if(native?.version!==1||grant?.version!==1||grant.method!=='_amplifier/input/receipt'||grant.passive!==true||grant.durable!==true||!sessionId)return;
    const proof=(error as any)?.data?.['amplifier.dev/inputOutcome'];
    if(!proof||typeof proof!=='object'||Array.isArray(proof)||Buffer.byteLength(JSON.stringify(proof))>4096||Object.keys(proof).sort().join(',')!=='effectBoundary,error,inputId,inputPersisted,noReplay,sessionId,status,terminal,version')return;
    if(proof.version!==1||proof.sessionId!==sessionId||proof.inputId!==inputId||proof.status!=='failed'||proof.terminal!==true||proof.noReplay!==true||proof.inputPersisted!==true||!['unknown','input-persisted','provider-request','model-output','tool-effects'].includes(proof.effectBoundary))return;
    if(!proof.error||typeof proof.error!=='object'||Array.isArray(proof.error)||Object.keys(proof.error).sort().join(',')!=='message,type'||typeof proof.error.type!=='string'||!/^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(proof.error.type)||typeof proof.error.message!=='string'||!proof.error.message||[...proof.error.message].length>1000||/[\x00-\x1f]/.test(proof.error.message))return;
    return structuredClone(proof);
  }catch{return;}
}
