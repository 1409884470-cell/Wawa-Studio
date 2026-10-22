import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {manuscriptTitle,parseTxt} from '../auto.mjs';
import {createPackagingAI,validateAnalysis} from '../packaging-ai.mjs';
import {WriterClient} from '../writer-client.mjs';

const site={tree:{男频:{都市:['都市生活']}},tags:['悬疑','脑洞']};
const analysis={summary:'主角追查失踪事件',channel:'男频',novelType:['男频','都市','都市生活'],tags:['悬疑','库外词'],storyType:'long',finished:'finished',confidence:90};
test('invalid categories fall back locally to brain fiction in the same broad category or channel',async()=>{
 const catalog=JSON.parse(fs.readFileSync(new URL('../data/categories.json',import.meta.url),'utf8'));
 const a=(channel,novelType)=>({...analysis,channel,novelType,tags:[catalog.tags[0]]});
 assert.deepEqual(validateAnalysis(a('男频',['男频','历史军事','库外类型']),catalog).novelType,['男频','历史军事','历史脑洞']);
 assert.deepEqual(validateAnalysis(a('男频',['男频','未知大类','未知']),catalog).novelType,['男频','都市小说','都市脑洞']);
 assert.deepEqual(validateAnalysis(a('女频',['女频','古装言情','未知']),catalog).novelType,['女频','脑洞小说','脑洞小说']);
 assert.deepEqual(validateAnalysis(a('女频',['女频','都市言情','未知']),catalog).novelType,['女频','都市言情','现言脑洞']);
 assert.deepEqual(validateAnalysis(a('男频',['男频','都市小说','都市生活']),catalog).novelType,['男频','都市小说','都市生活']);
 let calls=0;const ai=createPackagingAI({settings:{},ask:async()=>{calls++;return JSON.stringify(a('男频',['男频','科幻末世','未知']));}});
 assert.deepEqual((await ai.analyze([{name:'一',text:'正文'}],catalog,{})).novelType,['男频','科幻末世','科幻脑洞']);
 assert.equal(calls,1);
 assert.throws(()=>validateAnalysis({...analysis,tags:['悬疑'],novelType:[]},site),/没有脑洞类目/);
});
test('only a manuscript header can override its filename; books mentioned in chapters never become the title',()=>{
 assert.equal(manuscriptTitle('第一章 来信\n他拿起一本小说。\n《无关书名》\n书名：另一本','原名'),'原名');
 assert.equal(manuscriptTitle('书名：真正书名\n简介：故事\n第一章 来信\n书名：无关','文件名'),'真正书名');
 assert.equal(manuscriptTitle('《封面书名》\n目录\n第一章 来信','文件名'),'封面书名');
});
test('mixed tags are cleaned without another request, all-invalid tags use bounded matching with custom prompt',async()=>{
 const sent=[],used=[];let mode='mixed';
 const ai=createPackagingAI({settings:{promptTemplates:{analysis:'ANALYZE {v3}',tagMatch:'MATCH {v1} {v0}'}},onPrompt:k=>used.push(k),ask:async messages=>{
  sent.push(messages.at(-1).content);
  if(sent.at(-1).startsWith('MATCH'))return JSON.stringify({tags:[' 脑洞 ','另一个库外词']});
  return JSON.stringify({...analysis,tags:mode==='mixed'?analysis.tags:['无效']});
 }});
 assert.deepEqual((await ai.analyze([{name:'第一章',text:'故事'}],site,{})).tags,['悬疑']);assert.equal(sent.length,1);
 mode='invalid';assert.deepEqual((await ai.analyze([{name:'第一章',text:'故事'}],site,{})).tags,['脑洞']);assert.equal(sent.length,3);assert.ok(used.includes('tagMatch'));
 let attempts=0;const bad=createPackagingAI({settings:{},ask:async()=>{attempts++;return JSON.stringify({tags:['不存在']});}});
 await assert.rejects(bad.repairTags({...analysis,tags:[]},site),/两次/);assert.equal(attempts,2);
});
test('every packaging prompt override reaches the actual request, with conditional stages tested explicitly',async()=>{
 const templates=Object.fromEntries(['analysis','score','title','intro','coverStyle','coverScene','entry','rewrite'].map(k=>[k,k+'-CUSTOM {v0} {v1} {v2} {v3}']));const seen=[];
 const ai=createPackagingAI({settings:{promptTemplates:templates},ask:async msgs=>{
  const prompt=msgs.at(-1).content;seen.push(prompt);const k=prompt.split('-CUSTOM')[0];
  return k==='rewrite'?'修订正文'.repeat(30):JSON.stringify({analysis,score:{scores:{contentFit:20,hook:45,genre:10,readability:15,distinctive:10},reason:'理由'},title:{title:'新书名'},intro:{intro:'主角追查旧城事件，最终找回失物，解开往日谜团。'},coverStyle:{style:'插画'},coverScene:{scene:'主角在阳光下拆开来信'},entry:{name:'征文',confidence:95}}[k]);
 }});
 const a=await ai.analyze([{name:'一',text:'正文'}],site,{});await ai.score('书名',a);await ai.title(a,[]);await ai.intro('书名',a,'风格');await ai.prompt('书名',a,'风格','笔名');await ai.entry(a,[{name:'征文'}]);await ai.rewriteChapter({name:'一',text:'原始正文'.repeat(30)},a,'要求');
 for(const k of Object.keys(templates))assert.ok(seen.some(s=>s.startsWith(k+'-CUSTOM')),k);
});
test('writer uses saved brainstorm prompt, remains responsive during model calls, and tests unsaved API without persisting it',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio43-')),root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),client=new WriterClient(root,dir);
 const requests=[];let release,started;const entered=new Promise(r=>started=r);
 const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{const data=JSON.parse(body);requests.push(data);
  const finish=value=>{if(res.writableEnded)return;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}));};
  if(data.messages.at(-1).content.includes('IDEA-CUSTOM')){release=()=>finish({ideas:[{book_name:'书名',core_premise:'剧情'}]});started();}else finish('正常');
 });});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{release?.();client.close();await new Promise(r=>server.close(r));setTimeout(()=>fs.rmSync(dir,{recursive:true,force:true}),200);});
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 await client.call('save-config',{api:{base_url:baseUrl,model:'saved-model',api_key:'test-key',stream:false},prompts:{ideas:'IDEA-CUSTOM {v0}'}});
 const pending=client.call('ideas',{count:1});await Promise.race([entered,pending.then(()=>{throw Error('ideas returned before request');})]);
 let timer;try{await Promise.race([client.call('snapshot'),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('snapshot blocked by ideas')),1500))]);}finally{clearTimeout(timer);release();}
 assert.equal((await pending).ideas[0].book_name,'书名');assert.match(requests[0].messages.at(-1).content,/IDEA-CUSTOM 1/);
 assert.equal(await client.call('test-api',{baseUrl,model:'unsaved-model',apiKey:''}),'正常');assert.equal(requests.at(-1).model,'unsaved-model');assert.equal((await client.call('config')).api.model,'saved-model');
});
