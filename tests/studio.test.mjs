import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateStudio,choosePen,penStats,resolvePen,fetchConcurrent,resubmitLimit} from '../studio-policy.mjs';
import {buildCoverPrompt,COVER_FIXED} from '../cover-prompt.mjs';
import {renderPrompt} from '../prompt-catalog.mjs';
import {WriterClient} from '../writer-client.mjs';
import {attachStudio} from '../studio-main.mjs';
import {EventEmitter} from 'node:events';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('pen reservations prevent parallel allocation exceeding cap and preserve bound names',()=>{
 const s=validateStudio({penNames:[{name:'甲',limit:1},{name:'乙',limit:1,channel:'女频'}]});
 const jobs=[],job={settings:{},analysis:{channel:'男频',novelType:['男频','都市','都市生活']}};
 const p=choosePen(s,jobs,job,'138');assert.equal(p.name,'甲');jobs.push({...job,penId:p.id,status:'queued'});
 assert.equal(choosePen(s,jobs,job,'138'),null);
 assert.equal(choosePen(s,jobs,{...job,penId:p.id,settings:{penName:'甲'}},'138').name,'甲');
 assert.equal(choosePen(s,jobs,{...job,analysis:{channel:'女频'}},'138').name,'乙');
});
test('account restriction, disabled pens, dedupe, and numeric constraints',()=>{
 assert.throws(()=>validateStudio({penNames:[{name:'甲'},{name:'甲'}]}));
 assert.throws(()=>validateStudio({qualityResubmits:-1}));assert.throws(()=>validateStudio({revenueConcurrency:0}));
 const s=validateStudio({penNames:[{name:'甲',account:'123'},{name:'乙',enabled:false}]});
 assert.equal(choosePen(s,[],{settings:{}},'456'),null);
});
test('rejected and canceled uploads retain quota and historical submission timestamps',()=>{
 const at=Date.now(),p={id:'p'};
 const stats=penStats(p,[{penId:'p',status:'canceled',submissionEvents:[new Date(at).toISOString(),new Date(at-1000).toISOString()]}],at);
 assert.equal(stats.total,1);assert.equal(stats.submitted,1);assert.equal(stats.today,2);
});
test('pen matching never conflates identical titles and supports old submissions',()=>{
 const jobs=[{settings:{penName:'甲'},remote:{sid:1},oldSubmissions:[{sid:3}]}];
 assert.equal(resolvePen({sid:2,title:'同名'},jobs),'未匹配');assert.equal(resolvePen({sid:3,title:'同名'},jobs),'甲');
 assert.equal(resolvePen({sid:1,penName:'平台'},jobs),'平台');assert.equal(resolvePen({sid:2},jobs,{'2':'手工'}),'手工');
});
test('cover keeps fixed rules and appends user text; editable prompt values are rendered literally',()=>{
 const s=buildCoverPrompt({coverExtra:'加入远山'},{title:'书名',penName:'甲',style:'卡通',channel:'女频',genre:'都市'});
 assert.ok(s.includes("完整书名「书名」"));assert.ok(s.endsWith('加入远山'));assert.ok(s.includes('作者署名「甲」'));
 assert.equal(renderPrompt({promptTemplates:{title:'标题：{v0}'}},'title',{v0:'$&正文'}),'标题：$&正文');
 assert.equal(resubmitLimit({},'generic'),1);assert.equal(resubmitLimit({},'other'),0);
});
test('bounded revenue concurrency checkpoints successes despite per-book failures',async()=>{
 let active=0,peak=0;const saved=[];
 const result=await fetchConcurrent([1,2,3,4,5],async id=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;if(id===3)throw new Error('503');return id;},{concurrency:3,delayMs:0,onResult:r=>saved.push(r)});
 assert.equal(peak,3);assert.equal(result.length,5);assert.equal(saved.filter(x=>x.data).length,4);assert.equal(result.filter(x=>x.error).length,1);
});
test('rate-limit response retires parallel workers and processes remaining IDs',async()=>{
 const seen=[];const results=await fetchConcurrent([1,2,3,4,5],async id=>{seen.push(id);if(id===1)throw new Error('HTTP 429');return id;},{concurrency:3,delayMs:0,sleep:async()=>{}});
 assert.equal(new Set(seen).size,5);assert.equal(results.length,5);
});
test('bundled private writer supports configuration, creation, pause, and restart without a web server',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unified-writer-'));const client=new WriterClient(root,dir);t.after(()=>{client.close();setTimeout(()=>fs.rmSync(dir,{recursive:true,force:true}),200);});
 const config=await client.call('config');assert.equal(config.api.api_key,undefined);
 await client.call('save-config',{api:{api_key:'test-secret'}});
 await client.call('save-config',{api:{api_key:''}});assert.equal((await client.call('config')).api.has_api_key,true);
 await client.call('save-config',{clear_api_key:true,api:{api_key:''}});assert.equal((await client.call('config')).api.has_api_key,false);
 const defaults=await client.call('defaults');assert.ok(defaults.prompts.prompt_1);
 await client.call('save-config',{prompts:{prompt_1:'新的全书规划'}});assert.equal((await client.call('config')).prompts.prompt_1,'新的全书规划');
 const b=await client.call('add',{book_name:'接口隔离测试'});await client.call('action',{id:b.id,action:'pause'});
 assert.equal((await client.call('snapshot')).queue.items[0].status,'paused');
 await assert.rejects(client.call('complete-export',{id:b.id}),/尚未完整生成/);
});
test('unified lifecycle creates durable links and does not re-import after repeated scans',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unified-link-')),handlers=new Map(),app=new EventEmitter();
 const data={penNames:[],resumeOnStartup:false,autoSubmitCompleted:true};let imports=0;
 const q={store:{state:{jobs:[],schemes:[{name:'默认'}],paused:true}},snapshot(){return this.store.state;},async import(){imports++;const j={id:'j1'};this.store.state.jobs.push(j);return {added:['j1'],duplicates:[],errors:[]};},job(id){return this.store.state.jobs.find(j=>j.id===id);},save(){},resume(){this.store.state.paused=false;},pause(){this.store.state.paused=true;},pump(){}};
 const service=attachStudio({app,ipcMain:{handle:(k,v)=>handlers.set(k,v)},dialog:{},root,userPath:(...p)=>path.join(dir,...p),getAutomation:()=>q,loadSettings:()=>data,saveSettings:()=>{},send:()=>{},loadCredentials:()=>null});
 service.writer.call=async method=>method==='snapshot'?{queue:{items:[{id:'book1',status:'completed'}]}}:'fake.txt';
 const run=()=>handlers.get('studio')({}, {method:'sync-completed'});
 assert.equal((await run()).ok,true);await run();assert.equal(imports,1);assert.equal(q.store.state.jobs[0].writerId,'book1');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/studio.json'))).links.book1.jobId,'j1');
 q.control=(id,action)=>{assert.equal(action,'delete');const j=q.job(id);j.hidden=true;j.status='canceled';};
 const deleted=await handlers.get('studio')({}, {method:'delete-items',data:{kind:'books',ids:['book1']}});assert.equal(deleted.ok,true);assert.equal(deleted.data[0].success,true);
 await run();assert.equal(imports,1);assert.equal(q.job('j1').hidden,true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/studio.json'))).links.book1.deleted,true);
 const invalid=await handlers.get('studio')({}, {method:'delete-items',data:{kind:'books',ids:['__proto__']}});assert.equal(invalid.ok,false);
 t.after(()=>{app.emit('before-quit');fs.rmSync(dir,{recursive:true,force:true});});
});
