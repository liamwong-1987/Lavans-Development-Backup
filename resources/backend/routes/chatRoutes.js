/**
 * chatRoutes.js — GPT 对话功能（对齐大神画布 gpt-chat.html 的 API 契约）
 *
 * 接口清单（与源端 FastAPI main.py 契约一致，前端 gpt-chat.html 原样调用）：
 *   GET    /api/conversations            — 对话列表（X-User-ID 隔离）
 *   POST   /api/conversations            — 新建对话
 *   GET    /api/conversations/:id        — 读对话（含完整 messages）
 *   DELETE /api/conversations/:id        — 删除对话
 *   POST   /api/chat                     — 非流式对话（chat/agent/image 文本降级）
 *   POST   /api/chat/agent               — agent 模式（当前降级为文本对话）
 *   POST   /api/chat/stream              — 流式对话（SSE：meta/delta/done/error）
 *   POST   /api/ai/upload                — 参考图上传（multipart，字段 files）
 *
 * Provider 复用画布 API 设置（moduleConfigService 'canvas'），chat_models 为对话模型。
 * 仅支持 OpenAI 兼容 / APIMart 协议；CLI（codex/gemini-cli）与 runninghub/jimeng 文本对话已阻断。
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getModuleConfig } = require('../moduleConfigService');
const { resolveProxyUrl } = require('../systemProxy');

const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 40;      // 每次请求携带的历史消息上限
const MAX_CONVERSATIONS = 50;         // 每个用户保留的会话上限
const STREAM_TIMEOUT_MS = 180 * 1000; // 流式单次请求总时长上限

module.exports = function chatRoutes() {
  const router = express.Router();
  const backendRoot = path.resolve(__dirname, '..');
  const chatUploadRoot = path.join(backendRoot, 'uploads', 'chat');
  const outputRoot = path.join(backendRoot, 'output', 'canvas');
  const conversationsPath = path.join(outputRoot, 'chat-conversations.json');
  [chatUploadRoot, outputRoot].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

  router.use('/chat-uploads', express.static(chatUploadRoot));

  const chatUpload = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_ATTACHMENTS, fileSize: MAX_FILE_BYTES },
    fileFilter: (_req, file, done) => {
      const accepted = /^(image\/(jpeg|png|webp|bmp|gif))$/i.test(file.mimetype || '');
      done(accepted ? null : new Error('仅支持图片附件（jpg/png/webp/bmp/gif）'), accepted);
    }
  });

  // ==================== 工具函数（与 canvasRoutes 同源实现） ====================
  function shouldUseProxy(url) {
    try {
      const host = new URL(String(url)).hostname.toLowerCase();
      if (!host || host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('192.168.') || host.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
      const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '');
      if (noProxy && (noProxy === '*' || noProxy.split(/[,\s]+/).some(token => token && (token === host || (token.startsWith('.') && host.endsWith(token)))))) return false;
    } catch (_e) {}
    return true;
  }
  function abortError() { const error = new Error('The operation was aborted'); error.name = 'AbortError'; return error; }
  async function bodyToBuffer(body) {
    if (body == null) return null;
    if (typeof body === 'string') return { buffer: Buffer.from(body) };
    if (Buffer.isBuffer(body)) return { buffer: body };
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const boundary = '----lavans' + crypto.randomBytes(12).toString('hex');
      const chunks = [];
      for (const [name, value] of body.entries()) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (typeof value === 'string') {
          chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        } else {
          const filename = String(value?.name || 'blob');
          const type = String(value?.type || 'application/octet-stream');
          chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
          chunks.push(Buffer.from(await value.arrayBuffer()));
          chunks.push(Buffer.from('\r\n'));
        }
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return { buffer: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
    }
    return { buffer: Buffer.from(String(body)) };
  }
  // 流式请求：返回 { ok, status, headers, body: IncomingMessage }，body 为可读流
  function proxiedFetchStream(url, options = {}) {
    const proxyUrl = shouldUseProxy(url) ? resolveProxyUrl() : '';
    return new Promise((resolve, reject) => {
      (async () => {
        let parsed;
        try { parsed = new URL(String(url)); } catch (error) { reject(error); return; }
        const isHttps = parsed.protocol === 'https:';
        const method = String(options.method || 'GET').toUpperCase();
        const headers = { ...(options.headers || {}) };
        const prepared = await bodyToBuffer(options.body);
        if (prepared?.buffer && !headers['Content-Length']) headers['Content-Length'] = String(prepared.buffer.length);
        if (prepared?.contentType && !headers['Content-Type']) headers['Content-Type'] = prepared.contentType;
        const reqOptions = { method, host: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80), path: parsed.pathname + parsed.search, headers };
        if (isHttps && proxyUrl) reqOptions.agent = new HttpsProxyAgent(proxyUrl);
        const mod = isHttps ? https : http;
        const req = mod.request(reqOptions, res => {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, statusText: res.statusMessage || '', headers: res.headers, body: res });
        });
        if (options.signal) options.signal.addEventListener('abort', () => req.destroy(abortError()), { once: true });
        req.on('error', error => reject(error));
        if (prepared?.buffer) req.write(prepared.buffer);
        req.end();
      })().catch(reject);
    });
  }
  async function readStreamText(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  // ==================== Provider 解析 ====================
  function providerForRequest(providerId = '') {
    const config = getModuleConfig('canvas');
    const requested = String(providerId || config.primaryProviderId || '').trim().toLowerCase();
    return config.providers.find(provider => provider.id === requested)
      || config.providers.find(provider => provider.id === config.primaryProviderId)
      || config.providers[0]
      || null;
  }
  function providerEndpointUrl(provider, key, fallbackPath) {
    const configured = String(provider?.[key] || '').trim();
    if (configured) return /^https?:\/\//i.test(configured) ? configured : `${String(provider?.base_url || '').replace(/\/$/, '')}/${configured.replace(/^\/+/, '')}`;
    let base = String(provider?.base_url || '').replace(/\/$/, '');
    if (['openai', 'apimart'].includes(provider?.protocol) && !/\/v1(\/|$)/i.test(base)) base += '/v1';
    return `${base}${fallbackPath}`;
  }
  function chatCompletionUrl(provider) { return providerEndpointUrl(provider, 'chat_endpoint', '/chat/completions'); }
  function providerModelHeaders(provider) {
    if (provider?.protocol === 'volcengine') return { Authorization: `Bearer ${provider.volcengine_key || provider.api_key || ''}`, Accept: 'application/json' };
    return { Authorization: `Bearer ${provider?.api_key || ''}`, Accept: 'application/json' };
  }
  function providerErrorMessage(response, raw) {
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (_e) {}
    return data?.error?.message || data?.message || String(raw || '').slice(0, 500) || `Provider 返回 HTTP ${response.status || 0}`;
  }
  function extractChatText(data) {
    const unwrapped = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) && !data.choices ? data.data : data;
    const content = unwrapped?.choices?.[0]?.message?.content ?? unwrapped?.choices?.[0]?.text ?? '';
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.map(item => item?.text || item?.content || '').filter(Boolean).join('\n').trim();
    return String(content || '').trim();
  }
  // 从 SSE 事件文本里提取增量 delta（OpenAI 兼容 + apimart data.data 包装）
  function extractSseDelta(eventText) {
    const lines = String(eventText || '').split('\n');
    let delta = '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        const unwrapped = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) && !data.choices ? data.data : data;
        const content = unwrapped?.choices?.[0]?.delta?.content ?? unwrapped?.choices?.[0]?.text ?? '';
        if (typeof content === 'string') delta += content;
      } catch (_e) {}
    }
    return delta;
  }

  // ==================== 对话存储（JSON 文件，按用户隔离） ====================
  function readAllConversations() {
    try {
      if (fs.existsSync(conversationsPath)) {
        const data = JSON.parse(fs.readFileSync(conversationsPath, 'utf8'));
        return data && typeof data === 'object' ? data : {};
      }
    } catch (_e) {}
    return {};
  }
  function writeAllConversations(all) {
    fs.writeFileSync(conversationsPath, JSON.stringify(all, null, 2), 'utf8');
  }
  function userIdOf(req) { return String(req.get('X-User-ID') || req.body?.user_id || 'default').trim() || 'default'; }
  function userConversations(userId) {
    const all = readAllConversations();
    const list = Array.isArray(all[userId]) ? all[userId] : [];
    return list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }
  function saveConversation(userId, conversation) {
    const all = readAllConversations();
    let list = Array.isArray(all[userId]) ? all[userId] : [];
    const idx = list.findIndex(item => item.id === conversation.id);
    if (idx >= 0) list[idx] = conversation;
    else list.unshift(conversation);
    if (list.length > MAX_CONVERSATIONS) list = list.slice(0, MAX_CONVERSATIONS);
    all[userId] = list;
    writeAllConversations(all);
  }
  function deleteConversation(userId, id) {
    const all = readAllConversations();
    const list = Array.isArray(all[userId]) ? all[userId].filter(item => item.id !== id) : [];
    all[userId] = list;
    writeAllConversations(all);
  }
  function findConversation(userId, id) {
    return userConversations(userId).find(item => item.id === id) || null;
  }
  function newId() { return `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }
  function autoTitle(message) {
    const clean = String(message || '').replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 24) : '新对话';
  }
  function publicConversationSummary(conversation) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const last = [...messages].reverse().find(item => item && item.content);
    return {
      id: conversation.id,
      title: conversation.title || '新对话',
      last_message: last ? String(last.content).slice(0, 60) : '',
      created_at: conversation.created_at || '',
      updated_at: conversation.updated_at || ''
    };
  }

  // 参考图 ref → provider 可读的 base64 data URL（本地路径转 base64）
  function refToDataUrl(url) {
    if (!url) return '';
    if (/^data:image\//i.test(url)) return url;
    if (/^https?:\/\//i.test(url)) return url;
    // 本地路径映射
    let abs = '';
    const rel = decodeURIComponent(String(url).replace(/^\//, ''));
    if (String(url).startsWith('/chat-uploads/')) abs = path.join(chatUploadRoot, path.basename(rel));
    else if (String(url).startsWith('/canvas-assets/')) abs = path.join(backendRoot, 'uploads', 'canvas', rel.replace(/^canvas-assets\//, ''));
    else if (String(url).startsWith('/canvas-output/')) abs = path.join(outputRoot, rel.replace(/^canvas-output\//, ''));
    else if (String(url).startsWith('/uploads/')) abs = path.join(backendRoot, rel);
    if (!abs || !fs.existsSync(abs)) return '';
    const ext = path.extname(abs).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[ext] || 'image/png';
    return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  }

  // ==================== 对话校验与消息构建 ====================
  function validateChatProvider(providerId) {
    const provider = providerForRequest(providerId);
    if (!provider || provider.enabled === false) throw new Error('当前 Provider 不存在或已禁用');
    if (['codex', 'gemini-cli', 'jimeng', 'runninghub'].includes(provider.protocol)) throw new Error(`Provider ${provider.name || provider.id} 的文本对话尚未接入，已阻断`);
    if (!provider.api_key) throw new Error(`当前 Provider ${provider.name || provider.id} 尚未配置 API Key`);
    if (!provider.base_url) throw new Error(`当前 Provider ${provider.name || provider.id} 尚未配置 Base URL`);
    return provider;
  }
  function buildChatMessages({ provider, model, message, systemPrompt, historyMessages, referenceImages }) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const item of (historyMessages || []).slice(-MAX_HISTORY_MESSAGES)) {
      if ((item?.role === 'user' || item?.role === 'assistant') && item?.content) messages.push({ role: item.role, content: item.content });
    }
    const imageUrls = (referenceImages || []).map(ref => refToDataUrl(ref?.url)).filter(Boolean).slice(0, 8);
    if (imageUrls.length) {
      const content = [{ type: 'text', text: message || '请描述这些图片' }];
      for (const url of imageUrls) content.push({ type: 'image_url', image_url: { url } });
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: message });
    }
    return { messages, model };
  }

  // ==================== 接口 ====================
  router.get('/api/conversations', (req, res) => {
    try {
      const conversations = userConversations(userIdOf(req));
      res.json({ conversations: conversations.map(publicConversationSummary) });
    } catch (error) {
      res.status(500).json({ detail: error.message || '读取对话失败' });
    }
  });

  router.post('/api/conversations', (req, res) => {
    try {
      const userId = userIdOf(req);
      const now = new Date().toISOString();
      const conversation = {
        id: newId(),
        title: String(req.body?.title || '新对话').slice(0, 60) || '新对话',
        messages: [],
        created_at: now,
        updated_at: now
      };
      saveConversation(userId, conversation);
      res.json({ conversation });
    } catch (error) {
      res.status(500).json({ detail: error.message || '新建对话失败' });
    }
  });

  router.get('/api/conversations/:id', (req, res) => {
    try {
      const conversation = findConversation(userIdOf(req), String(req.params.id || ''));
      if (!conversation) return res.status(404).json({ detail: '对话不存在' });
      res.json({ conversation });
    } catch (error) {
      res.status(500).json({ detail: error.message || '读取对话失败' });
    }
  });

  router.delete('/api/conversations/:id', (req, res) => {
    try {
      deleteConversation(userIdOf(req), String(req.params.id || ''));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ detail: error.message || '删除对话失败' });
    }
  });

  // 上传参考图（对齐源端 /api/ai/upload 契约，返回 { files: [{name,url,kind,mime}] }）
  router.post('/api/ai/upload', (req, res) => {
    chatUpload.array('files', MAX_ATTACHMENTS)(req, res, error => {
      if (error) return res.status(400).json({ detail: error.message || '上传失败' });
      const files = (req.files || []).map(file => {
        const ext = path.extname(file.originalname || '').toLowerCase() || ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' })[file.mimetype] || '.png';
        const name = `chat_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(chatUploadRoot, name), file.buffer);
        return { name: file.originalname || name, url: `/chat-uploads/${encodeURIComponent(name)}`, kind: 'image', mime: file.mimetype || 'image/png' };
      });
      res.json({ files });
    });
  });

  // 非流式对话（chat / image / agent 统一走文本；image/agent 当前降级为文本，UI 与接口保留）
  async function handleChat(req, res, mode) {
    try {
      const provider = validateChatProvider(String(req.body?.provider || '').trim());
      const model = String(req.body?.model || provider.chat_models?.[0] || '').trim();
      const message = String(req.body?.message || '').trim();
      const systemPrompt = String(req.body?.system_prompt || '').trim();
      const referenceImages = Array.isArray(req.body?.reference_images) ? req.body.reference_images : [];
      if (!message) return res.status(400).json({ detail: '请输入消息内容' });

      const userId = userIdOf(req);
      const conversationId = String(req.body?.conversation_id || '').trim();
      let conversation = conversationId ? findConversation(userId, conversationId) : null;
      if (!conversation) conversation = { id: '', title: '', messages: [] };
      const historyMessages = conversation.messages || [];

      const { messages, model: resolvedModel } = buildChatMessages({ provider, model, message, systemPrompt, historyMessages, referenceImages });
      const body = { model: resolvedModel, messages };
      if (provider.protocol === 'apimart') body.stream = false;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      let upstream;
      try {
        upstream = await proxiedFetchStream(chatCompletionUrl(provider), {
          method: 'POST',
          headers: { ...providerModelHeaders(provider), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const raw = await readStreamText(upstream.body);
        if (!upstream.ok) return res.status(502).json({ detail: providerErrorMessage(upstream, raw) });
        let data = {}; try { data = JSON.parse(raw || '{}'); } catch (_e) {}
        const text = extractChatText(data);
        if (!text) return res.status(502).json({ detail: 'Provider 未返回可识别的文本内容' });

        const now = new Date().toISOString();
        const updated = {
          id: conversation.id || newId(),
          title: conversation.title || autoTitle(message),
          messages: [...historyMessages, { role: 'user', content: message, attachments: referenceImages }, { role: 'assistant', content: text, model: resolvedModel }],
          created_at: conversation.created_at || now,
          updated_at: now
        };
        saveConversation(userId, updated);
        res.json({ conversation: updated });
      } finally { clearTimeout(timer); }
    } catch (error) {
      res.status(error.status || 500).json({ detail: error.message || '对话失败' });
    }
  }

  router.post('/api/chat', (req, res) => handleChat(req, res, 'chat'));
  router.post('/api/chat/agent', (req, res) => handleChat(req, res, 'agent'));

  // 流式对话（SSE：meta → delta* → done | error）
  router.post('/api/chat/stream', async (req, res) => {
    const userId = userIdOf(req);
    let provider;
    try {
      provider = validateChatProvider(String(req.body?.provider || '').trim());
    } catch (error) {
      return res.status(error.status || 400).json({ detail: error.message || '对话失败' });
    }
    const model = String(req.body?.model || provider.chat_models?.[0] || '').trim();
    const message = String(req.body?.message || '').trim();
    const systemPrompt = String(req.body?.system_prompt || '').trim();
    const referenceImages = Array.isArray(req.body?.reference_images) ? req.body.reference_images : [];
    if (!message) return res.status(400).json({ detail: '请输入消息内容' });

    const conversationId = String(req.body?.conversation_id || '').trim();
    let conversation = conversationId ? findConversation(userId, conversationId) : null;
    if (!conversation) conversation = { id: '', title: '', messages: [] };
    const historyMessages = conversation.messages || [];

    const { messages, model: resolvedModel } = buildChatMessages({ provider, model, message, systemPrompt, historyMessages, referenceImages });

    const sendSSE = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_e) {} };

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let upstreamBody = null;
    const cleanup = () => { try { upstreamBody?.destroy(); } catch (_e) {} };
    const done = () => { try { res.end(); } catch (_e) {} };
    req.on('close', cleanup);

    const streamTimer = setTimeout(() => { sendSSE({ type: 'error', detail: '对话超时（180 秒）' }); done(); }, STREAM_TIMEOUT_MS);

    try {
      const body = { model: resolvedModel, messages, stream: true };
      const upstream = await proxiedFetchStream(chatCompletionUrl(provider), {
        method: 'POST',
        headers: { ...providerModelHeaders(provider), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      upstreamBody = upstream.body;
      if (!upstream.ok) {
        const raw = await readStreamText(upstreamBody);
        sendSSE({ type: 'error', detail: providerErrorMessage(upstream, raw) });
        return done();
      }

      let fullText = '';
      let buffer = '';
      upstreamBody.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const eventText of events) {
          const delta = extractSseDelta(eventText);
          if (delta) { fullText += delta; sendSSE({ type: 'delta', delta }); }
        }
      });
      upstreamBody.on('end', () => {
        const tail = extractSseDelta(buffer);
        if (tail) { fullText += tail; sendSSE({ type: 'delta', delta: tail }); }
        const now = new Date().toISOString();
        const updated = {
          id: conversation.id || newId(),
          title: conversation.title || autoTitle(message),
          messages: [...historyMessages, { role: 'user', content: message, attachments: referenceImages }, { role: 'assistant', content: fullText, model: resolvedModel }],
          created_at: conversation.created_at || now,
          updated_at: now
        };
        saveConversation(userId, updated);
        clearTimeout(streamTimer);
        sendSSE({ type: 'done', conversation: updated });
        done();
      });
      upstreamBody.on('error', error => {
        clearTimeout(streamTimer);
        sendSSE({ type: 'error', detail: error.message || '流式请求中断' });
        done();
      });
    } catch (error) {
      clearTimeout(streamTimer);
      sendSSE({ type: 'error', detail: error.message || '对话失败' });
      done();
    }
  });

  return router;
};
