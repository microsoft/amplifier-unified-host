import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeEventIntake} from '../src/native-event-intake.js';

test('wire admission waits for preceding events but not future events',async()=>{
  const intake=new NativeEventIntake(),first={},second={};
  intake.observe(first);let done=false;
  const joined=intake.drain().then(()=>{done=true;});
  await Promise.resolve();assert.equal(done,false);
  intake.observe(second);intake.admit(first);await joined;
  assert.equal(done,true);intake.admit(second);await intake.drain();
});
test('ordinary ACP with no native events needs no barrier',async()=>{
  await new NativeEventIntake().drain();
});
test('missing, invalid and closed callback admissions cannot claim completion',async()=>{
  for(const mode of ['missing','invalid','closed']){
    const intake=new NativeEventIntake();intake.observe({});
    if(mode==='invalid')intake.admit({});
    if(mode==='closed')intake.closed();
    // Keep a referenced deadline while the production timeout remains unrefed.
    const keep=setTimeout(()=>{},1000);
    try{await assert.rejects(intake.drain(5),/admission|closed/);await assert.rejects(intake.drain());}
    finally{clearTimeout(keep);}
  }
});
test('native admission is bounded by count and bytes',async()=>{
  const count=new NativeEventIntake();for(let i=0;i<512;i++)count.observe({});
  assert.throws(()=>count.observe({}),/capacity/);await assert.rejects(count.drain(),/capacity/);
  const bytes=new NativeEventIntake();assert.throws(()=>bytes.observe({text:'x'.repeat(8*1024*1024)}),/capacity/);
  await assert.rejects(bytes.drain(),/capacity/);
});
