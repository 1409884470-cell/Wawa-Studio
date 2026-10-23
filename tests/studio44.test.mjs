import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPackagingAI} from '../packaging-ai.mjs';
import {COVER_FIXED} from '../cover-prompt.mjs';
test('content-specific cover scene, user mood and extra are all passed into the image request',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cover44-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const seen=[];let payload;const ai=createPackagingAI({coverDir:dir,settings:{coverTemplate:'书名：{书名} 笔名：{笔名} 画风：{画风}',coverMood:'明亮，不要阴暗',coverExtra:'简洁背景',promptTemplates:{coverStyle:'STYLE {v1}',coverScene:'SCENE {v0} {v1} {v2} {v3}'},imgApiBaseUrl:'https://test.invalid',imgApiKey:'test',imageModel:'image'},ask:async m=>{seen.push(m.at(-1).content);return JSON.stringify(seen.at(-1).startsWith('STYLE')?{style:'暖色插画'}:{scene:'林舟拆开祖父的来信，窗边一只铜铃'});},fetcher:async(u,o)=>{payload=JSON.parse(o.body);return {ok:true,json:async()=>({data:[]})};}});
 const prompt=await ai.prompt('祖父的来信',{summary:'林舟收到祖父来信，铜铃成为线索',channel:'男频',novelType:['男频','都市','都市脑洞']},'自然光','青禾');
 assert.ok(!prompt.includes(COVER_FIXED));assert.doesNotMatch(prompt,/本书画面|不要阴暗/);assert.ok(prompt.endsWith('简洁背景'));assert.equal(seen.length,1);assert.match(seen[0],/祖父来信/);
 await assert.rejects(ai.cover(prompt,'1024x1536','test'),/未返回图片/);assert.equal(payload.prompt,prompt);
});
