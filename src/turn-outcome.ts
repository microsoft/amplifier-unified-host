/** A completed turn's last public answer, never a concatenation of progress.
 * Native message identity wins when available; tools and steering delimit
 * answer segments for other ACP agents. Model-call diagnostics are not speech.
 */
export function turnOutcome(parts:ReadonlyArray<any>,completed:boolean):{text:string;responseId?:string} {
  if(!completed)return {text:''};
  let answer:string[]=[],messageId:string|undefined,responseId:string|undefined;
  for(const part of parts){
    if(part._meta?.['amplifier.dev/modelCall'])continue;
    if(part.kind==='toolCall'||part._meta?.['amplifier.dev/steering']||part._meta?.['amplifier.dev/history']?.inputOrigin==='steering'){
      answer=[];messageId=undefined;responseId=undefined;continue;
    }
    if(part.kind!=='markdown')continue;
    const id=part._meta?.['amplifier.dev/history']?.messageId;
    if(id&&messageId&&id!==messageId)answer=[];
    if(id)messageId=id;
    responseId=id??part.id;
    const text=typeof part.content==='string'?part.content:part.content?.value;
    if(typeof text==='string')answer.push(text);
  }
  return {text:answer.join('\n').slice(0,50000),...(responseId?{responseId}:{})};
}
