/**
 * colorEngine.js — 颜色引擎 v3
 * 确定性 LAB K-Means 聚类 + 完整候选色 LAB + 无自动 Mask
 */
const fs = require('fs');
const sharp = require('sharp');

// ==================== RGB ↔ HEX ↔ LAB ↔ HSL ====================

function clampByte(v) { return Math.max(0, Math.min(255, v | 0)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rgbToLab(r, g, b) {
  let rr = r / 255, gg = g / 255, bb = b / 255;
  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;
  const x = (rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375) / 0.950470;
  const y = rr * 0.2126729 + gg * 0.7151522 + bb * 0.0721750;
  const z = (rr * 0.0193339 + gg * 0.1191920 + bb * 0.9503041) / 1.088830;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const L = 116 * f(y) - 16, A = 500 * (f(x) - f(y)), B = 200 * (f(y) - f(z));
  return [Math.round(L * 100) / 100, Math.round(A * 100) / 100, Math.round(B * 100) / 100];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) { case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break; case g: h = ((b - r) / d + 2) / 6; break; default: h = ((r - g) / d + 4) / 6; }
  return [h * 360, s * 100, l * 100];
}

// ==================== Delta E ====================

function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.sqrt(a1 * a1 + b1 * b1), C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const cBar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + 6103515625)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1), C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const hp = (x, y) => { if (x === 0 && y === 0) return 0; const v = Math.atan2(y, x) / rad; return v >= 0 ? v : v + 360; };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const lBar = (L1 + L2) / 2, cBarP = (C1p + C2p) / 2;
  let hBar;
  if (C1p * C2p === 0) hBar = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hBar = (h1p + h2p) / 2;
  else hBar = (h1p + h2p + 360) / 2;
  const T = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.20 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hBar - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(cBarP, 7) / (Math.pow(cBarP, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(lBar - 50, 2)) / Math.sqrt(20 + Math.pow(lBar - 50, 2));
  const Sc = 1 + 0.045 * cBarP;
  const Sh = 1 + 0.015 * cBarP * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}

function describeDeviation(targetLab, currentLab) {
  const dL = currentLab[0] - targetLab[0], da = currentLab[1] - targetLab[1], db = currentLab[2] - targetLab[2];
  const tips = [];
  if (dL > 3) tips.push('偏亮'); if (dL < -3) tips.push('偏暗');
  if (da > 3) tips.push('偏红'); if (da < -3) tips.push('偏绿');
  if (db > 3) tips.push('偏黄'); if (db < -3) tips.push('偏蓝');
  return tips.length ? tips.join('，') : '轻微色差';
}

// ==================== 确定性 LAB K-Means 聚类 ====================

function labDist(a, b) {
  const dL = a[3] - b[3], dA = a[4] - b[4], dB = a[5] - b[5];
  return Math.sqrt(dL * dL + dA * dA + dB * dB);
}

function kMeansClusterLab(points, K = 5, maxIter = 20) {
  if (points.length <= K) {
    return points.map((p, i) => ({ centroid: p, indices: [i], count: 1 }));
  }

  // 确定性初始化：按 LAB 空间均匀采样
  const centroids = [];
  const n = points.length;
  // 第一个中心：L 中位数点
  const sortedByL = [...points].sort((a, b) => a[3] - b[3]);
  centroids.push(sortedByL[Math.floor(n / 2)].slice());

  while (centroids.length < K) {
    let bestIdx = 0, bestMinDist = -1;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (const c of centroids) minDist = Math.min(minDist, labDist(points[i], c));
      if (minDist > bestMinDist) { bestMinDist = minDist; bestIdx = i; }
    }
    centroids.push(points[bestIdx].slice());
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const clusters = centroids.map(() => []);
    for (let i = 0; i < n; i++) {
      let bestD = Infinity, bestC = 0;
      for (let c = 0; c < K; c++) {
        const d = labDist(points[i], centroids[c]);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      clusters[bestC].push(i);
    }
    let changed = false;
    for (let c = 0; c < K; c++) {
      if (clusters[c].length === 0) continue;
      const newC = [0, 0, 0, 0, 0, 0];
      for (const idx of clusters[c]) {
        for (let j = 0; j < 6; j++) newC[j] += points[idx][j];
      }
      const nc = clusters[c].length;
      for (let j = 0; j < 6; j++) newC[j] /= nc;
      if (labDist(centroids[c], newC) > 0.5) changed = true;
      centroids[c] = newC;
    }
    if (!changed) break;
  }

  const result = centroids.map(cen => ({ centroid: cen, indices: [], count: 0 }));
  for (let i = 0; i < n; i++) {
    let bestD = Infinity, bestC = 0;
    for (let c = 0; c < K; c++) {
      const d = labDist(points[i], centroids[c]);
      if (d < bestD) { bestD = d; bestC = c; }
    }
    result[bestC].indices.push(i);
    result[bestC].count++;
  }
  return result;
}

function clusterScore(cluster, totalPoints) {
  const [R, G, B, L] = cluster.centroid;
  const [, s] = rgbToHsl(R, G, B);
  const ratio = cluster.count / totalPoints;
  const midToneScore = L >= 25 && L <= 70 ? 1 : L < 25 ? L / 25 : (100 - L) / 30;
  return ratio * (40 + 30 * Math.min(s / 100, 1) + 30 * Math.max(0, midToneScore));
}

// ==================== 颜色提取 ====================

async function extractColor(imagePath, opts = {}) {
  try {
    const { data, info } = await sharp(imagePath)
      .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    let roi = opts.roi || { x: 0.15, y: 0.15, w: 0.7, h: 0.7 };

    const cx = Math.floor(width * roi.x), cy = Math.floor(height * roi.y);
    const cw = Math.floor(width * roi.w), ch = Math.floor(height * roi.h);

    const points = [];
    for (let y = cy; y < Math.min(cy + ch, height); y++) {
      for (let x = cx; x < Math.min(cx + cw, width); x++) {
        const idx = (y * width + x) * 4;
        if (data[idx + 3] < 25) continue;
        const R = data[idx], G = data[idx + 1], B = data[idx + 2];
        const brightness = (R + G + B) / 3;
        if (brightness < 12 || brightness > 240) continue;
        const lab = rgbToLab(R, G, B);
        if (lab[0] < 12 || lab[0] > 92) continue;
        const [, s] = rgbToHsl(R, G, B);
        if (s < 5 && lab[0] > 30 && lab[0] < 80) continue; // 排除低饱和度中间调
        points.push([R, G, B, lab[0], lab[1], lab[2]]);
      }
    }

    if (points.length < 100) {
      return { success: false, reason: 'no_reliable_color', primary: null, candidates: [] };
    }

    const clusters = kMeansClusterLab(points, 5);
    const total = points.length;

    const valid = clusters.filter(c => {
      const [, , , L] = c.centroid;
      const [, s] = rgbToHsl(c.centroid[0], c.centroid[1], c.centroid[2]);
      if (L < 3 || L > 97) return false;
      if (s < 8 && L > 25 && L < 75) return false;
      return true;
    });

    if (valid.length === 0) {
      return { success: false, reason: 'no_reliable_color', primary: null, candidates: [] };
    }

    const sorted = [...valid].sort((a, b) => clusterScore(b, total) - clusterScore(a, total));
    const best = sorted[0];
    const [bR, bG, bB, bL, bA, lB] = best.centroid;

    const primary = {
      hex: rgbToHex(Math.round(bR), Math.round(bG), Math.round(bB)),
      rgb: [Math.round(bR), Math.round(bG), Math.round(bB)],
      lab: [Math.round(bL * 100) / 100, Math.round(bA * 100) / 100, Math.round(lB * 100) / 100],
      confidence: Math.min(1, best.count / total * 5)
    };

    const candidates = sorted.slice(0, 5).map(c => {
      const [cr, cg, cb, cL, cA, lB] = c.centroid;
      return {
        hex: rgbToHex(Math.round(cr), Math.round(cg), Math.round(cb)),
        rgb: [Math.round(cr), Math.round(cg), Math.round(cb)],
        lab: [Math.round(cL * 100) / 100, Math.round(cA * 100) / 100, Math.round(lB * 100) / 100],
        ratio: c.count / total,
        confidence: Math.min(1, c.count / total * 5)
      };
    });

    return { success: true, primary, candidates };
  } catch (e) {
    console.error('[COLOR] 提取失败:', imagePath, e.message);
    return { success: false, reason: 'extraction_error', primary: null, candidates: [] };
  }
}

// ==================== Mask 合成（仅 confirmed Mask 调用） ====================

async function protectOutsideMask(templatePath, generatedPath, maskPath, outputPath) {
  if (!maskPath || !fs.existsSync(maskPath)) {
    fs.copyFileSync(generatedPath, outputPath);
    return outputPath;
  }
  const tplMeta = await sharp(templatePath).metadata();
  const { width, height } = tplMeta;

  const template = await sharp(templatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const generated = await sharp(generatedPath)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(maskPath)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const td = template.data, gd = generated.data, md = mask.data;
  for (let i = 0; i < td.length; i += 4) {
    const w = 1 - md[i + 3] / 255;
    gd[i]     = clampByte(Math.round(gd[i]     * w + td[i]     * (1 - w)));
    gd[i + 1] = clampByte(Math.round(gd[i + 1] * w + td[i + 1] * (1 - w)));
    gd[i + 2] = clampByte(Math.round(gd[i + 2] * w + td[i + 2] * (1 - w)));
    gd[i + 3] = 255;
  }

  // 先输出无损 PNG 用于 QC
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  await sharp(gd, { raw: { width, height, channels: 4 } })
    .png().toFile(outputPath);
  return outputPath;
}

// ==================== 临时 Mask 预览 ====================

async function generateMaskPreview(templatePath, maskPath, outputPath) {
  try {
    const tpl = await sharp(templatePath).metadata();
    const { width, height } = tpl;
    const template = await sharp(templatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = await sharp(maskPath).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let i = 3; i < mask.data.length; i += 4) {
      const a = mask.data[i];
      if (a < 64) { // 核心可编辑区 → 红色
        template.data[i - 3] = clampByte(template.data[i - 3] * 0.25 + 220 * 0.75);
        template.data[i - 2] = clampByte(template.data[i - 2] * 0.25 + 40 * 0.75);
        template.data[i - 1] = clampByte(template.data[i - 1] * 0.25 + 40 * 0.75);
      } else if (a < 192) { // 羽化区 → 黄色
        template.data[i - 3] = clampByte(template.data[i - 3] * 0.4 + 240 * 0.6);
        template.data[i - 2] = clampByte(template.data[i - 2] * 0.4 + 200 * 0.6);
        template.data[i - 1] = clampByte(template.data[i - 1] * 0.4 + 20 * 0.6);
      }
      // 保护区 → 原色
    }

    const outDir = require('path').dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    await sharp(template.data, { raw: { width, height, channels: 4 } })
      .png().toFile(outputPath);
    return outputPath;
  } catch (e) { return null; }
}

// ==================== 灰度边缘结构相似度 ====================

function edgeSimilarity(imgA, imgB, width, height) {
  // Sobel 边缘提取
  function sobel(data, w, h) {
    const edges = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        const g = v => v[idx] * 0.299 + v[idx + 1] * 0.587 + v[idx + 2] * 0.114;
        const tl = g(data, ((y - 1) * w + (x - 1)) * 4);
        const tc = g(data, ((y - 1) * w + x) * 4);
        const tr = g(data, ((y - 1) * w + (x + 1)) * 4);
        const ml = g(data, (y * w + (x - 1)) * 4);
        const mr = g(data, (y * w + (x + 1)) * 4);
        const bl = g(data, ((y + 1) * w + (x - 1)) * 4);
        const bc = g(data, ((y + 1) * w + x) * 4);
        const br = g(data, ((y + 1) * w + (x + 1)) * 4);
        const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
        const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        edges[y * w + x] = clampByte(Math.round(Math.sqrt(gx * gx + gy * gy)));
      }
    }
    return edges;
  }

  const ea = sobel(imgA, width, height);
  const eb = sobel(imgB, width, height);
  let match = 0, total = 0;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i] > 30 || eb[i] > 30) {
      total++;
      if (Math.abs(ea[i] - eb[i]) < 25) match++;
    }
  }
  return total > 0 ? match / total : 1;
}

module.exports = {
  extractColor, protectOutsideMask, generateMaskPreview, edgeSimilarity,
  rgbToHex, rgbToLab, deltaE2000, describeDeviation
};
