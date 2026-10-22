import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutomationQueue, accountKey } from '../automation-engine.mjs';
import { openStore, DEFAULT_SCHEME, archiveManuscript, atomicJSON } from '../automation-store.mjs';
import { titleScore, createPackagingAI } from '../packaging-ai.mjs';
import { auditManuscript, extractChaptersFromText, parseNovelFile } from '../auto.mjs';
import { cleanManuscript, effectiveWords } from '../manuscript-cleaner.mjs';
import { initialPlan, rejectionKind } from '../submission-policy.mjs';
import { allPages } from '../pagination.mjs';
import { validateConfig, loadSiteData } from '../core.mjs';
import { runSubmission } from '../submission-engine.mjs';

const site = { tree: { 男频: { 都市: ['都市生活'] } }, tags: ['悬疑','脑洞'], entries: ['普通投稿','科幻征文'] };
const analysis = { summary:'主角调查失踪案，发现未来来信，最后解开秘密并回归生活。',characters:'主角',conflict:'寻找真相',themes:['悬疑'],visual:'雨夜街道',
  channel:'男频',novelType:['男频','都市','都市生活'],tags:['悬疑'],storyType:'long',finished:'finished',confidence:90,reason:'案件结构明确' };
const fixtureSettings = { penName:'测试作者',apiBaseUrl:'https://text.invalid/v1',apiKey:'fake-text-key',textModel:'fake-text',
  imgApiBaseUrl:'https://image.invalid/v1',imgApiKey:'fake-image-key',imageModel:'fake-image' };

test('global concurrency refills a freed slot without waiting for the slowest book',async t=>{
 const f=setup(t,{settings:{submissionConcurrency:2}}),q=f.queue;let releaseSlow,thirdStarted;
 const slow=new Promise(r=>releaseSlow=r),third=new Promise(r=>thirdStarted=r);let active=0,peak=0;
 q.store.state.jobs=[1,2,3].map(n=>({id:String(n),status:'queued',scheme:{concurrency:1}}));
 q.run=async j=>{q.active.add(j.id);j.status='running';peak=Math.max(peak,++active);if(j.id==='1')await slow;else if(j.id==='3')thirdStarted();active--;j.status='done';q.active.delete(j.id);};
 q.store.state.paused=false;const drain=q.pump();let timer;
 try{await Promise.race([third,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('freed slot remained idle')),1000))]);assert.equal(q.job('1').status,'running');}
 finally{clearTimeout(timer);releaseSlow();await drain;}
 assert.equal(peak,2);
});

test('writer-provided source title is authoritative on import and restart; uploaded titles cannot be repaired locally',async t=>{
 const f=setup(t,{text:'书名：正文里的无关书名\n简介：这是一段规划简介，并不是投稿文案。\n第一章 开始\n'+'主角开始追查失踪案件。'.repeat(80)});
 await f.queue.import([f.source],{...DEFAULT_SCHEME,autoStart:false},{title:'真实写作项目名',writerId:'book1'});
 const j=f.queue.store.state.jobs[0];assert.equal(j.title,'真实写作项目名');assert.equal(j.writerId,'book1');
 assert.equal(j.sourceIntro,'');
 f.queue.control(j.id,'restart');await f.queue.step(j);assert.equal(j.originalTitle,'真实写作项目名');
 f.queue.control(j.id,'source-title',{title:'恢复书名'});assert.equal(j.title,'恢复书名');assert.equal(j.scores.length,0);
 j.remote={sid:7};assert.throws(()=>f.queue.control(j.id,'source-title',{title:'不应变更'}),/远端/);
});

function setup(t, { aiOverrides = {}, runnerOverrides = {}, scheme = {}, originalTitle = '案件原书名', text, settings: initialSettings } = {}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wawawa-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'稿件.txt');fs.writeFileSync(source,text || `书名：${originalTitle}\n\n第一章 来信\n${'主角收到未来来信，开始调查失踪案件。'.repeat(20)}\n\n第二章 真相\n${'案件最后水落石出，主角回到平静生活。'.repeat(20)}`);
  const calls=[], remote={subs:[],chapters:[]}; let nextSid=3,nextBase=9; let settings={...fixtureSettings,...initialSettings},phone='13800000000';
  const ai = {
    analyze:async()=>{calls.push('analysis');return structuredClone(analysis);},
    score:async(title)=>{calls.push('score:'+title);return{total:80,scores:{contentFit:20,hook:35,genre:10,readability:10,distinctive:5},reason:'有冲突且贴合正文'};},
    title:async()=>{calls.push('title');return '全新案件书名';},intro:async()=>{calls.push('intro');return '主角收到一封来自未来的神秘来信，追查案件时逐渐接近秘密，危险也随之而来。';},
    prompt:async(title,a,style,pen)=>{calls.push('prompt');return `${title}，${pen} 著，${style}`;},
    cover:async()=>{calls.push('cover');const f=path.join(root,'cover.png');fs.writeFileSync(f,'fake-image-for-engine-only');return f;},
    rewriteChapter:async c=>{calls.push('rewrite:'+c.name);return c.text+'他决定认真继续生活。';},
    entry:async()=>({name:'科幻征文',confidence:90,reason:'内容匹配'}),...aiOverrides,
  };
  const runner = {
    apiLabelMap:async()=>new Map([['悬疑',1],['脑洞',2]]),apiCampaigns:async()=>[{name:'科幻征文',code:'sci-fi',description:'科幻主题'}],
    listSubmissions:async()=>remote.subs,
    apiUpload:async()=>{calls.push('upload-cover');return 'https://cdn.invalid/cover.png';},
    apiCreateFromFile:async cfg=>{calls.push('create');remote.payload=cfg;remote.chapters=cfg.chapters.map((c,i)=>({...c,node_id:i+1,is_submitted:false,is_locked:false}));const sid=nextSid++,baseId=nextBase++;remote.subs.push({sid,id:baseId,title:cfg.novel_title,penName:cfg.pen_name,status:'draft'});return{submission_id:sid,base_novel_id:baseId};},
    apiStartFormat:async()=>{calls.push('format');return {task_id:'format-test'};},
    apiFormatProgress:async()=>({status:'done',failed:0,skipped_locked:0}),
    apiStructure:async()=>remote.chapters,
    apiDeleteSubmission:async sid=>{calls.push(['delete',sid]);remote.subs=remote.subs.filter(x=>String(x.sid)!==String(sid));},
    apiUpdateCreateFile:async(sid,file)=>{calls.push('append-rest');const chapters=extractChaptersFromText(fs.readFileSync(file,'utf8'));const offset=remote.chapters.length;remote.chapters.push(...chapters.map((c,i)=>({...c,node_id:offset+i+1,is_submitted:false,is_locked:false})));},
    apiSubmitSubmission:async(sid,ids)=>{calls.push('submit');remote.chapters.forEach(c=>{if(ids.includes(c.node_id))c.is_submitted=true;});return{success_count:ids.length};},
    apiSubmitChapters:async(sid,ids)=>runner.apiSubmitSubmission(sid,ids),...runnerOverrides,
  };
  const storeFile=path.join(root,'queue.json');
  const deps={root,getSettings:()=>settings,getAccount:()=>phone,getSite:()=>site,aiFactory:()=>ai,withSite:fn=>fn(runner),checkConfig:()=>[],sleep:async()=>{}};
  let queue=new AutomationQueue({store:openStore(storeFile),...deps});
  const importBook=async()=>{await queue.import([source],{...DEFAULT_SCHEME,autoStart:false,storyRule:'long',firstSubmitMode:'all',...scheme});return queue.store.state.jobs[0];};
  const run=async()=>{queue.store.state.paused=false;await queue.pump();return queue.store.state.jobs[0];};
  return {root,source,calls,remote,runner,ai,importBook,run,get queue(){return queue;},settings:s=>{settings={...settings,...s};},phone:p=>{phone=p;},restart:()=>{queue=new AutomationQueue({store:openStore(storeFile),...deps});return queue;}};
}

test('full automatic pipeline preserves 80-point original title, binds author and verifies all submitted chapters',async t=>{
  const f=setup(t);await f.importBook();const j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.equal(j.title,'案件原书名');assert.equal(j.titleChanged,false);
  assert.equal(f.calls.includes('title'),false);assert.ok(j.prompt.includes('测试作者'));assert.deepEqual(f.remote.payload.label_ids,[1]);assert.equal(f.remote.payload.custom_label_texts,undefined);
  assert.equal(f.remote.payload.pen_name,'测试作者');assert.match(j.result,/已提交，等待审核/);assert.ok(j.remoteConfirmedAt);
  assert.ok(fs.existsSync(j.artifacts.package));assert.equal(fs.readFileSync(path.join(f.root,'queue.json'),'utf8').includes('fake-text-key'),false);
});
test('score below 80 regenerates then scores, never accepts a low-scoring candidate',async t=>{
  const f=setup(t,{aiOverrides:{score:async title=>({total:title==='案件原书名'?79:82,scores:{},reason:'评分依据'})}});await f.importBook();const j=await f.run();assert.equal(j.title,'全新案件书名');assert.equal(j.scores.length,2);assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');
});
test('repeated low scores stop before generating cover or uploading',async t=>{
  const f=setup(t,{aiOverrides:{score:async()=>({total:79,scores:{},reason:'题材不明'})}});await f.importBook();const j=await f.run();assert.equal(j.stage,'title');assert.equal(j.status,'attention');assert.equal(j.scores.length,4);assert.equal(f.calls.includes('create'),false);
});
test('network failure resumes saved intro and cover rather than regenerating successful stages',async t=>{
  let n=0;const f=setup(t,{aiOverrides:{cover:async()=>{n++;throw new Error('HTTP 503');}}});await f.importBook();let j=await f.run();assert.equal(n,3);assert.equal(j.stage,'cover');
  f.ai.cover=async()=>{n++;return path.join(f.root,'recovered.png');};f.queue.control(j.id,'retry');await f.run();j=f.queue.job(j.id);assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.equal(f.calls.filter(x=>x==='intro').length,1);assert.equal(f.calls.filter(x=>x==='analysis').length,1);
});
test('restart recovers persisted upload identity after connection drops before response',async t=>{
  const f=setup(t);const create=f.runner.apiCreateFromFile;f.runner.apiCreateFromFile=async cfg=>{await create(cfg);throw new Error('connection lost after server wrote');};
  await f.importBook();let j=await f.run();assert.equal(j.stage,'upload');assert.ok(j.uploadIntent);assert.equal(j.remote,undefined);
  f.restart();j=f.queue.store.state.jobs[0];f.queue.control(j.id,'retry');j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.equal(f.calls.filter(x=>x==='create').length,1);
});
test('ambiguous create with no visible remote match never blindly duplicates a book',async t=>{
  const f=setup(t,{runnerOverrides:{apiCreateFromFile:async()=>{throw new Error('timeout');}}});await f.importBook();let j=await f.run();f.queue.control(j.id,'retry');j=await f.run();assert.equal(j.status,'attention');assert.match(j.error.message,/不确定/);assert.ok(j.uploadIntent);
});
test('submit timeout reconciles server flags without sending twice',async t=>{
  const f=setup(t);const submit=f.runner.apiSubmitSubmission;f.runner.apiSubmitSubmission=async(...args)=>{await submit(...args);throw new Error('timeout after submit');};
  await f.importBook();let j=await f.run();assert.equal(j.stage,'submit');f.queue.control(j.id,'retry');j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.equal(f.calls.filter(x=>x==='submit').length,1);
});
test('partial submission stays attention, explicit resend sends only remaining unlocked chapters',async t=>{
  const f=setup(t);f.runner.apiSubmitSubmission=async(sid,ids)=>{f.calls.push(['submit',ids]);f.remote.chapters[0].is_submitted=true;return{success_count:1,failed_count:1};};await f.importBook();let j=await f.run();assert.equal(j.stage,'verify');assert.equal(j.status,'attention');
  f.queue.control(j.id,'confirm-not-submitted');f.runner.apiSubmitSubmission=async(sid,ids)=>{f.calls.push(['submit',ids]);f.remote.chapters.forEach(c=>{if(ids.includes(c.node_id))c.is_submitted=true;});};j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.deepEqual(f.calls.filter(Array.isArray).at(-1),['submit',[2]]);
});
test('library mode creates a draft but never calls submit',async t=>{const f=setup(t,{scheme:{destination:'library'}});await f.importBook();const j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.ok(f.calls.includes('create'));assert.equal(f.calls.includes('submit'),false);});
test('package mode needs no account or browser',async t=>{const f=setup(t,{scheme:{destination:'package'}});f.phone('');f.queue.withSite=()=>{throw new Error('forbidden');};await f.importBook();const j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.equal(f.calls.includes('create'),false);});
test('account switch blocks remote operations',async t=>{const f=setup(t);await f.importBook();f.phone('13900000000');const j=await f.run();assert.equal(j.stage,'catalog');assert.match(j.error.message,/账号/);assert.equal(f.calls.includes('create'),false);});
test('settings rebind from unconfigured analysis keeps inspection and catalog intact',async t=>{const f=setup(t,{settings:{apiKey:''}});await f.importBook();let j=await f.run();assert.equal(j.stage,'analysis');f.settings({apiKey:'fixed'});f.queue.control(j.id,'review',{useCurrentSettings:true});j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');});
test('unknown tags and low-confidence classification require attention',async t=>{
  const f=setup(t,{aiOverrides:{analyze:async()=>({...analysis,tags:['臆造标签']})}});await f.importBook();let j=await f.run();assert.equal(j.status,'attention');assert.equal(j.stage,'analysis');
  f.queue.control(j.id,'review',{analysis:{...analysis,confidence:30}});j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.deepEqual(f.remote.payload.label_ids,[1]);
});
test('same contents dedupe; same title with different contents never overwrite source',async t=>{
  const f=setup(t);const j=await f.importBook();const before=fs.readFileSync(j.file,'utf8');const duplicate=await f.queue.import([f.source],{...DEFAULT_SCHEME,autoStart:false});assert.equal(duplicate.duplicates.length,1);
  fs.appendFileSync(f.source,'\n另一段新正文');await f.importBook();assert.equal(f.queue.store.state.jobs.length,2);assert.equal(fs.readFileSync(j.file,'utf8'),before);assert.notEqual(f.queue.store.state.jobs[1].file,j.file);
});
test('paused queue resumes with latest pen name before upload',async t=>{
  const f=setup(t);const analyze=f.ai.analyze;f.ai.analyze=async(...args)=>{f.queue.pause();return analyze(...args);};await f.importBook();let j=await f.run();assert.equal(j.stage,'title');assert.equal(j.status,'queued');
  f.settings({penName:'后来笔名'});f.restart();assert.equal(f.queue.store.state.paused,true);j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.equal(f.remote.payload.pen_name,'后来笔名');assert.ok(j.prompt.includes('后来笔名'));
});
test('short manuscript requires matching campaign, not first campaign fallback',async t=>{
  const f=setup(t,{scheme:{storyRule:'short'},aiOverrides:{entry:async()=>{throw new Error('无匹配入口');}}});await f.importBook();let j=await f.run();assert.equal(j.stage,'entry');assert.equal(f.calls.includes('create'),false);
  f.queue.control(j.id,'review',{entry:'科幻征文'});j=await f.run();assert.equal(j.status,j.scheme.destination==='submit'?'watching':'done');assert.equal(f.remote.payload.campaign_code,'sci-fi');
});
test('chapters under 50 effective words are excluded while source and removal report stay available',async t=>{
  const f=setup(t,{text:'书名：短章测试\n\n第一章\n他走了。\n第二章\n'+ '多年以后他终于重新回到故乡见到亲人。'.repeat(10)});await f.importBook();const j=await f.run();assert.equal(j.status,'watching');assert.equal(f.remote.payload.chapters.length,1);assert.equal(f.remote.payload.chapters[0].name,'第二章');assert.ok(fs.readFileSync(j.file,'utf8').includes('他走了'));assert.match(fs.readFileSync(j.artifacts.cleaning,'utf8'),/不足50/);
});
test('parser supports fullwidth, English and numbered chapter headings without dropping short text',()=>{
  for(const name of ['第１章 开端','Chapter 1 Beginning','1. 开端','番外 回家']){const ch=extractChaptersFromText(name+'\n他走了。');assert.equal(ch.length,1);assert.equal(ch[0].name,name);assert.equal(ch[0].text,'他走了。');}
  const ch=extractChaptersFromText('雨下了一夜。\n第一章 开端\n他走了。');assert.equal(ch[0].name,'第一章 开端');assert.equal(ch[0].text,'他走了。');
});
test('title score sums rubric and rejects fabricated total/out-of-range values',()=>{
  assert.equal(titleScore({scores:{contentFit:20,hook:35,genre:10,readability:10,distinctive:5},total:99,reason:'依据'}),80);
  assert.throws(()=>titleScore({scores:{contentFit:100},reason:'依据'}),/维度/);
});
test('AI cover prompt contains final title and configured pen name; image magic is validated',async t=>{
  const f=setup(t);const ai=createPackagingAI({settings:fixtureSettings,coverDir:f.root,ask:async()=>'{"prompt":"明亮插画氛围","scene":"主角拆开来信，背景简洁明亮"}',fetcher:async()=>({ok:true,json:async()=>({data:[{b64_json:Buffer.from('not an image').toString('base64')}]})})});
  const prompt=await ai.prompt('最终书名',analysis,'悬疑','测试笔名');assert.ok(prompt.includes('最终书名'));assert.ok(prompt.includes('测试笔名'));await assert.rejects(ai.cover(prompt,'768x1024','id'),/不是有效/);
});
test('pagination fetches more than 300 works and rejects repeating pages',async()=>{
  const items=Array.from({length:347},(_,id)=>({id}));assert.equal((await allPages(async(p,n)=>({items:items.slice((p-1)*n,p*n)}),{size:20,key:'id'})).length,347);
  await assert.rejects(allPages(async()=>({items:items.slice(0,20)}),{size:20,key:'id'}),/重复/);
});
test('dry preview rejects missing packaging before remote writes',async t=>{
  const f=setup(t);const cfg={localFile:f.source,title:'书名',penName:'笔名',category:'长篇',channel:'男频',status:'已完结',novelType:analysis.novelType,tags:['悬疑'],entry:'普通投稿'};
  await assert.rejects(runSubmission(f.runner,{cfg},'dry',{preflight:c=>validateConfig(c,site)}),/封面/);assert.equal(f.calls.includes('upload-cover'),false);assert.equal(f.calls.includes('create'),false);
});
test('corrupt queue never silently resets completed remote history',t=>{const f=setup(t);fs.writeFileSync(path.join(f.root,'queue.json'),'{bad');assert.throws(()=>f.restart());});

const longFixture = () => '书名：待签约测试\n\n'+Array.from({length:20},(_,i)=>`第${i+1}章\n${'主角寻找到新的证据。'.repeat(250)}`).join('\n\n');
test('first 10-15 chapters cover minimum 20k effective words; full book is stored but only selected chapters are submitted',async t=>{
  const f=setup(t,{text:longFixture(),scheme:{firstSubmitMode:'minimum'}});await f.importBook();const j=await f.run();assert.equal(j.plan.count,10);assert.ok(j.plan.words>=20000);assert.equal(j.chapterCount,20);assert.equal(f.remote.payload.chapters.length,20);assert.equal(f.remote.chapters.filter(c=>c.is_submitted).length,10);assert.equal(f.remote.payload.is_finished,false);assert.equal(f.calls.some(x=>typeof x==='string'&&x.startsWith('rewrite')),false);
});
test('fixed short range below 20k blocks upload and can be changed in task details',async t=>{
  const f=setup(t,{text:longFixture(),scheme:{firstSubmitMode:'count',firstChapterCount:3}});await f.importBook();let j=await f.run();assert.equal(j.stage,'check');assert.match(j.error.message,/未达到20000/);assert.equal(f.calls.includes('create'),false);
  f.queue.control(j.id,'review',{firstSubmitMode:'count',firstChapterCount:12,firstMinChapters:10,firstMaxChapters:15});j=await f.run();assert.equal(j.status,'watching');assert.equal(j.plan.count,12);
});
test('range planning reaches 20k at chapter 14 and refuses insufficient 15 chapters',()=>{
  const ch=Array.from({length:20},()=>({name:'章',text:'字'.repeat(1500)}));assert.equal(initialPlan(ch,{...DEFAULT_SCHEME}).count,14);
  assert.throws(()=>initialPlan(ch.map(c=>({...c,text:'字'.repeat(1000)})),DEFAULT_SCHEME),/未达到20000/);
});
test('only exact generic rejection is eligible; supplementary story or format remarks never qualify',()=>{
  assert.equal(rejectionKind('质量暂未达到签约标准，感谢投稿。'),'generic');
  assert.equal(rejectionKind('质量暂未达到签约标准，感谢投稿\n故事完整度过低，剧情混乱主线不清晰，看点过低'),'story');
  assert.equal(rejectionKind('质量暂未达到签约标准，感谢投稿。正文有第一章第二章章节标识'),'format');
  assert.equal(rejectionKind('质量暂未达到签约标准，感谢投稿。其他问题'),'other');
  assert.equal(rejectionKind(''),'unknown');
});
test('generic rejection deletes only its bound record, rewrites first range and recreates once',async t=>{
  const f=setup(t,{text:longFixture(),scheme:{firstSubmitMode:'minimum'}});await f.importBook();let j=await f.run();const firstSid=j.remote.sid;
  f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='质量暂未达到签约标准，感谢投稿。';
  f.remote.subs.push({sid:900,id:900,title:'另一部作品',status:'rejected',reviewReason:'质量暂未达到签约标准，感谢投稿。'});
  await f.queue.syncReviews({manual:true});j=await f.run();assert.equal(j.status,'watching');assert.equal(j.repairCount,1);assert.notEqual(j.remote.sid,firstSid);
  assert.deepEqual(f.calls.filter(x=>Array.isArray(x)&&x[0]==='delete'),[['delete',firstSid]]);assert.equal(f.remote.subs.some(x=>x.sid===900),true);
  assert.equal(f.calls.filter(x=>typeof x==='string'&&x.startsWith('rewrite:')).length,10);assert.equal(f.calls.filter(x=>x==='cover').length,1);
  assert.equal(f.queue.chapters(j)[10].text.includes('他决定认真继续生活'),false);assert.equal(f.remote.payload.is_finished,false);
  const newRow=f.remote.subs.find(x=>x.sid===j.remote.sid);newRow.status='rejected';newRow.reviewReason='质量暂未达到签约标准，感谢投稿。';
  await f.queue.syncReviews({manual:true});assert.equal(j.status,'blocked');assert.equal(f.calls.filter(x=>x==='create').length,2);
});
test('zero quality and non-quality limits preserve rejected submissions',async t=>{
  for(const reason of ['质量暂未达到签约标准，感谢投稿。故事完整度过低，剧情混乱主线不清晰，看点过低','格式问题：正文中有大纲细纲']){
    const f=setup(t,{settings:{qualityResubmits:0,otherResubmits:0}});await f.importBook();const j=await f.run();f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason=reason;
    await f.queue.syncReviews({manual:true});assert.equal(j.status,'blocked');assert.equal(f.calls.filter(Array.isArray).length,0);assert.equal(f.calls.some(x=>typeof x==='string'&&x.startsWith('rewrite:')),false);
  }
});

test('configured quality limit permits two distinct revisions and persists its budget across restart',async t=>{
  const f=setup(t,{settings:{qualityResubmits:2}});await f.importBook();let j=await f.run();
  for(let n=1;n<=2;n++){
    const row=f.remote.subs.find(r=>r.sid===j.remote.sid);row.status='rejected';row.reviewReason='质量暂未达到签约标准，感谢投稿。';
    await f.queue.syncReviews({manual:true});await f.queue.draining;
    assert.equal(j.resubmits.quality,n);assert.equal(j.status,'watching');assert.ok(j.artifacts.rewrite.endsWith(`rewrite-${n}.json`));
  }
  assert.equal(f.calls.filter(x=>typeof x==='string'&&x.startsWith('rewrite:')).length,4);
  f.restart();j=f.queue.job(j.id);f.remote.subs.find(r=>r.sid===j.remote.sid).status='rejected';f.remote.subs.find(r=>r.sid===j.remote.sid).reviewReason='质量暂未达到签约标准，感谢投稿。';
  await f.queue.syncReviews({manual:true});assert.equal(j.status,'blocked');assert.equal(f.calls.filter(x=>x==='create').length,3);
});

test('non-quality retry uses its own configurable cap and does not consume quality budget',async t=>{
  const f=setup(t,{settings:{qualityResubmits:2,otherResubmits:1}});await f.importBook();const j=await f.run();
  f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='格式问题：正文中有大纲细纲';
  await f.queue.syncReviews({manual:true});await f.queue.draining;assert.equal(j.resubmits.other,1);assert.equal(j.resubmits.quality,undefined);assert.equal(j.status,'watching');
  f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='格式问题：正文中有大纲细纲';
  await f.queue.syncReviews({manual:true});assert.equal(j.status,'blocked');
});

test('pen cap waiting resumes after quota is raised and retains its name through settings changes',async t=>{
  const pen={id:'one',name:'作者甲',limit:1,enabled:true};const f=setup(t,{settings:{penNames:[pen]}});
  const j=await f.importBook();f.queue.store.state.jobs.push({id:'old',hash:'other',penId:'one',settings:{penName:'作者甲'},scheme:j.scheme,status:'done',account:j.account});
  await f.run();assert.equal(j.status,'waiting');assert.equal(f.calls.includes('create'),false);
  f.settings({penNames:[{...pen,limit:2}]});j.retryAt=0;await f.run();assert.equal(j.status,'watching');assert.equal(j.settings.penName,'作者甲');
  f.settings({penNames:[{...pen,name:'改名'}],penName:'其他'});f.queue.syncPenName(j);assert.equal(j.settings.penName,'作者甲');
});
test('disabled auto repair preserves generic rejection and makes no delete request',async t=>{
  const f=setup(t);await f.importBook();const j=await f.run();f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='质量暂未达到签约标准，感谢投稿。';f.settings({autoRepairRejected:false});await f.queue.syncReviews({manual:true});assert.equal(j.status,'blocked');assert.equal(f.calls.filter(Array.isArray).length,0);
});
test('paused monitoring classifies but does not delete; refreshed changed reason blocks deletion',async t=>{
  const f=setup(t);await f.importBook();const j=await f.run();f.queue.pause();f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='质量暂未达到签约标准，感谢投稿。';
  await f.queue.syncReviews({manual:true});assert.equal(j.stage,'delete-rejected');assert.equal(f.calls.filter(Array.isArray).length,0);
  f.remote.subs[0].reviewReason+='剧情混乱主线不清晰';await f.run();assert.equal(j.status,'attention');assert.equal(f.calls.filter(Array.isArray).length,0);
});
test('delete response lost after server deleted recovers from durable intent without repeating delete',async t=>{
  const f=setup(t);const remove=f.runner.apiDeleteSubmission;f.runner.apiDeleteSubmission=async sid=>{await remove(sid);throw new Error('timeout after delete');};await f.importBook();let j=await f.run();f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='质量暂未达到签约标准，感谢投稿。';await f.queue.syncReviews({manual:true});j=await f.run();assert.equal(j.stage,'delete-rejected');assert.ok(j.deleteIntent);
  f.restart();j=f.queue.store.state.jobs[0];f.queue.control(j.id,'retry');j=await f.run();assert.equal(j.status,'watching');assert.equal(f.calls.filter(Array.isArray).length,1);
});
test('approved is insufficient: only contracted permits automatic remainder upload',async t=>{
  const f=setup(t,{text:longFixture(),scheme:{firstSubmitMode:'minimum'}});await f.importBook();let j=await f.run();f.remote.subs[0].status='approved';await f.queue.syncReviews({manual:true});assert.equal(f.calls.includes('append-rest'),false);assert.equal(j.status,'watching');
  f.remote.subs[0].status='contracted';await f.queue.syncReviews({manual:true});j=await f.run();assert.equal(j.status,'done');assert.equal(j.remainderComplete,true);assert.equal(f.remote.chapters.length,20);assert.ok(f.remote.chapters.every(c=>c.is_submitted));assert.equal(f.calls.filter(x=>x==='append-rest').length,0);
});
test('legacy partial warehouse stops safely instead of using unsupported file append',async t=>{
  const f=setup(t,{text:longFixture(),scheme:{firstSubmitMode:'minimum'}});await f.importBook();let j=await f.run();
  f.remote.chapters.splice(10);delete j.warehouseAll;f.remote.subs[0].status='contracted';
  await f.queue.syncReviews({manual:true});j=await f.run();assert.equal(j.stage,'append-rest');assert.match(j.error.message,/旧版/);assert.equal(f.calls.includes('append-rest'),false);
});

test('cleaner removes outline sections, prompts, separator lines and ending marks, keeping prose and 50-word boundary',()=>{
  const text='大纲\n第一章 概述\n主角进入城市。\n第二章 概述\n主角解决冲突。\n正文\n第一章 开始\n'+ '他在城市里寻找线索。'.repeat(10)+'\n（本章完）\n-----\n以下是为您生成的小说内容：\n第二章\n'+ '甲'.repeat(49)+'\n第三章\n'+'乙'.repeat(50);
  const a=cleanManuscript({text});assert.equal(a.chapters.length,2);assert.equal(a.chapters[0].name,'第一章 开始');assert.equal(a.chapters[1].name,'第三章');assert.equal(effectiveWords(a.chapters[1].text),50);
  const joined=a.chapters.map(c=>c.text).join('');assert.doesNotMatch(joined,/大纲|第一章|第二章|本章完|以下是|-----/);assert.ok(a.changes.length>=7);
});
test('keyword-only matches are non-blocking notices and preserve prose',()=>{
  const a=cleanManuscript({text:'第一章\n'+ '主角正在思考下一步行动。'.repeat(10)+'\n提示词内容可能仍在这一段正文中。'});assert.equal(a.chapters.length,1);assert.equal(a.warnings.length,0);assert.ok(a.notices.length);assert.match(a.chapters[0].text,/提示词内容/);
});
test('bracketed and bold chapter headings and standalone ending marks do not enter chapter body',()=>{
  const body='主角沿着旧街走过寻找儿时的朋友。'.repeat(8);
  const a=cleanManuscript({text:`【第一章 起点】\n${body}\n本章完\n**第二章 重逢**\n${body}\n正文：第三章 回家\n${body}`});
  assert.equal(a.chapters.length,3);assert.ok(a.chapters.every(c=>!/第一章|第二章|第三章|本章完/.test(c.text)));
});
test('import completes cleaning and persists its report even when automatic start is disabled',async t=>{
  const f=setup(t);const j=await f.importBook();assert.equal(j.stage,'catalog');assert.ok(fs.existsSync(j.artifacts.cleaning));assert.equal(f.calls.includes('analysis'),false);
});
test('unknown or empty refusal reason blocks deletion; account change stops monitor actions',async t=>{
  const f=setup(t);await f.importBook();const j=await f.run();f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='';await f.queue.syncReviews({manual:true});assert.equal(j.status,'blocked');assert.equal(j.review.kind,'unknown');
  f.remote.subs[0].reviewReason='质量暂未达到签约标准，感谢投稿。';f.phone('13911112222');await f.queue.syncReviews({manual:true});assert.equal(f.calls.filter(Array.isArray).length,0);
});
test('upgrading a persisted legacy verify checkpoint restores its all-chapter plan',async t=>{
  const f=setup(t);await f.importBook();let j=await f.run();delete j.plan;j.stage='verify';j.status='queued';j=await f.run();assert.equal(j.status,'watching');assert.equal(j.plan.count,j.chapterCount);assert.equal(f.calls.filter(x=>x==='create').length,1);
});


test('AI calls follow current connection settings without replacing book metadata', async t => {
  const f=setup(t);const j=await f.importBook();
  f.settings({apiBaseUrl:'https://new.invalid/v1',apiKey:'new-key',textModel:'new-model',imgApiBaseUrl:'https://image.invalid/v1',imgApiKey:'image-key',imageModel:'new-image',penName:'new-pen'});
  const text=f.queue.settings(j),image=f.queue.settings(j,true);
  assert.equal(text.apiBaseUrl,'https://new.invalid/v1');assert.equal(text.apiKey,'new-key');assert.equal(text.textModel,'new-model');
  assert.equal(image.imageModel,'new-image');assert.equal(image.imgApiKey,'image-key');assert.equal(text.penName,j.settings.penName);
  f.settings({apiKey:''});assert.throws(()=>f.queue.settings(j),/配置文本 AI/);
});

test('homepage intro is reused and long front matter never becomes a submitted chapter',async t=>{
  const intro='一封远方来信让平凡青年踏上追寻真相的旅程，秘密逐渐揭开。';
  const f=setup(t,{text:'书名：原稿简介测试\n【简介】：'+intro+'\n\n'+intro+'\n前言\n'+('首页宣传语。'.repeat(200))+'\n第一章 开始\n'+('青年出门调查案件。'.repeat(50))});
  const j=await f.importBook();assert.ok(j.sourceIntro.startsWith(intro));await f.run();assert.equal(j.intro,j.sourceIntro);assert.equal(f.calls.includes('intro'),false);assert.equal(f.remote.chapters[0].name,'第一章 开始');assert.doesNotMatch(f.remote.chapters[0].text,/宣传语|简介/);
});
test('edited cover resumes and deleted remote task retains duplicate protection',async t=>{
  let fail=true;const f=setup(t,{aiOverrides:{cover:async()=>{if(fail)throw new Error('prompt rejected');return f.source;}}});await f.importBook();const j=await f.run();assert.equal(j.stage,'cover');f.queue.pause();
  f.queue.control(j.id,'edit-prompt',{prompt:'低饱和背景，人物与书名清晰'});fail=false;await f.run();assert.equal(j.status,'watching');assert.equal(f.calls.filter(x=>x==='analysis').length,1);
  const sid=j.remote.sid;f.queue.control(j.id,'delete');assert.equal(f.queue.store.state.jobs.length,1);assert.equal(j.hidden,true);assert.equal(f.remote.subs[0].sid,sid);assert.ok(fs.existsSync(j.file));const next=await f.importBook();assert.equal(next.id,j.id);
});
test('parallel rewriting checkpoints out of order successes and retry only retries failed chapters',async t=>{
  let running=0,peak=0,fail=true;const seen=[];
  const f=setup(t,{text:longFixture(),scheme:{firstSubmitMode:'minimum'},initialSettings:{rewriteConcurrency:3},aiOverrides:{rewriteChapter:async c=>{
    running++;peak=Math.max(peak,running);seen.push(c.name);await new Promise(r=>setTimeout(r,c.name==='第1章'?15:1));running--;if(c.name==='第1章'&&fail)throw new Error('temporary');return c.text;
  }}});
  await f.importBook();const j=await f.run();f.remote.subs[0].status='rejected';f.remote.subs[0].reviewReason='质量暂未达到签约标准，感谢投稿。';await f.queue.syncReviews({manual:true});await f.run();assert.equal(j.stage,'rewrite');assert.equal(peak,3);
  const done=JSON.parse(fs.readFileSync(j.artifacts.rewriteWorking)).done;assert.ok(done.length>0);fail=false;f.queue.control(j.id,'retry');await f.run();assert.equal(j.status,'watching');for(const i of done)assert.equal(seen.filter(n=>n===`第${i+1}章`).length,1);
});

test('restart resets a local failed task to original import and remote tasks cannot restart',async t=>{
  const f=setup(t);const j=await f.importBook();j.status='attention';j.stage='cover';j.prompt='旧提示';j.intro='旧简介';f.queue.control(j.id,'restart');assert.equal(j.stage,'inspect');assert.equal(j.prompt,undefined);assert.equal(j.intro,undefined);assert.ok(fs.existsSync(j.file));await f.run();assert.equal(j.status,'watching');assert.throws(()=>f.queue.control(j.id,'restart'),/远端/);
});

test('native format finishes before submit and resume polls same task without reupload',async t=>{
  let fail=true;const f=setup(t,{runnerOverrides:{apiFormatProgress:async()=>{if(fail)throw new Error('network');return {status:'done',failed:0,skipped_locked:0};}}});await f.importBook();const j=await f.run();assert.equal(j.stage,'format');assert.equal(f.calls.includes('submit'),false);assert.ok(j.formatTaskId);
  fail=false;f.queue.control(j.id,'retry');await f.run();assert.equal(j.status,'watching');assert.equal(f.calls.filter(x=>x==='format').length,1);assert.equal(f.calls.filter(x=>x==='create').length,1);assert.ok(f.calls.indexOf('format')<f.calls.indexOf('submit'));
});
test('partial native formatting blocks submission',async t=>{
  const f=setup(t,{runnerOverrides:{apiFormatProgress:async()=>({status:'done',failed:1})}});await f.importBook();const j=await f.run();assert.equal(j.stage,'format');assert.equal(j.status,'attention');assert.equal(f.calls.includes('submit'),false);
});

test('pen name update refreshes unuploaded packaging but preserves remote identity',async t=>{
 const f=setup(t);const j=await f.importBook();j.stage='check';j.prompt='旧署名';j.cover='old.png';f.settings({penName:'新笔名'});f.queue.updatePendingPenNames();assert.equal(j.settings.penName,'新笔名');assert.equal(j.stage,'prompt');assert.equal(j.cover,undefined);
 j.remote={sid:3,baseId:9};f.settings({penName:'再换笔名'});f.queue.updatePendingPenNames();assert.equal(j.settings.penName,'新笔名');
});

test('deleting an active job waits for its current step and prevents subsequent uploads across restart',async t=>{
 let release,started;const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const f=setup(t,{aiOverrides:{analyze:async()=>{started();await gate;return structuredClone(analysis);}}});
 const j=await f.importBook(),running=f.run();await entered;
 f.queue.control(j.id,'delete');assert.equal(j.deleteRequested,true);release();await running;
 assert.equal(j.hidden,true);assert.equal(j.status,'canceled');assert.equal(f.calls.includes('create'),false);
 f.restart();await f.run();assert.equal(f.calls.includes('create'),false);assert.equal(f.queue.job(j.id).hidden,true);
});

test('old paused analysis reloads the category tree and empty tag cache',async t=>{
 const f=setup(t);const j=await f.importBook();j.stage='analysis';j.catalog={tree:{},tags:[],entries:[]};j.analysis=structuredClone(analysis);
 await f.queue.step(j);
 assert.deepEqual(j.catalog.tree,site.tree);assert.deepEqual(j.catalog.tags,site.tags);
});
test('old keyword-only inspection warning is re-cleaned on retry',async t=>{
 const f=setup(t);const j=await f.importBook();j.stage='inspect';j.cleaningSummary.version=1;j.warnings=['旧关键词误报'];
 await f.queue.step(j);
 assert.equal(j.cleaningSummary.version,2);assert.deepEqual(j.warnings,[]);
});

test('refresh-cover keeps text artifacts, uses current mood, and does not reuse the old image cache',async t=>{
 const f=setup(t);const j=await f.importBook();j.analysis=structuredClone(analysis);j.prompt='旧提示';j.intro='已确认简介';j.titleScore=88;j.cover='旧封面';j.stage='cover';f.queue.pause();
 f.settings({coverMood:'清亮暖色，自定义光线'});assert.equal(f.queue.settings(j).coverMood,'清亮暖色，自定义光线');
 f.queue.control(j.id,'refresh-cover');assert.equal(j.stage,'prompt');assert.equal(j.prompt,undefined);assert.equal(j.intro,'已确认简介');assert.equal(j.titleScore,88);
 await f.queue.step(j);j.stage='cover';let key;f.ai.cover=async(p,s,id)=>{key=id;return 'new.png';};await f.queue.step(j);assert.equal(key,j.id+'-v1');
 j.remote={sid:1};assert.throws(()=>f.queue.control(j.id,'refresh-cover'),/远端/);
});

test('applying a saved cover prompt invalidates only local cover artifacts and skips active or remote jobs',async t=>{
 const f=setup(t);const j=await f.importBook();j.analysis=structuredClone(analysis);j.stage='check';j.prompt='cached';j.cover='cached.png';j.intro='keep';j.titleScore=90;j.scores=[{title:'keep',total:90}];
 const active=structuredClone(j);active.id='active';const remote=structuredClone(j);remote.id='remote';remote.remote={sid:3};f.queue.store.state.jobs.push(active,remote);f.queue.active.add('active');
 assert.deepEqual(f.queue.applyPrompt('coverScene'),{updated:1,skipped:2});assert.equal(j.stage,'prompt');assert.equal(j.prompt,undefined);assert.equal(j.intro,'keep');assert.equal(j.scores.length,1);assert.equal(remote.cover,'cached.png');
 f.queue.applyPrompt('score');assert.equal(j.stage,'title');assert.deepEqual(j.scores,[]);assert.equal(j.intro,undefined);
});
test('old title scores are reassessed using the new rubric and keep the writer naming style',async t=>{
 const f=setup(t);const j=await f.importBook();j.analysis=structuredClone(analysis);j.stage='title';j.scores=[{title:'旧评分',total:99}];j.platformStyle='飞卢风';j.titleStyle='强钩子';
 let context;f.ai.score=async(title,a)=>{context=a;return {total:80,reason:'new',scores:{}};};await f.queue.step(j);
 assert.equal(j.title,j.originalTitle);assert.equal(j.titleScoreVersion,2);assert.equal(context.titleStyle,'强钩子');
});
