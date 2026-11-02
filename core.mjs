import { normalizePrompts } from './prompt-catalog.mjs';
import { STUDIO_DEFAULTS, validateStudio, fetchConcurrent } from './studio-policy.mjs';
import { DEFAULT_COVER_TEMPLATE, normalizeCoverSettings } from './cover-prompt.mjs';
// 蛙蛙写作自动投稿核心模块：登录、表单填写、提交（供 CLI 和 GUI 共用）
import fs from 'node:fs';
import { allPages } from './pagination.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { RES_DIR, userPath } from './paths.mjs';
import { chromium } from 'playwright-core';

export const __dirname = RES_DIR;
export const FORM_URL = 'https://wawawriter.com/app/submission/create';
export const PROFILE_DIR = userPath('profiles', 'wawa');
export const SESSION_FILE = userPath('profiles', 'wawa-session.json');
export const CREDENTIALS_FILE = userPath('profiles', 'credentials.json');
export const SETTINGS_FILE = userPath('profiles', 'settings.json');
export const OUTPUT_DIR = userPath('output');
export const CONFIG_DIR = userPath('configs');

/* ---------------- 设置 ---------------- */

const DEFAULT_SETTINGS = {
  ...STUDIO_DEFAULTS, penLibraryOnly:true,
  penName: '',            // 默认笔名
  apiBaseUrl: '',         // 文本 AI（OpenAI 兼容）：地址
  apiKey: '',             // 文本 AI：Key
  textModel: '',          // 文本 AI：模型（标题/简介）
  imgApiBaseUrl: '',      // 图像 AI：地址（可与文本 AI 不同）
  imgApiKey: '',          // 图像 AI：Key
  imageModel: '',         // 图像 AI：模型（封面）
  coverTemplate: DEFAULT_COVER_TEMPLATE,
  deaiPrompt: '',         // 去AI提示词（留空 = 内置默认：去模板词/口语化/剧情不变）
  autoRepairRejected: true,
  rewriteConcurrency: 3, // 仅精确匹配通用质量拒稿时，自动修改并复投一次
  reviewPollMinutes: 10,
  updateUrl: '',          // 检查更新地址（JSON: version/note/url）；留空 = 不检查
};

export function loadSettings() {
  try {
    const settings=normalizeCoverSettings({...DEFAULT_SETTINGS,...JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'))});
    settings.submissionDailyLimit=Math.min(3,Math.max(1,Number(settings.submissionDailyLimit)||3));
    settings.promptTemplates=normalizePrompts(settings.promptTemplates);
    settings.penNames=(settings.penNames||[]).map(p=>({...p}));
    if(!settings.penLibraryVersion){
      if(settings.penName?.trim()&&!settings.penNames.some(p=>p.name===settings.penName.trim()))settings.penNames.push({id:'legacy-'+crypto.createHash('sha256').update(settings.penName.trim()).digest('hex').slice(0,16),name:settings.penName.trim(),enabled:true,account:'',limit:0,dailyLimit:0,gapMinutes:0});
      settings.penLibraryVersion=1;
    }
    settings.penName='';settings.penLibraryOnly=true;return settings;
  }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(patch) {
  const cur = loadSettings();
  const next = validateStudio({ ...cur, ...patch });
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

/* ---------------- 登录凭据 ---------------- */

export function loadCredentials() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8')); }
  catch { return null; }
}
export function saveCredentials({ phone, password }) {
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ phone, password }, null, 2));
}
export function clearCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactRe = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);

export function loadSiteData() {
  const f = path.join(__dirname, 'data', 'categories.json');
  if (!fs.existsSync(f)) return { entries: ['普通投稿'], tags: [], tree: {} };
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

/* ---------------- 配置校验（返回错误信息数组，空即通过） ---------------- */

export function validateConfig(cfg, site = loadSiteData()) {
  const errs = [];
  if (!cfg.sourceTitle && cfg.sourceId == null && !cfg.localFile) errs.push('请填写站内作品标题，或选择本地稿件文件');
  if (cfg.sourceTitle && cfg.localFile) errs.push('站内作品与本地文件只能二选一');
  if (!cfg.cover) errs.push('请选择封面图片');
  if (!cfg.penName?.trim()) errs.push('请填写笔名');
  if (!cfg.title?.trim() || cfg.title.length > 30) errs.push('书名须为1-30字');
  if (!cfg.intro?.trim()) errs.push('请填写作品简介');
  if (!cfg.entry?.trim()) errs.push('请选择适用的投稿入口');
  if (!['已完结', '连载中'].includes(cfg.status)) errs.push('请选择完结状态');
  if (!Array.isArray(cfg.tags) || !cfg.tags.length || cfg.tags.some(t => !site.tags.includes(t)) || cfg.customTags?.length) errs.push('标签必须从蛙蛙系统标签库中选择');
  if (!site.tree[cfg.novelType?.[0]]?.[cfg.novelType?.[1]]?.includes(cfg.novelType?.[2])) errs.push('小说类目不在蛙蛙库中');
  if (cfg.novelType?.[0] !== cfg.channel) errs.push('频道与小说类目不一致');
  if (!['长篇','短篇'].includes(cfg.category)) errs.push('请选择作品分类（长篇/短篇）');
  if (!['男频','女频'].includes(cfg.channel)) errs.push('请选择作品频道');
  if (!Array.isArray(cfg.novelType) || cfg.novelType.length !== 3) errs.push('请选择完整的小说类目（一级/二级/三级）');
  if (cfg.category === '短篇' && cfg.entry === '普通投稿') errs.push('站点规则：普通投稿仅开放长篇；短篇请选择征文活动入口');
  if (cfg.cover && !/^https?:\/\//i.test(cfg.cover)) {
    if (!fs.existsSync(cfg.cover)) errs.push(`封面文件不存在：${cfg.cover}`);
    else {
      const stat = fs.statSync(cfg.cover);
      if (!stat.isFile() || stat.size === 0) errs.push('封面图片为空或不是文件');
      if (stat.size > 5 * 1024 * 1024) errs.push('封面图片超过 5MB');
      const ext = path.extname(cfg.cover).toLowerCase().replace('.', '');
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) errs.push('封面仅支持 jpg/png/webp');
      if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
        const b = fs.readFileSync(cfg.cover);
        const valid = b.length > 12 && ((b[0] === 137 && b.toString('ascii',1,4) === 'PNG') || (b[0] === 255 && b[1] === 216 && b[2] === 255) || (b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP'));
        if (!valid) errs.push('封面文件内容不是 PNG/JPEG/WebP 图片');
      }
    }
  }
  if (cfg.localFile && !fs.existsSync(cfg.localFile)) errs.push(`本地稿件不存在：${cfg.localFile}`);
  if (cfg.intro && cfg.intro.length > 500) errs.push(`简介超 500 字（当前 ${cfg.intro.length} 字）`);
  if (cfg.penName && cfg.penName.length > 40) errs.push('笔名超过 40 字上限');
  return errs;
}

// 从原始 JSON（中文键）转内部字段
export function normalizeConfig(raw) {
  return {
    sourceTitle: raw['作品标题'] ?? raw.sourceTitle ?? null,
    sourceId: raw['作品ID'] ?? raw.sourceId ?? null,
    localFile: raw['本地文件'] ?? raw.localFile ?? null,
    cover: raw['封面'] ?? raw.cover ?? null,
    title: raw['作品名称'] ?? raw.title ?? null,
    penName: raw['笔名'] ?? raw.penName ?? null,
    wordCount: raw['作品字数'] ?? raw.wordCount ?? null,
    entry: raw['投稿入口'] ?? raw.entry ?? '普通投稿',
    category: raw['作品分类'] ?? raw.category ?? null,
    channel: raw['作品频道'] ?? raw.channel ?? null,
    status: raw['作品状态'] ?? raw.status ?? '已完结',
    novelType: raw['小说类目'] ?? raw.novelType ?? null,
    tags: raw['作品标签'] ?? raw.tags ?? [],
    customTags: raw['自定义标签'] ?? raw.customTags ?? [],
    intro: raw['作品简介'] ?? raw.intro ?? '',
  };
}

// 内部字段转中文键 JSON（保存配置用）
export function denormalizeConfig(cfg) {
  return {
    作品标题: cfg.sourceTitle ?? '',
    作品ID: cfg.sourceId ?? null,
    本地文件: cfg.localFile ?? '',
    封面: cfg.cover ?? '',
    作品名称: cfg.title ?? '',
    笔名: cfg.penName ?? '',
    作品字数: cfg.wordCount ?? '',
    投稿入口: cfg.entry ?? '普通投稿',
    作品分类: cfg.category ?? '',
    作品频道: cfg.channel ?? '',
    作品状态: cfg.status ?? '已完结',
    小说类目: cfg.novelType ?? [],
    作品标签: cfg.tags ?? [],
    自定义标签: cfg.customTags ?? [],
    作品简介: cfg.intro ?? '',
  };
}

export function listConfigs() {
  if (!fs.existsSync(CONFIG_DIR)) return [];
  return fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
    .map(f => {
      const p = path.join(CONFIG_DIR, f);
      try {
        const cfg = normalizeConfig(JSON.parse(fs.readFileSync(p, 'utf-8')));
        return { file: f, name: cfg.title || cfg.sourceTitle || f.replace('.json', ''), cfg };
      } catch { return { file: f, name: f.replace('.json', ''), cfg: null }; }
    });
}

export function saveConfig(filename, cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const safe = filename.replace(/[\\/:*?"<>|]/g, '_').replace(/\.json$/, '') + '.json';
  fs.writeFileSync(path.join(CONFIG_DIR, safe), JSON.stringify(denormalizeConfig(cfg), null, 2));
  return safe;
}

export function deleteConfig(filename) {
  const p = path.join(CONFIG_DIR, filename);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/* ---------------- 浏览器与登录 ---------------- */

export function createRunner({ onLog = () => {}, onAuthRequired = () => {}, browserType = chromium, profileDir = PROFILE_DIR, sessionFile = SESSION_FILE, beforeSubmit = () => {}, onSubmitError = () => {}, checkQuota = () => {} } = {}) {
  const log = (...a) => { console.log('[wawa]', ...a); onLog(a.map(String).join(' ')); };
  let ctx = null;   // BrowserContext（launchPersistentContext 返回值）
  let page = null;
  let authRequired=false;

  const api = {
    get running() { return !!ctx; },
    get page() { return page; },

    async launch({ headless = true } = {}) {
      if (ctx) return page;
      log(headless ? '启动浏览器（无头模式）...' : '启动浏览器窗口...');
      try {
        ctx = await browserType.launchPersistentContext(profileDir, {
          channel: 'chrome',
          headless,
          viewport: { width: 1440, height: 900 },
        });
      } catch (e) {
        // 新机器没装 Chrome：给出可执行的指引而不是一串英文堆栈
        if (/executable|chrome/i.test(e.message) && !fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
          && !fs.existsSync('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe')
          && !fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'))) {
          throw new Error('未检测到 Google Chrome 浏览器。本工具依赖本机 Chrome 投稿，请先安装：https://www.google.cn/chrome/ 装好后重新打开软件。');
        }
        throw e;
      }
      ctx.on('close',()=>{ctx=null;page=null;});
      page = ctx.pages()[0] ?? await ctx.newPage();
      return page;
    },

    async close() {
      if (ctx) { await ctx.close().catch(() => {}); ctx = null; page = null; log('浏览器已关闭。'); }
    },

    async openLogin() {
      if(!ctx)await api.launch({headless:false});
      await page.goto(FORM_URL,{waitUntil:'domcontentloaded'});
      await page.bringToFront();
      return true;
    },
    async saveLoginSession() {
      if(!page||page.isClosed())throw new Error('请先打开登录浏览器');
      await page.goto(FORM_URL,{waitUntil:'domcontentloaded'});
      try{await page.locator('input[placeholder*="作品名称"]').waitFor({state:'visible',timeout:10000});}
      catch{throw new Error('尚未登录，请先在浏览器完成登录');}
      await api._saveSession();authRequired=false;return true;
    },
    async ensureLogin() {
      const required=()=>{authRequired=true;onAuthRequired();const e=new Error('登录已失效，请到设置 → 平台账号登录');e.code='AUTH_REQUIRED';return e;};
      if(authRequired)throw required();
      const formReady=async()=>{try{await page.locator('input[placeholder*="作品名称"]').waitFor({state:'visible',timeout:5000});return true;}catch{return false;}};
      await page.goto(FORM_URL,{waitUntil:'domcontentloaded'});
      if(await formReady())return true;
      if(fs.existsSync(sessionFile)){
        await api._restoreSession();await page.goto(FORM_URL,{waitUntil:'domcontentloaded'});
        if(await formReady())return true;
      }
      throw required();
    },

    // 账号密码登录：打开登录面板 → 手机号登录 → 密码登录 → 填写 → 提交
    async _autoPasswordLogin(phone, password, formReady) {
      await page.goto('https://wawawriter.com/app/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      if (await formReady()) return true;

      // 打开登录面板（顶栏按钮或自动弹出的对话框）
      const dlg = page.locator('.el-dialog');
      if (!(await dlg.isVisible().catch(() => false))) {
        await page.locator('button.topbar-guest__login-btn').click();
        await dlg.waitFor({ state: 'visible', timeout: 10000 });
      }
      await page.waitForTimeout(800);

      // 手机号登录 tab → 密码登录 切换
      await dlg.getByRole('button', { name: '手机号登录' }).click();
      await page.waitForTimeout(600);
      const pwdToggle = dlg.getByText('密码登录', { exact: true });
      if (await pwdToggle.count() === 1) {
        await pwdToggle.click();
        await page.waitForTimeout(600);
      }
      // 填写
      await dlg.getByRole('textbox', { name: '请输入手机号' }).fill(phone);
      await dlg.getByRole('textbox', { name: '请输入密码' }).fill(password);
      // 勾选协议
      await page.evaluate(() => {
        const cb = document.querySelector('input.agreement-checkbox');
        if (cb && !cb.checked) cb.click();
      });
      await page.waitForTimeout(400);
      // 提交
      await dlg.getByRole('button', { name: '登录', exact: true }).click();
      log('已提交登录…');

      // 结果轮询：成功 / 滑块验证 / 报错
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(1500);
        if (await formReady()) return true;
        // 腾讯防水墙滑块
        if (page.frames().some(f => f.url().includes('turing.captcha.gtimg.com'))) {
          log('出现滑块验证，尝试自动通过…');
          const solved = await api._solveTencentCaptcha();
          if (!solved) {
            log('滑块自动通过失败（可手动拖一下滑块）。');
            return false;
          }
          await page.waitForTimeout(2000);
          if (await formReady()) return true;
        }
        // 站点报错提示
        const err = await page.evaluate(() => {
          const m = Array.from(document.querySelectorAll('.el-message')).find(x => x.className.includes('error'));
          return m ? m.textContent.trim() : null;
        });
        if (err) { log(`站点提示：${err}`); return false; }
      }
      return formReady();
    },

    // 腾讯防水墙滑块自动求解：像素边缘检测找缺口 → 拟人拖动
    async _solveTencentCaptcha() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const frame = page.frames().find(f => f.url().includes('turing.captcha.gtimg.com'));
        if (!frame) return true; // 没有验证码帧，视为无需处理
        try {
          const bg = frame.locator('#slideBg, img[id*="slideBg"], .tc-bg-img, img[src*="cap_union"]').first();
          const handle = frame.locator('#tcaptcha_drag_thumb, .tc-drag-thumb, [id*="drag_thumb"], .tc-slider-normal').first();
          if (!(await bg.count()) || !(await handle.count())) {
            log('识别不到滑块元素，跳过自动求解。');
            return false;
          }
          const bgBox = await bg.boundingBox();
          const hdBox = await handle.boundingBox();
          if (!bgBox || !hdBox) return false;

          // 截图背景 → pngjs 解码 → 找缺口（列边缘能量峰值）
          const buf = await bg.screenshot();
          const { PNG } = await import('pngjs');
          const png = PNG.sync.read(buf);
          const { width: W, height: H, data } = png;
          const lum = (x, y) => {
            const i = (y * W + x) * 4;
            return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          };
          // 中部 60% 高度带内做列差分，找边缘能量最高的两列（缺口左右沿）
          const y0 = Math.floor(H * 0.2), y1 = Math.floor(H * 0.8);
          const energy = new Array(W).fill(0);
          for (let x = 1; x < W; x++) {
            let s = 0;
            for (let y = y0; y < y1; y++) s += Math.abs(lum(x, y) - lum(x - 1, y));
            energy[x] = s / (y1 - y0);
          }
          // 只在右半区找（缺口不会在最左），取能量峰值列
          let gapX = -1, best = 0;
          for (let x = Math.floor(W * 0.45); x < W - 2; x++) {
            if (energy[x] > best) { best = energy[x]; gapX = x; }
          }
          if (gapX < 0) return false;

          // 像素坐标 → 页面坐标（截图可能含 2x 缩放）
          const scale = bgBox.width / W;
          const targetX = bgBox.x + gapX * scale - (hdBox.width / 2) + 4;
          const dist = targetX - hdBox.x;
          if (dist <= 0) continue;

          // 拟人拖动：加速 → 减速 → 轻微过冲回拉
          await page.mouse.move(hdBox.x + hdBox.width / 2, hdBox.y + hdBox.height / 2);
          await page.mouse.down();
          const steps = 28;
          let cur = 0;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const ease = 1 - Math.pow(1 - t, 2.2);                 // ease-out
            let dx = dist * ease - cur;
            if (i === steps) dx = dist - cur;
            cur += dx;
            await page.mouse.move(
              hdBox.x + hdBox.width / 2 + cur,
              hdBox.y + hdBox.height / 2 + (Math.random() - 0.5) * 3,
            );
            await page.waitForTimeout(12 + Math.random() * 26);
          }
          await page.waitForTimeout(120);
          await page.mouse.move(hdBox.x + hdBox.width / 2 + dist - 3, hdBox.y + hdBox.height / 2); // 轻微回拉
          await page.waitForTimeout(80);
          await page.mouse.up();
          await page.waitForTimeout(1800);

          // 验证帧消失即成功
          if (!page.frames().some(f => f.url().includes('turing.captcha.gtimg.com'))) {
            log('✅ 滑块验证已通过。');
            return true;
          }
          log(`第 ${attempt + 1} 次拖动未通过，重试…`);
          // 点刷新换一张
          const refresh = frame.locator('img[alt*="refresh"], .tc-refresh, [id*="refresh"]').first();
          if (await refresh.count()) { await refresh.click(); await page.waitForTimeout(1200); }
        } catch (e) {
          log(`滑块求解异常：${e.message.split('\n')[0]}`);
          return false;
        }
      }
      return false;
    },

    async _restoreSession() {
      try {
        const { localStorage: ls, cookie } = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
        await page.goto('https://wawawriter.com/app/', { waitUntil: 'domcontentloaded' });
        await page.evaluate((entries) => {
          for (const [k, v] of Object.entries(entries)) {
            try { localStorage.setItem(k, v); } catch { /* 忽略 */ }
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
        log(`会话恢复失败（${e.message.split('\n')[0]}）`);
      }
    },

    async _saveSession() {
      try {
        const session = await page.evaluate(() => {
          const ls = {};
          for (let i = 0; i < localStorage.length; i++) ls[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
          return { localStorage: ls, cookie: document.cookie };
        });
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        log('登录会话已保存。');
      } catch (e) { throw new Error('登录保存失败：'+e.message.split('\n')[0]); }
    },

    // 站内作品列表（分页拉全，返回未投稿优先的基础信息）
    async listSiteWorks() {
      const items = await allPages((page, page_size) => this._api('POST', '/wrhp-api/api/v2/novel/list', { json: { page, page_size, sort: ['-update_time'], edition: 2, story_type: ['long','short'] } }), { size: 50, key: 'base_novel_id' });
      return items.map(i => ({ id: i.base_novel_id, title: i.title, wordCount: i.word_count, storyType: i.story_type, cover: i.cover || null, submitted: !!i.is_submitted, update: i.update_time, status: i.status }));
    },

    // 回到空表单页（批量任务失败恢复用）
    async resetForm() {
      if (!page) return;
      await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500);
    },

    /* ---------------- API 直连引擎（优先传到作品库） ---------------- */
    // 站点前端自身走的就是这些接口；比 UI 自动化更快更稳。
    // FormData 不能跨进页面，文件按 base64 传入后在页面内重建 File。

    async _api(method, apiPath, { json, file, extra } = {}) {
      if (!page) throw new Error('浏览器未启动');
      const payload = { method, path: apiPath, json: json ?? null, extra: extra ?? null, file: null, fileName: null };
      if (file) {
        const buf = fs.readFileSync(file);
        payload.file = buf.toString('base64');
        payload.fileName = path.basename(file);
        payload.fileSecret = crypto.createHash('md5').update(buf).digest('hex');   // 站点要求 file_secret=MD5，否则 NOT SECURE UPLOAD
        const ext = payload.fileName.toLowerCase().split('.').pop();
        payload.mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
          txt: 'text/plain', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })[ext] || 'application/octet-stream';
      }
      try{return await page.evaluate(async (p) => {
        const rid = crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') :
          Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
        const H = {
          accept: 'application/json, text/plain, */*', 'x-client-channel': 'web', 'x-client-platform': 'pc',
          'x-request-id': rid, ocpcinfo: location.href,
        };
        let body;
        if (p.file) {
          const bin = atob(p.file);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          body = new FormData();
          body.append('file', new File([arr], p.fileName, { type: p.mime }));
          if (p.fileSecret) body.append('file_secret', p.fileSecret);
          if (p.extra) for (const [k, v] of Object.entries(p.extra)) body.append(k, v);
        } else if (p.json != null) {
          H['content-type'] = 'application/json';
          body = JSON.stringify(p.json);
        }
        const r = await fetch('https://wawawriter.com' + p.path, { method: p.method, credentials: 'include', headers: H, body, signal: AbortSignal.timeout(120000) });
        const j = await r.json().catch(() => ({ code: r.status, message: '非 JSON 响应' }));
        if(r.status===401||/未登录|登录过期|登录失效|请.*登录/.test(String(j.message||'')))throw new Error('AUTH_REQUIRED');
        if (!r.ok || j.code !== 200) throw new Error(j.message || `接口 ${p.path} 返回 ${j.code}`);
        return j.data;
      }, payload);}catch(e){if(/AUTH_REQUIRED/.test(e.message)){authRequired=true;onAuthRequired();e.code='AUTH_REQUIRED';e.message='登录已失效，请到设置 → 平台账号登录';}throw e;}
    },

    // 封面/文件上传 → CDN URL
    async apiUpload(localPath) {
      const d = await this._api('POST', '/wrhp-api/api/v1/file/simpleupload', { file: localPath });
      if (!d?.result) throw new Error('上传失败：无返回 URL');
      return d.result;
    },

    // 系统标签名 → id 映射
    async apiLabelMap() {
      const d = await this._api('POST', '/wrhp-api/api/v1/label/list', { json: { page: 1, page_size: 1000, scope: 'system' } });
      const m = new Map();
      for (const it of d?.items ?? []) m.set(it.name, it.id);
      return m;
    },

    // 征文活动（名字 → code）
    async apiCampaigns() {
      const d = await this._api('GET', '/wrhp-api/api/v1/submission/campaigns/active');
      return Array.isArray(d) ? d : [];
    },

    // 从文件创建投稿（全部章节进作品库）→ {submission_id, base_novel_id}
    async apiCreateFromFile(cfg) {
      return this._api('POST', '/wrhp-api/api/v1/submission/novel/create_from_file', { json: cfg });
    },

    // 从库内作品创建投稿
    async apiCreateFromNovel(cfg) {
      return this._api('POST', '/wrhp-api/api/v1/submission/novel/create_from_novel', { json: cfg });
    },

    // 蛙蛙自带整本排版，参数与站点默认设置一致。
    async apiStartFormat(baseNovelId) {
      return this._api('POST', `/wrhp-api/api/v2/novel/${baseNovelId}/chapters/format`, {
        json: { settings: { indent: true, blankLineRule: 'one', spaceRule: 'keep', deleteIndentRule: 'all' } },
      });
    },
    async apiFormatProgress(baseNovelId, taskId) {
      return this._api('GET', `/wrhp-api/api/v2/novel/${baseNovelId}/chapters/format/${taskId}/progress`);
    },

    // 作品结构：全部章节按 index 升序（站点返回是倒序的）
    async apiStructure(baseNovelId) {
      const d = await this._api('GET', `/wrhp-api/api/v2/novel/${baseNovelId}/structure`);
      const flat = [];
      if (Array.isArray(d?.volumes)) d.volumes.forEach(v => flat.push(...(v.chapters ?? [])));
      else if (Array.isArray(d?.chapters)) flat.push(...d.chapters);
      return flat.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    },

    // 提交投稿（chapter_ids 省略 = 全部）
    checkSubmissionQuota() { return checkQuota(); },
    async submitCounted(method,url,options,submissionId) {
      await beforeSubmit({submissionId});
      try { return await this._api(method,url,options); }
      catch(e){await onSubmitError(e);throw e;}
    },
    async apiSubmitSubmission(submissionId, chapterIds) {
      return this.submitCounted('POST', `/wrhp-api/api/v1/submission/novel/${submissionId}/submit`,
        chapterIds?.length ? { json: { chapter_ids: chapterIds } } : {}, submissionId);
    },

    // 已投稿作品：上传文件并入新章节
    async apiUpdateCreateFile(submissionId, localPath) {
      return this._api('POST', '/wrhp-api/api/v1/submission/update/create_file',
        { file: localPath, extra: { submission_id: String(submissionId) } });
    },

    // 已投稿作品：提交选中章节 → {success_count, failed_count, failed_list}
    async apiSubmitChapters(submissionId, chapterIds) {
      return this.submitCounted('POST', '/wrhp-api/api/v1/submission/update/submit_chapters',
        { json: { submission_id: submissionId, chapter_ids: chapterIds } },submissionId);
    },

    // 删除投稿记录（自检清理用）
    async apiDeleteSubmission(submissionId) {
      return this._api('DELETE', `/wrhp-api/api/v1/submission/novel/${submissionId}`);
    },

    async apiSubmissionDetail(submissionId) {
      return this._api('GET', `/wrhp-api/api/v1/submission/novel/${submissionId}`);
    },

    // 投稿记录（my_list 全量，POST 分页）：状态/签约/类目/字数
    async listSubmissions() {
      const items = await allPages((page, page_size) => this._api('POST', '/wrhp-api/api/v1/submission/novel/my_list', { json: { page, page_size } }), { size: 20, key: 'submission_id' });
      return items.map(i => ({ id: i.base_novel_id, sid: i.submission_id, title: i.title,
        storyType: i.story_type, channel: i.channel, cat: [i.cate1_name,i.cate2_name,i.cate3_name].filter(Boolean),
        status: i.status, contract: i.contract_status, reviewReason: i.review_reason ?? '', finishStatus:i.finish_status,
        meituan: i.meituan_shelf_status, words: i.total_word_count, finished: i.is_finished,
        submittedN: Array.isArray(i.submitted_chapter_ids) ? i.submitted_chapter_ids.length : null,
        campaign: i.campaign_name, entry: i.entry_type, submittedAt: i.submitted_at, penName: i.pen_name }));
    },

    // 单书收益（my_revenue）：总额 + 官方每日快照（latest=最新数据日，previous=前一日）
    async listRevenue() {
      if (!page) throw new Error('浏览器未启动');
      return page.evaluate(async () => {
        const r = await fetch('https://wawawriter.com/wrhp-api/api/v1/submission/novel/my_revenue', { credentials: 'include', signal: AbortSignal.timeout(30000) });
        const j = await r.json();
        return (j.data ?? []).map(x => ({
          id: x.base_novel_id, title: x.title,
          total: x.total_revenue ?? 0,
          latest: x.latest?.revenue ?? 0,
          follows: x.latest?.follow_user_cnt ?? 0,
          recent7d: (x.recent_7d ?? []).reduce((s, d) => s + (d.revenue || 0), 0),
          latestDate: x.latest?.date ?? null,
          latestRev: x.latest?.revenue ?? null,
          latestReaders: x.latest?.follow_user_cnt ?? null,
          latestOk: x.latest ? x.latest.available !== false : false,
        }));
      });
    },

    // 单书完整每日历史（revenue_history?period=all）：
    // 返回该书从首个数据日到今天的每日序列。items[].revenue=当日收益（增量），
    // follow_user_cnt=当日在读（null=该日无在读数据），available=false / 日期>=今天 = 占位行要剔除。
    async fetchRevenueHistory(sid) {
      if (!page) throw new Error('浏览器未启动');
      return page.evaluate(async (sidIn) => {
        const r = await fetch(
          `https://wawawriter.com/wrhp-api/api/v1/submission/novel/${encodeURIComponent(String(sidIn))}/revenue_history?period=all`,
          {
            credentials: 'include', signal: AbortSignal.timeout(30000),
            headers: { accept: 'application/json, text/plain, */*', 'x-client-channel': 'web', 'x-client-platform': 'pc' },
          });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!j || j.code !== 200 || !j.data) throw new Error(j?.message || '历史接口返回异常');
        const d = j.data;
        return {
          total: d.total_revenue ?? 0,
          startDate: d.start_date ?? null,
          endDate: d.end_date ?? null,
          items: (d.items ?? []).map(it => ({
            date: it.date, r: it.revenue ?? 0,
            f: it.follow_user_cnt == null ? null : it.follow_user_cnt,
            ok: it.available !== false,
          })),
        };
      }, sid);
    },

    // 批量拉取多本书的每日历史：低速串行 + 连续失败退避（站点对高频历史接口限流）
    async fetchRevenueHistories(sids, options = {}) {
      return fetchConcurrent(sids, sid=>this.fetchRevenueHistory(sid), options);
    },

    /* ---------------- 表单操作 ---------------- */

    async _clickRadio(groupName, label) {
      const radio = page.locator('.el-radio').filter({ has: page.locator('.el-radio__label', { hasText: exactRe(label) }) });
      const n = await radio.count();
      if (n === 0) {
        const all = await page.locator('.el-radio .el-radio__label').allTextContents();
        throw new Error(`找不到「${groupName}」选项「${label}」。可选项：${all.map(t => t.trim()).join('、')}`);
      }
      const first = radio.first();
      const cls = await first.getAttribute('class');
      if (cls.includes('is-disabled')) throw new Error(`「${groupName}」选项「${label}」当前不可选（站点限制）`);
      if (cls.includes('is-checked')) { log(`${groupName}：${label}（已是选中状态）`); return; }
      await first.click();
      await page.waitForTimeout(300);
      log(`${groupName}：${label}`);
    },

    async _hasRadio(label) {
      return (await page.locator('.el-radio').filter({
        has: page.locator('.el-radio__label', { hasText: exactRe(label) }),
      }).count()) > 0;
    },

    async _chooseFromWorks(title) {
      log(`从站内作品选择：${title}`);
      await page.getByRole('button', { name: '从作品选择' }).click();
      const dialog = page.locator('.el-dialog:visible');
      await dialog.waitFor({ state: 'visible' });
      await page.waitForTimeout(1500);

      const findItem = () => dialog.locator('p').filter({ hasText: exactRe(title) });
      const itemCount = () => page.evaluate(() => {
        const dlg = document.querySelector('.el-dialog');
        return dlg ? dlg.querySelectorAll('p').length : -1;
      });
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
    },

    async _uploadLocalFile(filePath) {
      log(`上传本地文件：${filePath}`);
      await page.locator('input[type="file"][accept=".docx,.doc,.txt"]').setInputFiles(filePath);
      log('等待文件解析（最长 180 秒）…');
      const readToasts = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('.el-message')).map(m => ({
          text: (m.textContent || '').trim(),
          error: m.className.includes('error'),
        }))
      );
      const formFilled = () => page.evaluate(() => {
        const name = document.querySelector('input[placeholder*="作品名称"]')?.value ?? '';
        const words = document.querySelector('input[placeholder*="作品字数"]')?.value ?? '';
        return (name && name.trim()) || (words && Number(words) > 0);
      });
      let clickedNext = false;
      for (let i = 0; i < 120; i++) {
        await page.waitForTimeout(1500);
        // 站点报错直接失败
        const toasts = await readToasts();
        const err = toasts.find(t => t.error);
        if (err) throw new Error(`站点报错：${err.text}`);
        // 大文件解析完会弹「预览章节内容」对话框，点「下一步」确认导入
        if (!clickedNext) {
          const dlg = page.locator('[aria-label="预览章节内容"]');
          if (await dlg.count()) {
            const next = dlg.getByRole('button', { name: '下一步' });
            if (await next.count()) {
              await next.click();
              clickedNext = true;
              log('已确认章节预览（点击下一步）…');
              await page.waitForTimeout(2000);
              continue;
            }
          }
        }
        if (await formFilled()) {
          log('文件解析完成。');
          return;
        }
        if (i > 0 && i % 10 === 0) log(`仍在解析… 已等 ${(i * 1.5).toFixed(0)} 秒`);
      }
      log('警告：文件解析超时未回填，继续后续步骤（名称/字数将用配置值覆盖）。');
    },

    async _uploadCover(coverPath) {
      log(`上传封面：${coverPath}`);
      // 上传文稿后站点会追加第二个图片 input（换封面用），取第一个（主封面位）
      const input = page.locator('input[type="file"][accept*="image"]').first();
      await input.setInputFiles(coverPath);
      await page.waitForTimeout(2000);
      const errToast = await page.evaluate(() => {
        const m = Array.from(document.querySelectorAll('.el-message')).find(x => x.className.includes('error'));
        return m ? m.textContent.trim() : null;
      });
      if (errToast) throw new Error(`封面上传失败：${errToast}`);
      log('封面上传完成。');
    },

    async _pickCategory(segments) {
      log(`选择小说类目：${segments.join(' / ')}`);
      await page.locator('input[placeholder*="小说类目"]').click();
      await page.locator('.el-cascader__dropdown:visible').first().waitFor({ state: 'visible' });
      for (const seg of segments) {
        const node = page.locator('.el-cascader__dropdown:visible .el-cascader-menu').last()
          .locator('.el-cascader-node').filter({ hasText: exactRe(seg) });
        const n = await node.count();
        if (n === 0) throw new Error(`小说类目中找不到「${seg}」，请检查三级路径`);
        await node.first().click();
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(600);
      const val = await page.evaluate(() => {
        const byPh = document.querySelector('input[placeholder*="小说类目"]');
        if (byPh) return byPh.value;
        for (const c of document.querySelectorAll('.el-cascader')) {
          const inp = c.querySelector('input');
          if (inp && inp.value) return inp.value;
        }
        return null;
      });
      if (!val || !val.includes(segments[2])) throw new Error(`类目回填异常：${val}`);
      log(`类目已回填：${val}`);
    },

    async _pickTags(tags) {
      if (!tags.length) return;
      const expand = page.getByRole('button', { name: '展开' });
      if (await expand.count() === 1 && await expand.isVisible().catch(() => false)) {
        await expand.click();
        await page.waitForTimeout(400);
      }
      for (const tag of tags) {
        const chip = page.locator('div.flex.flex-wrap.gap-2 > div').filter({ hasText: exactRe(tag) });
        if ((await chip.count()) === 0) throw new Error(`作品标签中找不到「${tag}」`);
        const el = chip.first();
        if (!(await el.getAttribute('class')).includes('E8F8F2')) {
          await el.click();
          await page.waitForTimeout(300);
        }
        if (!(await el.getAttribute('class')).includes('E8F8F2')) throw new Error(`标签「${tag}」未选中（可能超数量上限）`);
        log(`标签：${tag}`);
      }
    },

    async _addCustomTags(tags) {
      for (const t of tags) {
        await page.locator('input[placeholder*="自定义标签"]').fill(t);
        await page.waitForTimeout(300);
        const addBtn = page.getByRole('button', { name: '添加' });
        if (!(await addBtn.isEnabled())) throw new Error(`自定义标签「${t}」无法添加`);
        await addBtn.click();
        await page.waitForTimeout(400);
        log(`自定义标签：${t}`);
      }
    },

    async _dumpFormState() {
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
    },

    // 主流程：填写并（可选）提交一篇
    async submitOne(cfg, { submit = false } = {}) {
      if (!page) throw new Error('浏览器未启动');
      // 1. 确保在表单页
      if ((await page.locator('input[placeholder*="作品名称"]').count()) === 0) {
        await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }
      // 2. 作品来源（先切入口/分类再开弹窗）
      if (cfg.localFile) {
        await api._uploadLocalFile(cfg.localFile);
      } else {
        await api._clickRadio('投稿入口', cfg.entry);
        if (await api._hasRadio(cfg.category)) await api._clickRadio('作品分类', cfg.category);
        else log(`警告：入口下没有「${cfg.category}」选项，跳过分类切换。`);
        await api._chooseFromWorks(cfg.sourceTitle);
      }
      // 3. 名称
      const titleInput = page.locator('input[placeholder*="作品名称"]');
      const autoTitle = await titleInput.inputValue();
      if (cfg.title && cfg.title !== autoTitle) {
        await titleInput.fill(cfg.title);
        log(`作品名称：${cfg.title}（覆盖自动回填）`);
      } else log(`作品名称：${autoTitle}（自动回填）`);
      // 4. 封面
      await api._uploadCover(cfg.cover);
      // 5. 笔名 / 字数
      await page.locator('input[placeholder*="笔名"]').fill(cfg.penName);
      log(`笔名：${cfg.penName}`);
      if (cfg.wordCount) {
        await page.locator('input[placeholder*="作品字数"]').fill(String(cfg.wordCount));
        log(`作品字数：${cfg.wordCount}（指定）`);
      } else {
        const wc = await page.locator('input[placeholder*="作品字数"]').inputValue();
        log(`作品字数：${wc || '（空）'}（自动解析）`);
      }
      // 6. 单选组
      await api._clickRadio('投稿入口', cfg.entry);
      if (await api._hasRadio(cfg.category)) await api._clickRadio('作品分类', cfg.category);
      await api._clickRadio('作品频道', cfg.channel);
      await api._clickRadio('作品状态', cfg.status);
      // 7. 类目 / 标签 / 简介
      await api._pickCategory(cfg.novelType);
      await api._pickTags(cfg.tags);
      await api._addCustomTags(cfg.customTags);
      if (cfg.intro) {
        await page.locator('textarea[placeholder*="作品简介"]').fill(cfg.intro);
        log(`作品简介：已填写（${cfg.intro.length} 字）`);
      }
      // 8. 状态核对 + 截图
      const state = await api._dumpFormState();
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base = (cfg.title || cfg.sourceTitle || '投稿').slice(0, 20);
      const shot = path.join(OUTPUT_DIR, `${ts}-${base}-表单.png`);
      await page.screenshot({ path: shot, fullPage: true });
      log('表单填写完成，已截图。');

      if (!submit) {
        log('【干跑模式】未提交。确认截图无误后可真实提交。');
        return { ok: true, dryRun: true, screenshot: shot, state };
      }
      // 9. 真实提交
      log('提交投稿 ...');
      await page.getByRole('button', { name: '提交' }).click();
      await page.waitForTimeout(1500);
      const msgBox = page.locator('.el-message-box:visible');
      if ((await msgBox.count()) > 0) {
        const boxText = (await msgBox.innerText()).replace(/\s+/g, ' ').slice(0, 120);
        log(`站点弹窗确认：${boxText}`);
        await msgBox.getByRole('button', { name: /确定|确认|投稿/ }).first().click();
      }
      let result = { ok: false, messages: [] };
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(1000);
        const toasts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.el-message')).map(m => ({
            text: (m.textContent || '').trim(),
            type: m.className.includes('error') ? 'error' : m.className.includes('success') ? 'success' : 'info',
          }))
        );
        if (toasts.length) result.messages = toasts.map(t => `[${t.type}] ${t.text}`);
        if (toasts.some(t => t.type === 'success') || /\/app\/submission\/?$/.test(page.url())) { result.ok = true; break; }
        if (toasts.some(t => t.type === 'error')) break;
      }
      const shot2 = path.join(OUTPUT_DIR, `${ts}-${base}-结果.png`);
      await page.screenshot({ path: shot2, fullPage: true });
      result.screenshot = shot2;
      if (result.ok) log('✅ 投稿提交成功！', result.messages.join(' '));
      else log('⚠️ 提交结果未知或失败：', result.messages.join(' ') || '未捕获到站点提示');
      return result;
    },
  };
  return api;
}
