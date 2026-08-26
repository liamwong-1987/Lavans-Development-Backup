const fs = require('fs');
const path = require('path');
const { atomicWriteJson, clone, ensureDir, readJson, safeId, sha256, stableStringify } = require('./atomicJsonStore');
const { assertGenerationPlanIdentity } = require('../agentGenerationRoundService');

const HASH_RE = /^[a-f0-9]{64}$/;
const ROUND_CHILD_FIELDS = ['parentAuthorizationId', 'roundId', 'planRevision', 'planHash', 'planArtifactVersionId', 'itemId', 'stageId'];

class ExecutionGuard {
  constructor(artifactStore, options = {}) {
    this.artifactStore = artifactStore;
    this.clock = options.clock || (() => Date.now());
    this.filePath = path.join(path.resolve(options.rootPath || artifactStore.rootPath), 'execution-authorizations.json');
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) atomicWriteJson(this.filePath, { authorizations: {} });
  }

  _load() { return readJson(this.filePath, { authorizations: {} }); }
  _save(state) { atomicWriteJson(this.filePath, state); }

  _normalized(input = {}) {
    const hasHighPriceThreshold = input.highPriceThreshold !== undefined
      && input.highPriceThreshold !== null
      && String(input.highPriceThreshold).trim() !== '';
    const request = {
      operationId: safeId(input.operationId, 'operationId'),
      provider: safeId(input.provider, 'provider'),
      model: safeId(input.model, 'model'),
      inputVersionIds: [...new Set((input.inputVersionIds || []).map(id => safeId(id, 'inputVersionId')))].sort(),
      quantity: Number(input.quantity),
      estimatedCost: Number(input.estimatedCost),
      budgetLimit: Number(input.budgetLimit),
      currency: String(input.currency || 'CNY'),
      retryLimit: Number(input.retryLimit || 0),
      executionMode: input.executionMode === 'auto' ? 'auto' : 'manual',
      allowFallback: input.allowFallback === true,
      fallbackProvider: input.allowFallback === true ? safeId(input.fallbackProvider, '') : '',
      fallbackModel: input.allowFallback === true ? safeId(input.fallbackModel, '') : '',
      reviewGateId: safeId(input.reviewGateId || 'paid-batch-review', 'reviewGateId'),
      highPriceThreshold: hasHighPriceThreshold && Number.isFinite(Number(input.highPriceThreshold)) ? Number(input.highPriceThreshold) : null,
      highPriceConfirmed: input.highPriceConfirmed === true
    };
    const agentFields = [
      ['agentSessionId', 'agentSessionId'],
      ['toolRunId', 'toolRunId'],
      ['nodeId', 'nodeId'],
      ['taskKind', 'taskKind']
    ];
    const hasAgentBinding = agentFields.some(([field]) => input[field] !== undefined && input[field] !== null && String(input[field]).trim())
      || (input.inputHash !== undefined && input.inputHash !== null && String(input.inputHash).trim());
    if (hasAgentBinding && (agentFields.some(([field]) => !String(input[field] || '').trim()) || !String(input.inputHash || '').trim())) {
      throw new Error('Agent 付费授权必须完整绑定 Session、toolRun、节点、任务类型和 inputHash');
    }
    for (const [field, label] of agentFields) {
      if (input[field] !== undefined && input[field] !== null && String(input[field]).trim()) {
        request[field] = safeId(input[field], label);
      }
    }
    if (input.inputHash !== undefined && input.inputHash !== null && String(input.inputHash).trim()) {
      const inputHash = String(input.inputHash).trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(inputHash)) throw new Error('inputHash 不合法');
      request.inputHash = inputHash;
    }
    return request;
  }

  _validateRequest(request) {
    if (!request.inputVersionIds.length) throw new Error('付费执行必须绑定输入版本');
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) throw new Error('生成数量不合法');
    if (!Number.isFinite(request.estimatedCost) || request.estimatedCost < 0) throw new Error('预计费用不合法');
    if (!Number.isFinite(request.budgetLimit) || request.budgetLimit < request.estimatedCost) throw new Error('预计费用超过预算');
    if (!Number.isInteger(request.retryLimit) || request.retryLimit < 0) throw new Error('重试上限不合法');
    if (request.allowFallback && (!request.fallbackProvider || !request.fallbackModel)) throw new Error('备用执行必须精确指定站点和模型');
    if (request.highPriceThreshold !== null && request.estimatedCost > request.highPriceThreshold && !request.highPriceConfirmed) throw new Error('高价批次需要再次确认');
    if (!request.reviewGateId) throw new Error('付费执行必须绑定人工审核关');
    request.inputVersionIds.forEach(id => {
      const artifact = this.artifactStore.get(id, { verify: false });
      if (!artifact) throw new Error(`输入版本不存在：${id}`);
      const validation = this.artifactStore.verify(id);
      if (!validation.valid) throw new Error(`输入版本无效：${id}`);
      if (artifact.approvalState !== 'locked' || artifact.validityState !== 'current') throw new Error(`输入版本未锁定或需要复核：${id}`);
    });
  }

  _normalizedRound(input = {}) {
    const planArtifactVersionId = safeId(input.planArtifactVersionId, 'planArtifactVersionId');
    const artifact = this.artifactStore.get(planArtifactVersionId, { verify: false });
    const planHash = String(input.planHash || '').trim().toLowerCase();
    if (!HASH_RE.test(planHash)) throw new Error('planHash 不合法');
    const request = {
      agentSessionId: safeId(input.agentSessionId, 'agentSessionId'),
      roundId: safeId(input.roundId, 'roundId'),
      planRevision: Number(input.planRevision),
      planHash,
      planArtifactVersionId,
      planArtifactContentHash: String(artifact?.contentHash || '').trim().toLowerCase(),
      totalQuantity: Number(input.totalQuantity),
      estimatedCost: Number(input.estimatedCost),
      budgetLimit: Number(input.budgetLimit),
      currency: String(input.currency || 'CNY').trim().toUpperCase(),
      executionMode: input.executionMode === 'auto' ? 'auto' : 'manual',
      reviewGateId: safeId(input.reviewGateId || 'paid-round-review', 'reviewGateId')
    };
    this._validateRoundRequest(request);
    return request;
  }

  _validateRoundRequest(request) {
    if (!Number.isInteger(request.planRevision) || request.planRevision < 1) throw new Error('计划版本不合法');
    if (!HASH_RE.test(request.planHash) || !HASH_RE.test(request.planArtifactContentHash)) throw new Error('计划摘要不合法');
    if (!Number.isInteger(request.totalQuantity) || request.totalQuantity <= 0) throw new Error('Round 总数量不合法');
    if (!Number.isFinite(request.estimatedCost) || request.estimatedCost < 0) throw new Error('Round 预计费用不合法');
    if (!Number.isFinite(request.budgetLimit) || request.budgetLimit < request.estimatedCost) throw new Error('Round 预计费用超过预算');
    if (!/^[A-Z]{3,8}$/.test(request.currency)) throw new Error('Round 币种不合法');
    const artifact = this.artifactStore.get(request.planArtifactVersionId, { verify: false });
    if (!artifact) throw new Error('Round 计划产物不存在');
    const validation = this.artifactStore.verify(request.planArtifactVersionId);
    if (!validation.valid || validation.contentHash !== request.planArtifactContentHash) throw new Error('Round 计划产物校验失败');
    if (artifact.approvalState !== 'locked' || artifact.validityState !== 'current') throw new Error('Round 计划产物未锁定或需要复核');
    let envelope;
    try { envelope = JSON.parse(this.artifactStore.readContent(request.planArtifactVersionId, { maxBytes: 200_000 })); }
    catch (_error) { throw new Error('Round 计划产物内容不合法'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.agentSessionId !== request.agentSessionId || envelope.roundId !== request.roundId
      || Number(envelope.planRevision) !== request.planRevision || String(envelope.planHash || '').toLowerCase() !== request.planHash) {
      throw new Error('Round 计划产物身份不一致');
    }
    const plan = assertGenerationPlanIdentity(envelope.plan && typeof envelope.plan === 'object' ? envelope.plan : envelope, {
      planRevision: request.planRevision,
      planHash: request.planHash
    });
    if (plan.items.length !== request.totalQuantity) throw new Error('Round 总数量与锁定计划不一致');
    return plan;
  }

  _normalizedChild(input = {}) {
    const request = this._normalized(input);
    const planHash = String(input.planHash || '').trim().toLowerCase();
    if (!HASH_RE.test(planHash)) throw new Error('planHash 不合法');
    return {
      ...request,
      parentAuthorizationId: safeId(input.parentAuthorizationId, 'parentAuthorizationId'),
      roundId: safeId(input.roundId, 'roundId'),
      planRevision: Number(input.planRevision),
      planHash,
      planArtifactVersionId: safeId(input.planArtifactVersionId, 'planArtifactVersionId'),
      itemId: safeId(input.itemId, 'itemId'),
      stageId: safeId(input.stageId, 'stageId')
    };
  }

  _validateChildRequest(request, state) {
    this._validateRequest(request);
    if (request.quantity !== 1 || request.retryLimit !== 0 || request.allowFallback) {
      throw new Error('Round 子回执必须是单项、零重试且禁止备用执行');
    }
    const parent = state.authorizations[request.parentAuthorizationId];
    if (!parent || parent.authorizationType !== 'round-master') throw new Error('缺少 Round 父授权');
    if (sha256(stableStringify(parent.request)) !== parent.signature) throw new Error('Round 父授权记录校验失败');
    if (!parent.consumedAt) throw new Error('Round 父授权尚未使用');
    const plan = this._validateRoundRequest(clone(parent.request));
    if (request.agentSessionId !== parent.request.agentSessionId || request.roundId !== parent.request.roundId
      || request.planRevision !== parent.request.planRevision || request.planHash !== parent.request.planHash
      || request.planArtifactVersionId !== parent.request.planArtifactVersionId) {
      throw new Error('Round 子回执与父授权身份不一致');
    }
    const item = plan.items.find(candidate => candidate.itemId === request.itemId);
    if (!item || item.stageId !== request.stageId || item.kind !== request.taskKind
      || item.provider !== request.provider || item.model !== request.model) {
      throw new Error('子回执与生成计划绑定不一致');
    }
    if (!request.inputVersionIds.includes(parent.request.planArtifactVersionId)) throw new Error('子回执未绑定锁定计划产物');
    if (request.currency.toUpperCase() !== parent.request.currency) throw new Error('子回执币种与 Round 不一致');
    return { parent, plan, item };
  }

  authorize(input = {}) {
    if (ROUND_CHILD_FIELDS.some(field => input[field] !== undefined && input[field] !== null && String(input[field]).trim())) {
      throw new Error('Round 子项必须由已消费父授权派生');
    }
    const request = this._normalized(input);
    this._validateRequest(request);
    const signature = sha256(stableStringify(request));
    const authorization = { authorizationId: `auth-${signature.slice(0, 24)}`, signature, request, authorizedBy: String(input.authorizedBy || 'user'), authorizedAt: this.clock(), consumedAt: null };
    const state = this._load();
    const existing = state.authorizations[authorization.authorizationId];
    if (existing) {
      if (existing.signature !== signature || sha256(stableStringify(existing.request)) !== signature) throw new Error('付费授权记录冲突或已损坏');
      return clone(existing);
    }
    state.authorizations[authorization.authorizationId] = authorization;
    this._save(state);
    return clone(authorization);
  }

  authorizeRound(input = {}) {
    const request = this._normalizedRound(input);
    const signature = sha256(stableStringify(request));
    const authorizationId = `round-auth-${signature.slice(0, 24)}`;
    const state = this._load();
    const existing = state.authorizations[authorizationId];
    if (existing) {
      if (existing.authorizationType !== 'round-master' || existing.signature !== signature
        || sha256(stableStringify(existing.request)) !== signature) throw new Error('Round 授权记录冲突或已损坏');
      this._validateRoundRequest(clone(existing.request));
      return clone(existing);
    }
    const authorization = {
      authorizationId,
      authorizationType: 'round-master',
      signature,
      request,
      authorizedBy: String(input.authorizedBy || 'user'),
      authorizedAt: this.clock(),
      consumedAt: null,
      derivedItems: {},
      derivedEstimatedCost: 0,
      derivedBudget: 0
    };
    state.authorizations[authorizationId] = authorization;
    this._save(state);
    return clone(authorization);
  }

  consumeRoundAuthorization(input = {}) {
    const authorizationId = safeId(input.authorizationId, 'authorizationId');
    const state = this._load();
    const authorization = state.authorizations[authorizationId];
    if (!authorization || authorization.authorizationType !== 'round-master') throw new Error('缺少 Round 主授权');
    if (sha256(stableStringify(authorization.request)) !== authorization.signature) throw new Error('Round 授权记录校验失败');
    this._validateRoundRequest(clone(authorization.request));
    const identity = {
      agentSessionId: safeId(input.agentSessionId, 'agentSessionId'),
      roundId: safeId(input.roundId, 'roundId'),
      planRevision: Number(input.planRevision),
      planHash: String(input.planHash || '').trim().toLowerCase(),
      planArtifactVersionId: safeId(input.planArtifactVersionId, 'planArtifactVersionId')
    };
    for (const [field, value] of Object.entries(identity)) {
      if (value !== authorization.request[field]) throw new Error('Round 主授权身份已变化');
    }
    if (authorization.consumedAt) return { ...clone(authorization), idempotent: true };
    authorization.consumedAt = this.clock();
    this._save(state);
    return { ...clone(authorization), idempotent: false };
  }

  deriveRoundItemReceipt(input = {}) {
    const parentAuthorizationId = safeId(input.parentAuthorizationId, 'parentAuthorizationId');
    const itemId = safeId(input.itemId, 'itemId');
    const state = this._load();
    const parent = state.authorizations[parentAuthorizationId];
    if (!parent || parent.authorizationType !== 'round-master') throw new Error('缺少 Round 父授权');
    if (sha256(stableStringify(parent.request)) !== parent.signature) throw new Error('Round 父授权记录校验失败');
    if (!parent.consumedAt) throw new Error('Round 父授权尚未使用');
    const plan = this._validateRoundRequest(clone(parent.request));
    const item = plan.items.find(candidate => candidate.itemId === itemId);
    if (!item) throw new Error('Round 生成项不存在');
    for (const [field, expected] of Object.entries({
      roundId: parent.request.roundId,
      planRevision: parent.request.planRevision,
      planHash: parent.request.planHash,
      planArtifactVersionId: parent.request.planArtifactVersionId,
      stageId: item.stageId
    })) {
      if (input[field] !== undefined && input[field] !== null && String(input[field]).trim()
        && String(input[field]).trim() !== String(expected)) throw new Error('Round 子回执请求发生漂移');
    }
    const request = {
      ...this._normalized(input),
      parentAuthorizationId,
      roundId: parent.request.roundId,
      planRevision: parent.request.planRevision,
      planHash: parent.request.planHash,
      planArtifactVersionId: parent.request.planArtifactVersionId,
      itemId,
      stageId: item.stageId
    };
    this._validateChildRequest(request, state);
    const signature = sha256(stableStringify(request));
    parent.derivedItems ||= {};
    const existingId = parent.derivedItems[itemId];
    if (existingId) {
      const existing = state.authorizations[existingId];
      if (!existing || existing.authorizationType !== 'round-item-child' || existing.signature !== signature
        || sha256(stableStringify(existing.request)) !== signature) throw new Error('同一生成项的子回执发生漂移');
      return { ...clone(existing), idempotent: true };
    }
    for (const authorization of Object.values(state.authorizations)) {
      if (authorization.authorizationType !== 'round-item-child') continue;
      if (['operationId', 'toolRunId', 'nodeId'].some(field => authorization.request?.[field] === request[field])) {
        throw new Error('执行身份已绑定另一生成项');
      }
    }
    const nextEstimatedCost = Number((Number(parent.derivedEstimatedCost || 0) + request.estimatedCost).toFixed(12));
    const nextBudget = Number((Number(parent.derivedBudget || 0) + request.budgetLimit).toFixed(12));
    if (nextEstimatedCost > parent.request.estimatedCost || nextBudget > parent.request.budgetLimit) {
      throw new Error('子回执累计费用超过 Round 授权预算');
    }
    const authorizationId = `item-auth-${signature.slice(0, 24)}`;
    const now = this.clock();
    const authorization = {
      authorizationId,
      authorizationType: 'round-item-child',
      parentAuthorizationId,
      signature,
      request,
      authorizedBy: parent.authorizedBy,
      authorizedAt: parent.authorizedAt,
      derivedAt: now,
      consumedAt: now
    };
    const conflicting = state.authorizations[authorizationId];
    if (conflicting) throw new Error('Round 子回执记录冲突或已损坏');
    state.authorizations[authorizationId] = authorization;
    parent.derivedItems[itemId] = authorizationId;
    parent.derivedEstimatedCost = nextEstimatedCost;
    parent.derivedBudget = nextBudget;
    this._save(state);
    return { ...clone(authorization), idempotent: false };
  }

  assertAllowed(input = {}) {
    const authorizationId = safeId(input.authorizationId, 'authorizationId');
    const authorization = this._load().authorizations[authorizationId];
    if (!authorization) throw new Error('缺少精确付费授权');
    if (authorization.authorizationType && authorization.authorizationType !== 'single') throw new Error('Round 授权必须使用专用核验入口');
    if (authorization.consumedAt) throw new Error('付费授权已使用');
    const request = this._normalized(input);
    this._validateRequest(request);
    if (sha256(stableStringify(request)) !== authorization.signature) throw new Error('执行参数已变化，旧授权失效');
    return { allowed: true, authorizationId, request: clone(request) };
  }

  consume(input = {}) {
    const result = this.assertAllowed(input);
    const state = this._load();
    const authorization = state.authorizations[result.authorizationId];
    authorization.consumedAt = this.clock();
    this._save(state);
    return {
      allowed: true,
      authorizationId: result.authorizationId,
      signature: authorization.signature,
      request: clone(authorization.request),
      authorizedBy: authorization.authorizedBy,
      authorizedAt: authorization.authorizedAt,
      consumedAt: authorization.consumedAt
    };
  }

  assertConsumed(input = {}) {
    const authorizationId = safeId(input.authorizationId, 'authorizationId');
    const state = this._load();
    const authorization = state.authorizations[authorizationId];
    if (!authorization) throw new Error('缺少精确付费授权');
    if (!authorization.consumedAt) throw new Error('付费授权尚未使用');
    if (sha256(stableStringify(authorization.request)) !== authorization.signature) throw new Error('付费授权记录校验失败');
    if (authorization.authorizationType === 'round-master') throw new Error('Round 主授权不能直接用于单项执行');
    if (authorization.authorizationType === 'round-item-child') this._validateChildRequest(clone(authorization.request), state);
    else this._validateRequest(clone(authorization.request));
    const suppliedRequest = Object.keys(input).some(key => key !== 'authorizationId' && input[key] !== undefined);
    if (suppliedRequest) {
      const request = authorization.authorizationType === 'round-item-child' ? this._normalizedChild(input) : this._normalized(input);
      if (sha256(stableStringify(request)) !== authorization.signature) throw new Error('执行参数已变化，旧授权失效');
    }
    return {
      allowed: true,
      authorizationId,
      ...(authorization.authorizationType ? { authorizationType: authorization.authorizationType } : {}),
      ...(authorization.parentAuthorizationId ? { parentAuthorizationId: authorization.parentAuthorizationId } : {}),
      signature: authorization.signature,
      request: clone(authorization.request),
      authorizedBy: authorization.authorizedBy,
      authorizedAt: authorization.authorizedAt,
      consumedAt: authorization.consumedAt
    };
  }

  consumeStoredAuthorization(input = {}) {
    const authorizationId = safeId(typeof input === 'string' ? input : input.authorizationId, 'authorizationId');
    const state = this._load();
    const authorization = state.authorizations[authorizationId];
    if (!authorization) throw new Error('缺少精确付费授权');
    if (authorization.authorizationType === 'round-master') throw new Error('Round 主授权必须使用专用消费入口');
    if (sha256(stableStringify(authorization.request)) !== authorization.signature) throw new Error('付费授权记录校验失败');
    this._validateRequest(clone(authorization.request));
    if (authorization.consumedAt) return { ...this.assertConsumed({ authorizationId }), idempotent: true };
    authorization.consumedAt = this.clock();
    this._save(state);
    return {
      allowed: true,
      authorizationId,
      signature: authorization.signature,
      request: clone(authorization.request),
      authorizedBy: authorization.authorizedBy,
      authorizedAt: authorization.authorizedAt,
      consumedAt: authorization.consumedAt,
      idempotent: false
    };
  }
}

module.exports = { ExecutionGuard };
