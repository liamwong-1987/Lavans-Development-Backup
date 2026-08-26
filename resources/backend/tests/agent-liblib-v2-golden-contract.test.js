'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const fixture = require('./agent-liblib-v2-golden.fixture');
const repoRoot = path.resolve(__dirname, '../../..');
const frontendPath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js');
const projectionPath = path.join(repoRoot, 'resources/backend/services/canvasAgentFoundation/canvasProjection.js');
const sessionServicePath = path.join(repoRoot, 'resources/backend/services/agentSessionService.js');
const evidenceManifest = require('./fixtures/agent-liblib-v2-golden-evidence.json');
const frontendSource = fs.readFileSync(frontendPath, 'utf8');
const projectionSource = fs.readFileSync(projectionPath, 'utf8');

function loadAgentSessionFactory() {
  assert.ok(fs.existsSync(sessionServicePath), '尚未建立 AgentSession 服务');
  return require(sessionServicePath).createAgentSessionService;
}

function createTestSessionService(rootPath, seed = 0) {
  const createAgentSessionService = loadAgentSessionFactory();
  let tick = 1_000 + seed;
  let sequence = seed;
  return createAgentSessionService({
    rootPath,
    clock: () => ++tick,
    makeId: prefix => `${prefix}-${++sequence}`
  });
}

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('黄金回放哈希清单和 8 节点时间轴内部一致', () => {
  assert.equal(fixture.source.sha256.length, 64);
  assert.equal(fixture.keyframes.length, 25);
  assert.equal(evidenceManifest.sourceSha256, fixture.source.sha256);
  assert.deepEqual(evidenceManifest.keyframes.map(item => item.name), fixture.keyframes);
  assert.equal(evidenceManifest.keyframes.every(item => Number(item.bytes) > 0 && /^[A-F0-9]{64}$/.test(item.sha256)), true);
  assert.equal(fixture.taskNodes.length, 8);
  assert.equal(new Set(fixture.taskNodes.map(node => node.id)).size, 8);
  assert.equal(fixture.documentMessages.every(message => message.canvasNode === false), true);
  assert.equal(fixture.checkpoints.at(-1).taskNodeCount, 8);
  assert.equal(fixture.checkpoints.every(checkpoint => checkpoint.composerAvailable === true), true);
  for (const lifecycle of fixture.mediaLifecycles) {
    assert.ok(fixture.taskNodes.some(node => node.id === lifecycle.nodeId), `生命周期必须复用同一节点：${lifecycle.nodeId}`);
    assert.ok(lifecycle.completedAt > lifecycle.runningAt, `完成时间必须晚于开始时间：${lifecycle.nodeId}`);
  }
});

test('黄金回放严格无网络、无真实素材、无 Provider 调用和费用', () => {
  assert.deepEqual(fixture.safety, {
    networkAllowed: false,
    realMaterialAllowed: false,
    generationRequestCount: 0,
    providerCallCount: 0,
    addedCost: 0
  });
});

test('红灯：问卷完成、运行、暂停、失败和完成后主输入仍可用', () => {
  assert.equal(/smartAgentQuestionInput\.hidden\s*=\s*smartAgentQuestionnaireComplete/.test(frontendSource), false,
    '当前实现仍在问卷完成后隐藏主输入');
  assert.equal(/smartAgentQuestionInput\.disabled\s*=\s*smartAgentQuestionnaireComplete/.test(frontendSource), false,
    '当前实现仍在问卷完成后禁用主输入');
});

test('Stage 1：一个 AgentSession 包含唯一产品状态字段', () => {
  assert.ok(fs.existsSync(sessionServicePath), '尚未建立 AgentSession 服务');
  const sessionSource = fs.readFileSync(sessionServicePath, 'utf8');
  for (const field of ['messages', 'toolRuns', 'currentNodeRefs']) assert.equal(new RegExp(field).test(sessionSource), true, `AgentSession 缺少 ${field}`);
});

test('Stage 1：创建、消息和幂等回执跨服务重启仍一致', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-session-idempotency-'));
  const service = createTestSessionService(rootPath);
  assert.equal(fs.existsSync(path.join(rootPath, 'sessions.json')), false, '服务构造本身不得创建状态文件');
  const createInput = { requestId: 'request-create-1', canvasId: 'canvas-a', skillId: 'story-tvc', title: '剧情 TVC' };
  const created = service.createSession(createInput);
  assert.equal(created.idempotent, false);
  assert.equal(created.session.canvasId, 'canvas-a');
  assert.equal('requestReceipts' in created.session, false, '公开会话不得暴露内部幂等回执');

  const createReplay = service.createSession(createInput);
  assert.equal(createReplay.idempotent, true);
  assert.equal(createReplay.session.id, created.session.id);
  assert.throws(
    () => service.createSession({ ...createInput, title: '不同载荷' }),
    error => error?.statusCode === 409 && error?.code === 'IDEMPOTENCY_CONFLICT'
  );

  const messageInput = { requestId: 'request-message-1', role: 'user', kind: 'text', content: '制作一条品牌剧情短片' };
  const appended = service.appendMessage(created.session.id, messageInput);
  assert.equal(appended.session.messages.length, 1);
  assert.equal(appended.session.messages[0].content, messageInput.content);
  assert.equal(service.appendMessage(created.session.id, messageInput).idempotent, true);
  assert.throws(
    () => service.appendMessage(created.session.id, { ...messageInput, content: '改变后的内容' }),
    error => error?.statusCode === 409 && error?.code === 'IDEMPOTENCY_CONFLICT'
  );

  const restarted = createTestSessionService(rootPath, 100);
  const loaded = restarted.loadSession(created.session.id);
  assert.equal(loaded.messages.length, 1);
  assert.equal(restarted.appendMessage(created.session.id, messageInput).idempotent, true);
});

test('Stage 1：工具任务与当前节点引用只改变会话工作集', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-session-nodes-'));
  const service = createTestSessionService(rootPath, 200);
  const created = service.createSession({ requestId: 'request-create-nodes', canvasId: 'canvas-nodes', skillId: 'story-tvc' });
  const sessionId = created.session.id;

  service.setStatus(sessionId, { requestId: 'request-status-running', status: 'running' });
  const running = service.upsertToolRun(sessionId, 'tool-image-1', {
    requestId: 'request-tool-running',
    type: 'image-generation',
    status: 'running',
    provider: 'fixture-provider',
    model: 'fixture-model',
    remoteTaskId: 'fixture-remote-1'
  });
  assert.equal(running.session.toolRuns[0].status, 'running');

  const attached = service.attachCurrentNode(sessionId, 'node-image-1', {
    requestId: 'request-node-attach',
    kind: 'image',
    role: 'storyboard-frame',
    toolRunId: 'tool-image-1',
    assetVersionId: 'asset-version-1'
  });
  assert.deepEqual(attached.session.currentNodeRefs.map(item => item.nodeId), ['node-image-1']);
  assert.equal(service.attachCurrentNode(sessionId, 'node-image-1', {
    requestId: 'request-node-attach',
    kind: 'image',
    role: 'storyboard-frame',
    toolRunId: 'tool-image-1',
    assetVersionId: 'asset-version-1'
  }).idempotent, true);
  assert.equal(service.listSessions('canvas-nodes').length, 1);
  assert.equal(service.listSessions('another-canvas').length, 0);

  const succeeded = service.upsertToolRun(sessionId, 'tool-image-1', {
    requestId: 'request-tool-succeeded',
    type: 'image-generation',
    status: 'succeeded',
    provider: 'fixture-provider',
    model: 'fixture-model',
    remoteTaskId: 'fixture-remote-1'
  });
  assert.equal(succeeded.session.toolRuns[0].status, 'succeeded');
  assert.throws(
    () => service.upsertToolRun(sessionId, 'tool-image-1', {
      requestId: 'request-tool-illegal-restart',
      type: 'image-generation',
      status: 'running'
    }),
    error => error?.statusCode === 409 && error?.code === 'INVALID_TOOL_RUN_TRANSITION'
  );

  const detached = service.detachCurrentNode(sessionId, 'node-image-1', { requestId: 'request-node-detach' });
  assert.equal(detached.session.currentNodeRefs.length, 0);
});

test('Stage 1：软件重启后未决远端任务转未知且不自动重发', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-session-recovery-'));
  const service = createTestSessionService(rootPath, 400);
  const created = service.createSession({ requestId: 'request-create-recovery', canvasId: 'canvas-recovery', skillId: 'story-tvc' });
  const sessionId = created.session.id;
  service.setStatus(sessionId, { requestId: 'request-status-recovery', status: 'running' });
  const before = service.upsertToolRun(sessionId, 'tool-remote-1', {
    requestId: 'request-tool-submitting',
    type: 'video-generation',
    status: 'submitting',
    provider: 'fixture-provider',
    model: 'fixture-model',
    remoteTaskId: 'remote-task-unknown'
  }).session;

  const sessionSource = fs.readFileSync(sessionServicePath, 'utf8');
  assert.doesNotMatch(sessionSource, /\bfetch\s*\(|require\(['"]node:https?['"]\)|providerExecutor|generate(?:Image|Video)/,
    'AgentSession 状态服务不得包含 Provider 或网络执行入口');
  const restarted = createTestSessionService(rootPath, 500);
  const recovered = restarted.loadSession(sessionId);
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.toolRuns[0].status, 'remote-unknown');
  assert.equal(recovered.toolRuns[0].recoveryReason, 'service-restart');
  assert.ok(recovered.revision > before.revision);

  const recoveredAgain = createTestSessionService(rootPath, 600).loadSession(sessionId);
  assert.equal(recoveredAgain.revision, recovered.revision, '重复重启不得重复修改恢复状态');
});

test('Stage 1：最小 AgentSession HTTP 接口遵守状态码与公开结构', async () => {
  const fixedSession = {
    id: 'agent-session-route-1',
    canvasId: 'canvas-route',
    skillId: 'story-tvc',
    status: 'idle',
    messages: [],
    toolRuns: [],
    currentNodeRefs: [],
    revision: 1
  };
  const calls = [];
  const fakeService = {
    createSession(input) { calls.push(['create', input]); return { session: fixedSession, idempotent: false }; },
    listSessions(canvasId) { calls.push(['list', canvasId]); return [fixedSession]; },
    loadSession(sessionId) { calls.push(['load', sessionId]); return fixedSession; },
    appendMessage(sessionId, input) { calls.push(['message', sessionId, input]); return { session: { ...fixedSession, messages: [{ id: 'message-1', content: input.content }] }, idempotent: false }; },
    setStatus(sessionId, input) { calls.push(['status', sessionId, input]); return { session: { ...fixedSession, status: input.status }, idempotent: false }; },
    upsertToolRun(sessionId, toolRunId, input) { calls.push(['tool', sessionId, toolRunId, input]); return { session: fixedSession, idempotent: false }; },
    attachCurrentNode(sessionId, nodeId, input) { calls.push(['attach', sessionId, nodeId, input]); return { session: fixedSession, idempotent: false }; },
    detachCurrentNode(sessionId, nodeId, input) { calls.push(['detach', sessionId, nodeId, input]); return { session: fixedSession, idempotent: false }; }
  };
  const createCanvasRoutes = require('../routes/canvasRoutes');
  const router = createCanvasRoutes({ agentSessionService: fakeService, agentRunService: {} });

  await withServer(router, async baseUrl => {
    const created = await fetch(`${baseUrl}/api/canvas/agent-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-create-1', canvasId: 'canvas-route', skillId: 'story-tvc' })
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).session, fixedSession);

    const listed = await fetch(`${baseUrl}/api/canvas/agent-sessions?canvasId=canvas-route`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).sessions.length, 1);

    const loaded = await fetch(`${baseUrl}/api/canvas/agent-sessions/${fixedSession.id}`);
    assert.equal(loaded.status, 200);
    assert.equal((await loaded.json()).session.id, fixedSession.id);

    const appended = await fetch(`${baseUrl}/api/canvas/agent-sessions/${fixedSession.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-message-1', role: 'user', kind: 'text', content: '继续制作' })
    });
    assert.equal(appended.status, 200);
    assert.equal((await appended.json()).session.messages[0].content, '继续制作');

    const statusUpdated = await fetch(`${baseUrl}/api/canvas/agent-sessions/${fixedSession.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-status-1', status: 'running' })
    });
    assert.equal(statusUpdated.status, 200);
    assert.equal((await statusUpdated.json()).session.status, 'running');

    const toolUpdated = await fetch(`${baseUrl}/api/canvas/agent-sessions/${fixedSession.id}/tool-runs/tool-route-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-tool-1', type: 'image-generation', status: 'queued' })
    });
    assert.equal(toolUpdated.status, 200);
    await toolUpdated.json();

    const attached = await fetch(`${baseUrl}/api/canvas/agent-sessions/${fixedSession.id}/current-nodes/node-route-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-node-1', kind: 'image' })
    });
    assert.equal(attached.status, 200);
    assert.equal(calls.some(call => call[0] === 'attach'), true);

    const detached = await fetch(`${baseUrl}/api/canvas/agent-sessions/${fixedSession.id}/current-nodes/node-route-1`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-node-delete-1' })
    });
    assert.equal(detached.status, 200);
    assert.equal(calls.some(call => call[0] === 'detach'), true);
  });
});

test('红灯：主画布只读取 AgentSession 当前工作集', () => {
  assert.equal(/currentNodeRefs/.test(projectionSource), true, '当前投影尚未读取 AgentSession.currentNodeRefs');
  assert.equal(/artifactStore\.list\s*\(/.test(projectionSource), false, '当前投影仍把全部 Foundation 历史产物送上主画布');
});

test('红灯：AGENT 媒体不再使用统一审核节点外壳', () => {
  assert.equal(/type:\s*'agent-approval-artifact'/.test(projectionSource), false, '当前投影仍创建 agent-approval-artifact');
  assert.equal(/type:\s*'smart-agent-approval-artifact'/.test(frontendSource), false, '当前前端仍创建 smart-agent-approval-artifact');
});
