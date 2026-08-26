/**
 * validator.js — 校验系统
 * 只做文件级检查：模板位置、颜色位置、文件完整性
 * 不调AI，秒级完成
 */
const path = require('path');
const crypto = require('crypto');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

function isImage(name) {
  return IMAGE_EXT.includes(path.extname(name).toLowerCase());
}

/** 自动配对 */
function autoPair(templates, colors) {
  // 给每张图独立编号：T1/T2/T3...（模版）C1/C2/C3...（颜色）
  const tplMap = new Map();
  const clrMap = new Map();
  templates.forEach((t, i) => tplMap.set(t.path, { id: `T${i + 1}`, name: t.name }));
  colors.forEach((c, i) => clrMap.set(c.path, { id: `C${i + 1}`, name: c.name }));

  const pairs = [];
  for (const tpl of templates) {
    for (const clr of colors) {
      const tplInfo = tplMap.get(tpl.path);
      const clrInfo = clrMap.get(clr.path);
      pairs.push({
        id: crypto.randomBytes(4).toString('hex'),
        templateId: tplInfo.id,
        templateName: tpl.name,
        templateNameWithoutExt: tpl.nameWithoutExt || path.parse(tpl.name).name,
        templatePath: tpl.path,
        colorId: clrInfo.id,
        colorName: clr.name,
        colorNameWithoutExt: clr.nameWithoutExt || path.parse(clr.name).name,
        colorPath: clr.path,
        outputName: `${tplInfo.id}_${clrInfo.id}.jpg`,
        status: 'pending',
        score: 100,
        reason: null
      });
    }
  }
  return pairs;
}

module.exports = { autoPair, isImage };
