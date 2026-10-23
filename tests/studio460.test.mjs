import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildCoverPrompt,normalizeCoverSettings,DEFAULT_COVER_TEMPLATE,LEGACY_COVER_TEMPLATE} from '../cover-prompt.mjs';
import {normalizePrompts,PROMPTS} from '../prompt-catalog.mjs';
import {createPackagingAI} from '../packaging-ai.mjs';
import {openStore,DEFAULT_SCHEME} from '../automation-store.mjs';
test('removed layers are ignored; required identity placeholders remain visible in saved base',()=>{
 const s=normalizeCoverSettings({coverTemplate:'CUSTOM',coverExtra:'EXTRA',coverLayout:'HIDDEN LAYOUT',coverMood:'HIDDEN MOOD',coverPrefix:'PREFIX',coverNegative:'NEGATIVE',promptTemplates:{coverScene:'HIDDEN SCENE',coverStyle:'STYLE'}});
 assert.equal(s.coverTemplate,'CUSTOM\n完整书名：{书名}\n作者署名：{笔名}\n画风：{画风}');
 for(const k of ['coverLayout','coverMood','coverPrefix','coverNegative'])assert.equal(s[k],undefined);
 assert.equal(s.promptTemplates.coverScene,undefined);assert.equal(s.promptTemplates.coverStyle,'STYLE');
 const p=buildCoverPrompt(s,{title:'长书名$&',penName:'笔名$&',style:'木刻'});assert.equal(p,'CUSTOM\n完整书名：长书名$&\n作者署名：笔名$&\n画风：木刻\nEXTRA');
 assert.equal(normalizeCoverSettings({coverTemplate:LEGACY_COVER_TEMPLATE}).coverTemplate,DEFAULT_COVER_TEMPLATE);
 assert.equal(normalizePrompts({coverScene:'discard',coverStyle:'keep'}).coverScene,undefined);assert.equal(PROMPTS.coverScene,undefined);
});
test('one editable style call drives cover with book-specific content and no scene request',async()=>{
 const requests=[];const ai=createPackagingAI({settings:{coverExtra:'CUSTOM EXTRA',promptTemplates:{coverStyle:'STYLE-CUSTOM {v0} {v1}',coverScene:'MUST NOT CALL'}},ask:async m=>{requests.push(m.at(-1).content);return '{"style":"木刻与冷暖色块，物件主导海报"}';}});
 const p=await ai.prompt('拾荒王', {summary:'主角用旧物救下整条街',characters:'年长修理工',conflict:'旧街改造',channel:'男频',novelType:['男频','都市','脑洞']},'IGNORED BATCH PROMPT','青禾');
 assert.equal(requests.length,1);assert.match(requests[0],/STYLE-CUSTOM 拾荒王/);assert.match(requests[0],/年长修理工/);assert.doesNotMatch(requests[0],/IGNORED BATCH|MUST NOT CALL/);
 for(const value of ['拾荒王','青禾','年长修理工','旧街改造','木刻与冷暖','CUSTOM EXTRA'])assert.ok(p.includes(value));assert.doesNotMatch(p,/本书画面/);
});
test('upgrade discards obsolete pending cover caches once but protects remote jobs and pauses',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cover-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'queue.json');
 const base={id:'local',stage:'cover',status:'attention',prompt:'OLD',cover:'old.png',intro:'keep',scheme:DEFAULT_SCHEME,artifacts:{package:'old.json'},history:[]};
 fs.writeFileSync(file,JSON.stringify({version:1,jobs:[base,{...base,id:'remote',remote:{sid:1}},{...base,id:'uncertain',uploadIntent:{at:'today'}}],schemes:[DEFAULT_SCHEME]}));
 const store=openStore(file);assert.equal(store.state.paused,true);const [local,remote,uncertain]=store.state.jobs;
 assert.equal(local.stage,'prompt');assert.equal(local.prompt,undefined);assert.equal(local.intro,'keep');assert.equal(remote.prompt,'OLD');assert.equal(uncertain.prompt,'OLD');
 local.prompt='NEW';store.save();assert.equal(openStore(file).state.jobs[0].prompt,'NEW');
});
