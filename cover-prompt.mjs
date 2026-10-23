export const LEGACY_COVER_TEMPLATE = '书名：{书名}\n笔名：{笔名}\n男女频：{男女频}\n题材：{题材}\n画风：{画风}';
export const DEFAULT_COVER_TEMPLATE = '制作2:3竖版小说封面。必须在画面中绘制完整书名「{书名}」和作者署名「{笔名}」，逐字准确，不用占位文字。为文字预留干净、高对比区域；书名醒目清晰，长书名可分两至三行；笔名完整可读，不遮脸、不裁切、不遗漏，不添加其他文字。画风与附加要求不得取消这两项文字。\n画风：{画风}\n题材：{题材}（{男女频}）\n故事：{剧情摘要}\n人物：{主要人物}\n核心冲突：{核心冲突}\n以本书独有的冲突或意象组织画面，主体明确、背景简洁、明亮清透；避免固定低头人物、桌面和窗光模板。';
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
  const template=normalizeCoverTemplate(settings.coverTemplate);
  const fields={'书名':values.title,'笔名':values.penName,'男女频':values.channel,'题材':values.genre,'画风':values.style,'剧情摘要':values.summary,'主要人物':values.characters,'核心冲突':values.conflict};
  return template.replace(/\{(书名|笔名|男女频|题材|画风|剧情摘要|主要人物|核心冲突)\}/g,(_,k)=>fields[k]||'未指定')+(settings.coverExtra?.trim()?'\n'+settings.coverExtra.trim():'');
}
export function normalizeCoverTemplate(template){
  let value=typeof template==='string'&&template.trim()&&template!==LEGACY_COVER_TEMPLATE?template:DEFAULT_COVER_TEMPLATE;
  // Required identity fields are visible in the saved basic template, not a hidden prompt layer.
  for(const [key,label] of [['书名','完整书名'],['笔名','作者署名'],['画风','画风']])if(!value.includes('{'+key+'}'))value+='\n'+label+'：{'+key+'}';
  return value;
}
export function normalizeCoverSettings(settings){
  const result={...settings,coverTemplate:normalizeCoverTemplate(settings.coverTemplate)};
  for(const k of ['coverLayout','coverMood','coverPrefix','coverNegative'])delete result[k];
  if(result.promptTemplates){result.promptTemplates={...result.promptTemplates};delete result.promptTemplates.coverScene;}
  return result;
}
