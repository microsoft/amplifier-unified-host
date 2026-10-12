import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UpdateIntake} from '../src/update-intake.js';
const chunk=(text:string,meta?:any):any=>({sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text},...(meta?{_meta:meta}:{})}});
test('burst text is ordered and coalesced, callers settle after durable consumption',async()=>{
 const seen:any[]=[];let release!:()=>void;const held=new Promise<void>(r=>release=r);
 const intake=new UpdateIntake(async p=>{await held;seen.push(p);},()=>{});
 const inputs=Array.from({length:1000},(_,i)=>`${i}😀\n`);let settled=false;
 const done=Promise.all(inputs.map(s=>intake.enqueue(chunk(s)))).then(()=>settled=true);
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.ok(intake.count<10);
 release();await done;
 assert.equal(seen.map(p=>p.update.content.text).join(''),inputs.join(''));
 assert.equal(intake.count,0);assert.equal(intake.bytes,0);
});
test('message, provenance, reasoning and tool boundaries never merge',async()=>{
 const seen:any[]=[];const intake=new UpdateIntake(async p=>{seen.push(p);},()=>{});
 const a=chunk('one',{messageId:'1'}),b=chunk('two',{messageId:'2'}),tool:any={sessionId:'native',update:{sessionUpdate:'tool_call',toolCallId:'t',status:'pending'}};
 const reason=chunk('thought');reason.update.sessionUpdate='agent_thought_chunk';
 await Promise.all([a,b,tool,reason,chunk('three')].map(p=>intake.enqueue(p)));
 assert.deepEqual(seen,[a,b,tool,reason,chunk('three')]);assert.equal(a.update.content.text,'one');
});
test('queue limits reject without phantom work; failed durable consumption prevents later publication',async()=>{
 let release!:()=>void;const held=new Promise<void>(r=>release=r);const seen:any[]=[];
 const intake=new UpdateIntake(async p=>{await held;seen.push(p);throw Error('disk failure');},()=>{});
 const pending=[];
 for(let i=0;i<512;i++)pending.push(intake.enqueue(chunk('x',{messageId:i})).catch(e=>e.message));
 assert.throws(()=>intake.enqueue(chunk('overflow',{messageId:513})),/capacity/);
 assert.throws(()=>intake.enqueue(chunk('x'.repeat(9*1024*1024))),/capacity/);
 release();assert.ok((await Promise.all(pending)).every(v=>v==='disk failure'));assert.equal(seen.length,1);
 assert.equal(intake.count,0);assert.equal(intake.bytes,0);
});
test('different sessions and nontext properties do not coalesce',async()=>{
 const seen:any[]=[];const intake=new UpdateIntake(async p=>{seen.push(p);},()=>{});
 const a=chunk('one'),b=chunk('two');b.sessionId='other';
 const c=chunk('three');c.update.content.annotations={audience:['user']};
 await Promise.all([a,b,c].map(p=>intake.enqueue(p)));assert.equal(seen.length,3);
});
