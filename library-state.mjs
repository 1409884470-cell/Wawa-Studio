// Library facts survive removal of a task from the submission list.
export function submissionState(j) {
  if (!j) return {group:'ready',text:'已完稿 · 未投稿',percent:0};
  const status=j.hidden?(j.recordStatus||j.status):j.status;
  const submitted=!!j.submittedAt || (!!j.remoteConfirmedAt && j.scheme?.destination==='submit');
  if (status==='blocked') return {group:'attention',text:'已投稿 · 审核未通过',percent:100};
  if (submitted || ['watching','done'].includes(status)&&j.scheme?.destination==='submit')
    return {group:'done',text:j.hidden?'已投稿 · 记录已移除':j.result||'已投稿 · 审核中',percent:100};
  if (j.remote || j.uploadIntent || j.repairSource)
    return {group:'attention',text:j.remoteConfirmedAt?'已上传草稿 · 未投稿':j.hidden?'已上传或结果待核对 · 记录已移除':'上传／投稿结果待核对',percent:77};
  if (j.hidden || status==='canceled') return {group:'ready',text:'已完稿 · 未投稿',percent:0};
  if (status==='done' && j.scheme?.destination==='package') return {group:'ready',text:'包装完成 · 未投稿',percent:62};
  if (status==='attention') return {group:'attention',text:'投稿准备需处理',percent:0};
  const steps=['inspect','catalog','analysis','title','intro','entry','prompt','cover','check','upload','format','submit','verify'];
  return {group:'processing',text:status==='waiting'?'等待笔名／额度':status==='running'?'投稿处理中':'已转入投稿中心 · 待处理',percent:Math.round(Math.max(0,steps.indexOf(j.stage))/steps.length*100)};
}

export function completedBooks(snapshot) {
  const books=new Map();
  for (const b of snapshot.library||[]) if(b.id&&(b.status==='completed'||b.kind==='full'))
    books.set(b.id,{...b,status:'completed',completed_chapters:b.chapters,total_words_actual:b.words});
  for (const b of snapshot.queue.items) if(b.status==='completed') books.set(b.id,{...books.get(b.id),...b});
  return [...books.values()];
}

export function bookSubmission(jobs,id) {
  const related=jobs.filter(j=>j.writerId===id);
  return related.find(j=>!j.hidden&&j.status!=='canceled') || related.find(j=>submissionState(j).group!=='ready') || related.at(-1);
}

export function hideSubmissionRecord(j) {
  if (!j.hidden) j.recordStatus=j.status;
  j.hidden=true;j.status='canceled';delete j.deleteRequested;
}
