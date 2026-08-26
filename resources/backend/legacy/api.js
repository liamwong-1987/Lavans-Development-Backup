/**
 * api.js — OpenAI兼容API接入层（yunwu.ai 中转站）
 *
 * 核心：
 *   generateImage(task) — 统一入口
 *   Response Adapter    — 兼容多种返回格式，统一输出 { success, image_url, raw }
 *
 * 错误处理：429→限流等待  500→自动重试  timeout→重试  invalid→丢弃
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const sharp = require('sharp');

// ==================== 环境变量 ====================
const BASE_URL = process.env.BASE_URL || 'https://yunwu.ai/v1';
const API_KEY = process.env.API_KEY || '';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o';
const IMAGE_SIZE = process.env.IMAGE_SIZE || '1024x1024';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_SEC || '120') * 1000;
const RETRY_MAX = parseInt(process.env.RETRY_MAX || '3');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const LOG_DIR = path.join(__dirname, '..', 'logs');

// 确保目录
[OUTPUT_DIR, LOG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// axios 实例
const client = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: `Bearer ${API_KEY}` },
  timeout: TIMEOUT_MS
});

// ==================== 日志 ====================
function apiLog(requestId, type, status, elapsed, cost, error) {
  const entry = JSON.stringify({
    time: new Date().toISOString(),
    request_id: requestId,
    type, status,
    latency_ms: elapsed,
    cost: cost?.toFixed(4) || '0.0000',
    error: error || null
  }) + '\n';
  fs.appendFileSync(path.join(LOG_DIR, `api_${new Date().toISOString().slice(0, 10)}.log`), entry);
}

function costEstimate(elapsedMs) {
  if (elapsedMs > 60000) return 0.08;
  if (elapsedMs > 30000) return 0.05;
  return 0.03;
}

// ==================== 颜色提取引擎（Sharp 像素级计算） ====================
const colorCache = new Map();
const maskCache = new Map(); // 缓存每张模板的 mask

/**
 * RGB → LAB 转换（D65 标准光源）
 * LAB 是设备无关的颜色空间，最适合做颜色精确匹配
 */
function rgbToLab(r, g, b) {
  let rr = r / 255, gg = g / 255, bb = b / 255;
  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;
  const x = (rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375) / 0.950470;
  const y = rr * 0.2126729 + gg * 0.7151522 + bb * 0.0721750;
  const z = (rr * 0.0193339 + gg * 0.1191920 + bb * 0.9503041) / 1.088830;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const L = 116 * f(y) - 16;
  const A = 500 * (f(x) - f(y));
  const B = 200 * (f(y) - f(z));
  return { L: Math.round(L * 10) / 10, A: Math.round(A * 10) / 10, B: Math.round(B * 10) / 10 };
}

/**
 * CIEDE2000 ΔE 色差计算（工业标准）
 * <1.0 → 肉眼不可分辨  <3.0 → 专业级可接受  <5.0 → 普通可接受  >5.0 → 不合格
 */
function deltaE2000(l1, a1, b1, l2, a2, b2) {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1), C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.sqrt(a1p * a1p + b1 * b1), C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = Math.atan2(b1, a1p) * 180 / Math.PI + (Math.atan2(b1, a1p) < 0 ? 360 : 0);
  const h2p = Math.atan2(b2, a2p) * 180 / Math.PI + (Math.atan2(b2, a2p) < 0 ? 360 : 0);
  const dLp = l2 - l1, dCp = C2p - C1p;
  const dh = C1p * C2p === 0 ? 0 : Math.abs(h1p - h2p) > 180 ? (h2p - h1p + (h2p <= h1p ? 360 : -360)) : h2p - h1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh * Math.PI / 360);
  const SL = 1 + 0.015 * (l1 - 50) * (l1 - 50) / Math.sqrt(20 + (l1 - 50) * (l1 - 50));
  const SC = 1 + 0.045 * C1p;
  const T = 1 - 0.17 * Math.cos((h1p - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * h1p * Math.PI / 180);
  const SH = 1 + 0.015 * C1p * T;
  const RT = -2 * Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))) * Math.sin(60 * Math.exp(-((h1p - 275) / 25) * ((h1p - 275) / 25)) * Math.PI / 180);
  return Math.sqrt(dLp * dLp / (SL * SL) + dCp * dCp / (SC * SC) + dHp * dHp / (SH * SH) + RT * dCp / SC * dHp / SH);
}

/**
 * 自动生成 Mask（区域锁定）—— Level 3 空间控制
 * 中心区域渐变透明 = AI 可改色，外围锁定 = 背景/礼盒/道具不改
 */
async function generateMask(templatePath) {
  if (maskCache.has(templatePath)) return maskCache.get(templatePath);
  try {
    const meta = await sharp(templatePath).metadata();
    const { width, height } = meta;
    const cx = width / 2, cy = height / 2;
    const maxR = Math.min(cx, cy);
    const safeR = maxR * 0.5, fadeR = maxR * 0.7;
    const channels = 4;
    const pixels = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        let alpha;
        if (dist <= safeR) alpha = 0;
        else if (dist >= fadeR) alpha = 255;
        else alpha = Math.round(255 * (dist - safeR) / (fadeR - safeR));
        const idx = (y * width + x) * channels;
        pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = 255;
        pixels[idx + 3] = alpha;
      }
    }
    const maskPath = templatePath.replace(/\.\w+$/, '_mask.png');
    if (fs.existsSync(maskPath)) fs.unlinkSync(maskPath);
    await sharp(pixels, { raw: { width, height, channels } }).png().toFile(maskPath);
    console.log(`[MASK] ${path.basename(templatePath)} → mask (安全区:${safeR.toFixed(0)}px)`);
    maskCache.set(templatePath, maskPath);
    return maskPath;
  } catch (e) {
    console.log(`[MASK] 失败: ${e.message}`);
    return null;
  }
}

/**
 * 像素级颜色提取（Sharp）—— 工业级方案
 * 策略：取画面中心区域 40%，计算颜色直方图，返回占比最高的颜色
 * 不依赖 AI 猜色，100% 计算机确定
 */
async function extractColorWithSharp(colorPath, colorHint) {
  try {
    const { data, info } = await sharp(colorPath)
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const pixels = new Uint8Array(data);

    // 取中心区域（裁去四周各 30%）
    const cx = Math.floor(width * 0.3), cy = Math.floor(height * 0.3);
    const cw = Math.floor(width * 0.4), ch = Math.floor(height * 0.4);

    // 颜色直方图（用 RGB 24-bit key 分组）
    const hist = new Map();
    for (let y = cy; y < cy + ch; y++) {
      for (let x = cx; x < cx + cw; x++) {
        const idx = (y * width + x) * channels;
        const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
        // 排除过亮（高光>240）和过暗（阴影<20）的像素
        const brightness = (r + g + b) / 3;
        if (brightness > 240 || brightness < 20) continue;
        const key = (r >> 3) << 11 | (g >> 3) << 5 | (b >> 3); // 5-bit per channel quantization
        hist.set(key, (hist.get(key) || 0) + 1);
      }
    }

    if (hist.size === 0) return null;

    // 找占比最高的颜色
    let maxKey = 0, maxCount = 0;
    for (const [key, count] of hist) {
      if (count > maxCount) { maxCount = count; maxKey = key; }
    }

    const r = ((maxKey >> 11) & 0x1F) << 3;
    const g = ((maxKey >> 5) & 0x1F) << 3;
    const b = (maxKey & 0x1F) << 3;
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    const lab = rgbToLab(r, g, b);

    const result = {
      hex,
      rgb: `${r},${g},${b}`,
      lab: `${lab.L},${lab.A},${lab.B}`,
      name: colorHint || '提取色',
      method: 'sharp_pixel'
    };

    console.log(`[COLOR-SHARP] ${path.basename(colorPath)} → HEX ${hex} LAB(${lab.L},${lab.A},${lab.B}) 目标:${colorHint || '无'}`);
    return result;
  } catch (e) {
    console.log(`[COLOR-SHARP] 失败 ${colorPath}: ${e.message}`);
    return null;
  }
}

/**
 * GPT-4o Vision 回退方案 —— 仅当 Sharp 提取失败时使用
 */
async function analyzeColorWithVision(colorPath, colorHint) {
  try {
    const b64 = fs.readFileSync(colorPath).toString('base64');
    const ext = path.extname(colorPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const hint = colorHint ? `目标色系是"${colorHint}"，在床品区域中找到这个颜色的面料。` : '';

    console.log(`[COLOR-VISION] 回退分析: ${path.basename(colorPath)}${hint ? ' → ' + colorHint : ''}`);

    const res = await client.post('/chat/completions', {
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `这是一张床品产品图。${hint}请提取床品面料（被套/床单/枕套）中间调颜色（避开高光和阴影）。只返回JSON：{"hex":"#XXXXXX","name":"中文颜色名","rgb":"R,G,B"}` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } }
        ]
      }],
      max_tokens: 150,
      temperature: 0
    });

    const content = res.data?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed?.hex) return null;

    const rgbParts = (parsed.rgb || '128,128,128').split(',').map(Number);
    const lab = rgbToLab(rgbParts[0] || 128, rgbParts[1] || 128, rgbParts[2] || 128);

    const result = {
      hex: parsed.hex,
      rgb: parsed.rgb || '128,128,128',
      lab: `${lab.L},${lab.A},${lab.B}`,
      name: parsed.name || colorHint || '未知',
      method: 'gpt4_vision_fallback'
    };

    console.log(`[COLOR-VISION] ${path.basename(colorPath)} → ${result.hex} ${result.name}`);
    return result;
  } catch (e) {
    console.log(`[COLOR-VISION] 失败 ${path.basename(colorPath)}: ${e.message}`);
    return null;
  }
}

/**
 * 统一颜色提取入口：Sharp 计算（主）→ GPT-4o Vision（回退）
 */
async function analyzeColor(colorPath, colorHint) {
  if (!colorPath || !fs.existsSync(colorPath)) return null;
  if (colorCache.has(colorPath)) return colorCache.get(colorPath);

  // 主方案：Sharp 像素级提取
  let result = await extractColorWithSharp(colorPath, colorHint);

  // 回退：GPT-4o Vision
  if (!result) {
    console.log(`[COLOR] Sharp 提取失败，回退到 Vision: ${path.basename(colorPath)}`);
    result = await analyzeColorWithVision(colorPath, colorHint);
  }

  if (!result) {
    result = { hex: '#888888', rgb: '128,128,128', lab: '50,0,0', name: colorHint || '未知', method: 'fallback_default' };
  }

  colorCache.set(colorPath, result);
  return result;
}

// ==================== 动态提示词（工业级：数值化颜色控制） ====================
function buildPrompt(task, colorInfo) {
  const tplId = task.templateId || task.templateName || '图1';

  if (colorInfo?.hex) {
    const lab = colorInfo.lab || '';
    const rgb = colorInfo.rgb || '';
    return `Change ONLY bedding fabric color.

Target color:
HEX: ${colorInfo.hex}
RGB: ${rgb}
LAB: ${lab}
Color name: ${colorInfo.name || ''}

STRICT RULES:
- Do NOT change lighting, shadows, composition, props, background
- Preserve fabric texture, folds, and material exactly
- Replace only the bedding fabric color at pixel level
- Photorealistic output. 1:1 ratio`;
  }

  const clrId = task.colorId || task.colorName || '图2';
  return `将{${tplId}}中床品的颜色，替换成{${clrId}}中的床品颜色，无色差。只改床品的颜色，严格保留床品的纹路、褶皱、材质、光影不变。不要改礼盒、丝带、道具、背景、构图、角度。光线自然，超真实感，比例1：1`;
}

// ==================== 响应适配器（核心） ====================

/**
 * Response Adapter — 兼容 yunwu.ai 不稳定的返回结构
 *
 * 支持格式：
 *   res.data.url
 *   res.data.data[0].url
 *   res.data.data[0].b64_json
 *   res.data.image
 *   res.data.images[0]
 *   纯 base64 字符串
 *
 * 统一输出：
 *   { success: true, image_url: "file://...", raw: {} }
 */
function adaptResponse(responseData, requestId) {
  const raw = responseData;

  // 尝试所有可能的图片位置
  const attempts = [
    // 格式1: res.data.url
    () => raw?.url,
    // 格式2: res.data.data[0].url
    () => raw?.data?.[0]?.url,
    // 格式3: res.data.data[0].b64_json
    () => raw?.data?.[0]?.b64_json,
    // 格式4: res.data.image
    () => raw?.image,
    // 格式5: res.data.images[0]
    () => raw?.images?.[0],
    // 格式6: 直接在顶层是 base64 字符串（长度>100且只含base64字符）
    () => {
      if (typeof raw === 'string' && raw.length > 100 && /^[A-Za-z0-9+/=]+$/.test(raw.substring(0, 100))) {
        return raw;
      }
      return null;
    }
  ];

  for (const fn of attempts) {
    try {
      const result = fn();
      if (result) {
        const isBase64 = typeof result === 'string'
          && result.length > 100
          && !result.startsWith('http');

        let imageUrl;
        if (isBase64) {
          // base64 → 落盘
          const filename = `img_${requestId}_${Date.now()}.png`;
          const filePath = path.join(OUTPUT_DIR, filename);
          // 修复: 先删除已存在文件，避免 Windows 下覆盖写入问题
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          fs.writeFileSync(filePath, Buffer.from(result, 'base64'));
          imageUrl = `file://${filePath}`;
        } else if (typeof result === 'string' && result.startsWith('http')) {
          imageUrl = result; // URL，调用者负责下载
        } else {
          imageUrl = String(result);
        }

        return { success: true, image_url: imageUrl, raw };
      }
    } catch (e) {
      // 该格式不匹配，继续尝试下一个
    }
  }

  // 所有格式都不匹配
  return { success: false, image_url: '', raw, error: 'response_no_image' };
}

// ==================== 错误分类处理 ====================

/**
 * 根据 HTTP 状态码和错误类型，返回处理策略
 *
 * 返回: { action: 'retry'|'wait_and_retry'|'discard'|'fatal', waitMs: number }
 */
function classifyError(statusCode, errorMessage) {
  // 429 → 限流，等待后重试
  if (statusCode === 429) {
    return { action: 'wait_and_retry', waitMs: 5000 };
  }
  // 500/502/503 → 服务器错误，自动重试
  if (statusCode >= 500) {
    return { action: 'retry', waitMs: 2000 };
  }
  // timeout
  if (errorMessage?.includes('timeout') || errorMessage?.includes('ETIMEDOUT') || errorMessage?.includes('ECONNABORTED')) {
    return { action: 'retry', waitMs: 3000 };
  }
  // 4xx（非429）→ 请求错误，丢弃
  if (statusCode >= 400 && statusCode < 500) {
    return { action: 'discard', waitMs: 0 };
  }
  // 网络错误 → 重试
  if (errorMessage?.includes('ECONN') || errorMessage?.includes('ENOTFOUND') || errorMessage?.includes('network')) {
    return { action: 'retry', waitMs: 3000 };
  }
  // 其他 → 丢弃
  return { action: 'discard', waitMs: 0 };
}

// ==================== 统一入口：generateImage ====================

/**
 * generateImage(task) — 唯一对外入口
 *
 * @param {Object} task  { templatePath, colorPath, templateName, colorName, outputPath }
 * @returns {Object}     { success, image_url, raw, cost, requestId, elapsed }
 */
async function generateImage(task) {
  const requestId = crypto.randomBytes(6).toString('hex');
  const t0 = Date.now();

  let lastError = null;
  let attempt = 0;

  // 分析颜色参考图（缓存复用，同一张图只分析一次）
  const colorInfo = task.colorPath ? await analyzeColor(task.colorPath, task.colorNameWithoutExt) : null;

  // 生成区域锁定 Mask（缓存复用）
  const maskPath = task.templatePath ? await generateMask(task.templatePath) : null;

  while (attempt <= RETRY_MAX) {
    attempt++;

    try {
      // ===== 构建请求 =====
      const form = new FormData();
      form.append('image', fs.createReadStream(task.templatePath), {
        filename: 'template.jpg',
        contentType: 'image/jpeg'
      });
      // Level 3 空间锁：Mask 锁定非床品区域
      if (maskPath && fs.existsSync(maskPath)) {
        form.append('mask', fs.createReadStream(maskPath), {
          filename: 'mask.png',
          contentType: 'image/png'
        });
      }
      form.append('model', IMAGE_MODEL);
      form.append('size', IMAGE_SIZE);
      form.append('n', '1');
      form.append('response_format', 'b64_json');
      form.append('prompt', buildPrompt(task, colorInfo));

      console.log(`[API] #${attempt} ${task.templateName}→${task.colorName}${maskPath ? ' [MASK]' : ''}`);

      // ===== 发送请求 =====
      const res = await client.post('/images/edits', form, {
        headers: form.getHeaders(),
        timeout: TIMEOUT_MS
      });

      const elapsed = Date.now() - t0;
      const cost = costEstimate(elapsed);

      // ===== Response Adapter =====
      const adapted = adaptResponse(res.data, requestId);

      if (adapted.success) {
        // ===== 图片落盘 =====
        let finalUrl = adapted.image_url;

        // 如果是远程URL，立即下载到本地
        if (finalUrl.startsWith('http://') || finalUrl.startsWith('https://')) {
          const localPath = task.outputPath || path.join(OUTPUT_DIR, `gen_${requestId}.png`);
          await downloadToFile(finalUrl, localPath);
          finalUrl = `file://${localPath}`;
        }
        // 如果还没落盘（base64已被adapter保存），确认路径
        if (finalUrl.startsWith('file://') && task.outputPath) {
          const srcPath = finalUrl.replace('file://', '');
          if (srcPath !== task.outputPath && fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, task.outputPath);
            finalUrl = `file://${task.outputPath}`;
          }
        }

        apiLog(requestId, 'generate', 'OK', elapsed, cost);

        // Level 3 校验锁：Delta E 色差计算
        let deltaE = null;
        if (colorInfo?.hex && task.outputPath && fs.existsSync(task.outputPath)) {
          try {
            const outColor = await extractColorWithSharp(task.outputPath, null);
            if (outColor) {
              const labParts = outColor.lab.split(',').map(Number);
              const tgtParts = colorInfo.lab.split(',').map(Number);
              deltaE = Math.round(deltaE2000(tgtParts[0], tgtParts[1], tgtParts[2], labParts[0], labParts[1], labParts[2]) * 10) / 10;
              console.log(`[DELTA-E] ${path.basename(task.outputPath)} → ΔE=${deltaE} (目标:${colorInfo.lab} 输出:${outColor.lab})${deltaE > 5 ? ' ⚠️偏大' : deltaE < 3 ? ' ✓' : ''}`);
            }
          } catch (e) { /* 校验失败不影响生成 */ }
        }

        return {
          success: true,
          image_url: finalUrl,
          raw: adapted.raw,
          cost,
          requestId,
          elapsed,
          deltaE
        };
      }

      // Adapter 返回失败（响应格式不匹配）
      lastError = adapted.error || 'response_no_image';
      apiLog(requestId, 'generate', 'FAIL', elapsed, cost, lastError);
      console.log(`[API] 响应无图片，格式: ${JSON.stringify(adapted.raw).substring(0, 200)}`);

      const strategy = classifyError(0, 'invalid response');
      if (strategy.action === 'discard') {
        return {
          success: false,
          image_url: '',
          raw: adapted.raw,
          cost: 0,
          requestId,
          elapsed,
          error: '响应无图片数据（无效响应，已丢弃）'
        };
      }
      // retry
      await sleep(strategy.waitMs);
      continue;

    } catch (e) {
      const elapsed = Date.now() - t0;
      const statusCode = e.response?.status || 0;
      const errorMsg = e.response?.data?.error?.message || e.message || 'unknown';
      const strategy = classifyError(statusCode, errorMsg);

      console.log(`[API] 错误: ${statusCode} ${errorMsg} → ${strategy.action}`);

      if (strategy.action === 'fatal') {
        apiLog(requestId, 'generate', 'FATAL', elapsed, 0, errorMsg);
        return { success: false, image_url: '', raw: null, cost: 0, requestId, elapsed, error: errorMsg };
      }

      if (strategy.action === 'discard') {
        apiLog(requestId, 'generate', 'DISCARD', elapsed, 0, errorMsg);
        return { success: false, image_url: '', raw: null, cost: 0, requestId, elapsed, error: `已丢弃(${statusCode}: ${errorMsg})` };
      }

      // retry 或 wait_and_retry
      lastError = errorMsg;
      apiLog(requestId, 'generate', `RETRY_${attempt}`, elapsed, 0, errorMsg);

      if (attempt <= RETRY_MAX) {
        await sleep(strategy.waitMs);
        continue;
      }
    }
  }

  // 所有重试耗尽
  const finalElapsed = Date.now() - t0;
  apiLog(requestId, 'generate', 'EXHAUSTED', finalElapsed, 0, lastError);
  return {
    success: false,
    image_url: '',
    raw: null,
    cost: 0,
    requestId,
    elapsed: finalElapsed,
    error: `重试${RETRY_MAX}次后仍失败: ${lastError}`
  };
}

// ==================== AI校验（vision模型） ====================

async function validatePair(templatePath, colorPath) {
  try {
    const tplB64 = `data:image/jpeg;base64,${fs.readFileSync(templatePath).toString('base64')}`;
    const clrB64 = `data:image/jpeg;base64,${fs.readFileSync(colorPath).toString('base64')}`;

    const res = await client.post('/chat/completions', {
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Are both images bedding product photos? Output JSON: {"score":<0-100>,"is_bedding":<bool>,"is_color":<bool>,"reason":"<brief>"}' },
          { type: 'image_url', image_url: { url: tplB64, detail: 'low' } },
          { type: 'image_url', image_url: { url: clrB64, detail: 'low' } }
        ]
      }],
      max_tokens: 120,
      temperature: 0
    });

    const content = res.data?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { score: 50, reason: 'parse error' };
  } catch {
    return { score: 0, reason: 'validation failed' };
  }
}

// ==================== API连通性测试 ====================

/**
 * GET /api/test 使用的连通性测试
 * 创建一张极小的测试图，调用 images/edits，验证连通性
 */
async function testConnection() {
  const requestId = 'test_' + crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();

  try {
    // 使用一个真实的测试图片（从 uploads 或创建一个有效的1x1 PNG）
    let testImage;
    const testPath = path.join(__dirname, '..', 'uploads', 'templates');
    if (fs.existsSync(testPath)) {
      const files = fs.readdirSync(testPath).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      if (files.length > 0) {
        testImage = fs.readFileSync(path.join(testPath, files[0]));
      }
    }
    if (!testImage) {
      // 降级：最小有效PNG（1x1红色像素）
      testImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
    }

    const form = new FormData();
    form.append('image', testImage, { filename: 'test.png', contentType: 'image/png' });
    form.append('model', IMAGE_MODEL);
    form.append('size', '1024x1024');
    form.append('n', '1');
    form.append('prompt', 'Generate a simple test image');

    const res = await client.post('/images/edits', form, {
      headers: form.getHeaders(),
      timeout: 30000
    });

    const elapsed = Date.now() - t0;

    // Response Adapter
    const adapted = adaptResponse(res.data, requestId);

    apiLog(requestId, 'test', adapted.success ? 'OK' : 'FAIL', elapsed, 0, adapted.success ? null : 'no_image');

    return {
      success: adapted.success,
      message: adapted.success ? 'API连通正常 ✓' : 'API连通但无法获取图片',
      endpoint: BASE_URL,
      model: IMAGE_MODEL,
      latency_ms: elapsed,
      raw_keys: res.data ? Object.keys(res.data) : [],
      has_data_field: !!res.data?.data,
      data_count: res.data?.data?.length || 0
    };
  } catch (e) {
    const elapsed = Date.now() - t0;
    const statusCode = e.response?.status || 0;
    const errorMsg = e.response?.data?.error?.message || e.message;

    apiLog(requestId, 'test', 'FAIL', elapsed, 0, errorMsg);

    return {
      success: false,
      message: `连接失败: ${errorMsg}`,
      endpoint: BASE_URL,
      model: IMAGE_MODEL,
      latency_ms: elapsed,
      status_code: statusCode,
      error: errorMsg
    };
  }
}

// ==================== 辅助 ====================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function downloadToFile(url, filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 修复: 先删除已存在文件，避免 Windows 下覆盖写入问题
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000
  });
  fs.writeFileSync(filePath, Buffer.from(res.data));
  return filePath;
}

module.exports = { generateImage, validatePair, testConnection, analyzeColor, generateMask, maskCache, colorCache, costEstimate };
