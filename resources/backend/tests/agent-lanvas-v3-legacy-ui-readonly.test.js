'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontendPath = path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.js');
const source = fs.readFileSync(frontendPath, 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `缺少起始标记：${startMarker}`);
  assert.notEqual(end, -1, `缺少结束标记：${endMarker}`);
  return source.slice(start, end);
}

function functionSource(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `缺少函数 ${name}`);
  const declarationStart = source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  const parametersStart = source.indexOf('(', start);
  let parameterDepth = 0;
  let bodyStart = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        bodyStart = source.indexOf('{', index + 1);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `缺少函数体 ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declarationStart, index + 1);
    }
  }
  assert.fail(`函数 ${name} 没有闭合`);
}

test('Legacy AgentRun 非读取请求在 fetch 前统一失败关闭', async () => {
  const bundle = sourceBetween('const SMART_AGENT_LEGACY_READ_ONLY_MESSAGE', 'function smartAgentSettingsStorageKey');
  const fetchCalls = [];
  const notices = [];
  const context = {
    toast: message => notices.push(message),
    fetch: async (...args) => {
      fetchCalls.push(args);
      return { ok: true, status: 200, text: async () => '{"success":true}' };
    }
  };
  vm.createContext(context);
  vm.runInContext(`${bundle}; this.request = smartAgentBackendRequest; this.notice = smartAgentLegacyReadOnlyNotice;`, context);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(
      context.request('/api/canvas/agent-runs/legacy-run/stages/microstory/execute?fixture=1', { method }),
      error => error?.code === 'LEGACY_AGENT_RUN_READ_ONLY' && /只读历史/.test(error.message)
    );
  }
  assert.equal(fetchCalls.length, 0, '旧写请求不得到达底层 fetch');

  const payload = await context.request('/api/canvas/agent-runs/legacy-run');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { success: true });
  assert.equal(fetchCalls.length, 1, '历史 GET 仍可读取');
  assert.equal(context.notice(), false);
  assert.match(notices[0], /新版持续聊天 AGENT/);
});

test('Foundation 投影同步是无请求、无节点变化的纯 no-op', async () => {
  const projectionSource = sourceBetween('async function syncSmartAgentFoundationProjection()', 'function smartAgentVisualImageSize');
  assert.match(projectionSource, /^async function syncSmartAgentFoundationProjection\(\)\{\s*return false;\s*\}\s*$/);
  assert.doesNotMatch(projectionSource, /smartAgentBackendRequest|fetch|nodes|connections|push|filter/);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${projectionSource}; this.syncProjection = syncSmartAgentFoundationProjection;`, context);
  assert.equal(await context.syncProjection(), false);
});

test('旧 Run 恢复只清理遗留计时器，不同步、不推进、不建新计时器', () => {
  const clearSource = functionSource('clearSmartAgentRunTimer');
  const resumeSource = functionSource('resumeSmartAgentRuns');
  assert.doesNotMatch(resumeSource, /syncSmartAgentBackendRuns|scheduleSmartAgentRun|setTimeout|setInterval|advanceSmartAgentRun/);
  assert.equal((source.match(/\bresumeSmartAgentRuns\(\)/g) || []).length, 1, '启动或协同合并仍调用旧恢复入口');

  const timeoutHandles = new Map([['run-old', { type: 'timeout' }]]);
  const revisionHandles = new Map([['run-old:revision-old', { type: 'interval' }]]);
  const clearedTimeouts = [];
  const clearedIntervals = [];
  const context = {
    smartAgentRunTimers: timeoutHandles,
    smartAgentRevisionPolls: revisionHandles,
    clearTimeout: handle => clearedTimeouts.push(handle),
    clearInterval: handle => clearedIntervals.push(handle)
  };
  vm.createContext(context);
  vm.runInContext(`${clearSource}\n${resumeSource}; this.resumeRuns = resumeSmartAgentRuns;`, context);
  assert.equal(context.resumeRuns(), false);
  assert.equal(timeoutHandles.size, 0);
  assert.equal(revisionHandles.size, 0);
  assert.equal(clearedTimeouts.length, 1);
  assert.equal(clearedIntervals.length, 1);
});

test('旧本地 Run 调度器不能再建立自动推进任务', () => {
  const scheduleSource = functionSource('scheduleSmartAgentRun');
  assert.doesNotMatch(scheduleSource, /setTimeout|advanceSmartAgentRun|smartAgentRunTimers\.set/);
  const cleared = [];
  const context = { clearSmartAgentRunTimer: runId => cleared.push(runId) };
  vm.createContext(context);
  vm.runInContext(`${scheduleSource}; this.scheduleRun = scheduleSmartAgentRun;`, context);
  assert.equal(context.scheduleRun('legacy-running', 1), false);
  assert.deepEqual(cleared, ['legacy-running']);
});

test('canvasForStorage 深度保留旧 Foundation 节点、连线和顺序', () => {
  const storageSource = functionSource('canvasForStorage');
  const legacyNode = { id: 'legacy-foundation', type: 'smart-agent-approval-artifact', agentFoundationProjection: true, contentPreview: '历史剧本', x: 12, y: 34 };
  const legacyEdge = { id: 'legacy-edge', from: 'normal-node', to: 'legacy-foundation', type: 'flow', agentFoundationProjection: true };
  const original = {
    id: 'canvas-readonly',
    nodes: [
      { id: 'normal-node', type: 'image', x: 1, y: 2 },
      legacyNode,
      { id: 'log-preview', type: 'text' }
    ],
    connections: [
      { id: 'normal-edge', from: 'normal-node', to: 'normal-node', type: 'flow' },
      legacyEdge
    ],
    settings: { theme: 'dark' }
  };
  const context = {
    canvas: original,
    canvasDefaultSmartSettings: { provider: 'fixture' },
    initialSmartSettings: {},
    SMART_LOG_PREVIEW_NODE_ID: 'log-preview',
    settingsForStorage: value => value,
    mediaItemForStorage: value => value
  };
  vm.createContext(context);
  vm.runInContext(`${storageSource}; this.forStorage = canvasForStorage;`, context);
  const stored = JSON.parse(JSON.stringify(context.forStorage()));
  assert.deepEqual(stored.nodes.map(node => node.id), ['normal-node', 'legacy-foundation']);
  assert.deepEqual(stored.nodes[1], legacyNode);
  assert.deepEqual(stored.connections, original.connections);
  assert.equal(original.nodes.length, 3, '序列化不得原地修改画布');
});

test('旧动作先提示只读，Foundation 写入和 AI 修订均不能先改本地状态', () => {
  const roots = [
    'installSmartAgentStoryDatabase',
    'saveSmartAgentSettings',
    'runSmartAgentFoundationReviewAction',
    'openSmartAgentShotVideoRecovery',
    'previewSmartAgentShotVideoPromptRevision',
    'confirmSmartAgentShotVideoRecovery',
    'startSmartAgentRun',
    'pauseSmartAgentRun',
    'continueSmartAgentRun',
    'cancelSmartAgentRun',
    'retrySmartAgentRun',
    'submitSmartAgentManualVersion',
    'executeSmartAgentAiRevision',
    'submitSmartAgentScriptVersion',
    'cancelSmartAgentRevisionAttempt'
  ];
  for (const name of roots) {
    const body = functionSource(name).slice(functionSource(name).indexOf('{') + 1);
    assert.match(body, /^\s*smartAgentLegacyReadOnlyNotice\(\);\s*return;/, `${name} 仍可能先写本地状态`);
  }
  assert.ok((source.match(/\/api\/canvas\/agent-runs/g) || []).length >= 54, 'Legacy 路径盘点意外缩小，需重新审计统一门');
});

test('AgentSession 聊天与附件不属于 Legacy 只读门', () => {
  const chatSource = functionSource('submitSmartAgentChatMessage');
  const uploadSource = functionSource('uploadSmartAgentMaterials');
  assert.doesNotMatch(chatSource, /smartAgentLegacyReadOnlyNotice|LEGACY_AGENT_RUN_READ_ONLY/);
  assert.doesNotMatch(uploadSource, /smartAgentLegacyReadOnlyNotice|LEGACY_AGENT_RUN_READ_ONLY/);
  assert.match(source, /\/api\/canvas\/agent-sessions\/\$\{encodeURIComponent\(smartAgentActiveSession\.id\)\}\/messages/);
});

test('上传成功的资料以规范附件字段进入 AgentSession 消息', async () => {
  const requests = [];
  const context = {
    smartAgentMaterials: [],
    smartAgentMaterialUploadBusy: false,
    smartAgentQuestionnaireComplete: true,
    smartAgentBrief: null,
    smartAgentMaterialInput: null,
    smartAgentSessionMessageBusy: false,
    smartAgentSessionError: '',
    smartAgentActiveSession: { id: 'session-fixture', canvasId: 'canvas-fixture', messages: [] },
    canvasId: 'canvas-fixture',
    TextDecoder,
    Uint8Array,
    FormData: class FormDataFixture { append() {} },
    window: {},
    toast() {},
    renderSmartAgentQuestionnaire() {},
    saveSmartAgentDraft() {},
    smartAgentBuildBrief() { return ''; },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        success: true,
        materials: [{ id: 'asset-product-1', url: '/canvas-assets/product.png', kind: 'image', name: 'product.png', type: 'image/png' }]
      })
    }),
    ensureSmartAgentSession: async () => context.smartAgentActiveSession,
    smartAgentReadSessionOutbox: () => null,
    smartAgentWriteSessionOutbox() {},
    uid: () => 'message-request-fixture',
    smartAgentSessionRequest: async (url, options) => {
      requests.push({ url, options });
      return { session: context.smartAgentActiveSession };
    },
    encodeURIComponent
  };
  vm.createContext(context);
  const functions = [
    'smartAgentReadableMaterialName',
    'smartAgentNormalizeMaterial',
    'uploadSmartAgentMaterials',
    'smartAgentPendingMaterials',
    'smartAgentSessionAttachments',
    'appendSmartAgentSessionMessage'
  ].map(functionSource).join('\n');
  vm.runInContext(`${functions}; this.upload = uploadSmartAgentMaterials; this.attachments = smartAgentSessionAttachments; this.appendMessage = appendSmartAgentSessionMessage;`, context);

  await context.upload([{ name: 'product.png', type: 'image/png' }]);
  const attachments = JSON.parse(JSON.stringify(context.attachments()));
  assert.deepEqual(attachments, [{ assetId: 'asset-product-1', kind: 'image', name: 'product.png', mimeType: 'image/png' }]);
  await context.appendMessage({ role: 'user', kind: 'text', content: '请使用这张产品图', attachments });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/canvas/agent-sessions/session-fixture/messages');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.attachments, attachments);
  assert.equal(body.requestId, 'message-request-fixture');
});
