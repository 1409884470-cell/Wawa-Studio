export const DEFAULT_COVER_TEMPLATE = '书名：{书名}\n笔名：{笔名}\n男女频：{男女频}\n题材：{题材}\n画风：{画风}';
export const COVER_FIXED = '2:3竖版商业小说封面。完整书名醒目易读，笔名清楚，不遮脸。除书名和笔名外不添加文字。主体明确，背景简洁。';
export const COVER_MOOD = '画面明亮通透，色彩干净，主体清楚，避免阴暗压抑、黑底、血腥、浓雾、脏灰和过度炫光。每本书根据独有剧情变化人物动作与标志性物件，不套用相同人物站姿和背景。';
export function inferCoverStyle(text='') {
  if(/搞笑|喜剧|沙雕|幽默/.test(text))return '轻松搞笑插画风格';
  if(/儿童|小孩|幼儿|萌娃|童话/.test(text))return '卡通插画风格';
  if(/悬疑|推理|惊悚/.test(text))return '悬疑插画风格';
  if(/仙侠|古风|修仙/.test(text))return '古风插画风格';
  return '贴合剧情氛围的小说人物插画风格';
}
export function buildCoverPrompt(settings, values) {
  const template=settings.coverTemplate ?? DEFAULT_COVER_TEMPLATE;
  const fields={'书名':values.title,'笔名':values.penName,'男女频':values.channel,'题材':values.genre,'画风':values.style};
  return template.replace(/\{(书名|笔名|男女频|题材|画风)\}/g,(_,k)=>fields[k]||'未指定')+'\n'+(settings.coverLayout??COVER_FIXED)+(values.scene?'\n本书画面：'+values.scene:'')+'\n'+(settings.coverMood??COVER_MOOD)+(settings.coverExtra?.trim()?'\n'+settings.coverExtra.trim():'');
}
