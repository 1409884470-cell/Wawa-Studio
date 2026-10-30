import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {buildCoverPrompt,inferCoverStyle} from '../cover-prompt.mjs';
test('cover template substitutes metadata and fixed requirements without legacy additions',()=>{
 const prompt=buildCoverPrompt({coverTemplate:'{书名} / {笔名} / {男女频} / {题材} / {画风}',coverPrefix:'旧的复杂背景'},{title:'测试书名',penName:'作者',channel:'女频',genre:'喜剧',style:inferCoverStyle('搞笑故事')});
 assert.match(prompt,/测试书名 \/ 作者 \/ 女频 \/ 喜剧 \/ 轻松搞笑/);assert.doesNotMatch(prompt,/人物占画面80%/);assert.doesNotMatch(prompt,/除书名和笔名外不添加文字/);assert.doesNotMatch(prompt,/七猫风格/);assert.doesNotMatch(prompt,/旧的复杂背景/);assert.match(inferCoverStyle('小孩冒险'),/卡通/);
});
test('automatic site operations launch headless',async()=>{
 const source=fs.readFileSync(new URL('../main.mjs',import.meta.url),'utf8');let selected;
 const context=vm.createContext({platformLoginRequired:false,manualLoginOpen:false,siteTail:Promise.resolve(),busy:false,revBusy:false,automationSiteBusy:false,getRunner:async headless=>{selected=headless;return{ensureLogin:async()=>{}};},send:()=>{}});
 vm.runInContext(source.slice(source.indexOf('async function withAutomationSite('),source.indexOf('function getAutomation()')),context);
 await context.withAutomationSite(async()=>{});assert.equal(selected,true);
});
