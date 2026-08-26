'use strict';

const crypto = require('node:crypto');

const ALLOWED_KINDS = new Set(['image', 'video', 'audio', 'tool']);
const ITEM_STATUSES = new Set([
  'planned',
  'queued',
  'submitting',
  'running',
  'remote-unknown',
  'succeeded',
  'failed',
  'cancelled',
  'blocked-by-dependency'
]);
const EXECUTION_FIELDS = ['toolRunId', 'nodeId', 'operationId', 'inputHash', 'remoteTaskId'];
const MAX_PLAN_BYTES = 100_000;

function planError(message, code = 'INVALID_GENERATION_ROUND_PLAN', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function identifier(value, label) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id)) {
    throw planError(`${label} 不合法`, 'INVALID_GENERATION_PLAN_ID');
  }
  return id;
}

function optionalIdentifier(value, label) {
  const id = value === undefined || value === null ? '' : String(value).trim();
  return id ? identifier(id, label) : '';
}

function text(value, label, limit, required = false) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  if (required && !normalized) throw planError(`${label} 不能为空`);
  if (normalized.length > limit) throw planError(`${label} 超出长度限制`);
  return normalized;
}

function canonicalValue(value, label = '值') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw planError(`${label} 必须是有限数字`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalValue(entry, `${label}[${index}]`));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw planError(`${label} 不是合法 JSON 值`);
  }
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalValue(value[key], `${label}.${key}`)])
  );
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function allowedKinds(options) {
  const configured = options?.allowedKinds;
  const values = configured instanceof Set ? [...configured] : (Array.isArray(configured) ? configured : [...ALLOWED_KINDS]);
  const normalized = new Set(values.map(value => String(value || '').trim()));
  if (!normalized.size || [...normalized].some(kind => !ALLOWED_KINDS.has(kind))) {
    throw planError('允许的媒体类型配置不合法', 'UNAUTHORIZED_MEDIA_KIND');
  }
  return normalized;
}

function normalizeStage(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw planError(`生成阶段 ${index + 1} 不合法`);
  }
  return {
    stageId: identifier(value.stageId, `生成阶段 ${index + 1} ID`),
    label: text(value.label, `生成阶段 ${index + 1}名称`, 240)
  };
}

function normalizeDependency(value, itemIndex, dependencyIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw planError(`生成项 ${itemIndex + 1} 的依赖 ${dependencyIndex + 1} 不合法`);
  }
  return {
    itemId: identifier(value.itemId, `生成项 ${itemIndex + 1} 依赖 ID`),
    role: value.role === undefined || value.role === null || String(value.role).trim() === ''
      ? ''
      : identifier(value.role, `生成项 ${itemIndex + 1} 依赖角色`)
  };
}

function normalizeBranchIdentity(value, itemIndex) {
  const identity = {
    parentNodeRef: optionalIdentifier(value.parentNodeRef, `生成项 ${itemIndex + 1} 父节点`),
    branchRootRef: optionalIdentifier(value.branchRootRef, `生成项 ${itemIndex + 1} 分支根节点`),
    supersedesRef: optionalIdentifier(value.supersedesRef, `生成项 ${itemIndex + 1} 被替代节点`)
  };
  const refs = Object.values(identity);
  if (!refs.some(Boolean)) return {};
  if (refs.some(ref => !ref) || identity.parentNodeRef !== identity.supersedesRef) {
    throw planError('重做分支身份必须完整，且父节点必须是被替代节点', 'INVALID_GENERATION_BRANCH_IDENTITY');
  }
  return identity;
}

function normalizeItem(value, index, permittedKinds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw planError(`生成项 ${index + 1} 不合法`);
  }
  const kind = String(value.kind || '').trim();
  if (!permittedKinds.has(kind)) throw planError(`媒体类型 ${kind || '(空)'} 未获授权`, 'UNAUTHORIZED_MEDIA_KIND');
  if (Number(value.quantity) !== 1 || !Number.isInteger(Number(value.quantity))) {
    throw planError('每个生成项必须对应一个独立输出', 'INVALID_GENERATION_ITEM_QUANTITY');
  }
  if (value.status !== undefined && String(value.status).trim() !== 'planned') {
    throw planError('纯计划不能预写执行状态', 'PLAN_EXECUTION_BINDING_FORBIDDEN');
  }
  if (EXECUTION_FIELDS.some(field => hasOwn(value, field) && value[field] !== '' && value[field] !== null && value[field] !== undefined)) {
    throw planError('纯计划不能预写执行绑定或远端结果', 'PLAN_EXECUTION_BINDING_FORBIDDEN');
  }
  if (!value.spec || typeof value.spec !== 'object' || Array.isArray(value.spec)) {
    throw planError(`生成项 ${index + 1} 规格必须是对象`);
  }
  const dependencies = Array.isArray(value.dependsOn) ? value.dependsOn : [];
  if (dependencies.length > 1_000) throw planError('生成项依赖过多');
  const normalizedDependencies = dependencies
    .map((dependency, dependencyIndex) => normalizeDependency(dependency, index, dependencyIndex))
    .sort((left, right) => left.itemId.localeCompare(right.itemId) || left.role.localeCompare(right.role));
  const dependencyKeys = normalizedDependencies.map(dependency => `${dependency.itemId}\u0000${dependency.role}`);
  if (new Set(dependencyKeys).size !== dependencyKeys.length) {
    throw planError('生成项包含重复依赖', 'DUPLICATE_GENERATION_DEPENDENCY');
  }
  const branchIdentity = normalizeBranchIdentity(value, index);
  return {
    itemId: identifier(value.itemId, `生成项 ${index + 1} ID`),
    stageId: identifier(value.stageId, `生成项 ${index + 1} 阶段 ID`),
    kind,
    prompt: text(value.prompt, `生成项 ${index + 1} Prompt`, 60_000, true),
    promptVersion: value.promptVersion === undefined || value.promptVersion === null || String(value.promptVersion).trim() === ''
      ? ''
      : identifier(value.promptVersion, `生成项 ${index + 1} Prompt 版本`),
    provider: text(value.provider, `生成项 ${index + 1} Provider`, 160, true),
    model: text(value.model, `生成项 ${index + 1} 模型`, 240, true),
    spec: canonicalValue(value.spec, `生成项 ${index + 1}规格`),
    quantity: 1,
    dependsOn: normalizedDependencies,
    ...branchIdentity,
    status: 'planned'
  };
}

function buildTopologicalOrder(items) {
  const itemIds = new Set(items.map(item => item.itemId));
  const indegree = new Map(items.map(item => [item.itemId, item.dependsOn.length]));
  const dependents = new Map(items.map(item => [item.itemId, []]));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!itemIds.has(dependency.itemId)) {
        throw planError(`生成项 ${item.itemId} 引用了不存在的依赖 ${dependency.itemId}`, 'MISSING_GENERATION_DEPENDENCY');
      }
      if (dependency.itemId === item.itemId) {
        throw planError(`生成项 ${item.itemId} 不能依赖自身`, 'GENERATION_PLAN_CYCLE');
      }
      dependents.get(dependency.itemId).push(item.itemId);
    }
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([itemId]) => itemId).sort();
  const order = [];
  while (ready.length) {
    const itemId = ready.shift();
    order.push(itemId);
    for (const dependentId of dependents.get(itemId).sort()) {
      const next = indegree.get(dependentId) - 1;
      indegree.set(dependentId, next);
      if (next === 0) {
        ready.push(dependentId);
        ready.sort();
      }
    }
  }
  if (order.length !== items.length) throw planError('生成计划包含循环依赖', 'GENERATION_PLAN_CYCLE');
  return order;
}

function immutableIdentity(stages, items) {
  return {
    stages,
    items: items.map(({ status, ...item }) => item)
  };
}

function normalizeGenerationPlan(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw planError('生成计划必须是对象');
  const planRevision = Number(input.planRevision);
  if (!Number.isInteger(planRevision) || planRevision < 1 || planRevision > 1_000_000) {
    throw planError('生成计划版本不合法');
  }
  if (!Array.isArray(input.stages) || !Array.isArray(input.items)
    || input.stages.length < 1 || input.items.length < 1
    || input.stages.length > 1_000 || input.items.length > 2_000) {
    throw planError('生成计划必须包含有界阶段和项目');
  }
  const sourceStages = input.stages.map(normalizeStage);
  const sourceItems = input.items.map((item, index) => normalizeItem(item, index, allowedKinds(options)));
  const stages = [...sourceStages].sort((left, right) => left.stageId.localeCompare(right.stageId));
  const items = [...sourceItems].sort((left, right) => left.itemId.localeCompare(right.itemId));
  if (new Set(stages.map(stage => stage.stageId)).size !== stages.length) {
    throw planError('生成阶段 ID 重复', 'DUPLICATE_GENERATION_STAGE_ID');
  }
  if (new Set(items.map(item => item.itemId)).size !== items.length) {
    throw planError('生成项 ID 重复', 'DUPLICATE_GENERATION_ITEM_ID');
  }
  const stageIds = new Set(stages.map(stage => stage.stageId));
  const missingStage = items.find(item => !stageIds.has(item.stageId));
  if (missingStage) throw planError(`生成项 ${missingStage.itemId} 引用了不存在的阶段`, 'MISSING_GENERATION_STAGE');

  const topologicalOrder = buildTopologicalOrder(items);
  const identity = immutableIdentity(stages, items);
  const sourceIdentity = immutableIdentity(sourceStages, sourceItems);
  if (Buffer.byteLength(stableStringify(identity), 'utf8') > MAX_PLAN_BYTES) {
    throw planError('生成计划超出大小限制', 'GENERATION_PLAN_TOO_LARGE');
  }
  return {
    planRevision,
    stages,
    items,
    planHash: hash(identity),
    sourcePlanHash: hash(sourceIdentity),
    topologicalOrder
  };
}

function validateGenerationPlan(input, options = {}) {
  return normalizeGenerationPlan(input, options);
}

function canonicalGenerationPlanHash(input, options = {}) {
  return normalizeGenerationPlan(input, options).planHash;
}

function topologicalSort(input, options = {}) {
  return normalizeGenerationPlan(input, options).topologicalOrder;
}

function normalizeStatuses(plan, statusByItemId = {}) {
  if (!statusByItemId || typeof statusByItemId !== 'object' || Array.isArray(statusByItemId)) {
    throw planError('生成项状态表不合法', 'INVALID_GENERATION_ITEM_STATUS');
  }
  const knownIds = new Set(plan.items.map(item => item.itemId));
  for (const itemId of Object.keys(statusByItemId)) {
    if (!knownIds.has(itemId)) throw planError(`状态表包含未知生成项 ${itemId}`, 'GENERATION_PLAN_DRIFT', 409);
  }
  return Object.fromEntries(plan.items.map(item => {
    const status = statusByItemId[item.itemId] === undefined ? item.status : String(statusByItemId[item.itemId]).trim();
    if (!ITEM_STATUSES.has(status)) throw planError(`生成项 ${item.itemId} 状态不合法`, 'INVALID_GENERATION_ITEM_STATUS');
    return [item.itemId, status];
  }));
}

function selectReadyItems(input, statusByItemId = {}, options = {}) {
  const plan = normalizeGenerationPlan(input, options);
  const statuses = normalizeStatuses(plan, statusByItemId);
  return plan.items.filter(item => statuses[item.itemId] === 'planned'
    && item.dependsOn.every(dependency => statuses[dependency.itemId] === 'succeeded'));
}

function summarizeGenerationCost(input, quotesByItemId, options = {}) {
  const plan = normalizeGenerationPlan(input, options);
  if (!quotesByItemId || typeof quotesByItemId !== 'object' || Array.isArray(quotesByItemId)) {
    throw planError('费用报价表不合法', 'INVALID_GENERATION_COST');
  }
  const knownIds = new Set(plan.items.map(item => item.itemId));
  for (const itemId of Object.keys(quotesByItemId)) {
    if (!knownIds.has(itemId)) throw planError(`报价包含未知生成项 ${itemId}`, 'GENERATION_PLAN_DRIFT', 409);
  }
  const byKind = {};
  let currency = '';
  let estimatedCost = 0;
  for (const item of plan.items) {
    const quote = quotesByItemId[item.itemId];
    if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
      throw planError(`生成项 ${item.itemId} 缺少报价`, 'MISSING_GENERATION_COST');
    }
    const itemCurrency = text(quote.currency, `生成项 ${item.itemId} 币种`, 16, true).toUpperCase();
    const itemCost = Number(quote.estimatedCost);
    if (!/^[A-Z]{3,8}$/.test(itemCurrency) || !Number.isFinite(itemCost) || itemCost < 0) {
      throw planError(`生成项 ${item.itemId} 报价不合法`, 'INVALID_GENERATION_COST');
    }
    if (currency && currency !== itemCurrency) throw planError('同一轮报价币种不一致', 'MIXED_GENERATION_CURRENCY');
    currency = itemCurrency;
    estimatedCost += itemCost;
    byKind[item.kind] ||= { itemCount: 0, estimatedCost: 0 };
    byKind[item.kind].itemCount += 1;
    byKind[item.kind].estimatedCost += itemCost;
  }
  estimatedCost = Number(estimatedCost.toFixed(12));
  for (const value of Object.values(byKind)) value.estimatedCost = Number(value.estimatedCost.toFixed(12));
  return { currency, estimatedCost, itemCount: plan.items.length, byKind };
}

function aggregateGenerationStatus(input, statusByItemId = {}, options = {}) {
  const plan = normalizeGenerationPlan(input, options);
  const statuses = Object.values(normalizeStatuses(plan, statusByItemId));
  return aggregateNormalizedStatuses(statuses);
}

function aggregateNormalizedStatuses(statuses) {
  if (statuses.every(status => status === 'succeeded')) return 'completed';
  if (statuses.some(status => status === 'remote-unknown')) return 'remote-unknown';
  if (statuses.some(status => ['queued', 'submitting', 'running'].includes(status))) return 'running';
  if (statuses.every(status => status === 'cancelled')) return 'cancelled';
  const hasFailure = statuses.some(status => ['failed', 'cancelled', 'blocked-by-dependency'].includes(status));
  if (hasFailure && statuses.some(status => status === 'succeeded' || status === 'planned')) return 'partial';
  if (hasFailure) return 'failed';
  return 'planning';
}

function recoverGenerationRoundState(input, statusByItemId = {}, options = {}) {
  const plan = normalizeGenerationPlan(input, options);
  const current = normalizeStatuses(plan, statusByItemId);
  const interruptedItemIds = plan.items
    .filter(item => ['submitting', 'running'].includes(current[item.itemId]))
    .map(item => item.itemId);
  const recovered = Object.fromEntries(plan.items.map(item => [
    item.itemId,
    interruptedItemIds.includes(item.itemId) ? 'remote-unknown' : current[item.itemId]
  ]));
  return {
    statusByItemId: recovered,
    status: aggregateNormalizedStatuses(Object.values(recovered)),
    reconcileRequired: Object.values(recovered).includes('remote-unknown'),
    interruptedItemIds
  };
}

function assertGenerationPlanIdentity(input, expected, options = {}) {
  const plan = normalizeGenerationPlan(input, options);
  const expectedRevision = Number(expected?.planRevision);
  const expectedHash = String(expected?.planHash || '').trim().toLowerCase();
  if (expectedRevision !== plan.planRevision || !/^[a-f0-9]{64}$/.test(expectedHash)
    || (expectedHash !== plan.planHash && expectedHash !== plan.sourcePlanHash)) {
    throw planError('生成计划已发生漂移', 'GENERATION_PLAN_DRIFT', 409);
  }
  return plan;
}

module.exports = Object.freeze({
  aggregateGenerationStatus,
  assertGenerationPlanIdentity,
  canonicalGenerationPlanHash,
  normalizeGenerationPlan,
  recoverGenerationRoundState,
  selectReadyItems,
  summarizeGenerationCost,
  topologicalSort,
  validateGenerationPlan
});
