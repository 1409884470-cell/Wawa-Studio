import { extractChaptersFromText } from './auto.mjs';

export const effectiveWords = text => (String(text).match(/[\p{L}\p{N}]/gu) || []).length;
const chapterHead = /^(?:#{1,6}\s*)?(?:第[0-9０-９零〇一二两三四五六七八九十百千万]+[章节回][^\n]{0,50}|Chapter\s+\d+[^\n]{0,50}|[0-9０-９]{1,4}[.．、]\s*[^\n]{1,40}|(?:序章|楔子|番外|尾声|终章)[^\n]{0,30})$/i;
const outlineHead = /^(?:#{1,6}\s*)?[【\[（(]?(?:小说|故事|章节|本章|第.{1,10}章)?(?:大纲|细纲|创作提纲|写作提纲|章节规划|剧情梗概|人物设定|人物小传|写作要求|创作要求|AI提示词|提示词|系统提示词)[】\]）)]?\s*(?:[:：].*)?$/i;
const bodyHead = /^(?:#{1,6}\s*)?[【\[（(]?(?:小说正文|正文|正文开始|以下正文|开始正文)[】\]）)]?\s*[:：]?\s*$/;
const ending = /[（(【\[]\s*(?:本章完|本章节完|本章结束|未完待续|全文完|完结|待续)\s*[）)】\]]/g;
const promptLine = /^(?:好的[，,。！!]?\s*)?(?:以下是(?:为您|为你)?(?:生成|创作|撰写|续写|改写|润色|修改)的|这是(?:为您|为你)(?:生成|创作|撰写)的|根据(?:您|你)(?:提供|给出)的(?:大纲|细纲|要求)|请(?:根据|按照|继续|帮我|你扮演|以第[一三]人称)|你(?:是|现在是)一(?:个|位)(?:小说|网文|专业|资深)|作为(?:一(?:个|位))?AI|As an AI|\[(?:SYSTEM|USER|ASSISTANT)\]|(?:system|assistant|user)\s*[:：]|(?:输出要求|任务要求|字数要求|写作要求|创作要求|温馨提示|注意事项)\s*[:：]|如果(?:您|你)(?:需要|希望).*(?:修改|调整|继续)|需要我继续)/i;

// 只清理明确的结构标记和独立提示行；疑似提纲正文不能悄悄混进投稿。
export function cleanManuscript(parsed, { minChapterWords = 50, requireFirstChapter = false } = {}) {
  const changes = [], warnings = [], notices = [], kept = [];
  const raw = parsed.rawText || parsed.text || '';
  let inOutline = false, inThinking = false;
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    line=line.replace(/^\s*正文\s*[:：]\s*(?=第|Chapter)/i,'');
    const unwrapped=line.trim().replace(/^\*\*(.*?)\*\*$/,'$1').replace(/^[【\[](.+)[】\]]$/,'$1');
    if(chapterHead.test(unwrapped))line=unwrapped;
    const t = line.trim();
    const drop = reason => changes.push({ line: i + 1, reason, removed: lines[i] });
    if (/^<think>/.test(t)) { inThinking = !t.includes('</think>'); drop('AI思考过程'); continue; }
    if (inThinking) { if (t.includes('</think>')) inThinking = false; drop('AI思考过程'); continue; }
    if (outlineHead.test(t)) { inOutline = true; drop('大纲/细纲/提示词区块'); continue; }
    if (inOutline) {
      if (bodyHead.test(t)) { inOutline = false; drop('正文起始标记'); continue; }
      // 只有“章节标题 + 连贯叙事段落”才结束提纲区，提纲中的章节列表仍清理。
      const following = lines.slice(i + 1, i + 5).map(l => l.trim()).filter(Boolean)[0] || '';
      if (chapterHead.test(t) && effectiveWords(following) >= 50 && !/^(?:[-*\d一二三四五六七八九十、.]+\s*)?(?:剧情|情节|场景|目标|冲突|看点|伏笔|人物|内容|要点|本章)/.test(following)) inOutline = false;
      else { drop('大纲/细纲/提示词区块内容'); continue; }
    }
    if (bodyHead.test(t)) { drop('正文起始标记'); continue; }
    if (/^(?:本章完|本章节完|本章结束|全文完|未完待续|全书完|完结撒花)[。！!]?\s*$/.test(t)) {drop('章节结束标记');continue;}
    if (promptLine.test(t)) { drop('AI提示语/生成说明'); continue; }
    if (/^```(?:\w+)?\s*$/.test(t) || (t && !/[\p{L}\p{N}]/u.test(t))) { drop('分隔线/无意义符号'); continue; }
    if (/^(?:字数|总字数|作者|笔名|书名)\s*[:：]/.test(t)) { drop('正文中的元信息'); continue; }
    line = line.replace(ending, '');
    if (line !== lines[i]) changes.push({ line:i+1,reason:'结束标记或控制字符',removed:lines[i],replacement:line });
    // Markdown 章标题转为独立章名，不留在正文字段。
    if (chapterHead.test(line.trim())) line = line.trim().replace(/^#{1,6}\s*/, '');
    kept.push(line);
  }
  if (inThinking) warnings.push('AI思考区块未正常闭合，请核对清理记录');
  if (inOutline) warnings.push('大纲/提示词区块没有明确正文结束标识，请核对被排除内容');
  const first=kept.findIndex(l=>/^(?:第(?:一|1|１|01|０１)章|Chapter\s+0?1\b|[1１][.．、]\s)/i.test(l.trim()));
  if(first>0)changes.push({reason:'第一章之前的简介/序言不进入正文',removed:kept.slice(0,first).join('\n')});
  if(first<0 && requireFirstChapter)warnings.push('未识别到第一章，请核对章节标题后再上传');
  const split = extractChaptersFromText((first>=0?kept.slice(first):kept).join('\n'), { alreadyClean:true });
  const chapters = [];
  for (const c of split) {
    const body = c.text.split('\n').filter(l => {
      if (chapterHead.test(l.trim())) { changes.push({chapter:c.name,reason:'正文中重复的章节标识',removed:l});return false; }
      return true;
    }).join('\n').replace(ending,'').trim();
    const words = effectiveWords(body);
    if (words < minChapterWords) { changes.push({chapter:c.name,reason:`不足${minChapterWords}字的章节不上传`,words,removed:body});continue; }
    if (/(?:大纲|细纲|提示词|章节规划|输出要求|系统提示|AI生成|人工智能模型)/i.test(body)) notices.push(`「${c.name}」含相关词语，可能是正常剧情，已保留正文，不阻断投稿`);
    chapters.push({name:c.name,text:body});
  }
  if (chapters.length === 0) warnings.push('清理后没有达到50字的有效章节');
  const names = new Set();
  for (const c of chapters) { if(names.has(c.name))warnings.push(`清理后章名重复：「${c.name}」，请核对`); names.add(c.name); }
  return {chapters,words:chapters.reduce((n,c)=>n+effectiveWords(c.text),0),warnings:[...new Set(warnings)],notices,changes,version:2};
}
