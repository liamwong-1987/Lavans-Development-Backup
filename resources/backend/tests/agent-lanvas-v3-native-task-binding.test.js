'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const repoRoot = path.resolve(__dirname, '../../..');
const bindingPath = path.join(repoRoot, 'resources/backend/services/agentNativeTaskBinding.js');
const routesPath = path.join(repoRoot, 'resources/backend/routes/canvasRoutes.js');

const ROUTE_EXECUTION_PAYLOADS = Object.freeze({
  image: Object.freeze({
    type: 'generator',
    prompt: '无费用图片占位测试',
    size: '1024x1024',
    assets: Object.freeze([])
  }),
  video: Object.freeze({
    prompt: '无费用视频提交测试',
    aspect_ratio: '9:16',
    duration: 15,
    resolution: '',
    images: Object.freeze([])
  }),
  audio: Object.freeze({
    input: '你好，Lavans。',
    voice: 'alloy',
    response_format: 'wav',
    speed: 1
  })
});

const BASE_INPUT = Object.freeze({
  workspaceScope: 'canvas-agent',
  agentSessionId: 'agent-session-1',
  toolRunId: 'tool-video-1',
  nodeId: 'node-video-1',
  operationId: 'operation-video-1',
  inputHash: 'd'.repeat(64),
  provider: 'fixture-provider',
  model: 'fixture-video-model',
  taskKind: 'video',
  authorizationId: 'auth-video-1',
  inputVersionIds: Object.freeze(['artifact-video-1']),
  quantity: 1,
  estimatedCost: 4,
  approvedBudget: 4,
  retryBudget: 0,
  currency: 'CNY',
  inputRefs: Object.freeze([
    Object.freeze({ refId: 'node-source-1', workspaceScope: 'canvas' }),
    Object.freeze({ refId: 'node-source-2', workspaceScope: 'canvas-agent' })
  ]),
  allowFallback: false
});

const ROUND_INPUT = Object.freeze({
  ...BASE_INPUT,
  roundId: 'round-video-1',
  itemId: 'item-video-1',
  stageId: 'stage-video-1',
  planRevision: 3,
  planHash: 'c'.repeat(64),
  parentAuthorizationId: 'auth-round-master-1'
});

function loadBindingModule() {
  assert.ok(fs.existsSync(bindingPath), '尚未建立 Agent 原生任务绑定模块');
  return require(bindingPath);
}

function hasCode(code, statusCode = 400) {
  return error => error?.code === code && error?.statusCode === statusCode;
}

function assertM2BSourceInstalled() {
  const source = fs.readFileSync(routesPath, 'utf8');
  assert.match(source, /require\(['"]\.\.\/services\/agentNativeTaskBinding['"]\)/, '路由尚未接入 M2A 绑定合同');
  assert.match(source, /agentBinding:\s*task\.agentBinding/, 'task journal 尚未保存 Agent 绑定');
  assert.match(source, /routeOptions\.canvasVideoFetch/, '视频路由尚无可隔离的无网络测试入口');
  return source;
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

async function postJson(baseUrl, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function fixtureCanvasConfig() {
  return {
    primaryProviderId: 'fixture-provider',
    providers: [{
      id: 'fixture-provider',
      name: 'Fixture Provider',
      enabled: true,
      protocol: 'apimart',
      api_key: 'fixture-key-never-sent',
      base_url: 'https://fixture.invalid',
      image_models: ['fixture-image-model'],
      video_models: ['fixture-video-model'],
      audio_models: ['gpt-4o-mini-tts']
    }]
  };
}

function agentInput(taskKind, overrides = {}) {
  const { executionPayload = ROUTE_EXECUTION_PAYLOADS[taskKind], ...bindingOverrides } = overrides;
  const inputRefs = [{ refId: 'node-source-route-1', workspaceScope: 'canvas' }];
  const { hashAgentNativeExecutionPayload } = require(bindingPath);
  return {
    workspaceScope: 'canvas-agent',
    agentSessionId: 'agent-session-route-1',
    toolRunId: `tool-${taskKind}-route-1`,
    nodeId: `node-${taskKind}-route-1`,
    operationId: `operation-${taskKind}-route-1`,
    inputHash: hashAgentNativeExecutionPayload(taskKind, executionPayload, inputRefs),
    provider: 'fixture-provider',
    model: `fixture-${taskKind}-model`,
    taskKind,
    authorizationId: `auth-${taskKind}-route-1`,
    inputVersionIds: [`artifact-${taskKind}-route-1`],
    quantity: 1,
    estimatedCost: 4,
    approvedBudget: 4,
    retryBudget: 0,
    currency: 'CNY',
    inputRefs,
    allowFallback: false,
    ...bindingOverrides
  };
}

function authorizedRuntime(input, options = {}) {
  const roundIdentity = input.parentAuthorizationId ? {
    roundId: input.roundId,
    itemId: input.itemId,
    stageId: input.stageId,
    planRevision: input.planRevision,
    planHash: input.planHash,
    parentAuthorizationId: input.parentAuthorizationId
  } : {};
  const request = {
    operationId: input.operationId,
    provider: input.provider,
    model: input.model,
    inputVersionIds: [...input.inputVersionIds],
    quantity: input.quantity,
    estimatedCost: input.estimatedCost,
    budgetLimit: input.approvedBudget,
    currency: input.currency,
    retryLimit: input.retryBudget,
    executionMode: 'manual',
    allowFallback: false,
    fallbackProvider: '',
    fallbackModel: '',
    reviewGateId: `agent-session:${input.agentSessionId}:${input.toolRunId}`,
    highPriceThreshold: null,
    highPriceConfirmed: false,
    agentSessionId: input.agentSessionId,
    toolRunId: input.toolRunId,
    nodeId: input.nodeId,
    taskKind: input.taskKind,
    inputHash: input.inputHash,
    ...roundIdentity
  };
  const authorization = {
    source: 'execution-guard',
    allowed: true,
    authorizationId: input.authorizationId,
    signature: (input.taskKind === 'image' ? 'a' : 'b').repeat(64),
    authorizedBy: 'fixture-user',
    authorizedAt: 100,
    consumedAt: 200,
    request
  };
  const session = {
    id: input.agentSessionId,
    workspaceScope: 'canvas-agent',
    executionAuthorizations: [authorization],
    toolRuns: [{
      id: input.toolRunId,
      type: `native-${input.taskKind}`,
      status: options.toolRunStatus || 'submitting',
      nodeId: input.nodeId,
      provider: input.provider,
      model: input.model,
      operationId: input.operationId,
      inputVersion: input.inputVersionIds[0],
      inputHash: input.inputHash,
      quantity: input.quantity,
      estimatedCost: input.estimatedCost,
      approvedBudget: input.approvedBudget,
      retryBudget: input.retryBudget,
      authorizationId: input.authorizationId,
      authorizationState: 'consumed'
    }]
  };
  let guardCalls = 0;
  const verifyAgentCostQuote = ({ binding, inputHash }) => ({
    verified: true,
    source: 'server-price-catalog',
    provider: binding.provider,
    model: binding.model,
    taskKind: binding.taskKind,
    inputHash,
    quantity: binding.quantity,
    estimatedCost: options.quotedEstimatedCost ?? binding.estimatedCost,
    currency: binding.currency
  });
  return {
    sessionService: { loadSession: id => id === session.id ? session : null },
    foundation: {
      executionGuard: {
        assertConsumed(payload) {
          guardCalls += 1;
          if (guardCalls === options.failOnGuardCall) {
            const error = new Error('fixture authorization became stale');
            error.statusCode = 409;
            error.code = 'FIXTURE_AUTHORIZATION_STALE';
            throw error;
          }
          assert.equal(payload.authorizationId, authorization.authorizationId);
          const { authorizationId: _authorizationId, ...suppliedRequest } = payload;
          if (!Object.prototype.hasOwnProperty.call(suppliedRequest, 'highPriceThreshold')) suppliedRequest.highPriceThreshold = null;
          assert.deepEqual(suppliedRequest, authorization.request);
          return authorization;
        }
      }
    },
    verifyAgentCostQuote,
    get guardCalls() { return guardCalls; }
  };
}

test('M2A：同 operationId 与同载荷返回同一纯状态绑定', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  const inputBefore = JSON.stringify(BASE_INPUT);
  const first = resolveAgentNativeTaskBinding(null, BASE_INPUT, { clock: () => 100 });
  assert.equal(first.created, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.binding.schemaVersion, 2);
  assert.equal(first.binding.workspaceScope, 'canvas-agent');
  assert.equal(first.binding.agentSessionId, 'agent-session-1');
  assert.equal(first.binding.toolRunId, 'tool-video-1');
  assert.equal(first.binding.nodeId, 'node-video-1');
  assert.equal(first.binding.operationId, 'operation-video-1');
  assert.equal(first.binding.inputHash, BASE_INPUT.inputHash);
  assert.equal(first.binding.provider, 'fixture-provider');
  assert.equal(first.binding.model, 'fixture-video-model');
  assert.equal(first.binding.authorizationId, BASE_INPUT.authorizationId);
  assert.deepEqual(first.binding.inputVersionIds, BASE_INPUT.inputVersionIds);
  assert.equal(first.binding.allowFallback, false);
  assert.equal(first.binding.status, 'reserved');
  assert.equal(first.binding.requestHash.length, 64);
  assert.equal(first.binding.createdAt, 100);

  const replay = resolveAgentNativeTaskBinding(first.binding, BASE_INPUT, { clock: () => 999 });
  assert.equal(replay.created, false);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.binding, first.binding);
  assert.equal(JSON.stringify(BASE_INPUT), inputBefore, '纯函数不得修改调用方输入');
});

test('M2A：同 operationId 的不同输入或 Provider/模型漂移返回 409', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  const first = resolveAgentNativeTaskBinding(null, BASE_INPUT, { clock: () => 100 }).binding;

  assert.throws(
    () => resolveAgentNativeTaskBinding(first, { ...BASE_INPUT, inputHash: 'e'.repeat(64) }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(first, { ...BASE_INPUT, provider: 'another-provider' }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(first, { ...BASE_INPUT, model: 'another-model' }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(first, { ...BASE_INPUT, authorizationId: 'auth-video-2' }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
});

test('M5E-7：完整 Round 身份进入不可变 requestHash，同身份可以幂等重放', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  const legacy = resolveAgentNativeTaskBinding(null, BASE_INPUT, { clock: () => 100 }).binding;
  const first = resolveAgentNativeTaskBinding(null, ROUND_INPUT, { clock: () => 100 }).binding;

  assert.equal(legacy.requestHash, 'b20aed24e0be9754ef4b5144396477f2200b3a2618d76914326f85b5fe7f3b2f');
  assert.notEqual(first.requestHash, legacy.requestHash);
  for (const field of ['roundId', 'itemId', 'stageId', 'planRevision', 'planHash', 'parentAuthorizationId']) {
    assert.equal(first[field], ROUND_INPUT[field]);
  }

  const replay = resolveAgentNativeTaskBinding(first, ROUND_INPUT, { clock: () => 999 });
  assert.equal(replay.created, false);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.binding, first);
});

test('M5E-7：相同 operationId 不得跨 Round、条目、阶段、计划或主授权重用', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  const first = resolveAgentNativeTaskBinding(null, ROUND_INPUT).binding;
  const drifts = [
    { roundId: 'round-video-2' },
    { itemId: 'item-video-2' },
    { stageId: 'stage-video-2' },
    { planRevision: ROUND_INPUT.planRevision + 1 },
    { planHash: 'e'.repeat(64) },
    { parentAuthorizationId: 'auth-round-master-2' }
  ];

  for (const drift of drifts) {
    assert.throws(
      () => resolveAgentNativeTaskBinding(first, { ...ROUND_INPUT, ...drift }),
      hasCode('IDEMPOTENCY_CONFLICT', 409)
    );
  }
});

test('M5E-7：Round 身份必须六项齐全，legacy 绑定不能冒充 Round 绑定', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, { ...BASE_INPUT, roundId: ROUND_INPUT.roundId }),
    hasCode('INCOMPLETE_ROUND_IDENTITY')
  );
  const { parentAuthorizationId: _missingParent, ...missingParent } = ROUND_INPUT;
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, missingParent),
    hasCode('INCOMPLETE_ROUND_IDENTITY')
  );

  const legacy = resolveAgentNativeTaskBinding(null, BASE_INPUT).binding;
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'roundId'), false);
  assert.throws(
    () => resolveAgentNativeTaskBinding(legacy, ROUND_INPUT),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
  const round = resolveAgentNativeTaskBinding(null, ROUND_INPUT).binding;
  assert.throws(
    () => resolveAgentNativeTaskBinding(round, BASE_INPUT),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
});

test('M5E-8A：Round 六项身份必须穿过图片路由并进入 task journal', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m5e8a-round-route-'));
  const input = agentInput('image', {
    roundId: 'round-image-route-1',
    itemId: 'item-image-route-1',
    stageId: 'stage-image-route-1',
    planRevision: 2,
    planHash: '9'.repeat(64),
    parentAuthorizationId: 'auth-round-master-route-1',
    inputVersionIds: ['artifact-plan-route-1', 'artifact-image-route-1']
  });
  const runtime = authorizedRuntime(input);
  let executionCount = 0;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: () => { executionCount += 1; return new Promise(() => {}); },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });
  const requestBody = {
    ...ROUTE_EXECUTION_PAYLOADS.image,
    providerId: input.provider,
    model: input.model,
    agentTask: input
  };

  await withServer(router, async baseUrl => {
    const forgedResponse = await postJson(baseUrl, '/api/canvas/tasks', {
      ...requestBody,
      agentTask: {...input, itemId: 'item-image-route-forged'}
    });
    assert.equal(forgedResponse.status, 409);
    assert.equal((await forgedResponse.json()).code, 'EXECUTION_AUTHORIZATION_BINDING_CONFLICT');
    assert.equal(executionCount, 0);

    const response = await postJson(baseUrl, '/api/canvas/tasks', requestBody);
    assert.equal(response.status, 202);
    const first = await response.json();
    for (const field of ['roundId', 'itemId', 'stageId', 'planRevision', 'planHash', 'parentAuthorizationId']) {
      assert.equal(first.task.agentBinding[field], input[field]);
    }
    const replayResponse = await postJson(baseUrl, '/api/canvas/tasks', requestBody);
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json()).idempotent, true);
    assert.equal(executionCount, 1);
  });

  const journal = JSON.parse(fs.readFileSync(path.join(outputRoot, '.state', 'canvas-task-journal.json'), 'utf8'));
  assert.equal(journal.length, 1);
  for (const field of ['roundId', 'itemId', 'stageId', 'planRevision', 'planHash', 'parentAuthorizationId']) {
    assert.equal(journal[0].agentBinding[field], input[field]);
  }
});

test('M2A：Provider、模型和禁止 fallback 是提交前硬门', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, { ...BASE_INPUT, provider: '' }),
    hasCode('EXPLICIT_PROVIDER_REQUIRED')
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, { ...BASE_INPUT, model: '' }),
    hasCode('EXPLICIT_MODEL_REQUIRED')
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, { ...BASE_INPUT, allowFallback: true }),
    hasCode('FALLBACK_FORBIDDEN')
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, { ...BASE_INPUT, authorizationId: '' }),
    hasCode('INVALID_ID')
  );
});

test('M2E：视频参考图的顺序与角色属于 canonical execution hash', () => {
  const { hashAgentNativeExecutionPayload } = loadBindingModule();
  const images = [
    { url: '/canvas-assets/first.png', referenceIndex: 1, role: 'first_frame' },
    { url: '/canvas-assets/last.png', referenceIndex: 2, role: 'last_frame' }
  ];
  const base = { ...ROUTE_EXECUTION_PAYLOADS.video, images };
  const baseHash = hashAgentNativeExecutionPayload('video', base, []);
  assert.notEqual(
    hashAgentNativeExecutionPayload('video', { ...base, images: [...images].reverse() }, []),
    baseHash
  );
  assert.notEqual(
    hashAgentNativeExecutionPayload('video', { ...base, images: [{ ...images[0], role: 'last_frame' }, images[1]] }, []),
    baseHash
  );
});

test('R3：图片参考素材超过十张时失败关闭，不再静默截断已锁定输入', () => {
  const { normalizeAgentNativeExecutionPayload } = loadBindingModule();
  const assets = Array.from({ length: 11 }, (_unused, index) => ({
    url: `/canvas-output/reference-${index + 1}.png`,
    referenceIndex: index + 1,
    role: 'reference'
  }));
  assert.throws(
    () => normalizeAgentNativeExecutionPayload('image', {
      type: 'generator', prompt: '引用上限验证', size: '1024x1024', assets
    }, []),
    error => error?.code === 'INVALID_EXECUTION_PAYLOAD'
  );
  assert.equal(normalizeAgentNativeExecutionPayload('image', {
    type: 'generator', prompt: '引用上限验证', size: '1024x1024', assets: assets.slice(0, 10)
  }, []).assets.length, 10);
});

test('M2E：伪造或缺失的可信授权在 task journal 和 Provider 之前失败关闭', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2e-forged-auth-'));
  const validInput = agentInput('image');
  const runtime = authorizedRuntime(validInput);
  let executionCount = 0;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: () => { executionCount += 1; return new Promise(() => {}); },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas/tasks', {
      ...ROUTE_EXECUTION_PAYLOADS.image,
      providerId: 'fixture-provider',
      model: 'fixture-image-model',
      agentTask: { ...validInput, authorizationId: 'auth-forged-route-1' }
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'EXECUTION_AUTHORIZATION_MISSING');
    assert.equal(executionCount, 0);

    const drifts = [
      { prompt: '已在授权后被替换的图片 Prompt' },
      { size: '1536x1024' },
      { assets: [{ url: 'https://example.invalid/reference.png', role: 'reference' }] }
    ];
    for (const drift of drifts) {
      const payloadDrift = await postJson(baseUrl, '/api/canvas/tasks', {
        ...ROUTE_EXECUTION_PAYLOADS.image,
        ...drift,
        providerId: 'fixture-provider',
        model: 'fixture-image-model',
        agentTask: validInput
      });
      assert.equal(payloadDrift.status, 409);
      assert.equal((await payloadDrift.json()).code, 'EXECUTION_PAYLOAD_HASH_CONFLICT');
    }
    assert.equal(executionCount, 0, '实际图片载荷漂移不得进入执行器');

    const unavailableQuote = await postJson(baseUrl, '/api/canvas/tasks', {
      ...ROUTE_EXECUTION_PAYLOADS.image,
      agentTask: validInput
    });
    assert.equal(unavailableQuote.status, 503);
    assert.equal((await unavailableQuote.json()).code, 'AGENT_COST_QUOTE_UNAVAILABLE');
    assert.equal(executionCount, 0, '没有服务端权威估价时不得进入执行器');
  });
  const journalPath = path.join(outputRoot, '.state', 'canvas-task-journal.json');
  const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : [];
  assert.equal(journal.length, 0, '伪造授权不得留下可执行任务');
});

test('M2E：服务端权威估价与批准金额冲突时在 journal 和 Provider 前失败关闭', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2e-cost-conflict-'));
  const input = agentInput('image');
  const runtime = authorizedRuntime(input, { quotedEstimatedCost: input.estimatedCost + 1 });
  let executionCount = 0;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: () => { executionCount += 1; return new Promise(() => {}); },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas/tasks', {
      ...ROUTE_EXECUTION_PAYLOADS.image,
      agentTask: input
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'AGENT_COST_QUOTE_CONFLICT');
    assert.equal(executionCount, 0);
  });
  assert.equal(fs.existsSync(path.join(outputRoot, '.state', 'canvas-task-journal.json')), false);
});

test('M2E：图片 Provider 前二次核验失败时保留失败任务但绝不执行', async () => {
  const canvasRoutes = require(routesPath);
  const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2e-double-check-'));
  const outputRoot = path.join(isolationRoot, 'canvas');
  const recolorRoot = path.join(isolationRoot, 'recolor');
  const recolorStatePath = path.join(recolorRoot, 'batch.json');
  fs.mkdirSync(recolorRoot, { recursive: true });
  fs.writeFileSync(recolorStatePath, '{"feature":"recolor","assets":["isolated-material"]}\n', 'utf8');
  const recolorStateBefore = fs.readFileSync(recolorStatePath);
  const executionPayload = { ...ROUTE_EXECUTION_PAYLOADS.image, prompt: '二次核验失败测试' };
  const input = agentInput('image', { executionPayload });
  const runtime = authorizedRuntime(input, { failOnGuardCall: 2 });
  let executionCount = 0;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: () => { executionCount += 1; return new Promise(() => {}); },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas/tasks', {
      type: 'generator',
      providerId: 'fixture-provider',
      model: 'fixture-image-model',
      prompt: '二次核验失败测试',
      agentTask: input
    });
    assert.equal(response.status, 202);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executionCount, 0);
  });
  const journal = JSON.parse(fs.readFileSync(path.join(outputRoot, '.state', 'canvas-task-journal.json'), 'utf8'));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].status, 'failed');
  assert.equal(journal[0].agentBinding.status, 'failed');
  assert.deepEqual(fs.readFileSync(recolorStatePath), recolorStateBefore, 'Agent 图片生命周期不得改写一键复色数据');
});

test('M2E：视频 Provider 前二次核验失败时 fetch 为零且不遗留超时等待', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2e-video-double-check-'));
  const input = agentInput('video');
  const runtime = authorizedRuntime(input, { failOnGuardCall: 2 });
  let fetchCount = 0;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    canvasVideoFetch: async () => {
      fetchCount += 1;
      throw new Error('不应进入视频 Provider');
    },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas-video', {
      ...ROUTE_EXECUTION_PAYLOADS.video,
      provider_id: 'fixture-provider',
      model: 'fixture-video-model',
      agentTask: input
    });
    assert.equal(response.status, 409);
    assert.equal(fetchCount, 0);
  });
  const journal = JSON.parse(fs.readFileSync(path.join(outputRoot, '.state', 'canvas-task-journal.json'), 'utf8'));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].status, 'failed');
  assert.equal(journal[0].agentBinding.status, 'failed');
});

test('M2A：绑定拒绝 recolor，输入引用只接受 canvas 或 canvas-agent', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, { ...BASE_INPUT, workspaceScope: 'recolor' }),
    hasCode('INVALID_WORKSPACE_SCOPE')
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(null, {
      ...BASE_INPUT,
      inputRefs: [{ refId: 'recolor-asset-1', workspaceScope: 'recolor' }]
    }),
    hasCode('INVALID_INPUT_SCOPE')
  );

  const accepted = resolveAgentNativeTaskBinding(null, BASE_INPUT).binding;
  assert.deepEqual(accepted.inputRefs.map(item => item.workspaceScope), ['canvas', 'canvas-agent']);
});

test('M2A：本地与远端 taskId 只可补写或重放，不可换绑', () => {
  const { resolveAgentNativeTaskBinding } = loadBindingModule();
  const reserved = resolveAgentNativeTaskBinding(null, BASE_INPUT, { clock: () => 100 }).binding;
  const attachedInput = {
    ...BASE_INPUT,
    taskId: 'canvas-task-1',
    remoteTaskId: 'remote-task-1',
    status: 'running'
  };
  const attached = resolveAgentNativeTaskBinding(reserved, attachedInput, { clock: () => 200 });
  assert.equal(attached.created, false);
  assert.equal(attached.idempotent, false);
  assert.equal(attached.binding.taskId, 'canvas-task-1');
  assert.equal(attached.binding.remoteTaskId, 'remote-task-1');
  assert.equal(attached.binding.status, 'running');
  assert.equal(attached.binding.updatedAt, 200);

  const replay = resolveAgentNativeTaskBinding(attached.binding, attachedInput, { clock: () => 300 });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.binding, attached.binding);
  assert.throws(
    () => resolveAgentNativeTaskBinding(attached.binding, { ...attachedInput, taskId: 'canvas-task-2' }),
    hasCode('TASK_BINDING_CONFLICT', 409)
  );
  assert.throws(
    () => resolveAgentNativeTaskBinding(attached.binding, { ...attachedInput, remoteTaskId: 'remote-task-2' }),
    hasCode('REMOTE_TASK_BINDING_CONFLICT', 409)
  );
});

test('M2A：状态模块没有网络、Provider 执行或文件写入入口', () => {
  loadBindingModule();
  const source = fs.readFileSync(bindingPath, 'utf8');
  assert.doesNotMatch(
    source,
    /\bfetch\s*\(|require\(['"]node:(?:https?|fs)['"]\)|providerExecutor|generate(?:Image|Video|Audio)|atomicWriteJson/,
    'M2A 只能规范化和核对绑定，不能提交任务或落盘'
  );
});

test('M2B：Agent 图片 POST 先写 task journal，同 operationId 重放不再次执行', async () => {
  assertM2BSourceInstalled();
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2b-image-'));
  let executionCount = 0;
  const neverSettles = () => {
    executionCount += 1;
    return new Promise(() => {});
  };
  const requestBody = {
    type: 'generator',
    providerId: 'fixture-provider',
    model: 'fixture-image-model',
    prompt: '无费用图片占位测试',
    size: '1024x1024',
    agentTask: agentInput('image')
  };
  const runtime = authorizedRuntime(requestBody.agentTask);

  const firstRouter = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: neverSettles,
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });
  let firstTaskId = '';
  await withServer(firstRouter, async baseUrl => {
    const firstResponse = await postJson(baseUrl, '/api/canvas/tasks', requestBody);
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json();
    firstTaskId = first.task.id;
    assert.equal(first.idempotent, false);
    assert.equal(first.task.agentBinding.operationId, requestBody.agentTask.operationId);
    assert.equal(first.task.agentBinding.taskId, firstTaskId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executionCount, 1);

    const replayResponse = await postJson(baseUrl, '/api/canvas/tasks', requestBody);
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent, true);
    assert.equal(replay.task.id, firstTaskId);
    assert.equal(executionCount, 1, '幂等重放不得第二次进入图片执行器');

    const conflictResponse = await postJson(baseUrl, '/api/canvas/tasks', {
      ...requestBody,
      agentTask: { ...requestBody.agentTask, inputHash: '3'.repeat(64) }
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, 'IDEMPOTENCY_CONFLICT');

    const missingProviderResponse = await postJson(baseUrl, '/api/canvas/tasks', {
      ...requestBody,
      providerId: 'deleted-provider',
      agentTask: agentInput('image', {
        operationId: 'operation-image-missing-provider',
        inputHash: '4'.repeat(64),
        provider: 'deleted-provider'
      })
    });
    assert.equal(missingProviderResponse.status, 409);
    assert.equal(executionCount, 1, 'Provider 不存在时不得进入图片执行器');
  });

  const journalPath = path.join(outputRoot, '.state', 'canvas-task-journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].agentBinding.operationId, requestBody.agentTask.operationId);
  assert.equal(journal[0].agentBinding.taskId, firstTaskId);

  let restartedExecutionCount = 0;
  const restartedRouter = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: () => {
      restartedExecutionCount += 1;
      return new Promise(() => {});
    },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    agentRunService: {}
  });
  await withServer(restartedRouter, async baseUrl => {
    const replayResponse = await postJson(baseUrl, '/api/canvas/tasks', requestBody);
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent, true);
    assert.equal(replay.task.id, firstTaskId);
    assert.equal(replay.task.agentBinding.status, 'remote-unknown');
    assert.equal(restartedExecutionCount, 0, '重启恢复在估价器缺失时仍只能返回原任务，不能重新执行');
  });

  let replayQuoteCalls = 0;
  const conflictingQuoteRouter = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: () => {
      restartedExecutionCount += 1;
      return new Promise(() => {});
    },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: () => {
      replayQuoteCalls += 1;
      return { verified: false, source: 'server-price-catalog' };
    },
    agentRunService: {}
  });
  await withServer(conflictingQuoteRouter, async baseUrl => {
    const replayResponse = await postJson(baseUrl, '/api/canvas/tasks', requestBody);
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json()).idempotent, true);
    assert.equal(replayQuoteCalls, 0, '既有任务恢复不得因当前报价变化重新估价或重发');
    assert.equal(restartedExecutionCount, 0);
  });
});

test('M2B：Agent 视频 POST 使用严格 Provider/模型并把远端 ID 回写同一绑定', async () => {
  assertM2BSourceInstalled();
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2b-video-'));
  let fetchCount = 0;
  const fakeVideoFetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { task_id: 'remote-video-route-1' } })
    };
  };
  const requestBody = {
    provider_id: 'fixture-provider',
    model: 'fixture-video-model',
    prompt: '无费用视频提交测试',
    aspect_ratio: '9:16',
    duration: 15,
    images: [],
    agentTask: agentInput('video')
  };
  const runtime = authorizedRuntime(requestBody.agentTask);
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    canvasVideoFetch: fakeVideoFetch,
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });

  await withServer(router, async baseUrl => {
    const drifts = [
      { prompt: '已在授权后被替换的视频 Prompt' },
      { duration: 30 },
      { resolution: '1080p' },
      { aspect_ratio: '16:9' },
      { images: [{ url: 'https://example.invalid/frame.png', referenceIndex: 1, role: 'first_frame' }] }
    ];
    for (const drift of drifts) {
      const payloadDriftResponse = await postJson(baseUrl, '/api/canvas-video', {
        ...requestBody,
        ...drift
      });
      assert.equal(payloadDriftResponse.status, 409);
      assert.equal((await payloadDriftResponse.json()).code, 'EXECUTION_PAYLOAD_HASH_CONFLICT');
    }
    assert.equal(fetchCount, 0, '实际视频载荷漂移不得请求 Provider');

    const firstResponse = await postJson(baseUrl, '/api/canvas-video', requestBody);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.task_id, 'remote-video-route-1');
    assert.ok(first.local_task_id);
    assert.equal(first.agent_binding.taskId, first.local_task_id);
    assert.equal(first.agent_binding.remoteTaskId, 'remote-video-route-1');
    assert.equal(first.idempotent, false);
    assert.equal(fetchCount, 1);

    const replayResponse = await postJson(baseUrl, '/api/canvas-video', requestBody);
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent, true);
    assert.equal(replay.task_id, 'remote-video-route-1');
    assert.equal(replay.local_task_id, first.local_task_id);
    assert.equal(fetchCount, 1, '幂等重放不得第二次请求视频 Provider');

    const conflictResponse = await postJson(baseUrl, '/api/canvas-video', {
      ...requestBody,
      agentTask: { ...requestBody.agentTask, model: 'changed-model' }
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(fetchCount, 1);
  });

  const journal = JSON.parse(fs.readFileSync(path.join(outputRoot, '.state', 'canvas-task-journal.json'), 'utf8'));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].agentBinding.remoteTaskId, 'remote-video-route-1');
});

test('M6：Agent 音频 POST 只执行一次已授权 TTS，并把流式 WAV 长度修正后原子落盘', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m6-audio-'));
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(0xffffffff, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(0xffffffff, 40);
  wav.writeInt16LE(123, 44);
  wav.writeInt16LE(-123, 46);
  let fetchCount = 0;
  let upstreamBody = null;
  const fakeAudioFetch = async (_url, options) => {
    fetchCount += 1;
    upstreamBody = JSON.parse(options.body);
    return { ok: true, status: 200, arrayBuffer: async () => wav };
  };
  const agentTask = agentInput('audio', {
    model: 'gpt-4o-mini-tts',
    executionPayload: ROUTE_EXECUTION_PAYLOADS.audio
  });
  const runtime = authorizedRuntime(agentTask);
  const requestBody = {
    provider_id: 'fixture-provider',
    model: 'gpt-4o-mini-tts',
    ...ROUTE_EXECUTION_PAYLOADS.audio,
    agentTask
  };
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    canvasAudioFetch: fakeAudioFetch,
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const drift = await postJson(baseUrl, '/api/canvas-audio-tasks', { ...requestBody, voice: 'nova' });
    assert.equal(drift.status, 409);
    assert.equal(fetchCount, 0);

    const response = await postJson(baseUrl, '/api/canvas-audio-tasks', requestBody);
    assert.equal(response.status, 200);
    const first = await response.json();
    assert.equal(first.status, 'succeeded');
    assert.equal(first.idempotent, false);
    assert.ok(first.local_task_id);
    assert.equal(first.audios.length, 1);
    assert.equal(fetchCount, 1);
    assert.deepEqual(upstreamBody, { model: 'gpt-4o-mini-tts', input: '你好，Lavans。', voice: 'alloy', response_format: 'wav', speed: 1 });
    const savedWav = fs.readFileSync(path.join(outputRoot, path.basename(decodeURIComponent(first.audios[0].url))));
    assert.equal(savedWav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(savedWav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(savedWav.readUInt32LE(4), 40);
    assert.equal(savedWav.readUInt32LE(40), 4);

    const replay = await postJson(baseUrl, '/api/canvas-audio-tasks', requestBody);
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.idempotent, true);
    assert.equal(replayBody.local_task_id, first.local_task_id);
    assert.equal(fetchCount, 1);
  });
});

test('M6：已收到的无效音频响应明确失败，不伪装为 remote-unknown，也不自动重试', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m6-audio-invalid-'));
  let fetchCount = 0;
  const agentTask = agentInput('audio', {
    model: 'gpt-4o-mini-tts',
    executionPayload: ROUTE_EXECUTION_PAYLOADS.audio
  });
  const runtime = authorizedRuntime(agentTask);
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    canvasAudioFetch: async () => {
      fetchCount += 1;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('not-a-wav') };
    },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas-audio-tasks', {
      provider_id: 'fixture-provider',
      model: 'gpt-4o-mini-tts',
      ...ROUTE_EXECUTION_PAYLOADS.audio,
      agentTask
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, 'AGENT_AUDIO_RESULT_INVALID');
    assert.ok(body.local_task_id);
    const query = await fetch(`${baseUrl}/api/canvas-audio-tasks/${encodeURIComponent(body.local_task_id)}`);
    const queried = await query.json();
    assert.equal(queried.status, 'failed');
    assert.equal(queried.agent_binding.status, 'failed');
    assert.equal(fetchCount, 1);
  });
});

test('M5C：本地参考图只上传一次并以 first_frame 提交给 Seedance 2.0', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m5c-reference-video-'));
  fs.writeFileSync(path.join(outputRoot, 'source.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const executionPayload = {
    prompt: '让这只猫向前奔跑，镜头平稳跟随',
    aspect_ratio: '9:16',
    duration: 5,
    resolution: '480p',
    images: [{
      referenceId: 'node-source-route-1',
      referenceIndex: 1,
      sourceImageIndex: 0,
      role: 'first_frame',
      url: '/canvas-output/source.png',
      originalName: 'source.png'
    }]
  };
  const input = agentInput('video', { executionPayload, model: 'seedance-2.0' });
  const runtime = authorizedRuntime(input);
  const config = fixtureCanvasConfig();
  config.providers[0].video_models = ['seedance-2.0'];
  let uploadCount = 0;
  let videoSubmitCount = 0;
  let submittedVideoBody = null;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: config,
    canvasImageUploadFetch: async (url, options) => {
      uploadCount += 1;
      assert.match(url, /\/v1\/uploads\/images$/);
      assert.equal(options.method, 'POST');
      assert.ok(Buffer.isBuffer(options.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: 'https://upload.fixture/source.png', bytes: options.body.length })
      };
    },
    canvasVideoFetch: async (_url, options) => {
      videoSubmitCount += 1;
      submittedVideoBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { task_id: 'remote-reference-video-1' } })
      };
    },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });

  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas-video', {
      ...executionPayload,
      provider_id: 'fixture-provider',
      model: 'seedance-2.0',
      agentTask: input
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.task_id, 'remote-reference-video-1');
    assert.equal(uploadCount, 1);
    assert.equal(videoSubmitCount, 1);
    assert.deepEqual(submittedVideoBody, {
      prompt: executionPayload.prompt,
      model: 'seedance-2.0',
      duration: 5,
      resolution: '480p',
      size: '9:16',
      generate_audio: false,
      image_with_roles: [{ url: 'https://upload.fixture/source.png', role: 'first_frame' }]
    });
    assert.deepEqual(body.reference_summary.map(item => ({ referenceId: item.referenceId, role: item.role, urlType: item.urlType })), [{
      referenceId: 'node-source-route-1',
      role: 'first_frame',
      urlType: 'uploaded'
    }]);
  });
});

test('R3：Seedance 2.0 的首帧与语义资产混合引用保持图号顺序，不再把第二张资产误标成尾帧', async () => {
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-r3-reference-chain-'));
  const roles = ['first_frame', 'product', 'storyboard', 'character'];
  const images = roles.map((role, index) => {
    const filename = `reference-${index + 1}.png`;
    fs.writeFileSync(path.join(outputRoot, filename), Buffer.from(`fixture-reference-${index + 1}`));
    return {
      referenceId: `node-reference-${index + 1}`,
      referenceIndex: index + 1,
      sourceImageIndex: 0,
      role,
      url: `/canvas-output/${filename}`,
      originalName: filename
    };
  });
  const executionPayload = {
    prompt: '@图片1 是首帧，@图片2 是产品，@图片3 是分镜，@图片4 是人物',
    aspect_ratio: '9:16',
    duration: 5,
    resolution: '480p',
    images
  };
  const input = agentInput('video', { executionPayload, model: 'seedance-2.0' });
  const runtime = authorizedRuntime(input);
  const config = fixtureCanvasConfig();
  config.providers[0].video_models = ['seedance-2.0'];
  let uploadCount = 0;
  let submittedVideoBody = null;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: config,
    canvasImageUploadFetch: async () => {
      uploadCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: `https://upload.fixture/reference-${uploadCount}.png` })
      };
    },
    canvasVideoFetch: async (_url, options) => {
      submittedVideoBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { task_id: 'remote-r3-reference-chain' } })
      };
    },
    canvasAgentFoundation: runtime.foundation,
    agentSessionService: runtime.sessionService,
    verifyAgentCostQuote: runtime.verifyAgentCostQuote,
    agentRunService: {}
  });

  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas-video', {
      ...executionPayload,
      provider_id: 'fixture-provider',
      model: 'seedance-2.0',
      agentTask: input
    });
    assert.equal(response.status, 200);
    assert.equal(uploadCount, 4);
    assert.deepEqual(submittedVideoBody.image_urls, [
      'https://upload.fixture/reference-1.png',
      'https://upload.fixture/reference-2.png',
      'https://upload.fixture/reference-3.png',
      'https://upload.fixture/reference-4.png'
    ]);
    assert.equal('image_with_roles' in submittedVideoBody, false);
    const body = await response.json();
    assert.deepEqual(body.reference_summary.map(item => ({ referenceIndex: item.referenceIndex, role: item.role })), roles.map((role, index) => ({
      referenceIndex: index + 1,
      role
    })));
  });
});

test('M2B：没有 Agent 元数据的普通画布图片任务保持原默认 Provider 行为', async () => {
  assertM2BSourceInstalled();
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2b-legacy-'));
  let executionCount = 0;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    performCanvasGeneration: () => {
      executionCount += 1;
      return new Promise(() => {});
    },
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas/tasks', {
      type: 'generator',
      prompt: '普通画布兼容测试',
      model: 'fixture-image-model'
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.task.providerId, 'fixture-provider');
    assert.equal('agentBinding' in body.task, false);
    assert.equal('idempotent' in body, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executionCount, 1);
  });
});

test('M2B：没有 Agent 元数据的普通画布视频任务不需要 Session 授权或权威估价器', async () => {
  assertM2BSourceInstalled();
  const canvasRoutes = require(routesPath);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m2b-legacy-video-'));
  let fetchCount = 0;
  const router = canvasRoutes({
    outputRoot,
    canvasConfig: fixtureCanvasConfig(),
    canvasVideoFetch: async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { task_id: 'legacy-video-route-1' } })
      };
    },
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const response = await postJson(baseUrl, '/api/canvas-video', {
      ...ROUTE_EXECUTION_PAYLOADS.video,
      provider_id: 'fixture-provider',
      model: 'fixture-video-model'
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.task_id, 'legacy-video-route-1');
    assert.equal(body.provider_id, 'fixture-provider');
    assert.equal('agent_binding' in body, false);
    assert.equal('local_task_id' in body, false);
    assert.equal(fetchCount, 1);
  });
});
