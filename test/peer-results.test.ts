import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {peerTerminal} from '../src/peer-results.js';
const capability={version:1,checkpointed:true};
const proof={version:1,rootSessionId:'native-root',generationId:'generation',inputIds:['peer:one'],messageId:'native:answer',sourceRevision:'revision',textDigest:createHash('sha256').update('Saved answer').digest('hex')};
const event={type:'generation.finished',sessionId:'native-root',rootSessionId:'native-root',generation_id:'generation',input_ids:['peer:one'],active_job_ids:[],disposition:'manager_turn_finished',text:'Saved answer',peerTerminal:proof};
test('only negotiated exact native terminal evidence is admitted',()=>{
 assert.deepEqual(peerTerminal(event,'native-root','generation',capability),proof);
 assert.equal(peerTerminal(event,'native-root','generation',undefined),undefined);
 for(const patch of [{type:'generation.failed'},{sessionId:'child'},{rootSessionId:'other'},{generation_id:'other'},{input_ids:[]},{active_job_ids:['still-running']},{text:'changed'},{peerTerminal:{...proof,inputIds:['peer:one','peer:one']}},{peerTerminal:{...proof,sourceRevision:''}}])assert.equal(peerTerminal({...event,...patch},'native-root','generation',capability),undefined);
});
