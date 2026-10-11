import test from 'node:test';import assert from 'node:assert/strict';
import {samePublicResponseOrder} from '../src/history.js';
const tool=(id:string,batch?:string)=>({kind:'toolCall',toolCall:{toolCallId:id},...(batch?{_meta:{'amplifier.dev/history':{messageId:batch}}}:{})});
const text={kind:'markdown',content:'Visible progress'};
test('saved call batches allow concurrent starts but not text, steering or later-call reordering',()=>{
 const saved=[tool('a','first'),tool('b','first'),text,tool('c','second')],normalize=(id:string)=>id.replace(/^root:/,'');
 assert.equal(samePublicResponseOrder(saved,[tool('root:b'),tool('child:observed'),tool('root:a'),text,tool('root:c')],normalize),true);
 for(const observed of [[tool('root:a'),text,tool('root:b'),tool('root:c')],[tool('root:c'),tool('root:a'),tool('root:b'),text],[tool('root:a'),tool('root:a'),text,tool('root:c')],[tool('root:a'),text,tool('root:c')]])assert.equal(samePublicResponseOrder(saved,observed,normalize),false);
 const input={kind:'systemNotification',_meta:{'amplifier.dev/history':{nativeInput:{kind:'steer',id:'correction'}}}};
 assert.equal(samePublicResponseOrder([tool('a','first'),input,tool('b','first')],[tool('root:a'),tool('root:b'),input],normalize),false);
 assert.equal(samePublicResponseOrder([tool('a'),tool('b')],[tool('root:b'),tool('root:a')],normalize),false);
});
