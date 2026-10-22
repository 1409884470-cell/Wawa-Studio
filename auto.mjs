import { buildCoverPrompt, inferCoverStyle } from './cover-prompt.mjs';
// 自动化引擎：解析小说 → AI/本地 生成标题·简介·封面 → 自动推导分类/标签
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { RES_DIR, userPath } from './paths.mjs';
import { loadSiteData, loadSettings } from './core.mjs';

const __dirname = RES_DIR;                       // 只读资源（脚本）
export const COVER_DIR = userPath('covers');     // 可写：生成的封面

/* ================= AI 接口（OpenAI 兼容） ================= */

function aiConfigured() {
  const s = loadSettings();
  return !!(s.apiBaseUrl && s.apiKey && s.textModel);
}
function imageAiConfigured() {
  const s = loadSettings();
  return !!(s.imgApiBaseUrl && s.imgApiKey && s.imageModel);
}

export async function chat(messages, { json = false, maxTokens = 800, settings } = {}) {
  const s = settings ?? loadSettings();
  const base = s.apiBaseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({
      model: s.textModel,
      messages,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!r.ok) throw new Error(`AI 接口 ${r.status}：${(await r.text()).slice(0, 150)}`);
  const data = await r.json();
  if (data.choices?.[0]?.finish_reason === 'length') throw new Error('文本 AI 输出达到长度上限，结果已截断，请调整模型或章节长度');
  const text = data.choices?.[0]?.message?.content ?? '';
  return text.trim();
}

// 取正文样本：开头 + 中段 + 结尾（喂给 AI 足够判断题材）
function sampleText(text, max = 2600) {
  const clean = text.replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const head = clean.slice(0, Math.floor(max * 0.5));
  const mid = clean.slice(Math.floor(clean.length / 2), Math.floor(clean.length / 2) + Math.floor(max * 0.3));
  const tail = clean.slice(-Math.floor(max * 0.2));
  return head + '\n……\n' + mid + '\n……\n' + tail;
}

// AI 生成标题（爆款网文风格，返回数组供挑选/换一换）
export async function aiTitles(text, { channel, count = 5, extra = '' }) {
  const s = sampleText(text);
  const out = await chat([
    { role: 'system', content: '你是资深网文编辑，擅长起爆款书名。只输出 JSON。' },
    { role: 'user', content: `根据小说内容起 ${count} 个${channel || ''}向爆款书名（15-25字，悬念+冲突感，不带书名号）。输出 {"titles": ["...", ...]}\n补充要求：${extra || '无'}\n\n小说内容：${s}` },
  ], { json: true });
  const m = out.match(/\{[\s\S]*\}/);
  const arr = m ? (JSON.parse(m[0]).titles ?? []) : [];
  return arr.filter(t => typeof t === 'string' && t.length >= 6 && t.length <= 40).slice(0, count);
}

// AI 生成简介
export async function aiIntro(text, title, { channel, wordCount, extra = '' }) {
  const s = sampleText(text, 1800);
  const out = await chat([
    { role: 'system', content: '你是资深网文编辑，写投稿简介。只输出简介正文。' },
    { role: 'user', content: `为《${title}》写一段投稿简介（120-220字，${channel || ''}向：先抛核心冲突/金手指，再留钩子，口语化短句，不用"本书""故事讲述了"这类词，不剧透结局）。\n补充要求（优先满足）：${extra || '无'}\n\n小说内容：${s}` },
  ], { maxTokens: 500 });
  return out.replace(/^["“]|["”]$/g, '').slice(0, 500);
}

// AI 生成封面绘画提示词（走文本 AI：更懂剧情；生成图片才走图像 AI）
export async function aiCoverPromptGen(text, title, { channel, ruleName, intro, extra = '' }) {
  const s = sampleText(text, 800);
  const out = await chat([
    { role: 'system', content: '你是资深网文封面画师。根据小说信息为 AI 绘画模型写中文提示词。只输出提示词本身，不要解释。' },
    { role: 'user', content: `为《${title}》提取适合剧情的封面画风（${channel}，题材：${ruleName}）。搞笑剧情用搞笑插画，小孩主角或儿童故事用卡通风格，其他题材按剧情情绪判断。只输出一个不超过20字的画风名称，不附加人物外貌、服装、动作或表情描写，不指定颜色、配色、饱和度、冷暖色或色彩数量，不输出书名署名、背景或构图要求。\n补充要求：${extra || '无'}\n简介：${(intro || '').slice(0, 120)}\n内容节选：${s}` },
  ], { maxTokens: 300 });
  return out.replace(/^["“]|["”]$/g, '').trim();
}

// 去AI味：重写单章正文（剧情/信息完全不变，只调表达）。customPrompt 留空用内置默认要求
export async function deAiChapter(chName, text, customPrompt) {
  const req = (customPrompt && customPrompt.trim()) ||
    '改写这章小说正文，去掉AI写作痕迹：长短句交错，删除"然而/随着/不禁/仿佛/似乎"等模板化用词和四字词堆砌，对话更口语化，叙述更贴人物视角；剧情、对话信息、人物设定、事实细节必须完全保留，不增删情节，不改人称与时态，字数与原文大致相当。直接输出改写后的正文，不要任何说明和标题。';
  const out = await chat([
    { role: 'system', content: '你是资深网文作者，擅长把AI味重的正文改得像真人手写。只输出改写后的正文本身。' },
    { role: 'user', content: `${req}\n\n章节《${chName}》原文：\n${text}` },
  ], { maxTokens: 8000 });
  const clean = out.replace(/^["“']|["”']$/g, '').trim();
  if (clean.length < text.length * 0.5) throw new Error(`改写结果过短（${clean.length}/${text.length} 字），疑似截断，保留原文`);
  return clean;
}

// 测试连接：文本 AI 发一条极短消息
export async function aiPing(settings) {
  const out = await chat([{ role: 'user', content: '只回复两个字：正常' }], { maxTokens: 256, settings });
  if(!out.trim())throw new Error('模型返回空回复');
  return out.slice(0, 100);
}

// 测试连接：图像 AI 生成一张最小图（会产生极小费用）
export async function imageAiPing(settings) {
  const s = settings ?? loadSettings();
  const base = s.imgApiBaseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/images/generations') ? base : base + '/images/generations';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.imgApiKey}` },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({ model: s.imageModel, prompt: 'a solid green circle, minimal test', size: '1024x1536', response_format: 'b64_json' }),
  });
  if (!r.ok) throw new Error(`图像接口 ${r.status}：${(await r.text()).slice(0, 120)}`);
  const data = await r.json();
  const item = data.data?.[0] ?? {};
  if (!item.b64_json && !item.url) throw new Error('图像接口未返回图片');
  return 'ok';
}

// AI 生成封面（OpenAI 兼容 images 接口，独立配置）
export async function aiCover(title, intro, { channel, ruleName }) {
  const s = loadSettings();
  const base = s.imgApiBaseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/images/generations') ? base : base + '/images/generations';
  const style=aiConfigured()?await aiCoverPromptGen(intro,title,{channel,ruleName,intro}):inferCoverStyle(intro);
  const prompt=buildCoverPrompt(s,{title,penName:s.penName,channel,genre:ruleName,style});
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.imgApiKey}` },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({ model: s.imageModel, prompt, size: '1024x1536', response_format: 'b64_json' }),
  });
  if (!r.ok) throw new Error(`封面接口 ${r.status}：${(await r.text()).slice(0, 150)}`);
  const data = await r.json();
  const item = data.data?.[0] ?? {};
  const b64 = item.b64_json;
  let buf = null;
  if (b64) buf = Buffer.from(b64, 'base64');
  else if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!img.ok) throw new Error('封面图下载失败');
    buf = Buffer.from(await img.arrayBuffer());
  }
  if (!buf) throw new Error('封面接口未返回图片');
  fs.mkdirSync(COVER_DIR, { recursive: true });
  const file = path.join(COVER_DIR, `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)}-AI.png`);
  fs.writeFileSync(file, buf);
  return file;
}

export { aiConfigured, imageAiConfigured };

/* ================= 本地兜底 ================= */

/* ---------- 文本头部清理：去书名/简介头、作者信息、分隔符号 ---------- */

// 单行是「分隔线/页眉页脚符号」：短且几乎全是重复符号
const isSeparatorLine = (l) => {
  const t = l.replace(/[\s\u3000]/g, '');
  if (!t || t.length > 80) return false;
  return /^[-—–_=+*~·#※◇◆□■■●◎╬═│┃╔╚╠╣╭╮╰╯★☆✦✧{}【】\[\]()（）<>《》:：;；,，.。!！?？/\\|]{2,}$/.test(t)
    || /^(.)\1{2,}$/.test(t);   // 同一字符重复 3 次以上
};

// 元信息行：书名：xxx / 作者：xxx / 简介：xxx / 字数：xxx / 【书名】等开头块
const isMetaLine = (l) => {
  const t = l.trim();
  if (!t) return false;
  if (/^(书名|文章名|作品名|小说名|标题)\s*[：:]/.test(t)) return true;
  if (/^(作者|笔名|著)\s*[：:]/.test(t)) return true;
  if (/^(字数|总字数|篇幅)\s*[：:]/.test(t)) return true;
  if (/^(简介|内容简介|文案|摘要|书介)\s*[：:]?\s*$/.test(t)) return true;
  if (/^《.+》$/.test(t) && t.length <= 32) return true;          // 单独一行书名号
  return false;
};

// 简介多行块的结束：遇到章节标题或分隔线停
const isChapterHead = (l) => /^(第[0-9０-９零〇一二两三四五六七八九十百千万]+[章节回卷]|序章|楔子|序言|正文|番外|尾声|终章|Chapter\s+\d+|[0-9０-９]{1,4}[.．、]\s*\S)/i.test(l.trim());

export function cleanHead(text, { keepIntro = false } = {}) {
  const normalized=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const first=normalized.search(/^(?:\s*#{1,6}\s*)?(?:[【\[])?第(?:一|1|１|01|０１)章[^\n]*$/m);
  if(first>=0){
    const pre=normalized.slice(0,first);
    const mark=pre.match(/(?:^|\n)\s*[【\[（(]?(?:内容简介|作品简介|小说简介|简介|文案|摘要|书介)[】\]）)]?\s*[:：]?\s*/);
    let intro=mark?pre.slice(mark.index+mark[0].length).trim():'';
    intro=intro.split(/\n\s*(?:大纲|细纲|序言|前言|正文|作者|笔名)[：:\s]/)[0].trim();
    intro=intro.split('\n').filter(l=>!isSeparatorLine(l)).join('\n').trim();
    return {body:normalized.slice(first).trim(),intro};
  }
  // 全局剔除「纯分隔线」行（页眉页脚/章节分隔，如 ---- ==== ***）；
  // 注意：【】括起来的正文内容行不是分隔线，不受影响。
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let i = 0;
  const introLines = [];
  let introMode = false;
  // 头部区：最多看 60 行，遇到第一个章节标题停止
  for (; i < Math.min(lines.length, 60); i++) {
    const t = lines[i].trim();
    if (!t || isSeparatorLine(t)) continue;
    if (isChapterHead(lines[i])) break;
    // 「【简介】」/「[简介]」独立标记行 → 进入简介收集
    if (/^[【\[\(]\s*(简介|内容简介|文案|摘要)\s*[】\]\)]?$/.test(t)) { introMode = true; continue; }
    // 「简介：xxx」带内容
    const m = t.match(/^(?:【\[\(])?(?:简介|内容简介|文案|摘要)(?:】\]\))?\s*[：:]\s*(.+)$/);
    if (m) { introLines.push(m[1].trim()); introMode = true; continue; }
    if (isMetaLine(lines[i])) continue;      // 书名：/作者：/《书名》
    if (introMode) {
      // 无明确章节标题时，简介只取一个段落，避免将正文误吞进简介。
      if (i > 0 && !lines[i - 1].trim()) break;
      introLines.push(t);                     // 简介正文续行
      if (introLines.join('').length >= 400) break;
      continue;
    }
    // 头部里既不是元信息也不是章节头的短句：视为宣传语，归入简介
    // 不猜测短句是宣传语：未明确标记的所有文字都保留为正文。
    break;                                    // 其余视作正文开始
  }
  const body = lines.slice(i).join('\n').trim();
  return { body: body, intro: introLines.join(' ').trim() };
}

export function decodeText(buf) {
  if (buf[0] === 255 && buf[1] === 254) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 254 && buf[1] === 255) return new TextDecoder('utf-16be').decode(buf);
  let t = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (t.includes('\uFFFD')) {
    try { t = new TextDecoder('gbk').decode(buf); } catch { /* 保留原样 */ }
  }
  return t;
}

/* ---------- txt 解析 ---------- */

export function manuscriptTitle(raw, fallback) {
  // Only inspect the header before a contents marker or first chapter.
  const lines=raw.replace(/^\uFEFF/,'').split(/\r?\n/),header=[];
  for(const line of lines.slice(0,30)){
    if(/^\s*(?:目\s*录|第[一二三四五六七八九十百零〇两0-9０-９]+[章节回]|序章|楔子)/.test(line))break;
    header.push(line.trim());
  }
  const first=header.find(Boolean)||'';
  const explicit=first.match(/^(?:书名|作品名|小说名|文章名)\s*[：:]\s*(.+)$/);
  if(explicit)return explicit[1].trim().replace(/^《|》$/g,'');
  if(/^《[^《》]+》$/.test(first)&&first.length<=32)return first.slice(1,-1);
  return fallback.replace(/__(?:book_)?[a-f0-9-]{8,}$/i,'');
}

export function parseTxt(fp) {
  const raw = decodeText(fs.readFileSync(fp));
  const fileName = path.basename(fp).replace(/\.txt$/i, '');
  // 清理头部：去书名/简介/作者元信息和分隔线，提取正文与文案
  const { body: cleaned, intro: headIntro } = cleanHead(raw);
  const title = manuscriptTitle(raw,fileName);
  // 找第一章起点（清理后的正文里再定位一次）
  let body = cleaned;
  const ch1 = cleaned.match(/(第[一1１][章节回][^\n]{0,30}|序章[^\n]{0,20}|楔子[^\n]{0,20})/);
  if (ch1 && ch1.index > 0 && ch1.index < 3000) body = cleaned.slice(ch1.index);
  // 字数按正文统计（剔除头部元信息）
  const wordCount = cleaned.replace(/\s/g, '').length;
  const chapters = extractChaptersFromText(cleaned, { alreadyClean: true }).length;
  return { title, body: cleaned, wordCount, chapters, headIntro, text: cleaned, rawText: raw };
}

/* ---------- docx 解析（PowerShell 解压 document.xml） ---------- */

export async function parseDocx(fp) {
  const xml = await new Promise((resolve, reject) => {
    const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${fp.replace(/'/g, "''")}'); try { $e=$z.GetEntry('word/document.xml'); $r=New-Object IO.StreamReader($e.Open(),[Text.Encoding]::UTF8); $x=$r.ReadToEnd(); $r.Close() } finally { $z.Dispose() }; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $x`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(new Error('docx 解析失败：' + err.message.split('\n')[0]));
      else resolve(stdout);
    });
  });
  // w:p → 段落，w:t → 文本
  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
    .map(p => [...p[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join(''))
    .map(s => s.replace(/&#x([\da-f]+);/gi, (_,n) => String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g, (_,n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
    .filter(Boolean);
  const raw = paras.join('\n');
  const { body: cleaned, intro: headIntro } = cleanHead(raw);
  const fileName = path.basename(fp).replace(/\.docx?$/i, '');
  const title = manuscriptTitle(raw,fileName);
  let body = cleaned;
  const ch1 = cleaned.match(/(第[一1１][章节回][^\n]{0,30}|序章[^\n]{0,20}|楔子[^\n]{0,20})/);
  if (ch1 && ch1.index > 0 && ch1.index < 3000) body = cleaned.slice(ch1.index);
  const wordCount = cleaned.replace(/\s/g, '').length;
  const chapters = extractChaptersFromText(cleaned, { alreadyClean: true }).length;
  return { title, body: cleaned, wordCount, chapters, headIntro, text: cleaned, rawText: raw };
}

export const parseNovelFile = (fp) => {
  if (/\.doc$/i.test(fp)) throw new Error('请先将旧版 .doc 文件另存为 .docx 或 .txt');
  return /\.docx$/i.test(fp) ? parseDocx(fp) : parseTxt(fp);
};

export async function readNovelChapters(fp) {
  const parsed = await parseNovelFile(fp);
  return extractChaptersFromText(parsed.text, { alreadyClean: true });
}

/* ---------- 题材识别：关键词规则 → 频道/类目/标签 ---------- */

const RULES = [
  { name: '女频世情复仇',
    kw: ['渣夫', '离婚', '婆婆', '继子', '小叔', '前夫', '净身出户', '代孕', '同妻', '假死', '改嫁', '逼婚', '生子', '小三', '白月光', '外遇', '出轨'],
    channel: '女频', cat: ['女频', '情感小说'], tags: ['世情', '复仇', '爽文'], colors: ['#c2447a', '#5a1d3f'] },
  { name: '女频豪门甜宠',
    kw: ['总裁', '豪门', '霸总', '契约结婚', '闪婚', '首富', '大佬', '宠妻', '娇妻', '夫人'],
    channel: '女频', cat: ['女频', '都市言情', '总裁豪门'], tags: ['豪门霸总', '甜宠'], colors: ['#b03a5b', '#4a1530'] },
  { name: '女频古装宅斗',
    kw: ['重生', '嫡女', '庶女', '侯府', '王府', '宅斗', '宫斗', '娘娘', '公主', '丫鬟', '将军府', '摄政王', '太子'],
    channel: '女频', cat: ['女频', '古装言情'], tags: ['重生', '穿越'], colors: ['#8a5a2b', '#3d2412'] },
  { name: '女频年代',
    kw: ['年代', '七零', '六零', '八零', '知青', '供销社', '大队', '工分'],
    channel: '女频', cat: ['女频', '年代小说'], tags: ['年代', '重生'], colors: ['#7a6a3a', '#332c14'] },
  { name: '男频都市脑洞',
    kw: ['系统', '金手指', '开局', '签到', '升级', '直播', '外卖', '神豪', '返现', '校花'],
    channel: '男频', cat: ['男频', '都市小说', '都市脑洞'], tags: ['脑洞', '爽文'], colors: ['#2f6fb0', '#122c4d'] },
  { name: '男频仙侠玄幻',
    kw: ['修仙', '灵气', '宗门', '境界', '筑基', '元婴', '金丹', '灵石', '妖兽', '洞府', '长老'],
    channel: '男频', cat: ['男频', '仙侠武侠'], tags: ['仙侠', '热血'], colors: ['#3b2f8f', '#14104d'] },
  { name: '男频末世',
    kw: ['末世', '丧尸', '囤货', '避难所', '灾变', '天灾'],
    channel: '男频', cat: ['男频', '科幻末世'], tags: ['末世', '囤物资'], colors: ['#3d5a3d', '#141f14'] },
  { name: '悬疑',
    kw: ['凶手', '案发', '侦探', '破案', '尸体', '警察', '法医', '悬案'],
    channel: '男频', cat: ['男频', '悬疑小说'], tags: ['悬疑', '烧脑'], colors: ['#4a4a55', '#17171d'] },
];

// 类目路径校验：三级不齐时从站点树里补全
function resolveCategory(siteTree, prefix) {
  const [a, b, c] = prefix;
  const l1 = siteTree[a] ? a : Object.keys(siteTree)[0];
  const l2List = siteTree[l1] || {};
  const l2 = l2List[b] ? b : (Object.keys(l2List)[0] ?? '');
  const l3List = l2List[l2] || [];
  const l3 = l3List.includes(c) ? c : (l3List[0] ?? '');
  return [l1, l2, l3];
}

export function deriveMeta(text, title) {
  const site = loadSiteData();
  // 关键词命中计分
  let best = null, bestScore = 0;
  for (const rule of RULES) {
    let score = 0;
    for (const kw of rule.kw) {
      const hits = text.split(kw).length - 1;
      if (hits > 0) score += Math.min(hits, 5);
    }
    // 标题命中权重加倍
    for (const kw of rule.kw) if (title.includes(kw)) score += 3;
    if (score > bestScore) { bestScore = score; best = rule; }
  }
  const fallback = { name: '题材待确认', channel: '', cat: [], tags: [], colors: ['#5a7a9a', '#1d2f42'] };
  const rule = bestScore >= 2 ? best : fallback;
  const novelType = bestScore >= 2 ? resolveCategory(site.tree, rule.cat) : [];
  return {
    ruleName: rule.name,
    channel: rule.channel,
    novelType,
    tags: rule.tags.filter(t => site.tags.includes(t)).slice(0, 3),
    colors: rule.colors,
  };
}

/* ---------- 简介自动生成（第一章钩子摘录） ---------- */

export function buildIntro(body, wordCount) {
  let s = (body || '').replace(/\s+/g, ' ').trim();
  // 去掉章名
  s = s.replace(/^第[0-9零一二两三四五六七八九十百千]+[章节回][^ ]*/, '').trim();
  if (!s) return '';
  // 取前 260 字中的完整句
  let cut = s.slice(0, 280);
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  if (lastStop > 80) cut = cut.slice(0, lastStop + 1);
  else cut = cut.slice(0, 200) + '……';
  if (cut.length > 280) cut = cut.slice(0, 277) + '……';
  return `本文${wordCount >= 10000 ? (wordCount / 10000).toFixed(1) + '万' : wordCount}字。` + cut;
}

/* ---------- 章节范围切割：按章标题切出 from..to 生成临时稿 ---------- */

const CH_HEAD_RE = /^([ \t\u3000]*(?:第[0-9０-９零〇一二两三四五六七八九十百千万]+[章节回][^\n]{0,50}|(?:序章|楔子|序言|番外|尾声|终章)[^\n]{0,30}|Chapter[ \t]+\d+[^\n]{0,50}|[0-9０-９]{1,4}[.．、][ \t]*[^\n]{1,40}))[ \t]*$/gim;

// 返回临时文件路径；range 无效或章节数不足时返回 null（= 全量用原文件）
export function sliceNovelByRange(srcFile, from, to) {
  const raw = decodeText(fs.readFileSync(srcFile));
  const { body } = cleanHead(raw);
  const matches = [...body.matchAll(CH_HEAD_RE)];
  if (matches.length < 2) return null;                      // 没有可切分的章节结构
  from = Math.max(1, Number(from) || 1);
  to = Math.min(matches.length, Number(to) || matches.length);
  if (from > to || from < 1) return null;
  const start = matches[from - 1].index;
  const end = to < matches.length ? matches[to].index : body.length;
  const sliced = body.slice(start, end).trim();
  const tmpDir = userPath('tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.basename(srcFile).replace(/\.(txt|docx?)$/i, '');
  const tmp = path.join(tmpDir, `${base}-第${from}-${to}章.txt`);
  fs.writeFileSync(tmp, sliced, 'utf8');
  return tmp;
}

// 把清理后的正文切成 [{name, text}]（API 直连 create_from_file 用）；
// 自动剔除空白章节（无正文/纯符号），避免投稿被站点拒收；无章节标题时整篇作为单章
export function extractChapters(srcFile) {
  if (/\.docx?$/i.test(srcFile)) throw new Error('Word 稿件需要使用 readNovelChapters 解析');
  const raw = decodeText(fs.readFileSync(srcFile));
  return extractChaptersFromText(raw);
}

export function extractChaptersFromText(raw, { alreadyClean = false } = {}) {
  const body = alreadyClean ? raw.trim() : cleanHead(raw).body;
  const matches = [...body.matchAll(CH_HEAD_RE)];
  if (matches.length === 0) {
    const text = body.trim();
    return text ? [{ name: '正文', text }] : [];
  }
  const chapters = [];
  const prefix = body.slice(0, matches[0].index).trim();
  if (prefix) chapters.push({ name: '前言', text: prefix });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const text = body.slice(start, end).trim();
    // 空白章节：无有效内容（去空白后为空，或仅剩分隔线/少于 10 字的占位）
    const compact = text.replace(/[=\-—_*#·•\s]/g, '');
    // 保留空章及极短章，体检报告提示处理；不能静默删掉用户正文。
    chapters.push({ name: matches[i][1].trim(), text });
  }
  return chapters;
}

export function auditManuscript(parsed) {
  const chapters = extractChaptersFromText(parsed.text, { alreadyClean: true });
  const warnings = [];
  const seen = new Set();
  chapters.forEach((c, i) => {
    if (c.text.replace(/\s/g, '').length < 10) warnings.push(`第${i + 1}章「${c.name}」正文不足10字，请核对`);
    if (seen.has(c.name)) warnings.push(`章名重复：「${c.name}」`);
    seen.add(c.name);
  });
  if (parsed.text.includes('\uFFFD')) warnings.push('存在无法解码字符，请检查文件编码');
  if (chapters.length === 1 && chapters[0]?.name === '正文' && parsed.wordCount > 20000) warnings.push('长稿未识别到章节标题，请检查分章格式');
  if (chapters[0]?.name === '前言') warnings.push('首章之前存在正文，已保留为前言，请核对');
  if (/^[ \t]*第[^\n]{1,20}卷/m.test(parsed.text)) warnings.push('检测到卷标题，请核对章节预览中的卷信息');
  const nums = chapters.map(c => c.name.match(/^第([0-9０-９]+)[章节回]/)?.[1]).filter(Boolean).map(x => Number(x.normalize('NFKC')));
  if (nums.some((n,i) => i && n !== nums[i - 1] + 1)) warnings.push('数字章节编号不连续，请检查是否缺章或重复');
  return { chapters, warnings: [...new Set(warnings)], words: chapters.reduce((n,c) => n + c.text.replace(/\s/g,'').length, 0) };
}

/* ---------- 本地兜底：标题/简介候选变体 ---------- */

export function localTitleVariants(title, intro, body) {
  const out = [title];
  const src = intro || body || '';
  // 从简介/正文里抽短句做候选（12-24字、有冲突感的句子）
  const sentences = src.replace(/\s+/g, '').split(/[。！？；]/).filter(s => s.length >= 12 && s.length <= 26);
  for (const s of sentences.slice(0, 4)) out.push(s);
  return [...new Set(out)].slice(0, 5);
}

export function localIntroVariants(body, wordCount) {
  const variants = [];
  const clean = (body || '').replace(/\s+/g, ' ').trim();
  if (clean) {
    // 变体1：开头钩子
    variants.push(buildIntro(body, wordCount));
    // 变体2：中段冲突
    const mid = clean.slice(Math.floor(clean.length * 0.3), Math.floor(clean.length * 0.3) + 280);
    const stop = Math.max(mid.lastIndexOf('。'), mid.lastIndexOf('！'));
    variants.push('本文精彩片段：' + (stop > 60 ? mid.slice(0, stop + 1) : mid.slice(0, 200) + '……'));
    // 变体3：结尾悬念（倒着找完整句）
    const tail = clean.slice(-300);
    const t2 = tail.slice(tail.indexOf('。') + 1 || 0);
    variants.push((t2 || tail).slice(0, 240));
  }
  return variants.filter(v => v && v.length >= 30).slice(0, 3);
}

export function generateCover({ title, author, colors, outPath }) {
  fs.mkdirSync(COVER_DIR, { recursive: true });
  const file = outPath || path.join(COVER_DIR, `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)}.png`);
  const [c1, c2] = colors;
  const psScript = path.join(__dirname, 'scripts', 'make-cover.ps1');
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript,
      '-OutPath', file, '-Title', title, '-Author', author || '', '-C1', c1, '-C2', c2],
      { timeout: 30000 }, (err) => {
        if (err) reject(new Error('封面生成失败：' + err.message.split('\n')[0]));
        else if (!fs.existsSync(file)) reject(new Error('封面生成失败：文件未创建'));
        else resolve(file);
      });
  });
}

// 下载站内作品已有封面（在已登录页面上下文里 fetch → base64）
export async function downloadSiteCover(page, url, title) {
  if (!url) return null;
  try {
    const b64 = await page.evaluate(async (u) => {
      const r = await fetch(u);
      const buf = await r.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(bin);
    }, url);
    fs.mkdirSync(COVER_DIR, { recursive: true });
    const file = path.join(COVER_DIR, `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)}-站内封面.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  } catch { return null; }
}
