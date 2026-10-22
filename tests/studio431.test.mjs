import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAIObject,createPackagingAI} from '../packaging-ai.mjs';
import {cleanManuscript} from '../manuscript-cleaner.mjs';
test('JSON wrappers and reasoning are stripped without changing string contents',()=>{
 assert.deepEqual(parseAIObject('<think>reason {x}</think>说明：\n```json\n{"intro":"正文 {转折} \\"引语\\""}\n```'.replaceAll('\\\\"','\\"')),{intro:'正文 {转折} "引语"'});
 assert.throws(()=>parseAIObject('{"intro":"cut off'));
 assert.throws(()=>parseAIObject('[1,2,3]'));
});
test('invalid JSON retries automatically and stops at three calls',async()=>{
 let calls=0;
 const ai=createPackagingAI({settings:{},ask:async()=>++calls<3?'invalid':JSON.stringify({intro:'这是一段完整的小说简介，主角寻找线索并最终揭开谜底。'})});
 assert.ok(await ai.intro('书名',{},''));assert.equal(calls,3);
 calls=0;const bad=createPackagingAI({settings:{},ask:async()=>{calls++;return '{"intro":';}});
 await assert.rejects(bad.intro('书名',{},''),/连续三次/);assert.equal(calls,3);
});
test('keyword prose stays intact while definite AI chatter is filtered',()=>{
 const prose='他看见系统提示，打开人工智能模型写下大纲。'.repeat(10);
 const result=cleanManuscript({text:'第一章 起点\n以下是为您生成的小说内容：\n'+prose+'\n本章完'});
 assert.equal(result.chapters[0].text,prose);assert.equal(result.warnings.length,0);assert.ok(result.notices.length);assert.equal(result.version,2);
 const bad=cleanManuscript({text:'第一章 起点\n'+prose+'\n第一章 起点\n'+prose});assert.ok(bad.warnings.some(x=>x.includes('重复')));
});
