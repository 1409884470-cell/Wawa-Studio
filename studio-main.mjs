import fs from 'node:fs';
import path from 'node:path';
import { WriterClient } from './writer-client.mjs';
import { atomicJSON } from './automation-store.mjs';
import { penStats } from './studio-policy.mjs';
import { aiPing, imageAiPing } from './auto.mjs';
import { PROMPTS } from './prompt-catalog.mjs';
import { buildCoverPrompt } from './cover-prompt.mjs';

export function attachStudio({app,ipcMain,dialog,root,userPath,getAutomation,loadSettings,saveSettings,send,loadCredentials}) {
  const writer=new WriterClient(root,userPath('writer-data'));
  const file=userPath('data','studio.json');
  let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{enabled:false,links:{}};
  state.links??={};state.enabled=loadSettings().resumeOnStartup===true&&state.enabled;
  const save=()=>atomicJSON(file,state);
  let bridging=false;
  async function connectCompleted(){
    if(bridging||!state.enabled)return;
    bridging=true;
    try {
      const snap=await writer.call('snapshot');
      if(!loadSettings().autoSubmitCompleted)return;
      for(const book of snap.queue.items){
        if(book.status!=='completed'||state.links[book.id]?.jobId||state.links[book.id]?.deleted||state.links[book.id]?.deleting)continue;
        try {
          const q=getAutomation();
          const previous=q.store.state.jobs.find(j=>j.writerId===book.id);
          if(previous){state.links[book.id]={jobId:previous.id};save();continue;}
          const file=await writer.call('complete-export',{id:book.id});
          if(state.links[book.id]?.deleted||state.links[book.id]?.deleting)continue;
          const scheme=q.store.state.schemes.find(s=>s.name===q.store.state.defaultScheme)||q.store.state.schemes[0];
          const result=await q.import([file],{...scheme,autoStart:false},{title:book.book_name,writerId:book.id});
          if(result.errors.length)throw new Error(result.errors[0].error);
          const id=result.added[0]||result.duplicates[0]?.id;if(!id)throw new Error('未创建投稿任务');
          if(state.links[book.id]?.deleted||state.links[book.id]?.deleting){q.control(id,'delete');continue;}
          const job=q.job(id);if(job.writerId&&job.writerId!==book.id)throw new Error('该内容已被另一作品使用，已阻止重复投稿');
          job.writerId=book.id;job.platformStyle=book.platform_style;job.titleStyle=book.title_style;job.batch=book.created_at?.slice(0,10);q.save();
          state.links[book.id]={jobId:id};save();
          if(state.enabled&&!q.store.state.paused)q.pump();
        }catch(e){state.links[book.id]={...state.links[book.id],error:e.message};save();}
      }
      if(!getAutomation().store.state.paused) getAutomation().pump();
    }catch(e){state.error=e.message;send('studio-error',e.message);}finally{bridging=false;}
  }
  ipcMain.handle('studio',async(_event,{method,data={}}={})=>{
    try {
      if(method==='snapshot'){
        const snap=await writer.call('snapshot'),q=getAutomation().snapshot();
        return {ok:true,data:{...snap,automation:q,enabled:state.enabled,links:state.links,error:state.error,
          pens:loadSettings().penNames.map(p=>({...p,...penStats(p,q.jobs)}))}};
      }
      if(method==='settings')return {ok:true,data:{settings:loadSettings(),writer:await writer.call('config'),defaults:await writer.call('defaults'),prompts:PROMPTS,labels:JSON.parse(fs.readFileSync(path.join(root,'engine','prompt-labels.json'),'utf8'))}};
      if(method==='prompt-usage'){
        const [kind,key]=String(data.id||'').split(':');let usage={};
        if(kind==='writer')usage=await writer.call('prompt-usage');
        else try{usage=JSON.parse(fs.readFileSync(userPath('data','prompt-usage.json'),'utf8'));}catch{}
        return {ok:true,data:usage[kind==='setting'?(key==='deaiPrompt'?'rewrite':'cover-final'):key]||null};
      }
      if(method==='save-prompt'){
        const [kind,key]=String(data.id||'').split(':');if(typeof data.value!=='string'||data.value.length>20000)throw new Error('提示词最多20000字');
        if(kind==='writer'){const defaults=await writer.call('defaults');if(!Object.hasOwn(defaults.prompts,key))throw new Error('未知写作提示词');await writer.call('save-config',{prompts:{[key]:data.value}});}
        else if(kind==='post'){if(!Object.hasOwn(PROMPTS,key))throw new Error('未知投稿提示词');saveSettings({promptTemplates:{...loadSettings().promptTemplates,[key]:data.value}});}
        else if(kind==='setting'&&['coverTemplate','coverLayout','coverMood','coverExtra','deaiPrompt'].includes(key))saveSettings({[key]:data.value});
        else throw new Error('未知提示词');
        const q=getAutomation(),result=data.apply&&kind!=='writer'?q.applyPrompt(key):{updated:0,skipped:0};if(result.updated&&!q.store.state.paused)void q.pump();return {ok:true,data:result};
      }
      if(method==='cover-preview')return {ok:true,data:buildCoverPrompt({...loadSettings(),...data},{title:'示例小说',penName:'示例笔名',channel:'女频',genre:'都市',style:'清新人物插画',scene:'示例：主角侧身拆开关键来信，窗边自然光照亮人物，背景仅保留简洁的旧书店轮廓。实际生成按每本书的剧情分析变化。'})};
      if(method==='start'){
        state.enabled=true;save();delete state.error;
        const snapshot=await writer.call('snapshot');
        if(snapshot.queue.items.some(b=>['paused','pending','retry_wait'].includes(b.status)))await writer.call('start');
        getAutomation().resume();void connectCompleted();return {ok:true};
      }
      if(method==='pause'){state.enabled=false;save();getAutomation().pause();await writer.call('pause');return {ok:true};}
      if(method==='sync-completed'){state.enabled=true;save();await connectCompleted();return {ok:true};}
      if(method==='export'){
        const result=await writer.call('export',data),pick=await dialog.showSaveDialog({defaultPath:result.name,filters:[{name:'小说正文',extensions:['txt']}]});
        if(!pick.canceled)fs.writeFileSync(pick.filePath,result.content,'utf8');return {ok:true,canceled:pick.canceled};
      }
      if(method==='batch-export'){
        if(!Array.isArray(data.ids)||!data.ids.length||data.ids.length>500)throw new Error('请选择1至500本作品');
        const pick=await dialog.showOpenDialog({properties:['openDirectory','createDirectory']});if(pick.canceled)return {ok:true,data:{canceled:true}};
        const results=[];
        for(const selection of new Set(data.ids))try{
          const [kind,id]=String(selection).split(':');if(!/^[a-zA-Z0-9_-]{1,120}$/.test(id))throw new Error('无效作品ID');let result;
          if(kind==='book')result=await writer.call('export',{id});
          else if(kind==='post'){const j=getAutomation().job(id);result={name:j.title+'.txt',content:getAutomation().chapters(j).map(c=>c.name+'\n'+c.text).join('\n\n')};}
          else throw new Error('无效作品');
          const name=String(result.name).replace(/[\\/:*?"<>|]/g,'_').replace(/\.txt$/i,'')+'__'+id+'.txt';
          fs.writeFileSync(path.join(pick.filePaths[0],name),result.content,'utf8');results.push({id:selection,success:true});
        }catch(e){results.push({id:selection,success:false,error:e.message});}
        return {ok:true,data:{results}};
      }
      if(method==='restore-titles'){
        const snap=await writer.call('snapshot'),q=getAutomation();let restored=0,skipped=0;
        for(const j of q.store.state.jobs.filter(j=>j.writerId&&!j.hidden)){
          const b=snap.queue.items.find(b=>b.id===j.writerId)||snap.library.find(b=>b.id===j.writerId);
          if(!b||j.originalTitle===b.book_name)continue;
          if(q.active.has(j.id)||j.remote||j.uploadIntent||j.repairSource){skipped++;continue;}
          q.control(j.id,'source-title',{title:b.book_name});restored++;
        }
        return {ok:true,data:{restored,skipped}};
      }
      if(method==='ai-test'){
        const {role,baseUrl,model,apiKey}=data;
        if(!['writer','text','image'].includes(role))throw new Error('未知模型用途');
        const before=Date.now();let message;
        if(role==='writer')message=await writer.call('test-api',{baseUrl,model,apiKey});
        else{
          const s=loadSettings(),image=role==='image';
          const cfg=image?{imgApiBaseUrl:baseUrl,imgApiKey:apiKey||s.imgApiKey,imageModel:model}:{apiBaseUrl:baseUrl,apiKey:apiKey||s.apiKey,textModel:model};
          const url=new URL(baseUrl);if(!['http:','https:'].includes(url.protocol)||!model?.trim())throw new Error('请填写接口地址和模型');
          message=image?(await imageAiPing(cfg),'图像接口已返回测试图片'):await aiPing(cfg);
        }
        return {ok:true,data:{message,elapsedMs:Date.now()-before}};
      }
      if(method==='ai-save'){
        const keys={text:['apiBaseUrl','textModel','apiKey'],image:['imgApiBaseUrl','imageModel','imgApiKey']};
        const patch={},current=loadSettings();
        for(const role of ['writer','text','image']){
          const item=data[role];if(!item)continue;
          if(!item.clear){const url=new URL(item.baseUrl);if(!['http:','https:'].includes(url.protocol)||!item.model?.trim())throw new Error('请填写有效接口地址和模型');}
          if(role!=='writer'){const [base,model,key]=keys[role];Object.assign(patch,{[base]:item.clear?'':item.baseUrl.trim(),[model]:item.clear?'':item.model.trim(),[key]:item.clear?'':item.apiKey||current[key]||''});}
        }
        if(data.writer){const item=data.writer;
          await writer.call('save-config',item.clear?{clear_api_key:true,api:{base_url:'https://api.deepseek.com/v1',model:'deepseek-chat',api_key:''}}:{api:{base_url:item.baseUrl.trim(),model:item.model.trim(),api_key:item.apiKey||''}});
        }
        saveSettings(patch);return {ok:true};
      }
      if(method==='delete-pens'){
        if(!Array.isArray(data.ids)||data.ids.length>1000)throw new Error('请选择笔名');
        const settings=loadSettings(),q=getAutomation(),errors=[],deleted=[];
        for(const id of new Set(data.ids)){
          const p=settings.penNames.find(p=>p.id===id);if(!p)continue;
          if(q.store.state.jobs.some(j=>j.penId===id&&!j.hidden&&!j.remote&&!j.uploadIntent&&j.status!=='canceled'))errors.push({id,error:p.name+' 已分配给未投稿作品，请先删除对应任务'});
          else deleted.push(id);
        }
        saveSettings({penNames:settings.penNames.filter(p=>!deleted.includes(p.id)),penLibraryVersion:1,penName:''});
        return {ok:true,data:{deleted,errors}};
      }
      if(method==='delete-items'){
        if(!Array.isArray(data.ids)||!data.ids.length||data.ids.length>500||!['books','post'].includes(data.kind))throw new Error('请选择1至500条记录');
        if(data.ids.some(id=>typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,120}$/.test(id)||['__proto__','constructor','prototype'].includes(id)))throw new Error('记录ID无效');
        const q=getAutomation(),results=[];
        if(data.kind==='post'){
          for(const id of new Set(data.ids)){try{q.control(id,'delete');results.push({id,success:true});}catch(e){results.push({id,success:false,error:e.message});}}
        }else{
          for(const id of new Set(data.ids)){
            const previous=state.links[id];state.links[id]={...previous,deleting:true};save();
            try{
              await writer.call('action',{id,action:'erase'});
              for(const j of q.store.state.jobs.filter(j=>j.writerId===id))q.control(j.id,'delete');
              state.links[id]={...previous,deleted:true};results.push({id,success:true});
            }catch(e){state.links[id]=previous||{};results.push({id,success:false,error:e.message});}
            save();
          }
        }
        return {ok:true,data:results};
      }
      if(method==='match-pen'){
        if(!/^\d+$/.test(String(data.sid))||typeof data.name!=='string'||!data.name.trim()||data.name.length>40)throw new Error('作品ID或笔名无效');
        const s=loadSettings(),key=loadCredentials()?.phone||'';
        const maps=s.revenuePenMaps||{};maps[key]={...maps[key],[data.sid]:data.name.trim()};saveSettings({revenuePenMaps:maps});return {ok:true};
      }
      if(['config','save-config','defaults','add','action','batch','project','chapter','save-chapter','ideas'].includes(method))return {ok:true,data:await writer.call(method,data)};
      throw new Error('未知操作');
    }catch(e){return {ok:false,error:e.message};}
  });
  const timer=setInterval(connectCompleted,4000);timer.unref();
  if(state.enabled){writer.call('start').catch(()=>{});getAutomation().resume();}
  app.on('before-quit',()=>{clearInterval(timer);save();writer.close();});
  return {writer,connectCompleted};
}
