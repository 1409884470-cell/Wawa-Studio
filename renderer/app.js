'use strict';

/* ============================================================
 * 龙利鱼投稿助手 · 渲染层
 * 数据全部走「后端方言」：window.api（Electron IPC）或 MockBackend（静态预览）。
 * 任务模型 = 后端 schema：{id, name, cfg{作品名称,作品简介,…}, status, message,
 *                          range{mode,from,to}, deai, sid, siteInfo, coverPrompt}
 * ============================================================ */

/* ============ 工具 ============ */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(msg, icon = '✅') {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  const wrap=$('#toastWrap');while(wrap.children.length>=2)wrap.firstElementChild.remove();wrap.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2400);
}
const fmtWords = n => { n = Number(n) || 0; return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : (n || '—'); };
const fileUrl = p => !p ? '' : (p.startsWith('data:') || p.startsWith('file:') || p.startsWith('http') ? p : 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''));
const nowTime = () => `今天 ${new Date().toTimeString().slice(0, 5)}`;
let _tid = 0;
const tid = () => `t${++_tid}_${Date.now().toString(36)}`;

/* ============ 后端选择 ============ */
const backend = window.api ?? window.MockBackend;
const IN_MOCK = backend === window.MockBackend;

/* ============ 全局状态 ============ */
let siteData = { entries: [], tags: [], tree: {} };
let tasks = [];            // 后端 schema
let tasksLoaded = false;
let revData = null;        // revenueSummary 结果缓存
let settingsCache = {};
let runState = { active: false, paused: false, browserLost: false };
let lastRunMeta = { mode: 'dry', headless: true };

const STATUS = {
  ready:   { t: '待投稿', c: 'gray'  },
  queued:  { t: '排队中', c: 'gray'  },
  running: { t: '投稿中', c: 'blue'  },
  done:    { t: '成功',   c: 'green' },
  previewed: { t: '预览通过', c: 'blue' },
  error:   { t: '失败',   c: 'red'   },
};
const COVER_PALETTES = [
  ['#0f3b34', '#3f9d7a'], ['#1a1a2e', '#7b2ff7'], ['#12294b', '#2f80ed'],
  ['#b12a5b', '#ff8fb1'], ['#3a1c71', '#d76d77'], ['#15181c', '#45525c'],
];

/* 任务列表持久化：任何变化即落盘 */
let saveTimer = null;
function persistTasks() {
  if (!tasksLoaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    backend.saveTasks(tasks.map(t => ({
      id: t.id, name: t.name, cfg: t.cfg, range: t.range, deai: !!t.deai, status: t.status, message: t.message,
      sid: t.sid ?? null, siteInfo: t.siteInfo ?? null, coverPrompt: t.coverPrompt ?? '',
    })));
  }, 250);
}
const taskTitle = t => t.cfg.作品名称 || t.name || '未命名';
const taskEntry = t => {
  if (t.cfg.投稿入口) return t.cfg.投稿入口;
  const entries = siteData.entries || [];
  return entries.includes('普通投稿') ? '普通投稿' : (entries[0] || '普通投稿');
};
const taskCatText = t => (t.cfg.小说类目 || []).join('/');
const taskAllTags = t => (t.cfg.作品标签 || []).concat(t.cfg.自定义标签 || []);

/* ============ 导航 ============ */
function showPage(id) {
  if(['workbench','tasks','short','cover','text','logs','ai','account'].includes(id))id='studio-settings';
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + id));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === id));
  $('.main').scrollTop = 0;
  if (history.replaceState) history.replaceState(null, '', '#' + id);
  if (id === 'revenue') loadRevenue();
  window.studioNavigate?.(id);
  if (id === 'cover' || id === 'text') refreshModelSelects();
  if (id === 'cover' && !$('#cAuthor').value.trim() && settingsCache.penName) $('#cAuthor').value = settingsCache.penName;
}
document.addEventListener('click', e => {
  const nav = e.target.closest('.nav-item');
  if (nav) { showPage(nav.dataset.page); return; }
  const go = e.target.closest('[data-goto]');
  if (go) showPage(go.dataset.goto);
});

/* ============ 工作台 ============ */
function renderWorkbench() {
  const done = tasks.filter(t => t.status === 'done').length;
  const busy = tasks.filter(t => t.status === 'running' || t.status === 'queued').length;
  const pending = tasks.filter(t => ['ready', 'previewed', 'error'].includes(t.status)).length;
  $('#wbTotal').textContent = tasks.length;
  $('#wbDone').textContent = done;
  $('#wbBusy').textContent = busy;
  const month = (revData?.monthly || []).at(-1);
  $('#wbRevenue').textContent = month ? '¥' + month.rev.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '—';
  $('#wbRevenueSub').textContent = revData ? `数据日 ${revData.latestDate ?? '—'}` : '打开「收益数据」页同步';
  $('#wbDoneSub').textContent = tasks.length ? `占比 ${Math.round(done / tasks.length * 100)}%` : '—';
  $('#recentBody').innerHTML = tasks.slice(0, 5).map(t => {
    const s = STATUS[t.status] || STATUS.ready;
    return `<tr>
      <td class="t-title">${esc(taskTitle(t))}</td>
      <td>${esc(taskEntry(t))}</td>
      <td><span class="badge ${s.c}">${s.t}</span></td>
      <td class="t-dim">${esc(t.siteInfo?.text || t.message || '—')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty-row">还没有任务，去「长篇投稿」导入小说</td></tr>';
}

/* ============ 长篇投稿：任务列表 ============ */
function renderTasks() {
  const fe = $('#fEntry').value;
  const st = $('#fStatus').value;
  const kw = $('#fSearch').value.trim();
  const rows = tasks.filter(t =>
    (!fe || taskEntry(t) === fe) && (!st || t.status === st) &&
    (!kw || taskTitle(t).includes(kw)));
  rows.forEach(t => { t.introEmpty = !(t.cfg.作品简介 && t.cfg.作品简介.trim()); });
  $('#taskCount').textContent = `任务列表（${rows.length}）`;
  const succ = rows.filter(t => t.status === 'done').length;
  const fail = rows.filter(t => t.status === 'error').length;
  $('#taskStat').textContent = rows.length ? `成功 ${succ} · 失败 ${fail} · 失败任务可点击「▶ 投本书」重新投递` : '';
  $('#taskCards').innerHTML = rows.map(t => {
    const s = STATUS[t.status] || STATUS.ready;
    const [a, b] = COVER_PALETTES[(t._pi ?? 0) % COVER_PALETTES.length];
    const coverSrc = t.cfg.封面 ? fileUrl(t.cfg.封面) : '';
    const coverHtml = coverSrc
      ? `<img class="task-cover-img" src="${esc(coverSrc)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
         <div class="task-cover" style="display:none;background:linear-gradient(160deg,${a},${b})">${esc(taskTitle(t))}</div>`
      : `<div class="task-cover" style="background:linear-gradient(160deg,${a},${b})">${esc(taskTitle(t))}</div>`;
    const coverHover = `<div class="cover-hover">
      <button class="btn-mini" data-cvact="import">📥 导入封面</button>
      ${t.cfg.封面 ? `<button class="btn-mini" data-cvact="save">⬇ 保存封面</button>` : ''}
    </div>`;
    const rangeTag = t.range?.mode === 'custom' ? `<span class="tag green">投第${t.range.from}-${t.range.to}章</span>` : '';
    const deaiTag = t.deai ? `<span class="tag plain">🧹 去AI前10章</span>` : '';
    const progress = (t.status === 'running' || t.status === 'queued')
      ? `<div class="task-progress"><div class="tp-bar ${t.status === 'running' ? 'anim' : ''}"><i></i></div><span>${esc(t.message || (t.status === 'running' ? '处理中…' : '排队等待…'))}</span></div>` : '';
    return `<div class="task-card" data-id="${t.id}">
      <div class="task-cover-box">${coverHtml}${coverHover}</div>
      <div class="task-main">
        <div class="task-titlerow">
          <span class="task-title">${esc(taskTitle(t))}</span>
          <span class="tag">${esc(t.cfg.作品分类 || '长篇')}</span>
          <span class="tag">${esc(t.cfg.作品频道 || '男频')}</span>
          ${rangeTag}${deaiTag}
          ${(taskAllTags(t) || []).slice(0, 4).map(g => `<span class="tag plain">${esc(g)}</span>`).join('')}
        </div>
        <div class="task-inforow">
          <span class="badge ${s.c}">${s.t}</span>
          ${t.siteInfo ? `<span class="tag ${t.siteInfo.canUpdate ? 'green' : ''}" title="来自站内投稿记录，↻ 刷新站内状态更新">${esc(t.siteInfo.text)}</span>` : ''}
          <span class="t-dim">${esc(taskEntry(t))}${t.cfg.作品字数 ? ' · ' + fmtWords(t.cfg.作品字数) + '字' : ''} · 封面：${t.cfg.封面 ? (t.info?.coverSource === 'ai' ? 'AI 生成' : t.info?.coverSource === 'site' ? '站内原图' : '已生成') : '—'}</span>
        </div>
        <div class="task-cat">${esc(taskCatText(t) || '类目未定')} · ${esc(t.cfg.作品状态 || '连载中')}${t.introEmpty ? ' · <b style="color:var(--orange)">简介待生成</b>' : ''}</div>
        <div class="task-desc">${esc(t.cfg.作品简介 || '暂无简介，点击「选简介」生成或手动填写。')}</div>
        ${progress}
        <div class="task-actions">
          <button class="btn-mini" data-act="title">选标题</button>
          <button class="btn-mini" data-act="brief">选简介</button>
          <button class="btn-mini" data-act="cover">选封面</button>
          <button class="btn-mini btn-adjust" data-act="adjust">调整</button>
          <button class="btn-mini btn-go" data-act="go">▶ ${$('#runDry').checked ? '试投' : '投'}本书</button>
          <button class="btn-mini btn-remove" data-act="del">移除</button>
        </div>
      </div>
    </div>`;
  }).join('') || '<div class="task-empty">没有匹配的任务，试试调整筛选条件</div>';
}

['fEntry', 'fStatus', 'fSearch'].forEach(id =>
  $('#' + id).addEventListener('input', renderTasks));
$('#runDry').addEventListener('change', renderTasks);

function fillEntryFilter() {
  const sel = $('#fEntry');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部入口</option>' +
    (siteData.entries || []).map(e => `<option${e === cur ? ' selected' : ''}>${esc(e)}</option>`).join('');
}

/* ---------- 任务操作 ---------- */
$('#taskCards').addEventListener('click', async e => {
  const cv = e.target.closest('[data-cvact]');
  if (cv) {
    const card = cv.closest('.task-card');
    const t = tasks.find(x => x.id === card.dataset.id);
    if (!t) return;
    if (cv.dataset.cvact === 'import') {
      const files = await backend.pickFiles('image');
      if (!files || !files.length) return;
      setBusy('正在导入封面…');
      const r = await backend.archiveCover(files[0]);
      setBusy(null);
      if (!r.ok) { toast('导入失败：' + (r.error || ''), '⚠️'); return; }
      t.cfg.封面 = r.path;
      t.info = t.info || {};
      t.info.coverSource = 'local';
      persistTasks(); renderTasks();
      addLog('info', '投稿引擎', `《${taskTitle(t)}》已导入本地封面`);
      toast('封面已导入', '📥');
    } else {
      if (!t.cfg.封面) { toast('该书还没有封面', '⚠️'); return; }
      const r = await backend.saveCover(t.cfg.封面, `${taskTitle(t)}-封面`);
      if (r.ok) { toast('封面已保存：' + r.path, '⬇️'); addLog('info', '投稿引擎', `《${taskTitle(t)}》封面已保存到本地`); }
      else if (!r.canceled) toast('保存失败：' + (r.error || ''), '⚠️');
    }
    return;
  }
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const card = b.closest('.task-card');
  const t = tasks.find(x => x.id === card.dataset.id);
  if (!t) return;
  captureProviderDraft();
  const act = b.dataset.act;
  if (act === 'title')      openCand(t, 'title');
  else if (act === 'brief') openCand(t, 'intro');
  else if (act === 'cover') openCand(t, 'cover');
  else if (act === 'adjust') openTaskModal(t);
  else if (act === 'go') {
    if (t.status === 'running' || t.status === 'queued') { toast('该书正在投稿中', '⏳'); return; }
    runTaskList([t]);
  }
  else if (act === 'del') {
    tasks.splice(tasks.indexOf(t), 1);
    persistTasks(); renderTasks(); renderWorkbench(); refreshTaskSelect();
    addLog('warn', '投稿引擎', `任务已移除《${taskTitle(t)}》`);
    toast('任务已移除', '🗑️');
  }
});

/* ---------- 导入：本地小说 / 站内作品 ---------- */
$('#btnImportLocal').addEventListener('click', async () => {
  if (runState.active) { toast('投稿运行中，暂不能添加任务', '⏳'); return; }
  const files = await backend.pickFiles('doc');
  if (!files || !files.length) return;
  for (let i = 0; i < files.length; i++) {
    const fn = files[i].split(/[\\/]/).pop();
    setBusy(`（${i + 1}/${files.length}）正在解析并归档：${fn} …`);
    const r = await backend.prepareTask({ kind: 'file', path: files[i] });
    setBusy(null);
    if (r.ok) {
      tasks.unshift({ id: tid(), name: r.cfg.作品名称 || fn, cfg: r.cfg, status: 'ready', message: '',
        range: { mode: 'all' }, deai: false, sid: null, siteInfo: null, coverPrompt: '', info: r.info || {} });
      addLog('info', '投稿引擎', `本地稿件《${r.cfg.作品名称 || fn}》导入成功`);
    } else {
      toast('导入失败：' + r.error, '⚠️');
      addError('导入', `《${fn}》导入失败：${r.error}`);
    }
  }
  persistTasks(); renderTasks(); renderWorkbench(); refreshTaskSelect();
  toast(`已添加到投稿队列`, '📥');
});

/* 从站内作品添加（弹层列表） */
let siteWorksCache = [];
async function openSiteWorks() {
  if (runState.active) { toast('投稿运行中，暂不能添加任务', '⏳'); return; }
  const pop = $('#sitePop');
  pop.hidden = !pop.hidden;
  if (pop.hidden) return;
  $('#siteSearch').value = '';
  $('#siteList').innerHTML = '<div class="import-empty">正在登录并读取站内作品列表…</div>';
  const r = await backend.siteWorks();
  if (!r.ok) {
    $('#siteList').innerHTML = `<div class="import-empty">读取失败：${esc(r.error || '')}</div>`;
    return;
  }
  siteWorksCache = r.works || [];
  renderSiteList('');
}
function renderSiteList(kw = '') {
  const rows = siteWorksCache.filter(w => !kw || w.title.includes(kw));
  $('#siteList').innerHTML = rows.map(w => `
    <div class="import-item" data-w="${esc(w.id)}">
      <b>${esc(w.title)}<span class="badge gray" style="margin-left:6px">${w.storyType === 'long' ? '长篇' : '短篇'}</span></b>
      <span>${fmtWords(w.wordCount)}字 · 更新 ${(w.update || '').slice(5, 10) || '—'}${w.submitted ? ' · 已投过稿' : ''}</span>
    </div>`).join('') || '<div class="import-empty">没有匹配的作品</div>';
}
$('#btnSiteAdd').addEventListener('click', openSiteWorks);
$('#siteSearch').addEventListener('input', e => renderSiteList(e.target.value.trim()));
$('#siteList').addEventListener('click', async e => {
  const it = e.target.closest('.import-item');
  if (!it) return;
  const w = siteWorksCache.find(x => String(x.id) === it.dataset.w);
  if (!w) return;
  const r = await backend.prepareTask({ kind: 'site', work: w });
  if (r.ok) {
    tasks.unshift({ id: tid(), name: r.cfg.作品名称, cfg: r.cfg, status: 'ready', message: '',
      range: { mode: 'all' }, deai: false, sid: null, siteInfo: null, coverPrompt: '', info: r.info || {} });
    persistTasks(); renderTasks(); renderWorkbench(); refreshTaskSelect();
    addLog('info', '投稿引擎', `已从站内作品添加《${w.title}》`);
    $('#sitePop').hidden = true;
    toast(`已添加《${w.title}》到投稿队列`, '📤');
  } else toast('失败：' + r.error, '⚠️');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.siteadd-wrap')) $('#sitePop').hidden = true;
});

/* ---------- 刷新站内状态 ---------- */
async function refreshPanelStatus(silent = false) {
  if (!tasks.length) { if (!silent) toast('没有任务可刷新'); return; }
  setBusy(silent ? '正在后台核对站内状态…' : '正在核对站内状态（拉取投稿列表 + 检测可更新章节）…');
  const r = await backend.refreshPanel(tasks.map(t => ({ id: t.id, sid: t.sid ?? null, sourceId: t.cfg.作品ID ?? null, title: taskTitle(t), file: t.cfg.本地文件 || '' })));
  setBusy(null);
  if (!r.ok) {
    if (!silent) toast('刷新失败：' + r.error, '⚠️');
    addLog('error', '投稿引擎', '站内状态核对失败：' + r.error);
    return;
  }
  const SITE_STATUS_CN = { draft: '新建', reviewing: '审核中', approved: '审核成功', rejected: '审核失败',
    contracting: '签约中', contracted: '已签约', contract_rejected: '签约失败' };
  let hit = 0, canUpdateN = 0;
  for (const t of tasks) {
    const title = taskTitle(t);
    const s = r.byTask && Object.hasOwn(r.byTask, t.id) ? r.byTask[t.id] : r.byTitle?.[title];
    const upd = (r.updates ?? {})[t.id] ?? (r.updates ?? {})[title];
    if (s) {
      hit++;
      if (s.sid != null) t.sid = s.sid;
      let text = `${SITE_STATUS_CN[s.status] ?? s.status}${s.submittedN != null ? `·已投${s.submittedN}章` : ''}`;
      if (upd && upd.canUpdate) { text += ` · 本地多${upd.localN - (upd.submittedN ?? 0)}章可更新`; canUpdateN++; }
      t.siteInfo = { found: true, text, canUpdate: !!upd?.canUpdate };
    } else if (upd?.localN) {
      t.siteInfo = { found: false, text: `站内未投 · 本地${upd.localN}章` };
    } else {
      t.siteInfo = { found: false, text: '未投稿（将新建）' };
    }
  }
  persistTasks(); renderTasks();
  const msg = `站内状态已核对：${hit}/${tasks.length} 本在站内` + (canUpdateN ? `，${canUpdateN} 本有新章节可更新` : '');
  addLog('success', '投稿引擎', msg);
  if (!silent) toast(msg, '↻');
}
$('#btnRefreshSite').addEventListener('click', () => refreshPanelStatus(false));

/* ============ 投稿运行控制（事件驱动） ============ */
function setBusy(text) {
  const bar = $('#busyBar');
  if (!text) { bar.classList.remove('show'); return; }
  $('#busyText').textContent = text;
  bar.classList.add('show');
}
function renderRunState() {
  const r = runState.active;
  $('#btnRunAll').hidden = r;
  $('#btnPause').hidden = !r;
  $('#btnSkip').hidden = !r;
  $('#btnStop').hidden = !r;
  $('#runProgress').hidden = !r;
  $('#runbarCard').classList.toggle('running', r);
  if (r) $('#btnPause').textContent = runState.paused
    ? (runState.browserLost ? '🔄 重启并继续' : '▶ 继续投稿')
    : '⏸ 暂停投稿';
  renderTasks();
}
async function runTaskList(list) {
  if (runState.active) { toast('已有任务在运行，请先等待完成或停止', '⏳'); return; }
  const dry = $('#runDry').checked;
  const mode = dry ? 'dry' : 'submit';
  if (!dry && !confirm(`确定真实提交 ${list.length} 个任务？`)) return;
  const headless = $('#runHeadless').checked;
  lastRunMeta = { mode, headless };
  const payload = list.map(t => ({ id: t.id, sid: t.sid ?? null, name: taskTitle(t), cfg: t.cfg, range: t.range, deai: !!t.deai }));
  addLog('info', '投稿引擎', `批量投稿启动：共 ${payload.length} 本 · ${dry ? '干跑预览' : '真实提交'} · ${headless ? '无头后台' : '显示浏览器'}`);
  toast(`批量投稿已启动（${dry ? '干跑预览' : '真实提交'} · ${payload.length} 本）`, '🚀');
  runState.active = true; renderRunState();
  try {
    const r = await backend.runTasks(payload, mode, headless);
    applyRunResults(r);
    if (!r.ok && r.error) { toast(r.error, '⚠️'); addError('投稿引擎', r.error); }
  } catch (e) { toast('投稿失败：' + e.message, '⚠️'); }
  finally { if (!IN_MOCK) { runState.active = false; renderRunState(); } }
}
function applyRunResults(r) {
  const results = r.results || [];
  if (!results.length) return;   // 结果经事件流回（兼容异步后端）
  const failList = results.filter(x => x.ok === false);
  failList.forEach(x => addError('投稿引擎', `${x.name || '任务'}：${x.error || '投稿失败'}`, x.name));
  for (const res of results) {
    if (res.sid != null) {
      const t = tasks.find(x => x.id === res.id);
      if (t) t.sid = res.sid;
    }
  }
  persistTasks(); renderTasks(); renderWorkbench();
}
$('#btnRunAll').addEventListener('click', () => {
  const list = tasks.filter(t => t.status !== 'done');
  if (!list.length) { toast('没有待投稿的任务（成功任务不会重复投递）', '✅'); return; }
  runTaskList(list);
});
$('#btnPause').addEventListener('click', () => {
  backend.runControl(runState.paused ? 'resume' : 'pause');
});
$('#btnSkip').addEventListener('click', () => backend.runControl('skip'));
$('#btnStop').addEventListener('click', () => {
  if (!confirm('确认停止本次投稿？已投完的不受影响，未投完任务保持待投稿。')) return;
  backend.runControl('abort');
  setBusy(null);
});

/* ============ 错误中心 ============ */
let errors = [];
function addError(module, msg, title) {
  errors.unshift({ id: Date.now() + Math.random(), module, msg, t: new Date().toTimeString().slice(0, 8), title: title || '' });
  if (errors.length > 100) errors.pop();
  renderErrors();
}
function renderErrors() {
  $('#errCount').textContent = errors.length;
  $('#errCount').style.display = errors.length ? '' : 'none';
  $('#errList').innerHTML = errors.map(er => `
    <div class="err-item">
      <span class="badge red">错误</span>
      <span class="err-msg">${esc(er.msg)}</span>
      <span class="err-t">${er.t}</span>
      <button class="btn-mini" data-err="${er.id}">↻ 重试</button>
    </div>`).join('') || '<div class="err-empty">✅ 暂无错误记录，投稿引擎运行正常</div>';
}
$('#errList').addEventListener('click', e => {
  const b = e.target.closest('[data-err]');
  if (!b) return;
  const er = errors.find(x => String(x.id) === b.dataset.err);
  if (!er) return;
  if (er.module !== '投稿引擎') { showPage(er.module === '封面生成' ? 'cover' : 'text'); toast('请在对应生成工具中重试失败步骤', '↻'); return; }
  const matches = tasks.filter(x => er.title && taskTitle(x) === er.title);
  const t = matches.length === 1 ? matches[0] : null;
  if (!t) { showPage('tasks'); toast('请在任务列表选择具体任务后重试', '↻'); return; }
  if (t) { t.status = 'ready'; t.message = ''; persistTasks(); renderTasks(); }
  errors = errors.filter(x => x.id !== er.id);
  renderErrors();
  addLog('success', '投稿引擎', `《${er.title || '失败任务'}》已重新入队，等待重试`);
  toast('已重新加入投稿队列，点击「开始自动投稿」执行', '↻');
});
$('#btnErrRetryAll').addEventListener('click', () => {
  if (!errors.length) { toast('当前没有待重试的错误', '✅'); return; }
  let n = 0;
  errors = errors.filter(er => {
    if (er.module !== '投稿引擎') return true;
    const matches = tasks.filter(x => er.title && taskTitle(x) === er.title);
    if (matches.length !== 1) return true;
    matches[0].status = 'ready'; matches[0].message = ''; n++; return false;
  });
  renderErrors(); persistTasks(); renderTasks();
  toast(n + ' 个投稿任务已恢复待执行；生成错误请在对应工具重试', '↻');
});
$('#btnErrClear').addEventListener('click', () => {
  errors = [];
  renderErrors();
  toast('错误中心已清空', '🧹');
});

/* ============ 候选选择器（标题/简介/封面两步式） ============ */
const candModal = $('#candModal');
const CAND_TITLES = { title: '选择书名', intro: '选择简介', cover: '选择封面（两步式）' };
let cand = null;
function openCand(task, field) {
  cand = { task, field, items: [], sel: -1, step: 1, prompt: task.coverPrompt || '', cover: '', source: '' };
  $('#candTitle').textContent = `${CAND_TITLES[field]} · 《${taskTitle(task)}》`;
  if (field === 'cover') renderCoverCand(); else regenCand();
  candModal.hidden = false;
}
function closeCand() { candModal.hidden = true; cand = null; }
$('#btnCandClose').addEventListener('click', closeCand);
candModal.addEventListener('click', e => { if (e.target === candModal) closeCand(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && cand && !candModal.hidden) closeCand(); });

function candSkeleton(n, h) {
  return Array.from({ length: n }, () =>
    `<div class="cover-skel" style="height:${h}px;border-radius:10px;margin-bottom:10px"></div>`).join('');
}
function regenCand() {
  if (!cand) return;
  $('#candFoot').innerHTML = '';
  $('#candBody').innerHTML = `<div class="cand-list">${candSkeleton(3, 74)}</div>`;
  backend.genCandidates(cand.task.cfg, cand.field, 3).then(r => {
    if (!cand) return;
    if (!r.ok) {
      $('#candBody').innerHTML = `<div class="cand-empty">生成失败：${esc(r.error || '')}</div>`;
      addError('文本生成', `《${taskTitle(cand.task)}》候选生成失败：${r.error}`);
      return;
    }
    cand.items = r.items || [];
    cand.sel = -1;
    cand.source = r.source;
    renderCandBody();
    addLog('success', '文本生成',
      `已为《${taskTitle(cand.task)}》生成 ${cand.items.length} 个${cand.field === 'title' ? '书名' : '简介'}候选（${r.source === 'ai' ? 'AI' : '本地规则'}）`);
  });
}
function renderCandBody() {
  if (!cand) return;
  $('#candBody').innerHTML = `
    <div class="t-dim" style="margin-bottom:10px">来源：${cand.source === 'ai' ? 'AI 生成' : '本地规则生成'} · 点选候选后可应用</div>
    <div class="cand-list">${cand.items.map((s, i) => `
      <div class="cand-item ${cand.sel === i ? 'selected' : ''}" data-ci="${i}">
        <div class="cand-idx">候选 ${i + 1}</div>
        <p>${esc(s)}</p>
      </div>`).join('') || '<div class="cand-empty">暂无候选</div>'}
    </div>`;
  $('#candFoot').innerHTML = `
    <button class="btn btn-ghost" id="btnCandRegen">✨ 换一批</button>
    <button class="btn btn-primary" id="btnCandUse" ${cand.sel < 0 ? 'disabled' : ''}>✔ 使用选中候选</button>`;
  $('#btnCandRegen').addEventListener('click', regenCand);
  $('#btnCandUse').addEventListener('click', useCand);
}
function useCand() {
  if (!cand || cand.sel < 0) return;
  const t = cand.task;
  const val = cand.items[cand.sel];
  if (cand.field === 'title') {
    t.cfg.作品名称 = val; t.name = val;
    addLog('info', '文本生成', `《${val}》书名已更换`);
    toast('书名已应用到任务', '📝');
  } else {
    t.cfg.作品简介 = val; t.introEmpty = false;
    addLog('info', '文本生成', `《${taskTitle(t)}》简介已更新`);
    toast('简介已应用到任务', '📄');
  }
  persistTasks(); renderTasks(); renderWorkbench(); refreshTaskSelect();
  closeCand();
}
/* 标题/简介候选点选（委托绑定一次） */
candModal.addEventListener('click', e => {
  const item = e.target.closest('.cand-item[data-ci]');
  if (!item || !cand) return;
  cand.sel = +item.dataset.ci;
  $$('#candBody .cand-item').forEach(x => x.classList.remove('selected'));
  item.classList.add('selected');
  const btn = document.getElementById('btnCandUse');
  if (btn) btn.disabled = false;
});

/* 封面两步式 */
async function genCoverPromptText(overwrite = true) {
  if (!cand) return;
  const cur = $('#candPrompt').value.trim();
  if (cur && overwrite && !confirm('重新生成提示词？当前手写内容将被覆盖。')) return;
  $('#candPromptHint').textContent = '正在用文本AI阅读剧情生成提示词…';
  const r = await backend.genCandidates(cand.task.cfg, 'cover-prompt', 1, '');
  if (!r.ok) { $('#candPromptHint').textContent = '生成失败：' + r.error; return; }
  $('#candPrompt').value = r.prompt || '';
  cand.task.coverPrompt = r.prompt || '';
  $('#candPromptHint').textContent =
    { 'text-ai': '✅ 提示词已生成（文本AI 按剧情撰写，可手改）', 'manual': '提示词：手动输入', 'default': '提示词：默认模板（配置文本AI 后可按剧情生成）' }[r.promptSource] ?? '';
  persistTasks();
}
function renderCoverCand() {
  if (!cand) return;
  if (cand.step === 1) {
    $('#candBody').innerHTML = `
      <div class="step-dots">
        <span class="step-dot on">① 生成 / 修改提示词</span>
        <span class="step-dot">② 生成封面并挑选</span>
      </div>
      <div class="field">
        <div class="cfg-label-row">
          <label class="cfg-label">封面画面提示词</label>
          <button class="btn-link" id="btnGenPrompt">✨ AI 生成提示词</button>
        </div>
        <textarea id="candPrompt" rows="4" placeholder="点击右上角「AI 生成提示词」按剧情撰写，也可直接手写">${esc(cand.prompt)}</textarea>
        <div class="t-dim" id="candPromptHint" style="font-size:12px;margin-top:6px">打开弹窗不会消耗图像AI —— 改好提示词后再点「下一步」</div>
        <p class="tip">「AI设置」中的封面固定提示词 / 禁止提示词会在生成时自动拼接。</p>
      </div>`;
    $('#candFoot').innerHTML = `
      <button class="btn btn-ghost" id="btnCandCancel">取消</button>
      <button class="btn btn-primary" id="btnCandNext">下一步：生成封面 →</button>`;
    $('#btnCandCancel').addEventListener('click', closeCand);
    $('#btnGenPrompt').addEventListener('click', () => genCoverPromptText(true));
    $('#btnCandNext').addEventListener('click', () => {
      cand.prompt = $('#candPrompt').value.trim();
      if (!cand.prompt) { toast('请先生成或填写封面提示词', '⚠️'); return; }
      cand.task.coverPrompt = cand.prompt;
      cand.step = 2;
      renderCoverCand();
    });
  } else {
    $('#candBody').innerHTML = `
      <div class="step-dots">
        <span class="step-dot">① 生成 / 修改提示词</span>
        <span class="step-dot on">② 生成封面并挑选</span>
      </div>
      <div class="cand-covers cand-covers-1" id="candCoverGrid">
        <div class="cover-skel" style="aspect-ratio:2/3"></div>
      </div>
      <div class="t-dim" id="candCoverHint" style="font-size:12px;margin-top:8px">正在请求图像 AI 生成封面，可能需要几分钟…</div>
      <p class="tip">提示词：${esc(cand.prompt)}</p>`;
    $('#candFoot').innerHTML = `
      <button class="btn btn-ghost" id="btnCandBack">← 上一步</button>
      <button class="btn btn-ghost" id="btnCandReGen">🎨 重新生成</button>
      <button class="btn btn-primary" id="btnCandUseCover" disabled>✔ 设为本书封面</button>`;
    $('#btnCandBack').addEventListener('click', () => { cand.step = 1; renderCoverCand(); });
    $('#btnCandReGen').addEventListener('click', genCoverImage);
    genCoverImage();
    $('#btnCandUseCover').addEventListener('click', () => {
      if (!cand.cover) { toast('封面尚未生成', '⚠️'); return; }
      const t = cand.task;
      t.cfg.封面 = cand.cover;
      t.coverPrompt = cand.prompt;
      t.info = t.info || {};
      t.info.coverSource = cand.source === 'ai' ? 'ai' : 'local';
      persistTasks(); renderTasks();
      addLog('success', '封面生成', `《${taskTitle(t)}》已更新封面（${cand.source === 'ai' ? '图像AI' : '预览模式'}）`);
      toast('封面已应用到任务', '🎨');
      closeCand();
    });
  }
}
async function genCoverImage() {
  if (!cand) return;
  const grid = $('#candCoverGrid');
  grid.innerHTML = '<div class="cover-skel" style="aspect-ratio:2/3"></div>';
  $('#candCoverHint').textContent = '正在请求图像 AI 生成封面，可能需要几分钟…';
  $('#btnCandUseCover').disabled = true;
  const r = await backend.genCandidates(cand.task.cfg, 'cover', 1, cand.prompt);
  if (!cand || !document.getElementById('candCoverGrid')) return;
  if (!r.ok) {
    grid.innerHTML = '';
    $('#candCoverHint').textContent = '生成失败：' + (r.error || '');
    addError('封面生成', `《${taskTitle(cand.task)}》封面生成失败：${r.error}`);
    return;
  }
  cand.cover = r.cover; cand.prompt = r.prompt || cand.prompt; cand.source = r.source;
  grid.innerHTML = `<div class="cover-item selected" data-cci="0"><img src="${esc(fileUrl(r.cover))}" alt="封面方案"></div>`;
  $('#candCoverHint').textContent = r.source === 'ai'
    ? '✅ AI 封面已生成——满意就点「设为本书封面」'
    : '预览模式生成完成';
  $('#btnCandUseCover').disabled = false;
}

/* ============ 调整任务弹窗 ============ */
const modal = $('#taskModal');
let editTaskId = null;
let editTags = new Set();
function openTaskModal(t) {
  editTaskId = t.id;
  $('#taskModalTitle').textContent = '调整投稿任务';
  $('#btnCreateTask').textContent = '保存调整';
  $('#tTitle').value = t.cfg.作品名称 ?? '';
  // 投稿设置默认优先：长篇 / 普通投稿 / 连载中（频道、类目、标签等由导入分析带入）
  const entry = $('#tEntry');
  const entries = siteData.entries || [];
  const defaultEntry = entries.includes('普通投稿') ? '普通投稿' : (entries[0] || '普通投稿');
  entry.innerHTML = entries.map(e => `<option${e === defaultEntry ? ' selected' : ''}>${esc(e)}</option>`).join('');
  $('#tCat').value = '长篇';
  $('#tChannel').value = t.cfg.作品频道 || '男频';
  $('#tStatus2').value = '连载中';
  // 类目三级联动
  const c1 = $('#tC1'), c2 = $('#tC2'), c3 = $('#tC3');
  const fillC2 = a => {
    c2.innerHTML = ''; c3.innerHTML = '';
    for (const b of Object.keys(siteData.tree[a] || {})) c2.appendChild(new Option(b, b));
    c3.appendChild(new Option('—', ''));
  };
  const fillC3 = (a, b) => {
    c3.innerHTML = '';
    for (const c of ((siteData.tree[a] || {})[b] || [])) c3.appendChild(new Option(c, c));
  };
  c1.innerHTML = Object.keys(siteData.tree || {}).map(a => `<option>${esc(a)}</option>`).join('');
  const [da, db, dc] = t.cfg.小说类目 || [];
  if (da && siteData.tree[da]) c1.value = da; else c1.selectedIndex = 0;
  fillC2(c1.value);
  if (db) c2.value = db;
  fillC3(c1.value, c2.value);
  if (dc) c3.value = dc;
  c1.onchange = () => fillC2(c1.value);
  c2.onchange = () => fillC3(c1.value, c2.value);
  // 范围
  const r = t.range || { mode: 'all', from: 1, to: 10 };
  document.querySelector(`input[name="tRange"][value="${r.mode}"]`).checked = true;
  $('#tFrom').value = r.from ?? 1; $('#tTo').value = r.to ?? 10;
  syncRangeInputs();
  // 标签：库内 + 自定义（chip 点选）
  editTags = new Set(taskAllTags(t));
  renderTagEditor();
  $('#tDeAI').checked = !!t.deai;
  modal.hidden = false;
  $('#tTitle').focus();
}
function closeModal() { modal.hidden = true; }
$('#btnModalClose').addEventListener('click', closeModal);
$('#btnCancelTask').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

function renderTagEditor() {
  const lib = new Set(siteData.tags || []);
  const chosen = [...editTags].map(g =>
    `<span class="tag-x" data-libtag="${esc(g)}" title="${lib.has(g) ? '站点标签库' : '自定义标签'}">${esc(g)}<i>✕</i></span>`).join('');
  const suggestions = (siteData.tags || [])
    .filter(g => !editTags.has(g))
    .slice(0, 24)
    .map(g => `<span class="tag-sug" data-libtag="${esc(g)}">${esc(g)}</span>`).join('');
  $('#tTagBox').innerHTML = chosen || '<span class="t-dim" style="font-size:12px">暂无标签，点击下方推荐或输入添加（最多 8 个）</span>';
  $('#tTagSug').innerHTML = suggestions;
}
$('#tTagBox').addEventListener('click', e => {
  const x = e.target.closest('[data-libtag]');
  if (!x) return;
  editTags.delete(x.dataset.libtag);
  renderTagEditor();
});
$('#tTagSug').addEventListener('click', e => {
  const s = e.target.closest('[data-libtag]');
  if (!s) return;
  if (editTags.size >= 8) return toast('标签最多 8 个', '⚠️');
  editTags.add(s.dataset.libtag);
  renderTagEditor();
});
$('#tTagInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = e.target.value.trim();
  if (!v) return;
  if (editTags.has(v)) return toast('该标签已存在', '⚠️');
  if (editTags.size >= 8) return toast('标签最多 8 个', '⚠️');
  if (!(siteData.tags || []).includes(v)) return toast('请从蛙蛙系统标签库选择', '⚠️');
  editTags.add(v);
  e.target.value = '';
  renderTagEditor();
});
document.querySelectorAll('input[name="tRange"]').forEach(r =>
  r.addEventListener('change', syncRangeInputs));
function syncRangeInputs() {
  const custom = document.querySelector('input[name="tRange"]:checked').value === 'custom';
  $('#tFrom').disabled = !custom; $('#tTo').disabled = !custom;
}

$('#btnCreateTask').addEventListener('click', () => {
  const t = tasks.find(x => x.id === editTaskId);
  if (!t) return;
  const title = $('#tTitle').value.trim();
  if (!title) { toast('请先填写书名', '⚠️'); return; }
  // 标签分流：库内 → 作品标签；库外 → 自定义标签
  const lib = new Set(siteData.tags || []);
  const sel = [...editTags];
  t.cfg.作品标签 = sel.filter(x => lib.has(x));
  t.cfg.自定义标签 = [];
  t.cfg.作品名称 = title;
  t.name = title;
  t.cfg.投稿入口 = $('#tEntry').value;
  t.cfg.作品分类 = $('#tCat').value;
  t.cfg.作品频道 = $('#tChannel').value;
  t.cfg.作品状态 = $('#tStatus2').value;
  t.cfg.小说类目 = [$('#tC1').value, $('#tC2').value, $('#tC3').value].filter(Boolean);
  const mode = document.querySelector('input[name="tRange"]:checked').value;
  t.range = mode === 'custom'
    ? { mode, from: Math.max(1, +$('#tFrom').value || 1), to: Math.max(1, +$('#tTo').value || 1) }
    : { mode: 'all' };
  if (t.range.mode === 'custom' && (!Number.isInteger(t.range.from) || !Number.isInteger(t.range.to) || t.range.from > t.range.to)) {
    return toast('章节范围无效：请输入整数，起始章不能大于结束章', '⚠️');
  }
  t.deai = $('#tDeAI').checked;
  persistTasks(); renderTasks(); renderWorkbench(); refreshTaskSelect();
  closeModal();
  addLog('info', '投稿引擎', `任务已调整：《${title}》· ${t.cfg.投稿入口}${t.deai ? ' · 去AI处理' : ''}`);
  toast('任务已调整', '✏️');
});

/* ============ 收益数据 ============ */
let revScale = 14;
let revGroup = 'channel';
async function loadRevenue(silent = false, forceSync = false) {
  if(!silent && backend.revenueCache){const cached=await backend.revenueCache();revData=cached?.ok?cached:null;if(cached?.ok){revData=cached;$('#revDataArea').hidden=false;renderRevenue();}}
  if (!revData) {
    $('#revDataArea').hidden = true;
    $('#revBody').innerHTML = '<div class="rev-loading">正在拉取投稿记录与收益（自动登录；首次会回填全部历史，约 1-3 分钟）…</div>';
  }
  const r = await backend.revenueSummary(true, {forceSync});
  setBusy(null);
  if (!r.ok) {
    addError('收益同步', r.error || '收益同步失败');
    if (!revData) $('#revBody').innerHTML = `<div class="rev-loading">读取失败：${esc(r.error || '')}<br>稍后点击「刷新收益」重试</div>`;
    return;
  }
  revData = r;
  $('#revBody').innerHTML = '';
  $('#revDataArea').hidden = false;
  renderRevenue();
  renderWorkbench();
  addLog('success', '收益数据', `收益同步完成：数据日 ${r.latestDate ?? '—'}${r.syncedCount ? ` · 回填 ${r.syncedCount} 本` : ''}`);
}
$('#btnRefreshRev').addEventListener('click', () => loadRevenue(false));
$('#btnExport').addEventListener('click', async () => {
  toast('正在导出…', '⬇️');
  const r = await backend.exportRevenueCsv();
  if (r.ok) toast('已导出：' + r.path, '📄');
  else if (!r.canceled) toast('导出失败：' + (r.error || ''), '⚠️');
});

function revChartSVG(series) {
  if (!series || series.length < 2) return '<div class="rev-empty">暂无足够数据</div>';
  const W = 920, H = 230, L = 48, R = 60, T = 18, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const maxRev = Math.max(...series.map(p => p.rev), 0.01);
  const maxTot = Math.max(...series.map(p => p.total), 0.01);
  const bw = Math.max(3, iw / series.length - 2);
  const x = i => L + (i + 0.5) * iw / series.length;
  const yR = v => T + ih - (v / maxRev) * ih * 0.92;
  const yT = v => T + ih - (v / maxTot) * ih * 0.92;
  const bars = series.map((p, i) => {
    const h = Math.max(2, T + ih - yR(p.rev));
    return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="url(#rg)"><title>${p.date}｜当日 ¥${p.rev.toFixed(2)}｜累计 ¥${p.total.toFixed(2)}｜在读 ${p.readers ?? '—'}</title></rect>`;
  }).join('');
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yT(p.total).toFixed(1)}`).join(' ');
  const tickIdx = [0, Math.floor((series.length - 1) / 3), Math.floor((series.length - 1) * 2 / 3), series.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i);
  const ticks = tickIdx.map(i =>
    `<text x="${x(i).toFixed(1)}" y="${H - 8}" font-size="10" fill="#9aa0a6" text-anchor="middle">${series[i].date.slice(5).replace('-', '/')}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    <defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#10b981"/>
    </linearGradient></defs>
    <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" stroke="#eef0f2"/>
    <text x="${L - 6}" y="${(yR(maxRev) + 4).toFixed(1)}" font-size="10" fill="#9aa0a6" text-anchor="end">¥${maxRev.toFixed(0)}</text>
    <text x="${W - R + 6}" y="${(yT(maxTot) + 4).toFixed(1)}" font-size="10" fill="#0f9960" text-anchor="end">累计 ¥${maxTot.toFixed(0)}</text>
    ${bars}<path d="${line}" fill="none" stroke="#0f9960" stroke-width="2"/>${ticks}
  </svg><div class="t-dim" style="font-size:11.5px;margin-top:6px">柱 = 当日收益 · 绿线 = 累计收益（悬停看单日明细）</div>`;
}

function renderRevenue() {
  if (!revData) return;
  const r = revData;
  window.renderStudioRevenue?.(r);
  $('#revUpdated').textContent = `数据日 ${r.latestDate ?? '—'} · 更新于 ${new Date().toTimeString().slice(0, 5)}${r.syncedCount ? ` · 回填 ${r.syncedCount} 本` : ''}`;
  $('#stSumReaders').innerHTML = `${Number(r.totalFollows || 0).toLocaleString('zh-CN')}<span class="unit">人</span>`;
  $('#stSumReadersDelta').textContent = `最新日 ▲ +${Number(r.readerUp || 0).toLocaleString('zh-CN')} · ▼ ${Number(r.readerDown || 0).toLocaleString('zh-CN')}`;
  $('#stTodayReaders').innerHTML = `${Number(r.totalBooks || 0).toLocaleString('zh-CN')}<span class="unit">本</span>`;
  $('#stTodayReadersSub').textContent = `已签约 ${r.signedCount ?? '—'} 本`;
  $('#stNewReaders').textContent = r.yesterdayDelta != null ? Number(r.yesterdayDelta).toFixed(2) : '—';
  $('#stNewReadersSub').textContent = '每天约 13:30 更新前一日';
  $('#stDayRev').textContent = Number(r.last7Total || 0).toFixed(2);
  $('#stRevDiffLabel').textContent = '近 7 日收益';
  $('#stRevDiffPrev').textContent = `前 7 日 ¥${Number(r.prev7Total || 0).toFixed(2)}`;
  const wow = r.prev7Total > 0 ? (r.last7Total - r.prev7Total) / r.prev7Total * 100 : null;
  $('#stRevDiffWow').textContent = wow != null ? `${wow >= 0 ? '▲' : '▼'} ${Math.abs(wow).toFixed(0)}%` : '—';
  $('#stRevDiffWow').className = 'stat-delta ' + (wow >= 0 ? 'up' : 'down');
  $('#stTotalRev').textContent = Number(r.totalRevenue || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
  $('#stTotalRevSub').textContent = `数据日 ${r.latestDate ?? '—'}`;

  // 尺度按钮
  $('#revScaleBar').innerHTML = [[0, '全部'], [90, '90天'], [30, '30天'], [14, '14天'], [7, '7天']]
    .map(([n, label]) => `<button class="chip ${revScale === n ? 'on' : ''}" data-scale="${n}">${label}</button>`).join('');
  const shown = revScale ? r.series.slice(-revScale) : r.series;
  $('#revChart').innerHTML = revChartSVG(shown);

  // 分组汇总
  const groups = { penName:['按笔名',r.byPenName], channel: ['按频道', r.byChannel], type: ['按长短篇', r.byType], status: ['按状态', r.byStatus], cat: ['按一级类目', r.byCat] };
  $('#revGroupBar').innerHTML = Object.entries(groups)
    .map(([k, [label]]) => `<button class="chip ${revGroup === k ? 'on' : ''}" data-group="${k}">${label.replace('按', '')}</button>`).join('');
  const gData = groups[revGroup][1] || {};
  $('#revGroupTable').innerHTML = `
    <table class="table">
      <thead><tr><th>分组</th><th>作品数</th><th style="text-align:right">累计收益</th><th style="text-align:right">最新日+</th><th style="text-align:right">在读</th></tr></thead>
      <tbody>${Object.entries(gData).sort((a, b) => b[1].total - a[1].total).map(([k, v]) => `
        <tr><td>${esc(k)}</td><td>${v.count}</td>
        <td style="text-align:right;color:var(--green-dark);font-weight:600">¥${v.total.toFixed(2)}</td>
        <td style="text-align:right;color:${v.dayRev > 0 ? 'var(--green-dark)' : 'var(--text-3)'}">${v.dayRev > 0 ? '+' + v.dayRev.toFixed(2) : '—'}</td>
        <td style="text-align:right">${v.follows ?? '—'}</td></tr>`).join('')}</tbody>
    </table>`;

  // 月度统计
  $('#revMonthlyTable').innerHTML = `
    <table class="table">
      <thead><tr><th>月份</th><th style="text-align:right">收益</th><th style="text-align:right">月末在读</th></tr></thead>
      <tbody>${(r.monthly || []).slice().reverse().map(m => `
        <tr><td>${esc(m.month)}</td>
        <td style="text-align:right;color:var(--green-dark);font-weight:600">¥${m.rev.toFixed(2)}</td>
        <td style="text-align:right">${Number(m.endReaders || 0).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody>
    </table>`;

  // 单书明细
  $('#bookRevBody').innerHTML = (r.books || []).filter(b=>!window.studioPenFilter||b.penName===window.studioPenFilter).map(b => {
    const fd = b.fDelta > 0 ? `+${b.fDelta}` : (b.fDelta != null && b.fDelta < 0 ? String(b.fDelta) : '');
    const weekHtml = b.week ? `¥${b.week.sum.toFixed(2)} <span class="${b.week.sum >= b.week.prev ? 't-delta up' : 't-delta down'}">${b.week.sum >= b.week.prev ? '▲' : '▼'}</span>` : '—';
    return `<tr style="${b.ignored ? 'opacity:.45' : ''}${b.hasData ? '' : ';font-style:italic'}">
      <td class="t-title td-clip" title="${esc(b.title)}（${b.firstDate ? '首个数据日 ' + b.firstDate : '暂无数据'}）"><label><input type="checkbox" data-revenue-select value="${esc(b.sid)}"> ${esc(b.title)}</label><small style="display:block;color:var(--green-dark)">${esc(b.penName||'未匹配')} · ID ${esc(b.sid)}</small></td>
      <td><span class="badge ${b.status === '已签约' ? 'green' : 'gray'}">${esc(b.status)}</span></td>
      <td class="t-dim">${esc(b.channel)}·${esc(b.type)}</td>
      <td style="text-align:right">${fmtWords(b.words)}</td>
      <td style="text-align:right;color:${b.dayRev > 0 ? 'var(--green-dark)' : 'var(--text-3)'}">${b.dayRev != null ? '+' + b.dayRev.toFixed(2) : '—'}</td>
      <td style="text-align:right">${b.follows ?? '—'}${fd ? ` <span class="t-delta ${b.fDelta > 0 ? 'up' : 'down'}" style="font-size:11px">(${fd})</span>` : ''}</td>
      <td style="text-align:right;color:var(--green-dark);font-weight:600">¥${Number(b.total || 0).toFixed(2)}</td>
      <td style="text-align:right">${weekHtml}</td>
      <td class="t-dim" style="font-size:11px">${b.firstDate ?? '—'}</td>
      <td><button class="btn-mini" data-ign="${b.sid}">${b.ignored ? '取消忽略' : '忽略'}</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="empty-row">暂无书籍数据</td></tr>';
}
$('#revScaleBar').addEventListener('click', e => {
  const b = e.target.closest('[data-scale]');
  if (!b) return;
  revScale = +b.dataset.scale;
  renderRevenue();
});
$('#revGroupBar').addEventListener('click', e => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  revGroup = b.dataset.group;
  renderRevenue();
});
$('#bookRevBody').addEventListener('click', async e => {
  const b = e.target.closest('[data-ign]');
  if (!b) return;
  await backend.toggleRevIgnore(b.dataset.ign);
  const bk = (revData.books || []).find(x => String(x.sid) === String(b.dataset.ign));
  if (bk) bk.ignored = !bk.ignored;
  revData.books.sort((a, z) => (a.ignored - z.ignored) || (z.total - a.total));
  renderRevenue();
});

/* ============ 封面生成工作台 ============ */
const coverHistory = [];
let coverBoundTaskId = null;
$('#cTitle').addEventListener('input', e => { if (e.isTrusted) coverBoundTaskId = null; });
const lastBatch = { covers: [], title: '', taskId: null };   // 最近一批生成结果（原始路径/dataURL），供「设为首选」同步投稿封面
let coverBatch = 1;
bindCount('cTitle', 'cTitleCount', 30);
bindCount('cDesc', 'cDescCount', 800);
function bindCount(inputId, countId, max) {
  const el = $('#' + inputId), cnt = $('#' + countId);
  const update = () => {
    cnt.textContent = `${el.value.length}/${max}`;
    cnt.classList.toggle('over', el.value.length >= max);
  };
  el.addEventListener('input', update);
  update();
}
$('#cBatch').addEventListener('click', e => {
  const b = e.target.closest('.seg-item');
  if (!b) return;
  $$('#cBatch .seg-item').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  coverBatch = +b.dataset.n;
});

/* 快速导入小说（从任务列表） */
function renderImportList(kw = '') {
  const rows = tasks.filter(t => !kw || taskTitle(t).includes(kw)).slice(0, 30);
  $('#importList').innerHTML = rows.map(t => `
    <div class="import-item" data-tid="${t.id}">
      <b>${esc(taskTitle(t))}<span class="badge gray" style="margin-left:6px">${esc(taskCatText(t).split('/')[0] || '未分类')}</span></b>
      <span>${esc((t.cfg.作品简介 || '暂无简介').slice(0, 40))}</span>
    </div>`).join('') || '<div class="import-empty">暂无任务，先去「长篇投稿」导入</div>';
}
document.addEventListener('click', e => {
  const pop = $('#importPop'), card = e.target.closest('#importCard');
  if (card) {
    if (e.target.closest('#importPop')) return;
    if (e.target.closest('.import-item')) return;
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { $('#importSearch').value = ''; renderImportList(); $('#importSearch').focus(); }
  } else if (!e.target.closest('#importPop')) {
    pop.hidden = true;
  }
});
$('#importSearch').addEventListener('input', e => renderImportList(e.target.value.trim()));
$('#importList').addEventListener('click', e => {
  const it = e.target.closest('.import-item');
  if (!it) return;
  const t = tasks.find(x => x.id === it.dataset.tid);
  if (!t) return;
  coverBoundTaskId = t.id;
  $('#cTitle').value = taskTitle(t);
  $('#cTitle').dispatchEvent(new Event('input'));
  if (!$('#cDesc').value.trim()) {
    $('#cDesc').value = t.cfg.作品简介 || '';
    $('#cDesc').dispatchEvent(new Event('input'));
  }
  $('#importPop').hidden = true;
  toast(`已导入《${taskTitle(t)}》`, '📖');
});

/* 一键生成：真实模式走 genCandidates('cover')，逐张请求 */
$('#btnGenCover').addEventListener('click', async () => {
  const title = $('#cTitle').value.trim();
  if (!title) { toast('请先填写小说书名', '⚠️'); $('#cTitle').focus(); return; }
  const author = $('#cAuthor').value.trim();
  const desc = $('#cDesc').value.trim();
  const cfg = { 作品名称: title, 作品简介: desc, 笔名: author };
  const btn = $('#btnGenCover');
  btn.disabled = true; btn.textContent = `⏳ 生成中（0/${coverBatch}）…`;
  $('#coverEmpty').hidden = true;
  const grid = $('#coverGrid');
  grid.innerHTML = Array.from({ length: coverBatch }, () =>
    `<div class="cover-skel" style="aspect-ratio:2/3"></div>`).join('');
  grid.hidden = false;
  const t0 = performance.now();
  const images = [];
  lastBatch.covers = [];
  lastBatch.title = title;
  lastBatch.taskId = coverBoundTaskId;
  let lastPrompt = desc, lastSource = IN_MOCK ? 'mock' : 'ai';
  for (let i = 0; i < coverBatch; i++) {
    try {
      const r = await backend.genCandidates(cfg, 'cover', 1, desc, { size: $('#cSize').value });
      if (!r.ok) throw new Error(r.error || '生成失败');
      images.push(r.cover);
      lastBatch.covers[i] = r.cover;
      lastPrompt = r.prompt || lastPrompt;
      lastSource = r.source || lastSource;
      btn.textContent = `⏳ 生成中（${i + 1}/${coverBatch}）…`;
      const img = grid.children[i];
      if (img) img.outerHTML = `<div class="cover-item" data-i="${i}"><img src="${esc(fileUrl(r.cover))}" alt="封面方案 ${i + 1}">
        <span class="cover-badge" hidden>✔ 已选为封面</span>
        <div class="cover-act">
          <button class="btn-mini" data-cact="pick">✔ 设为首选</button>
          <button class="btn-mini" data-cact="dl">${IN_MOCK ? '⬇ 下载' : '💾 保存本地'}</button>
        </div></div>`;
    } catch (err) {
      const skel = grid.children[i];
      if (skel) skel.outerHTML = `<div class="cand-empty">方案 ${i + 1} 失败：${esc(err.message)}</div>`;
      addError('封面生成', `《${title}》封面方案 ${i + 1} 生成失败：${err.message}`, title);
    }
  }
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  if (images.length) {
    lastBatch.source = lastSource;
    $('#coverMeta').textContent =
      `本次生成 ${images.length} 张 · ${IN_MOCK ? '演示模式' : '图像AI'} · 耗时 ${sec} s`;
    $('#coverResultBar').hidden = false;
    coverHistory.unshift({ time: nowTime(), title, taskId: lastBatch.taskId, n: images.length, images, covers: images.slice() });
    if (coverHistory.length > 20) coverHistory.pop();
    addLog('success', '封面生成', `已为《${title}》生成 ${images.length} 张封面`);
    toast(`已生成 ${images.length} 张封面`, '🎨');
  } else {
    $('#coverEmpty').hidden = false;
    grid.hidden = true;
  }
  btn.disabled = false; btn.textContent = '✨ 一键生成';
});

/* 结果网格交互：设为首选 / 保存本地 */
$('#coverGrid').addEventListener('click', async e => {
  const b = e.target.closest('[data-cact]');
  if (!b) return;
  const item = b.closest('.cover-item');
  const idx = +item.dataset.i;
  if (b.dataset.cact === 'pick') {
    const picked = !item.classList.contains('selected');
    $$('#coverGrid .cover-item').forEach(x => {
      x.classList.remove('selected');
      $('.cover-badge', x).hidden = true;
    });
    if (picked) {
      item.classList.add('selected');
      $('.cover-badge', item).hidden = false;
      // 同步到明确导入的任务 ID，禁止按同名书匹配
      const raw = lastBatch.covers[idx];
      const title = lastBatch.title;
      const t = lastBatch.taskId ? tasks.find(x => x.id === lastBatch.taskId) : null;
      if (raw && t) {
        t.cfg.封面 = raw;
        t.info = t.info || {};
        t.info.coverSource = lastBatch.source === 'ai' ? 'ai' : 'local';
        persistTasks(); renderTasks();
        addLog('success', '封面生成', `《${taskTitle(t)}》投稿封面已更新（工作台方案 ${idx + 1}）`);
        toast(`已同步为《${taskTitle(t)}》的投稿封面`, '✅');
      } else {
        toast(`已选中方案 ${idx + 1}；如需同步投稿，请先从任务导入`, '⭐');
      }
    }
  } else {
    const src = $('img', item)?.src || '';
    if (IN_MOCK) {
      const a = document.createElement('a');
      a.href = src;
      a.download = `${$('#cTitle').value.trim() || '封面'}_方案${idx + 1}.png`;
      a.click();
      toast('封面图片已开始下载', '⬇️');
    } else {
      const srcPath = decodeURIComponent(src.replace(/^file:\/\/\//, '')).replace(/\//g, '\\');
      const r = await backend.saveCover(srcPath, `${$('#cTitle').value.trim() || '封面'}_方案${idx + 1}`);
      if (r.ok) { toast('封面已保存：' + r.path, '⬇️'); addLog('info', '封面生成', `封面方案 ${idx + 1} 已保存到本地`); }
      else if (!r.canceled) toast('保存失败：' + (r.error || ''), '⚠️');
    }
  }
});
$('#btnCoverClear').addEventListener('click', () => {
  $('#coverGrid').hidden = true;
  $('#coverGrid').innerHTML = '';
  $('#coverResultBar').hidden = true;
  $('#coverEmpty').hidden = false;
});

/* 生成历史 */
const historyModal = $('#historyModal');
function renderHistory() {
  const list = $('#historyList');
  if (!coverHistory.length) {
    list.innerHTML = '<div class="history-empty">暂无生成记录，去生成第一张封面吧</div>';
    return;
  }
  list.innerHTML = coverHistory.map((h, i) => `
    <div class="history-item">
      <div class="history-info">
        <b>《${esc(h.title)}》</b>
        <span>${h.n} 张 · ${h.time}</span>
      </div>
      <div class="history-thumbs">${h.images.slice(0, 4).map(s => `<img src="${esc(fileUrl(s))}" alt="">`).join('')}</div>
      <button class="btn-mini" data-h="${i}">查看</button>
    </div>`).join('');
}
$('#btnCoverHistory').addEventListener('click', () => { renderHistory(); historyModal.hidden = false; });
$('#btnHistoryClose').addEventListener('click', () => historyModal.hidden = true);
historyModal.addEventListener('click', e => { if (e.target === historyModal) historyModal.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !historyModal.hidden) historyModal.hidden = true; });
$('#historyList').addEventListener('click', e => {
  const b = e.target.closest('[data-h]');
  if (!b) return;
  const h = coverHistory[+b.dataset.h];
  lastBatch.covers = h.images.slice();
  lastBatch.title = h.title;
  lastBatch.taskId = h.taskId || null;
  lastBatch.source = 'local';
  const grid = $('#coverGrid');
  grid.innerHTML = h.images.map((src, i) => `
    <div class="cover-item" data-i="${i}">
      <img src="${esc(fileUrl(src))}" alt="封面方案 ${i + 1}">
      <span class="cover-badge" hidden>✔ 已选为封面</span>
      <div class="cover-act">
        <button class="btn-mini" data-cact="pick">✔ 设为首选</button>
        <button class="btn-mini" data-cact="dl">${IN_MOCK ? '⬇ 下载' : '💾 保存本地'}</button>
      </div>
    </div>`).join('');
  grid.hidden = false;
  $('#coverEmpty').hidden = true;
  $('#coverMeta').textContent = `历史记录 · ${h.n} 张 · ${h.time}`;
  $('#coverResultBar').hidden = false;
  historyModal.hidden = true;
  toast('已载入该批生成结果', '🕘');
});

/* ============ 简介书名生成 ============ */
const GEN_FIELDS = { title: '书名候选', intro: '简介候选', prompt: '封面提示词' };
let genItems = [];
let generatedFor = null;
let genCount = 3;
function refreshTaskSelect() {
  const sel = $('#gTask');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = tasks.map(t => `<option value="${t.id}">${esc(taskTitle(t))}</option>`).join('')
    || '<option value="">暂无任务，请先在「长篇投稿」导入小说</option>';
  if (cur && tasks.some(t => String(t.id) === cur)) sel.value = cur;
}
$('#gCount').addEventListener('click', e => {
  const b = e.target.closest('.seg-item');
  if (!b) return;
  $$('#gCount .seg-item').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  genCount = +b.dataset.n;
});
$('#btnGenText').addEventListener('click', async () => {
  const t = tasks.find(x => x.id === $('#gTask').value);
  if (!t) { toast('暂无投稿任务，请先在「长篇投稿」导入小说', '⚠️'); return; }
  const type = $('#gType').value;
  generatedFor = { id: t.id, type };
  const extra = $('#gExtra').value.trim();
  const btn = $('#btnGenText');
  btn.disabled = true; btn.textContent = '生成中…';
  $('#genMeta').hidden = true;
  const n = type === 'prompt' ? 1 : genCount;
  $('#genList').innerHTML = candSkeleton(n, 86);
  const t0 = performance.now();
  let items = [], source = 'local', err = '';
  if (type === 'prompt') {
    const r = await backend.genCandidates(t.cfg, 'cover-prompt', 1, '', { extra });
    if (r.ok) { items = [r.prompt]; source = r.promptSource === 'text-ai' ? 'ai' : r.promptSource; }
    else err = r.error;
  } else {
    const r = await backend.genCandidates(t.cfg, type, n, extra);
    if (r.ok) { items = r.items || []; source = r.source; }
    else err = r.error;
  }
  btn.disabled = false; btn.textContent = '✨ 生成候选';
  if (err) {
    $('#genList').innerHTML = `<div class="gen-empty">生成失败：${esc(err)}</div>`;
    addError('文本生成', `《${taskTitle(t)}》${GEN_FIELDS[type]}生成失败：${err}`, taskTitle(t));
    return;
  }
  genItems = items;
  $('#genList').innerHTML = genItems.map((s, i) => `
    <div class="gen-cand">
      <div class="gen-cand-head">
        <b>候选 ${i + 1}</b>
        <div class="row-actions">
          <button class="btn-mini green" data-guse="${i}">✔ 采用到任务</button>
          <button class="btn-mini" data-gcopy="${i}">📋 复制</button>
        </div>
      </div>
      <div class="gen-cand-body">${esc(s)}</div>
    </div>`).join('');
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  $('#genMeta').hidden = false;
  $('#genMeta').textContent = `《${taskTitle(t)}》 · ${genItems.length} 个候选 · ${source === 'ai' ? 'AI 生成' : '本地规则'} · ${sec}s`;
  addLog('success', '文本生成', `《${taskTitle(t)}》${GEN_FIELDS[type]}生成完成（${genItems.length} 个候选 · ${source === 'ai' ? 'AI' : '本地'}）`);
  toast('候选生成完成', '✨');
});
$('#genList').addEventListener('click', async e => {
  const use = e.target.closest('[data-guse]');
  const copy = e.target.closest('[data-gcopy]');
  if (!use && !copy) return;
  const idx = +(use || copy).dataset[use ? 'guse' : 'gcopy'];
  const val = genItems[idx] ?? '';
  if (copy) {
    try { await navigator.clipboard.writeText(val); toast('已复制到剪贴板', '📋'); }
    catch { toast('复制失败，请手动选择复制', '⚠️'); }
    return;
  }
  const t = tasks.find(x => x.id === generatedFor?.id);
  if (!t) return;
  const type = generatedFor.type;
  if (type === 'title') {
    t.cfg.作品名称 = val; t.name = val;
    toast(`书名已更换为《${val}》`, '📝');
  } else if (type === 'intro') {
    t.cfg.作品简介 = val; t.introEmpty = false;
    toast('简介已更新到任务', '📄');
  } else {
    t.coverPrompt = val;
    toast('封面提示词已保存，选封面时自动带出', '🎨');
  }
  const card = use.closest('.gen-cand');
  if (card) { card.classList.add('apply-flash'); setTimeout(() => card.classList.remove('apply-flash'), 800); }
  persistTasks(); renderTasks(); renderWorkbench(); refreshTaskSelect();
  addLog('info', '文本生成', `《${taskTitle(t)}》已采用${GEN_FIELDS[type]}候选 ${idx + 1}`);
});

/* Unified model settings live in studio.js. Legacy view selectors are read-only. */
function activeTextModel(){return settingsCache.textModel||'尚未配置文本模型';}
function refreshModelSelects(){
  for(const [id,key] of [['cModel','imageModel'],['gModel','textModel']]){const el=$('#'+id);if(el){el.innerHTML='<option>'+esc(settingsCache[key]||'请在 AI 设置中配置')+'</option>';el.disabled=true;}}
}

/* ============ 账号设置 ============ */
async function loadAccountPage() {
  const cred = await backend.getCredentials();
  $('#acctPhone').value = cred.phone || '';
  $('#acctBadge').textContent=cred.loginOpen?'待保存登录':cred.loginRequired?'需要登录':cred.sessionSaved?'登录已保存':'未登录';
  $('#acctBadge').className='badge '+(cred.sessionSaved&&!cred.loginRequired?'green':'gray');
  $('#acctLoginSub').textContent='';
  const s = await backend.getSettings();

  await refreshAccountList();
}
async function refreshAccountList() {
  const list = await backend.listAccounts();
  window.renderStudioAccounts?.(list);
  $('#acctSelect').innerHTML = '<option value="">— 已保存账号 —</option>' +
    list.map(a => `<option value="${esc(a.name)}">${esc(a.name)}（${esc(a.phone)}）</option>`).join('');
}
$('#btnPlatformLogin').addEventListener('click',async()=>{
  const button=$('#btnPlatformLogin');button.disabled=true;
  try{const r=await backend.openPlatformLogin($('#acctPhone').value.trim());if(!r.ok)throw new Error(r.error);await loadAccountPage();toast('浏览器已打开');}catch(e){toast(e.message,'⚠️');}finally{button.disabled=false;}
});
$('#btnPlatformLoginSave').addEventListener('click',async()=>{
  const button=$('#btnPlatformLoginSave');button.disabled=true;
  try{const r=await backend.savePlatformLogin();if(!r.ok)throw new Error(r.error);await loadAccountPage();toast('登录已保存');}catch(e){toast(e.message,'⚠️');}finally{button.disabled=false;}
});
backend.onPlatformLoginState?.(()=>loadAccountPage().catch(()=>{}));
$('#btnCredSave').addEventListener('click', async () => {
  const phone = $('#acctPhone').value.trim();
  const pwd = $('#acctPassword').value;
  if (!phone) return toast('请填写手机号', '⚠️');
  if (!pwd) return toast('填写密码以更新登录凭据（留空 = 不修改）', '⚠️');
  const r = await backend.saveCredentials(phone, pwd);
  if (r.ok) { $('#acctPassword').value = ''; await loadAccountPage(); addLog('success', '账号服务', '登录凭据已更新'); toast('登录凭据已保存', '💾'); }
  else toast(r.error, '⚠️');
});
$('#btnAcctSave').addEventListener('click', async () => {
  const name = $('#acctName').value.trim();
  const phone = $('#acctPhone').value.trim();
  const pwd = $('#acctPassword').value;
  if (!phone) return toast('请先在上方填写手机号', '⚠️');
  if (!name) return toast('先填账号备注名', '⚠️');
  const r = await backend.saveAccount(name, phone, pwd);
  if (r.ok) { await refreshAccountList(); $('#acctSelect').value = name; $('#acctName').value = ''; toast('账号已保存：' + name, '👤'); }
  else toast(r.error, '⚠️');
});
$('#btnAcctSwitch').addEventListener('click', async () => {
  const name = $('#acctSelect').value;
  if (!name) return toast('先选择要切换的账号', '⚠️');
  if (!confirm(`切换到「${name}」？\n切换后需在浏览器登录。`)) return;
  setBusy('正在切换账号并重置浏览器会话…');
  const r = await backend.switchAccount(name);
  setBusy(null);
  if (r.ok) {
    await loadAccountPage();
    revData = null;
    tasks.forEach(t => { t.siteInfo = null; });
    renderTasks(); renderWorkbench();
    addLog('success', '账号服务', `已切换到账号「${name}」，请打开浏览器登录`);
    toast('已切换到：' + name, '👤');
  } else toast(r.error, '⚠️');
});
$('#btnAcctDelete').addEventListener('click', async () => {
  const name = $('#acctSelect').value;
  if (!name) return toast('先选择要删除的账号', '⚠️');
  if (!confirm(`删除账号「${name}」？（不影响当前登录）`)) return;
  await backend.deleteAccount(name);
  await refreshAccountList();
  toast('已删除账号', '🗑️');
});
$('#btnLogout').addEventListener('click', async () => {
  if (!confirm('确定退出当前登录？')) return;
  const r = await backend.clearCredentials();
  if (!r.ok) return toast(r.error, '⚠️');
  await loadAccountPage();
  toast('已清除登录凭据', '👋');
});
try{localStorage.removeItem('wawa-mail-sender');}catch{}

/* ============ 运行日志 ============ */
const LOG_LEVELS = {
  info:    { name: '信息', color: '#7fb3ff' },
  success: { name: '成功', color: '#4ade80' },
  warn:    { name: '警告', color: '#fbbf24' },
  error:   { name: '错误', color: '#f87171' },
};
let logs = [];   // {t, level, module, msg}
function parseLogLine(line) {
  let level = 'info', module = '系统';
  if (/失败|错误|❌/.test(line)) level = 'error';
  else if (/警告|⚠/.test(line)) level = 'warn';
  else if (/成功|完成|✅/.test(line)) level = 'success';
  if (/投稿|投递|章节|作品库/.test(line)) module = '投稿引擎';
  else if (/封面/.test(line)) module = '封面生成';
  else if (/简介|书名|候选/.test(line)) module = '文本生成';
  else if (/收益/.test(line)) module = '收益数据';
  else if (/登录|账号/.test(line)) module = '账号服务';
  return { t: new Date().toTimeString().slice(0, 8), level, module, msg: line };
}
function addLog(level, module, msg) {
  logs.push({ t: new Date().toTimeString().slice(0, 8), level, module, msg });
  if (logs.length > 500) logs.shift();
  renderLogs();
}
function renderLogs() {
  const lv = $('#logLevel').value;
  const md = $('#logModule').value;
  const kw = $('#logSearch').value.trim().toLowerCase();
  const rows = logs.filter(l =>
    (!lv || l.level === lv) && (!md || l.module === md) && (!kw || l.msg.toLowerCase().includes(kw)));
  $('#logConsole').innerHTML = rows.map(l => `
    <div class="log-line">
      <span class="log-t">${l.t}</span>
      <span class="log-lv" style="color:${LOG_LEVELS[l.level].color}">${LOG_LEVELS[l.level].name}</span>
      <span class="log-md">${esc(l.module)}</span>
      <span class="log-msg">${esc(l.msg)}</span>
    </div>`).join('') || '<div class="log-none">暂无日志</div>';
  $('#logMeta').textContent = `显示 ${rows.length} 条 · 共 ${logs.length} 条 · 超过 500 条自动清理旧日志`;
  if ($('#logAuto').checked) {
    const c = $('#logConsole');
    c.scrollTop = c.scrollHeight;
  }
}
['logLevel', 'logModule', 'logSearch'].forEach(id =>
  $('#' + id).addEventListener('input', renderLogs));
$('#btnLogsExport').addEventListener('click', () => {
  const text = logs.map(l => `[${l.t}] [${LOG_LEVELS[l.level].name}] [${l.module}] ${l.msg}`).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `运行日志_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  toast('日志已导出为 TXT', '⬇️');
});
$('#btnLogsClear').addEventListener('click', () => {
  logs = [];
  renderLogs();
  toast('日志已清空（历史日志仍在 data/logs）', '🧹');
});

/* ============ 窗口控制 ============ */
/* Electron：无边框窗口，页面标题栏即真实标题栏（win-control IPC + CSS 拖拽区）
   浏览器预览：页内模拟桌面窗口（拖动 / 最大化样式 / 关闭遮罩） */
const win = $('#appWindow');
if (!IN_MOCK) document.body.classList.add('in-electron');
$('#btnMin').addEventListener('click', () => {
  if (IN_MOCK) return toast('已最小化到系统托盘（演示）', '🐤');
  backend.winControl('min');
});
$('#btnMax').addEventListener('click', () => {
  if (IN_MOCK) return win.classList.toggle('maximized');
  backend.winControl('max');
});
$('#btnClose').addEventListener('click', () => {
  if (IN_MOCK) { win.style.display = 'none'; $('#closedOverlay').hidden = false; return; }
  backend.winControl('close');
});
$('#btnReopen').addEventListener('click', () => location.reload());

/* 标题栏拖动（仅浏览器模拟；Electron 由 CSS -webkit-app-region 接管，
   双击最大化也是无边框拖拽区的系统默认行为，不再重复绑定） */
if (IN_MOCK) {
  let dragging = null;
  $('#titlebar').addEventListener('mousedown', e => {
    if (e.target.closest('.win-btn') || win.classList.contains('maximized')) return;
    const r = win.getBoundingClientRect(), dr = $('#desktop').getBoundingClientRect();
    dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    win.classList.add('dragging');
    win.style.left = (r.left - dr.left) + 'px';
    win.style.top  = (r.top  - dr.top)  + 'px';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dr = $('#desktop').getBoundingClientRect();
    win.style.left = (e.clientX - dr.left - dragging.dx) + 'px';
    win.style.top  = Math.max(0, e.clientY - dr.top - dragging.dy) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = null; win.classList.remove('dragging'); }
  });
}

/* ============ 后端事件接线 ============ */
backend.onLog(({ line }) => { logs.push(parseLogLine(line)); if (logs.length > 500) logs.shift(); renderLogs(); });
backend.onRunStatus(({ running, paused, browserLost }) => {
  runState = { active: running, paused: !!paused, browserLost: !!browserLost };
  renderRunState();
  if (!running) setBusy(null);
});
backend.onTaskStatus(({ id, status, message, sid }) => {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  t.status = status;
  t.message = message ?? '';
  if (sid != null) { t.sid = sid; persistTasks(); }
  if (status === 'error') addError('投稿引擎', `${taskTitle(t)}：${message || '投稿失败'}`, taskTitle(t));
  renderTasks();
});
backend.onRunProgress(d => {
  if (d.done) {
    const outcome = d.dryRun ? '预览通过' : '成功';
    const action = d.dryRun ? '干跑预览' : '批量投稿';
    $('#runBarFill').style.width = '100%';
    $('#runStepText').textContent = `${d.stopped ? '已停止' : '完成'}：${outcome} ${d.ok} · 失败 ${d.fail}${d.skip ? ' · 跳过 ' + d.skip : ''}`;
    $('#runCountText').textContent = '';
    backend.notifyDone();
    addLog(d.fail > 0 ? 'warn' : 'success', '投稿引擎', `${action}${d.stopped ? '已停止' : '结束'}：${outcome} ${d.ok}${d.fail ? ` · 失败 ${d.fail}` : ''}${d.skip ? ` · 跳过 ${d.skip}` : ''}`);
    toast(`${action}${d.stopped ? '已停止' : '结束'}：${outcome} ${d.ok}${d.fail ? ` · 失败 ${d.fail}` : ''}`, d.fail > 0 ? '⚠️' : '🏁');
    persistTasks(); renderTasks(); renderWorkbench();
    return;
  }
  runState.active = true;
  renderRunState();
  const pct = Math.round((d.i / d.total) * 100);
  $('#runBarFill').style.width = pct + '%';
  $('#runStepText').textContent = `《${d.name}》 · ${d.step || '处理中'}`;
  $('#runCountText').textContent = `第 ${d.i}/${d.total} 本 · ${lastRunMeta.mode === 'dry' ? '干跑预览' : '真实提交'} · ${lastRunMeta.headless ? '无头后台' : '显示浏览器'}`;
});
backend.onRevStatus(({ text }) => setBusy(text || null));
backend.onLoginWait(({ secondsLeft }) => {
  setBusy(`等待登录… 剩余 ${secondsLeft}s（可在浏览器窗口中手动完成滑块）`);
});

/* ============ 初始化 ============ */
(async function init() {
  try {
    siteData = await backend.getSiteData();
    tasks = (await backend.loadTasks()) || [];
    tasksLoaded = true;
    for (const item of (await backend.loadLogs()) || []) logs.push(parseLogLine(item.line ?? item));
    // Unified AI settings are authoritative; old browser provider cache cannot overwrite them.
    settingsCache=await backend.getSettings();

    fillEntryFilter();
    renderTasks(); renderWorkbench(); renderLogs(); renderErrors();
  refreshTaskSelect(); renderRunState();
  renderImportList();
  refreshModelSelects();
    loadAccountPage();
    addLog(IN_MOCK ? 'warn' : 'success', '系统',
      IN_MOCK ? '当前为静态预览（模拟后端）；在应用内运行时自动连接真实引擎' : '已连接投稿引擎，数据加载完成');
    if (tasks.length) addLog('info', '系统', `已恢复 ${tasks.length} 个任务（上次会话）`);
    // 更新检测前置：有本地文件的任务，启动后自动静默核对一次站内状态
    if (tasks.some(t => t.cfg.本地文件)) setTimeout(() => refreshPanelStatus(true), 2000);
  } catch (err) {
    addLog('error', '系统', '初始化失败：' + err.message);
    console.error(err);
  }
  const hash = location.hash.slice(1);
  if (hash && $('#page-' + hash)) showPage(hash);
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (h && $('#page-' + h)) showPage(h);
  });
})();
