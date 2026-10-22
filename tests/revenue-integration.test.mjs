import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJSON} from '../automation-store.mjs';
import {resolvePen,fetchConcurrent} from '../studio-policy.mjs';
const source=fs.readFileSync(new URL('../main.mjs',import.meta.url),'utf8');

test('new revenue snapshots still backfill history, subsequent refreshes reuse cache, and accounts stay isolated',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unified-revenue-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let phone='account-a',fullCalls=0;
 const date=n=>new Date(Date.now()+8*3600e3-n*86400e3).toISOString().slice(0,10);
 const settings={excludeRejectedRevenue:true,revenueConcurrency:3,revenueDelayMs:0};
 const runner={ensureLogin:async()=>{},listSubmissions:async()=>[{id:11,sid:1,title:'同名书',penName:phone==='account-a'?'甲':'乙',status:'contracted'}, {id:22,sid:2,title:'拒稿书',status:'rejected'}],
  listRevenue:async()=>[{id:11,total:phone==='account-a'?12:4,latestOk:true,latestDate:date(1),latestRev:2,latestReaders:5}],
  fetchRevenueHistories:async(ids,opts)=>{fullCalls++;return fetchConcurrent(ids,async()=>({items:[{date:date(2),r:phone==='account-a'?10:2,f:1,ok:true},{date:date(1),r:2,f:5,ok:true}]}),opts);}};
 const handlers=new Map();
 const context=vm.createContext({fs,path,crypto,atomicJSON,resolvePen,Date,Map,Set,Object,Number,JSON,console,
  ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},saveSettings:patch=>Object.assign(settings,patch),
  userPath:(...p)=>path.join(dir,...p),loadCredentials:()=>({phone}),loadSettings:()=>settings,
  getRunner:async()=>runner,getAutomation:()=>({store:{state:{jobs:[]}}}),send:()=>{},log:()=>{},busy:false,automationSiteBusy:false});
 vm.runInContext(source.slice(source.indexOf('const revAccount ='),source.indexOf("ipcMain.handle('revenue-cache'")),context);
 const first=await vm.runInContext('buildRevenueSummary()',context);assert.equal(first.ok,true,first.error);assert.equal(first.books.length,1);assert.equal(first.series.length,2);assert.equal(first.byPenName['甲'].total,12);assert.equal(fullCalls,1);
 const again=await vm.runInContext('buildRevenueSummary()',context);assert.equal(again.ok,true);assert.equal(fullCalls,1);
 phone='account-b';const second=await vm.runInContext('buildRevenueSummary()',context);assert.equal(second.ok,true,second.error);assert.equal(second.totalRevenue,4);assert.equal(second.byPenName['乙'].total,4);assert.equal(fullCalls,2);
 assert.equal(fs.readdirSync(path.join(dir,'profiles')).filter(n=>n.startsWith('revenue-summary-')).length,2);
 assert.equal(handlers.get('delete-revenue')({}, {ids:['1']}).ok,true);
 const deleted=await vm.runInContext('buildRevenueSummary()',context);assert.equal(deleted.books.length,0);
 phone='account-a';const isolated=await vm.runInContext('buildRevenueSummary()',context);assert.equal(isolated.books.length,1);
});
