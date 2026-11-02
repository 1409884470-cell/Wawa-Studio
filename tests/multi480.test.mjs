import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {openQuota,pickAccount,quotaDay} from '../submission-quota.mjs';
import {AutomationQueue,accountKey} from '../automation-engine.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'multi480-'));
process.env.WAWAWA_DATA_DIR=root;
// core may already be loaded by AutomationQueue; explicitly supplied profile paths remain isolated.
const {createRunner}=await import('../core.mjs');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('three attempts include failed calls, survive reload/deletion and reset at Shanghai midnight',()=>{
  const file=path.join(root,'quota.json');let at=Date.parse('2026-11-02T23:59:00+08:00');
  let q=openQuota(file,{clock:()=>at,settings:()=>({submissionDailyLimit:0})});q.migrate([]);
  for(let i=0;i<3;i++)q.reserve('A',{submissionId:i});
  assert.throws(()=>q.reserve('A'),e=>e.code==='DAILY_QUOTA'&&e.retryAt===Date.parse('2026-11-03T00:00:00+08:00'));
  assert.equal(q.stats('B').remaining,3);
  q=openQuota(file,{clock:()=>at});q.migrate([]);assert.equal(q.stats('A').remaining,0);
  at+=60000;assert.equal(quotaDay(at),'2026-11-03');assert.equal(q.stats('A').remaining,3);
});
test('legacy jobs migrate once and platform rejection blocks the rest of that day',()=>{
  const q=openQuota(path.join(root,'legacy.json'));
  q.migrate([{account:'A',id:'old',scheme:{destination:'submit'},submissionEvents:[new Date().toISOString()]}]);
  q.migrate([]);assert.equal(q.stats('A').used,1);q.block('A');assert.equal(q.stats('A').remaining,0);assert.equal(q.stats('B').remaining,3);
});
test('account allocation excludes unsigned accounts and balances reserved books with real attempts',()=>{
  const accounts=['A','B','C'].map(phone=>({phone,key:phone,sessionSaved:phone!=='C'}));
  const jobs=[];const assigned=[];
  for(let i=0;i<6;i++){const a=pickAccount(accounts,jobs,()=>({remaining:3}));assigned.push(a.key);jobs.push({id:i,account:a.key,status:'queued'});}
  assert.equal(assigned.filter(a=>a==='A').length,3);assert.equal(assigned.filter(a=>a==='B').length,3);
  assert.equal(pickAccount(accounts,[],key=>({remaining:key==='A'?0:3})).key,'B');
});
test('bound remote books cannot be reassigned and account-specific operation uses bound phone',async()=>{
  const accounts=['111111','222222'].map(phone=>({phone,key:accountKey(phone)}));let used;
  const q=new AutomationQueue({store:{state:{jobs:[]},save(){}},getAccount:()=>accounts[0].phone,getAccounts:()=>accounts,chooseAccount:()=>accounts[1],withSite:async(fn,phone)=>{used=phone;return fn({});}});
  const remote={account:accounts[0].key,remote:{sid:1}};q.assignAccount(remote);assert.equal(remote.account,accounts[0].key);
  const local={account:accounts[0].key};q.assignAccount(local);assert.equal(local.account,accounts[1].key);
  await q.site(local,async()=>{});assert.equal(used,accounts[1].phone);
});
test('core reserves before network and never refunds a failed submission; fourth never reaches API',async()=>{
  const q=openQuota(path.join(root,'calls.json'));const r=createRunner({beforeSubmit:d=>q.reserve('A',d)});let sent=0;
  r._api=async()=>{sent++;throw Error('network timeout');};
  for(let i=0;i<3;i++)await assert.rejects(r.apiSubmitSubmission(1,[1]),/timeout/);
  await assert.rejects(r.apiSubmitChapters(1,[2]),e=>e.code==='DAILY_QUOTA');assert.equal(sent,3);
});
test('browser storage and saved sessions are separate for two accounts',async()=>{
  const dirs=[];
  for(const phone of ['A','B']){
    const profileDir=path.join(root,phone,'browser'),sessionFile=path.join(root,phone,'session.json');
    const page={goto:async()=>{},bringToFront:async()=>{},isClosed:()=>false,locator:()=>({waitFor:async()=>{}}),evaluate:async()=>({localStorage:{account:phone},cookie:''})};
    const ctx={pages:()=>[page],on(){},close:async()=>{}};
    const r=createRunner({profileDir,sessionFile,browserType:{launchPersistentContext:async dir=>{dirs.push(dir);return ctx;}}});
    await r.openLogin();await r.saveLoginSession();await r.close();
  }
  assert.notEqual(dirs[0],dirs[1]);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'A','session.json'))).localStorage.account,'A');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'B','session.json'))).localStorage.account,'B');
});
test('serialized automation opens the requested account, including after another account fails login',async()=>{
  const source=fs.readFileSync(new URL('../main.mjs',import.meta.url),'utf8');let active=0,peak=0;const seen=[];
  const context=vm.createContext({loadCredentials:()=>({phone:'A'}),manualLoginOpen:false,invalidAccounts:new Set(['bad']),busy:false,revBusy:false,automationSiteBusy:false,siteTail:Promise.resolve(),send(){},getRunner:async(headless,phone)=>{seen.push(phone);return{ensureLogin:async()=>{}};}});
  vm.runInContext(source.slice(source.indexOf('async function withAutomationSite('),source.indexOf('function getAutomation()')),context);
  const work=()=>context.withAutomationSite(async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;},'B');
  await Promise.all([work(),work(),assert.rejects(context.withAutomationSite(async()=>{},'bad'),e=>e.code==='AUTH_REQUIRED')]);
  assert.equal(peak,1);assert.deepEqual(seen,['B','B']);
});
test('selected quota-waiting book resumes after reset while unrelated queue remains paused',async()=>{
  const j={id:'selected',status:'queued',stage:'submit',requestedStart:true,attempts:{},history:[],scheme:{destination:'package',concurrency:1}};
  const other={...j,id:'other',requestedStart:false};
  const state={paused:true,jobs:[j,other]};
  const q=new AutomationQueue({store:{state,save(){}},getSettings:()=>({submissionConcurrency:1}),emit(){}});
  q.syncPenName=()=>{};
  q.step=async()=>{const e=Error('额度已用完');e.waiting=true;e.code='DAILY_QUOTA';e.retryAt=Date.now()+86400000;throw e;};
  await q.pump();assert.equal(j.status,'waiting');assert.equal(j.requestedStart,true);assert.equal(other.status,'queued');
  j.retryAt=Date.now()-1;q.step=async job=>{job.stage='verify';};
  await q.pump();assert.equal(j.status,'done');assert.equal(other.status,'queued');
});
test('reviews with identical remote IDs are grouped by account',async()=>{
  const accounts=['111111','222222'].map(phone=>({phone,key:accountKey(phone)}));
  const jobs=accounts.map((a,i)=>({id:String(i),account:a.key,status:'watching',remote:{sid:1,baseId:2},scheme:{destination:'submit'},plan:{partial:false},artifacts:{}}));
  const q=new AutomationQueue({store:{state:{jobs,paused:true},save(){}},getAccount:()=>accounts[0].phone,getAccounts:()=>accounts,getSettings:()=>({}),withSite:async(fn,phone)=>fn({listSubmissions:async()=>[{sid:1,id:2,status:phone===accounts[0].phone?'contracted':'reviewing'}]})});
  await q.syncReviews({manual:true});assert.equal(jobs[0].status,'done');assert.equal(jobs[1].status,'watching');
});
