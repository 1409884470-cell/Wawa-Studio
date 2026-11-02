import fs from 'node:fs';
import crypto from 'node:crypto';
import { atomicJSON } from './automation-store.mjs';

export const quotaDay = (at=Date.now()) => new Date(at+8*3600e3).toISOString().slice(0,10);
export const nextQuotaDay = (at=Date.now()) => Date.parse(quotaDay(at)+'T00:00:00+08:00')+86400e3;
export const dailyLimit = settings => Math.min(3,Math.max(1,Number(settings.submissionDailyLimit)||3));
export function openQuota(file,{settings=()=>({}),clock=Date.now}={}) {
  const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,events:[],blocked:{}};
  if(state.version!==1||!Array.isArray(state.events)||!state.blocked)throw new Error('投稿额度记录损坏，请恢复备份');
  const save=()=>atomicJSON(file,state);
  function stats(account){const day=quotaDay(clock()),limit=dailyLimit(settings()),used=state.events.filter(e=>e.account===account&&quotaDay(e.at)===day).length;
    return {used,limit,remaining:state.blocked[account]===day?0:Math.max(0,limit-used),resetAt:nextQuotaDay(clock())};}
  function check(account){const s=stats(account);if(!s.remaining){const e=new Error(`今日投稿额度已用完（${s.used}/${s.limit}），等待次日`);e.code='DAILY_QUOTA';e.waiting=true;e.retryAt=s.resetAt;throw e;}return s;}
  return {stats,check,
    reserve(account,details={}){check(account);const event={...details,id:crypto.randomUUID(),account,at:clock()};state.events.push(event);try{save();}catch(e){state.events.pop();throw e;}return event.id;},
    block(account){state.blocked[account]=quotaDay(clock());save();},
    migrate(jobs){if(state.migrated)return;for(const j of jobs){if(j.scheme?.destination!=='submit')continue;
      // Legacy upload events include unsuccessful/uncertain attempts; conservatively retain them.
      const times=j.submissionEvents?.length?j.submissionEvents:[j.submitIntent?.at||j.submittedAt||j.uploadIntent?.at].filter(Boolean);
      for(const time of times){const at=Date.parse(time);if(Number.isFinite(at))state.events.push({id:crypto.randomUUID(),account:j.account,at,legacy:true,jobId:j.id});}
    }state.migrated=true;save();}
  };
}

export function pickAccount(accounts,jobs,stats){
  const eligible=accounts.filter(a=>a.sessionSaved&&a.enabled!==false).map(a=>{
    const reserved=jobs.filter(j=>!j.hidden&&j.account===a.key&&!j.submitIntent&&j.scheme?.destination!=='package'&&['queued','running','importing','waiting'].includes(j.status)).length;
    const s=stats(a.key);return {...a,available:s.remaining-reserved,reserved};
  });
  eligible.sort((a,b)=>b.available-a.available||a.reserved-b.reserved||a.phone.localeCompare(b.phone));
  return eligible[0]||null;
}
