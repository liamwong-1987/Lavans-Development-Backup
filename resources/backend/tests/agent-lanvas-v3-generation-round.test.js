'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const servicePath = path.join(repoRoot, 'resources/backend/services/agentGenerationRoundService.js');
const source = fs.readFileSync(servicePath, 'utf8');
const sessionServicePath = path.join(repoRoot, 'resources/backend/services/agentSessionService.js');
const sessionSource = fs.readFileSync(sessionServicePath, 'utf8');
const {
  aggregateGenerationStatus,
  assertGenerationPlanIdentity,
  canonicalGenerationPlanHash,
  normalizeGenerationPlan,
  recoverGenerationRoundState,
  selectReadyItems,
  summarizeGenerationCost,
  topologicalSort
} = require(servicePath);
const { createAgentSessionService } = require(sessionServicePath);

function imageItem(index, overrides = {}) {
  return {
    itemId: `image-${index}`,
    stageId: 'images',
    kind: 'image',
    prompt: `生成图片 ${index}`,
    promptVersion: 'prompt-v1',
    provider: 'configured-image-provider',
    model: 'configured-image-model',
    spec: { resolution: '1K', ratio: '9:16' },
    quantity: 1,
    dependsOn: [],
    ...overrides
  };
}

function planWith(items, stages = [{ stageId: 'images', label: '图片资产' }]) {
  return { planRevision: 1, stages, items };
}

function hasCode(code, statusCode = 400) {
  return error => error?.code === code && error?.statusCode === statusCode;
}

test('M5E-2：单图计划被规范为一个稳定且无执行绑定的 item', () => {
  const input = planWith([imageItem(1)]);
  const before = structuredClone(input);
  const normalized = normalizeGenerationPlan(input);

  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].quantity, 1);
  assert.equal(normalized.items[0].status, 'planned');
  assert.deepEqual(normalized.topologicalOrder, ['image-1']);
  assert.match(normalized.planHash, /^[a-f0-9]{64}$/);
  for (const field of ['toolRunId', 'nodeId', 'operationId', 'inputHash', 'remoteTaskId']) {
    assert.equal(Object.hasOwn(normalized.items[0], field), false);
  }
  assert.deepEqual(input, before, '纯规范化不得修改调用者输入');
});

test('M5E-2：十张图展开为十个独立 item 且不存在每消息单任务上限', () => {
  const input = planWith(Array.from({ length: 10 }, (_, index) => imageItem(index + 1)));
  const normalized = normalizeGenerationPlan(input, { allowedKinds: ['image', 'video'] });
  const ready = selectReadyItems(input, {}, { allowedKinds: ['image', 'video'] });

  assert.equal(normalized.items.length, 10);
  assert.equal(new Set(normalized.items.map(item => item.itemId)).size, 10);
  assert.equal(ready.length, 10);
  assert.ok(ready.every(item => item.kind === 'image' && item.quantity === 1));
});

test('M5E-2：三图到三视频形成确定 DAG，图片成功后对应视频才 ready', () => {
  const images = [1, 2, 3].map(index => imageItem(index));
  const videos = [1, 2, 3].map(index => ({
    itemId: `video-${index}`,
    stageId: 'videos',
    kind: 'video',
    prompt: `根据图片 ${index} 生成视频`,
    promptVersion: 'prompt-v1',
    provider: 'configured-video-provider',
    model: 'seedance-2.0',
    spec: { resolution: '480p', duration: 5, ratio: '9:16' },
    quantity: 1,
    dependsOn: [{ itemId: `image-${index}`, role: 'first_frame' }]
  }));
  const input = planWith([...videos, ...images], [
    { stageId: 'videos', label: '视频成片' },
    { stageId: 'images', label: '图片资产' }
  ]);

  const order = topologicalSort(input);
  for (const index of [1, 2, 3]) assert.ok(order.indexOf(`image-${index}`) < order.indexOf(`video-${index}`));
  assert.deepEqual(selectReadyItems(input).map(item => item.itemId), ['image-1', 'image-2', 'image-3']);
  assert.deepEqual(
    selectReadyItems(input, { 'image-1': 'succeeded', 'image-2': 'succeeded', 'image-3': 'succeeded' })
      .map(item => item.itemId),
    ['video-1', 'video-2', 'video-3']
  );
});

test('M5E-2：合法数组与对象键顺序变化不改变计划稳定身份', () => {
  const first = planWith([imageItem(2), imageItem(1)], [
    { stageId: 'images', label: '图片资产' }
  ]);
  const second = {
    items: [
      { ...imageItem(1), spec: { ratio: '9:16', resolution: '1K' } },
      { ...imageItem(2), spec: { ratio: '9:16', resolution: '1K' } }
    ],
    stages: [{ label: '图片资产', stageId: 'images' }],
    planRevision: 1
  };

  assert.equal(canonicalGenerationPlanHash(first), canonicalGenerationPlanHash(second));
  assert.deepEqual(normalizeGenerationPlan(first).items.map(item => item.itemId), ['image-1', 'image-2']);
});

test('M6B1：旧计划不补空分支字段且固定哈希保持不变', () => {
  const legacyPlan = {
    planRevision: 1,
    stages: [{ stageId: 'stage-images', label: 'Images' }],
    items: [{
      itemId: 'image-1',
      stageId: 'stage-images',
      kind: 'image',
      prompt: '兼容旧计划',
      promptVersion: 'prompt-v1',
      provider: 'fixture-apimart',
      model: 'gpt-image-2',
      spec: { ratio: '9:16', resolution: '2k' },
      quantity: 1,
      dependsOn: []
    }]
  };
  const normalized = normalizeGenerationPlan(legacyPlan);

  assert.equal(normalized.planHash, 'd176c1199a1ff22c6efeae98e48ea393efb1156ea43fdd8ea27ad535d3703ed5');
  for (const field of ['parentNodeRef', 'branchRootRef', 'supersedesRef']) {
    assert.equal(Object.hasOwn(normalized.items[0], field), false);
  }
});

test('M6B1：完整重做分支身份进入计划哈希，残缺或错指身份失败关闭', () => {
  const branchIdentity = {
    parentNodeRef: 'node-old',
    branchRootRef: 'node-root',
    supersedesRef: 'node-old'
  };
  const branchPlan = planWith([imageItem(1, branchIdentity)]);
  const normalized = normalizeGenerationPlan(branchPlan);

  assert.deepEqual(
    Object.fromEntries(Object.keys(branchIdentity).map(key => [key, normalized.items[0][key]])),
    branchIdentity
  );
  assert.notEqual(normalized.planHash, canonicalGenerationPlanHash(planWith([imageItem(1)])));
  assert.throws(
    () => assertGenerationPlanIdentity(planWith([imageItem(1, { ...branchIdentity, branchRootRef: 'node-other-root' })]), normalized),
    hasCode('GENERATION_PLAN_DRIFT', 409)
  );
  assert.throws(
    () => normalizeGenerationPlan(planWith([imageItem(1, { parentNodeRef: 'node-old' })])),
    hasCode('INVALID_GENERATION_BRANCH_IDENTITY')
  );
  assert.throws(
    () => normalizeGenerationPlan(planWith([imageItem(1, { ...branchIdentity, supersedesRef: 'node-other' })])),
    hasCode('INVALID_GENERATION_BRANCH_IDENTITY')
  );
});

test('M5E-2：费用按 item 和媒体类型汇总，不混入计划哈希', () => {
  const input = planWith([imageItem(1), imageItem(2)]);
  const beforeHash = canonicalGenerationPlanHash(input);
  const summary = summarizeGenerationCost(input, {
    'image-1': { currency: 'usd', estimatedCost: 0.1 },
    'image-2': { currency: 'USD', estimatedCost: 0.2 }
  });

  assert.deepEqual(summary, {
    currency: 'USD',
    estimatedCost: 0.3,
    itemCount: 2,
    byKind: { image: { itemCount: 2, estimatedCost: 0.3 } }
  });
  assert.equal(canonicalGenerationPlanHash(input), beforeHash);
  assert.throws(
    () => summarizeGenerationCost(input, {
      'image-1': { currency: 'USD', estimatedCost: 1 },
      'image-2': { currency: 'CNY', estimatedCost: 1 }
    }),
    hasCode('MIXED_GENERATION_CURRENCY')
  );
});

test('M5E-2：轮次状态由所有 item 聚合且 remote-unknown 优先失败关闭', () => {
  const input = planWith([imageItem(1), imageItem(2)]);
  assert.equal(aggregateGenerationStatus(input), 'planning');
  assert.equal(aggregateGenerationStatus(input, { 'image-1': 'running' }), 'running');
  assert.equal(aggregateGenerationStatus(input, { 'image-1': 'succeeded', 'image-2': 'failed' }), 'partial');
  assert.equal(aggregateGenerationStatus(input, { 'image-1': 'failed', 'image-2': 'failed' }), 'failed');
  assert.equal(aggregateGenerationStatus(input, { 'image-1': 'cancelled', 'image-2': 'cancelled' }), 'cancelled');
  assert.equal(aggregateGenerationStatus(input, { 'image-1': 'succeeded', 'image-2': 'succeeded' }), 'completed');
  assert.equal(aggregateGenerationStatus(input, { 'image-1': 'remote-unknown', 'image-2': 'succeeded' }), 'remote-unknown');
});

test('M5E-11：重启纯状态只把可能已提交的 item 收口为 remote-unknown', () => {
  const input = planWith(Array.from({ length: 9 }, (_, index) => imageItem(index + 1)));
  const recovered = recoverGenerationRoundState(input, {
    'image-1': 'planned',
    'image-2': 'queued',
    'image-3': 'submitting',
    'image-4': 'running',
    'image-5': 'remote-unknown',
    'image-6': 'succeeded',
    'image-7': 'failed',
    'image-8': 'blocked-by-dependency',
    'image-9': 'cancelled'
  });

  assert.deepEqual(recovered.statusByItemId, {
    'image-1': 'planned',
    'image-2': 'queued',
    'image-3': 'remote-unknown',
    'image-4': 'remote-unknown',
    'image-5': 'remote-unknown',
    'image-6': 'succeeded',
    'image-7': 'failed',
    'image-8': 'blocked-by-dependency',
    'image-9': 'cancelled'
  });
  assert.equal(recovered.status, 'remote-unknown');
  assert.equal(recovered.reconcileRequired, true);
  assert.deepEqual(recovered.interruptedItemIds, ['image-3', 'image-4']);
});

test('M5E-11：服务重启保留全部执行身份，partial 不回滚且 remote-unknown 不重发', t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-m5e11-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  let tick = 1_000;
  let generatedIds = 0;
  const service = createAgentSessionService({
    outputRoot,
    clock: () => ++tick,
    makeId: prefix => `${prefix}-m5e11-${++generatedIds}`
  });
  const session = service.createSession({
    requestId: 'request-m5e11-session',
    canvasId: 'canvas-m5e11',
    title: 'M5E-11 restart fixture',
    workspaceScope: 'canvas-agent',
    mode: 'generation'
  }).session;

  const addRound = (roundId, items, { commit = true, approve = true } = {}) => {
    const eventId = `event-${roundId}`;
    service.appendMessage(session.id, {
      requestId: `request-message-${roundId}`,
      eventId,
      role: 'user',
      kind: 'text',
      content: `create ${roundId}`
    });
    let round = service.createGenerationRound(session.id, {
      requestId: `request-create-${roundId}`,
      roundId,
      sourceMessageEventId: eventId,
      mode: 'manual'
    }).round;
    if (!commit) return round;
    round = service.commitGenerationRound(session.id, roundId, {
      requestId: `request-commit-${roundId}`,
      ...planWith(items)
    }).round;
    if (!approve) return round;
    return service.approveGenerationRound(session.id, roundId, {
      requestId: `request-approve-${roundId}`,
      planRevision: round.planRevision,
      planHash: round.planHash
    }).round;
  };
  const bindItem = (roundId, itemId, status, remoteTaskId = '') => {
    const suffix = `${roundId}-${itemId}`;
    const binding = {
      toolRunId: `tool-${suffix}`,
      nodeId: `node-${suffix}`,
      operationId: `operation-${suffix}`,
      inputHash: 'a'.repeat(64),
      remoteTaskId
    };
    service.upsertToolRun(session.id, binding.toolRunId, {
      requestId: `request-tool-queued-${suffix}`,
      type: 'native-image',
      status: 'queued',
      nodeId: binding.nodeId,
      provider: 'configured-image-provider',
      model: 'configured-image-model',
      operationId: binding.operationId,
      inputVersion: 'artifact-m5e11',
      inputHash: binding.inputHash,
      quantity: 1,
      estimatedCost: 0,
      approvedBudget: 0,
      retryBudget: 0,
      attempt: 0,
      ...(remoteTaskId ? { remoteTaskId } : {})
    });
    service.updateGenerationRoundItem(session.id, roundId, itemId, {
      requestId: `request-bind-${suffix}`,
      status: 'queued',
      ...binding
    });
    service.attachCurrentNode(session.id, binding.nodeId, {
      requestId: `request-node-${suffix}`,
      workspaceScope: 'canvas-agent',
      kind: 'image',
      toolRunId: binding.toolRunId
    });
    if (status !== 'queued') {
      service.upsertToolRun(session.id, binding.toolRunId, {
        requestId: `request-tool-${status}-${suffix}`,
        status,
        ...(status === 'failed' ? { error: 'fixture failure' } : {})
      });
    }
    return binding;
  };

  addRound('round-planning', [imageItem(1)], { commit: false });
  addRound('round-awaiting', [imageItem(2)], { approve: false });
  addRound('round-queued', [imageItem(3)]);
  const queuedBinding = bindItem('round-queued', 'image-3', 'queued');

  addRound('round-interrupted', [imageItem(4), imageItem(5), imageItem(6), imageItem(7), imageItem(8)]);
  const submittingBinding = bindItem('round-interrupted', 'image-4', 'submitting', 'remote-submitting');
  const runningBinding = bindItem('round-interrupted', 'image-5', 'running', 'remote-running');
  const unknownBinding = bindItem('round-interrupted', 'image-6', 'remote-unknown', 'remote-existing');
  bindItem('round-interrupted', 'image-7', 'succeeded', 'remote-succeeded');
  bindItem('round-interrupted', 'image-8', 'failed', 'remote-failed');

  addRound('round-partial', [imageItem(9), imageItem(10), imageItem(11)]);
  bindItem('round-partial', 'image-9', 'succeeded', 'remote-partial-success');
  bindItem('round-partial', 'image-10', 'failed', 'remote-partial-failed');

  const before = service.loadSession(session.id);
  const identity = value => ({
    toolRuns: value.toolRuns.map(item => [item.id, item.nodeId, item.operationId, item.remoteTaskId]),
    nodes: value.currentNodeRefs.map(item => [item.nodeId, item.toolRunId]),
    items: value.generationRounds.flatMap(round => round.items.map(item => [round.roundId, item.itemId, item.toolRunId, item.nodeId, item.operationId, item.remoteTaskId]))
  });
  const beforeIdentity = identity(before);
  let restartIdCalls = 0;
  const restarted = createAgentSessionService({
    outputRoot,
    clock: () => ++tick,
    makeId: prefix => {
      restartIdCalls += 1;
      return `${prefix}-unexpected-${restartIdCalls}`;
    }
  });
  const recovered = restarted.loadSession(session.id);
  const byRound = Object.fromEntries(recovered.generationRounds.map(round => [round.roundId, round]));

  assert.equal(restartIdCalls, 0, '恢复不能生成新的 session、operation、ToolRun 或 node 身份');
  assert.deepEqual(identity(recovered), beforeIdentity);
  assert.equal(byRound['round-planning'].status, 'planning');
  assert.equal(byRound['round-awaiting'].status, 'awaiting-approval');
  assert.equal(byRound['round-queued'].items[0].status, 'queued');
  assert.equal(byRound['round-queued'].items[0].operationId, queuedBinding.operationId);
  assert.equal(byRound['round-interrupted'].items.find(item => item.itemId === 'image-4').status, 'remote-unknown');
  assert.equal(byRound['round-interrupted'].items.find(item => item.itemId === 'image-5').status, 'remote-unknown');
  assert.equal(byRound['round-interrupted'].items.find(item => item.itemId === 'image-6').status, 'remote-unknown');
  assert.equal(byRound['round-interrupted'].items.find(item => item.itemId === 'image-4').remoteTaskId, submittingBinding.remoteTaskId);
  assert.equal(byRound['round-interrupted'].items.find(item => item.itemId === 'image-5').remoteTaskId, runningBinding.remoteTaskId);
  assert.equal(byRound['round-interrupted'].items.find(item => item.itemId === 'image-6').remoteTaskId, unknownBinding.remoteTaskId);
  assert.equal(byRound['round-interrupted'].status, 'remote-unknown');
  assert.equal(byRound['round-interrupted'].reconcileRequired, true);
  assert.match(byRound['round-interrupted'].recoverySummary, /service-restart/);
  assert.equal(byRound['round-partial'].status, 'partial');
  assert.equal(byRound['round-partial'].items.find(item => item.itemId === 'image-10').status, 'failed');
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.reconcileRequired, true);

  const firstRevision = recovered.revision;
  const restartedAgain = createAgentSessionService({ outputRoot, clock: () => ++tick, makeId: () => { throw new Error('identity generation forbidden'); } });
  const replayed = restartedAgain.loadSession(session.id);
  assert.equal(replayed.revision, firstRevision, '第二次重启不能再次改写已经收口的恢复事实');
  assert.deepEqual(identity(replayed), beforeIdentity);
  assert.doesNotMatch(sessionSource, /\bfetch\s*\(|providerExecutor|generate(?:Image|Video|Audio)|submitProvider/);
});

test('M6B1：Session 重启后保留重做分支身份和已承诺计划哈希', t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-m6b1-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  let tick = 2_000;
  let generatedIds = 0;
  const service = createAgentSessionService({
    outputRoot,
    clock: () => ++tick,
    makeId: prefix => `${prefix}-m6b1-${++generatedIds}`
  });
  const session = service.createSession({
    requestId: 'request-m6b1-session',
    canvasId: 'canvas-m6b1',
    title: 'M6B1 branch identity fixture',
    workspaceScope: 'canvas-agent',
    mode: 'generation'
  }).session;
  service.appendMessage(session.id, {
    requestId: 'request-m6b1-message',
    eventId: 'event-m6b1-message',
    role: 'user',
    kind: 'text',
    content: '重做这个节点'
  });
  service.createGenerationRound(session.id, {
    requestId: 'request-m6b1-create',
    roundId: 'round-m6b1-branch',
    sourceMessageEventId: 'event-m6b1-message',
    mode: 'manual'
  });
  const branchIdentity = {
    parentNodeRef: 'node-old',
    branchRootRef: 'node-root',
    supersedesRef: 'node-old'
  };
  const branchPlan = planWith([imageItem(1, branchIdentity)]);
  const committed = service.commitGenerationRound(session.id, 'round-m6b1-branch', {
    requestId: 'request-m6b1-commit',
    ...branchPlan
  }).round;
  assert.equal(committed.planHash, normalizeGenerationPlan(branchPlan).planHash);

  const restarted = createAgentSessionService({
    outputRoot,
    clock: () => ++tick,
    makeId: () => { throw new Error('恢复不能生成新身份'); }
  });
  const recovered = restarted.loadSession(session.id);
  const recoveredRound = recovered.generationRounds.find(round => round.roundId === committed.roundId);

  assert.equal(recoveredRound.planHash, committed.planHash);
  assert.deepEqual(
    Object.fromEntries(Object.keys(branchIdentity).map(key => [key, recoveredRound.items[0][key]])),
    branchIdentity
  );
});

test('M5E-2：重复 ID、缺失阶段、缺失依赖、循环、数量和越权类型均失败关闭', () => {
  assert.throws(() => normalizeGenerationPlan(planWith([imageItem(1), imageItem(1)])), hasCode('DUPLICATE_GENERATION_ITEM_ID'));
  assert.throws(
    () => normalizeGenerationPlan(planWith([imageItem(1, { stageId: 'missing' })])),
    hasCode('MISSING_GENERATION_STAGE')
  );
  assert.throws(
    () => normalizeGenerationPlan(planWith([imageItem(1, { dependsOn: [{ itemId: 'missing', role: 'reference' }] })])),
    hasCode('MISSING_GENERATION_DEPENDENCY')
  );
  assert.throws(
    () => normalizeGenerationPlan(planWith([
      imageItem(1, { dependsOn: [{ itemId: 'image-2', role: 'reference' }] }),
      imageItem(2, { dependsOn: [{ itemId: 'image-1', role: 'reference' }] })
    ])),
    hasCode('GENERATION_PLAN_CYCLE')
  );
  assert.throws(
    () => normalizeGenerationPlan(planWith([imageItem(1, { quantity: 10 })])),
    hasCode('INVALID_GENERATION_ITEM_QUANTITY')
  );
  assert.throws(
    () => normalizeGenerationPlan(planWith([imageItem(1)]), { allowedKinds: ['video'] }),
    hasCode('UNAUTHORIZED_MEDIA_KIND')
  );
});

test('M5E-2：批准身份能发现计划漂移，dependent video 不能预写最终 inputHash', () => {
  const input = planWith([imageItem(1)]);
  const normalized = normalizeGenerationPlan(input);
  assert.equal(assertGenerationPlanIdentity(input, normalized).planHash, normalized.planHash);
  assert.throws(
    () => assertGenerationPlanIdentity(planWith([imageItem(1, { prompt: '被替换的 Prompt' })]), normalized),
    hasCode('GENERATION_PLAN_DRIFT', 409)
  );
  assert.throws(
    () => normalizeGenerationPlan(planWith([imageItem(1, { inputHash: 'a'.repeat(64) })])),
    hasCode('PLAN_EXECUTION_BINDING_FORBIDDEN')
  );
});

test('M5E-2：纯计划服务没有文件、网络、Provider、Session 或节点写入口', () => {
  assert.doesNotMatch(source, /require\(['"]node:(?:fs|path|https?|net)['"]\)|\bfetch\s*\(|providerExecutor|createToolRun|createNode|writeFile|AgentSession/);
});
