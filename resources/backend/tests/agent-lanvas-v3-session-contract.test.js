'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const sessionServicePath = path.join(repoRoot, 'resources/backend/services/agentSessionService.js');
const sessionSource = fs.readFileSync(sessionServicePath, 'utf8');
const { createAgentSessionService } = require(sessionServicePath);

const SIGNED_SKILL = Object.freeze({
  skillRef: '@user_38ad8922/ecommerce-video-director-skill',
  signedVersion: '1.6.6',
  declaredVersion: '1.6.5',
  contentHash: 'a'.repeat(64),
  publisher: '@user_38ad8922'
});

function createService(rootPath, seed = 0) {
  let tick = 10_000 + seed;
  let sequence = seed;
  return createAgentSessionService({
    rootPath,
    clock: () => ++tick,
    makeId: prefix => `${prefix}-${++sequence}`
  });
}

function createSignedSession(service, overrides = {}) {
  return service.createSession({
    requestId: 'request-create-signed',
    canvasId: 'canvas-agent-a',
    workspaceScope: 'canvas-agent',
    mode: 'generation',
    title: '电商视频 AGENT',
    ...SIGNED_SKILL,
    ...overrides
  });
}

function hasCode(code, statusCode = 400) {
  return error => error?.code === code && error?.statusCode === statusCode;
}

test('M1：签名 Skill、画布工作区和运行模式成为 AgentSession 固定身份', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-identity-'));
  const service = createService(rootPath);
  const input = {
    requestId: 'request-create-signed',
    canvasId: 'canvas-agent-a',
    workspaceScope: 'canvas-agent',
    mode: 'generation',
    title: '电商视频 AGENT',
    constraints: { mediaDefaults: { imageModel: 'gpt-image-2', autoGenerateMedia: false } },
    ...SIGNED_SKILL
  };

  const created = service.createSession(input);
  assert.equal(created.idempotent, false);
  assert.equal(created.session.schemaVersion, 4);
  assert.equal(created.session.skillComposition, null);
  assert.deepEqual(created.session.generationRounds, []);
  assert.equal(created.session.workspaceScope, 'canvas-agent');
  assert.equal(created.session.mode, 'generation');
  assert.deepEqual(created.session.constraints, input.constraints);
  for (const [key, value] of Object.entries(SIGNED_SKILL)) assert.equal(created.session[key], value);

  assert.equal(service.createSession(input).idempotent, true);
  assert.throws(
    () => service.createSession({ ...input, mode: 'prompt-only' }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
  assert.throws(
    () => createSignedSession(service, { requestId: 'request-recolor', workspaceScope: 'recolor' }),
    hasCode('INVALID_WORKSPACE_SCOPE')
  );
  assert.throws(
    () => createSignedSession(service, { requestId: 'request-mode', mode: 'surprise-me' }),
    hasCode('INVALID_INPUT')
  );
  assert.throws(
    () => createSignedSession(service, { requestId: 'request-hash', contentHash: 'not-a-signed-hash' }),
    hasCode('INVALID_SKILL_SIGNATURE')
  );
});

test('U6：会话标题重命名幂等持久化，刷新列表和服务重启后保持一致', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-title-'));
  const service = createService(rootPath);
  const created = createSignedSession(service).session;

  const renamed = service.renameSession(created.id, {
    requestId: 'request-rename-session',
    title: '产品发布短片'
  });
  assert.equal(renamed.idempotent, false);
  assert.equal(renamed.session.title, '产品发布短片');
  assert.equal(service.listSessions('canvas-agent-a')[0].title, '产品发布短片');
  assert.equal(service.renameSession(created.id, {
    requestId: 'request-rename-session',
    title: '产品发布短片'
  }).idempotent, true);
  assert.throws(
    () => service.renameSession(created.id, { requestId: 'request-rename-session', title: '冲突名称' }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );
  assert.throws(
    () => service.renameSession(created.id, { requestId: 'request-empty-title', title: '   ' }),
    hasCode('INVALID_INPUT')
  );

  const restarted = createService(rootPath, 50);
  assert.equal(restarted.loadSession(created.id).title, '产品发布短片');
  assert.equal(restarted.listSessions('canvas-agent-a')[0].title, '产品发布短片');
});

test('M8R-3B：schema 1 状态原位迁移到 schema 4，旧 Skill 只等待下一次发送时绑定组合', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-migration-'));
  const storePath = path.join(rootPath, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schemaVersion: 1,
    sessions: [{
      id: 'agent-session-legacy',
      canvasId: 'canvas-legacy',
      skillId: 'story-tvc',
      title: '旧会话',
      status: 'collecting',
      messages: [{ id: 'message-legacy', role: 'user', kind: 'text', content: '保留我', attachments: [], createdAt: 1 }],
      toolRuns: [{ id: 'tool-legacy', type: 'image-generation', status: 'succeeded', createdAt: 2, updatedAt: 3 }],
      currentNodeRefs: [{ nodeId: 'node-legacy', kind: 'image', role: 'asset', attachedAt: 4 }],
      revision: 7,
      createdAt: 1,
      updatedAt: 4,
      requestReceipts: {}
    }],
    createReceipts: {},
    updatedAt: 4
  }, null, 2), 'utf8');

  const service = createService(rootPath, 100);
  const migrated = service.loadSession('agent-session-legacy');
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.skillComposition, null);
  assert.equal(migrated.workspaceScope, 'canvas-agent');
  assert.equal(migrated.messages[0].content, '保留我');
  assert.equal(migrated.toolRuns[0].id, 'tool-legacy');
  assert.equal(migrated.currentNodeRefs[0].nodeId, 'node-legacy');
  assert.equal(migrated.revision, 7);
  assert.deepEqual(migrated.plan, {});
  assert.deepEqual(migrated.approvals, []);
  assert.deepEqual(migrated.executionAuthorizations, []);
  assert.deepEqual(migrated.historyRefs, []);
  assert.deepEqual(migrated.generationRounds, []);

  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(persisted.schemaVersion, 4);
  assert.equal(persisted.sessions[0].schemaVersion, 4);
  assert.equal(persisted.sessions[0].revision, 7, '兼容迁移不得伪造一次业务修订');
});

test('M5E-1：schema 2 迁移不猜测历史 Round，旧执行真相字节语义不变', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-schema2-'));
  const originalService = createService(rootPath, 150);
  const sessionId = createSignedSession(originalService).session.id;
  originalService.upsertToolRun(sessionId, 'tool-existing-image', {
    requestId: 'request-existing-image',
    type: 'native-image',
    status: 'succeeded',
    nodeId: 'node-existing-image',
    provider: 'fixture-provider',
    model: 'fixture-image-model',
    operationId: 'operation-existing-image',
    inputVersion: 'input-existing-image',
    inputHash: '9'.repeat(64),
    quantity: 1,
    estimatedCost: 0,
    approvedBudget: 0,
    retryBudget: 0,
    attempt: 1,
    remoteTaskId: 'remote-existing-image'
  });
  originalService.attachCurrentNode(sessionId, 'node-existing-image', {
    requestId: 'request-existing-node',
    workspaceScope: 'canvas-agent',
    kind: 'image',
    nodeRole: 'asset',
    toolRunId: 'tool-existing-image'
  });

  const storePath = path.join(rootPath, 'sessions.json');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  stored.schemaVersion = 2;
  stored.sessions[0].schemaVersion = 2;
  delete stored.sessions[0].generationRounds;
  const protectedFacts = JSON.stringify({
    messages: stored.sessions[0].messages,
    toolRuns: stored.sessions[0].toolRuns,
    currentNodeRefs: stored.sessions[0].currentNodeRefs,
    executionAuthorizations: stored.sessions[0].executionAuthorizations
  });
  fs.writeFileSync(storePath, JSON.stringify(stored, null, 2), 'utf8');

  const migrated = createService(rootPath, 175).loadSession(sessionId);
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.skillComposition, null);
  assert.deepEqual(migrated.generationRounds, []);
  assert.equal(JSON.stringify({
    messages: migrated.messages,
    toolRuns: migrated.toolRuns,
    currentNodeRefs: migrated.currentNodeRefs,
    executionAuthorizations: migrated.executionAuthorizations
  }), protectedFacts);
});

test('M5E-1：GenerationRound 创建、锁定、批准、状态和 item 更新均原子幂等', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-round-'));
  const service = createService(rootPath, 180);
  const sessionId = createSignedSession(service).session.id;
  service.appendMessage(sessionId, {
    requestId: 'request-round-source-message',
    eventId: 'event-create-assets',
    role: 'user',
    kind: 'text',
    content: '生成一张猫图'
  });
  const createInput = {
    requestId: 'request-round-create',
    roundId: 'generation-round-assets',
    sourceMessageEventId: 'event-create-assets',
    mode: 'manual'
  };
  const created = service.createGenerationRound(sessionId, createInput);
  assert.equal(created.idempotent, false);
  assert.equal(created.round.status, 'planning');
  assert.equal(created.session.generationRounds.length, 1);
  assert.equal(service.createGenerationRound(sessionId, createInput).idempotent, true);
  assert.throws(
    () => service.createGenerationRound(sessionId, { ...createInput, mode: 'automatic' }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );

  const commitInput = {
    requestId: 'request-round-commit',
    planRevision: 1,
    stages: [{ stageId: 'stage-assets', label: '资产' }],
    items: [{
      itemId: 'item-image-1',
      stageId: 'stage-assets',
      kind: 'image',
      prompt: '一只猫',
      promptVersion: 'prompt-v1',
      provider: 'fixture-provider',
      model: 'fixture-image-model',
      spec: { size: '1K', aspectRatio: '1:1' },
      quantity: 1,
      dependsOn: []
    }]
  };
  const committed = service.commitGenerationRound(sessionId, createInput.roundId, commitInput);
  assert.equal(committed.round.status, 'awaiting-approval');
  assert.equal(committed.round.planRevision, 1);
  assert.match(committed.round.planHash, /^[a-f0-9]{64}$/);
  assert.equal(committed.round.items[0].quantity, 1);
  assert.equal(service.commitGenerationRound(sessionId, createInput.roundId, commitInput).idempotent, true);
  assert.throws(
    () => service.commitGenerationRound(sessionId, createInput.roundId, {
      ...commitInput,
      items: [{ ...commitInput.items[0], prompt: '另一只猫' }]
    }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );

  const approved = service.approveGenerationRound(sessionId, createInput.roundId, {
    requestId: 'request-round-approve',
    planRevision: committed.round.planRevision,
    planHash: committed.round.planHash
  });
  assert.equal(approved.round.status, 'approved');
  assert.equal(service.approveGenerationRound(sessionId, createInput.roundId, {
    requestId: 'request-round-approve',
    planRevision: committed.round.planRevision,
    planHash: committed.round.planHash
  }).idempotent, true);

  assert.equal(service.updateGenerationRoundStatus(sessionId, createInput.roundId, {
    requestId: 'request-round-running',
    status: 'running'
  }).round.status, 'running');
  const queued = service.updateGenerationRoundItem(sessionId, createInput.roundId, 'item-image-1', {
    requestId: 'request-round-item-queued',
    status: 'queued',
    toolRunId: 'tool-image-1',
    nodeId: 'node-image-1',
    operationId: 'operation-image-1',
    inputHash: '8'.repeat(64)
  });
  assert.equal(queued.round.items[0].toolRunId, 'tool-image-1');
  assert.equal(queued.round.items[0].status, 'queued');
  assert.equal(service.updateGenerationRoundItem(sessionId, createInput.roundId, 'item-image-1', {
    requestId: 'request-round-item-complete',
    status: 'succeeded',
    remoteTaskId: 'remote-image-1'
  }).round.items[0].status, 'succeeded');
  assert.equal(service.updateGenerationRoundStatus(sessionId, createInput.roundId, {
    requestId: 'request-round-complete',
    status: 'completed'
  }).round.status, 'completed');
});

test('M5E-1：取消关闭轮次，已批准计划损坏时读取失败关闭', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-round-cancel-'));
  const service = createService(rootPath, 190);
  const sessionId = createSignedSession(service).session.id;
  service.appendMessage(sessionId, {
    requestId: 'request-round-cancel-source',
    eventId: 'event-round-cancel',
    role: 'user',
    kind: 'text',
    content: '生成后取消'
  });
  service.createGenerationRound(sessionId, {
    requestId: 'request-round-cancel-create',
    roundId: 'generation-round-cancel',
    sourceMessageEventId: 'event-round-cancel',
    mode: 'automatic'
  });
  const cancelled = service.cancelGenerationRound(sessionId, 'generation-round-cancel', {
    requestId: 'request-round-cancel',
    reason: '用户取消'
  });
  assert.equal(cancelled.round.status, 'cancelled');
  assert.equal(service.cancelGenerationRound(sessionId, 'generation-round-cancel', {
    requestId: 'request-round-cancel',
    reason: '用户取消'
  }).idempotent, true);
  assert.throws(
    () => service.updateGenerationRoundStatus(sessionId, 'generation-round-cancel', {
      requestId: 'request-round-reopen',
      status: 'running'
    }),
    hasCode('INVALID_GENERATION_ROUND_TRANSITION', 409)
  );

  service.appendMessage(sessionId, {
    requestId: 'request-round-failed-source',
    eventId: 'event-round-failed',
    role: 'user',
    kind: 'text',
    content: '非法计划必须闭合'
  });
  service.createGenerationRound(sessionId, {
    requestId: 'request-round-failed-create',
    roundId: 'generation-round-failed',
    sourceMessageEventId: 'event-round-failed',
    mode: 'automatic'
  });
  const failed = service.updateGenerationRoundStatus(sessionId, 'generation-round-failed', {
    requestId: 'request-round-planning-failed',
    status: 'failed',
    failureSummary: '非法计划'
  });
  assert.equal(failed.round.status, 'failed');
  assert.equal(failed.round.planHash, '');

  const storePath = path.join(rootPath, 'sessions.json');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  stored.sessions[0].generationRounds[0] = {
    ...stored.sessions[0].generationRounds[0],
    status: 'approved',
    planRevision: 1,
    planHash: '',
    stages: [{ stageId: 'stage-corrupt' }],
    items: []
  };
  fs.writeFileSync(storePath, JSON.stringify(stored, null, 2), 'utf8');
  assert.throws(
    () => createService(rootPath, 195).loadSession(sessionId),
    hasCode('CORRUPT_GENERATION_ROUND_PLAN', 500)
  );
});

test('M1：会话快照有界且完成后仍能继续聊天，只有取消才不可重开', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-chat-'));
  const service = createService(rootPath, 200);
  const sessionId = createSignedSession(service).session.id;
  const state = service.setStatus(sessionId, {
    requestId: 'request-state-1',
    status: 'collecting',
    currentPhase: 'brief',
    plan: { steps: ['确认需求', '生成资产'] },
    constraints: { durationSeconds: 15, aspectRatio: '9:16' },
    safeBoundary: { kind: 'before-paid-submit', nextAction: 'ask-user' },
    approvals: [{ id: 'approval-1', status: 'pending' }],
    historyRefs: ['history-1']
  }).session;
  assert.deepEqual(state.plan.steps, ['确认需求', '生成资产']);
  assert.equal(state.constraints.durationSeconds, 15);
  assert.equal(state.safeBoundary.kind, 'before-paid-submit');
  assert.equal(state.approvals[0].status, 'pending');
  assert.deepEqual(state.historyRefs, ['history-1']);

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => service.setStatus(sessionId, { requestId: 'request-circular', status: 'collecting', plan: circular }),
    hasCode('INVALID_JSON_SNAPSHOT')
  );
  assert.throws(
    () => service.setStatus(sessionId, {
      requestId: 'request-oversized',
      status: 'collecting',
      constraints: { note: 'x'.repeat(120_000) }
    }),
    hasCode('SNAPSHOT_TOO_LARGE')
  );

  service.setStatus(sessionId, { requestId: 'request-completed', status: 'completed' });
  const resumed = service.appendMessage(sessionId, {
    requestId: 'request-message-after-complete',
    eventId: 'event-message-after-complete',
    role: 'user',
    kind: 'text',
    content: '再调整一下片尾'
  });
  assert.equal(resumed.session.status, 'collecting');
  assert.equal(resumed.session.messages.at(-1).eventId, 'event-message-after-complete');
  assert.equal(resumed.session.messages.at(-1).requestId, 'request-message-after-complete');

  service.setStatus(sessionId, { requestId: 'request-cancelled', status: 'cancelled' });
  assert.throws(
    () => service.appendMessage(sessionId, {
      requestId: 'request-message-after-cancel',
      role: 'user',
      kind: 'text',
      content: '不应写入'
    }),
    hasCode('SESSION_CANCELLED', 409)
  );
  assert.throws(
    () => service.setStatus(sessionId, { requestId: 'request-reopen-cancelled', status: 'collecting' }),
    hasCode('INVALID_SESSION_TRANSITION', 409)
  );
});

test('M2E：可信执行授权与 toolRun 在同一次 Session 写入中提交，UI approvals 不能替代它', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-approval-'));
  const service = createService(rootPath, 250);
  const sessionId = createSignedSession(service).session.id;
  service.upsertToolRun(sessionId, 'tool-session-guard-1', {
    requestId: 'request-awaiting-session-guard',
    type: 'native-image',
    status: 'awaiting-approval',
    nodeId: 'node-session-guard-1',
    provider: 'fixture-provider',
    model: 'fixture-image-model',
    operationId: 'operation-session-guard-1',
    inputVersion: 'input-version-guard-1',
    inputHash: 'd'.repeat(64),
    quantity: 1,
    estimatedCost: 4,
    approvedBudget: 4,
    retryBudget: 0,
    attempt: 0
  });
  const receipt = {
    allowed: true,
    authorizationId: 'auth-session-guard-1',
    signature: 'e'.repeat(64),
    authorizedBy: 'user',
    authorizedAt: 12_300,
    consumedAt: 12_345,
    request: {
      operationId: 'operation-session-guard-1',
      provider: 'fixture-provider',
      model: 'fixture-image-model',
      inputVersionIds: ['input-version-guard-1'],
      quantity: 1,
      estimatedCost: 4,
      budgetLimit: 4,
      retryLimit: 0,
      allowFallback: false,
      agentSessionId: sessionId,
      toolRunId: 'tool-session-guard-1',
      nodeId: 'node-session-guard-1',
      taskKind: 'image',
      inputHash: 'd'.repeat(64)
    }
  };
  const input = { requestId: 'request-record-consumed-approval', authorization: receipt };
  const recorded = service.commitExecutionAuthorization(sessionId, 'tool-session-guard-1', input);
  assert.equal(recorded.idempotent, false);
  assert.equal(recorded.session.approvals.length, 0);
  assert.equal(recorded.session.executionAuthorizations.length, 1);
  assert.equal(recorded.session.executionAuthorizations[0].source, 'execution-guard');
  assert.equal(recorded.session.executionAuthorizations[0].authorizationId, receipt.authorizationId);
  assert.equal(recorded.session.toolRuns[0].status, 'queued');
  assert.equal(recorded.session.toolRuns[0].authorizationId, receipt.authorizationId);
  assert.equal(recorded.session.toolRuns[0].authorizationState, 'consumed');
  assert.equal(service.commitExecutionAuthorization(sessionId, 'tool-session-guard-1', input).idempotent, true);

  assert.throws(
    () => service.commitExecutionAuthorization(sessionId, 'tool-session-guard-1', {
      requestId: 'request-unconsumed-approval',
      authorization: { ...receipt, authorizationId: 'auth-unconsumed', consumedAt: 0 }
    }),
    hasCode('INVALID_CONSUMED_AUTHORIZATION')
  );
  assert.throws(
    () => service.commitExecutionAuthorization(sessionId, 'tool-session-guard-1', {
      requestId: 'request-cross-session-approval',
      authorization: {
        ...receipt,
        authorizationId: 'auth-cross-session',
        request: { ...receipt.request, agentSessionId: 'another-agent-session' }
      }
    }),
    hasCode('AUTHORIZATION_SESSION_CONFLICT', 409)
  );
});

test('M1：付费审批字段受界限约束，提交后 Provider 与输入绑定不可漂移', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-paid-'));
  const service = createService(rootPath, 300);
  const sessionId = createSignedSession(service).session.id;
  const binding = {
    type: 'video-generation',
    provider: 'fixture-provider',
    model: 'fixture-video-model',
    operationId: 'operation-video-1',
    inputVersion: 'input-version-1',
    inputHash: 'b'.repeat(64),
    quantity: 1,
    estimatedCost: 8,
    approvedBudget: 10,
    retryBudget: 0,
    attempt: 0
  };

  assert.throws(
    () => service.upsertToolRun(sessionId, 'tool-awaiting-remote', {
      requestId: 'request-awaiting-remote',
      ...binding,
      status: 'awaiting-approval',
      remoteTaskId: 'must-not-exist-yet'
    }),
    hasCode('REMOTE_TASK_BEFORE_APPROVAL')
  );
  assert.throws(
    () => service.upsertToolRun(sessionId, 'tool-over-budget', {
      requestId: 'request-over-budget',
      ...binding,
      status: 'awaiting-approval',
      approvedBudget: 7
    }),
    hasCode('APPROVED_BUDGET_TOO_LOW')
  );
  assert.throws(
    () => service.upsertToolRun(sessionId, 'tool-negative-retry', {
      requestId: 'request-negative-retry',
      ...binding,
      status: 'awaiting-approval',
      retryBudget: -1
    }),
    hasCode('INVALID_NUMERIC_BOUND')
  );
  assert.throws(
    () => service.upsertToolRun(sessionId, 'tool-missing-binding', {
      requestId: 'request-missing-binding',
      type: 'video-generation',
      status: 'submitting'
    }),
    hasCode('MISSING_EXECUTION_BINDING')
  );

  const awaitingInput = {
    requestId: 'request-awaiting-valid',
    ...binding,
    status: 'awaiting-approval'
  };
  const awaiting = service.upsertToolRun(sessionId, 'tool-video-1', awaitingInput);
  assert.equal(awaiting.session.toolRuns[0].status, 'awaiting-approval');
  assert.equal(service.upsertToolRun(sessionId, 'tool-video-1', awaitingInput).idempotent, true);
  assert.throws(
    () => service.upsertToolRun(sessionId, 'tool-video-1', { ...awaitingInput, approvedBudget: 12 }),
    hasCode('IDEMPOTENCY_CONFLICT', 409)
  );

  const submitting = service.upsertToolRun(sessionId, 'tool-video-1', {
    requestId: 'request-submitting-valid',
    ...binding,
    status: 'submitting',
    remoteTaskId: 'remote-video-1',
    attempt: 1
  }).session.toolRuns[0];
  assert.equal(submitting.remoteTaskId, 'remote-video-1');
  assert.equal(submitting.model, binding.model);

  assert.throws(
    () => service.upsertToolRun(sessionId, 'tool-video-1', {
      requestId: 'request-change-binding',
      status: 'running',
      model: 'another-model'
    }),
    hasCode('IMMUTABLE_EXECUTION_BINDING', 409)
  );

  const running = service.upsertToolRun(sessionId, 'tool-video-1', {
    requestId: 'request-running-valid',
    status: 'running'
  }).session.toolRuns[0];
  assert.equal(running.model, binding.model);
  assert.equal(running.inputHash, binding.inputHash);
});

test('M1：当前节点引用表达分支、替代与最终交付，移除后仍保留后台引用', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-nodes-'));
  const service = createService(rootPath, 400);
  const sessionId = createSignedSession(service).session.id;

  const attached = service.attachCurrentNode(sessionId, 'node-video-v2', {
    requestId: 'request-node-v2',
    workspaceScope: 'canvas-agent',
    kind: 'video',
    nodeRole: 'final-video',
    toolRunId: 'tool-video-1',
    assetVersionId: 'asset-version-2',
    parentNodeRef: 'node-video-v1',
    branchRootRef: 'node-video-v1',
    supersedesRef: 'node-video-v1',
    finalDelivery: true
  }).session;
  const nodeRef = attached.currentNodeRefs[0];
  assert.equal(nodeRef.workspaceScope, 'canvas-agent');
  assert.equal(nodeRef.nodeRole, 'final-video');
  assert.equal(nodeRef.parentNodeRef, 'node-video-v1');
  assert.equal(nodeRef.branchRootRef, 'node-video-v1');
  assert.equal(nodeRef.supersedesRef, 'node-video-v1');
  assert.equal(nodeRef.finalDelivery, true);
  assert.equal(attached.finalDeliveryRef, 'node-video-v2');

  assert.throws(
    () => service.attachCurrentNode(sessionId, 'node-recolor', {
      requestId: 'request-node-recolor',
      workspaceScope: 'recolor',
      kind: 'image'
    }),
    hasCode('INVALID_WORKSPACE_SCOPE')
  );

  const detached = service.detachCurrentNode(sessionId, 'node-video-v2', { requestId: 'request-node-detach-v2' }).session;
  assert.equal(detached.currentNodeRefs.length, 0);
  assert.equal(detached.detachedNodeRefs.length, 1);
  assert.equal(detached.detachedNodeRefs[0].nodeId, 'node-video-v2');
  assert.ok(detached.detachedNodeRefs[0].detachedAt > nodeRef.attachedAt);
});

test('M1：重启只把未决远端任务标为待核对，保留远端 ID 且绝不自动重发', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-v3-recovery-'));
  const service = createService(rootPath, 500);
  const sessionId = createSignedSession(service).session.id;
  service.setStatus(sessionId, { requestId: 'request-session-running', status: 'running' });
  const before = service.upsertToolRun(sessionId, 'tool-video-remote', {
    requestId: 'request-tool-submitting',
    type: 'video-generation',
    status: 'submitting',
    provider: 'fixture-provider',
    model: 'fixture-video-model',
    operationId: 'operation-recovery-1',
    inputVersion: 'input-version-recovery-1',
    inputHash: 'c'.repeat(64),
    quantity: 1,
    estimatedCost: 5,
    approvedBudget: 5,
    retryBudget: 0,
    attempt: 1,
    remoteTaskId: 'remote-task-preserved'
  }).session;

  assert.doesNotMatch(
    sessionSource,
    /\bfetch\s*\(|require\(['"]node:https?['"]\)|providerExecutor|generate(?:Image|Video)/,
    'AgentSession 状态服务不得包含网络或 Provider 执行入口'
  );
  const recovered = createService(rootPath, 600).loadSession(sessionId);
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.recoveryStatus, 'reconcile-required');
  assert.equal(recovered.reconcileRequired, true);
  assert.equal(recovered.toolRuns[0].status, 'remote-unknown');
  assert.equal(recovered.toolRuns[0].remoteTaskId, 'remote-task-preserved');
  assert.equal(recovered.toolRuns[0].recoveryReason, 'service-restart');
  assert.ok(recovered.revision > before.revision);

  const recoveredAgain = createService(rootPath, 700).loadSession(sessionId);
  assert.equal(recoveredAgain.revision, recovered.revision, '重复启动不得重复制造恢复事件');
  assert.equal(recoveredAgain.toolRuns[0].remoteTaskId, 'remote-task-preserved');
});
