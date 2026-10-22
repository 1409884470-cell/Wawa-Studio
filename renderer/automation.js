(() => {
  'use strict';
  const api = window.api, host = document.querySelector('#page-automation');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stages = { inspect:'导入清理',catalog:'同步蛙蛙库',analysis:'内容分析',title:'书名评分',intro:'生成简介',entry:'匹配入口',prompt:'封面提示词',cover:'生成封面',check:'投稿校验',upload:'上传入库',format:'蛙蛙自动排版',submit:'提交投稿',verify:'核对结果',done:'已提交','delete-rejected':'删除已拒稿记录',rewrite:'修订首投章节','append-rest':'签约后补传','submit-rest':'补投剩余章节','verify-rest':'核对补投结果' };
  const states = { waiting:'等待额度/笔名', importing:'导入清理中',queued:'等待执行',running:'执行中',attention:'需要处理',watching:'跟踪审核',blocked:'拒稿待处理',done:'已完成',canceled:'已停止' };
  let state = { jobs:[], schemes:[], paused:true }, defaults, library, selectedId;
  if (!api?.automationState) { host.innerHTML = '<p>请在 wawawa 桌面软件中使用自动包装功能。</p>'; return; }
  const opts = items => items.map(([v,t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  host.innerHTML = `
    <div class="aq-hero"><div><div class="aq-eyebrow">WAWAWA / BATCH PUBLISHING</div><h1>自动投稿中心</h1><p>导入清理 → 自动包装 → 首投 → 审核跟踪 → 签约后补齐</p></div><button id="aqImport" class="aq-primary">＋ 批量导入小说</button></div>
    <div class="aq-notice" id="aqMessage" role="status">正在读取自动任务…</div>
    <div class="aq-stats" id="aqStats"></div>
    <div class="aq-panel"><div class="aq-panel-head"><h2>投稿并行</h2><div class="aq-actions"><label>同时处理本数 <input id="aqGlobalConcurrency" type="number" min="1" max="6" value="2" style="width:80px"></label><button id="aqSaveConcurrency" class="aq-primary">保存并行设置</button></div></div><p>1—6 本并行包装；同账号上传依次执行。</p></div>
    <div class="aq-panel"><div class="aq-panel-head"><h2>本批包装方案</h2><button id="aqToggleScheme">收起设置</button><div class="aq-actions"><select id="aqSchemes" aria-label="已保存方案"></select><button id="aqSave">保存方案</button><button id="aqDelete">删除方案</button></div></div>
      <div id="aqSchemeBody"><div class="aq-form">
        <label>方案名称<input id="aqName" maxlength="60"></label>
        <label>处理到哪一步<select id="aqDestination">${opts([['submit','自动包装并正式投稿'],['library','自动包装并上传为草稿'],['package','只生成包装，暂不上传']])}</select></label>
        <label>长短篇规则<select id="aqStoryRule">${opts([['words','按正文字数'],['analysis','根据内容分析'],['long','全部长篇'],['short','全部短篇']])}</select></label>
        <label>长篇字数阈值（大于）<input id="aqLongThreshold" type="number" min="1" max="10000000"></label>
        <label>投稿入口<select id="aqEntry"></select></label>
        <label>完结状态<select id="aqFinished">${opts([['analysis','根据结尾分析'],['finished','全部已完结'],['serial','全部连载中']])}</select></label>
        <label>首次投稿范围<select id="aqFirstSubmitMode">${opts([['minimum','前10—15章内凑够最低字数'],['count','固定前N章'],['all','整本投稿']])}</select></label>
        <label>固定前N章<input id="aqFirstChapterCount" type="number" min="1" max="10000"></label>
        <label>首投最少章数<input id="aqFirstMinChapters" type="number" min="1" max="10000"></label>
        <label>首投最多章数<input id="aqFirstMaxChapters" type="number" min="1" max="10000"></label>
        <label>首投最低有效字数<input id="aqFirstMinWords" type="number" min="20000" max="10000000"></label>
        <label class="aq-check"><input id="aqCompleteAfterContract" type="checkbox">确认已签约后自动补传剩余章节</label>
        <label class="aq-wide">简介风格<textarea id="aqIntroStyle" rows="2" maxlength="2000"></textarea></label>
        <label class="aq-wide">本批封面偏好（可留空，由剧情决定）<textarea id="aqCoverStyle" rows="2" maxlength="2000"></textarea></label>
      </div>
      <div class="aq-rule"><b>封面提示词</b><span>基础要求 + 本书剧情画面 + 明亮去模板要求 + 自定义补充。每本书单独分析。</span><button data-prompt-open="post:coverScene">设置封面提示词</button></div><div class="aq-rule"><b>书名自动评分</b><span>原名 ≥80 分沿用；最多再生成2次，仍不足80分则采用最高分合法书名。吸引力占45分。</span></div>
      <div class="aq-rule"><b>首投正常正文</b><span>全文先入仓，仅提交指定首投章节，部分投稿保持连载状态。按有效正文计数；不足50字的章节不上传。拒稿修订开关在“自动流程”设置中。</span></div>
      <div class="aq-rule"><b>笔名：<span id="aqPenName">未设置</span></b><span>从设置读取，自动加入投稿署名和封面绘画提示词。</span><button data-settings-open="pens">设置笔名</button><button data-settings-open="ai">模型设置</button></div>
      <details class="aq-advanced"><summary>执行设置</summary><div class="aq-form">
        <label>封面尺寸<select id="aqImageSize">${opts(['1024x1536', '768x1024','720x1280','1024x1024','1280x720'].map(x=>[x,x]))}</select></label>

        <label>网络失败自动重试次数<input id="aqRetries" type="number" min="0" max="3"></label>
        <input id="aqTitleAttempts" type="hidden" value="2">
      </div><p>每本书通常包含分析、评分、简介、提示词等多次文本请求及1次图像请求。重新生成与网络重试可能增加费用。上传结果不明确时先核对，不自动重复创建。</p></details>
      <label class="aq-check"><input id="aqAutoStart" type="checkbox">导入后立即按照本方案执行</label></div>
    </div>
    <div class="aq-panel"><div class="aq-panel-head"><div><h2>自动任务</h2><span id="aqQueueState"></span></div><div class="aq-actions"><select id="aqFilter" aria-label="筛选任务">${opts([['all','全部任务'],['attention','需要处理'],['blocked','拒稿待处理'],['watching','跟踪审核'],['running','执行中'],['queued','等待执行'],['waiting','等待笔名/额度'],['done','已完成'],['canceled','已停止']])}</select><label><input type="checkbox" id="aqSelectAll"> 全选</label><button id="aqBatchDelete">批量删除</button><button id="aqSyncReview">检查审核</button><button id="aqPause">暂停队列</button><button id="aqResume" class="aq-primary">继续队列</button></div></div><div id="aqJobs"></div></div>`;
  const $ = id => document.getElementById(id);
  const fields = ['name','introStyle','coverStyle','storyRule','longThreshold','entry','finished','destination','imageSize','autoStart','retries','titleAttempts','firstSubmitMode','firstChapterCount','firstMinChapters','firstMaxChapters','firstMinWords','completeAfterContract'];
  const fid = key => 'aq' + key[0].toUpperCase() + key.slice(1);
  const message = (text, bad = false) => { for(const id of ['aqMessage','aqRecordsMessage']){const box=$(id);if(box){box.textContent=text;box.classList.toggle('aq-bad',bad);}} const d = document.querySelector('.aq-dialog[open]'); if (d && bad) { let n = d.querySelector('.aq-dialog-error'); if (!n) { n = document.createElement('p'); n.className = 'aq-error aq-dialog-error'; d.prepend(n); } n.textContent = text; d.scrollTop = 0; } };
  const run = fn => async (...args) => { try { await fn(...args); } catch(e) { message(e.message || String(e), true); } };
  function fillScheme(s) {
    s={firstSubmitMode:'minimum',firstChapterCount:12,firstMinChapters:10,firstMaxChapters:15,firstMinWords:20000,completeAfterContract:true,...s};
    for (const k of fields) { const el = $(fid(k)); if (el.type === 'checkbox') el.checked = s[k]; else el.value = s[k]; }
    updateSchemeVisibility();
    if (!$('aqEntry').value && s.entry) $('aqEntry').add(new Option(s.entry, s.entry, true, true));
  }
  function updateSchemeVisibility(){
    const mode=$('aqFirstSubmitMode').value;
    $('aqFirstChapterCount').closest('label').hidden=mode!=='count';
    for(const id of ['aqFirstMinChapters','aqFirstMaxChapters','aqFirstMinWords'])$(id).closest('label').hidden=mode!=='minimum';
    $('aqLongThreshold').closest('label').hidden=$('aqStoryRule').value!=='words';
  }
  for(const id of ['aqFirstSubmitMode','aqStoryRule'])$(id).addEventListener('change',updateSchemeVisibility);
  function readScheme() {
    return Object.fromEntries(fields.map(k => { const el = $(fid(k)); return [k,el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value]; }));
  }
  function renderSchemes() {
    const current = $('aqSchemes').value || state.defaultScheme;
    $('aqSchemes').innerHTML = state.schemes.map(s => `<option>${esc(s.name)}</option>`).join('');
    if (state.schemes.some(s => s.name === current)) $('aqSchemes').value = current;
  }
  function render() {
    if(state.fatalError)message(state.fatalError,true); else if(state.reviewError)message('审核同步失败：'+state.reviewError,true);
    const jobs = state.jobs.filter(j=>!j.hidden);
    $('aqStats').innerHTML = [['总任务',jobs.length],['执行 / 等待',jobs.filter(j=>['running','queued'].includes(j.status)).length],['需要处理',jobs.filter(j=>['attention','blocked'].includes(j.status)).length],['已完成',jobs.filter(j=>j.status==='done').length]].map(([a,b])=>`<div><span>${a}</span><strong>${b}</strong></div>`).join('');
    $('aqQueueState').textContent = state.paused ? (state.running ? '正在完成当前步骤，随后暂停' : '已暂停 · 断点已保存') : state.running ? '正在执行 · 每步自动保存' : jobs.some(j=>j.status==='watching') ? '审核跟踪中 · 软件运行时定期检查' : '队列空闲';
    const visible = jobs.filter(j=>$('aqFilter').value === 'all' || $('aqFilter').value === j.status).slice().reverse();
    const selected=new Set([...document.querySelectorAll('[data-aq-select]:checked')].map(e=>e.value));
    $('aqJobs').innerHTML = visible.length ? visible.map(j => `<div class="aq-job ${j.status}"><div class="aq-job-main"><div><input type="checkbox" data-aq-select value="${j.id}" ${selected.has(j.id)?"checked":""}> <b>${esc(j.title)}</b><span class="aq-badge">${states[j.status]}</span>${j.titleScore != null ? `<span class="aq-score">书名 ${j.titleScore} 分${j.titleChanged ? ' · 已更名' : ' · 沿用原名'}</span>` : ''}</div><p>${esc(stages[j.stage])} · 完整稿 ${j.chapterCount ?? '—'} 章 / ${j.words ?? '—'} 有效字 · ${esc(j.scheme.name)}</p><progress max="12" value="${Math.max(0,Object.keys(stages).indexOf(j.stage))}"></progress>${j.error ? `<p class="aq-error">${esc(j.error.message)}</p>` : ''}${j.plan ? `<p>首投 ${j.plan.count} 章 / ${j.plan.words} 有效字 · 其余 ${j.chapterCount-j.plan.count} 章${j.remainderComplete?'已补齐':j.warehouseAll?'已入仓待投稿':'保留本地'}</p>` : ''}${j.review?.reason ? `<p class="aq-error">拒稿原文：${esc(j.review.reason)}</p>` : ''}${j.result ? `<p class="aq-success">${esc(j.result)}</p>` : ''}</div><div class="aq-actions">${j.status!=='running'?`<button data-aq-action="delete" data-id="${j.id}">删除任务</button>`:''}<button data-aq-action="detail" data-id="${j.id}">详情 / 处理</button>${j.status === 'attention' ? `<button data-aq-action="retry" data-id="${j.id}">重试当前步骤</button>` : ''}${['queued','attention','watching','blocked'].includes(j.status) ? `<button data-aq-action="cancel" data-id="${j.id}">停止此书</button>` : ''}</div></div>`).join('') : '<div class="aq-empty">导入 TXT / DOCX 小说后，包装进度会显示在这里。<br>同一文件重复导入会自动去重，同名不同稿件独立保存。</div>';
  }
  async function control(action,id,patch) {
    const result = await api.automationControl(action,id,patch);
    if (!result.ok) throw new Error(result.error);
    message(action === 'pause' ? '暂停请求已保存，当前步骤完成后暂停。' : '操作已保存。暂停中的队列请点击“继续队列”。');
  }
  $('aqImport').onclick = run(async () => {
    const files = await api.pickFiles('novel'); if (!files.length) return;
    $('aqImport').disabled = true;
    try {
      const r = await api.automationImport(files, readScheme()); if (!r.ok) throw new Error(r.error);
      if (r.added.length) { $('aqSchemeBody').hidden = true; $('aqToggleScheme').textContent = '展开设置'; }
      message(`导入 ${r.added.length} 本；重复 ${r.duplicates.length} 本；失败 ${r.errors.length} 本。${r.errors.map(x=>x.file+'：'+x.error).join('；')}`, !!r.errors.length);
    } finally { $('aqImport').disabled = false; }
  });
  $('aqSyncReview').onclick = run(async()=>{ $('aqSyncReview').disabled=true;try {const r=await api.automationSyncReview();if(!r.ok)throw new Error(r.error);message('审核状态已检查。暂停中的队列不会执行删除、修订或补投。');}finally{$('aqSyncReview').disabled=false;} });
  $('aqSaveConcurrency').onclick=run(async()=>{await api.saveSettings({submissionConcurrency:Number($('aqGlobalConcurrency').value)});message('投稿并行设置已保存，从下一次调度生效。');});
  $('aqSelectAll').onchange=()=>document.querySelectorAll('[data-aq-select]').forEach(e=>e.checked=$('aqSelectAll').checked);
  $('aqBatchDelete').onclick=run(async()=>{const ids=[...document.querySelectorAll('[data-aq-select]:checked')].map(e=>e.value);if(!ids.length)throw new Error('请先勾选投稿任务');const r=await api.studio('delete-items',{kind:'post',ids});if(!r.ok)throw new Error(r.error);const failed=r.data.filter(x=>!x.success);if(failed.length)throw new Error(failed.map(x=>x.error).join('；'));state=await api.automationState();render();message('已删除所选本地任务；执行中的任务在当前步骤结束后停止，线上作品保留。');});
  $('aqPause').onclick = run(()=>control('pause'));
  $('aqResume').onclick = run(()=>control('resume'));
  $('aqFilter').onchange = render;
  $('aqToggleScheme').onclick = () => { $('aqSchemeBody').hidden = !$('aqSchemeBody').hidden; $('aqToggleScheme').textContent = $('aqSchemeBody').hidden ? '展开设置' : '收起设置'; };
  $('aqSchemes').onchange = () => fillScheme(state.schemes.find(s=>s.name === $('aqSchemes').value) || defaults);
  $('aqSave').onclick = run(async()=>{ const s=readScheme(), r=await api.automationScheme('save',s);if(!r.ok)throw new Error(r.error);state=await api.automationState();renderSchemes();message('方案已保存；已经导入的任务保留原方案快照。');$('aqSchemes').value=s.name; });
  $('aqDelete').onclick = run(async()=>{const r=await api.automationScheme('delete',null,$('aqSchemes').value);if(!r.ok)throw new Error(r.error);message('已删除保存的方案，现有任务不受影响。');});
  $('aqJobs').onclick = run(async e=>{const b=e.target.closest('[data-aq-action]');if(!b)return;if(b.dataset.aqAction==='detail')await detail(b.dataset.id);else {if(b.dataset.aqAction==='delete'&&!confirm('删除本地任务记录并停止监控？原稿和站内作品保留。'))return;await control(b.dataset.aqAction,b.dataset.id);}});
  const dialog = document.createElement('dialog'); dialog.className = 'aq-dialog'; document.body.append(dialog);
  function closeDialog() { dialog.close(); selectedId = null; }
  async function detail(id) {
    selectedId=id; const j=state.jobs.find(x=>x.id===id), site=j.catalog || library;
    const a=j.analysis, editable=!['running','importing'].includes(j.status) && j.status!=='done' && !j.remote && !j.uploadIntent;
    dialog.innerHTML=`<div class="aq-panel-head"><h2>${esc(j.title)}</h2><button id="aqDetailClose">关闭</button></div>
      <div class="aq-detail-content"><p>${esc(stages[j.stage])} · ${states[j.status]} · ${esc(j.result || '')}</p>${j.error?`<p class="aq-error">${esc(j.error.message)}</p>`:''}
      <div class="aq-actions"><button id="aqPreviewChapters">清理后章节预览</button>${j.artifacts.cleaning?'<button id="aqShowCleaning">清理记录</button>':''}${j.cover?'<button id="aqOpenCover">查看封面</button>':''}${j.artifacts.package?'<button id="aqOpenPackage">打开包装文件夹</button>':''}</div>
      <div id="aqChapterView" hidden><select id="aqChapterSelect" aria-label="章节"></select><pre id="aqChapterText"></pre></div>
      ${j.warnings?.length?`<div class="aq-warning">${j.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}<label class="aq-check"><input type="checkbox" id="aqAck" ${j.warningsApproved?'checked':''}>已核对章节，确认保留全部正文</label></div>`:''}
      <div id="aqCleaningView" hidden></div>${j.plan?`<p>首投：${j.plan.count}章 / ${j.plan.words}有效字；总计${j.chapterCount}章。${j.remainderComplete?'已签约且余下章节已补齐':j.plan.partial?'首投保持连载，签约后补齐':'整本投稿'}</p>`:''}${j.review?`<p>站内审核：${esc(j.review.status)}<br>拒稿原文：${esc(j.review.reason||'无')}<br>累计重新投稿：${j.repairCount||0} 次（上限按自动流程设置分类计算）</p>`:''}<p>原始书名：${esc(j.sourceTitle||j.originalTitle||j.title)}<br>当前投稿书名：${esc(j.title)}${j.titleChanged?" · 评分后调整":""}</p><h3>书名评分记录</h3><p>内容贴合30 / 吸引力25 / 题材辨识20 / 可读性15 / 辨识度10；总分由程序相加。</p>${j.scores.map(s=>`<div class="aq-score-row"><b>${esc(s.title)} · ${s.total}分 ${s.original?'（原名）':''}</b><p>${esc(s.reason)}</p><small>${esc(Object.entries(s.scores || {}).map(([k,v])=>k+': '+v).join(' / '))}</small></div>`).join('')||'<p>尚未评分</p>'}
      <h3>内容分析与投稿信息</h3>${a?`<p>${esc(a.summary)}</p><p>人物：${esc(a.characters)}<br>冲突：${esc(a.conflict)}<br>主题：${esc((a.themes || []).join('、'))}<br>置信度：${a.confidence} / 100 · ${esc(a.reason)}</p><fieldset id="aqReviewFields" ${editable&&!j.repairSource?'':'disabled'}><div class="aq-form"><label>频道 / 一级类目<select id="aqReviewL1"></select></label><label>二级类目<select id="aqReviewL2"></select></label><label>三级类目<select id="aqReviewL3"></select></label><label>长短篇分析<select id="aqReviewType">${opts([['long','长篇'],['short','短篇']])}</select></label></div><div class="aq-tags">${site.tags.map(t=>`<label><input type="checkbox" value="${esc(t)}" ${a.tags.includes(t)?'checked':''}>${esc(t)}</label>`).join('')}</div><label class="aq-check"><input id="aqApproveAnalysis" type="checkbox" ${j.analysisApproved?'checked':''}>我已核对并确认内容分析及分类标签</label></fieldset>`:'<p>尚未生成内容分析</p>'}
      <fieldset ${editable?'':'disabled'}><div class="aq-form"><label>首投范围<select id="aqReviewFirstMode">${opts([['minimum','前若干章凑够最低字数'],['count','固定前N章'],['all','整本投稿']])}</select></label><label>固定首投章数<input id="aqReviewFirstCount" type="number" min="1" value="${j.scheme.firstChapterCount||12}"></label><label>最少章数<input id="aqReviewFirstMin" type="number" min="1" value="${j.scheme.firstMinChapters||10}"></label><label>最多章数<input id="aqReviewFirstMax" type="number" min="1" value="${j.scheme.firstMaxChapters||15}"></label><label>指定投稿入口<select id="aqReviewEntry"><option value="">沿用方案 / 自动匹配</option>${opts((site.entries || []).map(e=>[e,e]))}</select></label><label>确认完结状态<select id="aqReviewFinished">${opts([['','沿用方案 / 分析'],['finished','已完结'],['serial','连载中']])}</select></label></div></fieldset>
      <h3>简介</h3><textarea id="aqIntroEdit" ${editable?'':'disabled'} rows="5">${esc(j.intro || j.sourceIntro || '')}</textarea><h3>封面提示词</h3><textarea id="aqPromptEdit" ${editable?'':'disabled'} rows="7">${esc(j.prompt || '')}</textarea>${editable&&j.prompt?'<button id="aqSavePrompt">保存提示词并重试封面</button>':''}${editable&&j.prompt&&!j.repairSource?'<button id="aqRefreshCover">按新规则重做封面</button>':''}${editable&&j.cover?'<button id="aqCompressCover">压缩现有封面（保留原图）</button>':''}
      ${j.formatResult?`<p>蛙蛙排版：${esc(j.formatResult.status)} · ${j.formatResult.processed||0}/${j.formatResult.total||j.chapterCount}章</p>`:''}${j.stage==='format'&&j.status==='attention'?'<button id="aqFormatRetry">已核对站内，重新发起排版</button>':''}<h3>执行记录</h3><div class="aq-history">${j.history.map(h=>`<p>${esc(h.at)} · ${esc(stages[h.stage])} · ${esc(h.result)} ${esc(h.message || '')}</p>`).join('')}</div>
      <div class="aq-actions">${editable?'<button id="aqReviewSave" class="aq-primary">保存确认并继续</button><button id="aqRebind">使用当前设置重新包装</button>':''}${!['running','done','importing'].includes(j.status)?'<button id="aqDetailRetry">继续当前步骤</button>':''}${!j.remote&&!j.uploadIntent&&!j.repairSource&&j.status!=='running'?'<button id="aqRestart">从头重新处理</button>':''}${j.uploadIntent&&!j.remote?'<button id="aqNoCreate">已核对站内：尚未创建</button>':''}${j.submitIntent&&j.remote&&j.status==='attention'&&['submit','verify'].includes(j.stage)?'<button id="aqNotSubmitted">已核对站内：重发未提交章节</button>':''}${['append-rest','submit-rest','verify-rest'].includes(j.stage)&&j.status==='attention'?'<button id="aqRestRetry">已核对站内，继续补传/补投</button>':''}</div><p class="aq-muted">导入时保存方案；尚未上传的任务同步当前笔名，后续 AI 请求使用当前 API 和模型设置。书名或分析重新生成后，简介与封面也会重新生成。</p></div>`;
    if (!dialog.open) dialog.showModal();
    $('aqDetailClose').onclick=closeDialog;
    if($('aqFormatRetry'))$('aqFormatRetry').onclick=run(async()=>{if(confirm('请确认蛙蛙上没有仍在运行的排版任务。将使用蛙蛙默认参数重新排版，不重新上传作品。')){await control('confirm-format-retry',id);closeDialog();}});
    if($('aqRefreshCover'))$('aqRefreshCover').onclick=run(async()=>{await control('refresh-cover',id);closeDialog();});
    if($('aqSavePrompt'))$('aqSavePrompt').onclick=run(async()=>{await control('edit-prompt',id,{prompt:$('aqPromptEdit').value});closeDialog();});
    if($('aqCompressCover'))$('aqCompressCover').onclick=run(async()=>{await control('compress-cover',id);closeDialog();});
    if($('aqRestart'))$('aqRestart').onclick=run(async()=>{if(confirm('从原稿重新处理并重新生成包装？原有文件会保留。')){await control('restart',id);closeDialog();}});

    if($('aqShowCleaning'))$('aqShowCleaning').onclick=run(async()=>{const r=await api.automationCleaning(id);if(!r.ok)throw new Error(r.error);$('aqCleaningView').hidden=false;$('aqCleaningView').innerHTML='<h3>清理记录（原稿保留）</h3><pre class="aq-clean-log"></pre>';$('aqCleaningView').querySelector('pre').textContent=r.report.changes.map(c=>[c.line?'原文行 '+c.line:c.chapter,c.reason,c.removed].filter(Boolean).join(' · ')).join('\n\n')||'没有排除内容';});
    if($('aqRestRetry'))$('aqRestRetry').onclick=run(async()=>{if(confirm('确认已核对站内章节？将仅补传缺少的章节或补投未提交的章节。')){await control('confirm-rest-retry',id);closeDialog();}});
    $('aqPreviewChapters').onclick=run(async()=>{const r=await api.automationChapters(id);if(!r.ok)throw new Error(r.error);$('aqChapterView').hidden=false;$('aqChapterSelect').innerHTML=r.chapters.map((c,i)=>`<option value="${i}">${esc(c.name)} · ${c.text.length}字</option>`).join('');const show=()=>{$('aqChapterText').textContent=r.chapters[+$('aqChapterSelect').value]?.text || '';};$('aqChapterSelect').onchange=show;show();});
    if($('aqOpenCover'))$('aqOpenCover').onclick=()=>api.openPath(j.cover);
    if($('aqOpenPackage'))$('aqOpenPackage').onclick=()=>api.openPath(j.artifacts.package.replace(/[\\/][^\\/]+$/,''));
    if(a){
      const one=$('aqReviewL1'),two=$('aqReviewL2'),three=$('aqReviewL3');
      const set=(el,values,value)=>{el.innerHTML=opts(values.map(v=>[v,v]));if(values.includes(value))el.value=value;};
      const set3=()=>set(three,site.tree[one.value]?.[two.value]||[],a.novelType[2]);
      const set2=()=>{set(two,Object.keys(site.tree[one.value]||{}),a.novelType[1]);set3();};
      set(one,Object.keys(site.tree),a.channel);set2();one.onchange=set2;two.onchange=set3;$('aqReviewType').value=a.storyType;
    }
    $('aqReviewFirstMode').value=j.scheme.firstSubmitMode||'all';
    $('aqReviewEntry').value=j.overrides.entry||'';$('aqReviewFinished').value=j.overrides.finished||'';
    if($('aqReviewSave'))$('aqReviewSave').onclick=run(async()=>{
      const patch={...($('aqIntroEdit').value.trim()?{intro:$('aqIntroEdit').value.trim()}:{}),firstSubmitMode:$('aqReviewFirstMode').value,firstChapterCount:Number($('aqReviewFirstCount').value),firstMinChapters:Number($('aqReviewFirstMin').value),firstMaxChapters:Number($('aqReviewFirstMax').value),ackWarnings:!!$('aqAck')?.checked,entry:$('aqReviewEntry').value,finished:$('aqReviewFinished').value};
      if(a && !j.repairSource && $('aqApproveAnalysis').checked)patch.analysis={...a,channel:$('aqReviewL1').value,novelType:[$('aqReviewL1').value,$('aqReviewL2').value,$('aqReviewL3').value],storyType:$('aqReviewType').value,tags:[...dialog.querySelectorAll('.aq-tags input:checked')].map(x=>x.value)};
      await control('review',id,patch);closeDialog();
    });
    if($('aqRebind') && j.repairSource)$('aqRebind').hidden=true;
    if($('aqRebind'))$('aqRebind').onclick=run(async()=>{await control('review',id,{useCurrentSettings:true});closeDialog();});
    if($('aqDetailRetry'))$('aqDetailRetry').onclick=run(async()=>{await control('retry',id);closeDialog();});
    if($('aqNoCreate'))$('aqNoCreate').onclick=run(async()=>{if(confirm('请确保已检查蛙蛙站内列表，并确认此次创建确实没有成功。继续将允许重新创建该书。')){await control('confirm-no-create',id);closeDialog();}});
    if($('aqNotSubmitted'))$('aqNotSubmitted').onclick=run(async()=>{if(confirm('确认已检查站点状态？继续会读取最新章节状态，并重新提交仍未投稿的章节。')){await control('confirm-not-submitted',id);closeDialog();}});
  }
  async function refreshSettings(){const [s,c]=await Promise.all([api.getSettings(),api.getCredentials()]);$('aqGlobalConcurrency').value=s.submissionConcurrency||2;$('aqPenName').textContent=`笔名库：${s.penNames?.filter(p=>p.enabled!==false).length||0}个可用`;document.querySelector('.login-status').textContent=c.has?'已配置账号（投稿时验证）':'未配置账号';document.querySelector('.login-phone').textContent=String(c.phone||'').replace(/^(\d{3})\d{4}(\d{4})$/,'$1****$2');}
  document.addEventListener('click',e=>{if(e.target.closest('[data-page="automation"]'))run(refreshSettings)();});
  api.onAutomationState(next=>{state=next;renderSchemes();render();});
  run(async()=>{[state,library]=await Promise.all([api.automationState(),api.getSiteData()]);defaults=state.schemes.find(s=>s.name===state.defaultScheme)||state.schemes[0]||{name:'默认自动包装',introStyle:'贴合内容，突出冲突，保留悬念',coverStyle:'根据小说内容选择，竖版，清晰书名与作者署名',storyRule:'words',longThreshold:20000,entry:'auto',finished:'analysis',destination:'submit',imageSize:'1024x1536',autoStart:true,concurrency:1,retries:2,titleAttempts:2};$('aqEntry').innerHTML=opts([['auto','根据内容匹配（长篇默认普通投稿）'],...(library.entries||[]).map(e=>[e,e])]);renderSchemes();fillScheme(defaults);$('aqSchemes').value=defaults.name;render();await refreshSettings();message('选择包装方案后批量导入。正常稿件自动完成，只有异常需要处理；重启后点击“继续队列”接着执行。');})();
})();
