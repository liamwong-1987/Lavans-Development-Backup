const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createCanvasAgentFoundation, defaultLedger } = require('../services/canvasAgentFoundation');
const { TaskLedger } = require('../services/canvasAgentFoundation/taskLedger');
const { sha256 } = require('../services/canvasAgentFoundation/atomicJsonStore');
const { createCanvasAgentFoundationRoutes } = require('../routes/canvasAgentFoundationRoutes');
const { normalizeGenerationPlan } = require('../services/agentGenerationRoundService');

function fixture() {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-foundation-'));
  let now = 1_800_000_000_000;
  return { rootPath, foundation: createCanvasAgentFoundation({ rootPath, clock: () => ++now }) };
}

function create(foundation, id, content, inputRefs = [], metadata = {}) {
  return foundation.createArtifact({ logicalArtifactId: id, artifactType: id.split('-')[0], content, extension: '.txt', inputRefs, metadata, source: 'test', operationId: `create-${id}-${String(content)}`.replace(/[^a-zA-Z0-9._:-]/g, '-') });
}

function lock(foundation, id, replaceLockedVersionId) {
  foundation.approvalGate.requestReview(id);
  foundation.approvalGate.approve(id);
  return foundation.approvalGate.lock(id, { replaceLockedVersionId });
}

function lockedRoundPlan(foundation, suffix, items) {
  const agentSessionId = `agent-session-round-${suffix}`;
  const roundId = `generation-round-${suffix}`;
  const plan = normalizeGenerationPlan({
    planRevision: 1,
    stages: [{ stageId: 'assets', label: '资产' }, { stageId: 'videos', label: '视频' }],
    items
  }, { allowedKinds: ['image', 'video'] });
  const artifact = foundation.createArtifact({
    logicalArtifactId: `round-plan-${suffix}`,
    artifactType: 'agent-generation-plan',
    content: {
      agentSessionId,
      roundId,
      planRevision: plan.planRevision,
      planHash: plan.planHash,
      stages: plan.stages,
      items: plan.items
    },
    extension: '.json',
    operationId: `create-round-plan-${suffix}`
  });
  lock(foundation, artifact.artifactVersionId);
  return { agentSessionId, roundId, plan, artifact };
}

test('Artifact Version Store 不覆盖成功版本，重复 operationId 幂等', () => {
  const { foundation } = fixture();
  const first = foundation.createArtifact({ logicalArtifactId: 'script', artifactType: 'script', content: 'A', operationId: 'op-one' });
  const repeated = foundation.createArtifact({ logicalArtifactId: 'script', artifactType: 'script', content: 'B', operationId: 'op-one' });
  assert.equal(repeated.artifactVersionId, first.artifactVersionId);
  assert.equal(foundation.artifactStore.list().length, 1);
  const second = foundation.createArtifact({ logicalArtifactId: 'script', artifactType: 'script', content: 'B', operationId: 'op-two' });
  assert.equal(second.version, 2);
  assert.notEqual(second.contentPath, first.contentPath);
});

test('内容被篡改后哈希校验失败并阻断审核', () => {
  const { rootPath, foundation } = fixture();
  const artifact = create(foundation, 'script', 'original');
  fs.writeFileSync(path.join(rootPath, 'artifacts', artifact.contentPath), 'tampered');
  assert.equal(foundation.artifactStore.verify(artifact.artifactVersionId).valid, false);
  assert.throws(() => foundation.approvalGate.requestReview(artifact.artifactVersionId), /哈希不一致/);
  assert.equal(foundation.artifactStore.get(artifact.artifactVersionId, { verify: false }).validityState, 'invalid');
});

test('依赖图支持正向、反向查询并拒绝循环', () => {
  const { foundation } = fixture();
  const a = create(foundation, 'script', 'A');
  const b = create(foundation, 'shot-1', 'B', [{ artifactVersionId: a.artifactVersionId, role: 'script' }]);
  assert.equal(foundation.dependencyGraph.inputsOf(b.artifactVersionId)[0].artifactVersionId, a.artifactVersionId);
  assert.deepEqual(foundation.dependencyGraph.dependentsOf(a.artifactVersionId), [b.artifactVersionId]);
  assert.throws(() => foundation.dependencyGraph.setInputs(a.artifactVersionId, [{ artifactVersionId: b.artifactVersionId }]), /循环依赖/);
});

test('上游变化只标记真正受影响链，未相关镜头保持 current 且零删除', () => {
  const { rootPath, foundation } = fixture();
  const scriptV1 = create(foundation, 'script', 'V1');
  const shot1 = create(foundation, 'shot-1', 'shot1', [{ artifactVersionId: scriptV1.artifactVersionId, role: 'script' }]);
  const image1 = create(foundation, 'image-1', 'image1', [{ artifactVersionId: shot1.artifactVersionId, role: 'shot' }]);
  const shot2 = create(foundation, 'shot-2', 'shot2');
  const beforeFiles = fs.readdirSync(path.join(rootPath, 'artifacts', 'content'), { recursive: true }).length;
  const scriptV2 = foundation.createArtifact({ logicalArtifactId: 'script', artifactType: 'script', content: 'V2', operationId: 'script-v2' });
  const impact = foundation.impactPropagator.propagateReplacement(scriptV1.artifactVersionId, scriptV2.artifactVersionId, { operationId: 'impact-1' });
  assert.deepEqual(impact.affected.map(item => [item.artifactVersionId, item.validityState]), [[shot1.artifactVersionId, 'stale'], [image1.artifactVersionId, 'needs-review']]);
  assert.equal(foundation.artifactStore.get(shot2.artifactVersionId, { verify: false }).validityState, 'current');
  assert.equal(impact.deletedFiles, 0);
  assert.equal(fs.readdirSync(path.join(rootPath, 'artifacts', 'content'), { recursive: true }).length, beforeFiles + 1);
});

test('内容变化后的复用必须人工确认，确认后重新绑定且留审计', () => {
  const { foundation } = fixture();
  const oldInput = create(foundation, 'script', 'old');
  const downstream = create(foundation, 'shot-1', 'shot', [{ artifactVersionId: oldInput.artifactVersionId, role: 'script' }]);
  const newInput = foundation.createArtifact({ logicalArtifactId: 'script', artifactType: 'script', content: 'new', operationId: 'new-script' });
  foundation.impactPropagator.propagateReplacement(oldInput.artifactVersionId, newInput.artifactVersionId, { operationId: 'propagate' });
  assert.throws(() => foundation.impactPropagator.confirmReuse(downstream.artifactVersionId, oldInput.artifactVersionId, newInput.artifactVersionId, { operationId: 'reuse' }), /用户明确确认/);
  foundation.impactPropagator.confirmReuse(downstream.artifactVersionId, oldInput.artifactVersionId, newInput.artifactVersionId, { operationId: 'reuse', userConfirmed: true });
  assert.equal(foundation.dependencyGraph.inputsOf(downstream.artifactVersionId)[0].artifactVersionId, newInput.artifactVersionId);
  assert.equal(foundation.artifactStore.get(downstream.artifactVersionId, { verify: false }).validityState, 'current');
});

test('审核关卡执行合法状态机，替换锁定版本需要精确确认', () => {
  const { foundation } = fixture();
  const first = create(foundation, 'script', 'one');
  assert.throws(() => foundation.approvalGate.approve(first.artifactVersionId), /待审核/);
  lock(foundation, first.artifactVersionId);
  const second = foundation.createArtifact({ logicalArtifactId: 'script', artifactType: 'script', content: 'two', operationId: 'second-script' });
  foundation.approvalGate.requestReview(second.artifactVersionId);
  foundation.approvalGate.approve(second.artifactVersionId);
  assert.throws(() => foundation.approvalGate.lock(second.artifactVersionId), /精确确认/);
  foundation.approvalGate.lock(second.artifactVersionId, { replaceLockedVersionId: first.artifactVersionId });
  assert.equal(foundation.artifactStore.get(first.artifactVersionId, { verify: false }).approvalState, 'superseded');
  assert.equal(foundation.artifactStore.get(second.artifactVersionId, { verify: false }).approvalState, 'locked');
});

test('Execution Guard 只接受 locked + current 的精确输入与预算', () => {
  const { foundation } = fixture();
  const input = create(foundation, 'script', 'locked');
  const base = { operationId: 'paid-op', provider: 'provider-a', model: 'model-a', inputVersionIds: [input.artifactVersionId], quantity: 2, estimatedCost: 8, budgetLimit: 10, retryLimit: 1 };
  assert.throws(() => foundation.executionGuard.authorize(base), /未锁定/);
  lock(foundation, input.artifactVersionId);
  const authorization = foundation.executionGuard.authorize({ ...base, authorizedBy: 'user' });
  assert.equal(foundation.executionGuard.assertAllowed({ ...base, authorizationId: authorization.authorizationId }).allowed, true);
  assert.throws(() => foundation.executionGuard.assertAllowed({ ...base, model: 'model-b', authorizationId: authorization.authorizationId }), /旧授权失效/);
  assert.throws(() => foundation.executionGuard.authorize({ ...base, operationId: 'over-budget', estimatedCost: 12 }), /超过预算/);
});

test('Execution Guard 可跨重启核验已消费的 Agent 精确授权，inputHash 漂移失败关闭', () => {
  const { rootPath, foundation } = fixture();
  const input = create(foundation, 'agent-native-input', 'locked');
  lock(foundation, input.artifactVersionId);
  const request = {
    operationId: 'agent-native-paid-op',
    provider: 'provider-a',
    model: 'model-a',
    inputVersionIds: [input.artifactVersionId],
    quantity: 1,
    estimatedCost: 8,
    budgetLimit: 8,
    retryLimit: 0,
    allowFallback: false,
    agentSessionId: 'agent-session-guard-1',
    toolRunId: 'tool-run-guard-1',
    nodeId: 'node-guard-1',
    taskKind: 'image',
    inputHash: 'a'.repeat(64)
  };
  const authorization = foundation.executionGuard.authorize(request);
  assert.equal(authorization.request.inputHash, request.inputHash);
  assert.throws(
    () => foundation.executionGuard.authorize({ ...request, nodeId: undefined }),
    /必须完整绑定/
  );
  assert.throws(
    () => foundation.executionGuard.assertConsumed({ ...request, authorizationId: authorization.authorizationId }),
    /尚未使用/
  );
  const consumed = foundation.executionGuard.consume({ ...request, authorizationId: authorization.authorizationId });
  const restarted = createCanvasAgentFoundation({ rootPath });
  assert.deepEqual(
    restarted.executionGuard.assertConsumed({ ...request, authorizationId: authorization.authorizationId }),
    consumed
  );
  assert.deepEqual(
    restarted.executionGuard.assertConsumed({ ...consumed.request, authorizationId: authorization.authorizationId }),
    consumed,
    '持久化请求中的 null 高价阈值必须保持 null，不能被归一化成 0'
  );
  const repeatedAuthorization = restarted.executionGuard.authorize(request);
  assert.equal(repeatedAuthorization.consumedAt, consumed.consumedAt, '重复 authorize 不能复活已消费授权');
  const replayedConsumption = restarted.executionGuard.consumeStoredAuthorization({ authorizationId: authorization.authorizationId });
  assert.equal(replayedConsumption.idempotent, true);
  assert.equal(replayedConsumption.consumedAt, consumed.consumedAt);
  assert.throws(
    () => restarted.executionGuard.assertAllowed({ ...request, authorizationId: authorization.authorizationId }),
    /已使用/
  );
  assert.throws(
    () => restarted.executionGuard.assertConsumed({ ...request, inputHash: 'b'.repeat(64), authorizationId: authorization.authorizationId }),
    /旧授权失效/
  );
  restarted.artifactStore.updateState(input.artifactVersionId, { validityState: 'stale' });
  assert.throws(
    () => restarted.executionGuard.assertConsumed({ ...request, authorizationId: authorization.authorizationId }),
    /未锁定或需要复核/
  );
});

test('M5E-4：一个已消费 Round 主授权可派生异构图片与视频精确子回执', () => {
  const { rootPath, foundation } = fixture();
  const round = lockedRoundPlan(foundation, 'heterogeneous', [{
    itemId: 'image-hero', stageId: 'assets', kind: 'image', prompt: '商品主图', promptVersion: 'v1',
    provider: 'image-provider', model: 'image-model', spec: { ratio: '1:1', resolution: '1K' }, quantity: 1, dependsOn: []
  }, {
    itemId: 'video-hero', stageId: 'videos', kind: 'video', prompt: '商品视频', promptVersion: 'v1',
    provider: 'video-provider', model: 'video-model', spec: { ratio: '9:16', resolution: '480P', duration: 5 }, quantity: 1,
    dependsOn: [{ itemId: 'image-hero', role: 'first_frame' }]
  }]);
  const masterRequest = {
    agentSessionId: round.agentSessionId,
    roundId: round.roundId,
    planRevision: round.plan.planRevision,
    planHash: round.plan.planHash,
    planArtifactVersionId: round.artifact.artifactVersionId,
    totalQuantity: 2,
    estimatedCost: 1.25,
    budgetLimit: 1.25,
    currency: 'USD',
    executionMode: 'manual',
    reviewGateId: 'generation-round-review'
  };
  const master = foundation.executionGuard.authorizeRound({ ...masterRequest, authorizedBy: 'user' });
  assert.equal(master.authorizationType, 'round-master');
  assert.equal(master.request.planArtifactContentHash, round.artifact.contentHash);
  assert.throws(
    () => foundation.executionGuard.deriveRoundItemReceipt({ parentAuthorizationId: master.authorizationId, itemId: 'image-hero' }),
    /父授权尚未使用/
  );
  const consumedMaster = foundation.executionGuard.consumeRoundAuthorization({
    authorizationId: master.authorizationId,
    agentSessionId: round.agentSessionId,
    roundId: round.roundId,
    planRevision: round.plan.planRevision,
    planHash: round.plan.planHash,
    planArtifactVersionId: round.artifact.artifactVersionId
  });
  assert.equal(consumedMaster.idempotent, false);

  const imageInput = {
    parentAuthorizationId: master.authorizationId,
    itemId: 'image-hero',
    operationId: 'round-image-operation',
    provider: 'image-provider',
    model: 'image-model',
    inputVersionIds: [round.artifact.artifactVersionId],
    quantity: 1,
    estimatedCost: 0.25,
    budgetLimit: 0.25,
    currency: 'USD',
    retryLimit: 0,
    executionMode: 'manual',
    allowFallback: false,
    reviewGateId: 'generation-round-review',
    agentSessionId: round.agentSessionId,
    toolRunId: 'tool-round-image',
    nodeId: 'node-round-image',
    taskKind: 'image',
    inputHash: 'a'.repeat(64)
  };
  const imageReceipt = foundation.executionGuard.deriveRoundItemReceipt(imageInput);
  assert.equal(imageReceipt.authorizationType, 'round-item-child');
  assert.equal(imageReceipt.request.parentAuthorizationId, master.authorizationId);
  assert.equal(imageReceipt.request.roundId, round.roundId);
  assert.equal(imageReceipt.request.stageId, 'assets');
  assert.ok(imageReceipt.consumedAt);
  assert.equal(imageReceipt.idempotent, false);
  assert.equal(foundation.executionGuard.deriveRoundItemReceipt(imageInput).idempotent, true);

  const videoInput = {
    ...imageInput,
    itemId: 'video-hero',
    operationId: 'round-video-operation',
    provider: 'video-provider',
    model: 'video-model',
    estimatedCost: 1,
    budgetLimit: 1,
    toolRunId: 'tool-round-video',
    nodeId: 'node-round-video',
    taskKind: 'video',
    inputHash: 'b'.repeat(64)
  };
  const videoReceipt = foundation.executionGuard.deriveRoundItemReceipt(videoInput);
  assert.equal(videoReceipt.request.itemId, 'video-hero');
  assert.equal(videoReceipt.request.stageId, 'videos');

  const restarted = createCanvasAgentFoundation({ rootPath });
  assert.equal(restarted.executionGuard.assertConsumed({
    ...videoReceipt.request,
    authorizationId: videoReceipt.authorizationId
  }).authorizationId, videoReceipt.authorizationId);
  assert.equal(restarted.executionGuard.consumeRoundAuthorization({
    authorizationId: master.authorizationId,
    agentSessionId: round.agentSessionId,
    roundId: round.roundId,
    planRevision: 1,
    planHash: round.plan.planHash,
    planArtifactVersionId: round.artifact.artifactVersionId
  }).idempotent, true);
});

test('M5E-4：子回执拒绝预算超额、计划漂移、重复 item 漂移和跨 Round 执行身份复用', () => {
  const { foundation } = fixture();
  const planItems = [{
    itemId: 'image-one', stageId: 'assets', kind: 'image', prompt: '图一', promptVersion: 'v1',
    provider: 'image-provider', model: 'image-model', spec: { ratio: '1:1', resolution: '1K' }, quantity: 1, dependsOn: []
  }, {
    itemId: 'image-two', stageId: 'assets', kind: 'image', prompt: '图二', promptVersion: 'v1',
    provider: 'image-provider', model: 'image-model', spec: { ratio: '1:1', resolution: '1K' }, quantity: 1, dependsOn: []
  }];
  const firstRound = lockedRoundPlan(foundation, 'budget-a', planItems);
  const authorize = round => foundation.executionGuard.authorizeRound({
    agentSessionId: round.agentSessionId,
    roundId: round.roundId,
    planRevision: 1,
    planHash: round.plan.planHash,
    planArtifactVersionId: round.artifact.artifactVersionId,
    totalQuantity: 2,
    estimatedCost: 1,
    budgetLimit: 1,
    currency: 'USD',
    executionMode: 'auto',
    reviewGateId: 'generation-round-review'
  });
  const consume = (round, authorization) => foundation.executionGuard.consumeRoundAuthorization({
    authorizationId: authorization.authorizationId,
    agentSessionId: round.agentSessionId,
    roundId: round.roundId,
    planRevision: 1,
    planHash: round.plan.planHash,
    planArtifactVersionId: round.artifact.artifactVersionId
  });
  const firstMaster = authorize(firstRound);
  consume(firstRound, firstMaster);
  const child = {
    parentAuthorizationId: firstMaster.authorizationId,
    itemId: 'image-one',
    operationId: 'shared-operation', provider: 'image-provider', model: 'image-model',
    inputVersionIds: [firstRound.artifact.artifactVersionId], quantity: 1,
    estimatedCost: 0.7, budgetLimit: 0.7, currency: 'USD', retryLimit: 0,
    executionMode: 'auto', allowFallback: false, reviewGateId: 'generation-round-review',
    agentSessionId: firstRound.agentSessionId, toolRunId: 'shared-tool-run', nodeId: 'shared-node',
    taskKind: 'image', inputHash: 'c'.repeat(64)
  };
  const firstReceipt = foundation.executionGuard.deriveRoundItemReceipt(child);
  assert.throws(
    () => foundation.executionGuard.deriveRoundItemReceipt({ ...child, nodeId: 'changed-node' }),
    /同一生成项的子回执发生漂移/
  );
  assert.throws(
    () => foundation.executionGuard.deriveRoundItemReceipt({
      ...child,
      itemId: 'image-two', operationId: 'second-operation', toolRunId: 'second-tool', nodeId: 'second-node',
      estimatedCost: 0.31, budgetLimit: 0.31, inputHash: 'd'.repeat(64)
    }),
    /超过 Round 授权预算/
  );
  assert.throws(
    () => foundation.executionGuard.deriveRoundItemReceipt({ ...child, provider: 'another-provider' }),
    /生成计划绑定不一致/
  );
  assert.throws(
    () => foundation.executionGuard.assertConsumed({
      ...firstReceipt.request,
      roundId: 'another-round',
      authorizationId: firstReceipt.authorizationId
    }),
    /旧授权失效/
  );

  const secondRound = lockedRoundPlan(foundation, 'budget-b', planItems);
  const secondMaster = authorize(secondRound);
  consume(secondRound, secondMaster);
  assert.throws(
    () => foundation.executionGuard.deriveRoundItemReceipt({
      ...child,
      parentAuthorizationId: secondMaster.authorizationId,
      itemId: 'image-one',
      inputVersionIds: [secondRound.artifact.artifactVersionId],
      agentSessionId: secondRound.agentSessionId
    }),
    /执行身份已绑定另一生成项/
  );
});

test('needs-review、stale 和 invalid 输入全部不能进入付费执行', () => {
  for (const validityState of ['needs-review', 'stale', 'invalid']) {
    const { foundation } = fixture();
    const input = create(foundation, `script-${validityState}`, validityState);
    lock(foundation, input.artifactVersionId);
    foundation.artifactStore.updateState(input.artifactVersionId, { validityState });
    assert.throws(() => foundation.executionGuard.authorize({ operationId: `op-${validityState}`, provider: 'p', model: 'm', inputVersionIds: [input.artifactVersionId], quantity: 1, estimatedCost: 1, budgetLimit: 2 }), /未锁定或需要复核|输入版本无效/);
  }
});

test('Task Ledger 要求 10 个阶段、合法状态和唯一 nextAction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-ledger-'));
  const ledger = new TaskLedger(path.join(root, 'ledger.json'));
  const initial = defaultLedger();
  assert.equal(ledger.save(initial).phases.length, 10);
  const invalid = defaultLedger();
  invalid.nextAction = { taskId: 'missing' };
  assert.throws(() => ledger.save(invalid), /nextAction/);
  const duplicate = defaultLedger();
  duplicate.phases[1].tasks[0].id = '1.1';
  assert.throws(() => ledger.save(duplicate), /重复/);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
});

test('恢复审计发现缺失文件与投影不一致', () => {
  const { rootPath, foundation } = fixture();
  const artifact = create(foundation, 'script', 'content');
  fs.unlinkSync(path.join(rootPath, 'artifacts', artifact.contentPath));
  const report = foundation.recoveryAuditor.audit({ projection: { artifactCount: 0 } });
  assert.equal(report.healthy, false);
  assert.deepEqual(new Set(report.issues.map(issue => issue.type)), new Set(['artifact-invalid', 'projection-mismatch']));
});

test('服务重启将 running 操作恢复为 interrupted，不重复执行', () => {
  const { rootPath, foundation } = fixture();
  foundation.recoveryAuditor.registerOperation({ operationId: 'external-call-1', status: 'running', provider: 'paid-provider' });
  createCanvasAgentFoundation({ rootPath });
  const operations = JSON.parse(fs.readFileSync(path.join(rootPath, 'execution-operations.json'), 'utf8')).operations;
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, 'interrupted');
});

test('影响传播 operationId 跨重启保持幂等，不重复写审计', () => {
  const { rootPath, foundation } = fixture();
  const oldInput = create(foundation, 'script', 'old');
  create(foundation, 'shot-1', 'shot', [{ artifactVersionId: oldInput.artifactVersionId, role: 'script' }]);
  const newInput = foundation.createArtifact({ logicalArtifactId: 'script', artifactType: 'script', content: 'new', operationId: 'new-version' });
  const first = foundation.impactPropagator.propagateReplacement(oldInput.artifactVersionId, newInput.artifactVersionId, { operationId: 'stable-impact' });
  const restarted = createCanvasAgentFoundation({ rootPath });
  const repeated = restarted.impactPropagator.propagateReplacement(oldInput.artifactVersionId, newInput.artifactVersionId, { operationId: 'stable-impact' });
  assert.deepEqual(repeated, first);
  assert.equal(restarted.impactPropagator.audit().filter(entry => entry.operationId === 'stable-impact').length, 1);
});

test('精确付费授权跨重启保存，消费后不能再次使用', () => {
  const { rootPath, foundation } = fixture();
  const input = create(foundation, 'script', 'locked');
  lock(foundation, input.artifactVersionId);
  const request = { operationId: 'paid-persisted', provider: 'p', model: 'm', inputVersionIds: [input.artifactVersionId], quantity: 1, estimatedCost: 1, budgetLimit: 2, retryLimit: 0 };
  const authorization = foundation.executionGuard.authorize(request);
  const restarted = createCanvasAgentFoundation({ rootPath });
  restarted.executionGuard.consume({ ...request, authorizationId: authorization.authorizationId });
  assert.throws(() => createCanvasAgentFoundation({ rootPath }).executionGuard.assertAllowed({ ...request, authorizationId: authorization.authorizationId }), /已使用/);
});

test('M3A：默认 session-workset 不生成节点，显式 legacy-history 可重建后台版本与影响数', () => {
  const { rootPath, foundation } = fixture();
  const canvasId = 'canvas-m3a-history';
  const script = create(foundation, 'script', 'A', [], { canvasId });
  create(foundation, 'shot-1', 'B', [{ artifactVersionId: script.artifactVersionId, role: 'script' }], { canvasId });
  const workset = foundation.status({ canvasId, currentNodeRefs: [{ nodeId: 'node-image-current', workspaceScope: 'canvas-agent', kind: 'image', toolRunId: 'tool-image-current' }] }).projection;
  assert.equal(workset.mode, 'session-workset');
  assert.deepEqual(workset.nodes, []);
  assert.deepEqual(workset.edges, []);
  assert.deepEqual(workset.currentNodeRefs.map(ref => ref.nodeId), ['node-image-current']);
  assert.equal(workset.historySummary.artifactCount, 2);
  assert.equal('history' in workset, false, '默认工作集不能把完整历史投影到主画布');
  assert.equal(foundation.status().projection.artifactCount, 0, '缺少 canvasId 时默认工作集不能退化成全库读取');
  assert.throws(
    () => foundation.status({ currentNodeRefs: [{ nodeId: 'node-recolor', workspaceScope: 'recolor', kind: 'image' }] }),
    error => error?.code === 'INVALID_CURRENT_NODE_SCOPE'
  );
  assert.throws(
    () => foundation.status({ currentNodeRefs: [{ nodeId: 'node-document', workspaceScope: 'canvas-agent', kind: 'document' }] }),
    error => error?.code === 'INVALID_CURRENT_NODE_KIND'
  );
  assert.throws(
    () => foundation.status({ mode: 'unexpected-mode' }),
    error => error?.code === 'INVALID_FOUNDATION_PROJECTION_MODE'
  );
  assert.throws(
    () => foundation.status({ mode: 'legacy-history' }),
    error => error?.code === 'FOUNDATION_CANVAS_ID_REQUIRED'
  );

  const first = foundation.status({ canvasId, mode: 'legacy-history' }).projection;
  const restarted = createCanvasAgentFoundation({ rootPath });
  const second = restarted.status({ canvasId, mode: 'legacy-history' }).projection;
  assert.deepEqual(second, first);
  assert.deepEqual(second.nodes, []);
  assert.deepEqual(second.edges, []);
  assert.equal(second.history.artifacts.some(item => item.type === 'agent-approval-artifact'), false);
  assert.equal(second.history.artifacts.find(item => item.artifactVersionId === script.artifactVersionId).affectedCount, 1);
});

test('M3A：legacy-history 对损坏内容失败关闭，不再伪装成 locked/current', () => {
  const { rootPath, foundation } = fixture();
  const canvasId = 'canvas-history-integrity';
  const artifact = create(foundation, 'history-script', 'original', [], { canvasId });
  lock(foundation, artifact.artifactVersionId);
  fs.writeFileSync(path.join(rootPath, 'artifacts', artifact.contentPath), 'tampered');

  const status = foundation.status({ canvasId, mode: 'legacy-history' });
  const historical = status.projection.history.artifacts[0];
  assert.equal(historical.integrity.valid, false);
  assert.equal(historical.validityState, 'invalid');
  assert.equal(historical.recordedValidityState, 'current');
  assert.equal(historical.locked, false);
  assert.equal(historical.contentPreview, '');
  assert.equal(status.recovery.healthy, false);
});

test('不同 canvasId 的产物与投影完全隔离，并拒绝跨画布依赖', () => {
  const { rootPath, foundation } = fixture();
  const canvasA = foundation.createArtifact({ logicalArtifactId: 'canvas-a-script', artifactType: 'script', content: 'A', operationId: 'canvas-a-create', metadata: { canvasId: 'canvas-a' } });
  const canvasB = foundation.createArtifact({ logicalArtifactId: 'canvas-b-script', artifactType: 'script', content: 'B', operationId: 'canvas-b-create', metadata: { canvasId: 'canvas-b' } });
  fs.writeFileSync(path.join(rootPath, 'artifacts', canvasB.contentPath), 'tampered-on-canvas-b');
  const canvasAStatus = foundation.status({ canvasId: 'canvas-a', mode: 'legacy-history' });
  assert.deepEqual(canvasAStatus.projection.history.artifacts.map(item => item.artifactVersionId), [canvasA.artifactVersionId]);
  assert.equal(canvasAStatus.recovery.healthy, true, '按 canvasId 读取不能泄漏其他画布的损坏状态');
  assert.equal(JSON.stringify(canvasAStatus).includes(canvasB.artifactVersionId), false);
  assert.equal(foundation.status({ canvasId: 'canvas-b' }).projection.artifactCount, 1);
  assert.throws(() => foundation.createArtifact({ logicalArtifactId: 'canvas-b-shot', artifactType: 'shot', content: 'shot', operationId: 'cross-canvas', metadata: { canvasId: 'canvas-b' }, inputRefs: [{ artifactVersionId: canvasA.artifactVersionId }] }), /跨画布/);
});

test('M3A：Session 事件追加同内容幂等、内容漂移冲突且拒绝 recolor scope', () => {
  const { rootPath, foundation } = fixture();
  const event = {
    workspaceScope: 'canvas-agent',
    canvasId: 'canvas-session-history',
    agentSessionId: 'agent-session-history-1',
    eventId: 'message-user-1',
    eventType: 'message',
    payload: { kind: 'document', text: '剧本只留在聊天历史，不生成画布文档节点' }
  };
  const first = foundation.appendSessionEvent(event);
  const repeated = foundation.appendSessionEvent({ ...event, payload: { text: event.payload.text, kind: 'document' } });
  assert.equal(first.idempotent, false);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.artifact.artifactVersionId, first.artifact.artifactVersionId);
  assert.equal(foundation.artifactStore.list({ canvasId: event.canvasId, artifactType: 'agent-session-event' }).length, 1);

  const restarted = createCanvasAgentFoundation({ rootPath });
  assert.equal(restarted.appendSessionEvent(event).idempotent, true);
  assert.throws(
    () => restarted.appendSessionEvent({ ...event, payload: { ...event.payload, text: '同 eventId 的另一份内容' } }),
    error => error?.code === 'SESSION_EVENT_CONFLICT' && error?.statusCode === 409
  );
  assert.throws(
    () => restarted.appendSessionEvent({ ...event, eventId: 'message-recolor', workspaceScope: 'recolor' }),
    error => error?.code === 'INVALID_SESSION_EVENT_SCOPE'
  );
  assert.throws(
    () => restarted.appendSessionEvent({ ...event, eventId: 'message-nested-recolor', payload: { workspaceScope: 'recolor', refId: 'recolor-asset-1' } }),
    error => error?.code === 'INVALID_SESSION_EVENT_SCOPE'
  );
  assert.throws(
    () => restarted.appendSessionEvent({ ...event, eventId: 'message-cross-canvas', payload: { reference: { canvasId: 'another-canvas' } } }),
    error => error?.code === 'SESSION_EVENT_IDENTITY_CONFLICT' && error?.statusCode === 409
  );
  assert.throws(
    () => restarted.appendSessionEvent({ ...event, eventId: 'message-cross-session', payload: { reference: { agentSessionId: 'another-session' } } }),
    error => error?.code === 'SESSION_EVENT_IDENTITY_CONFLICT' && error?.statusCode === 409
  );
});

test('M3A：Session 事件面对 operation receipt、索引和内容篡改均失败且不改依赖图', () => {
  const poisoned = fixture();
  const event = {
    workspaceScope: 'canvas-agent',
    canvasId: 'canvas-event-tamper',
    agentSessionId: 'agent-session-tamper',
    eventId: 'message-poisoned-operation',
    eventType: 'message',
    payload: { text: '必须精确落入当前会话' }
  };
  const decoy = create(poisoned.foundation, 'decoy-artifact', 'decoy', [], { canvasId: event.canvasId });
  const operationId = `session-event:${sha256({ canvasId: event.canvasId, agentSessionId: event.agentSessionId, eventId: event.eventId }).slice(0, 40)}`;
  const poisonedIndexPath = path.join(poisoned.rootPath, 'artifacts', 'artifact-index.json');
  const poisonedIndex = JSON.parse(fs.readFileSync(poisonedIndexPath, 'utf8'));
  poisonedIndex.operations[operationId] = decoy.artifactVersionId;
  fs.writeFileSync(poisonedIndexPath, `${JSON.stringify(poisonedIndex, null, 2)}\n`);
  const poisonedIndexBefore = fs.readFileSync(poisonedIndexPath);
  const poisonedGraphPath = path.join(poisoned.rootPath, 'dependency-graph.json');
  const poisonedGraphBefore = fs.readFileSync(poisonedGraphPath);
  assert.throws(
    () => poisoned.foundation.appendSessionEvent(event),
    error => error?.code === 'SESSION_EVENT_CONFLICT' && error?.statusCode === 409
  );
  assert.deepEqual(fs.readFileSync(poisonedIndexPath), poisonedIndexBefore);
  assert.deepEqual(fs.readFileSync(poisonedGraphPath), poisonedGraphBefore);

  const indexed = fixture();
  const indexedEvent = { ...event, eventId: 'message-index-tamper' };
  const indexedResult = indexed.foundation.appendSessionEvent(indexedEvent);
  const indexedPath = path.join(indexed.rootPath, 'artifacts', 'artifact-index.json');
  const indexedData = JSON.parse(fs.readFileSync(indexedPath, 'utf8'));
  indexedData.artifacts[indexedResult.artifact.artifactVersionId].metadata.agentSessionId = 'forged-session';
  fs.writeFileSync(indexedPath, `${JSON.stringify(indexedData, null, 2)}\n`);
  const indexedBefore = fs.readFileSync(indexedPath);
  const indexedGraphPath = path.join(indexed.rootPath, 'dependency-graph.json');
  const indexedGraphBefore = fs.readFileSync(indexedGraphPath);
  assert.throws(
    () => indexed.foundation.appendSessionEvent(indexedEvent),
    error => error?.code === 'SESSION_EVENT_CONFLICT' && error?.statusCode === 409
  );
  assert.deepEqual(fs.readFileSync(indexedPath), indexedBefore);
  assert.deepEqual(fs.readFileSync(indexedGraphPath), indexedGraphBefore);

  const content = fixture();
  const contentEvent = { ...event, eventId: 'message-content-tamper' };
  const contentResult = content.foundation.appendSessionEvent(contentEvent);
  const contentPath = path.join(content.rootPath, 'artifacts', contentResult.artifact.contentPath);
  fs.writeFileSync(contentPath, 'tampered-content');
  const contentIndexPath = path.join(content.rootPath, 'artifacts', 'artifact-index.json');
  const contentIndexBefore = fs.readFileSync(contentIndexPath);
  const contentGraphPath = path.join(content.rootPath, 'dependency-graph.json');
  const contentGraphBefore = fs.readFileSync(contentGraphPath);
  assert.throws(
    () => content.foundation.appendSessionEvent(contentEvent),
    error => error?.code === 'SESSION_EVENT_HISTORY_INVALID' && error?.statusCode === 409
  );
  assert.deepEqual(fs.readFileSync(contentIndexPath), contentIndexBefore);
  assert.deepEqual(fs.readFileSync(contentGraphPath), contentGraphBefore);
});

test('M3A：status 是按画布的只读观察，不写恢复报告或改运行记录', () => {
  const { rootPath, foundation } = fixture();
  const canvasId = 'canvas-read-only-status';
  create(foundation, 'read-only-script', 'A', [], { canvasId });
  foundation.recoveryAuditor.registerOperation({ operationId: 'running-observation', status: 'running', provider: 'test-provider' });
  const operationsPath = path.join(rootPath, 'execution-operations.json');
  const reportPath = path.join(rootPath, 'recovery-report.json');
  const operationsBefore = fs.readFileSync(operationsPath);
  assert.equal(fs.existsSync(reportPath), false);
  assert.equal(foundation.status({ canvasId }).recovery.healthy, true);
  assert.equal(foundation.status({ canvasId, mode: 'legacy-history' }).recovery.healthy, true);
  assert.deepEqual(fs.readFileSync(operationsPath), operationsBefore);
  assert.equal(fs.existsSync(reportPath), false);
});

test('状态 API 默认返回恢复报告、账本和零节点 session-workset', async () => {
  const { rootPath, foundation } = fixture();
  const canvasId = 'canvas-status-api';
  create(foundation, 'script', 'A', [], { canvasId });
  const app = express();
  app.use(express.json());
  app.use(createCanvasAgentFoundationRoutes({ outputRoot: rootPath, foundation }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/canvas-agent/foundation/status?canvasId=${canvasId}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.projection.artifactCount, 1);
    assert.equal(body.projection.mode, 'session-workset');
    assert.deepEqual(body.projection.nodes, []);
    assert.deepEqual(body.projection.edges, []);
    assert.equal(body.recovery.healthy, true);
    assert.equal(body.ledger.phases.length, 10);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
