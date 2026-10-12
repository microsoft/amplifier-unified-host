import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toolExecutionMetadata} from '../src/execution-metadata.js';

const metadata=(value:unknown)=>({'amplifier.dev/execution':value});
test('delegate headers omit unbounded bodies and cannot claim a different child session',()=>{
 const value={version:1,sessionId:'child',parentId:'worker:child',startedAt:12,endedAt:14,
  delegate:{id:'worker:child',sessionId:'child',label:'Reviewer',summary:'private report',
   routing:{selectionSource:'task',resolverActive:false,prompt:'private instructions'},control:{stop:true}},
  instructions:'private instructions'};
 assert.deepEqual(toolExecutionMetadata(metadata(value)),metadata({version:1,sessionId:'child',parentId:'worker:child',startedAt:12,endedAt:14,
  delegate:{id:'worker:child',sessionId:'child',label:'Reviewer',routing:{selectionSource:'task',resolverActive:false}}}));
 assert.deepEqual(toolExecutionMetadata(metadata({...value,delegate:{...value.delegate,sessionId:'other'}})),
  metadata({version:1,sessionId:'child',parentId:'worker:child',startedAt:12,endedAt:14}));
});
test('unknown versions and oversized headers never enter durable chat projection',()=>{
 assert.deepEqual(toolExecutionMetadata(undefined),{});
 assert.deepEqual(toolExecutionMetadata(metadata({version:2,sessionId:'child'})),{});
 assert.deepEqual(toolExecutionMetadata(metadata({version:1,sessionId:'child',summary:'x'.repeat(8192)})),{});
 assert.deepEqual(toolExecutionMetadata(metadata({version:1,sessionId:'child',startedAt:'12',endedAt:Infinity,
  delegate:{id:'worker:child',sessionId:'child',label:'x'.repeat(513),routing:[]}})),
  metadata({version:1,sessionId:'child',delegate:{id:'worker:child',sessionId:'child'}}));
});
