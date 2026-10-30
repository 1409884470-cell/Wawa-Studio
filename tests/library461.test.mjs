import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {completedBooks,submissionState,hideSubmissionRecord,bookSubmission} from '../library-state.mjs';
import {attachStudio} from '../studio-main.mjs';

test('removing records preserves confirmed submissions, drafts and uncertain uploads distinctly',()=>{
  for(const [facts,group] of [[{remoteConfirmedAt:'today',scheme:{destination:'submit'}},'done'],[{remoteConfirmedAt:'today',scheme:{destination:'library'}},'attention'],[{uploadIntent:{at:'today'}},'attention']]){
    const j={id:'j',status:'done',remote:{sid:1},...facts};hideSubmissionRecord(j);
    assert.equal(submissionState(j).group,group);assert.equal(j.recordStatus,'done');
    assert.equal(submissionState(JSON.parse(JSON.stringify(j))).group,group);
  }
  const legacy={hidden:true,status:'canceled',remoteConfirmedAt:'today',scheme:{destination:'submit'}};
  assert.equal(submissionState(legacy).group,'done');
  assert.equal(submissionState({hidden:true,status:'canceled',submitIntent:{},remote:{sid:2}}).group,'attention');
});
test('completed metadata remains visible with stale queue and no submission job',()=>{
  const s={queue:{items:[{id:'a',status:'paused'},{id:'b',status:'completed'}]},library:[{id:'a',status:'completed',chapters:12,words:20000},{id:'b',kind:'full'},{id:'partial',kind:'progress'}]};
  assert.deepEqual(completedBooks(s).map(b=>b.id),['a','b']);
  assert.equal(completedBooks(s)[0].completed_chapters,12);
  assert.equal(submissionState(null).text,'已完稿 · 未投稿');
  assert.equal(bookSubmission([{id:'old',writerId:'a',hidden:true,status:'canceled'},{id:'new',writerId:'a',status:'queued'}],'a').id,'new');
});
test('manual transfer works with automatic transfer off, survives stale links, and deduplicates concurrent clicks',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'library-transfer-')),app=new EventEmitter();let handler,imports=0;
  const settings={penNames:[],autoSubmitCompleted:false};
  const q={active:new Set(),store:{state:{jobs:[],schemes:[{name:'default',destination:'submit'}],paused:true}},snapshot(){return structuredClone(this.store.state);},save(){},startJobs(ids){this.started=ids;},pump(){throw new Error('must not start unrelated jobs');},job(id){return this.store.state.jobs.find(j=>j.id===id);},async import(){imports++;await new Promise(r=>setTimeout(r,10));this.store.state.jobs.push({id:'j1',status:'queued',stage:'catalog',scheme:{destination:'submit'},settings:{},artifacts:{}});return {added:['j1'],duplicates:[],errors:[]};}};
  fs.mkdirSync(path.join(dir,'data'));fs.writeFileSync(path.join(dir,'data/studio.json'),JSON.stringify({links:{book:{jobId:'stale'}}}));
  const service=attachStudio({app,ipcMain:{handle:(k,h)=>handler=h},dialog:{},root:dir,userPath:(...p)=>path.join(dir,...p),getAutomation:()=>q,loadSettings:()=>settings,saveSettings(){},send(){},loadCredentials(){}});
  t.after(()=>{app.emit('before-quit');fs.rmSync(dir,{recursive:true,force:true});});
  service.writer.call=async method=>method==='snapshot'?{queue:{items:[{id:'book',book_name:'完稿',status:'completed'}]},library:[]}: 'export.txt';
  const call=(method,data={})=>handler({}, {method,data});
  await service.connectCompleted();assert.equal(imports,0);
  const results=await Promise.all([call('submit-books',{ids:['book']}),call('submit-books',{ids:['book']})]);
  assert.deepEqual(q.started,['j1']);assert.equal(imports,1);assert.ok(results.every(r=>r.ok&&r.data[0].success));
  hideSubmissionRecord(q.job('j1'));await call('submit-books',{ids:['book']});assert.equal(imports,1);assert.equal(q.job('j1').hidden,false);
  Object.assign(q.job('j1'),{remote:{sid:123},remoteConfirmedAt:'today',status:'watching'});hideSubmissionRecord(q.job('j1'));
  const snap=await call('snapshot');assert.equal(snap.data.bookSubmissions.book.libraryState.group,'done');
  await call('submit-books',{ids:['book']});assert.equal(imports,1);assert.equal(q.job('j1').status,'attention');assert.equal(q.store.state.paused,true);
  const invalid=await call('submit-books',{ids:['unknown']});assert.equal(invalid.data[0].success,false);
});
