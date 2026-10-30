import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'login470-'));
process.env.WAWAWA_DATA_DIR=data;
const {createRunner,SESSION_FILE}=await import('../core.mjs');
test.after(()=>fs.rmSync(data,{recursive:true,force:true}));
function fixture(){
 let logged=false,gotos=0,mode,closed=false;const listeners={};
 const page={goto:async()=>{gotos++;},bringToFront:async()=>{},isClosed:()=>closed,locator:()=>({waitFor:async()=>{if(!logged)throw Error('not logged');}}),evaluate:async()=>({localStorage:{test:'session'},cookie:'test=1'})};
 const ctx={pages:()=>[page],on:(name,fn)=>listeners[name]=fn,close:async()=>{closed=true;listeners.close?.();}};
 let notices=0;const runner=createRunner({browserType:{launchPersistentContext:async(dir,opts)=>{mode=opts.headless;return ctx;}},onAuthRequired:()=>notices++});
 return {runner,get gotos(){return gotos;},get mode(){return mode;},login:()=>logged=true};
}
test('background login fails promptly and repeated calls do not navigate or try passwords',async()=>{
 const f=fixture();await f.runner.launch();await assert.rejects(f.runner.ensureLogin(),e=>e.code==='AUTH_REQUIRED');const n=f.gotos;
 await assert.rejects(f.runner.ensureLogin(),e=>e.code==='AUTH_REQUIRED');assert.equal(f.gotos,n);await f.runner.close();
});
test('manual browser is visible; login must verify before saving and saved session is usable',async()=>{
 const f=fixture();await f.runner.openLogin();assert.equal(f.mode,false);
 await assert.rejects(f.runner.saveLoginSession(),/尚未登录/);assert.equal(fs.existsSync(SESSION_FILE),false);
 f.login();await f.runner.saveLoginSession();assert.equal(JSON.parse(fs.readFileSync(SESSION_FILE)).localStorage.test,'session');await f.runner.ensureLogin();await f.runner.close();
 await assert.rejects(f.runner.saveLoginSession(),/打开登录浏览器/);
 fs.unlinkSync(SESSION_FILE);
});
test('disk failure saving a session cannot report login saved',async()=>{
 const f=fixture();await f.runner.openLogin();f.login();fs.mkdirSync(SESSION_FILE);
 await assert.rejects(f.runner.saveLoginSession(),/保存失败/);await f.runner.close();fs.rmdirSync(SESSION_FILE);
});
import vm from 'node:vm';
test('saving login resumes only current-account auth jobs and selected review tracking',async()=>{
 const jobs=[{id:'blocked',account:'A',status:'attention',error:{code:'AUTH_REQUIRED'}},{id:'other',account:'B',status:'attention',error:{code:'AUTH_REQUIRED'}},{id:'watch',account:'A',status:'watching'}];let handler,started=[];
 const source=fs.readFileSync(new URL('../main.mjs',import.meta.url),'utf8');
 const context=vm.createContext({ipcMain:{handle:(name,fn)=>handler=fn},manualLoginOpen:true,platformLoginRequired:true,runner:{running:true,saveLoginSession:async()=>{},close:async()=>{}},getAutomation:()=>({store:{state:{jobs}},startJobs:ids=>started=ids}),accountKey:x=>x,loadCredentials:()=>({phone:'A'}),loginResumeIds:new Set(['watch','other']),send:()=>{}});
 vm.runInContext(source.slice(source.indexOf("ipcMain.handle('platform-login-save'"),source.indexOf("ipcMain.handle('site-works'")),context);
 assert.equal((await handler()).ok,true);assert.deepEqual([...started],['blocked']);assert.equal(jobs[1].status,'attention');assert.equal(jobs[2].requestedStart,true);
});
