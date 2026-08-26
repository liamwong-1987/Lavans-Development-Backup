/**
 * qcEngine.js — QC 引擎 v3
 * 颜色 QC + 结构边缘 QC + 保护区检测
 * QC 异常不得自动 PASS
 */
const sharp = require('sharp');
const { extractColor, deltaE2000, describeDeviation, edgeSimilarity } = require('./colorEngine');

const DELTA_E_THRESHOLD = Number(process.env.DELTA_E_THRESHOLD || 6);
const OUTSIDE_CHANGE_LIMIT = 0.005;
const PIXEL_DIFF_THRESHOLD = 20;

async function runQC(outputPath, targetColor, maskPath = null, templatePath = null) {
  const reasons = [];
  let deltaE = 0, outsideChangeRate = 0, structureScore = 1;
  let colorStatus = 'review_required', structureStatus = 'review_required', outsideMaskStatus = 'not_applicable';

  // === 颜色 QC ===
  const extracted = await extractColor(outputPath, { roi: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } });
  const curLab = extracted?.primary?.lab || [50, 0, 0];
  deltaE = Math.round(deltaE2000(curLab, targetColor.lab) * 100) / 100;
  if (extracted?.primary && deltaE <= DELTA_E_THRESHOLD) {
    colorStatus = 'pass';
  } else if (extracted?.primary) {
    colorStatus = 'fail';
    reasons.push(`色差 ΔE=${deltaE}`);
  }

  // === 保护区检测 ===
  let changedPixels = 0, protectedTotal = 0;

  if (maskPath && templatePath) {
    try {
      const tpl = await sharp(templatePath).raw().toBuffer({ resolveWithObject: true });
      const out = await sharp(outputPath)
        .resize(tpl.info.width, tpl.info.height, { fit: 'fill' })
        .raw().toBuffer({ resolveWithObject: true });
      const mask = await sharp(maskPath)
        .resize(tpl.info.width, tpl.info.height, { fit: 'fill' })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

      // === 结构检测（Sobel 边缘） ===
      const tplWithAlpha = await sharp(templatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const outWithAlpha = await sharp(outputPath)
        .resize(tpl.info.width, tpl.info.height, { fit: 'fill' })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      structureScore = edgeSimilarity(tplWithAlpha.data, outWithAlpha.data, tpl.info.width, tpl.info.height);
      structureStatus = structureScore >= 0.85 ? 'pass' : 'fail';
      if (structureStatus === 'fail') reasons.push(`结构相似度 ${(structureScore * 100).toFixed(1)}%`);

      // === 保护区像素比较 ===
      for (let i = 0; i < tpl.data.length; i += 3) {
        const mi = Math.floor(i / 3) * 4;
        if (mask.data[mi + 3] > 128) {
          protectedTotal++;
          const dr = Math.abs(tpl.data[i] - out.data[i]);
          const dg = Math.abs(tpl.data[i + 1] - out.data[i + 1]);
          const db = Math.abs(tpl.data[i + 2] - out.data[i + 2]);
          if (dr > PIXEL_DIFF_THRESHOLD || dg > PIXEL_DIFF_THRESHOLD || db > PIXEL_DIFF_THRESHOLD) {
            changedPixels++;
          }
        }
      }
      outsideChangeRate = protectedTotal > 0 ? changedPixels / protectedTotal : 0;
      outsideMaskStatus = outsideChangeRate <= OUTSIDE_CHANGE_LIMIT ? 'pass' : 'fail';
      if (outsideMaskStatus === 'fail') reasons.push(`保护区变化 ${(outsideChangeRate * 100).toFixed(2)}%`);
    } catch (e) {
      console.error('[QC] 结构/保护区检测异常:', e.message);
      structureStatus = 'error';
      outsideMaskStatus = 'error';
      reasons.push('QC检测异常: ' + e.message);
    }
  }

  // === 最终判定 ===
  const pass = colorStatus === 'pass' && (structureStatus === 'pass' || structureStatus === 'review_required') && (outsideMaskStatus !== 'fail' && outsideMaskStatus !== 'error') && (structureStatus !== 'error' && structureStatus !== 'fail');
  const qualityStatus = pass ? 'passed' : (colorStatus === 'error' || structureStatus === 'error' ? 'error' : 'failed');
  const hint = colorStatus === 'fail' ? describeDeviation(targetColor.lab, curLab) : '';

  return {
    pass, qualityStatus, colorStatus, structureStatus, outsideMaskStatus,
    deltaE, outsideChangeRate: Math.round(outsideChangeRate * 10000) / 10000,
    structureScore: Math.round(structureScore * 10000) / 10000,
    target: targetColor, hint, reasons
  };
}

module.exports = { runQC, DELTA_E_THRESHOLD };
