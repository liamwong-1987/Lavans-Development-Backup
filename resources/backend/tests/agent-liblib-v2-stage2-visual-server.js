'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const fixture = require('./agent-liblib-v2-golden.fixture');
const skillAdapter = require('../agent-skills/create-product-microstory-seedance.adapter.json');
const frontendRoot = path.resolve(__dirname, '../../frontend');
const port = Number(process.env.AGENT_STAGE2_FIXTURE_PORT || 3128);
const requestReceipts = new Map();
const counters = { generationRequests: 0, providerCalls: 0, addedCost: 0, canvasWrites: 0, messageWrites: 0 };

const session = {
  ...fixture.chatReplay.session,
  status: 'running',
  messages: fixture.chatReplay.messages.map(item => ({ ...item })),
  toolRuns: fixture.chatReplay.toolRuns.map(item => ({ ...item })),
  currentNodeRefs: [],
  revision: 1,
  createdAt: 1,
  updatedAt: fixture.chatReplay.messages.at(-1)?.createdAt || 1
};

if (process.env.AGENT_STAGE2_STRUCTURED_QUESTION === '1') {
  session.title = '啤酒广告 · 快速确认';
  session.status = 'running';
  session.messages = [{
    id: 'fixture-user-structured-question',
    eventId: 'fixture-user-structured-question',
    requestId: 'fixture-user-structured-question',
    role: 'user',
    kind: 'text',
    content: '帮我做一条 15 秒啤酒广告，先按 Skill 把关键信息问清楚。',
    attachments: [],
    createdAt: 1
  }, {
    id: 'fixture-assistant-structured-question',
    eventId: 'fixture-assistant-structured-question',
    requestId: 'fixture-assistant-structured-question',
    role: 'assistant',
    kind: 'question',
    content: '啤酒广告 · 快速确认',
    attachments: [],
    structuredQuestion: {
      schemaVersion: 1,
      id: 'agent-question-stage2-fixture',
      title: '啤酒广告 · 快速确认',
      submitLabel: '继续',
      questions: [{
        id: 'product-name',
        title: '产品信息',
        prompt: '啤酒品牌或产品名称是什么？',
        type: 'text',
        required: true,
        allowCustom: false,
        placeholder: '请输入品牌或产品名称',
        choices: []
      }, {
        id: 'creative-direction',
        title: '视频方向',
        prompt: '更想要哪一种广告方向？',
        type: 'single',
        required: true,
        allowCustom: true,
        placeholder: '',
        choices: [{ value: 'story', label: '剧情带货', description: '用人物冲突带出卖点' }, { value: 'brand', label: '品牌氛围片', description: '' }]
      }]
    },
    createdAt: 2
  }];
  session.toolRuns = [];
  session.currentNodeRefs = [];
  session.revision = 2;
  session.updatedAt = 2;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function mimeType(filePath) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' })[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function staticPath(pathname) {
  if (pathname === '/static/vendor/css/fonts.css') return path.join(frontendRoot, 'smart-canvas-core', 'vendor', 'css', 'fonts.css');
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(frontendRoot, relative || 'smart-canvas-core/smart-canvas.html');
  return resolved === frontendRoot || resolved.startsWith(frontendRoot + path.sep) ? resolved : '';
}

async function handleApi(req, res, url) {
  if (url.pathname === '/__fixture/status') return sendJson(res, 200, { success: true, counters, session });
  if (/^\/api\/canvas-(?:image-tasks|video|llm)|^\/api\/canvas\/tasks/.test(url.pathname)) {
    counters.generationRequests += 1;
    counters.providerCalls += 1;
    return sendJson(res, 503, { success: false, error: 'Stage 2 fixture blocks every generation endpoint' });
  }
  if (url.pathname === '/api/canvas/workspace' && req.method === 'GET') {
    return sendJson(res, 200, { success: true, workspace: { id: fixture.chatReplay.session.canvasId, title: 'AGENT Stage 2 无付费回放', kind: 'smart', project: 'fixture', nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [], settings: {}, agentRuns: [], activeAgentRunId: '' } });
  }
  if (url.pathname === '/api/canvas/workspace' && req.method === 'PUT') {
    counters.canvasWrites += 1;
    return sendJson(res, 200, { success: true, workspace: { updated_at: Date.now() } });
  }
  if (url.pathname === '/api/canvas/agent-sessions' && req.method === 'GET') return sendJson(res, 200, { success: true, sessions: [session] });
  if (url.pathname === '/api/canvas/agent-sessions' && req.method === 'POST') return sendJson(res, 201, { success: true, session, idempotent: true });
  if (url.pathname === `/api/canvas/agent-sessions/${session.id}` && req.method === 'GET') return sendJson(res, 200, { success: true, session });
  if (url.pathname === `/api/canvas/agent-sessions/${session.id}/messages` && req.method === 'POST') {
    const body = await readBody(req);
    const receipt = requestReceipts.get(body.requestId);
    const payload = JSON.stringify({ role: body.role, kind: body.kind, content: body.content, attachments: body.attachments || [] });
    if (receipt && receipt !== payload) return sendJson(res, 409, { success: false, code: 'IDEMPOTENCY_CONFLICT', error: 'requestId 已用于不同载荷' });
    if (!receipt) {
      requestReceipts.set(body.requestId, payload);
      const id = `fixture-message-${session.messages.length + 1}`;
      session.messages.push({ id, eventId:id, requestId:body.requestId, role: body.role, kind: body.kind, content: body.content || '', attachments: body.attachments || [], createdAt: Date.now() });
      session.revision += 1;
      session.updatedAt = Date.now();
      counters.messageWrites += 1;
    }
    return sendJson(res, 200, { success: true, session, idempotent: Boolean(receipt) });
  }
  if (url.pathname === `/api/canvas/agent-sessions/${session.id}/respond` && req.method === 'POST') {
    const body = await readBody(req);
    const key = `respond:${body.requestId}`;
    const receipt = requestReceipts.get(key);
    const payload = JSON.stringify({ triggerMessageEventId:body.triggerMessageEventId, providerId:body.providerId, model:body.model, selectedSkillId:body.selectedSkillId || '' });
    if (receipt && receipt !== payload) return sendJson(res, 409, { success:false, code:'IDEMPOTENCY_CONFLICT', error:'requestId 已用于不同回复绑定' });
    let message = session.messages.find(item => item.requestId === key);
    if (!receipt) {
      requestReceipts.set(key, payload);
      const id = `fixture-assistant-${session.messages.length + 1}`;
      message = { id, eventId:id, requestId:key, role:'assistant', kind:'text', content:'这是本地假 Provider 的 AgentSession 回复，用于验证持续聊天，不会调用真实 API。', attachments:[], createdAt:Date.now() };
      session.messages.push(message);
      session.revision += 1;
      session.updatedAt = Date.now();
    }
    return sendJson(res, 200, { success:true, session, message, providerId:body.providerId, model:body.model, idempotent:Boolean(receipt), usage:null });
  }
  if (url.pathname === `/api/canvas/agent-sessions/${session.id}/status` && req.method === 'PATCH') {
    const body = await readBody(req);
    if (body.constraints && typeof body.constraints === 'object') session.constraints = body.constraints;
    if (body.status) session.status = body.status;
    session.revision += 1;
    session.updatedAt = Date.now();
    return sendJson(res, 200, { success:true, session });
  }
  if (url.pathname === '/api/canvas/providers' && req.method === 'GET') return sendJson(res, 200, {
    success:true,
    primaryProviderId:'fixture-provider',
    providers:[{
      id:'fixture-provider',name:'本地假 Provider',enabled:true,protocol:'openai',
      chat_models:['fixture-chat'],image_models:['fixture-image-1k-4k'],video_models:['fixture-video-480-720'],
      video_model_resolutions:{'fixture-video-480-720':['480p','720p']}
    }]
  });
  if (url.pathname === '/api/canvas/agent-skills') return sendJson(res, 200, { success: true, skills: [skillAdapter], errors: [] });
  if (url.pathname === '/api/canvas-agent/foundation/status') return sendJson(res, 200, { success: true, artifacts: [], activeSessionId: session.id });
  if (url.pathname === '/api/canvas/config') return sendJson(res, 200, { success: true, config: {} });
  if (url.pathname === '/api/canvas/prompt-libraries') return sendJson(res, 200, { success: true, library: { libraries: [] } });
  if (url.pathname === '/api/smart-canvas/prompt-templates') return sendJson(res, 200, { success: true, templates: [] });
  if (url.pathname.startsWith('/api/')) return sendJson(res, 200, { success: true, items: [], assets: [], libraries: [] });
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
  try {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__fixture/')) {
      const handled = await handleApi(req, res, url);
      if (handled !== false) return;
    }
    const filePath = staticPath(url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const body = fs.readFileSync(filePath);
    res.writeHead(200, { 'content-type': mimeType(filePath), 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  } catch (error) {
    sendJson(res, 500, { success: false, error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`AGENT_STAGE2_FIXTURE http://127.0.0.1:${port}/smart-canvas-core/smart-canvas.html?id=${fixture.chatReplay.session.canvasId}\n`);
});

function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
