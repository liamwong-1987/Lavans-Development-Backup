/**
 * apiClient.js v3 — 单阶段复色：gpt-image-2 直接根据双图进行图生图
 * 一键复色只根据模板图、参考色图和提示词提交一次图生图。
 * Vision 分析函数仅保留给独立手动工具，任务链不会自动调用。
 */
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');

const BASE_URL = process.env.BASE_URL || 'https://yunwu.ai/v1';
const API_KEY = process.env.API_KEY || '';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o';
const IMAGE_SIZE = process.env.IMAGE_SIZE || '1024x1024';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_SEC || '120') * 1000;

// ==================== 画布 Provider 解析 ====================
// 复色打通画布 Provider：根据 providerId 从 canvas-config.json 读对应配置，
// 用 Provider 的 api_key/base_url/image_models 替代 .env 全局常量。
let _moduleConfigService = null;
function getModuleConfigService() {
  if (!_moduleConfigService) {
    try { _moduleConfigService = require('./moduleConfigService'); } catch (e) {}
  }
  return _moduleConfigService;
}

function resolveProvider(providerId) {
  const svc = getModuleConfigService();
  if (!svc || !providerId) return null;
  try {
    const canvas = svc.getModuleConfig('canvas');
    const providers = canvas.providers || [];
    const p = providers.find(x => x.id === providerId && x.enabled !== false)
      || providers.find(x => x.id === providerId)
      || null;
    if (!p) return null;
    return {
      id: p.id,
      name: p.name || p.id,
      protocol: p.protocol || 'openai',
      base_url: p.base_url || '',
      api_key: p.api_key || '',
      image_models: Array.isArray(p.image_models) ? p.image_models : [],
      image_request_mode: p.image_request_mode || 'openai',
      image_generation_endpoint: p.image_generation_endpoint || '',
      image_edit_endpoint: p.image_edit_endpoint || '',
      model_names: p.model_names || {},
      model_protocols: p.model_protocols || {}
    };
  } catch (e) {
    return null;
  }
}

function providerConfig(providerId, fallback = {}) {
  const p = resolveProvider(providerId);
  if (!p) return {
    baseUrl: fallback.baseUrl || BASE_URL,
    apiKey: fallback.apiKey || API_KEY,
    imageModel: fallback.imageModel || IMAGE_MODEL,
    protocol: fallback.protocol || 'openai',
    image_models: fallback.image_models || [],
    image_request_mode: fallback.image_request_mode || 'openai',
    image_generation_endpoint: fallback.image_generation_endpoint || '',
    image_edit_endpoint: fallback.image_edit_endpoint || ''
  };
  return {
    baseUrl: p.base_url || BASE_URL,
    apiKey: p.api_key || API_KEY,
    imageModel: (p.image_models && p.image_models[0]) || IMAGE_MODEL,
    protocol: p.protocol,
    image_models: p.image_models,
    image_request_mode: p.image_request_mode,
    image_generation_endpoint: p.image_generation_endpoint,
    image_edit_endpoint: p.image_edit_endpoint
  };
}

// --- downloadUrl 重试配置 ---
const DOWNLOAD_RETRY_MAX = Number(process.env.DOWNLOAD_RETRY_MAX || 3);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 60000);
const DOWNLOAD_RETRY_BASE_DELAY_MS = Number(process.env.DOWNLOAD_RETRY_BASE_DELAY_MS || 2000);
const DOWNLOAD_TLS_INSECURE = process.env.DOWNLOAD_TLS_INSECURE === 'true';
const APIMART_POLL_INTERVAL_MS = Number(process.env.APIMART_POLL_INTERVAL_MS || 2000);
const APIMART_POLL_TIMEOUT_MS = Number(process.env.APIMART_POLL_TIMEOUT_SEC || 240) * 1000;

const client = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: `Bearer ${API_KEY}` },
  timeout: TIMEOUT_MS
});

// ==================== Response Adapter ====================

function adaptResponse(data) {
  // chat completions 响应：choices[0].message.content 可能包含生成的图片
  const attempts = [
    // 标准格式：data.choices[0].message.content 中的图片
    () => {
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;
      // 如果是纯 base64 字符串
      if (typeof content === 'string' && content.length > 100 && !content.startsWith('http')) return content;
      // 如果是数组（多模态响应）
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'image_url' && part.image_url?.url) return part.image_url.url;
          if (part.type === 'image' && part.data) return part.data;
          if (part.type === 'b64_json' && part.b64_json) return part.b64_json;
        }
      }
      // 检查 content 里有没有 Markdown 图片链接
      const mdMatch = typeof content === 'string' ? content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/) : null;
      if (mdMatch) return mdMatch[1];
      // 检查是不是 JSON 字符串里嵌了图片
      if (typeof content === 'string') {
        try { const parsed = JSON.parse(content); if (parsed.url) return parsed.url; if (parsed.b64_json) return parsed.b64_json; } catch (e) {}
      }
      return null;
    },
    // 旧格式兼容：data.data[0].b64_json
    () => data?.data?.[0]?.b64_json,
    () => data?.data?.[0]?.url,
    () => data?.url,
  ];

  for (const fn of attempts) {
    try {
      const result = fn();
      if (!result) continue;
      const isBase64 = typeof result === 'string' && !result.startsWith('http');
      return { success: true, type: isBase64 ? 'base64' : 'url', data: result };
    } catch (e) {}
  }
  return { success: false, error: 'no_image_in_response' };
}

// ==================== 核心调用 ====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCancelled(error, signal) {
  return signal?.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'AbortError';
}

function remoteUnknownError(error, details = {}) {
  const wrapped = error instanceof Error ? error : new Error(String(error || '远端结果未知'));
  wrapped.remoteResultUnknown = true;
  wrapped.generationAttempts = 1;
  if (details.providerTaskId) wrapped.providerTaskId = details.providerTaskId;
  return wrapped;
}

function knownGenerationError(error, details = {}) {
  const wrapped = error instanceof Error ? error : new Error(String(error || '生成失败'));
  wrapped.remoteResultUnknown = false;
  wrapped.generationAttempts = 1;
  if (details.providerTaskId) wrapped.providerTaskId = details.providerTaskId;
  return wrapped;
}

function isGlobalGenerationError(error) {
  const status = Number(error?.response?.status || 0);
  const message = String(error?.response?.data?.error?.message || error?.response?.data?.message || error?.message || '');
  if ([401, 402].includes(status)) return true;
  if (status === 403 && /key|auth|credential|balance|credit|quota|permission|密钥|认证|余额|额度|权限/i.test(message)) return true;
  if (status === 404 && /model|endpoint|route|not found|模型|接口|地址/i.test(message)) return true;
  if ([400, 422, 429].includes(status) && /model|key|auth|credential|balance|credit|quota|endpoint|模型|密钥|认证|余额|额度|接口/i.test(message)) return true;
  return /生成接口地址无效|全局 API 设置|API key|invalid key|incorrect key|insufficient balance|insufficient quota|model.+not.+found|密钥.*无效|余额.*不足|额度.*不足|模型.*不存在/i.test(message);
}

function isModelUnavailableError(error) {
  const status = Number(error?.response?.status || 0);
  const message = String(error?.response?.data?.error?.message || error?.response?.data?.message || error?.message || '');
  if (![0, 400, 404, 410, 422].includes(status)) return false;
  return /model(?:\s|_|-)*(?:not found|unavailable|disabled|unsupported|does not exist)|模型.*(?:不存在|不可用|已停用|不支持)|不支持.*模型/i.test(message);
}

function classifyGenerationResponseError(error, details = {}) {
  const status = Number(error?.response?.status || 0);
  // A 5xx response does not prove the upstream generation was never created.
  if (status >= 500) return remoteUnknownError(error, details);
  const wrapped = knownGenerationError(error, details);
  if (isGlobalGenerationError(error)) wrapped.globalApiError = true;
  if (isModelUnavailableError(error)) wrapped.modelUnavailable = true;
  return wrapped;
}

function assertHttpEndpoint(endpoint) {
  let parsed;
  const invalidEndpoint = () => {
    const error = new Error('生成接口地址无效，请检查全局 API 设置');
    error.globalApiError = true;
    return error;
  };
  try { parsed = new URL(endpoint); } catch (_) { throw invalidEndpoint(); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw invalidEndpoint();
}

async function notifyGenerationAttempt(options, details = {}) {
  if (typeof options.onGenerationAttempt === 'function') {
    await options.onGenerationAttempt({ requestId: options.requestId || '', ...details });
  }
}

/** 图片文件转 base64 data URL，非标准格式自动转 PNG */
const { default: sharp } = require('sharp');

async function imageToBase64Async(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const WEB_SAFE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const mime = WEB_SAFE[ext];
  if (mime) {
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }
  // 非 web 格式 → Sharp 转 PNG
  try {
    const pngBuf = await sharp(filePath).png().toBuffer();
    return `data:image/png;base64,${pngBuf.toString('base64')}`;
  } catch (e) {
    console.warn('[apiClient] 格式转换失败:', filePath, e.message);
    return null;
  }
}

// ==================== 可选 Stage 1: Vision 分析参考图 ====================

/** 用 Vision 模型分析参考图，提取颜色/材质/纹理/光泽等结构化信息 */
async function analyzeColorImage(colorImagePath) {
  const clrB64 = await imageToBase64Async(colorImagePath);
  if (!clrB64) return null;

  const body = {
    model: VISION_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `分析这张参考图片的床品颜色特征，请严格按以下格式返回（不要加任何多余文字）：

主色调HEX: #XXXXXX
辅色调HEX: #XXXXXX（如无则写"无"）
建议文字色HEX: #XXXXXX（与主色调相同，用于图中英文/LOGO的着色）
材质: （如纯棉/丝绸/亚麻/绒面等）
纹理: （如光滑/磨毛/条纹/格纹等）
光泽度: （哑光/微光/高光）
色彩风格: （如莫兰迪/复古/清新/奢华等）
颜色饱和度: （低/中/高）

只返回上述格式，不要解释。` },
        { type: 'image_url', image_url: { url: clrB64, detail: 'high' } }
      ]
    }],
    max_tokens: 300,
    temperature: 0.3,
  };

  try {
    const res = await client.post('/chat/completions', body, { timeout: 30000 });
    const text = res.data?.choices?.[0]?.message?.content || '';
    console.log('[Vision] 参考图分析结果:\n' + text);
    return text.trim();
  } catch (e) {
    console.warn('[Vision] 分析失败，跳过:', e.message);
    return null;
  }
}

function imageMimeFromExt(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function appendImageFile(form, field, filePath, appended) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  form.append(field, new Blob([buf], { type: imageMimeFromExt(filePath) }), filename);
  appended.push({ field, filename, bytes: buf.length });
}

function geminiImagePart(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return {
    inline_data: {
      mime_type: imageMimeFromExt(filePath),
      data: fs.readFileSync(filePath).toString('base64')
    }
  };
}

function extractGeminiImage(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    const mime = inline?.mimeType || inline?.mime_type || '';
    if (inline?.data && String(mime).startsWith('image/')) {
      return { success: true, type: 'base64', data: inline.data };
    }
  }
  return { success: false, error: 'no_image_in_gemini_response' };
}

function isGeminiImageModel(model) {
  return /gemini-.*image/i.test(model || IMAGE_MODEL);
}

async function editImageWithGemini({ imagePath, colorImagePath, prompt, size, signal, providerId, model, requestId, onGenerationAttempt }) {
  const pcfg = providerConfig(providerId);
  const effBaseUrl = pcfg.baseUrl;
  const effApiKey = pcfg.apiKey;
  const effModel = model || pcfg.imageModel;
  const parts = [{ text: prompt }];
  const templatePart = geminiImagePart(imagePath);
  const colorPart = geminiImagePart(colorImagePath);
  if (templatePart) parts.push(templatePart);
  if (colorPart) parts.push(colorPart);

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: {
        aspectRatio: '1:1',
        imageSize: (size || IMAGE_SIZE).includes('2048') ? '2K' : '1K'
      }
    }
  };

  const endpoint = `${effBaseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1beta/models/${effModel}:generateContent`;
  assertHttpEndpoint(endpoint);
  console.log(`[API] Provider:${providerId || '默认'} | 生图:${effModel} | 接口:gemini generateContent | 图片数:${parts.filter(p=>p.inline_data).length}`);

  const attemptOptions = { requestId, onGenerationAttempt };
  await notifyGenerationAttempt(attemptOptions, { providerId, model: effModel, protocol: 'gemini' });
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${effApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (isCancelled(error, signal)) throw new Error('任务已取消');
    throw remoteUnknownError(error);
  }

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) {}
  if (!res.ok) {
    const message = data?.error?.message || data?.message || text.slice(0, 1000) || `HTTP ${res.status}`;
    const err = new Error(message);
    err.response = { status: res.status, data };
    throw classifyGenerationResponseError(err);
  }

  return { ...extractGeminiImage(data), generationAttempts: 1 };
}

function apimartBaseUrl() {
  return BASE_URL.replace(/\/$/, '');
}

async function apimartRequest(pathname, options = {}) {
  try {
    const method = String(options.method || 'GET').toLowerCase();
    const base = (options.baseUrl || apimartBaseUrl()).replace(/\/$/, '');
    const key = options.apiKey || API_KEY;
    const response = await axios.request({
      method,
      url: `${base}${pathname}`,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      data: options.body,
      timeout: TIMEOUT_MS,
      signal: options.signal
    });
    const data = response.data || {};
    if (data.code != null && Number(data.code) !== 200) {
      const err = new Error(data?.error?.message || data?.message || `APIMart code ${data.code}`);
      err.response = { status: response.status, data };
      throw err;
    }
    return data;
  } catch (error) {
    if (error.response) throw error;
    const err = new Error(error.message || 'APIMart 请求失败');
    err.code = error.code;
    err.cause = error;
    throw err;
  }
}

async function editImageWithApimart({ imagePath, colorImagePath, prompt, size, signal, providerId, quality, model, requestId, onGenerationAttempt }) {
  const pcfg = providerConfig(providerId);
  let effBaseUrl = pcfg.baseUrl;
  // apimart 协议需以 /v1 结尾（对齐画布模块 modelScopeApiRoot 的补全逻辑）
  if (effBaseUrl && !/\/v1\/?$/i.test(effBaseUrl)) effBaseUrl = effBaseUrl.replace(/\/+$/, '') + '/v1';
  const effApiKey = pcfg.apiKey;
  const effModel = model || pcfg.imageModel;

  const imageUrls = [];
  const templateB64 = await imageToBase64Async(imagePath);
  const colorB64 = await imageToBase64Async(colorImagePath);
  if (templateB64) imageUrls.push(templateB64);
  if (colorB64) imageUrls.push(colorB64);
  if (!imageUrls.length) throw new Error('APIMart 参考图读取失败');

  const body = {
    model: effModel,
    prompt,
    n: 1,
    size: size || IMAGE_SIZE,
    resolution: process.env.APIMART_RESOLUTION || '1k',
    image_urls: imageUrls
  };
  if (quality) body.quality = quality;
  console.log(`[API] Provider:${providerId || 'apimart'} | 生图:${effModel} | 平台:APIMart | 接口:/images/generations JSON | 图片数:${imageUrls.length}`);
  assertHttpEndpoint(`${effBaseUrl}/images/generations`);
  const attemptOptions = { requestId, onGenerationAttempt };
  await notifyGenerationAttempt(attemptOptions, { providerId, model: effModel, protocol: 'apimart' });
  let submitted;
  try {
    submitted = await apimartRequest('/images/generations', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
      baseUrl: effBaseUrl,
      apiKey: effApiKey
    });
  } catch (error) {
    if (isCancelled(error, signal)) throw new Error('任务已取消');
    if (!error.response) throw remoteUnknownError(error);
    throw classifyGenerationResponseError(error);
  }
  const taskId = submitted?.data?.[0]?.task_id || submitted?.data?.task_id;
  if (!taskId) throw remoteUnknownError(new Error('APIMart 已响应但未返回 task_id'));
  await notifyGenerationAttempt(attemptOptions, { providerId, model: effModel, protocol: 'apimart', providerTaskId: taskId });

  const started = Date.now();
  while (Date.now() - started < APIMART_POLL_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error('任务已取消');
    let result;
    try {
      result = await apimartRequest(`/tasks/${encodeURIComponent(taskId)}?language=zh`, { method: 'GET', signal, baseUrl: effBaseUrl, apiKey: effApiKey });
    } catch (error) {
      if (isCancelled(error, signal)) throw new Error('任务已取消');
      throw remoteUnknownError(error, { providerTaskId: taskId });
    }
    const task = result?.data || {};
    if (task.status === 'completed') {
      const url = task?.result?.images?.[0]?.url?.[0];
      if (!url) throw knownGenerationError(new Error('APIMart 任务完成但未返回图片 URL'), { providerTaskId: taskId });
      return { success: true, type: 'url', data: url, providerTaskId: taskId, generationAttempts: 1 };
    }
    if (['failed', 'cancelled'].includes(task.status)) {
      throw knownGenerationError(new Error(task?.error?.message || `APIMart 任务${task.status}`), { providerTaskId: taskId });
    }
    await sleep(APIMART_POLL_INTERVAL_MS);
  }
  throw remoteUnknownError(new Error(`APIMart 任务仍在远端执行（task_id: ${taskId}）`), { providerTaskId: taskId });
}

// ==================== Stage 2: 图片生成 ====================

async function editImageOnce({ imagePath, colorImagePath, prompt, size, signal, providerId, quality, model, requestId, onGenerationAttempt }) {
  // 打通画布 Provider：优先用 providerId 解析配置，否则回退 .env 常量
  const pcfg = providerConfig(providerId);
  const effBaseUrl = pcfg.baseUrl;
  const effApiKey = pcfg.apiKey;
  const effModel = model || pcfg.imageModel;
  const effProtocol = pcfg.protocol;

  // APIMART 协议：走异步 task 提交 + 轮询
  if (effProtocol === 'apimart' || /api\.apimart\.ai/i.test(effBaseUrl)) {
    return editImageWithApimart({ imagePath, colorImagePath, prompt, size, signal, providerId, quality, model: effModel, requestId, onGenerationAttempt });
  }

  // Gemini 模型
  if (effProtocol === 'gemini' || isGeminiImageModel(effModel)) {
    return editImageWithGemini({ imagePath, colorImagePath, prompt, size, signal, providerId, model: effModel, requestId, onGenerationAttempt });
  }

  const form = new FormData();
  form.append('model', effModel);
  form.append('prompt', prompt);
  form.append('size', size || IMAGE_SIZE);
  form.append('n', '1');
  if (quality) form.append('quality', quality);

  const appended = [];
  appendImageFile(form, 'image', imagePath, appended);
  appendImageFile(form, 'image', colorImagePath, appended);

  const editEndpoint = pcfg.image_edit_endpoint || `${effBaseUrl.replace(/\/$/, '')}/images/edits`;
  assertHttpEndpoint(editEndpoint);
  console.log(`[API] Provider:${providerId || '默认'} | 生图:${effModel} | 接口:${editEndpoint} | 图片数:${appended.filter(x=>x.field==='image').length}`);

  await notifyGenerationAttempt({ requestId, onGenerationAttempt }, { providerId, model: effModel, protocol: 'openai' });
  let res;
  try {
    res = await fetch(editEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${effApiKey}` },
      body: form,
      signal
    });
  } catch (error) {
    if (isCancelled(error, signal)) throw new Error('任务已取消');
    throw remoteUnknownError(error);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${res.status}`;
    const err = new Error(message);
    err.response = { status: res.status, data };
    throw classifyGenerationResponseError(err);
  }

  return { ...adaptResponse(data), generationAttempts: 1 };
}

async function editImage(options) {
  if (options.signal?.aborted) throw new Error('任务已取消');
  const result = await editImageOnce(options);
  if (!result.success) throw knownGenerationError(new Error(result.error || 'API未返回图片'));
  return result;
}

async function checkHealth({ providerId = '', signal } = {}) {
  const pcfg = providerConfig(providerId);
  const baseUrl = String(pcfg.baseUrl || '').replace(/\/$/, '');
  try {
    assertHttpEndpoint(baseUrl);
  } catch (error) {
    return { success: false, code: 'INVALID_ENDPOINT', error: error.message };
  }
  if (!pcfg.apiKey) return { success: false, code: 'API_KEY_MISSING', error: 'API 密钥未配置' };

  const protocol = String(pcfg.protocol || 'openai').toLowerCase();
  const endpoint = protocol === 'gemini'
    ? `${baseUrl}/models?key=${encodeURIComponent(pcfg.apiKey)}`
    : `${baseUrl}/models`;
  const headers = protocol === 'gemini' ? {} : { Authorization: `Bearer ${pcfg.apiKey}` };
  try {
    const response = await fetch(endpoint, { method: 'GET', headers, signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { success: false, status: response.status, error: data?.error?.message || data?.message || `HTTP ${response.status}` };
    }
    return { success: true, status: response.status };
  } catch (error) {
    if (isCancelled(error, signal)) throw new Error('健康检查已取消');
    return { success: false, code: error?.code || 'HEALTH_CHECK_FAILED', error: error?.message || '健康检查失败' };
  }
}

async function queryGenerationResult({ providerId = '', providerTaskId, signal } = {}) {
  if (!providerTaskId) return { success: false, supported: false, status: 'unknown', error: '服务商未返回可查询的任务编号' };
  const pcfg = providerConfig(providerId);
  if (pcfg.protocol !== 'apimart' && !/api\.apimart\.ai/i.test(pcfg.baseUrl || '')) {
    return { success: false, supported: false, status: 'unknown', error: '当前服务商不支持远端任务查询' };
  }
  let baseUrl = String(pcfg.baseUrl || '').replace(/\/$/, '');
  if (!/\/v1$/i.test(baseUrl)) baseUrl += '/v1';
  try {
    const result = await apimartRequest(`/tasks/${encodeURIComponent(providerTaskId)}?language=zh`, {
      method: 'GET', signal, baseUrl, apiKey: pcfg.apiKey
    });
    const task = result?.data || {};
    if (task.status === 'completed') {
      const url = task?.result?.images?.[0]?.url?.[0];
      return url
        ? { success: true, supported: true, status: 'completed', type: 'url', data: url, providerTaskId }
        : { success: false, supported: true, status: 'failed', error: '远端任务完成但未返回图片地址', providerTaskId };
    }
    if (['failed','cancelled'].includes(task.status)) {
      return { success: false, supported: true, status: 'failed', error: task?.error?.message || `远端任务${task.status}`, providerTaskId };
    }
    return { success: true, supported: true, status: 'unknown', providerTaskId };
  } catch (error) {
    if (isCancelled(error, signal)) throw new Error('远端结果查询已取消');
    return { success: false, supported: true, status: 'unknown', error: error?.message || '远端结果查询失败', providerTaskId };
  }
}

/** 校验 Buffer 是否为有效图片格式（通过文件头 magic bytes） */
function isValidImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG:  89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // GIF:  47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  // BMP:  42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true;
  return false;
}

async function downloadUrl(url, signal) {
  let lastErr;

  for (let attempt = 0; attempt <= DOWNLOAD_RETRY_MAX; attempt++) {
    if (signal?.aborted) throw new Error('任务已取消');

    let httpsAgent = null;
    try {
      const options = {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal
      };

      if (DOWNLOAD_TLS_INSECURE) {
        httpsAgent = new https.Agent({ rejectUnauthorized: false });
        options.httpsAgent = httpsAgent;
      }

      const res = await axios.get(url, options);
      const buffer = Buffer.from(res.data);

      // 校验下载内容是否为有效图片（防止 CDN 返回 HTML 错误页等非图片数据）
      if (buffer.length === 0) {
        throw Object.assign(new Error('下载内容为空'), { code: 'EMPTY_RESPONSE', retryable: true });
      }
      if (!isValidImageBuffer(buffer)) {
        // 内容不是图片 → 可能是 CDN 错误页/重定向 → 当作网络层异常，触发重试
        const preview = buffer.slice(0, 200).toString('utf8').replace(/[\r\n]/g, ' ');
        const err = new Error(`下载内容非图片格式 (magic bytes mismatch, 前200字节: ${preview})`);
        err.code = 'INVALID_IMAGE_CONTENT';
        err.retryable = true;
        lastErr = err;
        if (attempt >= DOWNLOAD_RETRY_MAX) throw err;
        const delay = DOWNLOAD_RETRY_BASE_DELAY_MS * (attempt + 1);
        console.warn(`[downloadUrl] retry ${attempt + 1}/${DOWNLOAD_RETRY_MAX} (非图片内容), delay=${delay}ms, url=${String(url).slice(0, 80)}...`);
        await sleep(delay);
        continue;
      }
      return buffer;
    } catch (err) {
      // 用户取消 → 立即抛出，不重试
      if (signal?.aborted || err?.code === 'ERR_CANCELED') {
        throw new Error('任务已取消');
      }
      lastErr = err;
      const retryable = err.retryable === true || isRetryableDownloadError(err);
      if (!retryable || attempt >= DOWNLOAD_RETRY_MAX) {
        throw err;
      }
      const delay = DOWNLOAD_RETRY_BASE_DELAY_MS * (attempt + 1);
      console.warn(`[downloadUrl] retry ${attempt + 1}/${DOWNLOAD_RETRY_MAX}, delay=${delay}ms, reason=${err.message}, url=${String(url).slice(0, 80)}...`);
      await sleep(delay);
    } finally {
      // 释放TLS Agent资源
      if (httpsAgent) {
        try { httpsAgent.destroy(); } catch (_) {}
      }
    }
  }
  throw lastErr;
}

function isRetryableDownloadError(err) {
  const msg = String(err?.message || '');
  const code = String(err?.code || '');
  return /abort|timeout|ECONN|ETIMEDOUT|socket|stream|network|certificate|altnames/i.test(msg + ' ' + code);
}

module.exports = { editImage, downloadUrl, analyzeColorImage, checkHealth, queryGenerationResult };
module.exports.__test = { isGlobalGenerationError, isModelUnavailableError };
