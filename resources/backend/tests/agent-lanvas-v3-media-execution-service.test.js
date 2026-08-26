'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentSessionService } = require('../services/agentSessionService');
const { hashAgentNativeExecutionPayload } = require('../services/agentNativeTaskBinding');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');
const { createAgentMediaExecutionService, verifyAgentMediaQuote } = require('../services/agentMediaExecutionService');

test('M6：画布路由的延迟 Foundation 代理暴露 GenerationRound 单项回执端口', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/canvasRoutes.js'), 'utf8');
  assert.match(source, /deriveRoundItemReceipt:\s*\(\.\.\.args\)\s*=>\s*canvasAgentFoundationRoutes\.getFoundation\(\)\.executionGuard\.deriveRoundItemReceipt\(\.\.\.args\)/);
});

const DEFAULTS = Object.freeze({
  imageProviderId: 'fixture-apimart',
  imageModel: 'gpt-image-2',
  imageRatio: '9:16',
  imageResolution: '2K',
  imageQuantity: 1,
  videoProviderId: 'fixture-apimart',
  videoModel: 'seedance-2.0',
  videoRatio: '16:9',
  videoResolution: '720P',
  videoQuantity: 1,
  audioProviderId: 'fixture-apimart',
  audioModel: 'gpt-4o-mini-tts',
  audioVoice: 'alloy',
  audioFormat: 'wav',
  audioSpeed: 1,
  audioQuantity: 1
});

function fixture({ defaults = {}, provider = {}, cancelled = false } = {}) {
  const outputRoot = path.join(os.tmpdir(), `lavans-agent-media-service-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let id = 0;
  const sessionService = createAgentSessionService({ outputRoot, makeId: prefix => `${prefix}-media-${++id}` });
  const session = sessionService.createSession({
    requestId: 'request-create-media-session',
    canvasId: 'canvas-media-service',
    workspaceScope: 'canvas-agent',
    mode: 'generation'
  }).session;
  sessionService.appendMessage(session.id, {
    requestId: 'request-media-trigger',
    eventId: 'event-media-trigger',
    role: 'user',
    kind: 'text',
    content: '请准备一项媒体任务'
  });
  sessionService.setStatus(session.id, {
    requestId: 'request-media-defaults',
    status: cancelled ? 'cancelled' : 'collecting',
    constraints: { mediaDefaults: { ...DEFAULTS, ...defaults } }
  });
  const config = {
    primaryProviderId: 'other-provider-must-not-fallback',
    providers: [{
      id: 'fixture-apimart',
      name: 'Fixture APIMart',
      enabled: true,
      protocol: 'apimart',
      api_key: 'fixture-key-never-sent',
      base_url: 'https://fixture.invalid',
      image_models: ['gpt-image-2'],
      video_models: ['seedance-2.0'],
      audio_models: ['gpt-4o-mini-tts'],
      ...provider
    }, {
      id: 'other-provider-must-not-fallback',
      enabled: true,
      protocol: 'apimart',
      api_key: 'fixture-key-never-sent',
      base_url: 'https://fixture.invalid',
      image_models: ['gpt-image-2'],
      video_models: ['seedance-2.0'],
      audio_models: ['gpt-4o-mini-tts']
    }]
  };
  const foundation = createCanvasAgentFoundation({ rootPath: path.join(outputRoot, 'agent-foundation') });
  const canvasRecord = { id: session.canvasId, nodes: [], connections: [] };
  const service = createAgentMediaExecutionService({
    agentSessionService: sessionService,
    getCanvasConfig: () => config,
    getCanvasRecord: canvasId => canvasId === canvasRecord.id ? canvasRecord : null,
    resolveCanvasAssetPath: url => /^\/canvas-output\/[A-Za-z0-9._%()-]+$/.test(url) ? path.join(outputRoot, path.basename(url)) : null,
    foundation
  });
  return { outputRoot, sessionService, session: sessionService.loadSession(session.id), config, foundation, canvasRecord, service };
}

function attachSucceededSourceImage(state, overrides = {}) {
  const nodeId = overrides.nodeId || 'node-source-image-1';
  const toolRunId = overrides.toolRunId || 'tool-source-image-1';
  state.sessionService.upsertToolRun(state.session.id, toolRunId, {
    requestId: `request-${toolRunId}`,
    type: 'native-image',
    status: overrides.status || 'succeeded',
    nodeId,
    provider: 'fixture-apimart',
    model: 'gpt-image-2'
  });
  state.sessionService.attachCurrentNode(state.session.id, nodeId, {
    requestId: `request-attach-${nodeId}`,
    workspaceScope: 'canvas-agent',
    kind: overrides.kind || 'image',
    nodeRole: 'image-output',
    toolRunId,
    branchRootRef: nodeId
  });
  const url = overrides.url || '/canvas-output/source-image-1.png';
  if (/^\/canvas-output\/[A-Za-z0-9._%()-]+$/.test(url)) {
    fs.writeFileSync(path.join(state.outputRoot, path.basename(url)), overrides.bytes || Buffer.from('fixture-source-image'));
  }
  state.canvasRecord.nodes.push({
    id: nodeId,
    type: 'smart-image',
    images: [{
      url,
      name: 'source-image-1.png',
      kind: 'image',
      generatedResult: true
    }],
    taskState: { status: overrides.nodeStatus || 'completed' },
    agentNative: {
      workspaceScope: 'canvas-agent',
      agentSessionId: overrides.agentSessionId || state.session.id,
      toolRunId,
      kind: overrides.kind || 'image'
    }
  });
  return { nodeId, toolRunId };
}

function sourceImageReference(state, source) {
  const node = state.canvasRecord.nodes.find(item => item.id === source.nodeId);
  const image = node.images[0];
  const bytes = fs.readFileSync(path.join(state.outputRoot, path.basename(image.url)));
  return {
    referenceId: source.nodeId,
    referenceIndex: 1,
    sourceImageIndex: 0,
    role: 'first_frame',
    url: image.url,
    originalName: image.name,
    contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length
  };
}

function attachTerminalSourceVideo(state, overrides = {}) {
  const nodeId = overrides.nodeId || 'node-source-video-1';
  const toolRunId = overrides.toolRunId || 'tool-source-video-1';
  const status = overrides.status || 'succeeded';
  state.sessionService.upsertToolRun(state.session.id, toolRunId, {
    requestId: `request-${toolRunId}`,
    type: 'native-video',
    status,
    nodeId,
    provider: 'fixture-apimart',
    model: 'seedance-2.0',
    inputHash: overrides.inputHash || '',
    executionPayload: {
      prompt: '旧视频 Prompt',
      duration: 5,
      resolution: '480p',
      aspect_ratio: '9:16',
      images: overrides.reference ? [overrides.reference] : []
    }
  });
  state.sessionService.attachCurrentNode(state.session.id, nodeId, {
    requestId: `request-attach-${nodeId}`,
    workspaceScope: 'canvas-agent',
    kind: 'video',
    nodeRole: 'video-output',
    toolRunId,
    branchRootRef: overrides.branchRootRef || nodeId
  });
  state.canvasRecord.nodes.push({
    id: nodeId,
    type: 'smart-video',
    taskState: { status: overrides.nodeStatus || ({ succeeded: 'completed', failed: 'failed', cancelled: 'cancelled' })[status] || 'waiting' },
    agentNative: {
      workspaceScope: 'canvas-agent',
      agentSessionId: state.session.id,
      toolRunId,
      kind: 'video'
    }
  });
  return { nodeId, toolRunId };
}

function prepareInput(overrides = {}) {
  return {
    requestId: 'request-prepare-media',
    triggerMessageEventId: 'event-media-trigger',
    kind: 'image',
    prompt: '严格使用当前会话中保存的媒体默认设置',
    ...overrides
  };
}

function pureRoundPlan(round) {
  return {
    planRevision: round.planRevision,
    stages: round.stages.map(stage => ({ stageId: stage.stageId, label: stage.label })),
    items: round.items.map(item => ({
      itemId: item.itemId,
      stageId: item.stageId,
      kind: item.kind,
      prompt: item.prompt,
      promptVersion: item.promptVersion,
      provider: item.provider,
      model: item.model,
      spec: item.spec,
      quantity: 1,
      dependsOn: item.dependsOn,
      ...(item.parentNodeRef ? {
        parentNodeRef: item.parentNodeRef,
        branchRootRef: item.branchRootRef,
        supersedesRef: item.supersedesRef
      } : {})
    }))
  };
}

function authorizeRound(state, items, { roundId = 'round-media-batch', mode = 'automatic' } = {}) {
  const stages = [...new Set(items.map(item => item.stageId))].map(stageId => ({ stageId, label: stageId }));
  state.sessionService.createGenerationRound(state.session.id, {
    requestId: `request-create-${roundId}`,
    roundId,
    sourceMessageEventId: 'event-media-trigger',
    mode
  });
  let round = state.sessionService.commitGenerationRound(state.session.id, roundId, {
    requestId: `request-commit-${roundId}`,
    planRevision: 1,
    stages,
    items
  }).round;
  const session = state.sessionService.loadSession(state.session.id);
  const quote = state.service.verifyGenerationRoundQuote({ session, round });
  let artifact = state.foundation.createArtifact({
    logicalArtifactId: `agent-generation-plan-${roundId}`,
    artifactType: 'agent-generation-plan',
    operationId: `lock-generation-plan-${roundId}`,
    source: 'test',
    content: {
      agentSessionId: session.id,
      roundId,
      planRevision: round.planRevision,
      planHash: round.planHash,
      plan: pureRoundPlan(round)
    },
    extension: '.json',
    inputRefs: [],
    metadata: { canvasId: session.canvasId, agentSessionId: session.id, roundId, hidden: true }
  });
  artifact = state.foundation.approvalGate.requestReview(artifact.artifactVersionId);
  artifact = state.foundation.approvalGate.approve(artifact.artifactVersionId);
  artifact = state.foundation.approvalGate.lock(artifact.artifactVersionId);
  const authorizationRequest = {
    agentSessionId: session.id,
    roundId,
    planRevision: round.planRevision,
    planHash: round.planHash,
    planArtifactVersionId: artifact.artifactVersionId,
    planArtifactContentHash: artifact.contentHash,
    totalQuantity: quote.totalQuantity,
    estimatedCost: quote.estimatedCost,
    budgetLimit: quote.budgetLimit,
    currency: quote.currency,
    executionMode: mode === 'automatic' ? 'auto' : 'manual',
    reviewGateId: 'generation-round-review'
  };
  state.sessionService.prepareGenerationRoundAuthorization(session.id, roundId, {
    requestId: `request-prepare-auth-${roundId}`,
    authorizationRequest
  });
  const master = state.foundation.executionGuard.authorizeRound({ ...authorizationRequest, authorizedBy: 'user' });
  const consumed = state.foundation.executionGuard.consumeRoundAuthorization({
    authorizationId: master.authorizationId,
    agentSessionId: session.id,
    roundId,
    planRevision: round.planRevision,
    planHash: round.planHash,
    planArtifactVersionId: artifact.artifactVersionId
  });
  round = state.sessionService.commitGenerationRoundAuthorization(session.id, roundId, {
    requestId: `request-commit-auth-${roundId}`,
    authorization: consumed
  }).round;
  return { round, quote, artifact, master: consumed };
}

function roundImageItem(index, overrides = {}) {
  return {
    itemId: `image-${index}`,
    stageId: 'stage-images',
    kind: 'image',
    prompt: `图片 ${index}`,
    promptVersion: `prompt-image-${index}`,
    provider: 'fixture-apimart',
    model: 'gpt-image-2',
    spec: { ratio: '1:1', resolution: '1K' },
    quantity: 1,
    dependsOn: [],
    ...overrides
  };
}

function roundVideoItem(index, sourceItemId, overrides = {}) {
  return {
    itemId: `video-${index}`,
    stageId: 'stage-videos',
    kind: 'video',
    prompt: `视频 ${index}`,
    promptVersion: `prompt-video-${index}`,
    provider: 'fixture-apimart',
    model: 'seedance-2.0',
    spec: { ratio: '9:16', resolution: '480P', duration: 5 },
    quantity: 1,
    dependsOn: [{ itemId: sourceItemId, role: 'first_frame' }],
    ...overrides
  };
}

function settleRoundImage(state, roundId, itemId, { succeeded = true, bytes = null } = {}) {
  let session = state.sessionService.loadSession(state.session.id);
  const item = session.generationRounds.find(candidate => candidate.roundId === roundId).items
    .find(candidate => candidate.itemId === itemId);
  state.sessionService.upsertToolRun(session.id, item.toolRunId, {
    requestId: `request-settle-tool-${roundId}-${itemId}`,
    status: succeeded ? 'succeeded' : 'failed',
    error: succeeded ? '' : 'fixture image failed'
  });
  if (succeeded) {
    const url = `/canvas-output/${roundId}-${itemId}.png`;
    const content = bytes || Buffer.from(`fixture-${roundId}-${itemId}`);
    fs.writeFileSync(path.join(state.outputRoot, path.basename(url)), content);
    state.sessionService.attachCurrentNode(session.id, item.nodeId, {
      requestId: `request-attach-${roundId}-${itemId}`,
      workspaceScope: 'canvas-agent',
      kind: 'image',
      nodeRole: 'image-output',
      toolRunId: item.toolRunId,
      branchRootRef: item.nodeId
    });
    state.canvasRecord.nodes.push({
      id: item.nodeId,
      type: 'smart-image',
      images: [{ url, name: path.basename(url), kind: 'image', generatedResult: true }],
      taskState: { status: 'completed' },
      agentNative: {
        workspaceScope: 'canvas-agent',
        agentSessionId: session.id,
        toolRunId: item.toolRunId,
        kind: 'image'
      }
    });
  }
  state.sessionService.updateGenerationRoundItem(session.id, roundId, itemId, {
    requestId: `request-settle-item-${roundId}-${itemId}`,
    status: succeeded ? 'succeeded' : 'failed',
    error: succeeded ? '' : 'fixture image failed'
  });
}

test('M5：图片 prepare 生成确定性 awaiting-approval ToolRun、精确 USD 报价和 Bridge execution', () => {
  const state = fixture();
  const result = state.service.prepare(state.session.id, prepareInput());
  assert.equal(result.idempotent, false);
  assert.equal(result.toolRun.status, 'awaiting-approval');
  assert.equal(result.toolRun.type, 'native-image');
  assert.equal(result.toolRun.provider, 'fixture-apimart');
  assert.equal(result.toolRun.model, 'gpt-image-2');
  assert.equal(result.toolRun.quantity, 1);
  assert.equal(result.toolRun.currency, 'USD');
  assert.equal(result.toolRun.retryBudget, 0);
  assert.deepEqual(result.toolRun.executionPayload, {
    type: 'generator',
    prompt: prepareInput().prompt,
    size: '1152x2048',
    assets: [],
    canvasId: 'canvas-media-service',
    nodeId: result.toolRun.nodeId
  });
  const [width, height] = result.toolRun.executionPayload.size.split('x').map(Number);
  assert.equal(width / height, 9 / 16);
  assert.equal(Math.max(width, height), 2048, '现有 apimartSizeResolution 会精确解析为 9:16 / 2k');
  assert.equal(result.quote.verified, true);
  assert.equal(result.quote.source, 'server-price-catalog');
  assert.equal(result.quote.estimatedCost, 0.014);
  assert.equal(result.execution.allowFallback, false);
  assert.equal(result.execution.retryBudget, 0);
  assert.equal('authorizationId' in result.execution, false);
  assert.equal(result.execution.inputHash, hashAgentNativeExecutionPayload('image', result.execution.taskPayload, result.execution.inputRefs));
  assert.equal(result.execution.workspaceScope, 'canvas-agent');
  const lockedInput = state.foundation.artifactStore.get(result.execution.inputVersion, { verify: false });
  assert.equal(lockedInput.artifactType, 'agent-media-execution-input');
  assert.equal(lockedInput.approvalState, 'locked');
  assert.equal(lockedInput.validityState, 'current');
  assert.equal(lockedInput.metadata.hidden, true);
  assert.equal(lockedInput.metadata.visibility, 'backend-only');
  assert.equal(lockedInput.metadata.triggerMessageEventId, 'event-media-trigger');
  const frozenInput = JSON.parse(state.foundation.artifactStore.readContent(result.execution.inputVersion));
  assert.equal(frozenInput.triggerMessageEventId, 'event-media-trigger');
  assert.equal(frozenInput.normalizedExecutionPayload.prompt, prepareInput().prompt);
  assert.deepEqual(frozenInput.mediaSettings, {
    kind: 'image',
    providerId: 'fixture-apimart',
    model: 'gpt-image-2',
    ratio: '9:16',
    resolution: '2k',
    quantity: 1,
    duration: null
  });
  assert.deepEqual(frozenInput.quote, result.quote);

  const replay = state.service.prepare(state.session.id, prepareInput());
  assert.equal(replay.idempotent, true);
  assert.equal(replay.execution.operationId, result.execution.operationId);
  assert.equal(replay.execution.toolRunId, result.execution.toolRunId);
  assert.equal(replay.execution.nodeId, result.execution.nodeId);
  assert.equal(replay.execution.inputVersion, result.execution.inputVersion);
  assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, 1);
  assert.equal(state.foundation.artifactStore.list({ logicalArtifactId: lockedInput.logicalArtifactId }).length, 1);

  const described = state.service.describe(state.session.id, result.toolRun.id);
  assert.deepEqual(described.execution, result.execution);
  assert.deepEqual(described.quote, result.quote);
});

test('M5：视频 prepare 默认 5 秒、清晰度小写并按秒精确计价', () => {
  const state = fixture();
  const result = state.service.prepare(state.session.id, prepareInput({
    requestId: 'request-prepare-video',
    kind: 'video',
    prompt: '生成五秒安全测试视频'
  }));
  assert.equal(result.toolRun.type, 'native-video');
  assert.deepEqual(result.execution.taskPayload, {
    prompt: '生成五秒安全测试视频',
    duration: 5,
    resolution: '720p',
    aspect_ratio: '16:9',
    images: []
  });
  assert.equal(result.quote.estimatedCost, 0.895);
  assert.equal(result.toolRun.approvedBudget, 0.895);
  assert.equal(result.execution.inputHash, hashAgentNativeExecutionPayload('video', result.execution.taskPayload, result.execution.inputRefs));
  assert.equal(result.quote.resolution, '720p');
  assert.equal(result.quote.aspectRatio, '16:9');
});

test('M6：音频 prepare 锁定 APIMart TTS、WAV、音色与语速，保持零重试且禁止 fallback', () => {
  const state = fixture();
  const result = state.service.prepare(state.session.id, prepareInput({
    requestId: 'request-prepare-audio',
    kind: 'audio',
    prompt: '你好，Lavans。'
  }));
  assert.equal(result.toolRun.type, 'native-audio');
  assert.equal(result.toolRun.provider, 'fixture-apimart');
  assert.equal(result.toolRun.model, 'gpt-4o-mini-tts');
  assert.deepEqual(result.execution.taskPayload, {
    input: '你好，Lavans。',
    voice: 'alloy',
    response_format: 'wav',
    speed: 1
  });
  assert.equal(result.execution.retryBudget, 0);
  assert.equal(result.execution.allowFallback, false);
  assert.equal(result.quote.estimatedCost, 0.015);
  assert.equal(result.quote.resolution, 'wav');
  assert.equal(result.quote.aspectRatio, 'alloy');
  assert.equal(result.execution.inputHash, hashAgentNativeExecutionPayload('audio', result.execution.taskPayload, result.execution.inputRefs));
});

test('M5C：同 Session 已完成图片被锁定为 Seedance 首帧，并进入 inputHash 与节点来源', () => {
  const state = fixture({ defaults: { videoResolution: '480P', videoRatio: '9:16' } });
  const source = attachSucceededSourceImage(state);
  const result = state.service.prepare(state.session.id, prepareInput({
    requestId: 'request-reference-video',
    kind: 'video',
    prompt: '让这只猫向前奔跑，镜头平稳跟随',
    sourceNodeId: source.nodeId,
    sourceImageIndex: 0
  }));
  assert.equal(result.execution.sourceNodeId, source.nodeId);
  assert.equal(result.execution.parentNodeRef, source.nodeId);
  assert.equal(result.execution.branchRootRef, source.nodeId);
  assert.deepEqual(result.execution.taskPayload.images, [{
    referenceId: source.nodeId,
    referenceIndex: 1,
    sourceImageIndex: 0,
    role: 'first_frame',
    url: '/canvas-output/source-image-1.png',
    originalName: 'source-image-1.png',
    contentHash: crypto.createHash('sha256').update(Buffer.from('fixture-source-image')).digest('hex'),
    byteLength: Buffer.byteLength('fixture-source-image')
  }]);
  assert.deepEqual(result.execution.inputRefs, [
    { refId: 'event-media-trigger', workspaceScope: 'canvas-agent' },
    { refId: source.nodeId, workspaceScope: 'canvas-agent' }
  ]);
  assert.equal(result.quote.estimatedCost, 0.415);
  assert.equal(result.quote.resolution, '480p');
  assert.equal(result.quote.aspectRatio, '9:16');
  assert.equal(result.execution.inputHash, hashAgentNativeExecutionPayload('video', result.execution.taskPayload, result.execution.inputRefs));

  const remotePayload = { ...result.execution.taskPayload, images: [{ ...result.execution.taskPayload.images[0], url: 'https://invalid.example/source.png' }] };
  const remoteHash = hashAgentNativeExecutionPayload('video', remotePayload, result.execution.inputRefs);
  assert.throws(() => verifyAgentMediaQuote({
    binding: { ...result.execution, inputHash: remoteHash },
    executionPayload: remotePayload,
    inputHash: remoteHash
  }), error => error?.code === 'AGENT_MEDIA_REFERENCE_INVALID');

  state.canvasRecord.nodes[0].images[0].url = '/canvas-output/source-image-drift.png';
  assert.throws(() => state.service.describe(state.session.id, result.toolRunId), error => error?.code === 'AGENT_MEDIA_REFERENCE_CONFLICT');
});

test('M5C：跨 Session、非终态或非图片节点在 ToolRun 与付费授权前失败关闭', () => {
  for (const overrides of [
    { agentSessionId: 'agent-session-other' },
    { status: 'failed' },
    { kind: 'video' },
    { nodeStatus: 'running' },
    { url: 'https://invalid.example/source.png' }
  ]) {
    const state = fixture();
    const source = attachSucceededSourceImage(state, overrides);
    assert.throws(() => state.service.prepare(state.session.id, prepareInput({
      requestId: `request-invalid-reference-${Object.keys(overrides)[0]}`,
      kind: 'video',
      sourceNodeId: source.nodeId
    })), error => error?.code === 'AGENT_MEDIA_REFERENCE_INVALID');
    assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.filter(item => item.id !== source.toolRunId).length, 0);
  }
});

test('M5C：参考图片本地文件不存在时在 ToolRun 与授权前失败关闭', () => {
  const state = fixture();
  const source = attachSucceededSourceImage(state);
  const service = createAgentMediaExecutionService({
    agentSessionService: state.sessionService,
    getCanvasConfig: () => state.config,
    getCanvasRecord: () => state.canvasRecord,
    resolveCanvasAssetPath: () => null,
    foundation: state.foundation
  });
  assert.throws(() => service.prepare(state.session.id, prepareInput({
    requestId: 'request-missing-reference-file',
    kind: 'video',
    sourceNodeId: source.nodeId
  })), error => error?.code === 'AGENT_MEDIA_REFERENCE_INVALID');
  assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.filter(item => item.id !== source.toolRunId).length, 0);
});

test('M5：纯价目验证覆盖图片 1K/2K/4K 与视频 480p/720p/1080p', () => {
  const state = fixture();
  const prepared = state.service.prepare(state.session.id, prepareInput());
  for (const [size, cost] of [['576x1024', 0.0085], ['1152x2048', 0.014], ['2304x4096', 0.021]]) {
    const payload = { ...prepared.execution.taskPayload, size };
    const inputHash = hashAgentNativeExecutionPayload('image', payload, prepared.execution.inputRefs);
    const binding = { ...prepared.execution, inputHash, estimatedCost: cost, approvedBudget: cost };
    assert.equal(verifyAgentMediaQuote({ binding, executionPayload: payload, inputHash }).estimatedCost, cost);
  }

  for (const [resolution, unit] of [['480p', 0.083], ['720p', 0.179], ['1080p', 0.404]]) {
    const payload = { prompt: '价目验证', duration: 15, resolution, aspect_ratio: '9:16', images: [] };
    const inputRefs = [{ refId: 'event-media-trigger', workspaceScope: 'canvas-agent' }];
    const inputHash = hashAgentNativeExecutionPayload('video', payload, inputRefs);
    const cost = Number((unit * 15).toFixed(6));
    const binding = {
      provider: 'fixture-apimart', model: 'seedance-2.0', taskKind: 'video', inputHash,
      inputRefs, quantity: 1, retryBudget: 0, allowFallback: false,
      estimatedCost: cost, approvedBudget: cost, currency: 'USD'
    };
    assert.equal(verifyAgentMediaQuote({ binding, executionPayload: payload, inputHash }).estimatedCost, cost);
  }
});

test('M5：失效模型、规格、数量、协议与 cancelled Session 全部在 ToolRun 前失败关闭', () => {
  const cases = [
    [fixture({ defaults: { imageModel: 'unknown-image-model' }, provider: { image_models: ['unknown-image-model'] } }), 'AGENT_MEDIA_MODEL_UNAVAILABLE'],
    [fixture({ provider: { image_models: [] } }), 'AGENT_MEDIA_MODEL_UNAVAILABLE'],
    [fixture({ defaults: { imageResolution: '8K' } }), 'AGENT_MEDIA_SPEC_UNAVAILABLE'],
    [fixture({ defaults: { imageQuantity: 2 } }), 'AGENT_MEDIA_QUANTITY_UNAVAILABLE'],
    [fixture({ defaults: { imageProviderId: 'provider-does-not-exist' } }), 'AGENT_MEDIA_PROVIDER_UNAVAILABLE'],
    [fixture({ provider: { protocol: 'openai' } }), 'AGENT_MEDIA_PROTOCOL_UNAVAILABLE'],
    [fixture({ provider: { api_key: '   ' } }), 'AGENT_MEDIA_PROVIDER_INCOMPLETE'],
    [fixture({ provider: { base_url: '   ' } }), 'AGENT_MEDIA_PROVIDER_INCOMPLETE'],
    [fixture({ provider: { enabled: false } }), 'AGENT_MEDIA_PROVIDER_UNAVAILABLE'],
    [fixture({ cancelled: true }), 'SESSION_CANCELLED']
  ];
  for (const [state, code] of cases) {
    assert.throws(() => state.service.prepare(state.session.id, prepareInput()), error => error?.code === code);
    assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, 0);
  }
});

test('M5：缺少 Foundation 锁定端口时失败关闭且不创建 ToolRun', () => {
  const state = fixture();
  const service = createAgentMediaExecutionService({
    agentSessionService: state.sessionService,
    getCanvasConfig: () => state.config
  });
  assert.throws(() => service.prepare(state.session.id, prepareInput()), error => error?.code === 'AGENT_MEDIA_FOUNDATION_UNAVAILABLE');
  assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, 0);
});

test('M5：报价重算拒绝 fallback、retry、价格、inputHash 或执行载荷漂移', () => {
  const state = fixture();
  const prepared = state.service.prepare(state.session.id, prepareInput());
  const verify = (binding = prepared.execution, payload = prepared.execution.taskPayload, inputHash = prepared.execution.inputHash) => (
    verifyAgentMediaQuote({ binding, executionPayload: payload, inputHash })
  );
  assert.equal(verify().estimatedCost, 0.014);
  assert.throws(() => verify({ ...prepared.execution, allowFallback: true }), error => error?.code === 'AGENT_MEDIA_EXECUTION_POLICY_CONFLICT');
  assert.throws(() => verify({ ...prepared.execution, retryBudget: 1 }), error => error?.code === 'AGENT_MEDIA_EXECUTION_POLICY_CONFLICT');
  assert.throws(() => verify({ ...prepared.execution, estimatedCost: 0.01, approvedBudget: 0.01 }), error => error?.code === 'AGENT_MEDIA_QUOTE_CONFLICT');
  assert.throws(() => verify(prepared.execution, prepared.execution.taskPayload, '0'.repeat(64)), error => error?.code === 'AGENT_MEDIA_INPUT_HASH_CONFLICT');
  assert.throws(() => verify(prepared.execution, { ...prepared.execution.taskPayload, prompt: '漂移后的 Prompt' }), error => error?.code === 'AGENT_MEDIA_INPUT_HASH_CONFLICT');
});

test('M5：同 requestId 改变精确设置触发现有 Session 幂等冲突，不产生第二个 ToolRun', () => {
  const state = fixture();
  state.service.prepare(state.session.id, prepareInput());
  const current = state.sessionService.loadSession(state.session.id);
  state.sessionService.setStatus(state.session.id, {
    requestId: 'request-change-media-defaults',
    status: current.status,
    constraints: { mediaDefaults: { ...DEFAULTS, imageResolution: '4K' } }
  });
  assert.throws(() => state.service.prepare(state.session.id, prepareInput()), error => error?.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, 1);
});

test('M5E-6：整轮报价不预写执行身份，批准后 10 张图片物化为 10 个独立 ToolRun 与节点身份', () => {
  const state = fixture();
  const items = Array.from({ length: 10 }, (_, index) => roundImageItem(index + 1));
  const prepared = authorizeRound(state, items, { roundId: 'round-ten-images' });
  assert.equal(prepared.quote.totalQuantity, 10);
  assert.equal(prepared.quote.estimatedCost, 0.085);
  assert.equal('inputHash' in prepared.quote, false);
  assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, 0, '报价和主授权阶段不能预建 ToolRun');

  const materialized = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-ten-images'
  });
  assert.equal(materialized.readyExecutions.length, 10);
  const round = materialized.session.generationRounds.find(candidate => candidate.roundId === prepared.round.roundId);
  assert.equal(new Set(round.items.map(item => item.toolRunId)).size, 10);
  assert.equal(new Set(round.items.map(item => item.nodeId)).size, 10);
  assert.deepEqual(new Set(round.items.map(item => item.status)), new Set(['queued']));
  assert.equal(materialized.session.toolRuns.length, 10);
  assert.ok(materialized.session.toolRuns.every(toolRun => toolRun.authorizationState === 'consumed' && toolRun.status === 'queued'));

  const replay = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-ten-images-replay'
  });
  assert.equal(replay.readyExecutions.length, 0);
  assert.equal(replay.session.toolRuns.length, 10);
});

test('M5E-6：3 张图片成功后只解锁各自 3 个依赖视频，最终 inputHash 绑定真实本地文件摘要', () => {
  const state = fixture();
  const items = [];
  for (let index = 1; index <= 3; index += 1) {
    items.push(roundImageItem(index), roundVideoItem(index, `image-${index}`));
  }
  const prepared = authorizeRound(state, items, { roundId: 'round-three-pairs' });
  const first = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-three-images'
  });
  assert.equal(first.readyExecutions.length, 3);
  assert.ok(first.readyExecutions.every(entry => entry.taskKind === 'image'));
  assert.equal(first.session.toolRuns.filter(toolRun => toolRun.type === 'native-video').length, 0);

  for (let index = 1; index <= 3; index += 1) settleRoundImage(state, prepared.round.roundId, `image-${index}`);
  const second = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-three-videos'
  });
  assert.equal(second.readyExecutions.length, 3);
  assert.ok(second.readyExecutions.every(entry => entry.taskKind === 'video'));
  for (let index = 1; index <= 3; index += 1) {
    const video = second.readyExecutions.find(entry => entry.toolRun.executionPayload.prompt === `视频 ${index}`);
    const reference = video.toolRun.executionPayload.images[0];
    const source = second.session.generationRounds.find(candidate => candidate.roundId === prepared.round.roundId).items
      .find(item => item.itemId === `image-${index}`);
    assert.equal(reference.referenceId, source.nodeId);
    assert.match(reference.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(reference.byteLength > 0);
    assert.equal(video.toolRun.inputHash, hashAgentNativeExecutionPayload('video', video.toolRun.executionPayload, video.toolRun.inputRefs));
  }
});

test('R3：Skill 媒体计划把当前镜头的直接与传递图片依赖按稳定图号送入图片和视频任务', () => {
  const state = fixture();
  const items = [
    roundImageItem(1, { itemId: 'asset-character', stageId: 'stage-assets', prompt: '人物资产' }),
    roundImageItem(2, { itemId: 'asset-product', stageId: 'stage-assets', prompt: '产品资产' }),
    roundImageItem(3, { itemId: 'asset-unrelated', stageId: 'stage-assets', prompt: '其它镜头资产' }),
    roundImageItem(5, {
      itemId: 'keyframe-01',
      stageId: 'stage-keyframes',
      prompt: '当前镜头逐镜图',
      dependsOn: [{ itemId: 'storyboard-01', role: 'storyboard' }]
    }),
    roundImageItem(4, {
      itemId: 'storyboard-01',
      stageId: 'stage-storyboard',
      prompt: '当前镜头分镜图',
      dependsOn: [
        { itemId: 'asset-character', role: 'character' },
        { itemId: 'asset-product', role: 'product' }
      ]
    }),
    roundVideoItem(1, 'keyframe-01', {
      itemId: 'video-01',
      prompt: '当前镜头视频，@图片1 是首帧，@图片2 是产品，@图片3 是分镜，@图片4 是人物',
      dependsOn: [
        { itemId: 'asset-product', role: 'product' },
        { itemId: 'keyframe-01', role: 'first_frame' }
      ]
    })
  ];
  const prepared = authorizeRound(state, items, { roundId: 'round-skill-reference-chain' });

  const assets = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-skill-assets'
  });
  assert.deepEqual(assets.readyExecutions.map(entry => entry.toolRun.executionPayload.prompt).sort(), [
    '产品资产', '人物资产', '其它镜头资产'
  ]);
  for (const itemId of ['asset-character', 'asset-product', 'asset-unrelated']) {
    settleRoundImage(state, prepared.round.roundId, itemId);
  }

  const storyboard = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-skill-storyboard'
  }).readyExecutions[0];
  assert.deepEqual(storyboard.toolRun.executionPayload.assets.map(reference => ({
    sourceItemId: reference.sourceItemId,
    referenceIndex: reference.referenceIndex,
    role: reference.role
  })), [
    { sourceItemId: 'asset-character', referenceIndex: 1, role: 'character' },
    { sourceItemId: 'asset-product', referenceIndex: 2, role: 'product' }
  ]);
  assert.ok(!storyboard.toolRun.executionPayload.assets.some(reference => reference.sourceItemId === 'asset-unrelated'));
  settleRoundImage(state, prepared.round.roundId, 'storyboard-01');

  const keyframe = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-skill-keyframe'
  }).readyExecutions[0];
  assert.deepEqual(keyframe.toolRun.executionPayload.assets.map(reference => ({
    sourceItemId: reference.sourceItemId,
    referenceIndex: reference.referenceIndex,
    role: reference.role
  })), [
    { sourceItemId: 'storyboard-01', referenceIndex: 1, role: 'storyboard' },
    { sourceItemId: 'asset-character', referenceIndex: 2, role: 'character' },
    { sourceItemId: 'asset-product', referenceIndex: 3, role: 'product' }
  ]);
  settleRoundImage(state, prepared.round.roundId, 'keyframe-01');

  const video = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-skill-video'
  }).readyExecutions[0];
  assert.deepEqual(video.toolRun.executionPayload.images.map(reference => ({
    sourceItemId: reference.sourceItemId,
    referenceIndex: reference.referenceIndex,
    role: reference.role
  })), [
    { sourceItemId: 'keyframe-01', referenceIndex: 1, role: 'first_frame' },
    { sourceItemId: 'asset-product', referenceIndex: 2, role: 'product' },
    { sourceItemId: 'storyboard-01', referenceIndex: 3, role: 'storyboard' },
    { sourceItemId: 'asset-character', referenceIndex: 4, role: 'character' }
  ]);
  assert.ok(!video.toolRun.executionPayload.images.some(reference => reference.sourceItemId === 'asset-unrelated'));
  assert.equal(video.toolRun.inputHash, hashAgentNativeExecutionPayload('video', video.toolRun.executionPayload, video.toolRun.inputRefs));
  const restartedSession = createAgentSessionService({ outputRoot: state.outputRoot }).loadSession(state.session.id);
  const restartedVideo = restartedSession.toolRuns.find(toolRun => toolRun.id === video.toolRun.id);
  assert.deepEqual(restartedVideo.executionPayload.images, video.toolRun.executionPayload.images);
  assert.deepEqual(restartedVideo.inputRefs, video.toolRun.inputRefs);
});

test('M5E-6：单张图片失败只阻断自己的依赖视频，其余视频继续物化', () => {
  const state = fixture();
  const items = [];
  for (let index = 1; index <= 3; index += 1) {
    items.push(roundImageItem(index), roundVideoItem(index, `image-${index}`));
  }
  const prepared = authorizeRound(state, items, { roundId: 'round-one-image-fails' });
  state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-failure-images'
  });
  settleRoundImage(state, prepared.round.roundId, 'image-1');
  settleRoundImage(state, prepared.round.roundId, 'image-2', { succeeded: false });
  settleRoundImage(state, prepared.round.roundId, 'image-3');

  const result = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-unblocked-videos'
  });
  assert.equal(result.readyExecutions.length, 2);
  assert.deepEqual(result.blockedItemIds, ['video-2']);
  const round = result.session.generationRounds.find(candidate => candidate.roundId === prepared.round.roundId);
  assert.equal(round.items.find(item => item.itemId === 'video-1').status, 'queued');
  assert.equal(round.items.find(item => item.itemId === 'video-2').status, 'blocked-by-dependency');
  assert.equal(round.items.find(item => item.itemId === 'video-2').toolRunId, '');
  assert.equal(round.items.find(item => item.itemId === 'video-3').status, 'queued');
  assert.equal(result.session.toolRuns.filter(toolRun => toolRun.type === 'native-video').length, 2);
});

test('M5E-6：取消的 Round 即使已有主授权也保持零物化', () => {
  const state = fixture();
  const prepared = authorizeRound(state, [roundImageItem(1)], { roundId: 'round-cancel-before-materialize' });
  state.sessionService.cancelGenerationRound(state.session.id, prepared.round.roundId, {
    requestId: 'request-cancel-before-materialize',
    reason: 'fixture cancel'
  });
  assert.throws(
    () => state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
      requestId: 'request-materialize-cancelled-round'
    }),
    error => error?.code === 'GENERATION_ROUND_CANCELLED'
  );
  assert.equal(state.sessionService.loadSession(state.session.id).toolRuns.length, 0);
});

test('M6B2：Prompt 重做确定性写入聊天和单项分支 Round，重放不新增事实', () => {
  const state = fixture();
  const source = attachSucceededSourceImage(state);
  const input = {
    requestId: 'request-branch-redo-image',
    sourceNodeId: source.nodeId,
    prompt: '保留主体一致性，改为雨夜电影光影'
  };
  const beforeToolRuns = state.sessionService.loadSession(state.session.id).toolRuns.length;
  const result = state.service.prepareBranchRedo(state.session.id, input);
  const item = result.generationRound.items[0];

  assert.equal(result.generationRound.mode, 'manual');
  assert.equal(result.generationRound.status, 'awaiting-approval');
  assert.equal(item.kind, 'image');
  assert.equal(item.prompt, input.prompt);
  assert.equal(item.provider, DEFAULTS.imageProviderId);
  assert.equal(item.model, DEFAULTS.imageModel);
  assert.deepEqual(item.spec, { ratio: DEFAULTS.imageRatio, resolution: DEFAULTS.imageResolution.toLowerCase() });
  assert.equal(item.parentNodeRef, source.nodeId);
  assert.equal(item.branchRootRef, source.nodeId);
  assert.equal(item.supersedesRef, source.nodeId);
  assert.equal(result.userMessage.content, input.prompt);
  assert.equal(result.userMessage.attachments[0].assetId, source.nodeId);
  assert.equal(result.message.attachments[0].assetId, result.generationRound.roundId);
  assert.equal(state.service.verifyGenerationRoundQuote({ session: result.session, round: result.generationRound }).estimatedCost, 0.014);
  assert.equal(result.session.toolRuns.length, beforeToolRuns, '准备分支不能预造 ToolRun 或节点身份');

  const replay = state.service.prepareBranchRedo(state.session.id, input);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.generationRound.roundId, result.generationRound.roundId);
  assert.equal(replay.session.generationRounds.length, 1);
  assert.equal(replay.session.messages.length, result.session.messages.length);
  assert.throws(
    () => state.service.prepareBranchRedo(state.session.id, { ...input, prompt: '同一 requestId 漂移后的 Prompt' }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT'
  );

  const automatic = fixture({ defaults: { autoGenerateMedia: true } });
  const automaticSource = attachSucceededSourceImage(automatic);
  const automaticResult = automatic.service.prepareBranchRedo(automatic.session.id, {
    requestId: 'request-branch-redo-automatic',
    sourceNodeId: automaticSource.nodeId,
    prompt: '自动模式重做'
  });
  assert.equal(automaticResult.generationRound.mode, 'automatic');
  assert.equal(automaticResult.session.toolRuns.length, 1, '自动模式也不能在准备阶段绕过整轮授权');
});

test('M6B2：图片重做物化为新节点身份，旧节点保留并进入不可变 inputRefs', () => {
  const state = fixture();
  const source = attachSucceededSourceImage(state);
  const prepared = authorizeRound(state, [roundImageItem(1, {
    parentNodeRef: source.nodeId,
    branchRootRef: source.nodeId,
    supersedesRef: source.nodeId
  })], { roundId: 'round-branch-image' });
  const result = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-branch-image'
  });
  const execution = result.readyExecutions[0];
  const toolRun = result.session.toolRuns.find(item => item.id === execution.toolRunId);

  assert.notEqual(execution.nodeId, source.nodeId);
  assert.equal(execution.parentNodeRef, source.nodeId);
  assert.equal(execution.branchRootRef, source.nodeId);
  assert.equal(execution.supersedesRef, source.nodeId);
  assert.equal(execution.sourceNodeId, '', '图片分支血缘不能冒充视频首帧');
  assert.ok(toolRun.inputRefs.some(ref => ref.refId === source.nodeId));
  assert.ok(result.session.currentNodeRefs.some(ref => ref.nodeId === source.nodeId), '旧节点必须继续留在当前工作集');
  assert.equal(result.session.currentNodeRefs.some(ref => ref.nodeId === execution.nodeId), false, '新节点由 Bridge 建立 placeholder，不在服务端伪造');
});

test('M6B2：视频重做复用已核验首帧，但分支父节点仍是旧视频', () => {
  const state = fixture();
  const image = attachSucceededSourceImage(state);
  const reference = sourceImageReference(state, image);
  const video = attachTerminalSourceVideo(state, { reference, branchRootRef: 'node-video-branch-root' });
  const prepared = authorizeRound(state, [roundVideoItem(1, 'unused', {
    dependsOn: [],
    parentNodeRef: video.nodeId,
    branchRootRef: 'node-video-branch-root',
    supersedesRef: video.nodeId
  })], { roundId: 'round-branch-video' });
  const result = state.service.materializeGenerationRoundReadyItems(state.session.id, prepared.round.roundId, {
    requestId: 'request-materialize-branch-video'
  });
  const execution = result.readyExecutions[0];

  assert.equal(execution.sourceNodeId, image.nodeId);
  assert.equal(execution.parentNodeRef, video.nodeId);
  assert.equal(execution.supersedesRef, video.nodeId);
  assert.equal(execution.branchRootRef, 'node-video-branch-root');
  assert.deepEqual(execution.taskPayload.images, [reference]);
  assert.ok(execution.inputRefs.some(ref => ref.refId === video.nodeId));
  assert.ok(execution.inputRefs.some(ref => ref.refId === image.nodeId));
});

test('M6B2：源节点未终态或分支根漂移时在 ToolRun 物化前失败关闭', () => {
  const pending = fixture();
  const pendingSource = attachSucceededSourceImage(pending, { status: 'remote-unknown', nodeStatus: 'waiting' });
  assert.throws(
    () => pending.service.prepareBranchRedo(pending.session.id, {
      requestId: 'request-branch-redo-pending',
      sourceNodeId: pendingSource.nodeId,
      prompt: '不应被接受'
    }),
    error => error?.code === 'AGENT_MEDIA_BRANCH_SOURCE_INVALID'
  );
  assert.equal(pending.sessionService.loadSession(pending.session.id).generationRounds.length, 0);

  const drifted = fixture();
  const source = attachSucceededSourceImage(drifted);
  const prepared = authorizeRound(drifted, [roundImageItem(1, {
    parentNodeRef: source.nodeId,
    branchRootRef: source.nodeId,
    supersedesRef: source.nodeId
  })], { roundId: 'round-branch-drift' });
  drifted.sessionService.attachCurrentNode(drifted.session.id, source.nodeId, {
    requestId: 'request-change-branch-root',
    workspaceScope: 'canvas-agent',
    kind: 'image',
    toolRunId: source.toolRunId,
    branchRootRef: 'node-other-root'
  });
  const toolRunsBefore = drifted.sessionService.loadSession(drifted.session.id).toolRuns.length;
  assert.throws(
    () => drifted.service.materializeGenerationRoundReadyItems(drifted.session.id, prepared.round.roundId, {
      requestId: 'request-materialize-drifted-branch'
    }),
    error => error?.code === 'AGENT_MEDIA_BRANCH_SOURCE_CONFLICT'
  );
  assert.equal(drifted.sessionService.loadSession(drifted.session.id).toolRuns.length, toolRunsBefore);
});
