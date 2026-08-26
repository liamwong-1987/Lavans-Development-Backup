function safeText(value, limit = 4000) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function stripFence(value) {
  return String(value == null ? '' : value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parseCreativeDirections(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(stripFence(source)); }
    catch (_error) { throw new Error('创意方向没有返回可识别的内容'); }
  }
  const list = Array.isArray(source) ? source : source?.directions;
  if (!Array.isArray(list) || list.length < 3 || list.length > 6) throw new Error('创意方向必须提供 3 到 6 个可选方案');
  const normalized = list.map((item, index) => ({
    id: safeText(item?.id, 60) || `direction-${index + 1}`,
    title: safeText(item?.title, 80),
    hook: safeText(item?.hook, 800),
    characters: safeText(item?.characters, 800),
    conflict: safeText(item?.conflict, 800),
    reversal: safeText(item?.reversal, 800),
    productPlacement: safeText(item?.productPlacement, 800),
    ending: safeText(item?.ending, 800),
    productionNotes: safeText(item?.productionNotes, 800)
  }));
  const ids = new Set();
  normalized.forEach((item, index) => {
    if (!item.title || !item.hook || !item.conflict || !item.reversal || !item.productPlacement || !item.ending) throw new Error(`第 ${index + 1} 个创意方向内容不完整`);
    if (ids.has(item.id)) throw new Error('创意方向编号不能重复');
    ids.add(item.id);
  });
  return normalized;
}

function directionPlainText(direction, index) {
  return [
    `方案 ${index + 1}：${direction.title}`,
    `开场钩子：${direction.hook}`,
    direction.characters ? `人物关系：${direction.characters}` : '',
    `核心冲突：${direction.conflict}`,
    `剧情反转：${direction.reversal}`,
    `产品植入：${direction.productPlacement}`,
    `结尾方式：${direction.ending}`,
    direction.productionNotes ? `拍摄提示：${direction.productionNotes}` : ''
  ].filter(Boolean).join('\n');
}

function directionsPlainText(directions) {
  return directions.map(directionPlainText).join('\n\n');
}

function validateScript(value) {
  const text = safeText(value, 100000).replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (text.length < 120) throw new Error('完整剧本内容过短，未保存');
  if (/^\s*[\[{]/.test(text) && /"(?:title|hook|conflict|scene)"\s*:/.test(text)) throw new Error('完整剧本必须是给人阅读的纯文字，不能返回程序格式');
  return text;
}

module.exports = { parseCreativeDirections, directionsPlainText, directionPlainText, validateScript };
