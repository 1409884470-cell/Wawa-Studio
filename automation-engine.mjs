import { hideSubmissionRecord } from './library-state.mjs';
import { choosePen, penStats, resubmitLimit } from './studio-policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseNovelFile } from './auto.mjs';
import { archiveManuscript, atomicJSON, validScheme } from './automation-store.mjs';
import { validateAnalysis } from './packaging-ai.mjs';
import { cleanManuscript, effectiveWords } from './manuscript-cleaner.mjs';
import { initialPlan, rejectionKind, submissionReview } from './submission-policy.mjs';

export const STAGES = ['inspect', 'catalog', 'analysis', 'title', 'intro', 'entry', 'prompt', 'cover', 'check', 'upload', 'format', 'submit', 'verify', 'done'];
const RECOVERY_NEXT = {'delete-rejected':'rewrite',rewrite:'check','append-rest':'submit-rest','submit-rest':'verify-rest','verify-rest':'done'};
const now = () => new Date().toISOString();
export const accountKey = phone => crypto.createHash('sha256').update(String(phone || '')).digest('hex');
export const publicSettings = settings => Object.fromEntries(Object.entries(settings).filter(([k]) => !/key|password|secret|token/i.test(k)));
const retryable = e => /HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|TimeoutError|network/i.test(e.message);

export class AutomationQueue {
  constructor({ store, root, getSettings, getAccount, getAccounts, chooseAccount, getSite, aiFactory, withSite, checkConfig, emit = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { store, root, getSettings, getAccount, getAccounts, chooseAccount, getSite, aiFactory, withSite, checkConfig, emit, sleep });
    this.running = false; this.active = new Set(); this.monitoring = false;
  }
  jobAccount(j) {
    if(this.getAccounts)return this.getAccounts().find(a=>a.key===j.account)?.phone||'';
    return this.getAccount();
  }
  assignAccount(j) {
    if(j.scheme?.destination==='package'||!this.chooseAccount||j.remote||j.uploadIntent||j.repairSource||j.accountAssigned)return;
    const a=this.chooseAccount(j);
    if(!a){const e=new Error('请添加已登录账号，并配置可用笔名');e.code='AUTH_REQUIRED';throw e;}
    if(j.account!==a.key)delete j.penId;
    j.account=a.key;j.accountAssigned=true;delete j.awaitingAccount;
  }
  snapshot() { return structuredClone({ ...this.store.state, accounts:this.getAccounts?.().map(a=>({key:a.key,name:a.name,phone:a.phone}))||[], running: this.running }); }
  save() { this.store.save(); this.emit(this.snapshot()); }
  job(id) { const j = this.store.state.jobs.find(x => x.id === id); if (!j) throw new Error('任务不存在'); return j; }
  applyPrompt(key) {
    const target=['analysis','tagMatch'].includes(key)?'analysis':['score','title'].includes(key)?'title':key==='intro'?'intro':key==='entry'?'entry':key.startsWith('cover')?'prompt':null;
    let updated=0,skipped=0;
    if(!target)return {updated,skipped};
    for(const j of this.store.state.jobs){
      if(j.hidden||j.status==='canceled')continue;
      if(this.active.has(j.id)||j.remote||j.uploadIntent||j.repairSource){skipped++;continue;}
      if(STAGES.indexOf(j.stage)<STAGES.indexOf(target))continue;
      if(target==='analysis')delete j.analysis;
      if(['analysis','title'].includes(target)){j.scores=[];delete j.titleScore;delete j.titleScoreVersion;delete j.pendingTitle;}
      if(['analysis','title','intro'].includes(target))delete j.intro;
      if(['analysis','title','entry'].includes(target)){delete j.entry;delete j.entryReason;}
      if(['analysis','title','prompt'].includes(target)){delete j.prompt;delete j.cover;delete j.remoteCover;j.coverRevision=(j.coverRevision||0)+1;}
      delete j.cfg;delete j.artifacts.package;delete j.result;
      j.stage=target;j.status='queued';j.error=null;j.attempts={};updated++;
      j.history.push({at:now(),stage:target,result:'updated',message:'应用已保存提示词：'+key});
    }
    this.save();return {updated,skipped};
  }
  async import(files, input, source = {}) {
    const scheme = validScheme(input), settings = this.getSettings();
    if (!Array.isArray(files) || !files.length || files.some(f => typeof f !== 'string')) throw new Error('请选择一个或多个小说文件');
    const added = [], duplicates = [], errors = [];
    for (const src of files) {
      try {
        const archived = archiveManuscript(src, path.join(this.root, 'sources'));
        const existing = this.store.state.jobs.find(j => j.hash === archived.hash);
        if (existing) { duplicates.push({ file: src, id: existing.id }); continue; }
        const j = { id: crypto.randomUUID(), ...archived, originalPath: src, title: archived.originalName, stage: 'inspect', status: 'importing',
          createdAt: now(), updatedAt: now(), scheme: structuredClone(scheme), settings: publicSettings(settings),
          sourceTitle: files.length===1?source.title:undefined, writerId: files.length===1?source.writerId:undefined, account: accountKey(this.getAccount()), history: [], scores: [], attempts: {}, artifacts: {}, overrides: {} };
        try{this.assignAccount(j);}catch{j.awaitingAccount=true;}
        this.store.state.jobs.push(j); this.save(); added.push(j.id);
        try {await this.step(j);j.history.push({stage:'inspect',at:now(),result:'ok'});j.stage='catalog';j.status='queued';}
        catch(e){j.status='attention';j.error={stage:'inspect',message:e.message,at:now()};}
        this.save();
      } catch (e) { errors.push({ file: src, error: e.message }); }
    }
    if (scheme.autoStart && added.length) this.resume();
    return { added, duplicates, errors };
  }
  startJobs(ids) {
    for(const id of ids){const j=this.job(id);if(j.status==='queued'&&!j.hidden)j.requestedStart=true;}
    this.save();void this.pump();
  }
  pause() { this.store.state.paused = true;for(const j of this.store.state.jobs)delete j.requestedStart;this.save(); }
  resume() { this.store.state.paused = false; this.save(); this.pump(); }
  control(id, action, patch) {
    const j = this.job(id);
    if(action==='delete'&&this.active.has(id)){j.deleteRequested=true;this.save();return;}
    if (this.active.has(id)) throw new Error('当前步骤执行中，请暂停并等本步骤结束');
    if (action === 'delete') {
      hideSubmissionRecord(j); this.save(); return;
    }
    if(action==='source-title'){
      if(j.remote||j.uploadIntent||j.repairSource)throw new Error('已有远端记录，不能修改原始书名');
      const title=String(patch?.title||'').trim();if(!title||title.length>100)throw new Error('原始书名无效');
      j.sourceTitle=title;j.originalTitle=title;j.title=title;j.scores=[];
      for(const key of ['intro','prompt','cover','cfg','pendingTitle','titleScore','remoteCover','result'])delete j[key];
      delete j.artifacts.package;j.stage=j.analysis?'title':j.catalog?'analysis':'catalog';j.status='queued';j.error=null;
      j.history.push({at:now(),stage:j.stage,result:'updated',message:'从写作项目恢复原始书名：'+title});this.save();return;
    }
    if(action==='refresh-cover'){
      if(j.remote||j.uploadIntent||j.repairSource)throw new Error('已有远端记录或修订进度，不能重做本地封面');
      if(!j.analysis||!j.title||!j.prompt)throw new Error('请先完成封面提示词步骤');
      for(const key of ['prompt','cover','remoteCover','cfg','result'])delete j[key];
      delete j.artifacts.package;j.stage='prompt';j.status='queued';j.error=null;j.attempts.prompt=0;j.attempts.cover=0;
      j.coverRevision=(j.coverRevision||0)+1;
      j.history.push({at:now(),stage:'prompt',result:'updated',message:'按当前提示词重新生成本书画面与封面'});
    }
    else if (action === 'edit-prompt') {
      if(['rewrite','delete-rejected'].includes(j.stage))throw new Error('请先完成正文修订，再调整封面提示词');
      if (j.remote || j.uploadIntent) throw new Error('已有远端记录，请先核对站内作品，不能修改本地包装');
      if (!patch?.prompt?.trim()) throw new Error('封面提示词不能为空');
      j.prompt = patch.prompt.trim(); delete j.cover; delete j.remoteCover; delete j.cfg; delete j.artifacts.package;
      j.stage = 'cover'; j.status = 'queued'; j.error = null; j.attempts.cover = 0;
    }
    else if(action==='confirm-format-retry'){
      if(j.stage!=='format'||!j.remote)throw new Error('当前没有待处理排版任务');
      delete j.formatIntent;delete j.formatTaskId;delete j.formatResult;delete j.formattedAt;
      j.status='queued';j.error=null;
    }
    else if (action === 'restart') {
      if (j.remote || j.uploadIntent || j.repairSource) throw new Error('已有远端记录或复投进度，请从当前步骤重试，避免重复投稿');
      Object.assign(j,{stage:'inspect',status:'queued',error:null,attempts:{},scores:[],artifacts:{},overrides:{}});
      for(const k of ['analysis','intro','prompt','cover','cfg','pendingTitle','titleScore','remoteCover','plan','warningsApproved','analysisApproved','sourceIntro'])delete j[k];
    }
    else if (action === 'cancel') { j.status = 'canceled';delete j.requestedStart; }
    else if (action === 'retry' || action === 'review') {
      if (j.status === 'done') throw new Error('已完成任务不能重新投稿');
      if (action === 'review') {
        if (j.remote || j.uploadIntent) throw new Error('已有远端创建记录或待核对请求，不能修改包装信息');
        if (j.repairSource && (patch?.analysis || patch?.useCurrentSettings)) throw new Error('修改复投期间保留原包装；请在AI设置配置可用模型后重试修订，或只调整首投章节范围');
        if (patch?.analysis) { j.analysis = validateAnalysis(patch.analysis, j.catalog || this.getSite()); j.analysisApproved = true; }
        if (patch?.entry) j.overrides.entry = String(patch.entry);
        if (['finished', 'serial'].includes(patch?.finished)) j.overrides.finished = patch.finished;
        if (typeof patch?.intro === 'string') { if(!patch.intro.trim() || patch.intro.trim().length>500)throw new Error('简介须为1至500字'); j.sourceIntro=patch.intro.trim();j.intro=j.sourceIntro; }
        if (patch?.ackWarnings) j.warningsApproved = true;
        if (patch?.useCurrentSettings) {
          const penName=j.settings.penName || j.cfg?.penName || j.settings.penNames?.find(p=>p.id===j.penId)?.name;
          const account=j.account||accountKey(this.getAccount());
          if(j.account!==account)delete j.penId;
          j.settings = {...publicSettings(this.getSettings()),penName:penName||''}; j.account = account;
        }
        if (patch?.firstSubmitMode) {
          j.scheme = validScheme({...j.scheme,firstSubmitMode:patch.firstSubmitMode,firstChapterCount:patch.firstChapterCount,firstMinChapters:patch.firstMinChapters,firstMaxChapters:patch.firstMaxChapters});
          if(j.stage!=='rewrite' && STAGES.indexOf(j.stage)>=STAGES.indexOf('check'))j.stage='check';
        }
        // 包装输入变更后清除依赖产物，保留稿件与已确认的分析。
        if (patch?.analysis || patch?.useCurrentSettings) {
          j.scores = []; delete j.intro; delete j.prompt; delete j.cover; delete j.cfg; delete j.pendingTitle;
          j.stage = j.analysis ? 'title' : j.stage === 'inspect' ? 'inspect' : j.catalog ? 'analysis' : 'catalog';
        }
        else if ((patch?.entry || patch?.finished) && STAGES.indexOf(j.stage) >= STAGES.indexOf('entry')) j.stage = 'entry';
        if (patch?.analysis || patch?.useCurrentSettings) {
          delete j.remoteCover; delete j.artifacts.package; delete j.titleScore;
          delete j.result; delete j.entryReason;
        }
      }
      j.status = 'queued'; j.error = null; j.attempts[j.stage] = 0;
    } else if (action === 'confirm-no-create') {
      if (!j.uploadIntent || j.remote) throw new Error('没有待核对的创建请求');
      delete j.uploadIntent; j.status = 'queued'; j.error = null;
    } else if (action === 'confirm-not-submitted') {
      if(!['submit','verify'].includes(j.stage))throw new Error('当前不在首投核对阶段');
      if (j.status === 'done') throw new Error('已完成任务不能重新投稿');
      if (!j.submitIntent || !j.remote) throw new Error('没有待核对的提交请求');
      delete j.submitIntent; j.stage = 'submit'; j.status = 'queued'; j.error = null;
    } else if(action==='confirm-rest-retry'){
      if(!j.remote||!['append-rest','submit-rest','verify-rest'].includes(j.stage))throw new Error('没有待核对的补传请求');
      if(j.stage==='append-rest')delete j.appendIntent;
      else {delete j.restSubmitIntent;j.stage='submit-rest';}
      j.status='queued';j.error=null;
    } else throw new Error('未知任务操作');
    j.updatedAt = now(); this.save();
    if (!this.store.state.paused) this.pump();
  }
  syncPenName(j) {
    if(j.hidden||j.status==='canceled')return;
    if(j.penId||this.getSettings().penLibraryOnly)return;
    if(this.getSettings().penNames?.length)return;
    const pen=this.getSettings().penName?.trim();
    if(!pen || j.remote || j.uploadIntent || j.repairSource || j.stage==='done' || j.settings.penName===pen)return;
    j.settings.penName=pen;
    if(STAGES.indexOf(j.stage)>=STAGES.indexOf('prompt')){
      delete j.prompt;delete j.cover;delete j.remoteCover;delete j.cfg;delete j.artifacts.package;
      j.stage='prompt';
    }
    j.history.push({at:now(),stage:j.stage,result:'updated',message:'使用新笔名，待上传封面将同步署名'});
  }
  updatePendingPenNames() {
    for(const j of this.store.state.jobs)if(!this.active.has(j.id))this.syncPenName(j);
    this.save();
  }
  ensurePenName(j) {
    const current=this.getSettings(),previous=j.settings.penName?.trim();
    const locked=j.remote||j.uploadIntent||j.repairSource;
    let name=previous;
    if(locked){
      name=j.cfg?.penName?.trim()||previous||j.settings.penNames?.find(p=>p.id===j.penId)?.name;
      if(!name)throw new Error('原投稿笔名缺失，请核对原作品署名后恢复任务备份');
    }else if(current.penLibraryOnly||current.penNames?.length){
      const eligible=p=>p&&p.enabled!==false&&(!p.account||p.account===this.jobAccount(j))&&(!p.channel||p.channel===j.analysis?.channel)&&(!p.genre||j.analysis?.novelType?.join('/').includes(p.genre));
      let p=current.penNames?.find(p=>p.id===j.penId);
      if(!eligible(p)){
        p=current.penNames?.find(p=>p.name===previous&&eligible(p)&&(!p.limit||penStats(p,this.store.state.jobs.filter(x=>x.id!==j.id)).total<p.limit));
        p??=choosePen(current,this.store.state.jobs.filter(x=>x.id!==j.id),{...j,penId:undefined},this.jobAccount(j));
      }
      if(!p?.name?.trim()){const e=new Error('没有符合账号、题材或额度条件的可用笔名，请在笔名库补充');e.waiting=true;throw e;}
      j.penId=p.id;name=p.name.trim();
    }else name=current.penName?.trim()||previous;
    if(!name){const e=new Error('笔名库暂无可用笔名，请先添加并启用');e.waiting=true;throw e;}
    j.settings.penName=name;
    // 已上传及结果待核对任务只恢复原署名，不改动远端包装。
    if(name!==previous&&!locked){
      const hadCover=!!(j.prompt||j.cover);
      for(const key of ['prompt','cover','remoteCover','cfg','result'])delete j[key];
      delete j.artifacts.package;
      if(hadCover)j.coverRevision=(j.coverRevision||0)+1;
      j.history.push({at:now(),stage:j.stage,result:'updated',message:'笔名已绑定：'+name});
      if(hadCover&&STAGES.indexOf(j.stage)>=STAGES.indexOf('prompt')){j.stage='prompt';this.save();return true;}
    }
    this.save();return false;
  }
  validTitle(j,x) {
    return typeof x?.title==='string'&&x.title.trim().length>0&&x.title.length<=30&&Number.isFinite(x.total)&&!x.rejected&&
      !this.store.state.jobs.some(other=>other.id!==j.id&&other.status!=='canceled'&&(other.cfg?.title===x.title||(other.titleScoreVersion===2&&other.title===x.title)));
  }
  titleReady(j) {
    if(j.titleScoreVersion!==2||!this.validTitle(j,{title:j.title,total:j.titleScore}))return false;
    if(j.titleScore>=80)return true;
    const candidates=(j.scores||[]).filter(x=>this.validTitle(j,x));
    return j.titleFallback===true&&j.titleGenerations>=2&&candidates.some(x=>x.title===j.title&&x.total===j.titleScore)&&candidates.every(x=>x.total<=j.titleScore);
  }
  pump() {
    if (this.running) return this.draining;
    this.draining = this.drainQueue().catch(e => {
      this.store.state.paused = true; this.running = false;
      this.store.state.fatalError = `自动队列已停止：${e.message}。请检查磁盘空间与数据文件后重新启动软件。`;
      this.emit(this.snapshot());
    });
    return this.draining;
  }
  async drainQueue() {
    delete this.store.state.fatalError;
    this.running = true; this.save();
    try {
      const inFlight=new Set();
      while (!this.store.state.paused || inFlight.size || this.store.state.jobs.some(j=>j.requestedStart&&['queued','waiting'].includes(j.status))) {
        for(const j of this.store.state.jobs)if(j.status==='waiting'&&(!j.retryAt||j.retryAt<=Date.now()))j.status='queued';
        const pending=this.store.state.jobs.filter(j=>j.status==='queued'&&!j.hidden&&!this.active.has(j.id)&&(!this.store.state.paused||j.requestedStart)).sort((a,b)=>Number(!!a.repairSource)-Number(!!b.repairSource));
        const configured=this.getSettings().submissionConcurrency;
        const limit=Math.max(1,Math.min(6,configured??Math.min(...pending.map(j=>j.scheme.concurrency))));
        while(inFlight.size<limit&&pending.length){
          const job=pending.shift();let work;
          work=this.run(job).finally(()=>inFlight.delete(work));inFlight.add(work);
        }
        if(!inFlight.size)break;
        await Promise.race(inFlight);
      }
    } finally { this.running = false; this.save(); }
  }
  async run(j) {
    this.active.add(j.id); j.status = 'running'; this.save();
    try {
      while (j.stage !== 'done' && (!this.store.state.paused||j.requestedStart) && !j.deleteRequested) {
        this.assignAccount(j);
        this.syncPenName(j);
        const stage = j.stage;
        j.attempts[stage] = (j.attempts[stage] || 0) + 1; this.save();
        try {
          const result = await this.step(j);
          if(result==='stay')continue;
          j.history.push({ stage, at: now(), result: 'ok' });
          j.stage = RECOVERY_NEXT[stage] || STAGES[STAGES.indexOf(stage) + 1]; j.updatedAt = now(); this.save();
        } catch (e) {
          if (['analysis','title','intro','entry','prompt','cover','catalog'].includes(stage) && retryable(e) && j.attempts[stage] <= j.scheme.retries) {
            j.history.push({ stage, at: now(), result: 'retry', message: e.message }); this.save();
            await this.sleep(Math.min(30000, 2000 * 2 ** (j.attempts[stage] - 1))); continue;
          }
          throw e;
        }
      }
      j.status = j.stage === 'done' ? (j.scheme.destination === 'submit' && !j.remainderComplete ? 'watching' : 'done') : 'queued';
    } catch (e) {
      j.status = e.waiting ? 'waiting' : 'attention'; if(e.waiting)j.retryAt=e.retryAt||Date.now()+60000; j.error = { code:e.code, stage: j.stage, message: String(e.message || e), at: now() };
      j.history.push({ ...j.error, result: e.waiting?'waiting':'failed' });
    } finally { if(!['watching','waiting'].includes(j.status))delete j.requestedStart;if(j.deleteRequested)hideSubmissionRecord(j);this.active.delete(j.id); this.save(); }
  }
  settings(j, image = false) {
    const current = this.getSettings();
    const keys = image ? ['imgApiBaseUrl', 'imageModel'] : ['apiBaseUrl', 'textModel'];
    const secret = image ? 'imgApiKey' : 'apiKey';
    if (!current[secret] || keys.some(k => !current[k])) throw new Error(`请在模型设置中配置${image ? '图像' : '文本'} AI，再重试`);
    return { ...j.settings, ...Object.fromEntries(['apiBaseUrl','apiKey','textModel','imgApiBaseUrl','imgApiKey','imageModel','coverTemplate','coverExtra','promptTemplates','deaiPrompt'].map(k => [k, current[k]])) };
  }
  async site(j, operation) {
    const phone=this.jobAccount(j);
    if(!phone){const e=new Error('请到设置 → 平台账号登录');e.code='AUTH_REQUIRED';throw e;}
    if (accountKey(this.jobAccount(j)) !== j.account) throw new Error('投稿账号未配置或已切换，请恢复导入时的账号后重试');
    return this.withSite(r => {
      if (accountKey(this.jobAccount(j)) !== j.account) throw new Error('等待站点操作期间账号已切换，请恢复原账号');
      return operation(r);
    }, phone);
  }
  chapters(j) { return JSON.parse(fs.readFileSync(j.artifacts.chapters, 'utf8')); }
  uploadChapters(j) { return j.warehouseAll ? this.chapters(j) : this.chapters(j).slice(0, j.plan?.count ?? j.chapterCount); }
  async readReview(r, row) {
    let result = submissionReview(row);
    if (row.status === 'rejected' && !result.reason && r.apiSubmissionDetail) {
      const detail = await r.apiSubmissionDetail(row.sid);
      // 拒稿依据必须来自当前投稿 ID 的详情，读取失败不能推断为第一类拒稿。
      if (detail?.submission_id != null && String(detail.submission_id) !== String(row.sid)) throw new Error('审核详情的投稿ID不一致');
      result = {...result,reason:String(detail?.review_reason || '')};
    }
    return result;
  }
  async syncReviews({ manual = false } = {}) {
    if (this.monitoring || (!manual && this.store.state.paused&&!this.store.state.jobs.some(j=>j.requestedStart))) return;
    const watchedStates=manual?['watching','done','blocked']:['watching','done'];
    const jobs = this.store.state.jobs.filter(j => (manual||!this.store.state.paused||j.requestedStart)&&!j.hidden&&watchedStates.includes(j.status) && j.remote && j.scheme.destination === 'submit' && !j.remainderComplete && accountKey(this.jobAccount(j))===j.account);
    if (!jobs.length) return;
    this.monitoring = true;
    this.store.state.lastReviewAttempt=now();this.save();
    try {
      for(const key of new Set(jobs.map(j=>j.account))){
      const accountJobs=jobs.filter(j=>j.account===key);
      try { await this.site(accountJobs[0], async r => {
        const rows = await r.listSubmissions();
        for (const j of accountJobs) {
          // 用户在网络等待期间停止的任务不再执行自动跟踪动作。
          if (!watchedStates.includes(j.status)) continue;
          const row = rows.find(x => String(x.sid) === String(j.remote.sid));
          if (!row) { j.status='blocked';j.result='站内投稿不存在，请人工核对';continue; }
          if (String(row.id) !== String(j.remote.baseId)) {j.status='blocked';j.result='站内作品ID不符，已停止自动处理';continue;}
          const review = await this.readReview(r,row); j.review=review;
          if (review.status === 'rejected') {
            const kind=rejectionKind(review.reason);j.review.kind=kind;
            const settings=this.getSettings(), quality=['generic','story'].includes(kind);
            const key=quality?'quality':kind==='unknown'?'unknown':'other';
            const used=j.resubmits?.[key]??(!j.resubmits&&quality?j.repairCount||0:0), limit=resubmitLimit(settings,kind);
            if(settings.autoRepairRejected!==false && used<limit){
              j.resubmits??={};j.resubmits[key]=used+1;j.repairCount=(j.repairCount||0)+1;
              j.repairKind=kind;j.repairSource=structuredClone(j.remote);
              delete j.deleteIntent;delete j.artifacts.rewriteWorking;delete j.rewriteProgress;
              j.stage='delete-rejected';j.status='queued';j.error=null;
              j.result=`审核未通过，准备第${used+1}/${limit}次${quality?'质量':'非质量'}重投`;
            }else {j.status='blocked';j.result=`${quality?'质量':'非质量'}重投次数已用完或已关闭（${used}/${limit}）：${review.reason||'未提供原因'}`;}
          } else if (review.status === 'contracted') {
            if (j.plan?.partial && j.scheme.completeAfterContract && !j.remainderComplete) {
              j.stage='append-rest';j.status='queued';j.error=null;j.result='已签约：等待补传剩余章节';
            } else {j.status='done';j.result=j.plan?.partial?'已签约，剩余章节待手动补传':'已签约，整本已提交';j.remainderComplete=!j.plan?.partial;}
          } else {j.status='watching';j.result=['approved','contracting'].includes(review.status)?'审核通过，等待签约完成后补传':'首投已提交，正在跟踪审核';}
          this.save();
        }
      }); } catch(e){if(manual)throw e;for(const j of accountJobs)j.reviewError=e.message;}
      }
      this.store.state.lastReviewSync=now();delete this.store.state.reviewError;this.save();
    } catch(e) {this.store.state.reviewError=e.message;this.save();if(manual)throw e;}
    finally {this.monitoring=false;}
    if(!this.store.state.paused||this.store.state.jobs.some(j=>j.requestedStart&&['queued','waiting'].includes(j.status)))this.pump();
  }
  async step(j) {
    const s = j.scheme, network = s.destination !== 'package';
    if(['title','intro','entry','prompt','cover','check','upload'].includes(j.stage)&&this.ensurePenName(j))return 'stay';
    if(!j.plan && j.artifacts.chapters && ['upload','submit','verify'].includes(j.stage)) j.plan=initialPlan(this.chapters(j),s);
    const ai = image => this.aiFactory(this.settings(j, image));
    switch (j.stage) {
      case 'inspect': {
        if (!j.artifacts.chapters || (j.cleaningSummary?.version || 0) < 2) {
          const parsed = await parseNovelFile(j.file);
          // 哈希归档文件名不能成为小说标题。
          const parsedTitle = parsed.title === path.basename(j.file, path.extname(j.file)) ? j.originalName : parsed.title;
          const audit = cleanManuscript(parsed,{requireFirstChapter:true});
          // A writer synopsis is planning material, not a platform-ready introduction.
          j.sourceIntro = j.writerId ? '' : parsed.headIntro?.trim() || '';
          j.title = j.sourceTitle || parsedTitle; j.originalTitle = j.title; j.words = audit.words; j.chapterCount = audit.chapters.length;
          j.warnings = audit.warnings; j.artifacts.chapters = path.join(this.root, 'books', j.id, 'chapters.json');
          j.artifacts.cleaning = path.join(this.root,'books',j.id,'cleaning.json');
          j.cleaningSummary = {removed:audit.changes.length,version:audit.version};
          atomicJSON(j.artifacts.cleaning,{...audit,chapters:undefined,source:j.file});
          atomicJSON(j.artifacts.chapters, audit.chapters); this.save();
        }
        if (!this.chapters(j).length) throw new Error('清理后没有达到50字的有效章节，请查看清理记录并检查原稿');
        if (this.chapters(j).some(c => !c.text.replace(/[\s\-—_=*#]/g, ''))) throw new Error('稿件含空章，请修正原稿后重新导入；所有原文已保留');
        if (j.warnings.length && !j.warningsApproved) throw new Error('稿件体检发现异常，请打开章节预览核对后确认');
        break;
      }
      case 'catalog': {
        j.catalog = structuredClone(this.getSite());
        if (network) {
          await this.site(j, async r => {
            const labels = await r.apiLabelMap();
            if (!labels.size) throw new Error('蛙蛙系统标签库为空，请重试同步');
            j.catalog.tags = [...labels.keys()]; j.catalog.campaigns = await r.apiCampaigns();
            j.catalog.entries = ['普通投稿', ...j.catalog.campaigns.map(c => c.name || c.title).filter(Boolean)];
          });
        }
        j.catalog.syncedAt = now(); break;
      }
      case 'analysis': {
        // Old paused jobs can retain an incomplete catalog from a previous version.
        const local=this.getSite();
        j.catalog ||= structuredClone(local);
        j.catalog.tree=structuredClone(local.tree);
        if(!j.catalog.tags?.length){
          if(network)await this.site(j,async r=>{j.catalog.tags=[...(await r.apiLabelMap()).keys()];});
          else j.catalog.tags=[...local.tags];
        }
        this.save();
        if (!j.analysis) { j.analysis = await ai().analyze(this.chapters(j), j.catalog, s); this.save(); }
        else if(!Array.isArray(j.analysis.tags)||!j.analysis.tags.length||j.analysis.tags.some(t=>!j.catalog.tags.includes(t))){
          const engine=ai();if(engine.repairTags){j.analysis=await engine.repairTags(j.analysis,j.catalog);this.save();}
        }
        validateAnalysis(j.analysis, j.catalog);
        if (j.analysis.confidence < 70 && !j.analysisApproved) throw new Error('内容分析置信度低于70，请检查分析与分类标签后确认');
        break;
      }
      case 'title': {
        Object.assign(j.analysis,{platformStyle:j.platformStyle||j.analysis.platformStyle||'',titleStyle:j.titleStyle||j.analysis.titleStyle||''});
        if(j.titleScoreVersion!==2){j.scores=[];delete j.pendingTitle;j.titleScoreVersion=2;}
        const engine = ai();
        if(!j.scores.length){j.titleGenerations=0;delete j.titleFallback;}
        if (!j.scores.length) {
          j.scores.push({ title: j.originalTitle, ...await engine.score(j.originalTitle, j.analysis), original: true }); this.save();
        }
        j.titleGenerations??=j.scores.filter(x=>!x.original).length+(j.pendingTitle?1:0);
        const ranked=()=>j.scores.filter(x=>this.validTitle(j,x)).sort((a,b)=>b.total-a.total);
        let best=ranked().find(x=>x.total>=80);
        while(!best&&(j.pendingTitle||j.titleGenerations<2)){
          if(!j.pendingTitle){
            try{j.pendingTitle=await engine.title(j.analysis,j.scores);}
            catch(e){if(e.code!=='INVALID_TITLE')throw e;j.titleGenerations++;j.scores.push({title:e.title||'',total:0,original:false,rejected:true,reason:e.message});this.save();continue;}
            j.titleGenerations++;this.save();
          }
          const title=j.pendingTitle;
          if(typeof title!=='string'||!title.trim()||title.length>30)j.scores.push({title:typeof title==='string'?title:'',total:0,original:false,rejected:true,reason:'书名为空或超过30字'});
          else j.scores.push({title:title.trim(),...await engine.score(title.trim(),j.analysis),original:false});
          delete j.pendingTitle;this.save();best=ranked().find(x=>x.total>=80);
        }
        best??=ranked()[0];
        if(!best)throw new Error('原名与两次候选均为空、超长或同名，请调整书名后重新包装');
        j.titleFallback=best.total<80;
        if(j.titleFallback)j.history.push({at:now(),stage:'title',result:'fallback',message:`两次生成后采用最高分合法书名：${best.title}（${best.total}分）`});
        j.title = best.title; j.titleScore = best.total; j.titleScoreVersion=2;j.titleChanged = j.title !== j.originalTitle; break;
      }
      case 'intro':
        if(j.sourceIntro && j.sourceIntro.length > 500) throw new Error('原稿简介超过500字，请在详情编辑简介后继续');
        j.intro ??= j.sourceIntro || await ai().intro(j.title, j.analysis, s.introStyle); break;
      case 'entry': {
        j.storyType = s.storyRule === 'words' ? (j.words > s.longThreshold ? 'long' : 'short') : s.storyRule === 'analysis' ? j.analysis.storyType : s.storyRule;
        j.finished = j.overrides.finished || (s.finished === 'analysis' ? j.analysis.finished : s.finished);
        if (j.finished === 'uncertain') throw new Error('无法从结尾确定完结状态，请在异常详情选择已完结或连载');
        const explicit = j.overrides.entry || s.entry;
        if (explicit !== 'auto') j.entry = explicit;
        else if (j.storyType === 'long') j.entry = '普通投稿';
        else if (!network) { j.entry = '待匹配活动'; }
        else { const match = await ai().entry(j.analysis, j.catalog.campaigns); j.entry = match.name; j.entryReason = match.reason; }
        if (network && !j.catalog.entries.includes(j.entry)) throw new Error('所选入口不在当前活动列表，请在异常详情重新选择');
        if (j.storyType === 'short' && j.entry === '普通投稿') throw new Error('短篇不能使用普通投稿，请选择适用活动');
        break;
      }
      case 'prompt': j.prompt ??= await ai().prompt(j.title, j.analysis, '', j.settings.penName); break;
      case 'cover': j.cover ??= await ai(true).cover(j.prompt, s.imageSize, j.coverRevision?`${j.id}-v${j.coverRevision}`:j.id); break;
      case 'check': {
        validateAnalysis(j.analysis, j.catalog);
        if (!this.titleReady(j) && !j.remote && !j.uploadIntent){delete j.titleScore;delete j.intro;delete j.prompt;delete j.cover;j.stage='title';return 'stay';}
        j.plan = initialPlan(this.chapters(j),s);
        j.cfg = { localFile: j.file, title: j.title, intro: j.intro, cover: j.cover, penName: j.settings.penName,
          wordCount: j.words, category: j.storyType === 'long' ? '长篇' : '短篇', channel: j.analysis.channel,
          novelType: j.analysis.novelType, tags: j.analysis.tags, entry: j.entry, status: j.finished === 'finished' ? '已完结' : '连载中' };
        const errors = this.checkConfig(j.cfg, j.catalog);
        if (errors.length) throw new Error(errors.join('；'));
        const pkg = path.join(this.root, 'books', j.id, 'package.json');
        atomicJSON(pkg, { originalTitle: j.originalTitle, titleScores: j.scores, analysis: j.analysis, scheme: s, config: j.cfg, coverPrompt: j.prompt, chaptersFile: j.artifacts.chapters });
        j.artifacts.package = pkg; break;
      }
      case 'upload': {
        if (!network || j.remote) break;
        if(!j.uploadIntent&&!this.titleReady(j)){
          delete j.titleScore;delete j.intro;delete j.prompt;delete j.cover;delete j.cfg;
          j.stage='title';return 'stay';
        }
        if (!j.uploadIntent) { j.warehouseAll = true; this.save(); }
        await this.site(j, async r => {
        if(!j.remote && !j.uploadIntent){
          if(j.scheme.destination==='submit')r.checkSubmissionQuota?.();
          const current=this.getSettings(), p=current.penNames?.find(x=>x.id===j.penId);
          const at=Date.now(), day=t=>new Date(t+8*3600e3).toISOString().slice(0,10);
          const times=this.store.state.jobs.filter(x=>x.account===j.account).flatMap(x=>(x.submissionEvents||(x.uploadIntent?[x.uploadIntent.at]:[])).map(t=>Date.parse(t))).filter(Number.isFinite);
          const stat=p?penStats(p,this.store.state.jobs):null;
          if((current.penLibraryOnly&&!p)||(p?.enabled===false)||(p?.account&&p.account!==this.jobAccount(j))||(p?.dailyLimit&&stat.today>=p.dailyLimit)||(p?.gapMinutes&&at-stat.last<p.gapMinutes*60000)||
             
             (current.submissionGapSeconds&&times.length&&at-Math.max(...times)<current.submissionGapSeconds*1000)){
            const e=new Error('等待笔名启用或投稿额度／间隔恢复');e.waiting=true;throw e;
          }
        }
          const subs = await r.listSubmissions();
          if (j.uploadIntent) {
            const match = subs.filter(x => !j.uploadIntent.before.includes(String(x.sid)) && x.title === j.title && x.penName === j.settings.penName);
            if (match.length !== 1) throw new Error('上次创建请求结果不确定。请先核对站内作品；确认未创建后才能再次上传');
            const chapters = await r.apiStructure(match[0].id), local = this.uploadChapters(j);
            if (chapters.length !== local.length || chapters.some((c,i) => (c.name ?? c.title ?? c.chapter_name) !== local[i].name)) throw new Error('发现同名作品但章节不吻合，请先在站内核对，禁止自动重复创建');
            j.remote = { sid: match[0].sid, baseId: match[0].id }; this.save(); return;
          }
          if (subs.some(x => x.title === j.title)) throw new Error('当前账号已有同名作品，请核对作品或修改内容分析后重新包装');
          const labels = await r.apiLabelMap();
          if (j.cfg.tags.some(t => !labels.has(t))) {
            j.catalog.tags=[...labels.keys()];
            j.analysis=await ai().repairTags(j.analysis,j.catalog);j.cfg.tags=j.analysis.tags;this.save();
          }
          let entry = {};
          if (j.entry !== '普通投稿') {
            const campaign = (await r.apiCampaigns()).find(c => (c.name || c.title) === j.entry);
            if (!campaign?.code) throw new Error('征文入口已失效或没有活动标识，请重新选择');
            entry = { entry_type: 'campaign', campaign_code: campaign.code };
          }
          j.remoteCover ??= await r.apiUpload(j.cover); this.save();
          j.uploadIntent = { at: now(), before: subs.map(x => String(x.sid)) }; j.submissionEvents??=[];j.submissionEvents.push(j.uploadIntent.at);this.save();
          const result = await r.apiCreateFromFile({ novel_title: j.title, story_type: j.storyType, channel: j.analysis.channel,
            cover: j.remoteCover, introduction: j.intro, is_finished: j.finished === 'finished' && !j.plan?.partial, pen_name: j.settings.penName,
            label_ids: j.analysis.tags.map(t => labels.get(t)), cate1_name: j.analysis.novelType[0], cate2_name: j.analysis.novelType[1],
            cate3_name: j.analysis.novelType[2], chapters: this.uploadChapters(j), ...entry });
          if (result?.submission_id == null || result?.base_novel_id == null) throw new Error('创建请求未返回标识，请重试执行结果核对');
          j.remote = { sid: result.submission_id, baseId: result.base_novel_id }; this.save();
        }); break;
      }
      case 'format': {
        if(!network || j.formattedAt)break;
        let pending=false;
        await this.site(j,async r=>{
          if(!j.remote?.baseId)throw new Error('缺少入仓作品标识，无法排版');
          if(!j.formatTaskId){
            if(j.formatIntent)throw new Error('排版发起结果不确定，请先在蛙蛙核对排版任务，再选择重新发起');
            j.formatIntent={at:now(),baseId:j.remote.baseId};this.save();
            const task=await r.apiStartFormat(j.remote.baseId);
            if(!task?.task_id)throw new Error('蛙蛙未返回排版任务标识，请核对站内排版结果');
            j.formatTaskId=task.task_id;this.save();
          }
          const result=await r.apiFormatProgress(j.remote.baseId,j.formatTaskId);
          j.formatResult=result;this.save();
          if(result?.status==='failed')throw new Error('蛙蛙排版失败：'+(result.error||'请核对后重新发起'));
          if(result?.status!=='done'){pending=true;return;}
          if(Number(result.failed)>0 || Number(result.skipped_locked)>0)throw new Error('部分章节排版失败或已锁定，已停止投稿，请在蛙蛙核对');
          const chapters=await r.apiStructure(j.remote.baseId);
          if(chapters.length!==this.uploadChapters(j).length)throw new Error('排版后章节数不一致，请核对');
          j.formattedAt=now();this.save();
        });
        if(pending){await this.sleep(1000);return 'stay';}
        break;
      }
      case 'submit': {
        if (s.destination !== 'submit') break;
        await this.site(j, async r => {
          const chapters = await r.apiStructure(j.remote.baseId);
          if (chapters.length !== this.uploadChapters(j).length) throw new Error('入库章节数与首投范围不一致，请核对站内数据');
          const pending = chapters.slice(0,j.plan.count).filter(c => !c.is_submitted);
          if (!pending.length) return;
          if (j.submitIntent) throw new Error('上次提交结果待核对，部分章节尚未显示已提交。请稍后重试；确认未提交后才能重新发送');
          if (pending.some(c => c.is_locked)) throw new Error('章节被站点锁定，请处理后重试');
          if (pending.some(c => c.node_id == null)) throw new Error('站点章节缺少标识，不能提交');
          const subs = await r.listSubmissions();
          const remote = subs.find(x => String(x.sid) === String(j.remote.sid));
          if (!remote) throw new Error('投稿草稿不存在，请检查当前账号');
          r.checkSubmissionQuota?.();
          j.submitIntent = { at: now(), ids: pending.map(c => c.node_id) }; this.save();
          const result = remote.status === 'draft' ? await r.apiSubmitSubmission(j.remote.sid, j.submitIntent.ids) : await r.apiSubmitChapters(j.remote.sid, j.submitIntent.ids);
          j.submitResult = result || {}; this.save();
        }); break;
      }
      case 'verify': {
        if (!network) { j.result = '包装完成'; break; }
        await this.site(j, async r => {
          const chapters = await r.apiStructure(j.remote.baseId);
          if (chapters.length !== this.uploadChapters(j).length) throw new Error('入库章节数量异常，请核对');
          if (s.destination === 'submit' && chapters.slice(0,j.plan.count).some(c => !c.is_submitted)) throw new Error('站点尚未确认所有章节提交成功，请稍后重试核对');
          j.remoteConfirmedAt = now(); if(s.destination==='submit')j.submittedAt=j.remoteConfirmedAt; j.result = s.destination === 'submit' ? `首投${j.plan.count}章 / ${j.plan.words}字已提交，等待审核` : '已入库（投稿草稿）';
        }); break;
      }
      case 'delete-rejected': {
        await this.site(j,async r=>{
          const old=j.repairSource;
          if(old && !j.remote && j.oldSubmissions?.some(x=>String(x.sid)===String(old.sid)))return;
          if(!old?.sid || !j.remote || String(j.remote.sid)!==String(old.sid))throw new Error('缺少原投稿绑定，禁止删除');
          const row=(await r.listSubmissions()).find(x=>String(x.sid)===String(old.sid));
          if(row){
            const review=await this.readReview(r,row);
            if(String(row.id)!==String(old.baseId)||review.status!=='rejected'||rejectionKind(review.reason)!==(j.repairKind||'generic')||review.contract==='signed'||review.contract==='contracted')throw new Error('拒稿状态或理由已变化，已阻止删除');
            if(this.getSettings().autoRepairRejected===false || resubmitLimit(this.getSettings(),j.repairKind||'generic') < (j.resubmits?.[['generic','story'].includes(j.repairKind||'generic')?'quality':j.repairKind==='unknown'?'unknown':'other']||j.repairCount||1))throw new Error('自动修改复投已关闭，未删除旧投稿');
            j.deleteIntent ??= {sid:old.sid,baseId:old.baseId,review,at:now()};this.save();
            await r.apiDeleteSubmission(old.sid);
            if((await r.listSubmissions()).some(x=>String(x.sid)===String(old.sid)))throw new Error('旧投稿删除尚未确认，稍后重试核对');
          }else if(!j.deleteIntent)throw new Error('旧投稿已不在列表且没有删除记录，需人工核对');
          j.oldSubmissions??=[];
          if(!j.oldSubmissions.some(x=>String(x.sid)===String(old.sid)))j.oldSubmissions.push({...old,review:j.deleteIntent.review,deletedAt:now()});
          delete j.formatIntent;delete j.formatTaskId;delete j.formatResult;delete j.formattedAt;
          delete j.remote;delete j.uploadIntent;delete j.submitIntent;delete j.submitResult;delete j.remoteConfirmedAt;
          j.artifacts.rewriteWorking ??= path.join(this.root,'books',j.id,`rewrite-working-${j.repairCount||1}.json`);
          if(!fs.existsSync(j.artifacts.rewriteWorking))atomicJSON(j.artifacts.rewriteWorking,{chapters:this.chapters(j),completed:0});
          j.rewriteProgress ??= 0;this.save();
        });break;
      }
      case 'rewrite': {
        const working=JSON.parse(fs.readFileSync(j.artifacts.rewriteWorking,'utf8'));
        const chapters=working.chapters;const engine=ai();
        // 兼容旧连续进度；乱序完成按下标记录，重试不重复付费。
        working.done ??= Array.from({length:working.completed||0},(_,i)=>i);
        const todo=Array.from({length:j.plan?.count||chapters.length},(_,i)=>i).filter(i=>!working.done.includes(i));
        const limit=Math.max(1,Math.min(6,Number(this.getSettings().rewriteConcurrency)||3));
        let cursor=0, failure;
        const worker=async()=>{
          while(cursor<todo.length && !failure && !this.store.state.paused){
            const i=todo[cursor++], original=chapters[i];
            try {
              const revised=await engine.rewriteChapter(original,j.analysis,(this.getSettings().deaiPrompt||'')+'\n审核意见：'+(j.review?.reason||''));
              const clean=cleanManuscript({text:`${original.name}\n${revised}`});
              if(clean.chapters.length!==1||clean.warnings.length)throw new Error(`「${original.name}」改写后格式体检未通过，请检查`);
              chapters[i]={name:original.name,text:clean.chapters[0].text};working.done.push(i);
              working.completed=working.done.length;atomicJSON(j.artifacts.rewriteWorking,working);
              j.rewriteProgress=working.done.length;this.save();
            }catch(e){failure??=e;}
          }
        };
        await Promise.all(Array.from({length:Math.min(limit,todo.length)},worker));
        if(failure)throw failure;
        if(this.store.state.paused)return 'stay';
        const plan=initialPlan(chapters,s);
        if(plan.count>(j.plan?.count||0)){j.plan=plan;this.save();return 'stay';}
        j.plan=plan;j.words=chapters.reduce((n,c)=>n+effectiveWords(c.text),0);
        j.artifacts.rewrite=path.join(this.root,'books',j.id,`rewrite-${j.repairCount||1}.json`);
        atomicJSON(j.artifacts.rewrite,chapters);j.artifacts.chapters=j.artifacts.rewrite;
        this.save();break;
      }
      case 'append-rest': {
        await this.site(j,async r=>{
          const row=(await r.listSubmissions()).find(x=>String(x.sid)===String(j.remote.sid));
          if(!row||row.status!=='contracted'||String(row.id)!==String(j.remote.baseId))throw new Error('尚未确认当前书籍已签约，禁止补传');
          const local=this.chapters(j);let remote=await r.apiStructure(j.remote.baseId);
          if(remote.length>local.length||remote.some((c,i)=>(c.name??c.title??c.chapter_name)!==local[i].name))throw new Error('站内章节与本地版本不一致，禁止补传');
          if(remote.length<local.length){
            throw new Error('这是旧版仅上传首投章节的任务，仓库缺少余章。请在蛙蛙站内补齐仓库章节后重试；新版任务首次上传即完整入仓，不再使用文件补传接口');
          }
          if(remote.length!==local.length)throw new Error('剩余章节尚未完整入库，请稍后核对');
        });break;
      }
      case 'submit-rest': {
        await this.site(j,async r=>{
          const row=(await r.listSubmissions()).find(x=>String(x.sid)===String(j.remote.sid));
          if(!row||row.status!=='contracted')throw new Error('签约状态变化，已停止补投');
          const remote=await r.apiStructure(j.remote.baseId),pending=remote.filter(c=>!c.is_submitted);
          if(remote.length!==j.chapterCount)throw new Error('章节数不一致，禁止补投');
          if(!pending.length)return;
          if(j.restSubmitIntent)throw new Error('补投请求结果待核对，请检查站内状态');
          if(pending.some(c=>c.is_locked||c.node_id==null))throw new Error('部分剩余章节被锁定或没有标识');
          r.checkSubmissionQuota?.();
          j.restSubmitIntent={at:now(),ids:pending.map(c=>c.node_id)};this.save();
          await r.apiSubmitChapters(j.remote.sid,j.restSubmitIntent.ids);
        });break;
      }
      case 'verify-rest': {
        await this.site(j,async r=>{const remote=await r.apiStructure(j.remote.baseId);if(remote.length!==j.chapterCount||remote.some(c=>!c.is_submitted))throw new Error('剩余章节尚未全部确认提交，请稍后核对');});
        j.remainderComplete=true;j.result='已签约，全部剩余章节已补齐（完结申请可在站点处理）';break;
      }
      default: throw new Error('未知自动任务阶段');
    }
  }
}
