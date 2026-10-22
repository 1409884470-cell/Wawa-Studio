import { attachStudio } from './studio-main.mjs';
import { resolvePen } from './studio-policy.mjs';
import crypto from 'node:crypto';
import { buildCoverPrompt, COVER_FIXED, inferCoverStyle } from './cover-prompt.mjs';
import { compressCoverBuffer } from './cover-compression.mjs';
// 蛙蛙写作自动投稿工具 - Electron 主进程
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createRunner, loadSiteData, validateConfig, normalizeConfig,
  loadCredentials, saveCredentials, clearCredentials,
  loadSettings, saveSettings, OUTPUT_DIR, PROFILE_DIR, SESSION_FILE,
} from './core.mjs';
import {
  parseNovelFile, deriveMeta,
  aiTitles, aiIntro, aiCoverPromptGen, deAiChapter, aiPing, imageAiPing, aiConfigured, imageAiConfigured,
  localTitleVariants, localIntroVariants, readNovelChapters,
} from './auto.mjs';
import { userPath } from './paths.mjs';
import { runSubmission } from './submission-engine.mjs';
import { openStore, atomicJSON, archiveManuscript, validScheme } from './automation-store.mjs';
import { AutomationQueue } from './automation-engine.mjs';
import { createPackagingAI } from './packaging-ai.mjs';

app.setName('wawa-unified-studio');
app.setPath('userData', userPath('electron-profile'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance',()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.focus();}});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let runner = null;
let runnerHeadless = null;
let busy = false;
let automationSiteBusy = false;
let automation;
let siteTail = Promise.resolve();

async function withAutomationSite(fn) {
  const previous = siteTail;
  let release;
  siteTail = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    if (busy || revBusy) throw new Error('手动投稿或收益同步正在运行，请稍后重试自动任务');
    automationSiteBusy = true;
    const r = await getRunner(true);
    await r.ensureLogin({ loginWait: 120, onWait: sec => send('login-wait', { secondsLeft: sec }) });
    return await fn(r);
  } finally { automationSiteBusy = false; release(); }
}

function getAutomation() {
  if (!automation) automation = new AutomationQueue({
    store: openStore(userPath('data', 'automation.json')), root: userPath('data', 'automation'),
    getSettings: loadSettings, getAccount: () => loadCredentials()?.phone || '', getSite: loadSiteData,
    aiFactory: settings => createPackagingAI({ settings, onPrompt: (key,text) => {log('[提示词调用] 投稿 / '+key);if(text){const f=userPath('data','prompt-usage.json');let usage={};try{usage=JSON.parse(fs.readFileSync(f,'utf8'));}catch{}usage[key]={at:new Date().toISOString(),text};atomicJSON(f,usage);}}, coverDir: userPath('covers', 'automation'), compressImage: buf => compressCoverBuffer(buf,nativeImage), decodeImage: buf => !nativeImage.createFromBuffer(buf).isEmpty() }),
    withSite: withAutomationSite,
    checkConfig: (cfg, site) => validateConfig(cfg, site), emit: state => send('automation-state', state),
  });
  return automation;
}

ipcMain.handle('automation-state', () => getAutomation().snapshot());
ipcMain.handle('automation-sync-review', async () => {
  try {await getAutomation().syncReviews({manual:true});return {ok:true};}
  catch(e){return {ok:false,error:e.message};}
});
ipcMain.handle('automation-cleaning', (_e,id) => {
  try {const j=getAutomation().job(id);return {ok:true,report:JSON.parse(fs.readFileSync(j.artifacts.cleaning,'utf8'))};}
  catch(e){return {ok:false,error:e.message};}
});
ipcMain.handle('automation-import', async (_e, { files, scheme }) => {
  try { return { ok: true, ...await getAutomation().import(files, scheme) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('automation-control', (_e, { action, id, patch }) => {
  try {
    const q = getAutomation();
    if(action==='compress-cover') {
      const j=q.job(id);
      if(q.active.has(id)||j.remote||j.uploadIntent)throw new Error('请暂停并等待当前步骤结束；已有远端记录的封面不能改动');
      if(['rewrite','delete-rejected'].includes(j.stage))throw new Error('请先完成正文修订，再处理封面');
      if(!j.cover || !fs.existsSync(j.cover))throw new Error('没有可压缩的本地封面');
      const original=fs.readFileSync(j.cover), compressed=compressCoverBuffer(original,nativeImage);
      if(compressed!==original){const target=j.cover+'.compressed.jpg';fs.writeFileSync(target,compressed);j.cover=target;}
      if(j.cfg)j.cfg.cover=j.cover;
      delete j.remoteCover;
      j.stage='check';j.status='attention';j.error={stage:'check',message:'封面压缩完成，点击重试继续',at:new Date().toISOString()};q.save();
      return {ok:true};
    }
    if (action === 'pause') q.pause(); else if (action === 'resume') q.resume(); else q.control(id, action, patch);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('automation-scheme', (_e, { action, scheme, name }) => {
  try {
    const q = getAutomation();
    if (action === 'delete') q.store.state.schemes = q.store.state.schemes.filter(s => s.name !== name);
    else { const s = validScheme(scheme); q.store.state.schemes = [...q.store.state.schemes.filter(x => x.name !== s.name), s]; q.store.state.defaultScheme = s.name; }
    q.save(); return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('automation-chapters', (_e, id) => {
  try { return { ok: true, chapters: getAutomation().chapters(getAutomation().job(id)) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

/* ---------------- 数据目录（任务/日志/小说归档/记忆库/模板/账号） ---------------- */
const DATA_DIR = userPath('data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const NOVELS_DIR = path.join(DATA_DIR, 'novels');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'settings-templates.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function loadLibrary() {
  try {
    const v = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf-8'));
    return v && v.byTitle ? v : { byTitle: {} };
  } catch { return { byTitle: {} }; }
}
function recordLibrary(title, sid, baseId, chapters) {
  if (!title || sid == null) return;
  const l = loadLibrary();
  l.byTitle[title] = { sid, baseId, chapters: chapters ?? null, updatedAt: new Date().toISOString() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(l, null, 1));
}

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const log = (line) => {
  console.log('[wawa]', line);
  send('log', { line, ts: Date.now() });
  // 日志持久化：按天落盘（北京时间），软件重开可回看
  try {
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    fs.appendFileSync(path.join(LOGS_DIR, `${day}.log`), `[${ts}] ${line}\n`);
  } catch { /* 日志写失败不影响主流程 */ }
};

function createWindow() {
  let bounds = { width: 1120, height: 880 };
  try { bounds = { ...bounds, ...JSON.parse(fs.readFileSync(userPath('window-state.json'), 'utf-8')) }; } catch { /* 首次 */ }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 940, minHeight: 720,
    ...(bounds.maximized ? { show: false } : {}),
    frame: false,
    backgroundColor: '#f4f5f7',
    title: '蛙蛙创作工作室',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (bounds.maximized) { win.maximize(); win.show(); }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', () => {
    try { fs.writeFileSync(userPath('window-state.json'), JSON.stringify({ x: win.getBounds().x, y: win.getBounds().y, width: win.getBounds().width, height: win.getBounds().height, maximized: win.isMaximized() })); } catch { /* ignore */ }
  });
  win.on('closed', () => { win = null; });
}

/* ---------------- 基础 IPC ---------------- */

ipcMain.handle('get-site-data', () => loadSiteData());
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, patch) => {
  if(patch && Object.hasOwn(patch,'penName')){
    if(typeof patch.penName!=='string' || !patch.penName.trim() || patch.penName.trim().length>40)throw new Error('笔名须为1至40字');
    patch={...patch,penName:patch.penName.trim()};
  }
  const saved=saveSettings(patch ?? {});
  if(patch && Object.hasOwn(patch,'penName') && automation)automation.updatePendingPenNames();
  return saved;
});

ipcMain.handle('get-credentials', () => {
  const c = loadCredentials();
  return c ? { has: true, phone: c.phone } : { has: false, phone: '' };
});
ipcMain.handle('save-credentials', (_e, { phone, password }) => {
  try {
    if (busy || revBusy || automationSiteBusy) return { ok: false, error: '站点操作执行中，请等待结束后修改账号' };
    if (!phone || !password) return { ok: false, error: '手机号和密码不能为空' };
    saveCredentials({ phone, password });
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('clear-credentials', () => {
  if (busy || revBusy || automationSiteBusy) return { ok: false, error: '站点操作执行中，请等待结束后清除账号' };
  clearCredentials(); return { ok: true };
});

ipcMain.handle('validate-config', (_e, cfg) => validateConfig(normalizeConfig(cfg)));

ipcMain.handle('pick-files', async (_e, { kind }) => {
  const filters = kind === 'image'
    ? [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    : [{ name: '小说文稿', extensions: ['txt', 'docx'] }];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('open-output', async () => { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); await shell.openPath(OUTPUT_DIR); });
ipcMain.handle('open-path', async (_e, p) => { if (p) await shell.openPath(p); });

// 封面导入归档：把选中的图片拷贝进用户数据 covers/ 目录（原文件移动/删除不影响）
ipcMain.handle('archive-cover', async (_e, { src }) => {
  try {
    if (!src || !fs.existsSync(src)) return { ok: false, error: '文件不存在' };
    fs.mkdirSync(userPath('covers'), { recursive: true });
    const dest = userPath('covers', `imported-${Date.now().toString(36)}${(path.extname(src) || '.png').toLowerCase()}`);
    fs.copyFileSync(src, dest);
    return { ok: true, path: dest };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// 封面另存到本地：另存为对话框 + 拷贝
ipcMain.handle('save-cover', async (_e, { src, name }) => {
  try {
    if (!src || !fs.existsSync(src)) return { ok: false, error: '封面文件不存在' };
    const r = await dialog.showSaveDialog(win, {
      title: '保存封面到本地',
      defaultPath: `${name || '封面'}${path.extname(src) || '.png'}`,
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.copyFileSync(src, r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

/* ---------------- 站内作品导入 ---------------- */

async function getRunner(headless = true) {
  if (runner?.running && runnerHeadless !== !!headless) {
    await runner.close();
    runner = null;
  }
  if (!runner) runner = createRunner({ onLog: (line) => send('log', { line, ts: Date.now() }) });
  if (!runner.running) { await runner.launch({ headless: !!headless }); runnerHeadless = !!headless; }
  return runner;
}

ipcMain.handle('site-works', async () => {
  if (busy || revBusy || automationSiteBusy) return { ok: false, error: '请等待当前投稿或站内同步完成', works: [] };
  revBusy = true;
  try {
    const r = await getRunner(true);
    await r.ensureLogin({ loginWait: 120, onWait: (sec) => send('login-wait', { secondsLeft: sec }) });
    const works = await r.listSiteWorks();
    return { ok: true, works };
  } catch (e) {
    return { ok: false, error: String(e.message || e), works: [] };
  } finally { revBusy = false; }
});

/* ---------------- 任务准备（自动生成标题/简介/封面/类目） ---------------- */

// payload: { kind: 'file', path } | { kind: 'site', work: {id,title,wordCount,storyType,cover} }
// options: { aiTitle: bool, aiIntro: bool, aiCover: bool }  默认按是否配置了 API 决定
ipcMain.handle('prepare-task', async (_e, payload) => {
  try {
    const settings = loadSettings();
    let parsed = null, meta, sourceTitle = null, localFile = null, siteCoverUrl = null;

    if (payload.kind === 'file') {
      localFile = payload.path;
      parsed = await parseNovelFile(payload.path);
      meta = deriveMeta(parsed.text, parsed.title);
      // 归档到 data/novels：任务引用副本，原文件移动/删除不影响后续更新
      try {
        fs.mkdirSync(NOVELS_DIR, { recursive: true });
        const dest = archiveManuscript(payload.path, NOVELS_DIR).file;
        if (path.resolve(dest) !== path.resolve(payload.path) &&
            (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(fs.readFileSync(payload.path)))) {
          fs.copyFileSync(payload.path, dest);
        }
        if (localFile !== dest) log(`小说已归档：data/novels/${path.basename(dest)}`);
        localFile = dest;
      } catch { /* 归档失败退回原路径 */ }
      // 空白章节体检：仅提示数量，剔除在投稿执行时进行
      try {
        const cleanN = (await readNovelChapters(localFile)).length;
        if (parsed.chapters && cleanN < parsed.chapters) {
          log(` 《${parsed.title}》：发现 ${parsed.chapters - cleanN} 个空白章节，投稿时将自动跳过`);
        }
      } catch { /* 忽略 */ }
    } else {
      sourceTitle = payload.work.title;
      meta = deriveMeta(payload.work.title + ' ' + (payload.work.introGuess ?? ''), payload.work.title);
      parsed = { title: payload.work.title, body: '', wordCount: payload.work.wordCount ?? 0, chapters: 0, text: payload.work.title };
      siteCoverUrl = payload.work.cover ?? null;
      // 站内作品题材从标题推断（无正文）
      meta = deriveMeta(payload.work.title, payload.work.title);
    }

    // 篇幅：站内以 storyType 为准；本地按字数
    const category = payload.kind === 'site'
      ? (payload.work.storyType === 'long' ? '长篇' : '短篇')
      : (parsed.wordCount > 20000 ? '长篇' : '短篇');

    // 投稿入口：短篇必须走征文；长篇普通投稿
    const site = loadSiteData();
    const entry = category === '短篇' ? '' : '普通投稿';

    // ---- 标题：沿用文件原书名（《书名》行 > 文件名），改名交给用户（调整弹窗 / 换标题）----
    const title = parsed.title;
    const titleCandidates = [];

    // ---- 简介：只提取文件自带简介；AI 生成一律手动（任务卡「选简介」里操作） ----
    let intro = '';
    if (parsed.headIntro && parsed.headIntro.length >= 20) {
      intro = parsed.headIntro.slice(0, 500);
      log(`使用文件自带简介（${intro.length} 字）`);
    } else {
      log('文件无自带简介，已留空 —— 点任务卡「选简介」手动生成或摘录');
    }

    // ---- 封面：导入时不自动生成，留给用户点「换封面」挑选 ----
    // 站内作品直接复用其线上封面 URL（无需下载）
    const cover = payload.kind === 'site' ? siteCoverUrl : null;
    const coverSource = payload.kind === 'site' && siteCoverUrl ? 'site' : 'none';

    const cfg = {
      作品标题: sourceTitle ?? '',
      作品ID: payload.kind === 'site' ? payload.work.id : null,
      本地文件: localFile ?? '',
      封面: cover,
      作品名称: title,
      笔名: settings.penName || '',
      作品字数: parsed.wordCount ? String(parsed.wordCount) : '',
      投稿入口: entry,
      作品分类: category,
      作品频道: meta.channel,
      作品状态: '已完结',
      小说类目: meta.novelType,
      作品标签: meta.tags,
      自定义标签: [],
      作品简介: intro,
    };
    return { ok: true, cfg, info: { ruleName: meta.ruleName, coverSource, titleCandidates, words: parsed.wordCount, chapters: parsed.chapters } };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

/* ---------------- 候选生成（标题/简介/封面） ---------------- */

// payload: { cfg, field: 'title'|'intro'|'cover', count, prompt?, text? }
ipcMain.handle('gen-candidates', async (_e, { cfg, field, count = 3, prompt, options = {} }) => {
  try {
    count = Math.max(1, Math.min(5, Math.trunc(Number(count) || 3)));
    const c = normalizeConfig(cfg);
    const parsed = c.localFile && fs.existsSync(c.localFile) ? await parseNovelFile(c.localFile) : { text: c.title || '', body: '', wordCount: Number(c.wordCount) || 0, headIntro: c.intro };
    if (field === 'title') {
      if (aiConfigured() && parsed.text?.length > 300) {
        try { const titles = await aiTitles(parsed.text, { channel: c.channel, count, extra: prompt }); if (titles.length) return { ok: true, items: titles.slice(0, count), source: 'ai' }; }
        catch (e) { if (prompt?.trim()) throw e; log(`AI 标题失败：${e.message.split('\n')[0]}`); }
      }
      if (prompt?.trim()) throw new Error('补充要求需要可用的文本 AI 和足够的小说内容，请配置后重试');
      return { ok: true, items: localTitleVariants(c.title || parsed.title, parsed.headIntro || c.intro, parsed.body).slice(0, count), source: 'local' };
    }
    if (field === 'intro') {
      if (aiConfigured() && parsed.text?.length > 300) {
        try {
          const outs = [];
          for (let i = 0; i < count; i++) {
            outs.push(await aiIntro(parsed.text, c.title || parsed.title, { channel: c.channel, wordCount: parsed.wordCount, extra: prompt }));
          }
          if (outs.length) return { ok: true, items: outs, source: 'ai' };
        } catch (e) { if (prompt?.trim()) throw e; log(`AI 简介失败：${e.message.split('\n')[0]}`); }
      }
      if (prompt?.trim()) throw new Error('补充要求需要可用的文本 AI 和足够的小说内容，请配置后重试');
      return { ok: true, items: localIntroVariants(parsed.body, parsed.wordCount).slice(0, count), source: 'local' };
    }
    if (field === 'cover') {
      return await genCoverCandidates(c, prompt, { ...options, promptOnly: false });
    }
    if (field === 'cover-prompt') {
      return await genCoverCandidates(c, prompt, { ...options, promptOnly: true });
    }
    return { ok: false, error: '未知字段' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// 封面生成统一管线：提示词链（用户传入 > 文本AI 按剧情 > 默认模板）+ 固定/禁止提示词拼接
// + 图像 AI 出图。返回 {cover, prompt(可编辑的基提示词), promptSource, source}
async function genCoverCandidates(c, prompt, { promptOnly = false, size = '1024x1536', extra = '' } = {}) {
  const parsed = c.localFile && fs.existsSync(c.localFile) ? await parseNovelFile(c.localFile) : { text: c.title || '', body: '', wordCount: Number(c.wordCount) || 0, headIntro: c.intro };
  const meta = deriveMeta(parsed.text || c.title || '', c.title || '');
  let basePrompt = (prompt && prompt.trim()) || '';
  let promptSource = 'manual';
  if (!basePrompt && aiConfigured() && parsed.text?.length > 300) {
    try {
      basePrompt = await aiCoverPromptGen(parsed.text, c.title || parsed.title, { channel: c.channel, ruleName: meta.ruleName, intro: c.intro, extra });
      promptSource = 'text-ai';
      log(`文本 AI 生成封面提示词（${basePrompt.length} 字）`);
    } catch (e) { log(`文本 AI 提示词失败：${e.message.split('\n')[0]}，用默认模板`); }
  }
  if (promptOnly && !basePrompt) throw new Error('生成提示词需要可用的文本 AI 和足够的小说内容');

  if (!basePrompt) {
    basePrompt = inferCoverStyle(parsed.text || c.intro || '');
    promptSource = 'default';
  }
  const st = loadSettings();
  const fullPrompt = prompt?.trim() ? basePrompt+'\n'+COVER_FIXED+(st.coverExtra?.trim()?'\n'+st.coverExtra.trim():'') : buildCoverPrompt(st,{
    title:c.title||c.sourceTitle,penName:c.penName||st.penName,channel:c.channel,
    genre:meta.ruleName,style:promptSource==='default'?inferCoverStyle(parsed.text):basePrompt,
  });
  if (promptOnly) return {ok:true,prompt:fullPrompt,promptSource};
  if (imageAiConfigured()) {
    const cover = await aiCoverPrompt(fullPrompt, c.title || c.sourceTitle, size);
    return { ok: true, cover, prompt: fullPrompt, promptSource, source: 'ai' };
  }
  throw new Error('未配置可用的图像 AI。请先在「AI设置」添加并启用图像供应商。');
}

// 用指定提示词生成 AI 封面
async function aiCoverPrompt(prompt, title, size = '1024x1536') {
  if (!['1024x1536', '768x1024', '720x1280', '1024x1024', '1280x720'].includes(size)) throw new Error('不支持的封面尺寸');
  const s = loadSettings();
  const base = s.imgApiBaseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/images/generations') ? base : base + '/images/generations';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.imgApiKey}` },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({ model: s.imageModel, prompt, size, response_format: 'b64_json' }),
  });
  if (!r.ok) throw new Error(`封面接口 ${r.status}：${(await r.text()).slice(0, 120)}`);
  const data = await r.json();
  const item = data.data?.[0] ?? {};
  let buf = item.b64_json ? Buffer.from(item.b64_json, 'base64') : null;
  if (!buf && item.url) {
    const imageResponse = await fetch(item.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!imageResponse.ok) throw new Error(`封面图片下载失败：${imageResponse.status}`);
    buf = Buffer.from(await imageResponse.arrayBuffer());
  }
  if (!buf) throw new Error('封面接口未返回图片');
  fs.mkdirSync(userPath('covers'), { recursive: true });
  const file = userPath('covers', `${(title || '封面').replace(/[\\/:*?"<>|]/g, '_').slice(0, 26)}-${Date.now().toString(36)}.png`);
  fs.writeFileSync(file, buf);
  if(buf.length>5*1024*1024){const compressed=compressCoverBuffer(buf,nativeImage);const target=file+'.compressed.jpg';fs.writeFileSync(target,compressed);return target;}
  return file;
}

/* ---------------- 批量执行 ---------------- */

// 面板刷新：拉站内投稿状态 + 前置更新检测（本地章数 vs 站内已投章数）
ipcMain.handle('refresh-panel', async (_e, { tasks: checkList = [] } = {}) => {
  if (busy || revBusy || automationSiteBusy) return { ok: false, error: '投稿或站内同步运行中' };
  revBusy = true;
  try {
    const r = await getRunner(true);
    await r.ensureLogin({ loginWait: 60, onWait: (sec) => send('login-wait', { secondsLeft: sec }) });
    send('rev-status', { text: '正在核对站内投稿状态…' });
    const subs = await r.listSubmissions();
    const statusFor = s => ({
      status: s.status, contract: s.contract, sid: s.sid,
      submittedN: s.submittedN ?? null,
      words: s.words,
    });
    const byTitle = Object.fromEntries(subs.map(s => [s.title, statusFor(s)]));
    const byTask = {};
    // 更新检测前置：算每本书本地章数，标记可更新多少章
    const updates = {};
    for (const item of checkList) {
      if (!item) continue;
      const match = item.sid != null ? subs.find(s => String(s.sid) === String(item.sid))
        : item.sourceId != null ? subs.find(s => String(s.id) === String(item.sourceId))
        : subs.find(s => s.title === item.title);
      const hit = match ? statusFor(match) : null;
      if (item.id) byTask[item.id] = hit;
      if (!item.file || !fs.existsSync(item.file)) continue;
      try {
        const localN = (await readNovelChapters(item.file)).length;
        const submittedN = hit?.submittedN ?? (hit ? 0 : null);
        updates[item.id || item.title] = {
          localN,
          submittedN,
          canUpdate: hit ? localN > (submittedN ?? 0) : null,   // 站内没有 = 新书投稿；有 = 比较章数
          isNew: !hit,
        };
      } catch { /* 解析失败忽略该本 */ }
    }
    send('rev-status', { text: '' });
    return { ok: true, byTitle, byTask, updates };
  } catch (e) {
    send('rev-status', { text: '' });
    return { ok: false, error: String(e.message || e) };
  } finally { revBusy = false; }
});

/* ---------------- 持久化：任务列表 / 日志回看 ---------------- */

ipcMain.handle('load-tasks', () => {
  try {
    const list = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
    return Array.isArray(list) ? list.map(t => ({ ...t,
      status: ['done', 'previewed', 'error'].includes(t.status) ? t.status : 'ready',
      message: ['done', 'previewed', 'error'].includes(t.status) ? (t.message || '') : '' })) : [];
  } catch { return []; }
});
ipcMain.handle('save-tasks', (_e, list) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicJSON(TASKS_FILE, list ?? []);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('load-logs', () => {
  // 回放最近 2 天日志（北京时间命名），尾部 300 行
  const days = [0, 1].map(off => new Date(Date.now() + 8 * 3600e3 - off * 86400e3).toISOString().slice(0, 10));
  const lines = [];
  for (const d of days) {
    try { lines.push(...fs.readFileSync(path.join(LOGS_DIR, `${d}.log`), 'utf-8').split('\n').filter(Boolean)); } catch { /* 无文件 */ }
  }
  return lines.slice(-300).map(l => {
    const m = l.match(/^\[([^\]]+)\] (.*)$/);
    return { ts: m ? m[1] : '', line: m ? m[2] : l };
  });
});

/* ---------------- 设置模板（AI 配置/提示词整包切换） ---------------- */

const TEMPLATE_KEYS = ['apiBaseUrl', 'apiKey', 'textModel', 'imgApiBaseUrl', 'imgApiKey', 'imageModel', 'coverTemplate', 'coverPrefix', 'coverNegative', 'deaiPrompt', 'autoRepairRejected', 'reviewPollMinutes', 'rewriteConcurrency'];
function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8')); } catch { return {}; }
}
ipcMain.handle('list-templates', () => Object.keys(loadTemplates()));
ipcMain.handle('save-template', (_e, { name }) => {
  if (!name?.trim()) return { ok: false, error: '模板名不能为空' };
  const all = loadTemplates();
  const cur = loadSettings();
  all[name.trim()] = Object.fromEntries(TEMPLATE_KEYS.map(k => [k, cur[k] ?? '']));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(all, null, 1));
  return { ok: true, names: Object.keys(all) };
});
ipcMain.handle('apply-template', (_e, { name }) => {
  const t = loadTemplates()[name];
  if (!t) return { ok: false, error: '模板不存在' };
  const next = saveSettings(t);
  log(` 已切换设置模板：${name}`);
  return { ok: true, settings: next };
});
ipcMain.handle('delete-template', (_e, { name }) => {
  const all = loadTemplates();
  delete all[name];
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(all, null, 1));
  return { ok: true, names: Object.keys(all) };
});

/* ---------------- 账号模板（多账号保存与切换） ---------------- */

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')).accounts ?? []; } catch { return []; }
}
function saveAccounts(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: list }, null, 1));
}
ipcMain.handle('list-accounts', () => loadAccounts().map(a => ({ name: a.name, phone: a.phone })));
ipcMain.handle('save-account', (_e, { name, phone, password }) => {
  if (!name?.trim() || !phone?.trim()) return { ok: false, error: '备注名和手机号不能为空' };
  const list = loadAccounts();
  const old = list.find(a => a.name === name.trim());
  const pwd = password?.trim() || old?.password;
  if (!pwd) return { ok: false, error: '该账号还没有密码，请填写密码后再保存' };
  if (old) { old.phone = phone.trim(); old.password = pwd; }
  else list.push({ name: name.trim(), phone: phone.trim(), password: pwd });
  saveAccounts(list);
  return { ok: true, accounts: list.map(a => ({ name: a.name, phone: a.phone })) };
});
ipcMain.handle('switch-account', async (_e, { name }) => {
  if (busy || revBusy || automationSiteBusy) return { ok: false, error: '请等待投稿或收益同步完成后再切换账号' };
  const a = loadAccounts().find(x => x.name === name);
  if (!a) return { ok: false, error: '账号不存在' };
  saveCredentials({ phone: a.phone, password: a.password });
  // 关闭浏览器并清掉旧会话，下次打开投稿页自动用新账号登录
  if (runner) { await runner.close().catch(() => {}); runner = null; }
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch { /* 目录占用 */ }
  try { fs.rmSync(SESSION_FILE, { force: true }); } catch { /* 忽略 */ }
  lastSummary = null;
  log(`已切换账号：${name}（${a.phone}），浏览器会话已重置`);
  return { ok: true };
});
async function deleteAccounts(names){
  try {
    if(!Array.isArray(names)||!names.length||names.some(n=>typeof n!=='string'))throw new Error('请选择账号');
    if(busy||revBusy||automationSiteBusy)throw new Error('站点操作中，请等待完成后删除账号');
    const all=loadAccounts(),removed=all.filter(a=>names.includes(a.name)),current=loadCredentials()?.phone;
    saveAccounts(all.filter(a=>!names.includes(a.name)));
    if(removed.some(a=>a.phone===current)){if(runner){await runner.close().catch(()=>{});runner=null;}clearCredentials();}
    return {ok:true,deleted:removed.length};
  }catch(e){return {ok:false,error:e.message};}
}
ipcMain.handle('delete-accounts', (_e,{names})=>deleteAccounts(names));
ipcMain.handle('delete-account', async (_e, { name }) => {
  const result=await deleteAccounts([name]);
  return {...result,accounts:loadAccounts().map(a=>({name:a.name,phone:a.phone}))};
});

/* ---------------- 投稿执行（API 直连：优先传到作品库） ----------------
   流程：
   - 新书：本地解析全部章节 → create_from_file（整本书进作品库）→ 按投稿范围 submit(chapter_ids)
   - 已投稿过的书：本地切出未投稿的增量章节 → update/create_file 并入库 → submit_chapters 提交
   干跑：只做封面上传/解析/计划，不创建不提交。 */

/* ---------------- 运行控制（暂停 / 继续 / 停止 + 浏览器断开自愈） ---------------- */

const runControl = { paused: false, abort: false, relaunch: false, skipCurrent: false };
class SkipSignal extends Error { constructor() { super('__skip__'); } }
class AbortTaskSignal extends Error { constructor() { super('__abort__'); } }
const checkSkip = () => { if (runControl.skipCurrent) throw new SkipSignal(); };
async function checkRunControl() {
  while (runControl.paused && !runControl.abort && !runControl.skipCurrent) await new Promise(res => setTimeout(res, 100));
  if (runControl.abort) throw new AbortTaskSignal();
  checkSkip();
}
const BROWSER_LOST_RE = /Target closed|Browser closed|browser has been closed|Target page, context or browser has been closed|closed before|Session closed/i;

ipcMain.handle('run-control', (_e, { action }) => {
  if (action === 'pause') { runControl.paused = true; send('run-status', { running: true, paused: true, browserLost: runControl.relaunch }); log('⏸ 已请求暂停（当前章节/任务完成后生效）'); }
  else if (action === 'resume') { runControl.paused = false; send('run-status', { running: true, paused: false, browserLost: false }); log('▶ 继续投稿'); }
  else if (action === 'abort') { runControl.abort = true; runControl.paused = false; log('⏹ 已请求停止投稿（当前操作完成后生效）'); }
  else if (action === 'skip') { runControl.skipCurrent = true; log('⏭ 将在当前步骤结束后跳过这一本…'); }
  return { ok: true };
});

// 去AI处理：就地重写 chapters 里全书序号 <10 的章（文本AI）。返回成功重写数
async function deAiRewrite(t, chapters, startGlobalIdx) {
  let done = 0;
  for (let i = 0; i < chapters.length; i++) {
    await checkRunControl();
    const g = startGlobalIdx + i;          // 全书 0 基章号
    if (g >= 10) break;                     // 只处理前十章
    try {
      chapters[i].text = await deAiChapter(chapters[i].name, chapters[i].text, loadSettings().deaiPrompt);
      done++;
      send('task-status', { id: t.id, status: 'running', message: `去AI重写中（${done} 章）` });
      log(`  去AI：第 ${g + 1} 章完成`);
    } catch (e) {
      log(`  去AI：第 ${g + 1} 章失败保留原文（${e.message.split('\n')[0]}）`);
    }
  }
  return done;
}

async function runTaskViaApi(r, t, mode) {
  return runSubmission(r, t, mode, {
    lookup: title => loadLibrary().byTitle[title],
    record: (title, sid, baseId, chapters) => {
      recordLibrary(title, sid, baseId, chapters);
      t.sid = sid;
      send('task-status', { id: t.id, sid, status: 'running', message: '已保存投稿记录，继续核对提交结果…' });
    },
    checkpoint: checkRunControl, rewrite: deAiRewrite, log,
  });
}

ipcMain.handle('run-tasks', async (_e, { tasks, mode, headless }) => {
  if (busy || revBusy || automationSiteBusy) return { ok: false, error: '已有投稿或收益同步在运行中' };
  if (!['dry', 'submit'].includes(mode) || !Array.isArray(tasks) || !tasks.length) return { ok: false, error: '投稿任务或模式无效' };
  busy = true;
  Object.assign(runControl, { paused: false, abort: false, relaunch: false });
  send('run-status', { running: true, paused: false, browserLost: false });
  const results = [];
  const waitPaused = async () => {
    while (runControl.paused && !runControl.abort) await new Promise(res => setTimeout(res, 500));
  };
  try {
    let r = await getRunner(!!headless);
    await r.ensureLogin({ loginWait: 600, onWait: (sec) => send('login-wait', { secondsLeft: sec }) });
    for (const [ti, t] of tasks.entries()) {
      await waitPaused();
      if (runControl.abort) { log('⏹ 已停止：本任务及剩余任务保持「待投稿」'); break; }
      send('run-progress', { i: ti + 1, total: tasks.length, name: t.name });
      send('task-status', { id: t.id, status: 'running' });
      log(`▶ 开始${mode === 'dry' ? '干跑' : '投稿'}：《${t.name}》`);
      let done = false;
      for (let attempt = 1; attempt <= 2 && !done && !runControl.abort; attempt++) {
        try {
          const result = await runTaskViaApi(r, t, mode);
          for (const m of result.messages ?? []) log(`  ${m}`);
          send('task-status', { id: t.id, status: result.ok ? (result.dryRun ? 'previewed' : 'done') : 'error', message: (result.messages?.join('；') || (result.dryRun ? '干跑完成' : '完成')) });
          results.push({ id: t.id, ok: result.ok !== false, sid: result.sid ?? null, ...result });
          done = true;
        } catch (e) {
          if (e instanceof AbortTaskSignal) {
            send('task-status', { id: t.id, status: 'ready', message: '已停止，已入库内容可在下次继续提交' });
            results.push({ id: t.id, ok: true, canceled: true });
            break;
          }
          if (e instanceof SkipSignal || e.message === '__skip__') {
            runControl.skipCurrent = false;
            log(`⏭ 已跳过：《${t.name}》（保持待投稿）`);
            send('task-status', { id: t.id, status: 'ready', message: '已跳过' });
            results.push({ id: t.id, ok: true, skipped: true });
            done = true;
            break;
          }
          const msg = e.message.split('\n')[0];
          // 浏览器被手动关闭 → 自动暂停，等用户点「重启并继续」后恢复现场重试本任务
          if (attempt === 1 && BROWSER_LOST_RE.test(e.message)) {
            runControl.paused = true;
            runControl.relaunch = true;
            send('task-status', { id: t.id, status: 'queued', message: '浏览器已断开，等待重启' });
            send('run-status', { running: true, paused: true, browserLost: true });
            log(' 检测到浏览器已断开，投稿已自动暂停。点击「 重启并继续」恢复。');
            await waitPaused();
            if (runControl.abort) break;
            if (runControl.relaunch) {
              runControl.relaunch = false;
              log(' 正在重启浏览器并恢复登录…');
              try { await r.close(); } catch { /* 已断开 */ }
              runner = null;
              r = await getRunner(!!headless);
              await r.ensureLogin({ loginWait: 600, onWait: (sec) => send('login-wait', { secondsLeft: sec }) });
              log(' 浏览器已恢复，重试当前任务');
            }
            send('run-status', { running: true, paused: false, browserLost: false });
            continue;   // 重试同一本
          }
          log(` 《${t.name}》失败：${msg}`);
          send('task-status', { id: t.id, status: 'error', message: msg });
          results.push({ id: t.id, ok: false, error: msg });
          done = true;
        }
      }
      if (runControl.abort) { log('⏹ 已停止：本任务及剩余任务保持「待投稿」'); break; }
      // 投稿频率保护：任务之间模拟人工间隔（随机 12-25 秒；无单日上限）
      if (runControl.skipCurrent) runControl.skipCurrent = false;
      if (mode === 'submit' && ti < tasks.length - 1) {
        const sec = 12 + Math.floor(Math.random() * 14);
        log(`⏳ 频率保护：模拟人工间隔 ${sec}s 后继续下一个任务…`);
        for (let w = sec; w > 0; w -= 5) {
          send('task-status', { id: tasks[ti + 1].id, status: 'queued', message: `等待频率保护 ${w}s` });
          await new Promise(res => setTimeout(res, Math.min(5, w) * 1000));
        }
      }
    }
    const okN = results.filter(x => x.ok !== false && !x.skipped && !x.canceled).length;
    const skipN = results.filter(x => x.skipped).length;
    send('run-progress', { done: true, dryRun: mode === 'dry', stopped: runControl.abort, ok: okN, fail: results.filter(x => x.ok === false).length, skip: skipN });
    return { ok: results.every(x => x.ok !== false), results };
  } catch (e) {
    return { ok: false, error: String(e.message || e), results };
  } finally {
    busy = false;
    Object.assign(runControl, { paused: false, abort: false, relaunch: false, skipCurrent: false });
    send('run-status', { running: false, paused: false, browserLost: false });
  }
});

/* ---------------- 收益数据（融合 wawa-stats：每日历史回填 + 统计 + CSV） ---------------- */
// 数据模型（profiles/revenue-history.json v2）：
//   books["<submission_id>"] = { title, baseId, firstDate, lastSyncDay, lastSyncHour, days }
//   days["2026-08-30"] = { r: 当日收益, f: 当日在读(null=该日无在读数据) }
// 站点规则（实测）：数据每天北京时间约 13:30 后更新到「昨日」；日期>=今天的行是占位，需剔除。

const revAccount = () => crypto.createHash('sha256').update(loadCredentials()?.phone||'no-account').digest('hex').slice(0,20);
const revFile = () => userPath('profiles', `revenue-${revAccount()}.json`);
const revCache = () => userPath('profiles', `revenue-summary-${revAccount()}.json`);
const bjNow = () => new Date(Date.now() + 8 * 3600e3).toISOString();
const bjToday = () => bjNow().slice(0, 10);
const bjHour = () => Number(bjNow().slice(11, 13));
const bjMin = () => Number(bjNow().slice(14, 16));
const bjDaysAgo = (n) => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
// 站点数据更新窗口：每天约 13:30 发布昨日数据 → 过了 1:30 期望最新数据日=昨天，没过=前天
const expectedDataDate = () => (bjHour() > 13 || (bjHour() === 13 && bjMin() >= 30)) ? bjDaysAgo(1) : bjDaysAgo(2);
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

function loadRevStore() {
  try {
    const v = JSON.parse(fs.readFileSync(revFile(), 'utf-8'));
    if (v && v.version === 2) return v;
    // v1 旧快照（按日期存当日总额）：备份后从零开始——历史接口能完整回填真实每日数据，比旧快照更全更准
    fs.writeFileSync(userPath('profiles', 'revenue-history.v1.bak'), JSON.stringify(v));
    log('检测到旧版收益存档，已备份为 revenue-history.v1.bak，将用站点历史接口完整回填');
  } catch { /* 无文件 */ }
  return { version: 2, books: {} };
}
function saveRevStore(s) {
  fs.mkdirSync(path.dirname(revFile()), { recursive: true });
  atomicJSON(revFile(), s);
}
const revIgnoredList = () => loadSettings().revIgnored ?? [];

let revBusy = false;
let lastSummary = null;

async function buildRevenueSummary(headless = true, { forceSync = false } = {}) {
  if (revBusy) return { ok: false, error: '收益数据正在采集中，请稍候', busy: true };
  if (busy || automationSiteBusy) return { ok: false, error: '投稿任务运行中，暂不能刷新收益', busy: true };
  revBusy = true;
  try {
    const r = await getRunner(!!headless);
    await r.ensureLogin({ loginWait: 120, onWait: (sec) => send('login-wait', { secondsLeft: sec }) });
    send('rev-status', { text: '已登录 · 正在拉取投稿列表…' });
    const [allSubs,revs] = await Promise.all([r.listSubmissions(),r.listRevenue()]);
    const deletedRevenue=new Set(loadSettings().revenueDeleted?.[revAccount()]||[]);
    const subs=allSubs.filter(s=>(!loadSettings().excludeRejectedRevenue||s.status!=='rejected')&&!deletedRevenue.has(String(s.sid)));
    const currentSids=new Set(subs.map(s=>String(s.sid)));
    const penMap=loadSettings().revenuePenMaps?.[loadCredentials()?.phone||'']||{};
    const revMap = new Map(revs.map(x => [x.id, x]));
    const store = loadRevStore();
    const today = bjToday();

    // ---- 快车道：my_revenue 快照延展每日序列（1 个请求覆盖全部书，几秒）----
    // 数据窗口：每天约 13:30 发布昨日数据；latest.date 已在库中的书直接跳过
    let snapCount = 0, histCount = 0, emptyCount = 0;
    const gapSids = new Set();   // 快车道发现中间断档的书（如隔几天没开软件，latest 跳过了中间天）→ 转历史补拉
    for (const sub of subs) {
      if (sub.sid == null) continue;
      const rev = revMap.get(sub.id);
      const lt = rev?.latestOk ? rev : null;
      if (!lt?.latestDate || lt.latestDate >= today) continue;      // 无数据 / 未来占位
      const prevRec = store.books[sub.sid];
      const days = prevRec?.days ?? {};
      const prevDates = Object.keys(days).sort();
      const prevLast = prevDates[prevDates.length - 1] ?? null;
      if (prevLast && dayDiff(prevLast, lt.latestDate) > 1) gapSids.add(sub.sid);   // 中间断档 → 需补拉
      if (days[lt.latestDate]) continue;                            // 该日已入库 → 秒跳
      days[lt.latestDate] = { r: +Number(lt.latestRev ?? 0).toFixed(2), f: lt.latestReaders == null ? null : lt.latestReaders };
      store.books[sub.sid] = {
        ...prevRec, title: sub.title, baseId: sub.id,
        firstDate: prevRec?.firstDate ?? lt.latestDate,
        lastSyncDay: today, lastSyncHour: bjHour(),
        days,
      };
      snapCount++;
    }

    // ---- 历史接口（重活）：只对 首次见到的书 / 检测到日期缺口的书 / 强制刷新 补拉 ----
    const expected = expectedDataDate();
    const need = subs.filter(x => x.sid != null).filter(x => {
      if (forceSync) return true;
      if (gapSids.has(x.sid)) return true;                          // 快车道发现的中间断档
      const rec = store.books[x.sid];
      if (!rec || !rec.historyComplete) return true;                                        // 从未见过 → 全量历史回填
      const ds = Object.keys(rec.days ?? {}).sort();
      const lastDate = ds[ds.length - 1] ?? null;
      if (!lastDate) {                                              // 空记录（平台暂无数据）：每 3 天复查一次
        return !rec.lastSyncDay || dayDiff(rec.lastSyncDay, today) >= 3;
      }
      // 序列尾部断裂（倒数第二天到最后一天跳了 >1 天）且右端点没查过 → 补拉一次
      // 平台确实没有该天数据的书，补拉后记 gapCheckedThrough，不再重复拉
      const last2 = ds[ds.length - 2] ?? null;
      if (last2 && dayDiff(last2, lastDate) > 1 && lastDate > (rec.gapCheckedThrough ?? '')) return true;
      return lastDate < expected;                                   // 尾部落后于期望数据日 → 补拉
    });
    let errCount = 0, firstErr = '';
    if (need.length) {
      log(`历史补拉：${need.length} 本（新书或存在缺口）…`);
      send('rev-status', { text: `历史补拉 0/${need.length} 本…` });
      const subBySid = new Map(need.map(x => [x.sid, x]));
      const mergeResult = res => {
        if (res.error) { errCount++; if (!firstErr) firstErr = res.error; }
        const sub = subBySid.get(res.sid);
        if (!sub || res.error || !res.data) return;
        const days = {};
        for (const it of res.data.items ?? []) {
          if (!it.ok || !it.date || it.date >= today) return;   // 占位 / 未来行剔除
          days[it.date] = { r: +Number(it.r ?? 0).toFixed(2), f: it.f == null ? null : it.f };
        }
        const dates = Object.keys(days).sort();
        const prevRec = store.books[res.sid];
        if (!dates.length) {
          // 平台仍无该书的历史 → 保留快车道已积累的日期，标记同步时间
          store.books[res.sid] = {
            title: sub.title, baseId: sub.id, historyComplete:true, historyComplete:true,
            firstDate: prevRec?.firstDate ?? null,
            lastSyncDay: today, lastSyncHour: bjHour(),
            days: prevRec?.days ?? {},
          };
          emptyCount++;
          return;
        }
        // 合并：历史为准，但保留快车道先积累、历史里没有的日期（罕见错位兜底）
        const merged = { ...(prevRec?.days ?? {}), ...days };
        const mDates = Object.keys(merged).sort();
        // 补拉后尾部仍有断裂 = 平台确实没有该天数据 → 记录右端点，避免每次刷新重复拉这本书
        const mLast = mDates[mDates.length - 1];
        const mLast2 = mDates[mDates.length - 2] ?? null;
        const gapStill = mLast2 && dayDiff(mLast2, mLast) > 1 ? mLast : null;
        store.books[res.sid] = {
          title: sub.title, baseId: sub.id, historyComplete:true,
          firstDate: mDates[0], lastSyncDay: today, lastSyncHour: bjHour(),
          days: merged,
          ...(gapStill ? { gapCheckedThrough: mLast } : {}),
        };
        histCount++;
      };
      await r.fetchRevenueHistories(need.map(x=>x.sid), {
        concurrency:loadSettings().revenueConcurrency, delayMs:loadSettings().revenueDelayMs,
        onResult:res=>{mergeResult(res);saveRevStore(store);},
        onProgress:(i,total)=>send('rev-status',{text:`历史补拉 ${i}/${total} 本`})
      });
      saveRevStore(store);
      log(`同步完成：快照 ${snapCount} 本 · 历史补拉 ${histCount} 本 · 平台暂无数据 ${emptyCount} 本` +
        (errCount ? ` · 失败 ${errCount} 本（下次刷新自动续传：${firstErr.slice(0, 80)}）` : ''));
    } else {
      if (snapCount) saveRevStore(store);
      log(`快车道同步：快照 ${snapCount} 本，历史无缺口（${need.length} 本需补拉）`);
    }

    // ---- 汇总 ----
    const STATUS_CN = {
      contracted: '已签约', pending_review: '审核中', reviewing: '审核中',
      approved: '已通过', rejected: '已退稿', draft: '草稿', online: '已上架', finished: '已完结',
    };
    const ignored = new Set(revIgnoredList());
    const allDates = new Set();
    for (const b of Object.entries(store.books).filter(([sid])=>currentSids.has(String(sid))).map(([,book])=>book)) Object.keys(b.days).forEach(d => allDates.add(d));
    const dates = [...allDates].sort();
    const latestDate = dates[dates.length - 1] ?? null;
    const prevOf = {}; // 每本书每个日期的前一个数据日（算在读变化用）
    for (const b of Object.entries(store.books).filter(([sid])=>currentSids.has(String(sid))).map(([,book])=>book)) {
      const ds = Object.keys(b.days).sort();
      for (let i = 0; i < ds.length; i++) prevOf[`${b.baseId}|${ds[i]}`] = ds[i - 1] ?? null;
    }

    // 全账户每日序列：当日收益 / 累计 / 在读 / 在读纯增 / 在读下降（增减不互相抵消）
    const series = [];
    let cum = 0;
    for (const d of dates) {
      let rev = 0, readers = 0, up = 0, down = 0;
      for (const b of Object.entries(store.books).filter(([sid])=>currentSids.has(String(sid))).map(([,book])=>book)) {
        const it = b.days[d];
        if (!it) continue;
        rev += it.r;
        if (it.f != null) {
          readers += it.f;
          const pd = prevOf[`${b.baseId}|${d}`];
          const pf = pd ? b.days[pd]?.f : null;
          if (pf != null) { const df = it.f - pf; if (df > 0) up += df; else down += df; }
        }
      }
      cum = +(cum + rev).toFixed(2);
      series.push({ date: d, rev: +rev.toFixed(2), total: cum, readers, up, down });
    }

    const books = subs.map(s => {
      const rev = revMap.get(s.id) ?? { total: 0 };
      // 在读取历史最新真实值（my_revenue.latest 今天是占位 null，不可靠）
      const rec = store.books[s.sid];
      let follows = null, fDelta = null, dayRev = null, firstDate = null;
      if (rec) {
        firstDate = rec.firstDate ?? null;
        const ds = Object.keys(rec.days).sort();
        if (ds.length) {
          const ld = ds[ds.length - 1], lv = rec.days[ld];
          dayRev = ld === latestDate ? lv.r : null;
          follows = lv.f;
          const pd = prevOf[`${rec.baseId}|${ld}`];
          const pf = pd ? rec.days[pd]?.f : null;
          if (pd && pf != null && lv.f != null && ld === latestDate) fDelta = lv.f - pf;
        }
      }
      return {
        sid: s.sid, id: s.id, title: s.title, penName:resolvePen(s,getAutomation().store.state.jobs,penMap),
        status: STATUS_CN[s.status] ?? s.status ?? '未知',
        channel: s.channel ?? '—',
        type: s.storyType === 'long' ? '长篇' : '短篇',
        cat: s.cat?.length ? s.cat : ['未分类'],
        words: s.words ?? 0,
        total: rev.total ?? 0, dayRev, follows, fDelta, firstDate,
        hasData: !!(rec && Object.keys(rec.days).length),
        ignored: ignored.has(s.sid),
        week: rec ? (() => {
          const ds = Object.keys(rec.days).sort();
          if (!ds.length) return null;
          const sum = (arr) => arr.reduce((t, d) => t + rec.days[d].r, 0);
          const last = ds.slice(-7), prev = ds.slice(-14, -7);
          return { sum: +sum(last).toFixed(2), prev: +sum(prev).toFixed(2) };
        })() : null,
        // 近 30 天每日序列（单书收益展开用）
        daily: rec ? (() => {
          const ds = Object.keys(rec.days).sort();
          return ds.map((d, ix) => {
            const it = rec.days[d];
            const pd = ds[ix - 1];
            const pf = pd ? rec.days[pd]?.f : null;
            return { date: d, r: it.r, f: it.f, fd: (it.f != null && pf != null) ? it.f - pf : null };
          });
        })() : [],
      };
    });

    const sum = (arr, key) => arr.reduce((s, x) => s + (Number(x[key]) || 0), 0);
    const active = books.filter(b => b.hasData);
    const groupBy = (keyFn) => {
      const g = {};
      for (const b of books) {
        const k = keyFn(b) ?? '—';
        (g[k] ??= { count: 0, total: 0, follows: 0, dayRev: 0 }).count++;
        g[k].total += b.total;
        g[k].follows += b.follows ?? 0;
        g[k].dayRev += b.dayRev ?? 0;
      }
      for (const k of Object.keys(g)) {
        g[k].total = +g[k].total.toFixed(2);
        g[k].dayRev = +g[k].dayRev.toFixed(2);
      }
      return g;
    };
    // 近 7 日对比 + 月度统计
    const last7 = series.slice(-7);
    const prev7 = series.slice(-14, -7);
    const last7Total = +sum(last7, 'rev').toFixed(2);
    const prev7Total = +sum(prev7, 'rev').toFixed(2);
    const monthly = [];
    for (const p of series) {
      const m = p.date.slice(0, 7);
      const cur = monthly.find(x => x.month === m);
      if (cur) { cur.rev = +(cur.rev + p.rev).toFixed(2); cur.endReaders = p.readers; }
      else monthly.push({ month: m, rev: p.rev, endReaders: p.readers });
    }

    const latest = series[series.length - 1] ?? null;
    const summary = {
      ok: true,
      latestDate, fetchedAt: new Date().toISOString(), syncedCount: snapCount + histCount,
      totalRevenue: +sum(books, 'total').toFixed(2),
      yesterdayDelta: latest ? latest.rev : null,      // 最新数据日的当日收益
      baseDate: dates[dates.length - 2] ?? null,
      newBookCount: books.filter(b => b.firstDate && b.firstDate === latestDate).length || null,
      totalBooks: books.length,
      signedCount: books.filter(b => b.status === '已签约').length,
      totalFollows: sum(active, 'follows'),
      readerUp: latest ? latest.up : 0,
      readerDown: latest ? latest.down : 0,
      byPenName: groupBy(b => b.penName),
      byChannel: groupBy(b => b.channel),
      byType: groupBy(b => b.type),
      byStatus: groupBy(b => b.status),
      byCat: groupBy(b => b.cat[0]),
      series, last7, last7Total, prev7Total, monthly,
      books: books.sort((a, b) => (a.ignored - b.ignored) || (b.total - a.total)),
    };
    lastSummary = summary;
    atomicJSON(revCache(),summary);
    send('rev-status', { text: '' });   // 收尾：隐藏加载条
    return summary;
  } catch (e) {
    send('rev-status', { text: '' });
    return { ok: false, error: String(e.message || e) };
  } finally {
    revBusy = false;
  }
}

ipcMain.handle('delete-revenue',(_e,{ids})=>{
  try {
    if(revBusy)throw new Error('收益正在同步，请等待同步结束');
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>!/^\d+$/.test(String(id))))throw new Error('请选择有效收益记录');
    const key=revAccount(),settings=loadSettings(),deleted=settings.revenueDeleted||{};
    deleted[key]=[...new Set([...(deleted[key]||[]),...ids.map(String)])];saveSettings({revenueDeleted:deleted});
    const store=loadRevStore();for(const id of ids)delete store.books[id];saveRevStore(store);
    if(fs.existsSync(revCache()))fs.unlinkSync(revCache());lastSummary=null;
    return {ok:true};
  }catch(e){return {ok:false,error:e.message};}
});
ipcMain.handle('revenue-cache',()=>{try{return JSON.parse(fs.readFileSync(revCache(),'utf8'));}catch{return null;}});

ipcMain.handle('revenue-summary', (_e, { headless = true, forceSync = false } = {}) =>
  buildRevenueSummary(!!headless, { forceSync }));

// 忽略/取消忽略一本书（仍计入统计，只是列表沉底）
ipcMain.handle('toggle-rev-ignore', (_e, { sid }) => {
  const cur = new Set(revIgnoredList());
  cur.has(sid) ? cur.delete(sid) : cur.add(sid);
  saveSettings({ revIgnored: [...cur] });
  if (lastSummary) {
    const on = cur.has(sid);
    for (const b of lastSummary.books) if (b.sid === sid) b.ignored = on;
    lastSummary.books.sort((a, b) => (a.ignored - b.ignored) || (b.total - a.total));
  }
  return { ok: true, ignored: [...cur] };
});

// 导出 CSV（每日汇总 + 单书明细），带 BOM 方便 Excel 直接打开中文
ipcMain.handle('export-revenue-csv', async () => {
  try {
    const s = fs.existsSync(revCache()) ? JSON.parse(fs.readFileSync(revCache(),'utf8')) : await buildRevenueSummary(true);
    if (!s.ok) return s;
    const esc = (v) => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [];
    lines.push('== 每日汇总 ==');
    lines.push('日期,当日收益,累计收益,在读总数,在读纯增,在读下降');
    for (const p of s.series) lines.push([p.date, p.rev.toFixed(2), p.total.toFixed(2), p.readers, p.up, p.down].map(esc).join(','));
    lines.push('');
    lines.push('== 单书明细 ==');
    lines.push('书名,笔名,平台作品ID,状态,频道,篇幅,一级类目,字数,累计收益,最新日收益,最新在读,在读变化,首个数据日');
    for (const b of s.books) {
      lines.push([b.title, b.penName, b.sid, b.status, b.channel, b.type, b.cat[0], b.words,
        b.total.toFixed(2), b.dayRev == null ? '' : b.dayRev.toFixed(2),
        b.follows == null ? '' : b.follows, b.fDelta == null ? '' : b.fDelta,
        b.firstDate ?? ''].map(esc).join(','));
    }
    const dlg = await dialog.showSaveDialog(win, {
      title: '导出收益明细 CSV',
      defaultPath: path.join(os.homedir(), 'Desktop', `蛙蛙收益明细_${bjToday().replaceAll('-', '')}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (dlg.canceled || !dlg.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(dlg.filePath, '\ufeff' + lines.join('\r\n'), 'utf-8');
    log(` 已导出 CSV：${dlg.filePath}`);
    return { ok: true, path: dlg.filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});


// AI 配置测试连接（文本=极短消息；图像=最小测试图）
ipcMain.handle('test-ai', async (_e, { kind, config }) => {
  try {
    const settings = config ? (kind === 'image'
      ? { imgApiBaseUrl: config.baseUrl?.trim(), imgApiKey: config.apiKey?.trim(), imageModel: config.model?.replace(/（.*）/, '').trim() }
      : { apiBaseUrl: config.baseUrl?.trim(), apiKey: config.apiKey?.trim(), textModel: config.model?.replace(/（.*）/, '').trim() }) : loadSettings();
    if (kind === 'text') {
      if (!settings.apiBaseUrl || !settings.apiKey || !settings.textModel) return { ok: false, error: '文本AI未配置完整（地址 / Key / 模型名）' };
      const out = await aiPing(settings);
      return { ok: true, message: `连通正常，模型回复「${out}」` };
    }
    if (kind === 'image') {
      if (!settings.imgApiBaseUrl || !settings.imgApiKey || !settings.imageModel) return { ok: false, error: '图像AI未配置完整（地址 / Key / 模型名）' };
      await imageAiPing(settings);
      return { ok: true, message: '连通正常（图像接口已返回测试图片）' };
    }
    return { ok: false, error: '未知类型' };
  } catch (e) { return { ok: false, error: String(e.message || e).split('\n')[0] }; }
});

// 检查更新：settings.updateUrl 指向一个 JSON {"version":"x.y.z","note":"...","url":"下载页"}；留空=不检查
ipcMain.handle('check-update', async () => {
  try {
    const u = loadSettings().updateUrl;
    if (!u) return { ok: false, error: '未配置更新地址' };
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const info = await r.json();
    const cur = app.getVersion();
    const newer = String(info.version || '').split('.').map(Number);
    const old = cur.split('.').map(Number);
    const isNewer = newer.some((v, i) => v > (old[i] || 0)) && newer.length === 3;
    return { ok: true, current: cur, latest: info.version || '', note: info.note || '', url: info.url || '', isNewer };
  } catch (e) { return { ok: false, error: String(e.message || e).split('\n')[0] }; }
});

// 完成通知：任务栏闪烁（无声音）
  ipcMain.handle('notify-done', () => { try { if (win) { if (win.isMinimized()) win.restore(); win.flashFrame(true); } } catch { /* ignore */ } return { ok: true }; });
  // 无边框窗口控制：最小化 / 最大化切换 / 关闭
  ipcMain.handle('win-control', (_e, { action }) => {
    if (!win) return { ok: false };
    try {
      if (action === 'min') win.minimize();
      else if (action === 'max') { win.isMaximized() ? win.unmaximize() : win.maximize(); }
      else if (action === 'close') win.close();
      else return { ok: false, error: '未知操作' };
      return { ok: true, maximized: win.isMaximized() };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

app.whenReady().then(async () => {
  attachStudio({app,ipcMain,dialog,root:__dirname,userPath,getAutomation,loadSettings,saveSettings,send,loadCredentials});
  const reviewTimer=setInterval(()=>{
    if(!automation || automation.store.state.paused)return;
    const minutes=Math.max(2,Math.min(1440,Number(loadSettings().reviewPollMinutes)||10));
    if(Date.now()-Date.parse(automation.store.state.lastReviewAttempt||'1970-01-01')>=minutes*60000)automation.syncReviews().catch(e=>log('审核同步失败：'+e.message));
  },60000);
  reviewTimer.unref();
  createWindow();
  // --selfie 自检：加载后截图存证并退出
  if (process.argv.includes('--selfie')) {
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await new Promise(r => setTimeout(r, 2000));
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const dom = await win.webContents.executeJavaScript(`(() => {
      const nav = document.querySelector('aside.sidebar');
      const tabs = [...document.querySelectorAll('.page-tab')].map(b => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const nr = nav ? nav.getBoundingClientRect() : 0;
      // 持久化恢复断言：tasks.json 里的任务应已渲染到列表
      const restored = [...document.querySelectorAll('#tasks .task .name')].map(e => e.textContent.trim());
      // 收益页滚动断言：切到收益页塞入超长内容，检查容器可滚
      document.querySelector('.page-tab[data-page=revenue]').click();
      const body = document.getElementById('rev-body');
      body.innerHTML = '<div style="height:3000px">x</div>';
      const canScroll = body.scrollHeight > body.clientHeight + 100;
      body.scrollTop = 400;
      const scrolled = body.scrollTop > 100;
      body.innerHTML = '<div class="empty">测试内容已还原</div>';
      document.querySelector('.page-tab[data-page=tasks]').click();
      // 收益页 mock 截图：塞入示例 KPI/表格验证样式
      document.querySelector('.page-tab[data-page=revenue]').click();
      body.innerHTML = '<div class="kpi-grid" style="margin-bottom:14px">' +
        ['累计收益|¥894.40|var(--primary-dark)|数据日 2026-09-07', '最新日收益|+14.34|var(--primary-dark)|每天约 13:30 更新前一日',
         '在读总数|15489||最新日 <span class=kpi-up>▲ +515</span> · <span class=kpi-down>▼ 100</span>',
         '作品数|111||已签约 101', '近 7 日收益|¥253.77||前7日 ¥334.85 · <span class=kpi-down>▼ 25%</span>']
        .map(x => { const [l, v, c, sub] = x.split('|'); return '<div class=kpi-card><div class=kpi-label>' + l + '</div><div class=kpi-value style=' + (c ? 'color:' + c : '') + '>' + v + '</div><div class=kpi-sub>' + sub + '</div></div>'; }).join('') +
        '</div>' +
        '<table><tr><th>书名</th><th>状态</th><th style="text-align:right">累计收益</th></tr>' +
        '<tr><td>离婚后，我骑着外卖车闯出一条生路</td><td><span class="pill ok">已签约</span></td><td style="text-align:right;color:var(--primary-dark);font-weight:700">¥311.04</td></tr>' +
        '<tr><td>我在修仙界开殡仪馆，专收大能</td><td><span class="pill ok">已签约</span></td><td style="text-align:right;color:var(--primary-dark);font-weight:700">¥72.38</td></tr></table>';
      return { navFound: !!nav, navH: nr ? Math.round(nr.height) : 0,
               tabs, restored,
               revScroll: { canScroll, scrolled },
               toolbar: [...document.querySelectorAll('.toolbar .btn, .toolbar .checkbox-row')].map(b => b.textContent.trim().slice(0, 16)) };
    })()`);
    console.log('SELFIE_DOM=' + JSON.stringify(dom));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUTPUT_DIR, 'app-selfie.png'), img.toPNG());
    const size = win.getContentSize();
    const top = await win.webContents.capturePage({ x: 0, y: 0, width: size[0], height: Math.min(210, size[1]) });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'app-selfie-top.png'), top.toPNG());
    console.log('SELFIE_OK output/app-selfie.png + app-selfie-top.png');
    app.quit();
  }
  // --test-api 自检：对真实文件跑一遍干跑（不创建不提交，无网络写入）
  if (process.argv.includes('--test-api')) {
    const dir = 'C:\\Users\\14098\\Desktop\\小';
    const files = fs.readdirSync(dir).filter(f => /\.txt$/i.test(f));
    if (!files.length) { console.log('API_DRY=NO_TEST_FILE'); app.quit(); }
    const file = path.join(dir, files[0]);
    const parsed = await parseNovelFile(file);
    const r = await getRunner(true);
    await r.ensureLogin({ loginWait: 60 });
    const cfg = normalizeConfig({
      作品名称: parsed.title, 笔名: '龙利鱼', 作品频道: '女频', 作品分类: '长篇', 作品状态: '连载中',
      小说类目: ['女频', '脑洞', '穿越奇遇'], 作品标签: ['脑洞', '爽文'], 本地文件: file,
      作品简介: '自检', 投稿入口: '普通投稿', 封面: null,
    });
    let out;
    try {
      out = await runTaskViaApi(r, { id: 't', name: '自检', cfg, range: { mode: 'custom', from: 1, to: 10 } }, 'dry');
    } catch (e) { out = { ok: false, error: e.message }; }
    console.log('API_DRY_RANGE=' + JSON.stringify(out));
    await r.close();
    app.quit();
  }
  // --test-rev 自检：跑一遍收益汇总（含历史回填 + 每日对比）并打印结果
  if (process.argv.includes('--test-rev')) {
    const r = await buildRevenueSummary(true);
    console.log('REV_TEST=' + JSON.stringify({
      ok: r.ok, error: r.error,
      total: r.totalRevenue, latestDate: r.latestDate, dayDelta: r.yesterdayDelta,
      synced: r.syncedCount ?? 0, books: r.totalBooks, signed: r.signedCount, follows: r.totalFollows,
      up: r.readerUp, down: r.readerDown,
      seriesDays: (r.series ?? []).length,
      seriesHead: (r.series ?? []).slice(0, 2), seriesTail: (r.series ?? []).slice(-2),
      last7Total: r.last7Total, prev7Total: r.prev7Total,
      monthly: r.monthly,
      topDayRev: (r.books || []).filter(b => (b.dayRev ?? 0) > 0).slice(0, 3)
        .map(b => ({ t: b.title.slice(0, 12), day: b.dayRev, total: b.total, f: b.follows, fd: b.fDelta, first: b.firstDate })),
    }));
    app.quit();
  }
});
app.on('window-all-closed', () => { if (runner) runner.close().catch(() => {}); app.quit(); });

