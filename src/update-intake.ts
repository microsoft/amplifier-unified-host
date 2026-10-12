import {isDeepStrictEqual} from 'node:util';
import {setImmediate as yieldToIO} from 'node:timers/promises';
import type {SessionNotification} from '@agentclientprotocol/sdk';

/** Ordered, bounded ACP projection intake. Only adjacent text with identical
 * provenance is combined. Completion means the consumer durably handled it. */
export class UpdateIntake<T extends object = SessionNotification> {
  count=0;bytes=0;settled:Promise<void>=Promise.resolve();
  private tail?:{params:T;bytes:number;promise:Promise<void>};
  constructor(private consume:(params:T)=>Promise<void>,private changed:()=>void,private merge:(a:T,b:T)=>boolean=coalesceSessionUpdates){}
  enqueue(params:T):Promise<void> {
    const bytes=Buffer.byteLength(JSON.stringify(params)),tail=this.tail;
    if(this.bytes+bytes>8*1024*1024)throw Error('ACP update queue capacity exceeded; execution outcome requires reconciliation');
    if(tail&&tail.bytes+bytes<=64*1024&&this.merge(tail.params,params)){
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
export function coalesceSessionUpdates(a:object,b:object):boolean {
  const x=(a as any).update,y=(b as any).update;
  if(!x||!y)return false;
  if(!['agent_message_chunk','agent_thought_chunk'].includes(x.sessionUpdate)||x.sessionUpdate!==y.sessionUpdate||x.content?.type!=='text'||y.content?.type!=='text')return false;
  if(typeof x.content.text!=='string'||typeof y.content.text!=='string')return false;
  if(!isDeepStrictEqual({...a,update:{...x,content:{...x.content,text:''}}},{...b,update:{...y,content:{...y.content,text:''}}}))return false;
  x.content.text+=y.content.text;return true;
}
