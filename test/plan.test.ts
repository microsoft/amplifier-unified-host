import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planPart} from '../src/plan.js';
import {chatReducer} from '@microsoft/agent-host-protocol';
test('ACP plan remains typed after official AHP reduction and reload serialization',()=>{
 const part=planPart({entries:[{content:'Review',status:'in_progress',priority:'high',_meta:{'amplifier.dev/todo':{activeForm:'Reviewing'}}}]});
 let state:any=chatReducer({resource:'ahp-chat:/plan',turns:[],status:0} as any,{type:'chat/turnStarted',turnId:'t',startedAt:new Date().toISOString(),message:{text:'Start',origin:{kind:'user'}}} as any);
 state=chatReducer(state,{type:'chat/responsePart',turnId:'t',part} as any);
 state=chatReducer(state,{type:'chat/turnComplete',turnId:'t',duration:10} as any);
 const saved=JSON.parse(JSON.stringify(state));
 assert.deepEqual(saved.turns[0].responseParts[0]._meta,part._meta);
 assert.equal(saved.turns.length,1);assert.equal(saved.turns[0].message.text,'Start');
});
test('empty snapshot clears, unreadable latest and oversized data are explicit',()=>{
 assert.deepEqual(planPart({entries:[]})._meta['amplifier.dev/acp'].plan,{version:1,entries:[]});
 for(const update of [{entries:[],_meta:{'amplifier.dev/todo':{unavailable:true}}},{entries:[{content:'bad',status:'made_up',priority:'low'}]},{entries:new Array(201).fill({content:'x',status:'pending',priority:'low'})},{entries:[{content:'x'.repeat(4001),status:'pending',priority:'low'}]}]){
  const plan=planPart(update)._meta['amplifier.dev/acp'].plan;assert.equal(plan.unavailable,true);assert.deepEqual(plan.entries,[]);
 }
});
