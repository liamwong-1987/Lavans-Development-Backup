'use strict';

const { clone, safeId, sha256 } = require('./canvasAgentFoundation/atomicJsonStore');

const SCHEMA_VERSION = 2;
const TASK_KINDS = new Set(['image', 'video', 'audio', 'tool']);
const TASK_STATUSES = new Set(['reserved', 'queued', 'submitting', 'running', 'remote-unknown', 'succeeded', 'failed', 'cancelled']);
const INPUT_SCOPES = new Set(['canvas', 'canvas-agent']);
const ROUND_IDENTITY_FIELDS = Object.freeze([
  'roundId',
  'itemId',
  'stageId',
  'planRevision',
  'planHash',
  'parentAuthorizationId'
]);

function bindingError(message, statusCode = 400, code = 'AGENT_NATIVE_TASK_BINDING_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function identifier(value, label) {
  try {
    return safeId(value, label);
  } catch (_error) {
    throw bindingError(`${label} 不合法`, 400, 'INVALID_ID');
  }
}

function plainText(value, limit, label, required = false) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (required && !text) throw bindingError(`${label} 不能为空`, 400, 'INVALID_INPUT');
  if (text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) throw bindingError(`${label} 不合法`, 400, 'INVALID_INPUT');
  return text;
}

function explicitProvider(value) {
  const provider = plainText(value, 160, 'Provider');
  if (!provider) throw bindingError('必须显式指定 Provider', 400, 'EXPLICIT_PROVIDER_REQUIRED');
  return provider;
}

function explicitModel(value) {
  const model = plainText(value, 240, '模型');
  if (!model) throw bindingError('必须显式指定模型', 400, 'EXPLICIT_MODEL_REQUIRED');
  return model;
}

function inputHash(value) {
  const hash = plainText(value, 64, '输入摘要').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw bindingError('输入摘要必须是 64 位十六进制值', 400, 'INVALID_INPUT_HASH');
  return hash;
}

function normalizedRoundIdentity(input) {
  const present = ROUND_IDENTITY_FIELDS.filter(field => input[field] !== undefined && input[field] !== null);
  if (present.length === 0) return null;
  if (present.length !== ROUND_IDENTITY_FIELDS.length) {
    throw bindingError('Round 任务身份必须六项齐全', 400, 'INCOMPLETE_ROUND_IDENTITY');
  }
  const planRevision = Number(input.planRevision);
  if (!Number.isInteger(planRevision) || planRevision < 1 || planRevision > 1_000_000) {
    throw bindingError('计划版本不合法', 400, 'INVALID_PLAN_REVISION');
  }
  const planHash = plainText(input.planHash, 64, '计划摘要').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(planHash)) {
    throw bindingError('计划摘要必须是 64 位十六进制值', 400, 'INVALID_PLAN_HASH');
  }
  return {
    roundId: identifier(input.roundId, 'GenerationRound ID'),
    itemId: identifier(input.itemId, '生成项 ID'),
    stageId: identifier(input.stageId, '生成阶段 ID'),
    planRevision,
    planHash,
    parentAuthorizationId: identifier(input.parentAuthorizationId, '主授权 ID')
  };
}

function taskKind(value) {
  const kind = plainText(value, 40, '任务类型', true);
  if (!TASK_KINDS.has(kind)) throw bindingError('任务类型不受支持', 400, 'INVALID_TASK_KIND');
  return kind;
}

function taskStatus(value, fallback = 'reserved') {
  const status = plainText(value === undefined ? fallback : value, 40, '任务状态', true);
  if (!TASK_STATUSES.has(status)) throw bindingError('任务状态不受支持', 400, 'INVALID_TASK_STATUS');
  return status;
}

function normalizedInputRefs(value) {
  const refs = value === undefined || value === null ? [] : value;
  if (!Array.isArray(refs) || refs.length > 100) throw bindingError('输入引用不合法', 400, 'INVALID_INPUT_REFS');
  return refs.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw bindingError('输入引用不合法', 400, 'INVALID_INPUT_REFS');
    const scope = plainText(ref.workspaceScope, 40, '输入引用工作区', true);
    if (!INPUT_SCOPES.has(scope)) throw bindingError('输入引用不能来自一键复色工作区', 400, 'INVALID_INPUT_SCOPE');
    return {
      refId: identifier(ref.refId, '输入引用 ID'),
      workspaceScope: scope
    };
  });
}

function normalizedInputVersionIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw bindingError('付费任务必须绑定输入版本', 400, 'INVALID_INPUT_VERSION_IDS');
  }
  return [...new Set(value.map(id => identifier(id, '输入版本 ID')))].sort();
}

function finiteNumber(value, label, { integer = false, minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isInteger(number))) {
    throw bindingError(`${label}不合法`, 400, 'INVALID_EXECUTION_LIMIT');
  }
  return number;
}

function normalizedExecutionItems(value, label, maximum) {
  const items = value === undefined || value === null ? [] : value;
  if (!Array.isArray(items) || items.length > maximum) {
    throw bindingError(`${label}不合法`, 400, 'INVALID_EXECUTION_PAYLOAD');
  }
  try {
    return clone(items.slice(0, maximum));
  } catch (_error) {
    throw bindingError(`${label}无法规范化`, 400, 'INVALID_EXECUTION_PAYLOAD');
  }
}

function normalizeAgentNativeExecutionPayload(kindValue, payload = {}, inputRefs = []) {
  const kind = taskKind(kindValue);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw bindingError('Provider 执行载荷不合法', 400, 'INVALID_EXECUTION_PAYLOAD');
  }
  const envelope = {
    taskKind: kind,
    inputRefs: normalizedInputRefs(inputRefs)
  };
  if (kind === 'image') {
    return {
      ...envelope,
      type: plainText(payload.type || 'generator', 80, '图片任务类型', true),
      prompt: plainText(payload.prompt, 60_000, '图片 Prompt', true),
      size: plainText(payload.size || payload.imageSize || '1024x1024', 80, '图片尺寸', true),
      assets: normalizedExecutionItems(payload.assets, '图片素材', 10)
    };
  }
  if (kind === 'video') {
    return {
      ...envelope,
      prompt: plainText(payload.prompt, 60_000, '视频 Prompt', true),
      duration: Math.max(1, finiteNumber(payload.duration || 5, '视频时长')),
      resolution: plainText(payload.resolution, 80, '视频分辨率').toLowerCase(),
      aspectRatio: plainText(payload.aspect_ratio || payload.aspectRatio || '16:9', 40, '视频比例', true),
      images: normalizedExecutionItems(payload.images, '视频参考图', 100)
    };
  }
  if (kind === 'audio') {
    return {
      ...envelope,
      input: plainText(payload.input || payload.prompt, 4_096, '音频文本', true),
      voice: plainText(payload.voice || 'alloy', 40, '音色', true).toLowerCase(),
      responseFormat: plainText(payload.response_format || payload.responseFormat || 'wav', 20, '音频格式', true).toLowerCase(),
      speed: finiteNumber(payload.speed ?? 1, '语速')
    };
  }
  throw bindingError('当前 Provider 执行载荷只支持图片、视频或音频', 400, 'INVALID_EXECUTION_TASK_KIND');
}

function hashAgentNativeExecutionPayload(kind, payload, inputRefs) {
  return sha256(normalizeAgentNativeExecutionPayload(kind, payload, inputRefs));
}

function normalizedRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bindingError('任务绑定载荷不合法', 400, 'INVALID_INPUT');
  const scope = plainText(input.workspaceScope, 40, '任务工作区', true);
  if (scope !== 'canvas-agent') throw bindingError('Agent 原生任务只能属于 canvas-agent', 400, 'INVALID_WORKSPACE_SCOPE');
  if (input.allowFallback !== undefined && typeof input.allowFallback !== 'boolean') {
    throw bindingError('allowFallback 必须是布尔值', 400, 'INVALID_INPUT');
  }
  if (input.allowFallback === true) throw bindingError('Agent 原生任务禁止 Provider 或模型 fallback', 400, 'FALLBACK_FORBIDDEN');

  const roundIdentity = normalizedRoundIdentity(input);
  const immutable = {
    workspaceScope: scope,
    agentSessionId: identifier(input.agentSessionId, 'AgentSession ID'),
    toolRunId: identifier(input.toolRunId, 'Tool Run ID'),
    nodeId: identifier(input.nodeId, '节点 ID'),
    operationId: identifier(input.operationId, 'operationId'),
    ...(roundIdentity || {}),
    inputHash: inputHash(input.inputHash),
    provider: explicitProvider(input.provider),
    model: explicitModel(input.model),
    taskKind: taskKind(input.taskKind),
    authorizationId: identifier(input.authorizationId, '付费授权 ID'),
    inputVersionIds: normalizedInputVersionIds(input.inputVersionIds),
    quantity: finiteNumber(input.quantity, '生成数量', { integer: true, minimum: 1 }),
    estimatedCost: finiteNumber(input.estimatedCost, '预估费用'),
    approvedBudget: finiteNumber(input.approvedBudget, '批准预算'),
    retryBudget: finiteNumber(input.retryBudget, '重试预算', { integer: true }),
    currency: plainText(input.currency || 'CNY', 12, '币种', true),
    inputRefs: normalizedInputRefs(input.inputRefs),
    allowFallback: false
  };
  if (immutable.approvedBudget < immutable.estimatedCost) {
    throw bindingError('批准预算不能低于预估费用', 400, 'APPROVED_BUDGET_TOO_LOW');
  }
  return {
    immutable,
    requestHash: sha256(immutable),
    taskId: plainText(input.taskId, 320, '本地任务 ID'),
    remoteTaskId: plainText(input.remoteTaskId, 320, '远端任务 ID'),
    status: taskStatus(input.status),
    hasStatus: Object.prototype.hasOwnProperty.call(input, 'status')
  };
}

function currentTime(options) {
  const value = Number(typeof options?.clock === 'function' ? options.clock() : Date.now());
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function resolveAgentNativeTaskBinding(existingBinding, input = {}, options = {}) {
  const incoming = normalizedRequest(input);
  const timestamp = currentTime(options);
  if (existingBinding === undefined || existingBinding === null) {
    return {
      binding: {
        schemaVersion: SCHEMA_VERSION,
        ...incoming.immutable,
        requestHash: incoming.requestHash,
        taskId: incoming.taskId,
        remoteTaskId: incoming.remoteTaskId,
        status: incoming.status,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      created: true,
      idempotent: false
    };
  }
  if (!existingBinding || typeof existingBinding !== 'object' || Array.isArray(existingBinding)) {
    throw bindingError('已有任务绑定不合法', 500, 'CORRUPT_TASK_BINDING');
  }
  if (existingBinding.operationId !== incoming.immutable.operationId) {
    throw bindingError('已有绑定属于另一个 operationId', 409, 'OPERATION_BINDING_CONFLICT');
  }
  if (existingBinding.requestHash !== incoming.requestHash) {
    throw bindingError('operationId 已用于不同载荷', 409, 'IDEMPOTENCY_CONFLICT');
  }
  if (existingBinding.taskId && incoming.taskId && existingBinding.taskId !== incoming.taskId) {
    throw bindingError('本地任务 ID 已绑定且不可替换', 409, 'TASK_BINDING_CONFLICT');
  }
  if (existingBinding.remoteTaskId && incoming.remoteTaskId && existingBinding.remoteTaskId !== incoming.remoteTaskId) {
    throw bindingError('远端任务 ID 已绑定且不可替换', 409, 'REMOTE_TASK_BINDING_CONFLICT');
  }

  const binding = clone(existingBinding);
  let changed = false;
  if (!binding.taskId && incoming.taskId) {
    binding.taskId = incoming.taskId;
    changed = true;
  }
  if (!binding.remoteTaskId && incoming.remoteTaskId) {
    binding.remoteTaskId = incoming.remoteTaskId;
    changed = true;
  }
  if (incoming.hasStatus && binding.status !== incoming.status) {
    binding.status = incoming.status;
    changed = true;
  }
  if (changed) binding.updatedAt = timestamp;
  return { binding, created: false, idempotent: !changed };
}

module.exports = Object.freeze({
  resolveAgentNativeTaskBinding,
  normalizeAgentNativeExecutionPayload,
  hashAgentNativeExecutionPayload
});
