const path = require('path');
const { clone, readJson, safeId, sha256, stableStringify } = require('./atomicJsonStore');
const { ArtifactVersionStore } = require('./artifactVersionStore');
const { ApprovalGateEngine } = require('./approvalGateEngine');
const { buildCanvasProjection } = require('./canvasProjection');
const { DependencyGraph } = require('./dependencyGraph');
const { ExecutionGuard } = require('./executionGuard');
const { ImpactPropagator } = require('./impactPropagator');
const { RecoveryAuditor } = require('./recoveryAuditor');
const { TaskLedger } = require('./taskLedger');

const PHASES = [
  ['1', '执行底座与恢复账本', ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8']],
  ['2', '产品事实与调研', ['2.1', '2.2', '2.3']],
  ['3', '创意与剧本锁定', ['3.1', '3.2', '3.3']],
  ['4', '结构化分镜与资产台账', ['4.1', '4.2', '4.3']],
  ['5', '模型策略与费用防线', ['5.1', '5.2', '5.3']],
  ['6', '视觉资产生产', ['6.1', '6.2', '6.3']],
  ['7', '分镜图、故事板与调度', ['7.1', '7.2', '7.3']],
  ['8', '声音与逐镜制作包', ['8.1', '8.2', '8.3']],
  ['9', '逐镜视频生产与验收', ['9.1', '9.2', '9.3']],
  ['10', '合成、质检与最终交付', ['10.1', '10.2', '10.3']]
];

function defaultLedger() {
  return {
    schemaVersion: 1,
    planVersion: '2026-08-20.1',
    phases: PHASES.map(([id, name, tasks]) => ({ id, name, status: 'pending', tasks: tasks.map(taskId => ({ id: taskId, status: 'pending', evidence: [] })) })),
    decisions: [],
    blockers: [],
    nextAction: { taskId: '1.1', action: '建立执行底座基线' }
  };
}

function foundationEventError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertSessionEventPayload(value, expectedIdentity) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(item => assertSessionEventPayload(item, expectedIdentity));
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    if (/scope$/i.test(key) && child !== undefined && child !== null && String(child).trim()) {
      const scope = String(child).trim();
      if (!['canvas', 'canvas-agent'].includes(scope)) {
        throw foundationEventError('Session 历史不能引用一键复色或其他工作区', 'INVALID_SESSION_EVENT_SCOPE');
      }
    }
    if (/^canvasId$/i.test(key) && String(child || '').trim() !== expectedIdentity.canvasId) {
      throw foundationEventError('Session 事件不能引用其他画布', 'SESSION_EVENT_IDENTITY_CONFLICT', 409);
    }
    if (/^agentSessionId$/i.test(key) && String(child || '').trim() !== expectedIdentity.agentSessionId) {
      throw foundationEventError('Session 事件不能引用其他 Session', 'SESSION_EVENT_IDENTITY_CONFLICT', 409);
    }
    assertSessionEventPayload(child, expectedIdentity);
  });
}

function normalizedSessionEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw foundationEventError('Session 事件不合法', 'INVALID_SESSION_EVENT');
  }
  if (input.workspaceScope !== 'canvas-agent') {
    throw foundationEventError('Foundation 只接受 canvas-agent Session 事件', 'INVALID_SESSION_EVENT_SCOPE');
  }
  const canvasId = safeId(input.canvasId, 'canvasId');
  const agentSessionId = safeId(input.agentSessionId, 'AgentSession ID');
  let payload;
  try { payload = clone(input.payload === undefined ? {} : input.payload); }
  catch (_error) { throw foundationEventError('Session 事件内容无法序列化', 'INVALID_SESSION_EVENT'); }
  assertSessionEventPayload(payload, { canvasId, agentSessionId });
  return {
    schemaVersion: 1,
    workspaceScope: 'canvas-agent',
    canvasId,
    agentSessionId,
    eventId: safeId(input.eventId, 'eventId'),
    eventType: safeId(input.eventType, 'eventType'),
    payload
  };
}

function createCanvasAgentFoundation(options = {}) {
  const rootPath = path.resolve(options.rootPath);
  const artifactStore = new ArtifactVersionStore(path.join(rootPath, 'artifacts'), options);
  const dependencyGraph = new DependencyGraph(rootPath, options);
  const taskLedger = new TaskLedger(options.ledgerPath || path.join(rootPath, 'execution-ledger.json'), options);
  if (!taskLedger.exists()) taskLedger.save(defaultLedger());
  const approvalGate = new ApprovalGateEngine(artifactStore, options);
  const impactPropagator = new ImpactPropagator(artifactStore, dependencyGraph, options);
  const executionGuard = new ExecutionGuard(artifactStore, options);
  const recoveryAuditor = new RecoveryAuditor({ ...options, rootPath, artifactStore, dependencyGraph, taskLedger });
  const operationState = readJson(recoveryAuditor.operationsPath, { operations: [] });
  if ((operationState.operations || []).some(operation => operation.status === 'running')) {
    recoveryAuditor.interruptRunningOperations();
  }

  function createArtifact(input) {
    const canvasId = String(input?.metadata?.canvasId || '').trim();
    if (canvasId) {
      (input.inputRefs || []).forEach(ref => {
        const parent = artifactStore.get(ref.artifactVersionId, { verify: false });
        if (!parent) throw new Error(`输入版本不存在：${ref.artifactVersionId}`);
        if (String(parent.metadata?.canvasId || '') !== canvasId) throw new Error('禁止跨画布绑定产物依赖');
      });
    }
    const artifact = artifactStore.createVersion(input);
    dependencyGraph.setInputs(artifact.artifactVersionId, artifact.inputRefs, { operationId: input.operationId });
    return artifact;
  }

  function appendSessionEvent(input) {
    const event = normalizedSessionEvent(input);
    const identityHash = sha256({ canvasId: event.canvasId, agentSessionId: event.agentSessionId, eventId: event.eventId });
    const eventHash = sha256(stableStringify(event));
    const logicalArtifactId = `session-event-${identityHash.slice(0, 40)}`;
    const existing = artifactStore.list({ logicalArtifactId })[0] || null;
    function assertStoredEvent(candidate) {
      const sameIdentity = candidate.logicalArtifactId === logicalArtifactId
        && candidate.artifactType === 'agent-session-event'
        && candidate.source === 'agent-session-history'
        && candidate.metadata?.workspaceScope === 'canvas-agent'
        && candidate.metadata?.canvasId === event.canvasId
        && candidate.metadata?.agentSessionId === event.agentSessionId
        && candidate.metadata?.eventId === event.eventId
        && candidate.metadata?.eventType === event.eventType;
      if (!sameIdentity || candidate.metadata?.eventHash !== eventHash || candidate.contentHash !== eventHash) {
        throw foundationEventError('同一 Session eventId 已绑定不同内容', 'SESSION_EVENT_CONFLICT', 409);
      }
      const validation = artifactStore.verify(candidate.artifactVersionId);
      if (!validation.valid) throw foundationEventError(`Session 历史内容校验失败：${validation.error}`, 'SESSION_EVENT_HISTORY_INVALID', 409);
      return candidate;
    }
    if (existing) {
      assertStoredEvent(existing);
      return {
        artifact: existing,
        historyRef: { eventId: event.eventId, artifactVersionId: existing.artifactVersionId, contentHash: existing.contentHash },
        idempotent: true
      };
    }
    const operationId = `session-event:${identityHash.slice(0, 40)}`;
    const artifact = artifactStore.createVersion({
      logicalArtifactId,
      artifactType: 'agent-session-event',
      operationId,
      source: 'agent-session-history',
      content: event,
      extension: '.json',
      metadata: {
        canvasId: event.canvasId,
        workspaceScope: 'canvas-agent',
        agentSessionId: event.agentSessionId,
        eventId: event.eventId,
        eventType: event.eventType,
        eventHash,
        displayTitle: `Session event ${event.eventId}`
      }
    });
    assertStoredEvent(artifact);
    dependencyGraph.setInputs(artifact.artifactVersionId, artifact.inputRefs, { operationId });
    return {
      artifact,
      historyRef: { eventId: event.eventId, artifactVersionId: artifact.artifactVersionId, contentHash: artifact.contentHash },
      idempotent: false
    };
  }

  function status(statusOptions = {}) {
    const rawCanvasId = String(statusOptions.canvasId || '').trim();
    const canvasId = rawCanvasId ? safeId(rawCanvasId, 'canvasId') : '';
    const artifacts = canvasId ? artifactStore.list({ canvasId }) : [];
    const projection = buildCanvasProjection(artifactStore, dependencyGraph, {
      canvasId,
      mode: statusOptions.mode || 'session-workset',
      currentNodeRefs: statusOptions.currentNodeRefs || [],
      artifacts
    });
    const issues = [];
    artifacts.forEach(artifact => {
      const validation = artifactStore.verify(artifact.artifactVersionId);
      if (!validation.valid) {
        issues.push({ type: 'artifact-invalid', artifactVersionId: artifact.artifactVersionId, message: validation.error });
      }
      dependencyGraph.inputsOf(artifact.artifactVersionId).forEach(ref => {
        const inputArtifact = artifactStore.get(ref.artifactVersionId, { verify: false });
        if (!inputArtifact) {
          issues.push({ type: 'dependency-missing', artifactVersionId: artifact.artifactVersionId, inputVersionId: ref.artifactVersionId });
        } else if (String(inputArtifact.metadata?.canvasId || '') !== projection.canvasId) {
          issues.push({ type: 'dependency-cross-canvas', artifactVersionId: artifact.artifactVersionId });
        }
      });
    });
    const ledger = taskLedger.load();
    const ledgerValidation = taskLedger.validate(ledger);
    if (!ledgerValidation.valid) {
      ledgerValidation.errors.forEach(message => issues.push({ type: 'ledger-invalid', message }));
    }
    if (projection.artifactCount !== artifacts.length) {
      issues.push({ type: 'projection-mismatch', expected: artifacts.length, actual: projection.artifactCount });
    }
    const recovery = {
      schemaVersion: 2,
      healthy: issues.length === 0,
      auditedAt: recoveryAuditor.clock(),
      canvasId: projection.canvasId,
      artifactCount: artifacts.length,
      issues,
      nextAction: ledger?.nextAction || null
    };
    return { projection, recovery, ledger };
  }

  return { rootPath, artifactStore, dependencyGraph, taskLedger, approvalGate, impactPropagator, executionGuard, recoveryAuditor, createArtifact, appendSessionEvent, status };
}

module.exports = { PHASES, createCanvasAgentFoundation, defaultLedger };
