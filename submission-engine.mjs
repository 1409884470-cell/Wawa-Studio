import fs from 'node:fs';
import crypto from 'node:crypto';
import { userPath } from './paths.mjs';
import { normalizeConfig, validateConfig } from './core.mjs';
import { readNovelChapters, aiConfigured } from './auto.mjs';

export function selectRange(range, total) {
  if (!total) throw new Error('作品没有有效章节');
  if (range?.mode !== 'custom') return { from: 1, to: total };
  const from = Number(range.from), to = Number(range.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > total) {
    throw new Error(`章节范围无效：请输入 1-${total} 之间的起止章（允许只选一章）`);
  }
  return { from, to };
}

function uniqueMatch(rows, title) {
  const matches = rows.filter(s => s.title === title);
  if (matches.length > 1) throw new Error('存在同名作品，请从站内作品列表选择具体作品');
  return matches[0];
}

// IO 可注入，回归测试不启动浏览器、不调用真实投稿接口。
export async function runSubmission(r, t, mode, hooks = {}) {
  const cfg = normalizeConfig(t.cfg);
  const submit = mode === 'submit';
  const { readChapters = readNovelChapters, lookup = () => null, record = () => {},
    checkpoint = async () => {}, rewrite = async () => 0, log = () => {},
    aiAvailable = aiConfigured, preflight = validateConfig } = hooks;
  const messages = [];
  await checkpoint();
  const subs = await r.listSubmissions();
  await checkpoint();
  let exist;
  if (t.sid != null) {
    exist = subs.find(s => String(s.sid) === String(t.sid));
    if (!exist) throw new Error('当前账号下找不到该任务绑定的投稿，请核对账号或重新导入作品');
  } else if (cfg.sourceId != null) {
    exist = subs.find(s => String(s.id) === String(cfg.sourceId));
  } else {
    const remembered = lookup(cfg.title);
    exist = remembered?.sid != null ? subs.find(s => String(s.sid) === String(remembered.sid)) : null;
    exist ??= uniqueMatch(subs, cfg.title);
  }
  const local = cfg.localFile ? await readChapters(cfg.localFile) : null;
  if (local?.some(c => !c.text?.replace(/[\s\-—_=*#]/g, ''))) throw new Error('稿件含空章，请检查后重新导入');

  if (exist) {
    let structure = await r.apiStructure(exist.id);
    const range = selectRange(t.range, local ? local.length : structure.length);
    // 入库章节与本地前缀必须一致；已投稿数不能用于推断入库进度。
    if (local) {
      for (let i = 0; i < Math.min(local.length, structure.length); i++) {
        const name = structure[i].name ?? structure[i].title ?? structure[i].chapter_name;
        if (name && String(name).trim() !== local[i].name.trim()) {
          throw new Error(`第 ${i + 1} 章与作品库不一致，请核对源文件（站内：${name}；本地：${local[i].name}）`);
        }
      }
    }
    const start = structure.length;
    const appended = local ? local.slice(start) : [];
    const selected = structure.slice(range.from - 1, range.to).filter(c => !c.is_submitted && !c.is_locked);
    const planned = selected.length + Math.max(0, range.to - Math.max(start, range.from - 1));
    messages.push(`更新计划：新增入库 ${appended.length} 章；范围第 ${range.from}-${range.to} 章，待提交 ${planned} 章`);
    if (!submit) return { ok: true, dryRun: true, sid: exist.sid, baseId: exist.id, messages };

    if (appended.length) {
      if (t.deai && start < 10 && aiAvailable()) await rewrite(t, appended, start);
      await checkpoint();
      const tmpDir = userPath('tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmp = userPath('tmp', `update-${crypto.randomUUID()}.txt`);
      try {
        fs.writeFileSync(tmp, appended.map(c => `${c.name}\n\n${c.text}`).join('\n\n'), 'utf8');
        await r.apiUpdateCreateFile(exist.sid, tmp);
      } finally { fs.rmSync(tmp, { force: true }); }
      await checkpoint();
      structure = await r.apiStructure(exist.id);
      if (structure.length < local.length) throw new Error('新增章节未完整入库，请核对站内作品后重试');
    }
    const chosen = structure.slice(range.from - 1, range.to);
    const locked = chosen.filter(c => !c.is_submitted && c.is_locked).length;
    const ids = chosen.filter(c => !c.is_submitted && !c.is_locked).map(c => c.node_id);
    if (locked) messages.push(`${locked} 章被站点锁定，本次未提交`);
    if (!ids.length) {
      messages.push(locked ? '所选章节被锁定，请在站点处理后重试' : '所选范围已全部投稿，无需重复提交');
      return { ok: !locked, mode: 'uptodate', sid: exist.sid, baseId: exist.id, messages };
    }
    await checkpoint();
    const res = exist.status === 'draft'
      ? await r.apiSubmitSubmission(exist.sid, ids)
      : await r.apiSubmitChapters(exist.sid, ids);
    record(cfg.title, exist.sid, exist.id, structure.length);
    messages.push(`提交完成：成功 ${res?.success_count ?? ids.length} 章` +
      (res?.failed_count ? `，失败 ${res.failed_count} 章` : ''));
    return { ok: !res?.failed_count && !locked, mode: 'update', sid: exist.sid, baseId: exist.id, messages };
  }

  // 站内来源保留 base_novel_id，直接从作品库建立投稿。
  let sourceId = cfg.sourceId, sourceStructure = null;
  if (!local) {
    if (sourceId == null && cfg.sourceTitle) {
      const work = uniqueMatch(await r.listSiteWorks(), cfg.sourceTitle);
      sourceId = work?.id;
    }
    if (sourceId == null) throw new Error('请选择本地稿件或站内作品');
    sourceStructure = await r.apiStructure(sourceId);
  }
  const total = local ? local.length : sourceStructure.length;
  const range = selectRange(t.range, total);
  messages.push(`计划：${local ? `全部 ${total} 章入库` : `使用站内作品 ${total} 章`}；提交第 ${range.from}-${range.to} 章`);
  const problems = preflight(cfg);
  if (problems.length) throw new Error(problems.join('；'));
  if (!cfg.cover) throw new Error('投稿前请先生成或导入封面');
  if (!cfg.penName?.trim()) throw new Error('投稿前请填写笔名');
  let cover = cfg.cover;
  await checkpoint();
  const labels = await r.apiLabelMap();
  if (cfg.customTags?.length || (cfg.tags ?? []).some(n => !labels.has(n))) throw new Error('标签不在蛙蛙系统标签库中，请重新选择');
  let entry = {};
  if (cfg.entry !== '普通投稿') {
    const campaign = (await r.apiCampaigns()).find(c => c.name === cfg.entry || c.title === cfg.entry);
    if (!campaign) throw new Error(`找不到征文活动「${cfg.entry}」`);
    entry = { entry_type: 'campaign', campaign_code: campaign.code };
  }
  if (!submit) return { ok: true, dryRun: true, chaptersN: total, messages: [...messages, '封面、笔名、简介、类目、标签与入口校验通过'] };
  if (!/^https?:/i.test(cover)) cover = await r.apiUpload(cover);
  if (local && t.deai) {
    if (aiAvailable()) { log('去AI处理：重写前十章…'); await rewrite(t, local, 0); }
    else messages.push('未配置文本 AI，跳过去AI处理');
  }
  await checkpoint();
  const payload = {
    novel_title: cfg.title, story_type: cfg.category === '短篇' ? 'short' : 'long',
    channel: cfg.channel, cover, introduction: cfg.intro?.trim() || '暂无简介',
    is_finished: cfg.status === '已完结' && range.from === 1 && range.to === total,
    pen_name: cfg.penName, label_ids: (cfg.tags ?? []).map(n => labels.get(n)).filter(Boolean),
    cate1_name: cfg.novelType?.[0], cate2_name: cfg.novelType?.[1], cate3_name: cfg.novelType?.[2], ...entry,
  };
  const created = local
    ? await r.apiCreateFromFile({ ...payload, chapters: local })
    : await r.apiCreateFromNovel({
      base_novel_id: sourceId, title: cfg.title, cover: payload.cover,
      introduction: payload.introduction, is_finished: payload.is_finished,
      channel: payload.channel, pen_name: payload.pen_name,
      label_ids: payload.label_ids, custom_label_texts: payload.custom_label_texts,
      cate1_name: payload.cate1_name, cate2_name: payload.cate2_name, cate3_name: payload.cate3_name,
      chapter_ids: sourceStructure.slice(range.from - 1, range.to).map(c => c.node_id), ...entry,
    });
  const baseId = created?.base_novel_id ?? sourceId;
  if (created?.submission_id == null || baseId == null) throw new Error('创建投稿未返回作品标识，请在站点核对结果');
  // 建立草稿即记住身份；后续提交失败也可继续原草稿。
  record(cfg.title, created.submission_id, baseId, total);
  await checkpoint();
  const structure = await r.apiStructure(baseId);
  if (structure.length < range.to) throw new Error('作品库章节不完整，请核对站内作品后重试');
  const ids = structure.slice(range.from - 1, range.to).map(c => c.node_id);
  await checkpoint();
  const res = await r.apiSubmitSubmission(created.submission_id, ids);
  messages.push(`投稿完成：提交第 ${range.from}-${range.to} 章，共 ${ids.length} 章`);
  return { ok: !res?.failed_count, mode: 'create', sid: created.submission_id, baseId, messages };
}
