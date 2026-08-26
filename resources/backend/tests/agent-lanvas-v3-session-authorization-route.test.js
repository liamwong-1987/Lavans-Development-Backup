'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const canvasRoutes = require('../routes/canvasRoutes');
const { createAgentSessionService } = require('../services/agentSessionService');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');
const { hashAgentNativeExecutionPayload } = require('../services/agentNativeTaskBinding');

const IMAGE_TASK_PAYLOAD = Object.freeze({
  type: 'generator',
  providerId: 'fixture-provider',
  model: 'fixture-image-model',
  prompt: '真实安全门贯通测试，不发网络',
  size: '1024x1024',
  assets: Object.freeze([])
});
const IMAGE_INPUT_HASH = hashAgentNativeExecutionPayload('image', IMAGE_TASK_PAYLOAD, []);

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function requestJson(baseUrl, pathname, method, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function fixture() {
  const outputRoot = path.join(os.tmpdir(), `lavans-agent-m2e-route-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const foundation = createCanvasAgentFoundation({ rootPath: path.join(outputRoot, 'agent-foundation') });
  const artifact = foundation.createArtifact({
    logicalArtifactId: 'm2e-locked-input',
    artifactType: 'storyboard',
    operationId: 'm2e-create-input',
    content: 'locked input',
    metadata: { canvasId: 'canvas-m2e-route' }
  });
  foundation.approvalGate.requestReview(artifact.artifactVersionId);
  foundation.approvalGate.approve(artifact.artifactVersionId);
  foundation.approvalGate.lock(artifact.artifactVersionId);
  const sessionService = createAgentSessionService({
    outputRoot,
    clock: (() => { let now = 50_000; return () => ++now; })(),
    makeId: () => 'agent-session-m2e-route'
  });
  const session = sessionService.createSession({
    requestId: 'request-create-m2e-route',
    canvasId: 'canvas-m2e-route',
    workspaceScope: 'canvas-agent',
    mode: 'generation'
  }).session;
  sessionService.upsertToolRun(session.id, 'tool-m2e-route', {
    requestId: 'request-tool-awaiting-m2e-route',
    type: 'native-image',
    status: 'awaiting-approval',
    nodeId: 'node-m2e-route',
    provider: 'fixture-provider',
    model: 'fixture-image-model',
    operationId: 'operation-m2e-route',
    inputVersion: artifact.artifactVersionId,
    inputHash: IMAGE_INPUT_HASH,
    quantity: 1,
    estimatedCost: 4,
    approvedBudget: 4,
    retryBudget: 0,
    attempt: 0
  });
  return { outputRoot, foundation, artifact, sessionService, session };
}

function routerFor(state, sessionService = state.sessionService, extra = {}) {
  return canvasRoutes({
    outputRoot: state.outputRoot,
    canvasAgentFoundation: state.foundation,
    agentSessionService: sessionService,
    agentRunService: {},
    canvasConfig: { primaryProviderId: '', providers: [] },
    ...extra
  });
}

function branchCanvasConfig() {
  return {
    primaryProviderId: 'fixture-provider',
    providers: [{
      id: 'fixture-provider',
      enabled: true,
      protocol: 'apimart',
      api_key: 'fixture-key',
      base_url: 'https://fixture.invalid',
      image_models: ['gpt-image-2'],
      video_models: ['seedance-2.0']
    }]
  };
}

function attachBranchRedoSource(state, options = {}) {
  const nodeId = options.nodeId || 'node-branch-source';
  const toolRunId = options.toolRunId || 'tool-branch-source';
  const status = options.status || 'succeeded';
  const current = state.sessionService.loadSession(state.session.id);
  state.sessionService.setStatus(state.session.id, {
    requestId: `request-branch-settings-${nodeId}`,
    status: current.status,
    constraints: {
      ...current.constraints,
      mediaDefaults: {
        autoGenerateMedia: options.automatic === true,
        imageProviderId: 'fixture-provider', imageModel: 'gpt-image-2', imageRatio: '9:16', imageResolution: '1K', imageQuantity: 1,
        videoProviderId: 'fixture-provider', videoModel: 'seedance-2.0', videoRatio: '9:16', videoResolution: '480p', videoDuration: 5, videoQuantity: 1
      }
    }
  });
  state.sessionService.upsertToolRun(state.session.id, toolRunId, {
    requestId: `request-branch-tool-${nodeId}`,
    type: 'native-image', status, nodeId,
    provider: 'fixture-provider', model: 'gpt-image-2',
    operationId: `operation-${nodeId}`,
    inputVersion: state.artifact.artifactVersionId,
    inputHash: 'b'.repeat(64), quantity: 1,
    estimatedCost: 0.0085, approvedBudget: 0.0085,
    retryBudget: 0, attempt: 1
  });
  state.sessionService.attachCurrentNode(state.session.id, nodeId, {
    requestId: `request-branch-attach-${nodeId}`,
    workspaceScope: 'canvas-agent', kind: 'image', nodeRole: 'image-output',
    toolRunId, branchRootRef: nodeId
  });
  const canvasesRoot = path.join(state.outputRoot, 'canvases');
  fs.mkdirSync(canvasesRoot, { recursive: true });
  fs.writeFileSync(path.join(canvasesRoot, `${state.session.canvasId}.json`), JSON.stringify({
    id: state.session.canvasId,
    kind: 'smart',
    nodes: [{
      id: nodeId,
      type: 'smart-image',
      taskState: { status: options.nodeStatus || (status === 'succeeded' ? 'completed' : 'waiting') },
      agentNative: {
        workspaceScope: 'canvas-agent',
        agentSessionId: state.session.id,
        toolRunId,
        kind: 'image'
      }
    }],
    edges: []
  }, null, 2));
  return { nodeId, toolRunId };
}

function prepareRound(state, options = {}) {
  const roundId = options.roundId || `round-${options.mode || 'manual'}`;
  const eventId = `event-${roundId}`;
  state.sessionService.appendMessage(state.session.id, {
    requestId: `request-message-${roundId}`,
    eventId,
    role: 'user',
    kind: 'text',
    content: '生成图片后再生成视频'
  });
  if (options.autoGenerateMedia !== undefined) {
    state.sessionService.setStatus(state.session.id, {
      requestId: `request-settings-${roundId}`,
      status: 'collecting',
      constraints: {
        mediaDefaults: {
          autoGenerateMedia: options.autoGenerateMedia,
          imageProviderId: 'fixture-provider', imageModel: 'fixture-image-model', imageRatio: '9:16', imageResolution: '1K', imageQuantity: 1,
          videoProviderId: 'fixture-provider', videoModel: 'fixture-video-model', videoRatio: '9:16', videoResolution: '480p', videoDuration: 5, videoQuantity: 1
        }
      }
    });
  }
  state.sessionService.createGenerationRound(state.session.id, {
    requestId: `request-create-${roundId}`,
    roundId,
    sourceMessageEventId: eventId,
    mode: options.mode || 'manual'
  });
  const committed = state.sessionService.commitGenerationRound(state.session.id, roundId, {
    requestId: `request-commit-${roundId}`,
    planRevision: 1,
    stages: [
      { stageId: 'stage-assets', label: '资产' },
      { stageId: 'stage-video', label: '视频' }
    ],
    items: [
      {
        itemId: 'item-image', stageId: 'stage-assets', kind: 'image', prompt: '一只猫', promptVersion: 'prompt-image-v1',
        provider: 'fixture-provider', model: 'fixture-image-model', spec: { ratio: '9:16', resolution: '1K' }, quantity: 1, dependsOn: []
      },
      {
        itemId: 'item-video', stageId: 'stage-video', kind: 'video', prompt: '小猫向前跑', promptVersion: 'prompt-video-v1',
        provider: 'fixture-provider', model: 'fixture-video-model', spec: { ratio: '9:16', resolution: '480p', duration: 5 }, quantity: 1,
        dependsOn: [{ itemId: 'item-image', role: 'first_frame' }]
      }
    ]
  });
  return committed.round;
}

function verifiedRoundQuote({ session, round }) {
  return {
    verified: true,
    agentSessionId: session.id,
    roundId: round.roundId,
    planRevision: round.planRevision,
    planHash: round.planHash,
    totalQuantity: round.items.length,
    estimatedCost: 0.42,
    budgetLimit: 0.42,
    currency: 'USD'
  };
}

function routeRoundMaterializer(state) {
  const calls = [];
  return {
    calls,
    service: {
      materializeGenerationRoundReadyItems(sessionId, roundId, input) {
        calls.push({ sessionId, roundId, requestId: input.requestId });
        const session = state.sessionService.loadSession(sessionId);
        const round = session.generationRounds.find(candidate => candidate.roundId === roundId);
        const readyExecutions = calls.length === 1
          ? round.items.filter(item => item.dependsOn.length === 0).map(item => ({
              agentSessionId: session.id,
              roundId,
              itemId: item.itemId,
              taskKind: item.kind
            }))
          : [];
        return { session, roundId, readyExecutions, blockedItemIds: [] };
      }
    }
  };
}

function storedRoundAuthorizations(state) {
  const file = path.join(state.foundation.rootPath, 'execution-authorizations.json');
  return Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).authorizations || {})
    .filter(item => item.authorizationType === 'round-master');
}

test('M5E-5：手动 Round 一次确认创建并消费唯一主授权，重放不产生第二授权或执行', async () => {
  const state = fixture();
  const round = prepareRound(state, { mode: 'manual', roundId: 'round-manual-approve' });
  const materializer = routeRoundMaterializer(state);
  const originalToolRuns = state.sessionService.loadSession(state.session.id).toolRuns.length;
  await withServer(routerFor(state, state.sessionService, {
    verifyAgentGenerationRoundQuote: verifiedRoundQuote,
    agentMediaExecutionService: materializer.service
  }), async baseUrl => {
    const endpoint = `/api/canvas/agent-sessions/${state.session.id}/generation-rounds/${round.roundId}/authorization`;
    const unconfirmed = await requestJson(baseUrl, endpoint, 'POST', { requestId: 'request-round-manual-unconfirmed' });
    assert.equal(unconfirmed.status, 409);
    assert.equal((await unconfirmed.json()).code, 'GENERATION_ROUND_APPROVAL_REQUIRED');
    assert.equal(storedRoundAuthorizations(state).length, 0);
    assert.equal(state.foundation.artifactStore.list({ artifactType: 'agent-generation-plan' }).length, 0);

    const approvedResponse = await requestJson(baseUrl, endpoint, 'POST', { requestId: 'request-round-manual-approve', confirm: true });
    assert.equal(approvedResponse.status, 200);
    const approved = await approvedResponse.json();
    assert.equal(approved.authorization.authorizationType, 'round-master');
    assert.equal(approved.authorization.consumedAt > 0, true);
    assert.equal(approved.round.status, 'approved');
    assert.equal(approved.round.masterAuthorizationId, approved.authorization.authorizationId);
    assert.equal(approved.round.authorizationState, 'consumed');
    assert.equal(approved.round.planArtifactVersionId, approved.authorization.request.planArtifactVersionId);
    assert.deepEqual(approved.readyExecutions.map(item => item.itemId), ['item-image']);
    assert.equal(materializer.calls.length, 1);
    assert.equal(approved.session.toolRuns.length, originalToolRuns);
    assert.equal(approved.session.currentNodeRefs.length, 0);
    assert.equal(state.foundation.artifactStore.get(approved.round.planArtifactVersionId, { verify: false }).approvalState, 'locked');

    const replayResponse = await requestJson(baseUrl, endpoint, 'POST', { requestId: 'request-round-manual-approve', confirm: true });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent, true);
    assert.equal(replay.authorization.authorizationId, approved.authorization.authorizationId);
    assert.deepEqual(replay.readyExecutions, []);
    assert.equal(materializer.calls.length, 2);
    assert.equal(storedRoundAuthorizations(state).length, 1);
    assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, originalToolRuns);
  });
});

test('M5E-5：取消 Round 原子关闭全部 item，重放和后续推进都保持零执行', async () => {
  const state = fixture();
  const round = prepareRound(state, { mode: 'manual', roundId: 'round-manual-cancel' });
  let quoteCalls = 0;
  await withServer(routerFor(state, state.sessionService, {
    verifyAgentGenerationRoundQuote(input) { quoteCalls += 1; return verifiedRoundQuote(input); }
  }), async baseUrl => {
    const base = `/api/canvas/agent-sessions/${state.session.id}/generation-rounds/${round.roundId}`;
    const cancelledResponse = await requestJson(baseUrl, `${base}/cancel`, 'POST', { requestId: 'request-round-cancel-route', reason: '用户取消' });
    assert.equal(cancelledResponse.status, 200);
    const cancelled = await cancelledResponse.json();
    assert.equal(cancelled.round.status, 'cancelled');
    assert.deepEqual(cancelled.round.items.map(item => item.status), ['cancelled', 'cancelled']);
    assert.deepEqual(cancelled.readyExecutions, []);
    assert.equal(cancelled.session.currentNodeRefs.length, 0);
    assert.equal(storedRoundAuthorizations(state).length, 0);
    assert.equal(state.foundation.artifactStore.list({ artifactType: 'agent-generation-plan' }).length, 0);
    assert.equal(quoteCalls, 0);

    const replay = await requestJson(baseUrl, `${base}/cancel`, 'POST', { requestId: 'request-round-cancel-route', reason: '用户取消' });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
    const advance = await requestJson(baseUrl, `${base}/advance`, 'POST', { requestId: 'request-round-cancelled-advance' });
    assert.equal(advance.status, 409);
    assert.equal(storedRoundAuthorizations(state).length, 0);
    assert.equal(quoteCalls, 0);
  });
});

test('M5E-5：自动 Round 只依据已保存设置零确认授权，手动 Round advance 仍等待用户', async () => {
  const automatic = fixture();
  const autoRound = prepareRound(automatic, { mode: 'automatic', roundId: 'round-automatic', autoGenerateMedia: true });
  const materializer = routeRoundMaterializer(automatic);
  let quoteCalls = 0;
  await withServer(routerFor(automatic, automatic.sessionService, {
    verifyAgentGenerationRoundQuote(input) { quoteCalls += 1; return verifiedRoundQuote(input); },
    agentMediaExecutionService: materializer.service
  }), async baseUrl => {
    const endpoint = `/api/canvas/agent-sessions/${automatic.session.id}/generation-rounds/${autoRound.roundId}/advance`;
    const response = await requestJson(baseUrl, endpoint, 'POST', { requestId: 'request-round-auto-advance' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.round.status, 'approved');
    assert.equal(body.authorization.request.executionMode, 'auto');
    assert.equal(body.approvalRequired, false);
    assert.deepEqual(body.readyExecutions.map(item => item.itemId), ['item-image']);
    assert.equal(materializer.calls.length, 1);
    assert.equal(quoteCalls, 1);
    const replay = await requestJson(baseUrl, endpoint, 'POST', { requestId: 'request-round-auto-advance' });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.authorization.authorizationId, body.authorization.authorizationId);
    assert.deepEqual(replayBody.readyExecutions, []);
    assert.equal(materializer.calls.length, 2);
    assert.equal(storedRoundAuthorizations(automatic).length, 1);
  });

  const manual = fixture();
  const manualRound = prepareRound(manual, { mode: 'manual', roundId: 'round-manual-wait' });
  await withServer(routerFor(manual, manual.sessionService, { verifyAgentGenerationRoundQuote: verifiedRoundQuote }), async baseUrl => {
    const response = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${manual.session.id}/generation-rounds/${manualRound.roundId}/advance`,
      'POST',
      { requestId: 'request-round-manual-advance' }
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'GENERATION_ROUND_APPROVAL_REQUIRED');
    assert.equal(storedRoundAuthorizations(manual).length, 0);
  });

  const drifted = fixture();
  const driftedRound = prepareRound(drifted, { mode: 'automatic', roundId: 'round-automatic-drift', autoGenerateMedia: true });
  const current = drifted.sessionService.loadSession(drifted.session.id);
  drifted.sessionService.setStatus(drifted.session.id, {
    requestId: 'request-settings-round-automatic-drift-change',
    status: current.status,
    constraints: {
      ...current.constraints,
      mediaDefaults: { ...current.constraints.mediaDefaults, videoModel: 'changed-video-model' }
    }
  });
  await withServer(routerFor(drifted, drifted.sessionService, { verifyAgentGenerationRoundQuote: verifiedRoundQuote }), async baseUrl => {
    const response = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${drifted.session.id}/generation-rounds/${driftedRound.roundId}/advance`,
      'POST',
      { requestId: 'request-round-auto-drift-advance' }
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'AGENT_AUTO_MEDIA_BINDING_DRIFT');
    assert.equal(storedRoundAuthorizations(drifted).length, 0);
  });
});

test('M6B3：当前节点 branch-redo 路由只建立手动分支 Round，路径节点覆盖请求体且重放幂等', async () => {
  const state = fixture();
  const source = attachBranchRedoSource(state);
  const router = routerFor(state, state.sessionService, { canvasConfig: branchCanvasConfig() });
  await withServer(router, async baseUrl => {
    const endpoint = `/api/canvas/agent-sessions/${state.session.id}/current-nodes/${source.nodeId}/branch-redo`;
    const input = { requestId: 'request-route-branch-redo-manual', sourceNodeId: 'node-forged', prompt: '改成雨夜电影光影' };
    const firstResponse = await requestJson(baseUrl, endpoint, 'POST', input);
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.generationRound.mode, 'manual');
    assert.equal(first.generationRound.status, 'awaiting-approval');
    assert.equal(first.generationRound.items.length, 1);
    assert.equal(first.generationRound.items[0].parentNodeRef, source.nodeId);
    assert.equal(first.generationRound.items[0].supersedesRef, source.nodeId);
    assert.equal(first.generationRound.items[0].provider, 'fixture-provider');
    assert.equal(first.generationRound.items[0].model, 'gpt-image-2');
    assert.equal(first.userMessage.attachments[0].assetId, source.nodeId);
    assert.equal(first.message.attachments[0].assetId, first.generationRound.roundId);
    assert.equal(first.session.toolRuns.length, 2, '路由准备阶段不能创建新 ToolRun');

    const replayResponse = await requestJson(baseUrl, endpoint, 'POST', input);
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent, true);
    assert.equal(replay.generationRound.roundId, first.generationRound.roundId);
    assert.equal(replay.session.messages.length, first.session.messages.length);
    assert.equal(replay.session.generationRounds.length, 1);

    const advanceResponse = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${state.session.id}/generation-rounds/${first.generationRound.roundId}/advance`,
      'POST',
      { requestId: 'request-route-branch-redo-manual-advance' }
    );
    assert.equal(advanceResponse.status, 409);
    assert.equal((await advanceResponse.json()).code, 'GENERATION_ROUND_APPROVAL_REQUIRED');
    assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, 2);
  });
});

test('M6B3：自动 branch-redo 仍由既有 advance 完成整轮授权和本地物化', async () => {
  const state = fixture();
  const source = attachBranchRedoSource(state, { automatic: true });
  const router = routerFor(state, state.sessionService, { canvasConfig: branchCanvasConfig() });
  await withServer(router, async baseUrl => {
    const branchResponse = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${state.session.id}/current-nodes/${source.nodeId}/branch-redo`,
      'POST',
      { requestId: 'request-route-branch-redo-auto', prompt: '自动模式重做' }
    );
    assert.equal(branchResponse.status, 201);
    const branch = await branchResponse.json();
    assert.equal(branch.generationRound.mode, 'automatic');
    assert.equal(branch.generationRound.status, 'awaiting-approval');
    assert.equal(branch.session.toolRuns.length, 2, 'branch-redo POST 不能自己物化或调用 Provider');

    const advanceResponse = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${state.session.id}/generation-rounds/${branch.generationRound.roundId}/advance`,
      'POST',
      { requestId: 'request-route-branch-redo-auto-advance' }
    );
    assert.equal(advanceResponse.status, 200);
    const advanced = await advanceResponse.json();
    assert.equal(advanced.authorization.request.executionMode, 'auto');
    assert.equal(advanced.approvalRequired, false);
    assert.equal(advanced.readyExecutions.length, 1);
    assert.equal(advanced.readyExecutions[0].parentNodeRef, source.nodeId);
    assert.equal(advanced.readyExecutions[0].supersedesRef, source.nodeId);
    assert.equal(advanced.session.toolRuns.length, 3);
  });
});

test('M6B3：非当前节点和未决节点在 branch-redo 路由内失败关闭且不写 Round', async () => {
  const missing = fixture();
  attachBranchRedoSource(missing);
  await withServer(routerFor(missing, missing.sessionService, { canvasConfig: branchCanvasConfig() }), async baseUrl => {
    const response = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${missing.session.id}/current-nodes/node-not-current/branch-redo`,
      'POST',
      { requestId: 'request-route-branch-redo-missing', prompt: '不应建立分支' }
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'AGENT_MEDIA_BRANCH_SOURCE_INVALID');
    const session = missing.sessionService.loadSession(missing.session.id);
    assert.equal(session.messages.length, 0);
    assert.equal(session.generationRounds.length, 0);
  });

  const pending = fixture();
  const source = attachBranchRedoSource(pending, { status: 'remote-unknown', nodeStatus: 'waiting' });
  await withServer(routerFor(pending, pending.sessionService, { canvasConfig: branchCanvasConfig() }), async baseUrl => {
    const response = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${pending.session.id}/current-nodes/${source.nodeId}/branch-redo`,
      'POST',
      { requestId: 'request-route-branch-redo-pending', prompt: '不应重发未知远端任务' }
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'AGENT_MEDIA_BRANCH_SOURCE_INVALID');
    const session = pending.sessionService.loadSession(pending.session.id);
    assert.equal(session.messages.length, 0);
    assert.equal(session.generationRounds.length, 0);
  });
});

test('M5E-8B：ToolRun 状态原子投影到 Round item，服务重启把运行项标为 remote-unknown', () => {
  const state = fixture();
  const round = prepareRound(state, { mode: 'manual', roundId: 'round-tool-projection' });
  state.sessionService.approveGenerationRound(state.session.id, round.roundId, {
    requestId: 'request-approve-tool-projection',
    planRevision: round.planRevision,
    planHash: round.planHash
  });
  state.sessionService.upsertToolRun(state.session.id, 'tool-round-image-projection', {
    requestId: 'request-create-tool-projection',
    type: 'native-image', status: 'queued', nodeId: 'node-round-image-projection',
    provider: 'fixture-provider', model: 'fixture-image-model', operationId: 'operation-round-image-projection',
    inputVersion: state.artifact.artifactVersionId, inputHash: IMAGE_INPUT_HASH,
    quantity: 1, estimatedCost: 0, approvedBudget: 0, retryBudget: 0, attempt: 0
  });
  state.sessionService.updateGenerationRoundItem(state.session.id, round.roundId, 'item-image', {
    requestId: 'request-bind-tool-projection', status: 'queued',
    toolRunId: 'tool-round-image-projection', nodeId: 'node-round-image-projection',
    operationId: 'operation-round-image-projection', inputHash: IMAGE_INPUT_HASH
  });

  state.sessionService.upsertToolRun(state.session.id, 'tool-round-image-projection', {
    requestId: 'request-run-tool-projection', status: 'running'
  });
  let current = state.sessionService.loadSession(state.session.id);
  let currentRound = current.generationRounds.find(candidate => candidate.roundId === round.roundId);
  assert.equal(currentRound.items.find(item => item.itemId === 'item-image').status, 'running');
  assert.equal(currentRound.status, 'running');

  const restarted = createAgentSessionService({ outputRoot: state.outputRoot });
  current = restarted.loadSession(state.session.id);
  currentRound = current.generationRounds.find(candidate => candidate.roundId === round.roundId);
  assert.equal(current.toolRuns.find(item => item.id === 'tool-round-image-projection').status, 'remote-unknown');
  assert.equal(currentRound.items.find(item => item.itemId === 'item-image').status, 'remote-unknown');
  assert.equal(currentRound.items.find(item => item.itemId === 'item-image').reconcileRequired, true);
  assert.equal(currentRound.status, 'remote-unknown');
  assert.equal(currentRound.reconcileRequired, true);
});

test('M5E-5：Guard 已消费而 Round 写入中断时，同一请求安全补写且不产生第二主授权', async () => {
  const state = fixture();
  const round = prepareRound(state, { mode: 'manual', roundId: 'round-authorization-crash' });
  const materializer = routeRoundMaterializer(state);
  let failCommit = true;
  let quoteCalls = 0;
  const interruptedSessionService = {
    ...state.sessionService,
    commitGenerationRoundAuthorization(...args) {
      if (failCommit) {
        failCommit = false;
        const error = new Error('fixture round session write interrupted');
        error.statusCode = 503;
        error.code = 'FIXTURE_ROUND_SESSION_WRITE_INTERRUPTED';
        throw error;
      }
      return state.sessionService.commitGenerationRoundAuthorization(...args);
    }
  };
  await withServer(routerFor(state, interruptedSessionService, {
    verifyAgentGenerationRoundQuote(input) {
      quoteCalls += 1;
      const quote = verifiedRoundQuote(input);
      return quoteCalls === 1 ? quote : { ...quote, estimatedCost: 0.84, budgetLimit: 0.84 };
    },
    agentMediaExecutionService: materializer.service
  }), async baseUrl => {
    const endpoint = `/api/canvas/agent-sessions/${state.session.id}/generation-rounds/${round.roundId}/authorization`;
    const interrupted = await requestJson(baseUrl, endpoint, 'POST', { requestId: 'request-round-authorization-crash', confirm: true });
    assert.equal(interrupted.status, 503);
    const interruptedBody = await interrupted.json();
    assert.equal(interruptedBody.replaySafe, true);
    assert.equal(storedRoundAuthorizations(state).length, 1);
    assert.equal(storedRoundAuthorizations(state)[0].consumedAt > 0, true);
    const interruptedRound = state.sessionService.loadSession(state.session.id).generationRounds[0];
    assert.equal(interruptedRound.status, 'awaiting-approval');
    assert.equal(interruptedRound.authorizationState, 'prepared');
    assert.equal(interruptedRound.authorizationRequest.estimatedCost, 0.42);

    const recovered = await requestJson(baseUrl, endpoint, 'POST', { requestId: 'request-round-authorization-crash', confirm: true });
    assert.equal(recovered.status, 200);
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.authorization.idempotent, true);
    assert.equal(recoveredBody.round.status, 'approved');
    assert.equal(recoveredBody.authorization.request.estimatedCost, 0.42);
    assert.equal(quoteCalls, 1);
    assert.equal(storedRoundAuthorizations(state).length, 1);
  });
});

test('M5E-5：客户端伪造整轮价格不能替代服务端权威报价', async () => {
  const state = fixture();
  const round = prepareRound(state, { mode: 'manual', roundId: 'round-untrusted-quote' });
  await withServer(routerFor(state), async baseUrl => {
    const response = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${state.session.id}/generation-rounds/${round.roundId}/authorization`,
      'POST',
      { requestId: 'request-round-untrusted-quote', confirm: true, estimatedCost: 0, budgetLimit: 0, currency: 'USD' }
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'AGENT_GENERATION_ROUND_QUOTE_UNAVAILABLE');
    assert.equal(storedRoundAuthorizations(state).length, 0);
    assert.equal(state.foundation.artifactStore.list({ artifactType: 'agent-generation-plan' }).length, 0);
    assert.equal(state.sessionService.loadSession(state.session.id).generationRounds[0].status, 'awaiting-approval');
  });
});

test('M2E：Session 专属授权由 toolRun 派生，消费后与 queued toolRun 原子提交', async () => {
  const state = fixture();
  await withServer(routerFor(state), async baseUrl => {
    const prefix = `/api/canvas/agent-sessions/${state.session.id}/tool-runs/tool-m2e-route/authorization`;
    const authorizedResponse = await requestJson(baseUrl, prefix, 'POST', { requestId: 'request-authorize-m2e-route' });
    assert.equal(authorizedResponse.status, 200);
    const authorized = await authorizedResponse.json();
    assert.equal(authorized.authorization.request.agentSessionId, state.session.id);
    assert.equal(authorized.authorization.request.toolRunId, 'tool-m2e-route');
    assert.equal(authorized.authorization.request.inputHash, IMAGE_INPUT_HASH);
    assert.equal(authorized.authorization.consumedAt, null);

    const forged = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/status`, 'PATCH', {
      requestId: 'request-forged-ui-approval',
      status: 'waiting-user',
      approvals: [{ allowed: true, authorizationId: authorized.authorization.authorizationId, consumedAt: 1 }]
    });
    assert.equal(forged.status, 200);
    assert.equal(state.sessionService.loadSession(state.session.id).executionAuthorizations.length, 0, 'UI approvals 不是可信执行账本');

    const consumePath = `${prefix}/${authorized.authorization.authorizationId}/consume`;
    const consumedResponse = await requestJson(baseUrl, consumePath, 'POST', { requestId: 'request-consume-m2e-route' });
    assert.equal(consumedResponse.status, 200);
    const consumed = await consumedResponse.json();
    assert.equal(consumed.authorization.consumedAt > 0, true);
    assert.equal(consumed.session.toolRuns[0].status, 'queued');
    assert.equal(consumed.session.toolRuns[0].authorizationId, authorized.authorization.authorizationId);
    assert.equal(consumed.session.executionAuthorizations.length, 1);

    const replayResponse = await requestJson(baseUrl, consumePath, 'POST', { requestId: 'request-consume-m2e-route' });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent, true);
    assert.equal(replay.authorization.consumedAt, consumed.authorization.consumedAt);

    const reservedNamespace = await requestJson(baseUrl, '/api/canvas-agent/foundation/execution/authorize', 'POST', {
      ...authorized.authorization.request,
      reviewGateId: `agent-session:${state.session.id}:tool-m2e-route`
    });
    assert.equal(reservedNamespace.status, 400);
  });
});

test('M5：USD 媒体授权重算保留 inputRefs 与零重试安全字段', async () => {
  const state = fixture();
  const inputRefs = [{ refId: 'message-media-route-1', workspaceScope: 'canvas-agent' }];
  const executionPayload = {
    type: 'generator',
    prompt: '一只橙色小猫坐在浅蓝色背景前',
    size: '576x1024',
    assets: [],
    canvasId: 'canvas-m2e-route',
    nodeId: 'node-media-route'
  };
  const inputHash = hashAgentNativeExecutionPayload('image', executionPayload, inputRefs);
  state.sessionService.upsertToolRun(state.session.id, 'tool-media-route', {
    requestId: 'request-tool-media-route',
    type: 'native-image',
    status: 'awaiting-approval',
    nodeId: 'node-media-route',
    provider: 'apimart',
    model: 'gpt-image-2',
    operationId: 'operation-media-route',
    inputVersion: state.artifact.artifactVersionId,
    inputHash,
    inputRefs,
    executionPayload,
    quantity: 1,
    estimatedCost: 0.0085,
    approvedBudget: 0.0085,
    retryBudget: 0,
    currency: 'USD',
    attempt: 0
  });
  let verifiedBinding = null;
  const agentMediaExecutionService = {
    describe(sessionId, toolRunId) {
      assert.equal(sessionId, state.session.id);
      assert.equal(toolRunId, 'tool-media-route');
      return { execution: { inputHash } };
    },
    verifyQuote({ binding, executionPayload: suppliedPayload, inputHash: suppliedHash }) {
      verifiedBinding = binding;
      assert.deepEqual(binding.inputRefs, inputRefs);
      assert.equal(binding.approvedBudget, 0.0085);
      assert.equal(binding.retryBudget, 0);
      assert.equal(binding.allowFallback, false);
      assert.equal(suppliedHash, inputHash);
      assert.deepEqual(suppliedPayload, executionPayload);
      assert.equal(hashAgentNativeExecutionPayload('image', suppliedPayload, binding.inputRefs), inputHash);
      return { verified: true };
    }
  };

  await withServer(routerFor(state, state.sessionService, { agentMediaExecutionService }), async baseUrl => {
    const response = await requestJson(
      baseUrl,
      `/api/canvas/agent-sessions/${state.session.id}/tool-runs/tool-media-route/authorization`,
      'POST',
      { requestId: 'request-authorize-media-route' }
    );
    assert.equal(response.status, 200);
    assert.ok(verifiedBinding);
  });
});

test('M2E：Guard 已消费而 Session 写入中断时可用同一 requestId 安全补写', async () => {
  const state = fixture();
  let failCommit = true;
  const interruptedSessionService = {
    ...state.sessionService,
    commitExecutionAuthorization(...args) {
      if (failCommit) {
        failCommit = false;
        const error = new Error('fixture session write interrupted');
        error.statusCode = 503;
        error.code = 'FIXTURE_SESSION_WRITE_INTERRUPTED';
        throw error;
      }
      return state.sessionService.commitExecutionAuthorization(...args);
    }
  };
  await withServer(routerFor(state, interruptedSessionService), async baseUrl => {
    const prefix = `/api/canvas/agent-sessions/${state.session.id}/tool-runs/tool-m2e-route/authorization`;
    const authorized = await (await requestJson(baseUrl, prefix, 'POST', { requestId: 'request-authorize-crash' })).json();
    const consumePath = `${prefix}/${authorized.authorization.authorizationId}/consume`;
    const interrupted = await requestJson(baseUrl, consumePath, 'POST', { requestId: 'request-consume-crash' });
    assert.equal(interrupted.status, 503);
    const interruptedBody = await interrupted.json();
    assert.equal(interruptedBody.replaySafe, true);
    assert.equal(state.sessionService.loadSession(state.session.id).executionAuthorizations.length, 0);

    const recovered = await requestJson(baseUrl, consumePath, 'POST', { requestId: 'request-consume-crash' });
    assert.equal(recovered.status, 200);
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.authorization.idempotent, true);
    assert.equal(recoveredBody.session.executionAuthorizations.length, 1);
  });
});

test('M2E：真实 Guard 与 Session 回执贯通图片任务，重放不再次进入 Provider 执行器', async () => {
  const state = fixture();
  let executionCount = 0;
  const router = routerFor(state, state.sessionService, {
    canvasConfig: {
      primaryProviderId: 'fixture-provider',
      providers: [{
        id: 'fixture-provider',
        name: 'Fixture Provider',
        enabled: true,
        protocol: 'apimart',
        api_key: 'fixture-key-never-sent',
        base_url: 'https://fixture.invalid',
        image_models: ['fixture-image-model'],
        video_models: []
      }]
    },
    performCanvasGeneration: () => {
      executionCount += 1;
      return new Promise(() => {});
    },
    verifyAgentCostQuote: ({ binding, inputHash }) => ({
      verified: true,
      source: 'server-price-catalog',
      provider: binding.provider,
      model: binding.model,
      taskKind: binding.taskKind,
      inputHash,
      quantity: binding.quantity,
      estimatedCost: binding.estimatedCost,
      currency: binding.currency
    })
  });
  await withServer(router, async baseUrl => {
    const prefix = `/api/canvas/agent-sessions/${state.session.id}/tool-runs/tool-m2e-route/authorization`;
    const authorization = await (await requestJson(baseUrl, prefix, 'POST', { requestId: 'request-authorize-e2e' })).json();
    const consumePath = `${prefix}/${authorization.authorization.authorizationId}/consume`;
    const consumed = await (await requestJson(baseUrl, consumePath, 'POST', { requestId: 'request-consume-e2e' })).json();
    state.sessionService.upsertToolRun(state.session.id, 'tool-m2e-route', {
      requestId: 'request-tool-submitting-e2e',
      status: 'submitting',
      attempt: 1
    });
    const taskBody = {
      ...IMAGE_TASK_PAYLOAD,
      agentTask: {
        workspaceScope: 'canvas-agent',
        agentSessionId: state.session.id,
        toolRunId: 'tool-m2e-route',
        nodeId: 'node-m2e-route',
        operationId: 'operation-m2e-route',
        inputHash: IMAGE_INPUT_HASH,
        provider: 'fixture-provider',
        model: 'fixture-image-model',
        taskKind: 'image',
        authorizationId: consumed.authorization.authorizationId,
        inputVersionIds: [state.artifact.artifactVersionId],
        quantity: 1,
        estimatedCost: 4,
        approvedBudget: 4,
        retryBudget: 0,
        currency: 'CNY',
        inputRefs: [],
        allowFallback: false
      }
    };
    const firstResponse = await requestJson(baseUrl, '/api/canvas/tasks', 'POST', taskBody);
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json();
    assert.equal(first.task.agentBinding.authorizationId, consumed.authorization.authorizationId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executionCount, 1);

    const replayResponse = await requestJson(baseUrl, '/api/canvas/tasks', 'POST', taskBody);
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json()).idempotent, true);
    assert.equal(executionCount, 1);
  });
});
