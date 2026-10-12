import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {exportObservations} from '../src/export-observations.js';
function database(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE turns(chat TEXT,turn_id TEXT,payload TEXT,ordinal INTEGER PRIMARY KEY)');return db;}
test('export reads scalar work facts and deduplicates model updates without carrying bodies or source paths',async()=>{
 const db=database();try{
  db.prepare('INSERT INTO turns VALUES(?,?,?,?)').run('chat','turn',JSON.stringify({state:'complete',duration:1250,message:{text:'SECRET prompt'},responseParts:[{kind:'toolCall',toolCall:{toolCallId:'tool',input:'SECRET input',output:'SECRET output'}},{kind:'markdown',content:'SECRET reasoning',_meta:{'amplifier.dev/modelCall':{id:'model'}}},{kind:'markdown',_meta:{'amplifier.dev/modelCall':{id:'model'}}}]}),1);
  db.prepare('INSERT INTO turns VALUES(?,?,?,?)').run('other','other',JSON.stringify({state:'error'}),2);
  const calls:any[]=[],cap={manifest:{topics:{canvas:{version:1,uri:'amplifier-capability://canvas'}}},read:async(p:any)=>{calls.push(p);return {topic:'canvas',scope:'session',revision:1,data:{canvasArtifacts:[{id:'artifact',sessionId:'session',title:'Report',kind:'markdown',messageId:'turn',path:'SECRET path',bodyUri:'SECRET body'}],canvasPage:{}}}}};
  const result=await exportObservations(db,'chat','session',true,cap);
  assert.deepEqual(result.work,[{anchor:'turn',status:'completed',toolCalls:1,modelCalls:1,durationSeconds:1.25}]);
  assert.deepEqual(result.artifacts,[{id:'artifact',title:'Report',kind:'markdown',messageId:'turn'}]);
  assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(calls.length,1);assert.equal(calls[0].scope,'session');
  assert.deepEqual((await exportObservations(db,'chat','session',false)).work,[]);
 }finally{db.close();}
});
test('changed, wrong-session and repeated-cursor artifact pages are explicitly unavailable, never partial success',async()=>{
 const db=database();try{for(const fault of ['revision','session','cursor']){
  let page=0;const cap={manifest:{topics:{canvas:{version:1,uri:'amplifier-capability://canvas'}}},read:async()=>({topic:'canvas',scope:fault==='session'?'other':'session',revision:fault==='revision'?++page:1,data:{canvasArtifacts:fault==='cursor'?[]:[{id:'item'+page,sessionId:'session',title:'Report',kind:'markdown'}],canvasPage:{nextCursor:'same'}}})};
  const result=await exportObservations(db,'chat','session',false,cap);assert.deepEqual(result.artifacts,[]);assert.deepEqual(result.omissions,['artifact_references_unavailable']);
 }}finally{db.close();}
});
test('large retained histories disclose bounded work coverage instead of hydrating all transcript bodies',async()=>{
 const db=database();try{const put=db.prepare('INSERT INTO turns VALUES(?,?,?,?)');for(let i=0;i<1002;i++)put.run('chat','turn'+i,JSON.stringify({state:'unknown',responseParts:[]}),i);
  const result=await exportObservations(db,'chat','session',true);assert.equal(result.work.length,1000);assert.equal(result.work[0].anchor,'turn2');assert.ok(result.omissions.includes('older_host_work_summaries_exceed_export_limit'));
 }finally{db.close();}
});
