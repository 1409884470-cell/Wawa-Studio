import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCoverText,createPackagingAI} from '../packaging-ai.mjs';
const scene='主角撑起蓝伞跑过石桥，远处两只白鹭飞起，清亮水彩，书名留白。';
test('cover accepts long custom descriptions without silently truncating',()=>{
 const long=scene.repeat(30);assert.ok(long.length>600);assert.equal(parseCoverText(JSON.stringify({scene:long})),long);
 assert.equal(parseCoverText(JSON.stringify({scene:' ' .repeat(700)+scene})),scene);
});
test('cover accepts JSON aliases, nested wrappers, strings and plain descriptive text',()=>{
 for(const v of [{scene},{prompt:scene},{cover_prompt:scene},{description:scene},{画面描述:scene},{data:{scene}},{scene:{description:scene}},{scene:'',prompt:scene},scene])assert.equal(parseCoverText(JSON.stringify(v)),scene);
 assert.equal(parseCoverText(scene),scene);
 assert.equal(parseCoverText('```json\n'+JSON.stringify({scene})+'\n```'),scene);
 assert.equal(parseCoverText('<think>内部推理</think>'+JSON.stringify({scene})),scene);
 assert.equal(parseCoverText('说明：'+JSON.stringify({scene})),scene);
});
test('cover rejects blank, incomplete, unknown and error JSON instead of drawing it',()=>{
 for(const raw of ['', '  ', '{}','{"scene":""}','{"scene":123}','{"analysis":"仅分析"}','{"error":"failure","prompt":"error body"}','{"scene":"截断','["方案一","方案二"]','<think>未完成'])assert.throws(()=>parseCoverText(raw));
 assert.throws(()=>parseCoverText(JSON.stringify({style:'长'.repeat(6001)}),'style'),/6001.*1000/);
});
const analysis={summary:'主角赶往石桥送信',channel:'男频',novelType:['男频','都市','都市脑洞']};
function setup(responses){
 const calls=[],usage=[];let n=0;
 const ai=createPackagingAI({settings:{coverExtra:'不得阴暗',promptTemplates:{coverStyle:'STYLE 自定义蓝伞与白鹭 {v0}',coverScene:'SCENE 自定义蓝伞与白鹭 {v0}'}},coverDir:'unused',onPrompt:(k,p)=>usage.push({k,p}),ask:async messages=>{const text=messages.at(-1).content;calls.push(text);return responses[n++];}});
 return {ai,calls,usage};
}
test('invalid scene is repaired automatically with original instructions, result and feedback',async()=>{
 const f=setup(['{"wrong":"字段错误"}',JSON.stringify({style:scene})]);const p=await f.ai.prompt('石桥来信',analysis,'清亮','青禾');
 assert.match(p,/画风：主角撑起蓝伞/);assert.match(p,/青禾/);assert.match(p,/不得阴暗/);
 assert.equal(f.calls.length,2);assert.match(f.calls[1],/自定义蓝伞与白鹭 石桥来信/);assert.match(f.calls[1],/上次结果未通过校验/);
 assert.equal(f.usage.at(-1).p,f.calls.at(-1));
});
test('overlong scene is retried for condensation; no clipped sentence is sent',async()=>{
 const f=setup([JSON.stringify({style:'长'.repeat(6001)}),JSON.stringify({style:scene})]);const p=await f.ai.prompt('石桥来信',analysis,'清亮','青禾');assert.match(f.calls[1],/6001个字符/);assert.ok(p.includes(scene));assert.ok(!p.includes('长长长'));
});
test('scene repair stops after three calls and reports the specific failure',async()=>{
 const f=setup(['{}','{}','{}']);await assert.rejects(f.ai.prompt('石桥来信',analysis,'清亮','青禾'),/自动整理三次仍无效.*style/);assert.equal(f.calls.length,3);
});
test('network errors are left to the queue retry policy without extra scene calls',async()=>{
 let n=0;const ai=createPackagingAI({settings:{},coverDir:'unused',ask:async()=>{n++;throw Error('HTTP 503');}});
 await assert.rejects(ai.prompt('石桥',analysis,'','作者'),/HTTP 503/);assert.equal(n,1);
});
