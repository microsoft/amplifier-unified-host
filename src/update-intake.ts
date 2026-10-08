import {isDeepStrictEqual} from 'node:util';
import {setImmediate as yieldToIO} from 'node:timers/promises';
import type {SessionNotification} from '@agentclientprotocol/sdk';

/** Ordered, bounded ACP projection intake. Only adjacent text with identical
 * provenance is combined. Completion means the consumer durably handled it. */
export class UpdateIntake {
  count=0;bytes=0;settled:Promise<void>=Promise.resolve();
  private tail?:{params:SessionNotification;bytes:number;promise:Promise<void>};
  constructor(private consume:(params:SessionNotification)=>Promise<void>,private changed:()=>void){}
  enqueue(params:SessionNotification):Promise<void> {
    const bytes=Buffer.byteLength(JSON.stringify(params)),tail=this.tail;
    if(this.bytes+bytes>8*1024*1024)throw Error('ACP update queue capacity exceeded; execution outcome requires reconciliation');
    if(tail&&tail.bytes+bytes<=64*1024&&compatible(tail.params,params)){
      (tail.params.update as any).content.text+=(params.update as any).content.text;
      tail.bytes+=bytes;this.bytes+=bytes;return tail.promise;
    }
    if(this.count>=512)throw Error('ACP update queue capacity exceeded; execution outcome requires reconciliation');
    const batch={params:structuredClone(params),bytes,promise:Promise.resolve()};
    this.count++;this.bytes+=bytes;
    // Yield between durable batches so other sessions, reads and cancellation
    // can run even when a peer emits an entire response in one burst.
    batch.promise=this.settled.then(async()=>{
      await yieldToIO();
      if(this.tail===batch)this.tail=undefined;
      await this.consume(batch.params);
    }).finally(()=>{if(this.tail===batch)this.tail=undefined;this.count--;this.bytes-=batch.bytes;this.changed();});
    this.tail=batch;this.settled=batch.promise;return batch.promise;
  }
}
function compatible(a:SessionNotification,b:SessionNotification):boolean {
  const x=a.update as any,y=b.update as any;
  if(!['agent_message_chunk','agent_thought_chunk'].includes(x.sessionUpdate)||x.sessionUpdate!==y.sessionUpdate||x.content?.type!=='text'||y.content?.type!=='text')return false;
  if(typeof x.content.text!=='string'||typeof y.content.text!=='string')return false;
  return isDeepStrictEqual({...a,update:{...x,content:{...x.content,text:''}}},{...b,update:{...y,content:{...y.content,text:''}}});
}
