import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { runSubmission, selectRange } from '../submission-engine.mjs';
import { normalizeConfig } from '../core.mjs';
import { archiveManuscript } from '../automation-store.mjs';
import { readNovelChapters, extractChaptersFromText, parseNovelFile } from '../auto.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'main.mjs'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
const auto = fs.readFileSync(path.join(root, 'auto.mjs'), 'utf8');
const chapters = n => Array.from({ length: n }, (_, i) => ({ name: `第${i + 1}章`, text: `故事正文测试，这是第${i + 1}章完整的正文内容，保证不会被当成空白章节。` }));
const cfg = { 作品名称: '测试作品', 本地文件: 'virtual.txt', 笔名: '测试笔名', 封面: 'https://example.invalid/cover.png',
  作品分类: '长篇', 作品频道: '男频', 作品状态: '已完结', 小说类目: ['男频', '都市', '都市生活'] };
const task = (extra = {}) => ({ id: 'test', cfg: { ...cfg }, range: { mode: 'all' }, ...extra });
const struct = (n, submitted = []) => chapters(n).map((c, i) => ({ ...c, node_id: i + 101, is_submitted: submitted.includes(i + 1), is_locked: false }));

function fixture({ localN = 10, storedN = 0, submitted = [], status = 'reviewing', siteOnly = false } = {}) {
  let structure = struct(storedN, submitted);
  let subs = storedN && !siteOnly ? [{ id: 7, sid: 9, title: cfg.作品名称, status }] : [];
  const calls = [], records = [];
  const runner = {
    listSubmissions: async () => subs,
    listSiteWorks: async () => [{ id: 7, title: cfg.作品名称 }],
    apiStructure: async () => structure,
    apiLabelMap: async () => new Map(),
    apiUpload: async () => { calls.push(['upload']); return 'https://example.invalid/cover'; },
    apiCreateFromFile: async payload => { calls.push(['file', payload]); structure = struct(payload.chapters.length); return { submission_id: 9, base_novel_id: 7 }; },
    apiCreateFromNovel: async payload => { calls.push(['novel', payload]); return { submission_id: 9, base_novel_id: 7 }; },
    apiUpdateCreateFile: async (sid, file) => {
      const additions = extractChaptersFromText(fs.readFileSync(file, 'utf8'));
      calls.push(['append', additions]);
      structure.push(...additions.map((c, i) => ({ ...c, node_id: 101 + structure.length + i, is_submitted: false, is_locked: false })));
    },
    apiSubmitSubmission: async (sid, ids) => { calls.push(['submit', ids]); return { success_count: ids.length }; },
    apiSubmitChapters: async (sid, ids) => { calls.push(['update', ids]); return { success_count: ids.length }; },
  };
  const hooks = { preflight: () => [], readChapters: async () => chapters(localN), record: (...args) => records.push(args), aiAvailable: () => false };
  return { runner, hooks, calls, records, get structure() { return structure; }, setSubs: value => { subs = value; } };
}

test('all renderer methods and IPC handlers exist', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  const methods = new Set([...preload.matchAll(/^\s+(\w+):/gm)].map(m => m[1]));
  const allMain=main+'\n'+fs.readFileSync(path.join(root,'studio-main.mjs'),'utf8');
  const handlers = new Set([...allMain.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]));
  for (const m of ui.matchAll(/\b(?:backend|api)\.(\w+)/g)) assert.ok(methods.has(m[1]), m[1]);
  for (const m of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) assert.ok(handlers.has(m[1]), m[1]);
});

test('DOCX import and submission use the same decoded chapters', async () => {
  const file = path.join(root, 'tests/fixtures/two-chapters.docx');
  const parsed = await parseNovelFile(file);
  const decoded = await readNovelChapters(file);
  assert.equal(parsed.chapters, 2);
  assert.equal(decoded.length, 2);
  assert.ok(decoded.every(c => c.text.includes('故事正文测试')));
  const f = fixture();
  await runSubmission(f.runner, task({ cfg: { ...cfg, 本地文件: file } }), 'submit', { ...f.hooks, readChapters: readNovelChapters });
  assert.deepEqual(f.calls.find(c => c[0] === 'file')[1].chapters, decoded);
});

test('single chapter headings are preserved', () => {
  assert.equal(extractChaptersFromText('第一章 开始\n故事正文测试，这是一篇只有一个章节的小说。')[0].name, '第一章 开始');
});

test('dry run performs no remote writes and validates range', async () => {
  const f = fixture();
  const result = await runSubmission(f.runner, task(), 'dry', f.hooks);
  assert.equal(result.dryRun, true);
  assert.deepEqual(f.calls, []);
  await assert.rejects(runSubmission(f.runner, task({ range: { mode: 'custom', from: 1, to: 99 } }), 'dry', f.hooks), /章节范围无效/);
});

test('new book uploads all chapters but submits only one selected chapter', async () => {
  const f = fixture();
  await runSubmission(f.runner, task({ range: { mode: 'custom', from: 3, to: 3 } }), 'submit', f.hooks);
  assert.equal(f.calls[0][1].chapters.length, 10);
  assert.equal(f.calls[0][1].is_finished, false);
  assert.deepEqual(f.calls.at(-1), ['submit', [103]]);
});

test('site-only task creates from selected novel ID using current site schema', async () => {
  const f = fixture({ storedN: 10, siteOnly: true });
  await runSubmission(f.runner, task({ cfg: { ...cfg, 本地文件: '', 作品ID: 7, 作品标题: cfg.作品名称 },
    range: { mode: 'custom', from: 2, to: 3 } }), 'submit', f.hooks);
  const payload = f.calls[0][1];
  assert.equal(f.calls[0][0], 'novel');
  assert.equal(payload.base_novel_id, 7);
  assert.equal(payload.title, cfg.作品名称);
  assert.deepEqual(payload.chapter_ids, [102, 103]);
  assert.deepEqual(f.calls.at(-1), ['submit', [102, 103]]);
});

test('legacy site-only task resolves source title without reading an empty file', async () => {
  const f = fixture({ storedN: 10, siteOnly: true });
  const result = await runSubmission(f.runner, task({ cfg: { ...cfg, 本地文件: '', 作品标题: cfg.作品名称 } }), 'dry', f.hooks);
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 0);
});

test('existing site-only task submits available selected chapters', async () => {
  const f = fixture({ storedN: 10, submitted: [1, 2] });
  await runSubmission(f.runner, task({ cfg: { ...cfg, 本地文件: '', 作品ID: 7 }, range: { mode: 'custom', from: 3, to: 3 } }), 'submit', f.hooks);
  assert.deepEqual(f.calls, [['update', [103]]]);
});

test('partially submitted book reuses library chapters and honors range', async () => {
  const f = fixture({ storedN: 10, submitted: [1, 2, 3] });
  await runSubmission(f.runner, task({ range: { mode: 'custom', from: 4, to: 5 } }), 'submit', f.hooks);
  assert.deepEqual(f.calls, [['update', [104, 105]]]);
});

test('exactly one appended chapter is uploaded and submitted', async () => {
  const f = fixture({ localN: 11, storedN: 10, submitted: Array.from({ length: 10 }, (_, i) => i + 1) });
  await runSubmission(f.runner, task(), 'submit', f.hooks);
  assert.equal(f.calls[0][0], 'append');
  assert.deepEqual(f.calls[0][1].map(c => c.name), ['第11章']);
  assert.deepEqual(f.calls.at(-1), ['update', [111]]);
});

test('noncontiguous submitted chapters do not shift the local offset', async () => {
  const f = fixture({ localN: 3, storedN: 3, submitted: [1, 3] });
  await runSubmission(f.runner, task(), 'submit', f.hooks);
  assert.deepEqual(f.calls, [['update', [102]]]);
});

test('all submitted and locked ranges never send an empty chapter list', async () => {
  const f = fixture({ localN: 2, storedN: 2, submitted: [1] });
  f.structure[1].is_locked = true;
  const result = await runSubmission(f.runner, task(), 'submit', f.hooks);
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls, []);
});

test('renamed task updates its saved submission ID', async () => {
  const f = fixture({ localN: 2, storedN: 2, submitted: [1] });
  await runSubmission(f.runner, task({ sid: 9, cfg: { ...cfg, 作品名称: '已改名' } }), 'submit', f.hooks);
  assert.deepEqual(f.calls, [['update', [102]]]);
});

test('missing saved submission ID refuses to create a duplicate', async () => {
  const f = fixture();
  await assert.rejects(runSubmission(f.runner, task({ sid: 99 }), 'submit', f.hooks), /找不到/);
  assert.deepEqual(f.calls, []);
});

test('draft submission retry reuses existing library without reuploading', async () => {
  const f = fixture({ localN: 2, storedN: 2, status: 'draft' });
  await runSubmission(f.runner, task(), 'submit', f.hooks);
  assert.deepEqual(f.calls, [['submit', [101, 102]]]);
});

test('new draft identity is saved even when submission fails', async () => {
  const f = fixture();
  f.runner.apiSubmitSubmission = async () => { throw new Error('network failed'); };
  await assert.rejects(runSubmission(f.runner, task(), 'submit', f.hooks), /network failed/);
  assert.deepEqual(f.records[0], [cfg.作品名称, 9, 7, 10]);
});

test('out of bounds update range fails before writes', async () => {
  const f = fixture({ storedN: 10 });
  await assert.rejects(runSubmission(f.runner, task({ range: { mode: 'custom', from: 10, to: 11 } }), 'submit', f.hooks), /章节范围无效/);
  assert.deepEqual(f.calls, []);
});

test('cancel after creating draft prevents submission', async () => {
  const f = fixture();
  await assert.rejects(runSubmission(f.runner, task(), 'submit', { ...f.hooks,
    checkpoint: async () => { if (f.records.length) throw new Error('cancelled'); } }), /cancelled/);
  assert.equal(f.calls.some(c => c[0] === 'submit'), false);
});

test('range validates integer input and permits single chapter', () => {
  assert.deepEqual(selectRange({ mode: 'custom', from: 2, to: 2 }, 3), { from: 2, to: 2 });
  assert.throws(() => selectRange({ mode: 'custom', from: 1.5, to: 2 }, 3));
});

test('run IPC emits previewed status so preview remains eligible for submission', async () => {
  let handler;
  const events = [];
  const context = vm.createContext({ ipcMain: { handle: (_n, fn) => { handler = fn; } }, busy: false, revBusy: false, automationSiteBusy: false,
    runControl: {}, send: (name, data) => events.push({ name, ...data }), log: () => {},
    getRunner: async () => ({ ensureLogin: async () => {} }),
    runTaskViaApi: async () => ({ ok: true, dryRun: true, messages: [] }), setTimeout });
  const start = main.indexOf("ipcMain.handle('run-tasks'");
  vm.runInContext(main.slice(start, main.indexOf('/* ---------------- 收益数据', start)), context);
  await handler(null, { tasks: [task()], mode: 'dry', headless: true });
  const status = events.filter(e => e.name === 'task-status').at(-1).status;
  assert.equal(status, 'previewed');
  assert.ok([{ status }].filter(t => t.status !== 'done').length);
  assert.equal(events.find(e => e.name === 'run-progress' && e.done).dryRun, true);
});

test('UI sends sid and announces start before awaiting the backend', async () => {
  let payload;
  const order = [];
  const context = vm.createContext({ runState: { active: false }, IN_MOCK: false, renderRunState: () => {},
    $: s => ({ checked: s === '#runHeadless' }), confirm: () => true, lastRunMeta: {}, taskTitle: t => t.cfg.作品名称,
    backend: { runTasks: async p => { payload = p; order.push('completed'); return { ok: true, results: [] }; } },
    toast: s => order.push(s), addLog: () => {}, applyRunResults: () => {} });
  vm.runInContext(ui.slice(ui.indexOf('async function runTaskList('), ui.indexOf('function applyRunResults(')), context);
  await context.runTaskList([task({ sid: 9 })]);
  assert.equal(payload[0].sid, 9);
  assert.ok(order[0].includes('已启动'));
  assert.equal(order.at(-1), 'completed');
});

function generationHandler(overrides = {}) {
  let handler;
  const context = vm.createContext({ ipcMain: { handle: (_n, fn) => { handler = fn; } }, normalizeConfig,
    fs: { existsSync: () => true }, parseNovelFile: async () => ({ text: '正文'.repeat(300), body: '正文'.repeat(300) }),
    aiConfigured: () => true, aiTitles: async () => ['书名一', '书名二', '书名三'], aiIntro: async () => '简介', log: () => {}, ...overrides });
  const start = main.indexOf("ipcMain.handle('gen-candidates'");
  vm.runInContext(main.slice(start, main.indexOf('// 封面生成统一管线', start)), context);
  return handler;
}

test('candidate count and supplemental requirements reach the generation engine', async () => {
  const calls = [];
  const handler = generationHandler({ aiTitles: async (_text, options) => { calls.push(options); return ['一', '二', '三']; },
    aiIntro: async (_text, _title, options) => { calls.push(options); return '简介'; } });
  const titles = await handler(null, { cfg, field: 'title', count: 2, prompt: '必须带系统' });
  assert.equal(titles.items.length, 2);
  assert.equal(calls[0].extra, '必须带系统');
  assert.equal(calls[0].count, 2);
  const intros = await handler(null, { cfg, field: 'intro', count: 5, prompt: '200字内' });
  assert.equal(intros.items.length, 5);
  assert.equal(calls[1].extra, '200字内');
});

test('cover backend rejection is returned as an IPC error result', async () => {
  const handler = generationHandler({ genCoverCandidates: async () => { throw new Error('unsupported image size'); } });
  const result = await handler(null, { cfg, field: 'cover', options: { size: '1280x720' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported image size/);
});

test('title and intro UI pass supplemental requirements; prompt uses options.extra', async () => {
  for (const type of ['title', 'intro', 'prompt']) {
    let handler, args;
    const elements = { '#gTask': { value: 'test' }, '#gType': { value: type }, '#gExtra': { value: '必须满足我的要求' },
      '#btnGenText': { addEventListener: (_e, fn) => { handler = fn; } }, '#genMeta': {}, '#genList': {} };
    const context = vm.createContext({ $: s => elements[s], tasks: [task()], genCount: 5,
      backend: { genCandidates: async (...a) => { args = a; return { ok: true, items: ['候选'], prompt: '提示词', source: 'ai' }; } },
      candSkeleton: () => '', performance, genItems: [], esc: s => s, taskTitle: () => '测试',
      GEN_FIELDS: {}, addLog: () => {}, toast: () => {}, addError: () => {} });
    const start = ui.indexOf("$('#btnGenText').addEventListener");
    vm.runInContext(ui.slice(start, ui.indexOf("$('#genList').addEventListener", start)), context);
    await handler();
    assert.equal(type === 'prompt' ? args[4].extra : args[3], elements['#gExtra'].value);
    if (type !== 'prompt') assert.equal(args[2], 5);
  }
});

test('chosen cover size is sent in the actual HTTP request', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawa-cover-test-'));
  let request;
  try {
    const context = vm.createContext({ fs, Buffer, AbortSignal,
      loadSettings: () => ({ imgApiBaseUrl: 'https://example.invalid', imgApiKey: 'test', imageModel: 'test-image' }),
      userPath: (...parts) => path.join(tempDir, ...parts),
      fetch: async (_url, init) => { request = JSON.parse(init.body); return { ok: true, json: async () => ({ data: [{ b64_json: 'dGVzdA==' }] }) }; } });
    vm.runInContext(main.slice(main.indexOf('async function aiCoverPrompt('), main.indexOf("ipcMain.handle('refresh-panel'")), context);
    await context.aiCoverPrompt('画面描述', '测试', '1280x720');
    assert.equal(request.size, '1280x720');
    await context.aiCoverPrompt('默认封面', '测试');
    assert.equal(request.size, '1024x1536');
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('model test uses selected unsaved config without changing global settings', async () => {
  let handler, received;
  const context = vm.createContext({ ipcMain: { handle: (_n, fn) => { handler = fn; } },
    loadSettings: () => { throw new Error('must use selected configuration'); },
    aiPing: async s => { received = s; return '正常'; }, imageAiPing: async s => { received = s; } });
  const start = main.indexOf("ipcMain.handle('test-ai'");
  vm.runInContext(main.slice(start, main.indexOf('// 检查更新', start)), context);
  const config = { baseUrl: 'https://example.invalid', apiKey: 'test-only', model: 'chosen-model' };
  assert.equal((await handler(null, { kind: 'text', config })).ok, true);
  assert.equal(received.textModel, 'chosen-model');
  assert.equal((await handler(null, { kind: 'image', config })).ok, true);
  assert.equal(received.imageModel, 'chosen-model');
});

test('AI request includes count, instructions and explicit test model', async () => {
  const requests = [];
  const context = vm.createContext({ fs, path, RES_DIR: root, userPath: (...p) => path.join(root, ...p), AbortSignal, TextDecoder,
    loadSettings: () => ({ apiBaseUrl: 'https://example.invalid', apiKey: 'test', textModel: 'default' }),
    fetch: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return { ok: true,
      json: async () => ({ choices: [{ message: { content: body.response_format ? '{"titles":["测试系统书名之一","测试系统书名之二"]}' : '正常' } }] }) }; } });
  const source = auto.replace(/^import .*;\r?$/gm, '').replace(/export \{[^}]+\};/g, '')
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|const))/g, '');
  vm.runInContext(source, context);
  await context.aiTitles('正文', { channel: '男频', count: 2, extra: '必须带系统' });
  assert.match(requests[0].messages[1].content, /起 2 个/);
  assert.match(requests[0].messages[1].content, /必须带系统/);
  await context.aiPing({ apiBaseUrl: 'https://example.invalid', apiKey: 'test', textModel: 'selected-model' });
  assert.equal(requests[1].model, 'selected-model');
});

test('cover UI forwards selected horizontal size through the preload contract', async () => {
  let handler, args;
  const elements = {
    '#cTitle': { value: '测试作品' }, '#cAuthor': { value: '作者' }, '#cDesc': { value: '画面' }, '#cSize': { value: '1280x720' },
    '#btnGenCover': { addEventListener: (_e, fn) => { handler = fn; } }, '#coverEmpty': {},
    '#coverGrid': { children: [{}] }, '#coverMeta': {}, '#coverResultBar': {},
  };
  const context = vm.createContext({ $: s => elements[s], coverBatch: 1, performance, IN_MOCK: false,
    lastBatch: {}, coverBoundTaskId: null, coverHistory: [], backend: { genCandidates: async (...a) => { args = a; return { ok: true, cover: 'test.png', source: 'ai' }; } },
    esc: s => s, fileUrl: s => s, nowTime: () => '', addLog: () => {}, toast: () => {}, addError: () => {} });
  const start = ui.indexOf("$('#btnGenCover').addEventListener");
  vm.runInContext(ui.slice(start, ui.indexOf('/* 结果网格交互', start)), context);
  await handler();
  assert.equal(args[4].size, '1280x720');
  let bridged;
  const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  const bridgeContext = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (_n, value) => { bridged = value; } },
    ipcRenderer: { invoke: (_channel, payload) => payload } }) });
  vm.runInContext(preload, bridgeContext);
  assert.equal(bridged.genCandidates(...args).options.size, '1280x720');
});

test('credentials status describes saved credentials instead of claiming logged in', async () => {
  const elements = Object.fromEntries(['#acctPhone', '#acctBadge', '#acctLoginSub', '#acctPen'].map(id => [id, {}]));
  const context = vm.createContext({ $: s => elements[s], backend: { getCredentials: async () => ({ has: true, phone: 'test',sessionSaved:true }), getSettings: async () => ({}) },
    refreshAccountList: async () => {} });
  vm.runInContext(ui.slice(ui.indexOf('async function loadAccountPage('), ui.indexOf('async function refreshAccountList(')), context);
  await context.loadAccountPage();
  assert.equal(elements['#acctBadge'].textContent, '登录已保存');
});

test('changing background checkbox recreates browser with requested mode', async () => {
  const calls = [];
  const context = vm.createContext({ runnerPhone:'A',invalidAccounts:new Set(),accountPaths:()=>({}),loadCredentials:()=>({phone:'A'}),manualLoginOpen:false,platformLoginRequired:false,requirePlatformLogin:()=>{},runner: { running: true, close: async () => calls.push('close') }, runnerHeadless: true,
    send: () => {}, createRunner: () => ({ running: false, launch: async options => calls.push(options.headless) }) });
  vm.runInContext(main.slice(main.indexOf('async function getRunner('), main.indexOf("ipcMain.handle('platform-login-open'")), context);
  await context.getRunner(false);
  assert.deepEqual(calls, ['close', false]);
});

test('same-size revised manuscript archives separately and preserves old content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawa-archive-test-'));
  let handler;
  try {
    const src = path.join(dir, 'source.txt');
    const archive = path.join(dir, 'novels');
    fs.mkdirSync(archive);
    fs.writeFileSync(src, 'new content');
    fs.writeFileSync(path.join(archive, 'ArchiveTest.txt'), 'old content');
    const context = vm.createContext({ ipcMain: { handle: (_n, fn) => { handler = fn; } }, fs, path, archiveManuscript, NOVELS_DIR: archive,
      loadSettings: () => ({}), parseNovelFile: async () => ({ title: 'ArchiveTest', text: 'new content', wordCount: 11 }),
      deriveMeta: () => ({}), readNovelChapters: async () => [], loadSiteData: () => ({ entries: ['普通投稿'] }), log: () => {} });
    const start = main.indexOf("ipcMain.handle('prepare-task'");
    vm.runInContext(main.slice(start, main.indexOf('/* ---------------- 候选生成', start)), context);
    const result = await handler(null, { kind: 'file', path: src });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(result.cfg.本地文件, 'utf8'), 'new content');
    assert.notEqual(result.cfg.本地文件, src);
    assert.equal(fs.readFileSync(path.join(archive, 'ArchiveTest.txt'), 'utf8'), 'old content');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refresh matches renamed tasks by submission ID instead of title', async () => {
  let handler;
  const context = vm.createContext({ ipcMain: { handle: (_n, fn) => { handler = fn; } }, busy: false, revBusy: false, automationSiteBusy: false,
    getRunner: async () => ({ ensureLogin: async () => {}, listSubmissions: async () => [{ sid: 9, id: 7, title: '旧名', status: 'reviewing', submittedN: 1 }] }),
    send: () => {}, fs: { existsSync: () => true }, readNovelChapters: async () => chapters(2) });
  const start = main.indexOf("ipcMain.handle('refresh-panel'");
  vm.runInContext(main.slice(start, main.indexOf('/* ---------------- 持久化', start)), context);
  const result = await handler(null, { tasks: [{ id: 'test', sid: 9, title: '新名', file: 'virtual.txt' }] });
  assert.equal(result.byTask.test.sid, 9);
  assert.equal(result.updates.test.canUpdate, true);
});

test('site import distinguishes two works with the same title by ID', async () => {
  let handler, selected;
  const list = { addEventListener: (_event, fn) => { handler = fn; } };
  const context = vm.createContext({ $: s => s === '#siteList' ? list : {},
    siteWorksCache: [{ id: 1, title: '同名书' }, { id: 2, title: '同名书' }],
    backend: { prepareTask: async p => { selected = p.work; return { ok: false, error: 'isolated test' }; } }, toast: () => {} });
  const start = ui.indexOf("$('#siteList').addEventListener");
  vm.runInContext(ui.slice(start, ui.indexOf("document.addEventListener('click'", start)), context);
  await handler({ target: { closest: () => ({ dataset: { w: '2' } }) } });
  assert.equal(selected.id, 2);
});
