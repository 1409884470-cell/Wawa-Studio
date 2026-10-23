(() => {
  'use strict';
  const api=window.api;if(!api?.studio)return;
  const $=s=>document.querySelector(s), escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let snapshot,config,tab='general',polling=false,editor,selectedPrompt,ideas=[],ideasBusy=false;
  const ideaStore='wawa-idea-drafts-v44';
  function saveIdeas(){try{localStorage.setItem(ideaStore,JSON.stringify({ideas,genre:$('#studioGenre').value,seed:$('#studioPremise').value,style:$('#studioIdeaStyle').value,count:$('#studioIdeaCount').value}));}catch{}}
  const promptDrafts=new Map(),settingsDrafts=new Map();
  function stashSettings(){if(!['general','writer','ai'].includes(tab))return;const fields=[...document.querySelectorAll('#studioSettingsBody [data-setting],#studioSettingsBody [data-ai-field]')];if(fields.length)settingsDrafts.set(tab,fields.map(e=>({value:e.value,checked:e.checked})));}
  function restoreSettings(){const d=settingsDrafts.get(tab);if(!d)return;document.querySelectorAll('#studioSettingsBody [data-setting],#studioSettingsBody [data-ai-field]').forEach((e,i)=>{if(d[i]){e.value=d[i].value;e.checked=d[i].checked;}});}
  function stashPrompt(){if(selectedPrompt&&$('#studioPromptText'))promptDrafts.set(selectedPrompt.id,$('#studioPromptText').value);}
  const checked=selector=>[...document.querySelectorAll(selector+':checked')].map(e=>e.value);
  const selectAll=(label,selector)=>`<label class="studio-help"><input type="checkbox" data-select-all="${selector}"> ${label}</label>`;
  const statuses={archived:'已移出生产队列',pending:'排队中',running:'写作中',paused:'已暂停',pausing:'正在保存',retry_wait:'等待重试',completed:'已完稿',failed:'需要处理',needs_review:'待检查',queued:'准备投稿',attention:'需要处理',watching:'跟踪审核',blocked:'拒稿待处理',done:'已完成',canceled:'已停止',waiting:'等待额度／笔名'};
  const button=(text,action,extra='')=>`<button class="btn btn-sm" data-studio="${action}" ${extra}>${text}</button>`;
  async function call(method,data){const r=await api.studio(method,data);if(!r.ok)throw new Error(r.error||'操作失败');return r.data;}
  function notice(message,error=false){const n=$('#studioNotice');if(n){n.textContent=message;n.classList.toggle('error',error);}else toast(message,error?'⚠️':'✅');}
  function page(id,label){const el=document.createElement('section');el.className='page';el.id='page-'+id;$('.main').appendChild(el);return el;}
  const production=page('production'),productionRecords=page('production-records'),submissionRecords=page('submission-records'),runRecords=page('run-records'),library=page('library'),settings=page('studio-settings');
  const nav=$('.nav');
  const groups=[['创作工作室',[['production','◈','生产工作台'],['library','▤','作品书库']]],['任务记录',[['production-records','▦','写作任务'],['submission-records','⇧','投稿记录'],['run-records','≡','运行记录']]],['投稿与设置',[['automation','✦','自动投稿中心'],['revenue','▥','收益数据'],['studio-settings','⚙','设置']]]];
  nav.innerHTML=groups.map(([label,items])=>`<div class="nav-group"><div class="nav-label">${label}</div>${items.map(([id,icon,title])=>`<button class="nav-item" data-page="${id}"><span class="nav-ico">${icon}</span><span>${title}</span></button>`).join('')}</div>`).join('');
  const legacyAccount=$('#page-account');
  for(const id of ['workbench','tasks','short','cover','text','logs','ai','account']){
    const section=$('#page-'+id);if(section)section.hidden=true;
  }

  production.innerHTML=`<div class="studio-hero"><div><div class="studio-kicker">WAWA / CREATIVE STUDIO</div><h1>创作工作台</h1><p>脑洞 → 写作 → 书库 → 投稿</p></div><div class="studio-actions"><button class="btn btn-primary" data-studio="start">▶ 启动全流程</button>${button('暂停全部','pause')}<button class="btn" data-goto="production-records">写作任务</button><button class="btn" data-goto="submission-records">投稿记录</button></div></div><div id="studioNotice" class="studio-notice">正在读取工作室…</div><div class="studio-grid" id="studioMetrics"></div><div class="studio-card"><div class="studio-toolbar"><h2>批量脑洞生成</h2><span class="studio-help">先生成企划，再选择加入生产队列</span></div><div class="studio-form"><label>题材<input id="studioGenre" value="都市"></label><label>生成数量<input id="studioIdeaCount" type="number" value="3" min="1" max="30"></label><label>脑洞风格<select id="studioIdeaStyle"><option>随机混合</option><option>番茄风</option><option>飞卢风</option><option>七猫风</option><option>起点风</option></select></label><div class="studio-help">风格同时用于剧情与书名。方向可留空。</div><label class="studio-full">脑洞方向／创意种子<textarea id="studioPremise" placeholder="例如：普通外卖员获得穿梭不同年代的能力。可留空，由 AI 自由发挥。"></textarea></label></div><div class="studio-actions" style="margin-top:16px"><button class="btn btn-primary" data-studio="ideas">生成脑洞企划</button><button class="btn" data-prompt-open="writer:idea_expand">脑洞提示词</button><span class="studio-help">可编辑，支持追加生成。</span></div><div id="studioIdeas"></div></div>`;
  try{const draft=JSON.parse(localStorage.getItem(ideaStore)||'null');if(draft){ideas=Array.isArray(draft.ideas)?draft.ideas:[];$('#studioGenre').value=draft.genre||'都市';$('#studioPremise').value=draft.seed||'';$('#studioIdeaStyle').value=draft.style||'随机混合';$('#studioIdeaCount').value=draft.count||3;}}catch{}
  renderIdeas();
  productionRecords.innerHTML=`<div class="studio-hero"><div><div class="studio-kicker">PRODUCTION RECORDS</div><h1>写作任务</h1><p>待写与在写作品；完稿自动进入书库。</p></div><button class="btn" data-goto="production">返回脑洞生成</button></div><div class="studio-card"><div class="studio-toolbar"><h2>写作任务</h2><div class="studio-actions"><input id="studioWritingSearch" placeholder="搜索书名" aria-label="搜索写作任务"><select id="studioWritingFilter"><option value="all">全部未完稿</option><option value="pending">待写</option><option value="running">正在写</option><option value="paused">已暂停</option><option value="failed">需处理</option></select>${button('批量继续','batch-retry')}${button('批量暂停','batch-pause')}${button('批量收尾','batch-finish')}${selectAll('全选','[data-book-select]')}${button('批量删除','delete-books')}</div></div><div class="studio-table-wrap"><table class="studio-table"><thead><tr><th></th><th>作品</th><th>写作进度</th><th>操作</th></tr></thead><tbody id="studioJobs"></tbody></table></div></div>`;
  submissionRecords.innerHTML=`<div class="studio-hero"><div><div class="studio-kicker">SUBMISSION RECORDS</div><h1>投稿记录</h1><p>查看包装、投稿、审核与签约后补传进度。</p></div><div class="studio-actions">${button("修复未上传作品书名","restore-titles")}<button class="btn" data-goto="automation">打开投稿方案</button></div></div><div class="aq-notice" id="aqRecordsMessage" role="status">投稿任务会在这里实时更新。</div><div id="studioPendingSubmissions"></div>`;
  submissionRecords.append($('#aqStats'),$('#aqJobs').closest('.aq-panel'));
  $('#aqJobs').closest('.aq-panel').querySelector('h2').textContent='投稿任务';
  $('#page-automation').insertAdjacentHTML('beforeend','<div class="studio-card"><h2>查看投稿进度</h2><p>包装、审核、批量操作和任务详情集中在左侧“投稿记录”。</p><button class="btn btn-primary" data-goto="submission-records">打开投稿记录</button></div>');
  runRecords.innerHTML=`<div class="studio-hero"><div><div class="studio-kicker">RUN HISTORY</div><h1>运行记录</h1><p>查看写作过程及投稿引擎的运行日志。</p></div>${button('刷新记录','refresh')}</div><div class="studio-card"><h2>写作运行记录</h2><pre class="studio-code" id="studioLogs"></pre></div><div class="studio-toolbar" id="studioPostLogToolbar"><h2>投稿与系统运行记录</h2></div>`;
  $('#studioPostLogToolbar').append($('#page-logs .logs-actions'));
  runRecords.append($('#page-logs .logs-card'));
  library.innerHTML=`<div class="studio-hero"><div><div class="studio-kicker">YOUR BOOKS</div><h1>作品书库</h1><p>已完稿及已导入的完整作品。</p></div>${button('刷新书库','refresh')}</div><div class="studio-card"><div class="studio-actions"><input id="studioLibrarySearch" placeholder="搜索书名或笔名" aria-label="搜索书库"><select id="studioLibraryFilter"><option value="all">全部作品</option><option value="ready">待投稿</option><option value="processing">投稿中</option><option value="attention">需处理</option><option value="done">已提交</option></select>${selectAll('全选','[data-library-select]')}${button('批量导出','export-library')}${button('批量删除','delete-library')}<span class="studio-help">本地删除保留回收副本</span></div><div id="studioLibrary"></div></div>`;
  settings.innerHTML=`<div class="studio-hero"><div><div class="studio-kicker">PREFERENCES</div><h1>流程与提示词设置</h1><p>修改后请保存。未保存草稿仅在本次运行保留。</p></div></div><div class="studio-tabs" id="studioTabs">${[['general','自动流程'],['ai','AI 设置'],['writer','写作参数'],['account','平台账号'],['pens','笔名库'],['prompts','提示词设置']].map(([k,t])=>`<button data-settings-tab="${k}">${t}</button>`).join('')}</div><div id="studioSettingsBody"></div>`;
  const legacySettings=document.createElement('div');legacySettings.id='studioLegacySettings';settings.appendChild(legacySettings);
  for(const section of [legacyAccount]){section.classList.remove('page','active');legacySettings.appendChild(section);section.hidden=true;}
  const dialog=document.createElement('dialog');dialog.className='studio-dialog';dialog.id='studioEditor';document.body.appendChild(dialog);
  window.studioNavigate=id=>{if(id==='studio-settings')loadConfig().catch(fail);if(['production','production-records','submission-records','run-records','library'].includes(id))refresh().catch(fail);};
  function fail(e){notice(e.message||String(e),true);toast(e.message||String(e),'⚠️');}
  async function refresh(){if(polling)return;polling=true;try{snapshot=await call('snapshot');render();}finally{polling=false;}}
  function render(){
    const books=snapshot.queue.items,jobs=snapshot.automation.jobs;
    const writing=books.filter(b=>b.status!=='completed');
    const metrics=[['待写',writing.filter(b=>['pending','retry_wait'].includes(b.status)).length,'排队等待'],['正在写作',books.filter(b=>b.status==='running').length,'独立断点保存'],['投稿处理中',jobs.filter(j=>['running','queued','watching','waiting'].includes(j.status)).length,'自动包装及审核跟踪'],['需要处理',jobs.filter(j=>['attention','blocked'].includes(j.status)).length+books.filter(b=>b.status==='failed').length,'查看具体原因后重试']];
    $('#studioMetrics').innerHTML=metrics.map(([t,n,h])=>`<div class="studio-metric"><span>${t}</span><b>${n}</b><span>${h}</span></div>`).join('');
    if(!ideasBusy&&!$('#studioNotice').classList.contains('error'))notice(snapshot.enabled?'全流程已启用 · 完稿后按当前方案自动包装投稿':'全流程已暂停 · 创建作品后点击“启动全流程”');
    const selected=new Set([...document.querySelectorAll('[data-book-select]:checked')].map(e=>e.value));
    const query=($('#studioWritingSearch').value||'').trim(),filter=$('#studioWritingFilter').value;
    $('#studioJobs').innerHTML=writing.filter(b=>b.book_name.includes(query)&&(filter==='all'||filter==='failed'&&['failed','needs_review'].includes(b.status)||filter==='pending'&&['pending','retry_wait'].includes(b.status)||b.status===filter)).map(b=>{
      return `<tr><td><input type="checkbox" data-book-select value="${escape(b.id)}" ${selected.has(b.id)?'checked':''}></td><td><strong>${escape(b.book_name)}</strong><small>${escape(b.genre)} · ${escape(b.id.slice(-8))}</small>${b.error?`<small style="color:var(--red)">${escape(b.error)}</small>`:''}</td><td>${escape(statuses[b.status]||b.status)}${progress(Math.min(99,Math.floor((b.completed_chapters||0)/Math.max(1,b.chapter_count)*100)))}<small>${b.completed_chapters||0} / ${b.chapter_count}章 · ${b.total_words_actual||0}字</small><small>${escape(b.phase)}</small></td><td>${button('阅读','read',`data-id="${b.id}"`)}${['running','pending','retry_wait'].includes(b.status)?button('暂停','book-pause',`data-id="${b.id}"`):''}${['paused','failed','needs_review'].includes(b.status)?button('继续','book-resume',`data-id="${b.id}"`):''}${['running','paused','pending'].includes(b.status)?button('现在收尾','book-finish',`data-id="${b.id}"`):''}</td></tr>`;
    }).join('')||'<tr><td colspan="4" class="studio-empty">还没有生产任务。生成脑洞企划，选择后加入生产队列。</td></tr>';
    $('#studioLogs').textContent=snapshot.logs.join('\n')||'暂无运行记录';
    const waiting=books.filter(b=>b.status==='completed'&&!snapshot.links[b.id]?.jobId&&!snapshot.links[b.id]?.deleted&&!jobs.some(j=>j.writerId===b.id));
    $('#studioPendingSubmissions').innerHTML=waiting.length?`<div class="studio-card" style="margin-top:18px"><h2>待转入投稿</h2>${waiting.map(b=>`<p><b>${escape(b.book_name)}</b> · ${escape(snapshot.links[b.id]?.error||'已完稿，等待全流程转入投稿')}</p>`).join('')}</div>`:'';

    const libraryBooks=[...books.filter(b=>b.status==='completed'),...snapshot.library.filter(b=>b.id&&(b.status==='completed'||b.kind==='full')&&!books.some(x=>x.id===b.id)).map(b=>({...b,completed_chapters:b.chapters,total_words_actual:b.words,status:'completed'}))];
    const selectedLibrary=new Set(checked('[data-library-select]'));
    const lq=$('#studioLibrarySearch').value.trim(),lf=$('#studioLibraryFilter').value;
    const matches=(title,pen,j)=>[title,pen].join(' ').includes(lq)&&(lf==='all'||libraryStatus(j).group===lf);
    const rows=libraryBooks.filter(b=>{const j=jobs.find(x=>x.writerId===b.id&&!x.hidden);return matches(b.book_name,j?.settings.penName||'',j);}).map(b=>{const j=jobs.find(x=>x.writerId===b.id&&!x.hidden);return `<tr><td><input type="checkbox" data-library-select value="book:${escape(b.id)}" ${selectedLibrary.has("book:"+b.id)?"checked":""}> <strong>${escape(b.book_name)}</strong><small>${escape(b.genre)}</small></td><td>${escape(j?.settings.penName||'待分配')}</td><td>${b.completed_chapters||0}章 / ${b.total_words_actual||0}字</td><td><b>${escape(libraryStatus(j).text)}</b>${progress(libraryStatus(j).percent)}${j?.error?`<small class="studio-error">${escape(j.error.message)}</small>`:''}</td><td>${button('阅读／编辑','read',`data-id="${b.id}"`)}${button('导出正文','export',`data-id="${b.id}"`)}</td></tr>`;});
    for(const j of jobs.filter(j=>!j.writerId&&!j.hidden&&j.artifacts?.chapters&&matches(j.title,j.settings.penName,j)))rows.push(`<tr><td><input type="checkbox" data-library-select value="post:${escape(j.id)}" ${selectedLibrary.has("post:"+j.id)?"checked":""}> ${escape(j.title)}<small>导入作品</small></td><td>${escape(j.settings.penName||'待分配')}</td><td>${j.chapterCount||0}章 / ${j.words||0}字</td><td><b>${escape(libraryStatus(j).text)}</b>${progress(libraryStatus(j).percent)}</td><td>${button('查看章节','read-post',`data-id="${j.id}"`)}</td></tr>`);
    $('#studioLibrary').innerHTML=`<table class="studio-table"><thead><tr><th>作品</th><th>笔名</th><th>正文</th><th>投稿状态 / 进度</th><th>操作</th></tr></thead><tbody>${rows.join('')||'<tr><td colspan="5" class="studio-empty">书库为空</td></tr>'}</tbody></table>`;
  }
  const progress=n=>`<div class="studio-progress"><progress max="100" value="${n}" aria-label="完成进度 ${n}%"></progress><span>${n}%</span></div>`;
  function libraryStatus(j){if(!j||j.hidden||j.status==='canceled')return {group:'ready',text:'已完稿 · 待投稿',percent:0};const steps=['inspect','catalog','analysis','title','intro','entry','prompt','cover','check','upload','format','submit','verify'];const percent=j.status==='done'&&j.scheme?.destination==='package'?62:j.status==='done'&&j.scheme?.destination==='library'?77:['watching','done','blocked'].includes(j.status)?100:Math.max(0,Math.round(Math.max(0,steps.indexOf(j.stage))/steps.length*100));return {group:j.status==='done'&&j.scheme?.destination==='package'?'ready':['attention','blocked'].includes(j.status)?'attention':['watching','done'].includes(j.status)?'done':'processing',text:j.result||({watching:'已投稿 · 审核中',done:j.scheme?.destination==='package'?'包装完成 · 未上传':j.scheme?.destination==='library'?'已上传草稿':'已提交',blocked:'审核未通过',attention:'需要处理',queued:'等待投稿处理',running:'正在处理',waiting:'等待笔名 / 额度'}[j.status]||statuses[j.status]),percent};}
  async function deleteItems(kind,ids){if(!ids.length)throw new Error('请先勾选记录');const results=await call('delete-items',{kind,ids});const errors=results.filter(r=>!r.success);if(errors.length)throw new Error(errors.map(r=>r.error).join('；'));toast('已删除所选记录，执行中的任务会保存后停止');}
  function renderIdeas(){
    $('#studioIdeas').innerHTML=ideas.length?`<div class="studio-toolbar" style="margin-top:18px"><h2>脑洞企划 · ${ideas.filter(b=>!b.added).length} 个待加入</h2><div class="studio-actions">${selectAll('全选','[data-idea-select]')}<button class="btn btn-primary" data-studio="add-ideas">所选加入生产队列</button>${button('删除所选企划','delete-ideas')}</div></div>`+ideas.map(b=>`<div class="studio-idea-card"><label><input type="checkbox" data-idea-select value="${b.id}"> <b>${escape(b.book_name)}</b> <span class="studio-badge">${escape(b.platform_style||'自定义')}</span>${b.added?' · 已加入队列':''}</label><details ${b.added?'':'open'}><summary>查看 / 编辑企划</summary><div class="studio-form"><label>书名<input data-idea-id="${b.id}" data-idea-field="book_name" value="${escape(b.book_name)}" ${b.added?'disabled':''}></label><label>主角<input data-idea-id="${b.id}" data-idea-field="protagonist" value="${escape(b.protagonist||'')}" ${b.added?'disabled':''}></label><label class="studio-full">核心剧情<textarea data-idea-id="${b.id}" data-idea-field="core_premise" ${b.added?'disabled':''}>${escape(b.core_premise)}</textarea></label></div><small>${escape(b.style_brief||'')}</small></details></div>`).join(''):'';
    saveIdeas();
  }
  function renderAI(){
    const s=config.settings,w=config.writer.api;
    const roles=[['writer','写作与脑洞生成',w.has_api_key?w.base_url:'',w.has_api_key?w.model:'',w.has_api_key],['text','投稿资料与正文修订',s.apiBaseUrl,s.textModel,!!s.apiKey],['image','封面生成',s.imgApiBaseUrl,s.imageModel,!!s.imgApiKey]];
    $('#studioSettingsBody').innerHTML=`<div class="studio-card"><div class="studio-toolbar"><h2>AI 设置</h2><div class="studio-actions">${selectAll('全选','[data-ai-select]')}${button('批量删除配置','delete-ai')}<button class="btn btn-primary" data-studio="save-ai">保存 AI 设置</button></div></div><p>密钥留空保留原值。</p></div>`+roles.map(([role,label,base,model,hasKey])=>`<div class="studio-card" data-ai-role="${role}"><h2><input type="checkbox" data-ai-select value="${role}"> ${label}</h2><div class="studio-form"><label>接口地址<input data-ai-field="baseUrl" value="${escape(base||'')}" placeholder="https://example.com/v1"></label><label>模型名称<input data-ai-field="model" value="${escape(model||'')}"></label><label class="studio-full">API 密钥${hasKey?'（已保存，留空保留）':''}<input data-ai-field="apiKey" type="password" autocomplete="off" placeholder="${hasKey?'留空保留':'填写密钥'}"></label></div><div class="studio-actions" style="margin-top:12px"><button class="btn" data-studio="test-ai" data-role="${role}">${role==='image'?'生成测试图':'测试连接'}</button><span data-ai-test-status="${role}" role="status"></span></div><p>${role==='image'?'测试会实际生成一张图片，按接口计费。':'测试使用当前表单，密钥留空时使用已保存密钥；不会保存表单改动。'}</p></div>`).join('');
  }
  window.renderStudioAccounts=list=>{
    let box=$('#studioAccountBatch');if(!box){box=document.createElement('div');box.className='card';box.id='studioAccountBatch';legacyAccount.appendChild(box);}
    box.innerHTML=`<div class="studio-toolbar"><h3>已保存账号</h3><div class="studio-actions">${selectAll('全选','[data-account-select]')}${button('批量删除账号','delete-accounts')}</div></div><p class="studio-help">删除当前账号时会清除本机登录凭据；平台账号本身不受影响。</p>`+list.map(a=>`<label style="display:block;padding:10px"><input type="checkbox" data-account-select value="${escape(a.name)}"> ${escape(a.name)} · ${escape(a.phone)}</label>`).join('');
  };
  const field=(key,label,value,type='number',help='')=>`<label>${label}<input data-setting="${key}" type="${type}" ${type==='checkbox'?(value?'checked':''):`value="${escape(value)}"`}><small>${help}</small></label>`;
  async function loadConfig(){config=await call('settings');renderSettings();}
  function renderSettings(){
    $('#studioTabs').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.settingsTab===tab));
    const host=$('#studioSettingsBody'),s=config.settings,w=config.writer;
    legacyAccount.hidden=tab!=='account';host.hidden=tab==='account';


    if(tab==='general')host.innerHTML=`<div class="studio-card"><h2>全自动流程</h2><div class="studio-form">${field('submissionConcurrency','投稿同时处理本数（1—6）',s.submissionConcurrency)}${field('autoSubmitCompleted','完稿后自动进入投稿',s.autoSubmitCompleted,'checkbox')}${field('resumeOnStartup','重启后恢复此前启用的全流程',s.resumeOnStartup,'checkbox')}${field('autoRepairRejected','启用审核失败自动重投',s.autoRepairRejected!==false,'checkbox')}${field('qualityResubmits','质量问题：最多重新投稿次数',s.qualityResubmits)}${field('otherResubmits','非质量问题：最多重新投稿次数',s.otherResubmits)}${field('unknownResubmits','原因不明：最多重新投稿次数',s.unknownResubmits)}${field('rewriteConcurrency','修订章节并发数',s.rewriteConcurrency)}${field('reviewPollMinutes','审核状态检查间隔（分钟）',s.reviewPollMinutes)}${field('submissionDailyLimit','账号每日新投稿上限（0不限）',s.submissionDailyLimit)}${field('submissionGapSeconds','新投稿间隔（秒）',s.submissionGapSeconds)}${field('revenueConcurrency','收益历史采集并发（1—6）',s.revenueConcurrency)}${field('revenueDelayMs','收益请求间隔（毫秒）',s.revenueDelayMs)}${field('revenueRefreshMinutes','自动收益同步间隔（分钟，0关闭）',s.revenueRefreshMinutes)}${field('excludeRejectedRevenue','收益统计排除审核失败作品',s.excludeRejectedRevenue,'checkbox')}</div><p>次数指首次投稿之外的重投次数；0 为不重投。</p><button class="btn btn-primary" data-studio="save-general">保存流程设置</button></div><div class="studio-card"><h2>首投与包装方案</h2><p>首投章节范围、签约后补传、目标步骤和网络重试次数，请在自动投稿中心的方案中设置。完稿使用默认方案。</p><button class="btn" data-goto="automation">打开投稿方案</button></div>`;
    if(tab==='ai')renderAI();
    if(tab==='account')loadAccountPage().catch(fail);
    if(tab==='writer'){
      const names={base_url:'接口地址',model:'模型名称',api_key:'API 密钥（留空保留）',polish_chapters:'前几章精写（0—100）',full_book_polish:'全书精写（覆盖上述章数）',temperature:'温度',max_tokens:'输出 Token 上限',timeout:'首包等待（秒）',idle_timeout:'接收空闲（秒）',total_timeout:'单次总时限（秒）',stream:'流式接收',concurrency:'同时写作本数',request_delay:'请求间隔（秒）',max_retries:'单次请求尝试次数',chapter_count_per_book:'每本章节上限',chapter_words_target:'每章目标字数',min_words_ratio:'最低字数比例',repair_attempts:'正文修订次数',book_words_target:'全书目标字数',book_words_limit:'全书字数上限'};
      host.innerHTML=`<div class="studio-card"><h2>写作参数</h2><div class="studio-form">${['api','generation'].flatMap(section=>Object.entries(w[section]).filter(([k])=>!['has_api_key','base_url','model','api_key'].includes(k)).map(([k,v])=>field(section+'.'+k,names[k]||k,v,typeof v==='boolean'?'checkbox':typeof v==='number'?'number':'text'))).join('')}</div><p>精写增加章纲与正文审查。修改用于后续章节。</p><button class="btn btn-primary" data-studio="save-writer">保存写作设置</button></div>`;
    }
    if(tab==='pens')renderPens();
    if(tab==='prompts')renderPrompts();
    restoreSettings();
  }
  function renderPens(){const s=config.settings;$('#studioSettingsBody').innerHTML=`<div class="studio-card"><h2>笔名库</h2><p>账号、频道、题材留空不限；额度 0 为不限。</p><div class="studio-form"><label>分配方式<select id="studioPenMode"><option value="balanced">作品数量最少优先</option><option value="roundRobin">最近投稿最早优先</option></select></label><label>批量新增，一行一个<textarea id="studioPenImport" placeholder="笔名一&#10;笔名二"></textarea></label></div><div class="studio-actions" style="margin:12px 0">${selectAll('全选','[data-pen-select]')}${button('添加到列表','add-pens')}${button('批量删除','delete-pens')}<button class="btn btn-primary" data-studio="save-pens">保存笔名库</button></div><div class="studio-table-wrap"><table class="studio-table studio-pen-list"><thead><tr><th>笔名</th><th>账号手机号</th><th>频道</th><th>题材</th><th>累计上限</th><th>每日上限</th><th>间隔分钟</th><th>启用</th><th>占用</th></tr></thead><tbody>${s.penNames.map((p,i)=>{const stats=snapshot?.pens.find(x=>x.id===p.id);return `<tr data-pen-row="${i}"><td><input type="checkbox" data-pen-select value="${i}"><input data-key="name" value="${escape(p.name)}"></td><td><input data-key="account" value="${escape(p.account)}"></td><td><select data-key="channel">${['','男频','女频'].map(x=>`<option ${x===p.channel?'selected':''}>${x}</option>`).join('')}</select></td><td><input data-key="genre" value="${escape(p.genre)}"></td>${['limit','dailyLimit','gapMinutes'].map(k=>`<td><input data-key="${k}" type="number" min="0" value="${p[k]||0}"></td>`).join('')}<td><input data-key="enabled" type="checkbox" ${p.enabled!==false?'checked':''}></td><td>${stats?.submitted||0}已投<br>${stats?.reserved||0}预留</td></tr>`;}).join('')||'<tr><td colspan="9" class="studio-empty">尚未添加笔名，自动投稿会等待你添加可用笔名。</td></tr>'}</tbody></table></div></div>`;$('#studioPenMode').value=s.penMode;}
  function readPens(){return [...document.querySelectorAll('[data-pen-row]')].map(row=>{const p={...config.settings.penNames[Number(row.dataset.penRow)]};row.querySelectorAll('[data-key]').forEach(e=>p[e.dataset.key]=e.type==='checkbox'?e.checked:e.type==='number'?Number(e.value):e.value.trim());return p;});}
  const promptUsage={ideas:'点击首页“生成脑洞企划”时调用；{v0} 是企划数量。',style:'正文生成和正文修订时调用。',natural_style:'仅精写章节的生成、续写、审查和修订使用。',prompt_0:'仅精写章节调用 AI 连续性检查；快速章节使用本地验收。',prompt_1:'每本书首次建立全书设定时调用；恢复已有设定不会重复调用。',prompt_2:'精写范围内的正文生成；开启全书精写时用于全部章节。',prompt_3:'精写范围之外的快速正文生成；全书精写时不调用。',prompt_4:'收尾章节附加要求。',prompt_5:'连续性审查发现问题并执行修订时调用。',prompt_6:'正文不足或中断，需要续写时调用。',prompt_7:'精写章节的章纲审查时调用。',chapter_plan:'生成新一批章节大纲；{v0}/{v1}/{v2} 为起始章/结束章/总章数。',plan_repair:'章纲审查发现问题时调用；{v0}/{v1} 为修订起止章。',entry:'需要自动匹配征文入口时调用；普通长篇默认入口不调用。',tagMatch:'内容分析没有任何有效标签时，自动从当前标签库重选。',rewrite:'审核被拒且对应重投次数未用完时，逐章修订正文。',title:'原书名评分不足或重名时调用；评分通过则沿用原名。',analysis:'首次分析投稿正文时调用；有效分析已有缓存时不重复。',score:'检查原名或新书名的评分时调用。',intro:'生成投稿简介时调用；原稿已有简介则保留原简介。',coverStyle:'根据每本书的内容提取画材、配色和表现方式；只调用这一次封面文本分析。',idea_expand:'每次脑洞生成时补全用户方向；四个平台风格提示词也会随所选风格调用。'};
  function promptOptions(){return [
    ...Object.keys(config.writer.prompts).map(k=>({id:'writer:'+k,label:'写作 / '+(config.labels[k]||'通用文风'),value:config.writer.prompts[k],default:config.defaults.prompts[k],help:promptUsage[k]||'后续写作请求使用该提示词。'})),
    ...Object.entries(config.prompts).map(([k,p])=>({id:'post:'+k,label:'投稿 / '+p.label,value:config.settings.promptTemplates?.[k]??p.template,default:p.template,help:(promptUsage[k]||'对应投稿步骤调用。')+'\n'+p.variables.map((v,i)=>`{v${i}} = ${v}`).join('\n')})),
    {id:'setting:coverTemplate',label:'封面 / 基础提示词',value:config.settings.coverTemplate,default:config.coverDefault,help:'支持 {书名}、{笔名}、{画风}、{男女频}、{题材}、{剧情摘要}、{主要人物}、{核心冲突}。书名、笔名、画风变量遗漏时会自动补回并显示。'},
    {id:'setting:coverExtra',label:'封面 / 自定义附加提示词',value:config.settings.coverExtra||'',default:'',help:'直接追加在基础提示词之后。留空表示不附加要求。'},
    {id:'setting:deaiPrompt',label:'修订 / 投稿被拒后的补充要求',value:config.settings.deaiPrompt||'',default:''},
  ];}
  function renderPrompts(){const list=promptOptions();selectedPrompt=list.find(p=>p.id===selectedPrompt?.id)||list[0];$('#studioSettingsBody').innerHTML=`<div class="studio-card"><div class="studio-toolbar"><h2>提示词设置</h2><select id="studioPromptSelect">${['脑洞','写作','投稿','封面','修订'].map(group=>{const items=list.filter(p=>(p.id.startsWith('writer:idea')?'脑洞':p.id.startsWith('writer:')?'写作':p.id.includes('cover')?'封面':p.id.includes('deai')||p.id.endsWith(':rewrite')?'修订':'投稿')===group);return `<optgroup label="${group}">${items.map(p=>`<option value="${p.id}">${escape(p.label)}</option>`).join('')}</optgroup>`;}).join('')}</select></div><p>保存用于后续调用；更新待投稿作品可重做对应步骤。保留变量及 JSON 结构。</p><pre id="studioPromptHelp" class="studio-code"></pre><textarea id="studioPromptText" class="studio-prompt"></textarea><div class="studio-actions" style="margin-top:14px"><button class="btn btn-primary" data-studio="save-prompt">保存本项提示词</button><button class="btn" data-studio="apply-prompt">保存并更新待投稿作品</button>${button('查看最近调用','prompt-usage')}${button('恢复本项默认','reset-prompt')}${button('预览封面拼接','preview-cover')}</div><pre class="studio-code" id="studioCoverPreview"></pre></div>`;$('#studioPromptSelect').value=selectedPrompt.id;showPrompt();}
  function showPrompt(){document.querySelector('[data-studio="apply-prompt"]').hidden=selectedPrompt.id.startsWith('writer:');$('#studioPromptText').value=promptDrafts.get(selectedPrompt.id)??selectedPrompt.value??'';$('#studioPromptHelp').textContent=selectedPrompt.help||'';}
  async function readBook(id){const p=await call('project',{id});editor={id,chapters:p.chapters.filter(c=>c.status==='completed'),post:false};await showEditor(p.book_name);}
  async function showEditor(title){dialog.innerHTML=`<h2>${escape(title)}</h2><select id="studioChapterSelect">${editor.chapters.map((c,i)=>`<option value="${i}">${escape(c.name||`第${c.chapter_num}章 ${c.title}`)}</option>`).join('')}</select><textarea id="studioChapterText" ${editor.post?'readonly':''}></textarea><div class="studio-actions">${editor.post?'':button('保存本章','save-chapter')}${button('关闭','close-editor')}</div><p class="studio-help">修改正文需要先暂停写作。已进入投稿的作品保留投稿快照，修改不会自动覆盖站内内容。</p>`;dialog.showModal();await loadChapter();}
  async function loadChapter(){const c=editor.chapters[Number($('#studioChapterSelect').value)];$('#studioChapterText').value=c?(editor.post?c.text:await call('chapter',{id:editor.id,chapter:c.chapter_num})):'尚无完整保存的章节';}
  async function action(name,target){
    const id=target.dataset.id;
    if(['start','pause','export'].includes(name)){await call(name,{id});notice('操作已完成');}
    else if(name==='test-ai'){
      const role=target.dataset.role,card=target.closest('[data-ai-role]'),status=card.querySelector('[data-ai-test-status]');
      const data=Object.fromEntries([...card.querySelectorAll('[data-ai-field]')].map(e=>[e.dataset.aiField,e.value.trim()]));
      status.textContent='测试中…';
      try{const result=await call('ai-test',{role,...data});status.textContent=`正常 · ${(result.elapsedMs/1000).toFixed(1)}秒 · ${result.message}`;}
      catch(e){status.textContent='失败：'+e.message;throw e;}
      return;
    }
    else if(name==='restore-titles'){const result=await call('restore-titles');toast(`已恢复 ${result.restored} 本原书名，${result.skipped} 本执行中或已上传作品未改动`);}
    else if(name==='refresh')await refresh();
    else if(name==='ideas'){
      ideasBusy=true;notice('正在补充创意并生成不同风格的企划…');saveIdeas();
      try{const r=await call('ideas',{count:Number($('#studioIdeaCount').value),seed:$('#studioPremise').value,genre:$('#studioGenre').value,platform_style:$('#studioIdeaStyle').value,recent_ideas:ideas.slice(-30).map(b=>({book_name:b.book_name,core_premise:b.core_premise}))});
      ideas.push(...r.ideas.map((b,i)=>({...b,id:Date.now()+'-'+i})));renderIdeas();notice('企划已追加，可编辑后勾选加入生产队列');}finally{ideasBusy=false;}
    }else if(name==='add-ideas'){
      const selected=checked('[data-idea-select]');if(!selected.length)throw new Error('请勾选脑洞企划');
      for(const idea of ideas.filter(x=>selected.includes(x.id)&&!x.added)){await call('add',idea);idea.added=true;renderIdeas();}toast('所选企划已加入队列，可在生产记录查看');
    }else if(name==='delete-ideas'){const selected=checked('[data-idea-select]');if(!selected.length)throw new Error('请勾选脑洞企划');ideas=ideas.filter(x=>!selected.includes(x.id));renderIdeas();}
    else if(name==='delete-books'){await deleteItems('books',checked('[data-book-select]'));}
    else if(name==='export-library'){const r=await call('batch-export',{ids:checked('[data-library-select]')});if(!r.canceled){const failures=r.results.filter(x=>!x.success);toast(`已导出 ${r.results.length-failures.length} 本`);if(failures.length)throw new Error(failures.map(x=>x.error).join('；'));}}
    else if(name==='delete-library'){
      const ids=checked('[data-library-select]');if(!ids.length)throw new Error('请勾选书库作品');
      for(const [prefix,kind] of [['book:','books'],['post:','post']]){const selected=ids.filter(id=>id.startsWith(prefix)).map(id=>id.slice(prefix.length));if(selected.length)await deleteItems(kind,selected);}
    }
    else if(name.startsWith('book-'))await call('action',{id,action:name==='book-resume'?'retry':name.slice(5)});
    else if(name.startsWith('batch-')){const ids=[...document.querySelectorAll('[data-book-select]:checked')].map(e=>e.value);if(!ids.length)throw new Error('请先勾选作品');const r=await call('batch',{ids,action:name.slice(6)});if(Array.isArray(r)&&r.some(x=>x?.success===false))throw new Error('部分作品操作失败，请查看任务状态');}
    else if(name==='read')await readBook(id);
    else if(name==='read-post'){const r=await api.automationChapters(id);if(!r.ok)throw new Error(r.error);editor={id,chapters:r.chapters,post:true};await showEditor('投稿正文快照');}
    else if(name==='close-editor')dialog.close();
    else if(name==='save-chapter'){const c=editor.chapters[Number($('#studioChapterSelect').value)];if(!c)throw new Error('没有可编辑章节');await call('save-chapter',{id:editor.id,chapter:c.chapter_num,content:$('#studioChapterText').value});toast('已保存正文');}
    else if(name==='save-general'){
      const patch={};$('#studioSettingsBody').querySelectorAll('[data-setting]').forEach(e=>patch[e.dataset.setting]=e.type==='checkbox'?e.checked:Number(e.value));config.settings=await api.saveSettings(patch);settingsDrafts.delete('general');toast('流程设置已保存');
    }else if(name==='save-writer'){
      const patch={api:{},generation:{}};$('#studioSettingsBody').querySelectorAll('[data-setting]').forEach(e=>{const [s,k]=e.dataset.setting.split('.');patch[s][k]=e.type==='checkbox'?e.checked:e.type==='number'?Number(e.value):e.value;});config.writer=await call('save-config',patch);settingsDrafts.delete('writer');toast('写作设置已保存');
    }else if(name==='save-ai'){
      const data={};document.querySelectorAll('[data-ai-role]').forEach(card=>{const role=card.dataset.aiRole;data[role]=Object.fromEntries([...card.querySelectorAll('[data-ai-field]')].map(e=>[e.dataset.aiField,e.value.trim()]));if(!data[role].baseUrl&&!data[role].model&&!data[role].apiKey)data[role]={clear:true};});
      await call('ai-save',data);settingsDrafts.delete('ai');await loadConfig();toast('AI 设置已保存');
    }else if(name==='delete-ai'){
      const selected=checked('[data-ai-select]');if(!selected.length)throw new Error('请勾选要删除的 AI 配置');await call('ai-save',Object.fromEntries(selected.map(role=>[role,{clear:true}])));settingsDrafts.delete('ai');await loadConfig();toast('所选 AI 配置已删除');
    }else if(name==='delete-accounts'){
      const names=checked('[data-account-select]');if(!names.length)throw new Error('请勾选账号');const r=await api.deleteAccounts(names);if(!r.ok)throw new Error(r.error);await loadAccountPage();toast('所选账号已删除');
    }else if(name==='delete-pens'){
      const selected=new Set(checked('[data-pen-select]').map(Number));if(!selected.size)throw new Error('请勾选笔名');
      const rows=readPens(),ids=rows.filter((p,i)=>selected.has(i)&&p.id).map(p=>p.id);
      const result=await call('delete-pens',{ids});const removed=new Set(result.deleted);
      const survivors=rows.filter((p,i)=>!selected.has(i)||p.id&&!removed.has(p.id));
      config.settings=await api.saveSettings({penNames:survivors,penMode:$('#studioPenMode').value});renderPens();
      if(result.errors.length)throw new Error(result.errors.map(e=>e.error).join('；'));toast('所选笔名已删除');
    }else if(name==='add-pens'){
      config.settings.penNames=readPens();const seen=new Set(config.settings.penNames.map(p=>p.name));for(const name of $('#studioPenImport').value.split('\n').map(s=>s.trim()).filter(Boolean)){if(!seen.has(name)){config.settings.penNames.push({name,account:'',enabled:true,limit:0,dailyLimit:0,gapMinutes:0});seen.add(name);}}renderPens();
    }else if(name==='save-pens'){config.settings=await api.saveSettings({penNames:readPens(),penMode:$('#studioPenMode').value});toast('笔名库已保存');await refresh();renderPens();}
    else if(name==='reset-prompt')$('#studioPromptText').value=selectedPrompt.default||'';
    else if(name==='prompt-usage'){const r=await call('prompt-usage',{id:selectedPrompt.id});$('#studioCoverPreview').textContent=r?r.at+'\n'+r.text:'尚未调用本项。';}
    else if(name==='save-prompt'||name==='apply-prompt'){
      const value=$('#studioPromptText').value,result=await call('save-prompt',{id:selectedPrompt.id,value,apply:name==='apply-prompt'});
      selectedPrompt.value=value;promptDrafts.delete(selectedPrompt.id);await loadConfig();
      toast(name==='apply-prompt'?'已保存，更新 '+result.updated+' 本，跳过 '+result.skipped+' 本执行中或已上传作品':'已保存，用于后续调用');
    }else if(name==='preview-cover'){
      const data={};for(const key of ['coverTemplate','coverExtra'])data[key]=selectedPrompt.id==='setting:'+key?$('#studioPromptText').value:promptDrafts.get('setting:'+key)??config.settings[key];
      $('#studioCoverPreview').textContent='拼接示例（不会请求 AI）\n'+await call('cover-preview',data);
    }else if(name==='delete-revenue'){const ids=checked('[data-revenue-select]');if(!ids.length)throw new Error('请勾选收益记录');const r=await api.deleteRevenue(ids);if(!r.ok)throw new Error(r.error);revData=null;$('#revDataArea').hidden=true;$('#revBody').textContent='所选本地记录已删除，刷新收益查看剩余记录。';toast('已删除本地收益记录');}
    else if(name==='full-revenue')await loadRevenue(false,true);
    else if(name==='match-pen'){await call('match-pen',{sid:$('#studioMatchSid').value,name:$('#studioMatchName').value});toast('匹配已保存，刷新收益后生效');}
    if(!['save-chapter','preview-cover','reset-prompt','ideas'].includes(name))await refresh();
  }
  document.addEventListener('click',e=>{if($('#page-studio-settings').classList.contains('active')&&e.target.closest('[data-page],[data-goto],[data-settings-open],[data-prompt-open]')){stashPrompt();stashSettings();}},true);
  document.addEventListener('input',e=>{if(['studioWritingSearch','studioLibrarySearch'].includes(e.target.id)){render();return;}if(e.target.dataset.ideaField){const b=ideas.find(b=>b.id===e.target.dataset.ideaId);if(b&&!b.added){b[e.target.dataset.ideaField]=e.target.value;saveIdeas();}}if(['studioGenre','studioPremise','studioIdeaStyle','studioIdeaCount'].includes(e.target.id))saveIdeas();});
  document.addEventListener('click',e=>{const promptLink=e.target.closest('[data-prompt-open]');if(promptLink){tab='prompts';selectedPrompt={id:promptLink.dataset.promptOpen};showPage('studio-settings');return;}const settingsLink=e.target.closest('[data-settings-open]');if(settingsLink){tab=settingsLink.dataset.settingsOpen;showPage('studio-settings');return;}const tabButton=e.target.closest('[data-settings-tab]');if(tabButton){stashPrompt();stashSettings();tab=tabButton.dataset.settingsTab;renderSettings();return;}const target=e.target.closest('[data-studio]');if(!target||target.disabled)return;target.disabled=true;action(target.dataset.studio,target).catch(fail).finally(()=>{if(target.dataset.studio!=='add-idea')target.disabled=false;});});
  document.addEventListener('change',e=>{if(['studioWritingFilter','studioLibraryFilter'].includes(e.target.id)){render();return;}if(e.target.dataset.selectAll){document.querySelectorAll(e.target.dataset.selectAll).forEach(item=>{if(!item.disabled)item.checked=e.target.checked;});}if(e.target.id==='studioPromptSelect'){stashPrompt();selectedPrompt=promptOptions().find(p=>p.id===e.target.value);showPrompt();}if(e.target.id==='studioChapterSelect')loadChapter().catch(fail);if(e.target.id==='studioRevPen'){window.studioPenFilter=e.target.value;renderRevenue();}});
  let lastRevRefresh=0;
  setInterval(()=>{if(['production','production-records','submission-records','run-records','library'].some(id=>$('#page-'+id)?.classList.contains('active')))refresh().catch(fail);const mins=config?.settings.revenueRefreshMinutes;if(mins&&Date.now()-lastRevRefresh>=mins*60000){lastRevRefresh=Date.now();loadRevenue(true).catch(fail);}},5000);
  window.renderStudioRevenue=r=>{
    if(!$('#studioRevControls'))$('#revDataArea').insertAdjacentHTML('afterbegin',`<div class="studio-card" id="studioRevControls"><div class="studio-toolbar"><h2>笔名收益</h2><select id="studioRevPen" aria-label="筛选笔名"></select>${button('补齐全部历史','full-revenue')}${selectAll('全选','[data-revenue-select]')}${button('批量删除记录','delete-revenue')}</div><p>分组汇总可选择“笔名”；下方单书列表按笔名筛选。旧作品无法自动匹配时，可按平台作品ID绑定。</p><div class="studio-actions"><input id="studioMatchSid" placeholder="平台投稿ID" aria-label="平台投稿ID"><input id="studioMatchName" placeholder="对应笔名" aria-label="对应笔名">${button('保存笔名匹配','match-pen')}</div></div>`);
    $('#studioRevPen').innerHTML='<option value="">全部笔名</option>'+[...new Set(r.books.map(b=>b.penName||'未匹配'))].map(p=>`<option value="${escape(p)}">${escape(p)}</option>`).join('');$('#studioRevPen').value=window.studioPenFilter||'';
  };
  loadConfig().catch(fail);refresh().catch(fail);setTimeout(()=>showPage('production'),350);
})();
