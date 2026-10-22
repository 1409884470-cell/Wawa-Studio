#!/usr/bin/env node
/**
 * 蛙蛙写作（wawawriter.com）自动投稿工具
 *
 * 功能：
 *   - 支持长篇 / 短篇作品投稿
 *   - 从站内作品选择，或上传本地 docx/doc/txt 文件
 *   - 自动上传封面（jpg/png/webp，≤5MB）
 *   - 自动填写笔名、字数、作品简介
 *   - 自动选择投稿入口、分类、频道、状态、小说类目（级联）、作品标签、自定义标签
 *   - 默认干跑（只填写不提交），--submit 才真实提交
 *
 * 用法：
 *   node wawa-submit.mjs 投稿配置.json [选项]
 *   选项：
 *     --submit        真实提交（默认只填写并截图，不提交）
 *     --headless      无头模式运行（默认弹出浏览器窗口）
 *     --cdp <端口>    附加到已开启远程调试端口的 Chrome（如 9222），复用其登录态
 *     --login-wait <秒>  未登录时等待手动登录的最长时间（默认 300）
 *     --dir <目录>    批量模式：依次投稿目录下所有 .json 配置
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORM_URL = 'https://wawawriter.com/app/submission/create';
const PROFILE_DIR = path.join(__dirname, 'profiles', 'wawa');
const SESSION_FILE = path.join(__dirname, 'profiles', 'wawa-session.json');
const OUTPUT_DIR = path.join(__dirname, 'output');

const TAG = '[wawa-submit]';
const log = (...a) => console.log(TAG, ...a);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactRe = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);

/* ---------------- 参数与配置 ---------------- */

function parseArgs(argv) {
  const opts = { submit: false, headless: false, cdp: null, loginWait: 300, dir: null, configs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--submit') opts.submit = true;
    else if (a === '--headless') opts.headless = true;
    else if (a === '--cdp') opts.cdp = Number(argv[++i]);
    else if (a === '--login-wait') opts.loginWait = Number(argv[++i]);
    else if (a === '--dir') opts.dir = argv[++i];
    else opts.configs.push(a);
  }
  if (opts.dir) {
    opts.configs = fs.readdirSync(opts.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(opts.dir, f));
  }
  return opts;
}

function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const cfg = {
    sourceTitle: raw['作品标题'] ?? raw.sourceTitle ?? null,   // 站内作品标题（从作品选择）
    localFile: raw['本地文件'] ?? raw.localFile ?? null,        // 或本地 docx/doc/txt
    cover: raw['封面'] ?? raw.cover ?? null,
    title: raw['作品名称'] ?? raw.title ?? null,                // 可选，覆盖自动回填的名称
    penName: raw['笔名'] ?? raw.penName ?? null,
    wordCount: raw['作品字数'] ?? raw.wordCount ?? null,        // 可选，覆盖自动解析字数
    entry: raw['投稿入口'] ?? raw.entry ?? '普通投稿',
    category: raw['作品分类'] ?? raw.category ?? null,          // 长篇 / 短篇
    channel: raw['作品频道'] ?? raw.channel ?? null,            // 男频 / 女频 / 全频
    status: raw['作品状态'] ?? raw.status ?? '已完结',          // 连载中 / 已完结
    novelType: raw['小说类目'] ?? raw.novelType ?? null,        // 如 ["女频","都市言情","婚恋爱情"]
    tags: raw['作品标签'] ?? raw.tags ?? [],
    customTags: raw['自定义标签'] ?? raw.customTags ?? [],
    intro: raw['作品简介'] ?? raw.intro ?? '',
  };
  if (!cfg.sourceTitle && !cfg.localFile) throw new Error('配置缺少作品来源：请填写 "作品标题"（站内作品）或 "本地文件"（docx/doc/txt）');
  if (cfg.sourceTitle && cfg.localFile) throw new Error('"作品标题" 与 "本地文件" 只能二选一');
  if (!cfg.cover) throw new Error('配置缺少 "封面"（jpg/png/webp 图片路径）');
  if (!cfg.penName) throw new Error('配置缺少 "笔名"');
  if (!cfg.category) throw new Error('配置缺少 "作品分类"（长篇 或 短篇）');
  if (!cfg.channel) throw new Error('配置缺少 "作品频道"（男频/女频/全频）');
  if (!Array.isArray(cfg.novelType) || cfg.novelType.length !== 3) throw new Error('配置 "小说类目" 需为三级路径数组，如 ["女频","都市言情","婚恋爱情"]');
  for (const p of [cfg.cover, cfg.localFile].filter(Boolean)) {
    if (!fs.existsSync(p)) throw new Error(`文件不存在: ${p}`);
  }
  if (cfg.intro && cfg.intro.length > 500) {
    log(`警告：简介超过 500 字（${cfg.intro.length}），将截断`);
    cfg.intro = cfg.intro.slice(0, 500);
  }
  return cfg;
}

/* ---------------- 浏览器与登录 ---------------- */

async function launchContext(opts) {
  if (opts.cdp) {
    log(`附加到 Chrome 调试端口 ${opts.cdp} ...`);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.cdp}`);
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages().find(p => p.url().includes('wawawriter.com')) ?? await context.newPage();
    return { browser, context, page, isCdp: true };
  }
  log(opts.headless ? '以无头模式启动 Chrome ...' : '启动 Chrome（独立登录目录）...');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: opts.headless,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  return { browser: context, context, page, isCdp: false };
}

const formReady = (page) => page.locator('input[placeholder*="作品名称"]').count();

// 注入已保存的登录会话（localStorage + cookie），失败不阻断流程
async function restoreSession(page) {
  if (!fs.existsSync(SESSION_FILE)) return;
  try {
    const { localStorage: ls, cookie } = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    await page.goto('https://wawawriter.com/app/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((entries) => {
      for (const [k, v] of Object.entries(entries)) {
        try { localStorage.setItem(k, v); } catch { /* 配额或类型异常忽略 */ }
      }
    }, ls);
    if (cookie) {
      const cookies = cookie.split(';').map(c => c.trim()).filter(Boolean).map(c => {
        const idx = c.indexOf('=');
        return { name: c.slice(0, idx), value: c.slice(idx + 1), domain: 'wawawriter.com', path: '/' };
      });
      await page.context().addCookies(cookies);
    }
    log('已注入保存的登录会话。');
  } catch (e) {
    log(`会话恢复失败（${e.message.split('\n')[0]}），将按未登录处理。`);
  }
}

// 把当前页面的登录态保存下来，供下次无头复用
async function saveSession(page) {
  try {
    const session = await page.evaluate(() => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        ls[k] = localStorage.getItem(k);
      }
      return { localStorage: ls, cookie: document.cookie };
    });
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    log('登录会话已保存到 profiles/wawa-session.json（下次可直接无头运行）。');
  } catch (e) {
    log(`会话保存失败：${e.message.split('\n')[0]}`);
  }
}

async function ensureLoggedIn(page, opts) {
  log('打开投稿表单页面 ...');
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  if (await formReady(page) > 0) { log('已登录。'); return; }

  // 首次访问失败时尝试注入历史会话再刷新
  if (fs.existsSync(SESSION_FILE)) {
    await restoreSession(page);
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    if (await formReady(page) > 0) { log('已通过保存的会话登录。'); return; }
  }

  if (opts.headless) {
    throw new Error('当前未登录且处于无头模式。请先不带 --headless 运行一次，在弹出的浏览器里完成登录（登录态会保存，之后可无头运行）。');
  }

  log('未登录。请在弹出的浏览器窗口中完成登录（扫码 / 验证码均可）...');
  const deadline = Date.now() + opts.loginWait * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    try { await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' }); } catch { /* 忽略导航竞争 */ }
    await page.waitForTimeout(2000);
    if (await formReady(page) > 0) { log('登录成功！'); await saveSession(page); return; }
    const left = Math.round((deadline - Date.now()) / 1000);
    if (left % 30 === 0) log(`仍在等待登录... 剩余 ${left} 秒`);
  }
  throw new Error(`等待登录超时（${opts.loginWait} 秒）。`);
}

/* ---------------- 表单操作 ---------------- */

async function clickToastAware(page) { /* 预留 */ }

async function readToasts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.el-message')).map(m => ({
      text: (m.textContent || '').trim(),
      type: m.className.includes('error') ? 'error' : m.className.includes('success') ? 'success' : 'info',
    }))
  );
}

// 从站内作品选择（弹窗内按标题精确匹配，滚动触发分页加载直到找到或到底）
// 弹窗用 el-scrollbar 无限滚动，直接赋值 scrollTop 不会触发加载，
// 必须派发 wheel + scroll 事件模拟真实滚轮。
async function chooseFromWorks(page, title) {
  log(`从站内作品选择：${title}`);
  const btn = page.getByRole('button', { name: '从作品选择' });
  await btn.click();
  const dialog = page.locator('.el-dialog:visible');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);

  const findItem = () => dialog.locator('p').filter({ hasText: exactRe(title) });
  const itemCount = () => page.evaluate(() => {
    const dlg = document.querySelector('.el-dialog');
    return dlg ? dlg.querySelectorAll('p').length : -1;
  });

  // 滚一轮：小步滚动 + wheel/scroll 事件，返回是否触底
  const scrollRound = () => page.evaluate(async () => {
    const dlg = document.querySelector('.el-dialog');
    if (!dlg) return 'no-dialog';
    const wrap = dlg.querySelector('.el-scrollbar__wrap');
    if (!wrap) return 'no-wrap';
    for (let j = 0; j < 5; j++) {
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true }));
      wrap.scrollTop += Math.max(150, wrap.clientHeight * 0.5);
      wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
    }
    return wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 5 ? 'bottom' : 'ok';
  });

  let found = (await findItem().count()) > 0;
  let stuckRounds = 0;
  let lastCount = await itemCount();

  for (let i = 0; i < 100 && !found; i++) {
    const state = await scrollRound();
    await page.waitForTimeout(1300);
    const count = await itemCount();
    found = (await findItem().count()) > 0;
    if (found) break;
    if (count === lastCount) stuckRounds++; else stuckRounds = 0;
    lastCount = count;
    // 触底且条目数连续多轮不再增长 → 列表加载完毕
    if (state === 'bottom' && stuckRounds >= 2) break;
    if (state === 'no-dialog' || state === 'no-wrap') break;
  }

  if (!found && (await findItem().count()) === 0) {
    throw new Error(`作品选择弹窗中未找到：《${title}》。请确认标题与站内作品完全一致。`);
  }

  await findItem().first().click();
  await page.waitForTimeout(500);
  const confirm = dialog.getByRole('button', { name: '选择作品' });
  if (!(await confirm.isEnabled())) throw new Error('未能选中作品（确认按钮不可用）');
  await confirm.click();
  await dialog.waitFor({ state: 'hidden', timeout: 10000 });
  await page.waitForTimeout(800);
}

// 上传本地正文文件并等待解析回填
async function uploadLocalFile(page, filePath) {
  log(`上传本地文件：${filePath}`);
  const input = page.locator('input[type="file"][accept=".docx,.doc,.txt"]');
  await input.setInputFiles(filePath);
  log('等待文件解析 ...');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1500);
    const v = await page.locator('input[placeholder*="作品名称"]').inputValue();
    if (v && v.trim()) { log('文件解析完成。'); return; }
  }
  log('警告：文件上传后未检测到自动回填的作品名称，请人工核对。');
}

async function uploadCover(page, coverPath) {
  log(`上传封面：${coverPath}`);
  const stat = fs.statSync(coverPath);
  if (stat.size > 5 * 1024 * 1024) throw new Error('封面图片超过 5MB，请压缩后重试');
  const ext = path.extname(coverPath).toLowerCase().replace('.', '');
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) throw new Error(`封面格式不支持：.${ext}（支持 jpg/png/webp）`);
  const input = page.locator('input[type="file"][accept*="image"]');
  await input.setInputFiles(coverPath);
  await page.waitForTimeout(2000);
  log('封面上传完成。');
}

// 点击 Element Plus 单选（按可见文字精确匹配；disabled 时报错）
async function clickRadio(page, groupName, label) {
  const radio = page.locator('.el-radio').filter({ has: page.locator('.el-radio__label', { hasText: exactRe(label) }) });
  const n = await radio.count();
  if (n === 0) {
    const all = await page.locator('.el-radio .el-radio__label').allTextContents();
    throw new Error(`找不到「${groupName}」选项「${label}」。当前可选项：${all.map(t => t.trim()).join('、')}`);
  }
  const first = radio.first();
  const cls = await first.getAttribute('class');
  if (cls.includes('is-disabled')) throw new Error(`「${groupName}」选项「${label}」当前不可选（站点限制）`);
  if (cls.includes('is-checked')) { log(`${groupName}：${label}（已是选中状态）`); return; }
  await first.click();
  await page.waitForTimeout(300);
  log(`${groupName}：${label}`);
}

// 级联选择小说类目（三级路径）
// 注意：Element Plus 级联在选中后会把带 placeholder 的 input 移除，换成一个回显值的 input（无 placeholder）
async function pickCategory(page, segments) {
  log(`选择小说类目：${segments.join(' / ')}`);
  await page.locator('input[placeholder*="小说类目"]').click();
  await page.locator('.el-cascader__dropdown:visible').first().waitFor({ state: 'visible' });
  for (const seg of segments) {
    const node = page.locator('.el-cascader__dropdown:visible .el-cascader-menu').last()
      .locator('.el-cascader-node').filter({ hasText: exactRe(seg) });
    const n = await node.count();
    if (n === 0) throw new Error(`小说类目中找不到「${seg}」，请检查三级路径拼写`);
    await node.first().click();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(600);
  // 选完后原 placeholder input 会被替换；改从 DOM 直接读回显值
  const val = await page.evaluate(() => {
    const byPh = document.querySelector('input[placeholder*="小说类目"]');
    if (byPh) return byPh.value;
    // 回显 input 在同一个 el-cascader 容器内
    const casc = Array.from(document.querySelectorAll('.el-cascader'));
    for (const c of casc) {
      const inp = c.querySelector('input');
      if (inp && inp.value) return inp.value;
    }
    return null;
  });
  if (!val || !val.includes(segments[segments.length - 1])) {
    throw new Error(`类目回填异常：${val}（预期包含「${segments[segments.length - 1]}」）`);
  }
  log(`类目已回填：${val}`);
}

// 勾选作品标签（绿色高亮即选中）
async function pickTags(page, tags) {
  if (!tags.length) return;
  // 展开全部标签
  const expand = page.getByRole('button', { name: '展开' });
  if (await expand.count() === 1 && await expand.isVisible().catch(() => false)) {
    await expand.click();
    await page.waitForTimeout(400);
  }
  for (const tag of tags) {
    const chip = page.locator('div.flex.flex-wrap.gap-2 > div').filter({ hasText: exactRe(tag) });
    const n = await chip.count();
    if (n === 0) throw new Error(`作品标签中找不到「${tag}」`);
    const el = chip.first();
    const before = await el.getAttribute('class');
    if (!before.includes('E8F8F2')) {
      await el.click();
      await page.waitForTimeout(300);
    }
    const after = await el.getAttribute('class');
    if (!after.includes('E8F8F2')) throw new Error(`标签「${tag}」点击后未选中（可能超出标签数量上限）`);
    log(`标签：${tag}`);
  }
}

async function addCustomTags(page, tags) {
  for (const t of tags) {
    const input = page.locator('input[placeholder*="自定义标签"]');
    await input.fill(t);
    await page.waitForTimeout(300);
    const addBtn = page.getByRole('button', { name: '添加' });
    if (!(await addBtn.isEnabled())) throw new Error(`自定义标签「${t}」无法添加（按钮不可用）`);
    await addBtn.click();
    await page.waitForTimeout(400);
    log(`自定义标签：${t}`);
  }
}

// 汇总当前表单状态（干跑展示 / 校验用）
async function dumpFormState(page) {
  return page.evaluate(() => {
    const val = (ph) => document.querySelector(`input[placeholder*="${ph}"]`)?.value ?? null;
    const ta = document.querySelector('textarea[placeholder*="作品简介"]')?.value ?? null;
    const radios = Array.from(document.querySelectorAll('.el-radio.is-checked .el-radio__label')).map(e => e.textContent.trim());
    const tags = Array.from(document.querySelectorAll('div.flex.flex-wrap.gap-2 > div'))
      .filter(e => e.className.includes('E8F8F2')).map(e => e.textContent.trim());
    const coverUploaded = !!document.querySelector('img[src*="blob"], .el-upload img');
    const fileChosen = Array.from(document.querySelectorAll('input[type="file"]')).some(i => i.files?.length);
    return { 名称: val('作品名称'), 笔名: val('笔名'), 字数: val('作品字数'), 类目: val('小说类目'), 简介: ta, 选中单选: radios, 标签: tags, 封面已选: fileChosen || coverUploaded };
  });
}

/* ---------------- 主流程 ---------------- */

async function submitOne(page, opts, cfg, cfgFile) {
  const nameOf = path.basename(cfgFile || '未命名');
  log(`===== 开始处理：${nameOf} =====`);

  // 1. 确保在表单页
  if (await formReady(page) === 0) {
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  // 2. 作品来源
  if (cfg.localFile) await uploadLocalFile(page, cfg.localFile);
  else {
    // 先切投稿入口与分类：普通投稿只有长篇；征文活动才有短篇选项。
    // 弹窗按当前分类过滤作品列表，必须先选对入口/分类再打开弹窗。
    await clickRadio(page, '投稿入口', cfg.entry);
    const hasCategory = await page.locator('.el-radio').filter({
      has: page.locator('.el-radio__label', { hasText: exactRe(cfg.category) }),
    }).count();
    if (hasCategory > 0) {
      await clickRadio(page, '作品分类', cfg.category);
    } else {
      log(`警告：当前投稿入口下没有「${cfg.category}」选项（普通投稿仅开放长篇），跳过分类切换。`);
    }
    await chooseFromWorks(page, cfg.sourceTitle);
  }

  // 3. 作品名称（可覆盖）
  const titleInput = page.locator('input[placeholder*="作品名称"]');
  const autoTitle = await titleInput.inputValue();
  if (cfg.title && cfg.title !== autoTitle) {
    await titleInput.fill(cfg.title);
    log(`作品名称：${cfg.title}（覆盖自动回填「${autoTitle}」）`);
  } else {
    log(`作品名称：${autoTitle}（自动回填）`);
  }

  // 4. 封面
  await uploadCover(page, cfg.cover);

  // 5. 笔名 / 字数
  await page.locator('input[placeholder*="笔名"]').fill(cfg.penName);
  log(`笔名：${cfg.penName}`);
  if (cfg.wordCount) {
    await page.locator('input[placeholder*="作品字数"]').fill(String(cfg.wordCount));
    log(`作品字数：${cfg.wordCount}（配置指定）`);
  } else {
    const wc = await page.locator('input[placeholder*="作品字数"]').inputValue();
    log(`作品字数：${wc || '（空）'}（自动解析）`);
  }

  // 6. 单选组（作品来源阶段已切过入口/分类的会跳过重复点击）
  await clickRadio(page, '投稿入口', cfg.entry);
  const hasCat2 = await page.locator('.el-radio').filter({
    has: page.locator('.el-radio__label', { hasText: exactRe(cfg.category) }),
  }).count();
  if (hasCat2 > 0) await clickRadio(page, '作品分类', cfg.category);
  await clickRadio(page, '作品频道', cfg.channel);
  await clickRadio(page, '作品状态', cfg.status);

  // 7. 类目 / 标签 / 简介
  await pickCategory(page, cfg.novelType);
  await pickTags(page, cfg.tags);
  await addCustomTags(page, cfg.customTags);
  if (cfg.intro) {
    await page.locator('textarea[placeholder*="作品简介"]').fill(cfg.intro);
    log(`作品简介：已填写（${cfg.intro.length} 字）`);
  }

  // 8. 状态核对 + 截图
  const state = await dumpFormState(page);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const shot = path.join(OUTPUT_DIR, `${ts}-${(cfg.title || cfg.sourceTitle || '投稿').slice(0, 20)}-表单.png`);
  await page.screenshot({ path: shot, fullPage: true });
  log('表单当前状态：', JSON.stringify(state, null, 2));

  if (!opts.submit) {
    log('【干跑模式】已填写完毕并截图，未提交。确认无误后加 --submit 真实投稿。');
    return { ok: true, dryRun: true, screenshot: shot, state };
  }

  // 9. 真实提交
  log('提交投稿 ...');
  await page.getByRole('button', { name: '提交' }).click();
  await page.waitForTimeout(1500);

  // 可能出现确认弹窗
  const msgBox = page.locator('.el-message-box:visible');
  if (await msgBox.count() > 0) {
    const boxText = (await msgBox.innerText()).replace(/\s+/g, ' ').slice(0, 120);
    log(`站点弹窗确认：${boxText}`);
    const okBtn = msgBox.getByRole('button', { name: /确定|确认|投稿/ }).first();
    await okBtn.click();
  }

  // 收集结果（toast / 跳转）
  let result = { ok: false, messages: [], url: page.url() };
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    const toasts = await readToasts(page);
    if (toasts.length) result.messages = toasts.map(t => `[${t.type}] ${t.text}`);
    result.url = page.url();
    if (toasts.some(t => t.type === 'success') || /\/app\/submission(\/?$|\?)/.test(result.url)) {
      result.ok = true; break;
    }
    if (toasts.some(t => t.type === 'error')) break;
  }
  const shot2 = path.join(OUTPUT_DIR, `${ts}-${(cfg.title || cfg.sourceTitle || '投稿').slice(0, 20)}-结果.png`);
  await page.screenshot({ path: shot2, fullPage: true });
  result.screenshot = shot2;
  if (result.ok) log('✅ 投稿提交成功！', result.messages.join(' '));
  else log('⚠️ 提交结果未知或失败：', result.messages.join(' ') || '未捕获到站点提示', `（当前页面：${result.url}）`);
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.configs.length) {
    console.log(`用法: node wawa-submit.mjs <配置.json> [--submit] [--headless] [--cdp 端口] [--login-wait 秒] [--dir 目录]`);
    process.exit(1);
  }
  const cfgs = opts.configs.map(f => ({ file: f, cfg: loadConfig(f) }));
  const { browser, context, page } = await launchContext(opts);
  const results = [];
  try {
    await ensureLoggedIn(page, opts);
    for (const { file, cfg } of cfgs) {
      try {
        results.push({ file, ...(await submitOne(page, opts, cfg, file)) });
      } catch (e) {
        log(`❌ ${path.basename(file)} 失败：${e.message.split('\n')[0]}`);
        results.push({ file, ok: false, error: e.message.split('\n')[0] });
        if (cfgs.length > 1) {
          // 批量模式下失败后刷新表单页继续下一篇
          await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(3000);
        }
      }
    }
  } finally {
    if (opts.cdp) await browser.close().catch(() => {}); // 仅断开 CDP 连接，不关闭用户浏览器
    else await context.close().catch(() => {});
  }
  const okCount = results.filter(r => r.ok).length;
  log(`==== 完成：${okCount}/${results.length} 篇处理成功 ====`);
  process.exit(opts.submit ? (okCount === results.length ? 0 : 1) : 0);
}

main().catch(e => { console.error(TAG, '出错了：', e.message); process.exit(1); });
