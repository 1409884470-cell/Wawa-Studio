import { effectiveWords } from './manuscript-cleaner.mjs';

export function initialPlan(chapters, scheme) {
  if (!chapters.length) throw new Error('清理后没有有效章节');
  const mode = scheme.firstSubmitMode || 'all'; // 老任务保留原执行范围
  const minWords = scheme.firstMinWords ?? 20000;
  let count;
  if (mode === 'all') count = chapters.length;
  else if (mode === 'count') {
    count = Math.min(scheme.firstChapterCount ?? 12, chapters.length);
  } else if (mode === 'minimum') {
    count = Math.min(scheme.firstMinChapters ?? 10, chapters.length);
    const max = Math.min(scheme.firstMaxChapters ?? 15, chapters.length);
    while(count < max && chapters.slice(0,count).reduce((n,c)=>n+effectiveWords(c.text),0) < minWords) count++;
  } else throw new Error('首投范围无效');
  const words = chapters.slice(0,count).reduce((n,c)=>n+effectiveWords(c.text),0);
  if (mode !== 'all' && words < minWords) throw new Error(`前${count}章有效正文仅${words}字，未达到${minWords}字；请增加首投章数或改为整本投稿`);
  return {mode,count,words,total:chapters.length,partial:count < chapters.length};
}

// 必须整条理由相等。任何附加评语均不可自动删除、修改复投。
export function rejectionKind(reason) {
  const raw=String(reason || '').trim();
  if (!raw) return 'unknown';
  const normalized=raw.replace(/[\s，,。.!！;；:：]/g,'');
  if (normalized === '质量暂未达到签约标准感谢投稿') return 'generic';
  if (/故事完整度|剧情混乱|主线不清晰|看点过低|逻辑混乱|完整度过低/.test(raw)) return 'story';
  if (/格式|章[节名].*(?:标识|标题)|章节标识|大纲|细纲|分隔|提示词|空白章|正文.*(?:第一章|第二章|章名)|本章完/.test(raw)) return 'format';
  return 'other';
}

export function submissionReview(row) {
  return {status:row.status,reason:String(row.reviewReason ?? row.review_reason ?? ''),contract:row.contract ?? row.contract_status ?? '',at:new Date().toISOString()};
}
