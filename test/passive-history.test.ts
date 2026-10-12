import test from 'node:test';
import assert from 'node:assert/strict';
import {retainPassiveInputs} from '../src/history.js';
const text=(id:string)=>({kind:'markdown',content:id,_meta:{'amplifier.dev/history':{messageId:id}}});
const notice=(id:string)=>({kind:'systemNotification',content:id,_meta:{'amplifier.dev/history':{messageId:id,inputOrigin:'peer',recordedOnly:true,peerEnvelope:{mode:'notify'}}}});
test('canonical passive inputs survive live recordings with exact public ordering and no duplicates',()=>{
 const before=text('before'),after=text('after'),one=notice('one'),two=notice('two'),last=notice('last');
 const tool={kind:'toolCall',toolCall:{toolCallId:'tool'}},liveTool={kind:'toolCall',toolCall:{toolCallId:'native:tool'}};
 const record={kind:'systemNotification',content:'',_meta:{'amplifier.dev/modelCall':{id:'call'}}};
 const canonical=[before,one,tool,two,after,last],live=[before,record,liveTool,after];
 const normalize=(id:string)=>id.replace(/^native:/,'');
 const result=retainPassiveInputs(canonical,live,normalize);
 assert.deepEqual(result,[before,record,one,liveTool,two,after,last]);
 assert.deepEqual(retainPassiveInputs(canonical,result,normalize),result);
 assert.deepEqual(live,[before,record,liveTool,after]);
});
