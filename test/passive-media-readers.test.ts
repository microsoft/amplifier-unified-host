import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassiveMediaReaders} from '../src/passive-media-readers.js';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('media reads reuse transports but run every proof and retire after idle',async()=>{
 let opened=0,retired=0,proofs=0;
 const readers=new PassiveMediaReaders(async key=>({key,number:++opened}),async()=>{retired++;},10);
 const values=await Promise.all(Array.from({length:8},()=>readers.use('one',async reader=>{proofs++;return reader.number;})));
 assert.deepEqual(values,Array(8).fill(1));assert.equal(proofs,8);assert.equal(readers.size,1);
 await pause(30);assert.equal(readers.size,0);assert.equal(retired,1);
 assert.equal(await readers.use('one',async reader=>reader.number),2);await readers.close();assert.equal(retired,2);
 await assert.rejects(readers.use('one',async()=>{}),/closed/);
});
test('scope and pending-work limits are enforced while close drains admitted reads',async()=>{
 let release!:()=>void,retired=0,active=0,peak=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const readers=new PassiveMediaReaders(async key=>key,async()=>{retired++;},1000);
 const first=readers.use('one',async()=>{active++;peak=Math.max(peak,active);await gate;active--;});
 const waiting=Array.from({length:19},()=>readers.use('one',async()=>{active++;peak=Math.max(peak,active);active--;}));
 await assert.rejects(readers.use('one',async()=>{}),/queue capacity/);
 await readers.use('two',async()=>{});await assert.rejects(readers.use('three',async()=>{}),/capacity/);
 release();await Promise.all([first,...waiting]);await readers.close();assert.equal(peak,1);assert.equal(retired,2);assert.equal(readers.size,0);
});
test('a rejected proof does not become a cached success for a later read',async()=>{
 let valid=false,proofs=0,opened=0;
 const readers=new PassiveMediaReaders(async()=>++opened,async()=>{},1000);
 const read=()=>readers.use('one',async()=>{proofs++;if(!valid)throw Error('History changed');return 'verified';});
 await assert.rejects(read(),/History changed/);valid=true;assert.equal(await read(),'verified');valid=false;await assert.rejects(read(),/History changed/);
 assert.equal(opened,1);assert.equal(proofs,3);await readers.close();
});
test('shutdown waits for the executing proof and rejects queued reads before retiring',async()=>{
 let release!:()=>void,started!:()=>void,retired=0,queuedRan=false;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const running=new Promise<void>(resolve=>{started=resolve;});
 const readers=new PassiveMediaReaders(async()=>1,async()=>{retired++;});
 const first=readers.use('one',async()=>{started();await gate;return 'done';});
 await running;
 const queued=assert.rejects(readers.use('one',async()=>{queuedRan=true;}),/closed/);
 const closing=readers.close();
 assert.equal(retired,0);release();assert.equal(await first,'done');
 await queued;await closing;assert.equal(queuedRan,false);assert.equal(retired,1);assert.equal(readers.size,0);
});
