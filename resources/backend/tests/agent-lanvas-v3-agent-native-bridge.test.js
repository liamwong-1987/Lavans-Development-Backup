'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../../..');
const bridgePath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/agent-native-node-bridge.js');
const htmlPath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas.html');
const corePath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js');
const routesPath = path.join(repoRoot, 'resources/backend/routes/canvasRoutes.js');

function bridgeModule() {
  delete require.cache[require.resolve(bridgePath)];
  return require(bridgePath);
}

function fixtureInput(overrides = {}) {
  return {
    workspaceScope: 'canvas-agent',
    agentSessionId: 'agent-session-bridge-1',
    toolRunId: 'tool-run-bridge-1',
    nodeId: 'node-bridge-1',
    sourceNodeId: 'node-source-1',
    operationId: 'operation-bridge-1',
    inputVersion: 'input-v1',
    inputHash: 'a'.repeat(64),
    providerId: 'fixture-provider',
    model: 'fixture-model',
    kind: 'image',
    nodeRole: 'storyboard-frame',
    branchRootRef: 'node-bridge-1',
    quantity: 1,
    estimatedCost: 12,
    approvedBudget: 12,
    retryBudget: 0,
    authorizationId: 'auth-bridge-1',
    inputRefs: [{ refId: 'asset-canvas-1', workspaceScope: 'canvas' }],
    taskPayload: { prompt: 'fixture prompt', size: '1024x1024' },
    ...overrides
  };
}

function fixturePorts(options = {}) {
  const calls = [];
  let nodeReadCount = 0;
  const kind = options.kind || 'image';
  const executionPayload = options.executionPayload || (kind === 'video'
    ? { prompt: 'fixture video prompt', duration: 5, resolution: '480p', aspect_ratio: '9:16', images: [] }
    : { prompt: 'fixture prompt', size: '1024x1024' });
  const inputRefs = options.inputRefs || [{ refId: 'asset-canvas-1', workspaceScope: 'canvas' }];
  const hasRemoteTaskId = Object.prototype.hasOwnProperty.call(options, 'remoteTaskId');
  const remoteTaskId = hasRemoteTaskId ? options.remoteTaskId : 'canvas-task-existing';
  const toolRun = {
    id: 'tool-run-bridge-1',
    type: `native-${kind}`,
    status: options.toolStatus || 'queued',
    nodeId: 'node-bridge-1',
    provider: 'fixture-provider',
    model: 'fixture-model',
    operationId: 'operation-bridge-1',
    inputVersion: 'input-v1',
    inputHash: 'a'.repeat(64),
    quantity: 1,
    estimatedCost: 12,
    approvedBudget: 12,
    retryBudget: 0,
    attempt: 1,
    authorizationId: 'auth-bridge-1',
    authorizationState: 'consumed',
    executionPayload,
    inputRefs,
    remoteTaskId
  };
  const authorization = {
    source: 'execution-guard',
    allowed: true,
    authorizationId: 'auth-bridge-1',
    signature: 'c'.repeat(64),
    authorizedBy: 'fixture-user',
    authorizedAt: 100,
    consumedAt: 123,
    request: {
      operationId: 'operation-bridge-1',
      provider: 'fixture-provider',
      model: 'fixture-model',
      inputVersionIds: ['input-v1'],
      quantity: 1,
      estimatedCost: 12,
      budgetLimit: 12,
      currency: 'CNY',
      retryLimit: 0,
      executionMode: 'manual',
      allowFallback: false,
      fallbackProvider: '',
      fallbackModel: '',
      reviewGateId: 'agent-session:agent-session-bridge-1:tool-run-bridge-1',
      highPriceThreshold: null,
      highPriceConfirmed: false,
      agentSessionId: 'agent-session-bridge-1',
      toolRunId: 'tool-run-bridge-1',
      nodeId: 'node-bridge-1',
      taskKind: kind,
      inputHash: 'a'.repeat(64)
    }
  };
  const session = {
    id: 'agent-session-bridge-1',
    workspaceScope: 'canvas-agent',
    approvals: options.approvals || [],
    executionAuthorizations: options.executionAuthorizations === undefined ? [authorization] : options.executionAuthorizations,
    toolRuns: options.initialToolRun === false ? [] : [toolRun],
    currentNodeRefs: [{ nodeId: 'node-bridge-1', toolRunId: 'tool-run-bridge-1', workspaceScope: 'canvas-agent', kind }],
    detachedNodeRefs: []
  };
  const sessionPort = {
    async getSession(agentSessionId) {
      calls.push({ name: 'session:get', agentSessionId });
      return { session };
    },
    async upsertToolRun(agentSessionId, toolRunId, payload) {
      calls.push({ name: `session:${payload.status}`, agentSessionId, toolRunId, payload });
      let target = session.toolRuns.find(item => item.id === toolRunId);
      if (!target) {
        target = { id: toolRunId };
        session.toolRuns.push(target);
      }
      Object.assign(target, payload, { id: toolRunId });
      return { session };
    },
    async attachCurrentNode(agentSessionId, nodeId, payload) {
      calls.push({ name: 'session:attach-node', agentSessionId, nodeId, payload });
      return { session };
    },
    async detachCurrentNode(agentSessionId, nodeId, payload) {
      calls.push({ name: 'session:detach-node', agentSessionId, nodeId, payload });
      const existing = session.currentNodeRefs.find(item => item.nodeId === nodeId);
      if (existing && !session.detachedNodeRefs.some(item => item.nodeId === nodeId)) session.detachedNodeRefs.push({ ...existing, detachedAt: 456 });
      session.currentNodeRefs = session.currentNodeRefs.filter(item => item.nodeId !== nodeId);
      return { session, idempotent: !existing };
    }
  };
  const host = Object.freeze({
    capabilities: Object.freeze({ workspaceScope: 'canvas-agent', submitsProviderTasks: false }),
    async createPlaceholder(input) {
      calls.push({ name: 'host:create-placeholder', input });
      return { node: { nodeId: input.nodeId, taskState: { status: 'queued' } } };
    },
    async attachTask(input) {
      calls.push({ name: 'host:attach-task', input });
      return { node: { nodeId: input.nodeId, taskState: { status: 'running' } } };
    },
    async markRemoteUnknown(input) {
      calls.push({ name: 'host:remote-unknown', input });
      return { node: { nodeId: input.nodeId, taskState: { status: 'waiting' } } };
    },
    async resumeTask(input) {
      calls.push({ name: 'host:resume-task', input });
      return { node: { nodeId: input.nodeId } };
    },
    async getNode(input) {
      calls.push({ name: 'host:get-node', input });
      const readIndex = nodeReadCount++;
      const matchingToolRun = session.toolRuns.find(item => item.nodeId === input.nodeId);
      const matchingRemoteTaskId = matchingToolRun?.remoteTaskId || remoteTaskId;
      const pendingTaskId = options.nodeTaskId === null ? '' : (options.nodeTaskId || matchingRemoteTaskId || 'canvas-task-existing');
      const nodeKind = options.nodeKind || kind;
      const taskType = options.nodeTaskType || (nodeKind === 'video' ? 'video' : 'agent-native');
      return {
        node: {
          nodeId: input.nodeId,
          kind: nodeKind,
          agentNative: { kind: nodeKind },
          taskState: { status: options.nodeStatuses?.[readIndex] || options.nodeStatus || 'completed' },
          pendingTasks: pendingTaskId ? [{ taskId: pendingTaskId, kind: nodeKind, taskType, remoteTaskId: options.pendingRemoteTaskId || matchingRemoteTaskId || '' }] : []
        }
      };
    }
  });
  const taskPort = {
    async submit(input) {
      calls.push({ name: 'task:submit', input });
      if (options.submitErrors?.[input.nodeId]) throw options.submitErrors[input.nodeId];
      if (options.submitError) throw options.submitError;
      return options.receipt || { taskId: 'canvas-task-1', remoteTaskId: '', status: 'running', idempotent: false };
    }
  };
  return { calls, sessionPort, host, taskPort, session };
}

function roundStageInput(index, overrides = {}) {
  return fixtureInput({
    toolRunId: `tool-run-stage-${index}`,
    nodeId: `node-stage-${index}`,
    sourceNodeId: '',
    operationId: `operation-stage-${index}`,
    inputVersion: `input-stage-${index}`,
    inputHash: String(index).repeat(64),
    authorizationId: `item-auth-stage-${index}`,
    branchRootRef: `node-stage-${index}`,
    taskPayload: { prompt: `stage prompt ${index}`, size: '1024x1024' },
    ...overrides
  });
}

function installRoundStage(ports, inputs, statuses = {}) {
  ports.session.toolRuns = inputs.map(input => ({
    id: input.toolRunId,
    type: `native-${input.kind}`,
    status: statuses[input.nodeId] || 'queued',
    nodeId: input.nodeId,
    provider: input.providerId,
    model: input.model,
    operationId: input.operationId,
    inputVersion: input.inputVersion,
    inputHash: input.inputHash,
    quantity: input.quantity,
    estimatedCost: input.estimatedCost,
    approvedBudget: input.approvedBudget,
    retryBudget: input.retryBudget,
    attempt: 1,
    currency: 'CNY',
    authorizationId: input.authorizationId,
    authorizationState: 'consumed',
    executionPayload: input.taskPayload,
    inputRefs: input.inputRefs,
    remoteTaskId: statuses[input.nodeId] === 'remote-unknown' ? `remote-${input.nodeId}` : ''
  }));
  ports.session.executionAuthorizations = inputs.map((input, index) => ({
    source: 'execution-guard',
    authorizationType: 'round-item-child',
    allowed: true,
    authorizationId: input.authorizationId,
    parentAuthorizationId: 'round-auth-stage-1',
    signature: String.fromCharCode(99 + index).repeat(64),
    authorizedBy: 'fixture-user',
    authorizedAt: 100,
    consumedAt: 123,
    request: {
      operationId: input.operationId,
      provider: input.providerId,
      model: input.model,
      inputVersionIds: ['plan-stage-v1', input.inputVersion].sort(),
      quantity: input.quantity,
      estimatedCost: input.estimatedCost,
      budgetLimit: input.approvedBudget,
      currency: 'CNY',
      retryLimit: input.retryBudget,
      executionMode: 'manual',
      allowFallback: false,
      fallbackProvider: '',
      fallbackModel: '',
      reviewGateId: 'generation-round-review',
      highPriceThreshold: null,
      highPriceConfirmed: false,
      agentSessionId: input.agentSessionId,
      toolRunId: input.toolRunId,
      nodeId: input.nodeId,
      taskKind: input.kind,
      inputHash: input.inputHash,
      parentAuthorizationId: 'round-auth-stage-1',
      roundId: 'round-stage-1',
      planRevision: 4,
      planHash: 'f'.repeat(64),
      planArtifactVersionId: 'plan-stage-v1',
      itemId: `item-stage-${index + 1}`,
      stageId: 'stage-images'
    }
  }));
  ports.session.currentNodeRefs = inputs.map(input => ({
    nodeId: input.nodeId,
    toolRunId: input.toolRunId,
    workspaceScope: 'canvas-agent'
  }));
}

test('M2D：Bridge 冻结、无 UI 状态、只执行已批准的 canvas-agent 图片或视频', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts();
  const bridge = createAgentNativeNodeBridge(ports);
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal(Object.isFrozen(bridge.capabilities), true);
  assert.equal(bridge.capabilities.workspaceScope, 'canvas-agent');
  assert.equal(bridge.capabilities.persistentUiState, false);
  assert.equal(bridge.capabilities.recoverySubmits, false);
  assert.deepEqual(Object.keys(bridge).sort(), ['capabilities', 'detachCurrentNode', 'execute', 'executeStage', 'recover']);
  await assert.rejects(() => bridge.execute(fixtureInput({ workspaceScope: 'recolor' })), error => error?.code === 'INVALID_WORKSPACE_SCOPE');
  await assert.rejects(() => bridge.execute(fixtureInput({ authorizationId: undefined })), error => error?.code === 'APPROVAL_REQUIRED');
  await assert.rejects(() => bridge.execute(fixtureInput({ kind: 'document' })), error => error?.code === 'INVALID_TASK_KIND');
  assert.equal(ports.calls.length, 0, '文档、未批准或跨工作区输入不得写 Session、创建节点或提交任务');
});

test('M2D：Bridge 只接受 Session 已排队且安全门已消费的授权，不能自行批准 toolRun', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ executionAuthorizations: [] });
  const bridge = createAgentNativeNodeBridge(ports);
  await assert.rejects(() => bridge.execute(fixtureInput()), error => error?.code === 'APPROVAL_REQUIRED');
  assert.deepEqual(ports.calls.map(call => call.name), ['session:get']);
  assert.equal(ports.session.toolRuns[0].status, 'queued');
  assert.equal(ports.calls.some(call => call.name === 'host:create-placeholder' || call.name === 'task:submit'), false);

  const noReservation = fixturePorts({ initialToolRun: false });
  const noReservationBridge = createAgentNativeNodeBridge(noReservation);
  await assert.rejects(() => noReservationBridge.execute(fixtureInput()), error => error?.code === 'TOOL_RUN_NOT_PREPARED');
  assert.deepEqual(noReservation.calls.map(call => call.name), ['session:get']);

  const forgedUiApproval = fixturePorts({
    executionAuthorizations: [],
    approvals: [{ allowed: true, authorizationId: 'auth-bridge-1', consumedAt: 123 }]
  });
  await assert.rejects(
    () => createAgentNativeNodeBridge(forgedUiApproval).execute(fixtureInput()),
    error => error?.code === 'APPROVAL_REQUIRED'
  );
  assert.deepEqual(forgedUiApproval.calls.map(call => call.name), ['session:get']);
});

test('M2D：未消费或参数漂移的持久授权在创建占位节点前失败关闭', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const unconsumed = fixturePorts();
  unconsumed.session.executionAuthorizations[0].consumedAt = null;
  await assert.rejects(
    () => createAgentNativeNodeBridge(unconsumed).execute(fixtureInput()),
    error => error?.code === 'AUTHORIZATION_NOT_CONSUMED'
  );
  assert.deepEqual(unconsumed.calls.map(call => call.name), ['session:get']);

  const drifted = fixturePorts();
  drifted.session.executionAuthorizations[0].request.budgetLimit = 13;
  await assert.rejects(
    () => createAgentNativeNodeBridge(drifted).execute(fixtureInput()),
    error => error?.code === 'AUTHORIZATION_BINDING_CONFLICT'
  );
  assert.deepEqual(drifted.calls.map(call => call.name), ['session:get']);
});

test('M2D：执行顺序固定为核对已排队 Session、Host 占位、currentNodeRef、幂等提交和同节点运行', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts();
  const bridge = createAgentNativeNodeBridge(ports);
  const result = await bridge.execute(fixtureInput());
  assert.deepEqual(ports.calls.map(call => call.name), [
    'session:get',
    'host:create-placeholder',
    'session:attach-node',
    'session:get',
    'session:submitting',
    'task:submit',
    'host:attach-task',
    'session:running'
  ]);
  assert.equal(result.agentSessionId, 'agent-session-bridge-1');
  assert.equal(result.toolRunId, 'tool-run-bridge-1');
  assert.equal(result.nodeId, 'node-bridge-1');
  assert.equal(result.taskId, 'canvas-task-1');
  const submitted = ports.calls.find(call => call.name === 'task:submit').input;
  assert.equal(submitted.agentTask.workspaceScope, 'canvas-agent');
  assert.equal(submitted.agentTask.allowFallback, false);
  assert.equal(submitted.agentTask.provider, 'fixture-provider');
  assert.equal(submitted.agentTask.model, 'fixture-model');
  assert.equal(submitted.agentTask.operationId, 'operation-bridge-1');
  assert.equal(submitted.agentTask.nodeId, 'node-bridge-1');
  assert.equal(submitted.agentTask.authorizationId, 'auth-bridge-1');
  assert.deepEqual(submitted.agentTask.inputVersionIds, ['input-v1']);
  assert.equal(submitted.agentTask.quantity, 1);
  assert.equal(submitted.agentTask.estimatedCost, 12);
  assert.equal(submitted.agentTask.approvedBudget, 12);
  assert.equal(submitted.agentTask.retryBudget, 0);
  assert.equal(submitted.agentTask.currency, 'CNY');
});

test('M5E-8：阶段内所有占位先建立，Round 子授权逐项提交并独立 settled', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const lost = Object.assign(new Error('second submit response lost'), { code: 'SUBMIT_RESPONSE_LOST' });
  const ports = fixturePorts({ submitErrors: { 'node-stage-2': lost } });
  const inputs = [roundStageInput(1), roundStageInput(2), roundStageInput(3)];
  installRoundStage(ports, inputs);
  const bridge = createAgentNativeNodeBridge(ports);

  const result = await bridge.executeStage(inputs);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.results), true);
  assert.deepEqual(result.results.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled']);

  const calls = ports.calls.map(call => call.name);
  const firstSubmit = calls.indexOf('task:submit');
  const placeholderIndexes = calls.map((name, index) => name === 'host:create-placeholder' ? index : -1).filter(index => index >= 0);
  assert.equal(placeholderIndexes.length, 3);
  assert.equal(placeholderIndexes.every(index => index < firstSubmit), true, '第一次提交前必须已建立本阶段全部占位节点');
  assert.deepEqual(
    ports.calls.filter(call => call.name === 'host:create-placeholder').map(call => call.input.nodeId),
    ['node-stage-1', 'node-stage-2', 'node-stage-3']
  );
  assert.deepEqual(
    ports.calls.filter(call => call.name === 'task:submit').map(call => call.input.nodeId).sort(),
    ['node-stage-1', 'node-stage-2', 'node-stage-3']
  );
  assert.equal(ports.calls.filter(call => call.name === 'task:submit' && call.input.nodeId === 'node-stage-2').length, 1);

  const childTask = ports.calls.find(call => call.name === 'task:submit' && call.input.nodeId === 'node-stage-1').input.agentTask;
  assert.deepEqual(childTask.inputVersionIds, ['input-stage-1', 'plan-stage-v1']);
  assert.deepEqual({
    roundId: childTask.roundId,
    itemId: childTask.itemId,
    stageId: childTask.stageId,
    planRevision: childTask.planRevision,
    planHash: childTask.planHash,
    parentAuthorizationId: childTask.parentAuthorizationId
  }, {
    roundId: 'round-stage-1',
    itemId: 'item-stage-1',
    stageId: 'stage-images',
    planRevision: 4,
    planHash: 'f'.repeat(64),
    parentAuthorizationId: 'round-auth-stage-1'
  });
});

test('M5E-8：阶段中的 remote-unknown 只恢复既有任务，不再次提交', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ nodeStatuses: ['waiting', 'completed'] });
  const inputs = [roundStageInput(1), roundStageInput(2)];
  installRoundStage(ports, inputs, { 'node-stage-2': 'remote-unknown' });
  const bridge = createAgentNativeNodeBridge(ports);

  const result = await bridge.executeStage(inputs);
  assert.deepEqual(result.results.map(item => item.status), ['fulfilled', 'fulfilled']);
  assert.equal(ports.calls.filter(call => call.name === 'task:submit' && call.input.nodeId === 'node-stage-1').length, 1);
  assert.equal(ports.calls.filter(call => call.name === 'task:submit' && call.input.nodeId === 'node-stage-2').length, 0);
  assert.equal(ports.calls.some(call => call.name === 'host:resume-task' && call.input.nodeId === 'node-stage-2'), true);
});

test('M5E-8：空阶段或重复 node/toolRun/operation 身份在任何写入前失败关闭', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts();
  const bridge = createAgentNativeNodeBridge(ports);
  await assert.rejects(() => bridge.executeStage([]), error => error?.code === 'INVALID_STAGE_ITEMS');
  await assert.rejects(
    () => bridge.executeStage([roundStageInput(1), roundStageInput(2, { nodeId: 'node-stage-1' })]),
    error => error?.code === 'DUPLICATE_STAGE_EXECUTION_IDENTITY' && error?.field === 'nodeId'
  );
  assert.deepEqual(ports.calls, []);
});

test('M5C：锁定参考图贯穿 Bridge、Host 来源和视频提交，漂移在占位前阻断', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const taskPayload = {
    prompt: '小猫向前奔跑', duration: 5, resolution: '480p', aspect_ratio: '9:16',
    images: [{ referenceId: 'node-source-1', referenceIndex: 1, sourceImageIndex: 0, role: 'first_frame', url: '/canvas-output/source.png', originalName: 'source.png' }]
  };
  const inputRefs = [
    { refId: 'message-reference-video', workspaceScope: 'canvas-agent' },
    { refId: 'node-source-1', workspaceScope: 'canvas-agent' }
  ];
  const ports = fixturePorts({
    kind: 'video', executionPayload: taskPayload, inputRefs,
    receipt: { localTaskId: 'local-reference-video', remoteTaskId: 'remote-reference-video', status: 'running' }
  });
  const bridge = createAgentNativeNodeBridge(ports);
  await bridge.execute(fixtureInput({
    kind: 'video', nodeRole: 'video-output', sourceNodeId: 'node-source-1',
    taskPayload, inputRefs
  }));
  const placeholder = ports.calls.find(call => call.name === 'host:create-placeholder').input;
  assert.equal(placeholder.sourceNodeId, 'node-source-1');
  assert.equal(placeholder.refs[0].nodeId, 'node-source-1');
  assert.equal(placeholder.meta.inputRefs[0].url, '/canvas-output/source.png');
  const submitted = ports.calls.find(call => call.name === 'task:submit').input;
  assert.deepEqual(submitted.taskPayload.images, taskPayload.images);
  assert.equal(ports.calls.filter(call => call.name === 'task:submit').length, 1);

  const drifted = fixturePorts({ kind: 'video', executionPayload: taskPayload, inputRefs });
  await assert.rejects(() => createAgentNativeNodeBridge(drifted).execute(fixtureInput({
    kind: 'video', sourceNodeId: 'node-source-1',
    taskPayload: { ...taskPayload, images: [{ ...taskPayload.images[0], url: '/canvas-output/changed.png' }] },
    inputRefs
  })), error => error?.code === 'PREPARED_BINDING_CONFLICT');
  assert.deepEqual(drifted.calls.map(call => call.name), ['session:get']);
});

test('R3：图片任务的 Skill 依赖素材按锁定顺序进入 Host 缩略图和真实提交载荷', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const assets = [
    { referenceId: 'node-character-1', referenceIndex: 1, sourceImageIndex: 0, role: 'character', url: '/canvas-output/character.png', originalName: 'character.png' },
    { referenceId: 'node-product-1', referenceIndex: 2, sourceImageIndex: 0, role: 'product', url: '/canvas-output/product.png', originalName: 'product.png' }
  ];
  const taskPayload = { type: 'generator', prompt: '保持人物和产品资产一致', size: '1024x1024', assets };
  const inputRefs = assets.map(reference => ({ refId: reference.referenceId, workspaceScope: 'canvas-agent' }));
  const ports = fixturePorts({ kind: 'image', executionPayload: taskPayload, inputRefs });
  await createAgentNativeNodeBridge(ports).execute(fixtureInput({
    kind: 'image',
    sourceNodeId: '',
    taskPayload,
    inputRefs
  }));

  const placeholder = ports.calls.find(call => call.name === 'host:create-placeholder').input;
  assert.equal(placeholder.sourceNodeId, '');
  assert.deepEqual(placeholder.refs.map(reference => ({ nodeId: reference.nodeId, url: reference.url })), [
    { nodeId: 'node-character-1', url: '/canvas-output/character.png' },
    { nodeId: 'node-product-1', url: '/canvas-output/product.png' }
  ]);
  const submitted = ports.calls.find(call => call.name === 'task:submit').input;
  assert.deepEqual(submitted.taskPayload.assets, assets);
});

test('M2D：同一执行已进入 running 后再次执行只要求核对，不再次调用提交端口', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ receipt: { taskId: 'canvas-task-stable', status: 'running', idempotent: true } });
  const bridge = createAgentNativeNodeBridge(ports);
  const first = await bridge.execute(fixtureInput());
  await assert.rejects(() => bridge.execute(fixtureInput()), error => error?.code === 'TOOL_RUN_ALREADY_SUBMITTED' && error?.reconcileRequired === true);
  assert.equal(first.nodeId, 'node-bridge-1');
  assert.equal(first.taskId, 'canvas-task-stable');
  const submits = ports.calls.filter(call => call.name === 'task:submit');
  assert.equal(submits.length, 1, 'running/remote-unknown 的恢复入口只能查询，不能重放提交');
  assert.equal(submits.every(call => call.input.agentTask.operationId === 'operation-bridge-1'), true);
  assert.equal(submits.every(call => call.input.agentTask.nodeId === 'node-bridge-1'), true);
});

test('M2D：已排队 toolRun 的 Provider、模型、输入或数量漂移时，在 Host 与 Provider 前阻断', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts();
  const bridge = createAgentNativeNodeBridge(ports);
  await assert.rejects(
    () => bridge.execute(fixtureInput({ providerId: 'changed-provider' })),
    error => error?.code === 'PREPARED_BINDING_CONFLICT'
  );
  assert.equal(ports.calls.some(call => call.name === 'host:create-placeholder'), false);
  assert.equal(ports.calls.some(call => call.name === 'task:submit'), false);
});

test('M2D：提交响应未知时标记 reconcile-required，桥不会自行再次提交', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const lost = Object.assign(new Error('submit response lost'), { code: 'SUBMIT_RESPONSE_LOST' });
  const ports = fixturePorts({ submitError: lost });
  const bridge = createAgentNativeNodeBridge(ports);
  await assert.rejects(() => bridge.execute(fixtureInput()), error => error?.reconcileRequired === true);
  assert.equal(ports.calls.filter(call => call.name === 'task:submit').length, 1);
  assert.equal(ports.calls.some(call => call.name === 'session:remote-unknown'), true);
});

test('M2D：视频回执只有本地流水号时阻塞核对，绝不把它挂到视频节点或用于轮询', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({
    kind: 'video',
    remoteTaskId: '',
    receipt: { localTaskId: 'canvas-video-local-only', remoteTaskId: '', status: 'submitting' }
  });
  const bridge = createAgentNativeNodeBridge(ports);
  await assert.rejects(
    () => bridge.execute(fixtureInput({ kind: 'video', nodeRole: 'main-video', sourceNodeId: undefined, taskPayload: { prompt: 'fixture video prompt', duration: 5, resolution: '480p', aspect_ratio: '9:16', images: [] } })),
    error => error?.code === 'VIDEO_REMOTE_TASK_ID_MISSING'
      && error?.reconcileRequired === true
      && error?.localTaskId === 'canvas-video-local-only'
  );
  assert.equal(ports.calls.filter(call => call.name === 'task:submit').length, 1);
  assert.equal(ports.calls.some(call => ['host:attach-task', 'host:remote-unknown', 'host:resume-task'].includes(call.name)), false);
  assert.equal(ports.calls.some(call => call.name === 'session:remote-unknown'), true);
});

test('M2D：恢复只读取 Session 并查询既有 taskId，不调用 task submit', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ toolStatus: 'remote-unknown', remoteTaskId: 'canvas-task-existing', nodeStatuses: ['waiting', 'completed'] });
  const bridge = createAgentNativeNodeBridge(ports);
  const recovered = await bridge.recover(fixtureInput({ taskPayload: undefined, sourceNodeId: undefined, authorizationId: undefined, taskId: 'caller-forged-task' }));
  assert.deepEqual(ports.calls.map(call => call.name), [
    'session:get',
    'host:get-node',
    'host:resume-task',
    'host:get-node',
    'session:succeeded'
  ]);
  assert.equal(recovered.taskId, 'canvas-task-existing');
  assert.equal(recovered.status, 'succeeded');
  assert.equal(ports.calls.some(call => call.name === 'task:submit'), false);
});

test('M2D：节点已原位完成但 Session 尚未落终态时，直接收敛 Session 且不再查询任务', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ toolStatus: 'remote-unknown', remoteTaskId: '', nodeTaskId: null, nodeStatus: 'completed' });
  const bridge = createAgentNativeNodeBridge(ports);
  const recovered = await bridge.recover(fixtureInput({ taskPayload: undefined, sourceNodeId: undefined, authorizationId: undefined }));
  assert.equal(recovered.status, 'succeeded');
  assert.deepEqual(ports.calls.map(call => call.name), ['session:get', 'host:get-node', 'session:succeeded']);
  assert.equal(ports.calls.some(call => call.name === 'host:resume-task'), false);
});

test('M2D：恢复时若 Session 与节点都没有既有 taskId，只阻塞核对且不重放 POST', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ toolStatus: 'remote-unknown', remoteTaskId: '', nodeTaskId: null, nodeStatus: 'waiting' });
  const bridge = createAgentNativeNodeBridge(ports);
  const recovered = await bridge.recover(fixtureInput({ taskPayload: undefined, sourceNodeId: undefined, authorizationId: undefined }));
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.reconcileRequired, true);
  assert.deepEqual(ports.calls.map(call => call.name), ['session:get', 'host:get-node']);
  assert.equal(ports.calls.some(call => call.name === 'task:submit'), false);
});

test('M2D：恢复严格绑定 toolRun 和节点媒体类型，图片与视频不能互换', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ toolStatus: 'remote-unknown', kind: 'image', remoteTaskId: 'canvas-task-existing', nodeStatus: 'waiting' });
  const bridge = createAgentNativeNodeBridge(ports);
  await assert.rejects(
    () => bridge.recover(fixtureInput({ kind: 'video', taskPayload: undefined, sourceNodeId: undefined, authorizationId: undefined })),
    error => error?.code === 'RECOVERY_BINDING_CONFLICT'
  );
  assert.deepEqual(ports.calls.map(call => call.name), ['session:get']);
  assert.equal(ports.calls.some(call => call.name === 'host:resume-task'), false);

  const terminalMismatch = fixturePorts({
    toolStatus: 'remote-unknown',
    kind: 'video',
    nodeKind: 'image',
    remoteTaskId: 'canvas-video-existing',
    nodeStatus: 'completed'
  });
  await assert.rejects(
    () => createAgentNativeNodeBridge(terminalMismatch).recover(fixtureInput({ kind: 'video', taskPayload: undefined, sourceNodeId: undefined, authorizationId: undefined })),
    error => error?.code === 'RECOVERY_BINDING_CONFLICT'
  );
  assert.deepEqual(terminalMismatch.calls.map(call => call.name), ['session:get', 'host:get-node']);
  assert.equal(terminalMismatch.calls.some(call => call.name === 'session:succeeded'), false);
});

test('M6A：终态 Agent 节点先核对 Host，再从 Session 当前工作集软脱离', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed', nodeTaskId: null });
  const result = await createAgentNativeNodeBridge(ports).detachCurrentNode({
    workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-bridge-1', toolRunId: 'tool-run-bridge-1', nodeId: 'node-bridge-1', kind: 'image'
  });
  assert.equal(result.status, 'detached');
  assert.equal(result.idempotent, false);
  assert.deepEqual(ports.calls.map(call => call.name), ['session:get', 'host:get-node', 'session:detach-node']);
  assert.equal(ports.session.currentNodeRefs.length, 0);
  assert.equal(ports.session.detachedNodeRefs[0].nodeId, 'node-bridge-1');
});

test('M6A：未决任务和错绑节点在 Session 脱离前失败关闭', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const running = fixturePorts({ toolStatus: 'running', nodeStatus: 'running' });
  await assert.rejects(() => createAgentNativeNodeBridge(running).detachCurrentNode({
    workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-bridge-1', toolRunId: 'tool-run-bridge-1', nodeId: 'node-bridge-1', kind: 'image'
  }), error => error?.code === 'AGENT_NODE_DETACH_BLOCKED');
  assert.deepEqual(running.calls.map(call => call.name), ['session:get']);

  const mismatched = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed' });
  await assert.rejects(() => createAgentNativeNodeBridge(mismatched).detachCurrentNode({
    workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-bridge-1', toolRunId: 'other-tool-run', nodeId: 'node-bridge-1', kind: 'image'
  }), error => error?.code === 'AGENT_NODE_OWNERSHIP_CONFLICT');
  assert.deepEqual(mismatched.calls.map(call => call.name), ['session:get']);
});

test('M6A：Session 已脱离但本地节点仍在时允许幂等收尾，不重复 DELETE', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed' });
  ports.session.detachedNodeRefs = ports.session.currentNodeRefs.map(item => ({ ...item, detachedAt: 123 }));
  ports.session.currentNodeRefs = [];
  const result = await createAgentNativeNodeBridge(ports).detachCurrentNode({
    workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-bridge-1', toolRunId: 'tool-run-bridge-1', nodeId: 'node-bridge-1', kind: 'image'
  });
  assert.equal(result.idempotent, true);
  assert.deepEqual(ports.calls.map(call => call.name), ['session:get']);
});

test('M6A3：历史已删的 Session 以精确 404 幂等脱离，普通 404 和服务错误仍失败关闭', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const identity = {
    workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-bridge-1', toolRunId: 'tool-run-bridge-1', nodeId: 'node-bridge-1', kind: 'image'
  };
  const missing = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed', nodeTaskId: null });
  missing.sessionPort.getSession = async agentSessionId => {
    missing.calls.push({ name: 'session:get', agentSessionId });
    throw Object.assign(new Error('AgentSession 不存在'), { code: 'AGENT_SESSION_NOT_FOUND', status: 404 });
  };
  const result = await createAgentNativeNodeBridge(missing).detachCurrentNode(identity);
  assert.equal(result.status, 'detached');
  assert.equal(result.idempotent, true);
  assert.equal(result.orphanedSession, true);
  assert.deepEqual(missing.calls.map(call => call.name), ['session:get']);

  for (const error of [
    Object.assign(new Error('普通路由 404'), { code: 'BRIDGE_REQUEST_FAILED', status: 404 }),
    Object.assign(new Error('服务失败'), { code: 'AGENT_SESSION_NOT_FOUND', status: 500 })
  ]) {
    const blocked = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed', nodeTaskId: null });
    blocked.sessionPort.getSession = async agentSessionId => {
      blocked.calls.push({ name: 'session:get', agentSessionId });
      throw error;
    };
    await assert.rejects(() => createAgentNativeNodeBridge(blocked).detachCurrentNode(identity), thrown => thrown === error);
    assert.deepEqual(blocked.calls.map(call => call.name), ['session:get']);
  }
});

test('M6A4：运行中旧后端的精确缺失 Session 404 也可幂等脱离，其他旧 404 仍失败关闭', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const identity = {
    workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-bridge-1', toolRunId: 'tool-run-bridge-1', nodeId: 'node-bridge-1', kind: 'image'
  };
  const legacyMissing = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed', nodeTaskId: null });
  legacyMissing.sessionPort.getSession = async agentSessionId => {
    legacyMissing.calls.push({ name: 'session:get', agentSessionId });
    throw Object.assign(new Error('AgentSession 不存在'), {
      code: 'BRIDGE_REQUEST_FAILED',
      status: 404,
      payload: { success: false, error: 'AgentSession 不存在' }
    });
  };
  const result = await createAgentNativeNodeBridge(legacyMissing).detachCurrentNode(identity);
  assert.equal(result.status, 'detached');
  assert.equal(result.idempotent, true);
  assert.equal(result.orphanedSession, true);
  assert.deepEqual(legacyMissing.calls.map(call => call.name), ['session:get']);

  const unrelated = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed', nodeTaskId: null });
  const unrelatedError = Object.assign(new Error('节点不存在'), {
    code: 'BRIDGE_REQUEST_FAILED',
    status: 404,
    payload: { success: false, error: '节点不存在' }
  });
  unrelated.sessionPort.getSession = async () => { throw unrelatedError; };
  await assert.rejects(() => createAgentNativeNodeBridge(unrelated).detachCurrentNode(identity), thrown => thrown === unrelatedError);
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /agent-native-node-bridge\.js\?[^"']*m6a4=20260825-agent-m6a4/);
});

test('M6A3：核对后 Session 被并发删除仍可幂等收尾，不会重复访问 Host 或重建 Session', async () => {
  const { createAgentNativeNodeBridge } = bridgeModule();
  const ports = fixturePorts({ toolStatus: 'succeeded', nodeStatus: 'completed', nodeTaskId: null });
  ports.sessionPort.detachCurrentNode = async (agentSessionId, nodeId, payload) => {
    ports.calls.push({ name: 'session:detach-node', agentSessionId, nodeId, payload });
    throw Object.assign(new Error('AgentSession 不存在'), { code: 'AGENT_SESSION_NOT_FOUND', status: 404 });
  };
  const result = await createAgentNativeNodeBridge(ports).detachCurrentNode({
    workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-bridge-1', toolRunId: 'tool-run-bridge-1', nodeId: 'node-bridge-1', kind: 'image'
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.orphanedSession, true);
  assert.deepEqual(ports.calls.map(call => call.name), ['session:get', 'host:get-node', 'session:detach-node']);
});

test('M6A3：缺失 Session 路由提供稳定业务码，Bridge 缓存键同步刷新', () => {
  const routes = fs.readFileSync(routesPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(routes, /AgentSession 不存在[^\n]+AGENT_SESSION_NOT_FOUND/);
  assert.match(html, /agent-native-node-bridge\.js\?[^"']*m6a3=20260825-agent-m6a3/);
});

test('M2D：生产入口在 core 后加载，且 Bridge 不接触 Foundation、旧 Run 或一键复色', () => {
  const source = fs.readFileSync(bridgePath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const coreAt = html.indexOf('/smart-canvas-core/smart-canvas-core.js');
  const bridgeAt = html.indexOf('/smart-canvas-core/agent-native-node-bridge.js');
  const externalAt = html.indexOf('/external-link.js');
  assert.ok(coreAt >= 0 && bridgeAt > coreAt && externalAt > bridgeAt, 'Bridge 必须在 Adapter 与原生 Host 都存在后加载');
  assert.match(html, /smart-canvas-core\.js\?v=20260824-agent-m5i&amp;rev=20260825-agent-m6a2/, '画布删除接线变化后必须刷新 core 修订键');
  assert.match(html, /agent-native-node-bridge\.js\?v=20260824-agent-m5i&amp;rev=20260825-agent-m6a2/, 'Bridge 安全合同变化后必须刷新浏览器修订键');
  assert.doesNotMatch(source, /agent-runs|Foundation|foundation|recolor|一键复色/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
  assert.match(source, /LavansCanvasAdapter/);
  assert.match(source, /AgentNativeNodeHost/);
});

test('M6A5：画布删除必须先脱离 Session，失败时保留本地节点，普通节点一次删除', () => {
  const source = fs.readFileSync(corePath, 'utf8');
  const detachStart = source.indexOf('async function detachAgentNativeNodeBeforeDelete');
  const buttonStart = source.indexOf('async function deleteNodeFromButton');
  const keyboardStart = source.indexOf('async function deleteNodesFromKeyboard');
  const disconnectStart = source.indexOf('function disconnectConnection');
  const keyHandlerStart = source.indexOf("if((e.key === 'Delete' || e.key === 'Backspace')");
  assert.ok(detachStart >= 0 && buttonStart > detachStart && keyboardStart > buttonStart && disconnectStart > keyboardStart);
  const detachBlock = source.slice(detachStart, buttonStart);
  assert.ok(detachBlock.indexOf('await window.AgentNativeNodeBridge.detachCurrentNode(identity)') >= 0);
  assert.ok(detachBlock.indexOf('catch(error)') > detachBlock.indexOf('detachCurrentNode(identity)'));
  assert.match(detachBlock.slice(detachBlock.indexOf('catch(error)')), /return false/);
  const buttonBlock = source.slice(buttonStart, keyboardStart);
  assert.ok(buttonBlock.indexOf('await detachAgentNativeNodeBeforeDelete(node)') < buttonBlock.indexOf('deleteNodeWithoutUndo(id)'));
  assert.doesNotMatch(buttonBlock, /clearNodeMediaBeforeDelete/, '普通节点垃圾桶不能先清空媒体并遗留空节点');
  assert.match(buttonBlock, /deleteNode\(id\);/, '普通节点垃圾桶必须一次删除并进入本地 Undo');
  const keyboardBlock = source.slice(keyboardStart, disconnectStart);
  assert.ok(keyboardBlock.indexOf('await detachAgentNativeNodeBeforeDelete(node)') < keyboardBlock.indexOf('deleteNodeWithoutUndo(node.id)'));
  assert.ok(keyboardBlock.indexOf('deleteNodeWithoutUndo(node.id)') < keyboardBlock.indexOf('pushUndo()'), 'Agent 节点必须先无 Undo 移除，再为普通节点建立快照');
  assert.match(source.slice(keyHandlerStart, keyHandlerStart + 500), /void deleteNodesFromKeyboard\(ids\)/);
});

test('M6A5：删除事件夹具证明失败保留、成功先脱离、普通媒体节点一次删除且 Agent 不写入 Undo', async () => {
  const source = fs.readFileSync(corePath, 'utf8');
  const takeFunction = name => {
    const marker = source.indexOf(`function ${name}(`);
    assert.ok(marker >= 0, `缺少 ${name}`);
    const start = source.lastIndexOf('\n', marker) + 1;
    const open = source.indexOf('{', marker);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`无法提取 ${name}`);
  };
  const events = [];
  const context = {
    nodes: [],
    undoSuppressed: false,
    window: { AgentNativeNodeBridge: { detachCurrentNode: async () => {} } },
    toast(message) { events.push(`toast:${message}`); },
    deleteNode(id) {
      context.pushUndo();
      events.push(`delete:${id}:${context.undoSuppressed}`);
      context.nodes = context.nodes.filter(node => node.id !== id);
    },
    clearNodeMediaBeforeDelete(id) { events.push(`clear:${id}`); return true; },
    pushUndo() { if (!context.undoSuppressed) events.push('undo'); },
    render() { events.push('render'); },
    scheduleSave() { events.push('save'); }
  };
  const names = ['isAgentNativeCanvasNode', 'agentNativeDeleteIdentity', 'detachAgentNativeNodeBeforeDelete', 'deleteNodeWithoutUndo', 'deleteNodeFromButton', 'deleteNodesFromKeyboard'];
  vm.runInNewContext(`${names.map(takeFunction).join('\n')}\nthis.api={deleteNodeFromButton,deleteNodesFromKeyboard};`, context);
  const agent = { id: 'agent-node', outputKind: 'image', agentNative: { workspaceScope: 'canvas-agent', agentSessionId: 'session-1', toolRunId: 'run-1', kind: 'image' } };

  context.nodes = [agent];
  context.window.AgentNativeNodeBridge.detachCurrentNode = async () => { events.push('detach'); throw new Error('blocked'); };
  await context.api.deleteNodeFromButton('agent-node');
  assert.deepEqual(events, ['detach', 'toast:blocked']);
  assert.equal(context.nodes.length, 1);

  events.length = 0;
  context.window.AgentNativeNodeBridge.detachCurrentNode = async () => { events.push('detach'); };
  await context.api.deleteNodeFromButton('agent-node');
  assert.deepEqual(events, ['detach', 'delete:agent-node:true']);
  assert.equal(context.nodes.length, 0);

  events.length = 0;
  context.nodes = [{ id: 'ordinary-node', type: 'smart-image', images: [{ url: '/generated/image.png' }] }];
  await context.api.deleteNodeFromButton('ordinary-node');
  assert.deepEqual(events, ['undo', 'delete:ordinary-node:false']);
  assert.equal(context.nodes.length, 0);

  events.length = 0;
  context.nodes = [agent, { id: 'ordinary-node', type: 'smart-image' }];
  await context.api.deleteNodesFromKeyboard(['agent-node', 'ordinary-node']);
  assert.deepEqual(events, ['detach', 'delete:agent-node:true', 'undo', 'delete:ordinary-node:true', 'render', 'save']);
});

test('U2：复制 Agent 节点只保留可见内容，不复制 Session 和 ToolRun 所有权', () => {
  const source = fs.readFileSync(corePath, 'utf8');
  const takeFunction = name => {
    const marker = source.indexOf(`function ${name}(`);
    assert.ok(marker >= 0, `缺少 ${name}`);
    const start = source.lastIndexOf('\n', marker) + 1;
    const open = source.indexOf('{', marker);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`无法提取 ${name}`);
  };
  const context = {
    uid() { return 'copied-node'; },
    classicNodeDefinition() { return null; },
    clearSmartNodeTransientRunState(node) { node.running = false; delete node.pendingTasks; return node; }
  };
  vm.runInNewContext(`${takeFunction('isAgentNativeCanvasNode')}\n${takeFunction('cloneSmartNode')}\nthis.cloneSmartNode=cloneSmartNode;`, context);
  const original = {
    id:'agent-node',type:'smart-image',x:10,y:20,title:'Agent 图片',
    images:[{url:'/canvas-output/agent-image.png',kind:'image'}],
    taskState:{status:'completed'},
    agentNative:{workspaceScope:'canvas-agent',agentSessionId:'session-1',toolRunId:'run-1',kind:'image'}
  };
  const copy = context.cloneSmartNode(original, 24, 24);
  assert.equal(copy.id, 'copied-node');
  assert.equal(copy.agentNative, undefined);
  assert.equal(copy.images[0].url, original.images[0].url);
  assert.equal(copy.taskState.status, 'completed');
  assert.equal(original.agentNative.agentSessionId, 'session-1');
  assert.match(source.slice(source.indexOf('function pasteNodes'), source.indexOf('function readAssetInbox')), /cloneSmartNode\(n, dx, dy\)/);
  assert.match(source.slice(source.indexOf('function duplicateForAltDrag'), source.indexOf('function shellPoint')), /cloneSmartNode\(n, 0, 0\)/);
  assert.match(fs.readFileSync(htmlPath, 'utf8'), /smart-canvas-core\.js\?[^"']*u2=20260826-agent-copy-delete/);
});

test('M6A5：智能画布撤销与重做快捷键在捕获阶段接管，编辑框仍保留原生文字撤销', () => {
  const source = fs.readFileSync(corePath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const keydownStart = source.indexOf("window.addEventListener('keydown', e => {");
  const keyupStart = source.indexOf("window.addEventListener('keyup', e => {", keydownStart);
  assert.ok(keydownStart >= 0 && keyupStart > keydownStart, '缺少智能画布全局快捷键入口');
  const keydownBlock = source.slice(keydownStart, keyupStart);
  assert.match(keydownBlock, /\(e\.ctrlKey \|\| e\.metaKey\) && key === 'z' && !isEditableTarget\(e\.target\)/);
  assert.match(keydownBlock, /if\(e\.shiftKey\)\{ performRedo\(\); \}\s*else \{ performUndo\(\); \}/);
  assert.match(keydownBlock, /\}, true\);\s*$/, '快捷键必须使用捕获阶段，避免被内部画布控件提前消费');
  assert.match(html, /smart-canvas-core\.js\?[^"']*m6a5=20260825-agent-m6a5/, '普通删除与快捷键变化后必须刷新 core 缓存键');
});

test('U3：点击空白画布会释放编辑框焦点，让画布快捷键恢复接管', () => {
  const source = fs.readFileSync(corePath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const mouseStart = source.indexOf('shell.onmousedown = e => {');
  const menuStart = source.indexOf('shell.oncontextmenu = e => {', mouseStart);
  assert.ok(mouseStart >= 0 && menuStart > mouseStart, '缺少空白画布按下处理入口');
  const mouseBlock = source.slice(mouseStart, menuStart);
  assert.match(mouseBlock, /!e\.target\.closest\('\.image-node,\.composer,[^']+'\) && isEditableTarget\(document\.activeElement\)\) document\.activeElement\.blur\(\);/);
  assert.match(html, /smart-canvas-core\.js\?[^"']*u3=20260826-canvas-focus-shortcuts/, '焦点修复后必须刷新 core 缓存键');
});

test('M2D：浏览器脚本加载只注册冻结 Bridge，不在初始化时写 Session、节点或任务', () => {
  const source = fs.readFileSync(bridgePath, 'utf8');
  const calls = [];
  const adapter = {
    fetch() { calls.push('fetch'); },
    createTask() { calls.push('createTask'); }
  };
  const host = {
    capabilities: { workspaceScope: 'canvas-agent', submitsProviderTasks: false },
    createPlaceholder() { calls.push('createPlaceholder'); },
    attachTask() { calls.push('attachTask'); },
    markRemoteUnknown() { calls.push('markRemoteUnknown'); },
    resumeTask() { calls.push('resumeTask'); },
    getNode() { calls.push('getNode'); }
  };
  const browserWindow = { document: {}, LavansCanvasAdapter: adapter, AgentNativeNodeHost: host, fetch() { calls.push('window.fetch'); } };
  vm.runInNewContext(source, { window: browserWindow, globalThis: browserWindow });
  assert.equal(Object.isFrozen(browserWindow.AgentNativeNodeBridge), true);
  assert.equal(Object.isFrozen(browserWindow.AgentNativeNodeBridge.capabilities), true);
  assert.deepEqual(calls, []);
});

test('M2D：默认端口离线映射正确，Session/图片走 Adapter，视频只走明确同源入口', async () => {
  const { createAgentSessionPort, createAgentNativeTaskPort } = bridgeModule();
  const calls = [];
  const ok = payload => ({ ok: true, status: 200, json: async () => payload });
  const adapter = {
    async fetch(pathname, options) {
      calls.push({ name: 'adapter:fetch', pathname, options });
      return ok({ success: true, session: { id: 'agent-session-bridge-1' } });
    },
    async createTask(payload) {
      calls.push({ name: 'adapter:create-task', payload });
      return { success: true, task: { id: 'canvas-task-local', status: 'queued', upstreamTaskId: '' } };
    }
  };
  const sameOriginFetch = async (pathname, options) => {
    calls.push({ name: 'same-origin:fetch', pathname, options });
    if (pathname === '/api/canvas-audio-tasks') return ok({ local_task_id: 'canvas-audio-local', status: 'succeeded' });
    return ok({ local_task_id: 'canvas-video-local', task_id: 'canvas-video-remote', status: 'submitted' });
  };
  const sessionPort = createAgentSessionPort(adapter);
  const taskPort = createAgentNativeTaskPort(adapter, sameOriginFetch);
  await sessionPort.getSession('agent-session-bridge-1');
  await sessionPort.detachCurrentNode('agent-session-bridge-1', 'node-bridge-1', { requestId: 'request-detach-1' });
  const image = await taskPort.submit({
    kind: 'image', providerId: 'provider-a', model: 'model-a', nodeId: 'node-1', taskPayload: { prompt: 'image' }, agentTask: { allowFallback: false }
  });
  const video = await taskPort.submit({
    kind: 'video', providerId: 'provider-v', model: 'model-v', nodeId: 'node-2', taskPayload: { prompt: 'video' }, agentTask: { allowFallback: false }
  });
  const audio = await taskPort.submit({
    kind: 'audio', providerId: 'provider-audio', model: 'gpt-4o-mini-tts', nodeId: 'node-3',
    taskPayload: { input: '你好', voice: 'alloy', response_format: 'wav', speed: 1 }, agentTask: { allowFallback: false }
  });
  assert.equal(calls[0].pathname, '/agent-sessions/agent-session-bridge-1');
  assert.equal(calls[1].pathname, '/agent-sessions/agent-session-bridge-1/current-nodes/node-bridge-1');
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(JSON.parse(calls[1].options.body).requestId, 'request-detach-1');
  assert.equal(calls[2].name, 'adapter:create-task');
  assert.equal(calls[2].payload.providerId, 'provider-a');
  assert.equal(image.localTaskId, 'canvas-task-local');
  assert.equal(image.remoteTaskId, '');
  assert.equal(calls[3].name, 'same-origin:fetch');
  assert.equal(calls[3].pathname, '/api/canvas-video');
  assert.equal(JSON.parse(calls[3].options.body).provider_id, 'provider-v');
  assert.equal(video.localTaskId, 'canvas-video-local');
  assert.equal(video.remoteTaskId, 'canvas-video-remote');
  assert.equal(calls[4].pathname, '/api/canvas-audio-tasks');
  assert.equal(JSON.parse(calls[4].options.body).provider_id, 'provider-audio');
  assert.equal(audio.localTaskId, 'canvas-audio-local');
  assert.equal(audio.resumeTaskId, 'canvas-audio-local');
  assert.equal(audio.remoteTaskId, '');
});

test('M6：同步音频失败保留本地任务 ID，供原节点只读恢复且不再次提交', async () => {
  const { createAgentNativeTaskPort } = bridgeModule();
  let submitCount = 0;
  const taskPort = createAgentNativeTaskPort({ createTask() {} }, async () => {
    submitCount += 1;
    return {
      ok: false,
      status: 502,
      json: async () => ({
        success: false,
        code: 'CANVAS_AUDIO_ERROR',
        detail: '远端结果未知，等待核对',
        local_task_id: 'canvas-audio-recover-1'
      })
    };
  });
  await assert.rejects(
    taskPort.submit({
      kind: 'audio', providerId: 'provider-audio', model: 'gpt-4o-mini-tts', nodeId: 'node-audio-recover',
      taskPayload: { input: '你好', voice: 'alloy', response_format: 'wav', speed: 1 },
      agentTask: { allowFallback: false }
    }),
    error => error.localTaskId === 'canvas-audio-recover-1' && error.taskId === 'canvas-audio-recover-1'
  );
  assert.equal(submitCount, 1);
});
