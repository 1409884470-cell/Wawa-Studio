import crypto from 'node:crypto';
import { COVER_MOOD, COVER_FIXED } from './cover-prompt.mjs';

export const STUDIO_DEFAULTS = {
  qualityResubmits: 1, otherResubmits: 0, unknownResubmits: 0, rewriteConcurrency:3, reviewPollMinutes:10,
  penNames: [], penMode: 'balanced', coverExtra: '', coverMood:COVER_MOOD, coverLayout:COVER_FIXED,
  revenueConcurrency: 3, revenueDelayMs: 300, revenueRefreshMinutes: 0,
  excludeRejectedRevenue: true, autoSubmitCompleted: true, resumeOnStartup: false,
  submissionConcurrency: 2, submissionDailyLimit: 0, submissionGapSeconds: 0,
};
export function validateStudio(input) {
  const s={...STUDIO_DEFAULTS,...input};
  for(const [k,max] of Object.entries({submissionConcurrency:6,qualityResubmits:20,otherResubmits:20,unknownResubmits:20,revenueConcurrency:6,revenueDelayMs:30000,revenueRefreshMinutes:1440,submissionDailyLimit:10000,submissionGapSeconds:86400,rewriteConcurrency:6,reviewPollMinutes:1440})) {
    const n=Number(s[k]);if(!Number.isInteger(n)||n<(['submissionConcurrency','revenueConcurrency','rewriteConcurrency'].includes(k)?1:k==='reviewPollMinutes'?2:0)||n>max)throw new Error(`设置超出范围：${k}`);s[k]=n;
  }
  for(const k of ['excludeRejectedRevenue','autoSubmitCompleted','resumeOnStartup'])if(typeof s[k]!=='boolean')throw new Error(`设置必须为开关：${k}`);
  if(!['balanced','roundRobin'].includes(s.penMode))throw new Error('笔名分配方式无效');
  if(!Array.isArray(s.penNames)||s.penNames.length>1000)throw new Error('笔名库最多1000条');
  const seen=new Set(),ids=new Set();
  s.penNames=s.penNames.map(p=>{
    const name=String(p.name||'').trim(),account=String(p.account||'').trim();
    if(!name||name.length>40||seen.has(account+'|'+name))throw new Error('笔名为空、过长或重复');seen.add(account+'|'+name);
    const q={...p,id:p.id||crypto.randomUUID(),name,account,enabled:p.enabled!==false};
    if(ids.has(q.id))throw new Error('笔名标识重复');ids.add(q.id);
    for(const k of ['limit','dailyLimit','gapMinutes']){q[k]=Number(p[k]||0);if(!Number.isInteger(q[k])||q[k]<0||q[k]>100000)throw new Error('笔名额度或间隔无效');}
    q.channel=String(p.channel||'');q.genre=String(p.genre||'');return q;
  });
  if(typeof s.coverExtra!=='string'||s.coverExtra.length>20000)throw new Error('附加封面提示词最多20000字');
  if(typeof s.coverLayout!=='string'||s.coverLayout.length>20000)throw new Error('封面排版要求最多20000字');
  if(typeof s.coverMood!=='string'||s.coverMood.length>20000)throw new Error('封面明暗与去模板要求最多20000字');
  return s;
}
const today=at=>new Date(at+8*3600e3).toISOString().slice(0,10);
export function penStats(p,jobs,at=Date.now()) {
  const assigned=jobs.filter(j=>j.penId===p.id && (j.status!=='canceled'||j.uploadIntent||j.remote||j.submissionEvents?.length));
  const uploaded=assigned.filter(j=>j.uploadIntent||j.remote||j.submissionEvents?.length);
  const times=uploaded.flatMap(j=>(j.submissionEvents||[j.uploadIntent?.at||j.remoteConfirmedAt||j.createdAt]).map(t=>Date.parse(t))).filter(Number.isFinite);
  return {reserved:assigned.length-uploaded.length,total:assigned.length,submitted:uploaded.length,today:times.filter(t=>today(t)===today(at)).length,last:Math.max(0,...times)};
}
export function choosePen(settings,jobs,job,account,at=Date.now()) {
  const existing=settings.penNames?.find(p=>p.id===job.penId);if(job.penId)return existing||{id:job.penId,name:job.settings.penName};
  const pens=(settings.penNames||[]).filter(p=>p.enabled!==false&&(!p.account||p.account===account)&&(!p.channel||p.channel===job.analysis?.channel)&&(!p.genre||job.analysis?.novelType?.join('/').includes(p.genre)))
    .map(p=>({p,s:penStats(p,jobs,at)})).filter(({p,s})=>!p.limit||s.total<p.limit);
  pens.sort((a,b)=>settings.penMode==='roundRobin'?(a.s.last-b.s.last||a.s.total-b.s.total):(a.s.total-b.s.total||a.s.last-b.s.last));
  return pens[0]?.p||null;
}
export function resubmitLimit(settings,kind){return Number(kind==='generic'||kind==='story'?settings.qualityResubmits??1:kind==='unknown'?settings.unknownResubmits??0:settings.otherResubmits??0);}
export function resolvePen(sub,jobs,mapping={}) {
  return sub.penName?.trim()||mapping[String(sub.sid)]||jobs.find(j=>String(j.remote?.sid)===String(sub.sid)||j.oldSubmissions?.some(x=>String(x.sid)===String(sub.sid)))?.settings.penName||'未匹配';
}
export async function fetchConcurrent(ids,fetchOne,{concurrency=3,delayMs=300,onProgress,onResult,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const out=[];let cursor=0,done=0,throttled=false;
  async function worker(index){
    while(cursor<ids.length){
      if(throttled&&index>0)return;
      const sid=ids[cursor++];let result;
      try {result={sid,data:await fetchOne(sid)};}
      catch(e){result={sid,error:String(e.message||e)};if(/429|限流|频繁|too many/i.test(result.error)){throttled=true;await sleep(Math.max(3000,delayMs*4));}}
      out.push(result);await onResult?.(result);onProgress?.(++done,ids.length);
      if(cursor<ids.length)await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({length:Math.min(Math.max(1,concurrency),ids.length)},(_,i)=>worker(i)));return out;
}
