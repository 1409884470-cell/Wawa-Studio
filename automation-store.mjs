import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export const DEFAULT_SCHEME = {
  name: '默认自动包装', introStyle: '根据内容分析选择，突出真实冲突，保留悬念，不剧透结局',
  coverStyle: '根据小说题材选择画风，竖版，清晰书名与作者署名',
  storyRule: 'words', longThreshold: 20000, entry: 'auto', finished: 'analysis',
  destination: 'submit', imageSize: '1024x1536', autoStart: true, concurrency: 1,
  retries: 2, titleAttempts: 2,
  firstSubmitMode: 'minimum', firstChapterCount: 12, firstMinChapters: 10, firstMaxChapters: 15,
  firstMinWords: 20000, completeAfterContract: true,
};

export function validScheme(input = {}) {
  const s = { ...DEFAULT_SCHEME, ...input, titleAttempts: 2 };
  for (const [key, choices] of Object.entries({ storyRule: ['words', 'analysis', 'long', 'short'],
    finished: ['analysis', 'finished', 'serial'], destination: ['package', 'library', 'submit'],
    imageSize: ['1024x1536', '768x1024', '720x1280', '1024x1024', '1280x720'], firstSubmitMode: ['minimum','count','all'] })) {
    if (!choices.includes(s[key])) throw new Error(`包装方案字段无效：${key}`);
  }
  for (const [key, min, max] of [['longThreshold', 1, 10000000], ['concurrency', 1, 3], ['retries', 0, 3], ['titleAttempts', 1, 5], ['firstChapterCount',1,10000],['firstMinChapters',1,10000],['firstMaxChapters',1,10000],['firstMinWords',20000,10000000]]) {
    if (!Number.isInteger(Number(s[key])) || Number(s[key]) < min || Number(s[key]) > max) throw new Error(`包装方案数值无效：${key}`);
    s[key] = Number(s[key]);
  }
  for (const k of ['name', 'introStyle', 'coverStyle', 'entry']) {
    if (typeof s[k] !== 'string' || !s[k].trim() || s[k].length > 2000) throw new Error(`包装方案内容无效：${k}`);
    s[k] = s[k].trim();
  }
  s.autoStart = !!s.autoStart;
  s.completeAfterContract = !!s.completeAfterContract;
  if (s.firstMaxChapters < s.firstMinChapters) throw new Error('首投最大章数不能小于最小章数');
  return s;
}

export function openStore(file) {
  let state = { version: 1, jobs: [], schemes: [DEFAULT_SCHEME], paused: true };
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.jobs) || !Array.isArray(state.schemes)) throw new Error('自动任务数据格式异常，请保留文件并恢复备份');
  }
  for (const j of state.jobs) {
    if(j.deleteRequested){j.status='canceled';j.hidden=true;delete j.deleteRequested;}
    else if (['running','importing'].includes(j.status)) j.status = 'queued';
  }
  // 一次性升级旧默认尺寸，保留已生成封面；升级后仍可手选其他比例。
  if (!state.coverRatioDefaultVersion) {
    for (const s of state.schemes) if (s.imageSize === '768x1024') s.imageSize = '1024x1536';
    for (const j of state.jobs) if (!j.cover && j.scheme?.imageSize === '768x1024') j.scheme.imageSize = '1024x1536';
    state.coverRatioDefaultVersion = 1;
  }
  state.schemes = state.schemes.map(s => validScheme(s));
  // 已上传任务保持其原有的整本范围，不能把已存在的远端作品按新默认范围解释。
  for (const j of state.jobs) j.scheme = validScheme({ firstSubmitMode:'all',completeAfterContract:false,...j.scheme });
  // 重启保留断点，由“继续队列”恢复，避免重启时意外发起付费请求或投稿。
  state.paused = true;
  return { state, save: () => atomicJSON(file, state) };
}

export function archiveManuscript(src, dir) {
  if (!/\.(txt|docx)$/i.test(src)) throw new Error('小说仅支持 TXT / DOCX');
  const buf = fs.readFileSync(src);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${hash}${path.extname(src).toLowerCase()}`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf, { flag: 'wx' });
  return { file: dest, hash, originalName: path.basename(src, path.extname(src)) };
}
