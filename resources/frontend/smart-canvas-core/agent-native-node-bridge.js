/* Lavans AgentSession -> native canvas node coordinator.
 * Stateless by design: durable truth stays in AgentSession, the canvas node and the task journal.
 */
(function installAgentNativeNodeBridge(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  const bridge = api.createAgentNativeNodeBridge({
    sessionPort: api.createAgentSessionPort(root.LavansCanvasAdapter),
    host: root.AgentNativeNodeHost,
    taskPort: api.createAgentNativeTaskPort(root.LavansCanvasAdapter, root.fetch.bind(root))
  });
  if (!root.AgentNativeNodeBridge) {
    Object.defineProperty(root, 'AgentNativeNodeBridge', {
      value: bridge,
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
})(typeof window === 'undefined' ? globalThis : window, function buildAgentNativeNodeBridge() {
  'use strict';

  const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  const HASH_PATTERN = /^[a-f0-9]{64}$/;
  const TASK_KINDS = new Set(['image', 'video', 'audio']);

  function bridgeError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  }

  function isMissingAgentSession(error) {
    if (Number(error?.status) !== 404) return false;
    if (error?.code === 'AGENT_SESSION_NOT_FOUND') return true;
    const payload = error?.payload;
    return error?.code === 'BRIDGE_REQUEST_FAILED'
      && payload?.success === false
      && !payload?.code
      && payload?.error === 'AgentSession 不存在';
  }

  function orphanedSessionDetach(input) {
    return Object.freeze({ status: 'detached', idempotent: true, orphanedSession: true, ...input });
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function identifier(value, label, optional = false) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (optional && !text) return '';
    if (!ID_PATTERN.test(text)) throw bridgeError(`${label} 不合法`, 'INVALID_ID', { field: label });
    return text;
  }

  function boundedText(value, label, limit, required = false) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if ((required && !text) || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) {
      throw bridgeError(`${label} 不合法`, 'INVALID_INPUT', { field: label });
    }
    return text;
  }

  function finiteNumber(value, label, fallback = 0, integer = false) {
    const number = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
      throw bridgeError(`${label} 不合法`, 'INVALID_INPUT', { field: label });
    }
    return number;
  }

  function stableIdHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function requestId(input, step) {
    const suffix = `.${step}`;
    const direct = `${input.operationId}${suffix}`;
    if (direct.length <= 160) return identifier(direct, 'requestId');
    const digest = stableIdHash(input.operationId);
    const prefixLength = Math.max(1, 160 - suffix.length - digest.length - 1);
    return identifier(`${input.operationId.slice(0, prefixLength)}.${digest}${suffix}`, 'requestId');
  }

  function normalizeInputRefs(value) {
    const refs = value === undefined || value === null ? [] : value;
    if (!Array.isArray(refs) || refs.length > 100) throw bridgeError('输入引用不合法', 'INVALID_INPUT_REFS');
    return refs.map(ref => {
      if (!isRecord(ref) || !['canvas', 'canvas-agent'].includes(ref.workspaceScope)) {
        throw bridgeError('输入引用工作区不合法', 'INVALID_INPUT_SCOPE');
      }
      return Object.freeze({
        refId: identifier(ref.refId, '输入引用 ID'),
        workspaceScope: ref.workspaceScope
      });
    });
  }

  function normalizeExecution(input = {}, options = {}) {
    if (!isRecord(input)) throw bridgeError('协调器输入不合法', 'INVALID_INPUT');
    if (input.workspaceScope !== 'canvas-agent') throw bridgeError('原生执行桥只属于 canvas-agent', 'INVALID_WORKSPACE_SCOPE');
    const authorizationValue = input.authorizationId || input.approval?.authorizationId;
    if (options.requireApproval !== false && !String(authorizationValue || '').trim()) {
      throw bridgeError('真实执行前必须已有已消费的精确授权', 'APPROVAL_REQUIRED');
    }
    const authorizationId = identifier(authorizationValue, '付费授权 ID', true);
    const kind = boundedText(input.kind, '任务类型', 40, true);
    if (!TASK_KINDS.has(kind)) throw bridgeError('当前原生执行桥只接入图片和视频任务', 'INVALID_TASK_KIND');
    const inputHash = boundedText(input.inputHash, '输入摘要', 64, true).toLowerCase();
    if (!HASH_PATTERN.test(inputHash)) throw bridgeError('输入摘要必须是 64 位十六进制值', 'INVALID_INPUT_HASH');
    const estimatedCost = finiteNumber(input.estimatedCost, '预估费用');
    const approvedBudget = finiteNumber(input.approvedBudget, '批准预算');
    if (approvedBudget < estimatedCost) throw bridgeError('批准预算不能低于预估费用', 'APPROVED_BUDGET_TOO_LOW');
    if (input.allowFallback === true) throw bridgeError('原生执行桥禁止备用 Provider 或模型', 'FALLBACK_FORBIDDEN');
    const taskPayload = input.taskPayload === undefined ? {} : input.taskPayload;
    if (!isRecord(taskPayload)) throw bridgeError('任务载荷不合法', 'INVALID_TASK_PAYLOAD');
    const inputRefs = normalizeInputRefs(input.inputRefs);
    const payloadReferences = kind === 'video' && Array.isArray(taskPayload.images) ? taskPayload.images : [];
    const lockedSourceNodeId = payloadReferences.length ? identifier(payloadReferences[0]?.referenceId, '锁定的源节点 ID') : '';
    const requestedSourceNodeId = identifier(input.sourceNodeId, '源节点 ID', true);
    if (kind === 'video' && requestedSourceNodeId !== lockedSourceNodeId) {
      throw bridgeError('视频源节点与已锁定的参考图不一致', 'SOURCE_BINDING_CONFLICT');
    }
    if (lockedSourceNodeId && !inputRefs.some(ref => ref.workspaceScope === 'canvas-agent' && ref.refId === lockedSourceNodeId)) {
      throw bridgeError('视频源节点没有进入已锁定输入引用', 'SOURCE_BINDING_CONFLICT');
    }
    return Object.freeze({
      workspaceScope: 'canvas-agent',
      agentSessionId: identifier(input.agentSessionId, 'AgentSession ID'),
      toolRunId: identifier(input.toolRunId, 'Tool Run ID'),
      nodeId: identifier(input.nodeId, '节点 ID'),
      sourceNodeId: lockedSourceNodeId || requestedSourceNodeId,
      operationId: identifier(input.operationId, 'operationId'),
      inputVersion: identifier(input.inputVersion, '输入版本'),
      inputHash,
      providerId: boundedText(input.providerId, 'Provider', 160, true),
      model: boundedText(input.model, '模型', 240, true),
      kind,
      nodeRole: identifier(input.nodeRole || `${kind}-output`, '节点角色'),
      parentNodeRef: identifier(input.parentNodeRef, '父节点引用', true),
      branchRootRef: identifier(input.branchRootRef || input.nodeId, '分支根引用'),
      supersedesRef: identifier(input.supersedesRef, '替代节点引用', true),
      quantity: Math.max(1, finiteNumber(input.quantity, '生成数量', 1, true)),
      estimatedCost,
      approvedBudget,
      retryBudget: finiteNumber(input.retryBudget, '重试预算', 0, true),
      attempt: Math.max(1, finiteNumber(input.attempt, '执行次数', 1, true)),
      currency: boundedText(input.currency || 'CNY', '币种', 12, true).toUpperCase(),
      authorizationId,
      inputRefs: Object.freeze(inputRefs),
      taskPayload: Object.freeze({ ...taskPayload }),
      nodeMeta: Object.freeze(isRecord(input.nodeMeta) ? { ...input.nodeMeta } : {})
    });
  }

  function normalizeNodeIdentity(input = {}) {
    if (!isRecord(input)) throw bridgeError('节点操作参数不合法', 'INVALID_INPUT');
    if (input.workspaceScope !== 'canvas-agent') throw bridgeError('原生节点只能属于 canvas-agent', 'INVALID_WORKSPACE_SCOPE');
    const kind = boundedText(input.kind, '媒体类型', 40, true);
    if (!['image', 'video', 'audio'].includes(kind)) throw bridgeError('当前节点媒体类型不受支持', 'INVALID_MEDIA_KIND');
    return Object.freeze({
      workspaceScope: 'canvas-agent',
      agentSessionId: identifier(input.agentSessionId, 'AgentSession ID'),
      toolRunId: identifier(input.toolRunId, 'Tool Run ID'),
      nodeId: identifier(input.nodeId, '节点 ID'),
      kind
    });
  }

  function hostInput(input, extra = {}) {
    const payloadReferences = input.kind === 'image' && Array.isArray(input.taskPayload?.assets)
      ? input.taskPayload.assets
      : Array.isArray(input.taskPayload?.images) ? input.taskPayload.images : [];
    const refs = payloadReferences.map(reference => ({
      url: String(reference?.url || ''),
      name: String(reference?.originalName || reference?.name || ''),
      nodeId: String(reference?.referenceId || ''),
      index: Math.max(0, Number(reference?.sourceImageIndex) || 0),
      imageIndex: Math.max(0, Number(reference?.sourceImageIndex) || 0),
      kind: 'image'
    }));
    return {
      workspaceScope: input.workspaceScope,
      agentSessionId: input.agentSessionId,
      toolRunId: input.toolRunId,
      nodeId: input.nodeId,
      sourceNodeId: input.sourceNodeId,
      kind: input.kind,
      nodeRole: input.nodeRole,
      parentNodeRef: input.parentNodeRef,
      branchRootRef: input.branchRootRef,
      supersedesRef: input.supersedesRef,
      expectedCount: input.quantity,
      refs,
      meta: {
        prompt: String(input.taskPayload?.prompt || ''),
        displayPrompt: String(input.nodeMeta?.displayPrompt || input.taskPayload?.prompt || ''),
        promptText: String(input.nodeMeta?.displayPrompt || input.taskPayload?.prompt || ''),
        promptHtml: '',
        promptRefs: refs.map(ref => ({ ...ref })),
        inputRefs: refs.map(ref => ({ ...ref })),
        sourceNodeId: input.sourceNodeId,
        settings: isRecord(input.nodeMeta?.settings) ? { ...input.nodeMeta.settings } : {},
        createdAt: Date.now()
      },
      ...extra
    };
  }

  function toolRunPayload(input, status, step, extra = {}) {
    return {
      requestId: requestId(input, step),
      type: `native-${input.kind}`,
      status,
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
      attempt: input.attempt,
      currency: input.currency,
      ...extra
    };
  }

  function agentTask(input, authorization) {
    const request = isRecord(authorization?.request) ? authorization.request : {};
    const inputVersionIds = Array.isArray(request.inputVersionIds) && request.inputVersionIds.includes(input.inputVersion)
      ? [...request.inputVersionIds]
      : [input.inputVersion];
    const roundIdentity = request.parentAuthorizationId ? {
      roundId: request.roundId,
      itemId: request.itemId,
      stageId: request.stageId,
      planRevision: request.planRevision,
      planHash: request.planHash,
      parentAuthorizationId: request.parentAuthorizationId
    } : {};
    return Object.freeze({
      workspaceScope: input.workspaceScope,
      agentSessionId: input.agentSessionId,
      toolRunId: input.toolRunId,
      nodeId: input.nodeId,
      operationId: input.operationId,
      ...roundIdentity,
      inputHash: input.inputHash,
      provider: input.providerId,
      model: input.model,
      taskKind: input.kind,
      authorizationId: input.authorizationId,
      inputVersionIds,
      quantity: input.quantity,
      estimatedCost: input.estimatedCost,
      approvedBudget: input.approvedBudget,
      retryBudget: input.retryBudget,
      currency: input.currency,
      inputRefs: input.inputRefs.map(ref => ({ ...ref })),
      allowFallback: false
    });
  }

  function requirePort(port, methods, label) {
    if (!isRecord(port)) throw bridgeError(`${label} 不可用`, 'BRIDGE_PORT_UNAVAILABLE');
    for (const method of methods) {
      if (typeof port[method] !== 'function') throw bridgeError(`${label}.${method} 不可用`, 'BRIDGE_PORT_UNAVAILABLE');
    }
    return port;
  }

  function normalizedReceipt(value, kind) {
    if (!isRecord(value)) throw bridgeError('任务提交未返回可恢复回执', 'INVALID_TASK_RECEIPT');
    const localTaskId = identifier(value.localTaskId || value.taskId, '本地任务 ID', true);
    const remoteTaskId = identifier(value.remoteTaskId, '远端任务 ID', true);
    if (kind === 'video' && !remoteTaskId) {
      throw bridgeError('视频任务只保存了本地流水号，缺少可查询的远端任务 ID', 'VIDEO_REMOTE_TASK_ID_MISSING', {
        localTaskId,
        reconcileRequired: true
      });
    }
    const resumeTaskId = identifier(kind === 'video' ? remoteTaskId : (value.resumeTaskId || localTaskId), '恢复任务 ID');
    return Object.freeze({
      localTaskId,
      remoteTaskId,
      resumeTaskId,
      status: boundedText(value.status || 'running', '任务状态', 40, true),
      idempotent: value.idempotent === true
    });
  }

  function optionalReceiptId(value, label) {
    try { return identifier(value, label, true); }
    catch (_error) { return ''; }
  }

  function terminalStatus(node) {
    const status = String(node?.taskState?.status || '').toLowerCase();
    if (['completed', 'succeeded'].includes(status)) return 'succeeded';
    if (status === 'failed') return 'failed';
    if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
    if (['waiting', 'remote-unknown', 'interrupted'].includes(status)) return 'remote-unknown';
    return 'running';
  }

  function assertRecoveryBinding(input, session, toolRun) {
    if (!session || session.id !== input.agentSessionId || session.workspaceScope !== 'canvas-agent') {
      throw bridgeError('AgentSession 恢复绑定不一致', 'RECOVERY_BINDING_CONFLICT');
    }
    if (!toolRun || toolRun.type !== `native-${input.kind}` || toolRun.nodeId !== input.nodeId || toolRun.provider !== input.providerId || toolRun.model !== input.model
      || toolRun.operationId !== input.operationId || toolRun.inputVersion !== input.inputVersion || toolRun.inputHash !== input.inputHash) {
      throw bridgeError('toolRun 恢复绑定不一致', 'RECOVERY_BINDING_CONFLICT');
    }
    const nodeRef = (session.currentNodeRefs || []).find(ref => ref.nodeId === input.nodeId && ref.toolRunId === input.toolRunId);
    if (!nodeRef || nodeRef.workspaceScope !== 'canvas-agent') throw bridgeError('当前节点引用不属于该 toolRun', 'RECOVERY_BINDING_CONFLICT');
  }

  function preparedBindingMatches(input, toolRun) {
    return toolRun.type === `native-${input.kind}`
      && toolRun.nodeId === input.nodeId
      && toolRun.provider === input.providerId
      && toolRun.model === input.model
      && toolRun.operationId === input.operationId
      && toolRun.inputVersion === input.inputVersion
      && toolRun.inputHash === input.inputHash
      && Number(toolRun.quantity) === input.quantity
      && Number(toolRun.estimatedCost) === input.estimatedCost
      && Number(toolRun.approvedBudget) === input.approvedBudget
      && Number(toolRun.retryBudget) === input.retryBudget
      && String(toolRun.currency || 'CNY') === input.currency
      && JSON.stringify(toolRun.executionPayload || {}) === JSON.stringify(input.taskPayload || {})
      && JSON.stringify(toolRun.inputRefs || []) === JSON.stringify(input.inputRefs || []);
  }

  function assertConsumedAuthorization(input, session, toolRun) {
    const authorization = (session?.executionAuthorizations || []).find(item => item?.authorizationId === input.authorizationId);
    if (!authorization) throw bridgeError('AgentSession 中没有这条付费授权', 'APPROVAL_REQUIRED');
    if (authorization.source !== 'execution-guard' || authorization.allowed !== true
      || !HASH_PATTERN.test(String(authorization.signature || ''))
      || !Number.isFinite(Number(authorization.consumedAt)) || Number(authorization.consumedAt) <= 0) {
      throw bridgeError('付费授权尚未被安全门消费', 'AUTHORIZATION_NOT_CONSUMED');
    }
    const request = authorization.request;
    const inputVersionIds = Array.isArray(request?.inputVersionIds) ? request.inputVersionIds : [];
    const roundFields = ['parentAuthorizationId', 'roundId', 'planRevision', 'planHash', 'planArtifactVersionId', 'itemId', 'stageId'];
    const roundFieldCount = roundFields.filter(field => request?.[field] !== undefined && request?.[field] !== null && String(request[field]).trim()).length;
    const isRoundChild = roundFieldCount > 0;
    const roundMatches = !isRoundChild || (roundFieldCount === roundFields.length
      && ID_PATTERN.test(String(request.parentAuthorizationId || ''))
      && ID_PATTERN.test(String(request.roundId || ''))
      && Number.isInteger(Number(request.planRevision)) && Number(request.planRevision) >= 1
      && HASH_PATTERN.test(String(request.planHash || '').toLowerCase())
      && ID_PATTERN.test(String(request.planArtifactVersionId || ''))
      && ID_PATTERN.test(String(request.itemId || ''))
      && ID_PATTERN.test(String(request.stageId || ''))
      && inputVersionIds.includes(request.planArtifactVersionId));
    const matches = isRecord(request)
      && request.operationId === input.operationId
      && request.provider === input.providerId
      && request.model === input.model
      && request.agentSessionId === input.agentSessionId
      && request.toolRunId === input.toolRunId
      && request.nodeId === input.nodeId
      && request.taskKind === input.kind
      && request.inputHash === input.inputHash
      && inputVersionIds.includes(input.inputVersion)
      && (isRoundChild || inputVersionIds.length === 1)
      && Number(request.quantity) === input.quantity
      && Number(request.estimatedCost) === input.estimatedCost
      && Number(request.budgetLimit) === input.approvedBudget
      && Number(request.retryLimit) === input.retryBudget
      && String(request.currency || 'CNY') === input.currency
      && request.allowFallback === false
      && roundMatches;
    const toolRunMatches = toolRun?.authorizationId === input.authorizationId
      && toolRun?.authorizationState === 'consumed';
    if (!matches || !toolRunMatches) throw bridgeError('已消费授权与 Session、toolRun、Provider、模型、输入、数量或预算不一致', 'AUTHORIZATION_BINDING_CONFLICT');
    return authorization;
  }

  function recoveryTaskId(input, node, toolRun) {
    if (node?.kind && node.kind !== input.kind) throw bridgeError('节点媒体类型与 toolRun 不一致', 'RECOVERY_BINDING_CONFLICT');
    if (node?.agentNative?.kind && node.agentNative.kind !== input.kind) throw bridgeError('节点 Agent 媒体类型与 toolRun 不一致', 'RECOVERY_BINDING_CONFLICT');
    const taskType = input.kind === 'video' ? 'video' : 'agent-native';
    const pending = Array.isArray(node?.pendingTasks) ? node.pendingTasks.filter(Boolean) : [];
    const matching = pending.filter(item => item.kind === input.kind && item.taskType === taskType);
    if (pending.length && (matching.length !== 1 || matching.length !== pending.length)) {
      throw bridgeError('节点恢复清单的媒体类型或任务数量不一致', 'RECOVERY_BINDING_CONFLICT');
    }
    const task = matching[0];
    if (!task) return '';
    if ((task.providerId && task.providerId !== input.providerId) || (task.model && task.model !== input.model)) {
      throw bridgeError('节点恢复清单的 Provider 或模型不一致', 'RECOVERY_BINDING_CONFLICT');
    }
    const taskId = identifier(task.taskId, '持久化任务 ID');
    const pendingRemoteTaskId = identifier(task.remoteTaskId, '节点远端任务 ID', true);
    const toolRemoteTaskId = identifier(toolRun.remoteTaskId, 'toolRun 远端任务 ID', true);
    if (pendingRemoteTaskId && toolRemoteTaskId && pendingRemoteTaskId !== toolRemoteTaskId) {
      throw bridgeError('节点与 toolRun 的远端任务 ID 不一致', 'RECOVERY_BINDING_CONFLICT');
    }
    if (input.kind === 'video' && (!toolRemoteTaskId || taskId !== toolRemoteTaskId)) {
      throw bridgeError('视频恢复必须绑定同一条持久化远端任务 ID', 'RECOVERY_BINDING_CONFLICT');
    }
    return taskId;
  }

  function assertPreparedBinding(input, session, toolRun) {
    if (!session || session.id !== input.agentSessionId || session.workspaceScope !== 'canvas-agent' || !toolRun) {
      throw bridgeError('尚未找到已预留的 toolRun', 'TOOL_RUN_NOT_PREPARED');
    }
    if (!preparedBindingMatches(input, toolRun)) throw bridgeError('已预留任务的 Provider、模型、输入、数量或预算发生变化', 'PREPARED_BINDING_CONFLICT');
    if (['submitting', 'running', 'remote-unknown'].includes(toolRun.status)) {
      throw bridgeError('任务已经提交，只能查询原任务', 'TOOL_RUN_ALREADY_SUBMITTED', { reconcileRequired: true });
    }
    if (['succeeded', 'failed', 'cancelled'].includes(toolRun.status)) {
      throw bridgeError('工具任务已经终结，不能再次提交', 'TOOL_RUN_TERMINAL');
    }
    if (toolRun.status !== 'queued') throw bridgeError('工具任务尚未进入可提交状态', 'TOOL_RUN_NOT_PREPARED');
  }

  function createAgentNativeNodeBridge(deps = {}) {
    const sessionPort = requirePort(deps.sessionPort, ['getSession', 'upsertToolRun', 'attachCurrentNode', 'detachCurrentNode'], 'AgentSession port');
    const host = requirePort(deps.host, ['createPlaceholder', 'attachTask', 'markRemoteUnknown', 'resumeTask', 'getNode'], 'AgentNativeNodeHost');
    const taskPort = requirePort(deps.taskPort, ['submit'], 'Agent task port');
    if (host.capabilities?.workspaceScope !== 'canvas-agent' || host.capabilities?.submitsProviderTasks !== false) {
      throw bridgeError('原生节点 Host 能力声明不安全', 'UNSAFE_HOST_CAPABILITIES');
    }
    const capabilities = Object.freeze({
      version: 1,
      workspaceScope: 'canvas-agent',
      persistentUiState: false,
      providerFallback: false,
      approvedExecutionOnly: true,
      recoverySubmits: false
    });

    async function prepare(rawInput) {
      const input = normalizeExecution(rawInput);
      const sessionPayload = await sessionPort.getSession(input.agentSessionId);
      const session = sessionPayload?.session || sessionPayload;
      if (!session || session.id !== input.agentSessionId || session.workspaceScope !== 'canvas-agent') {
        throw bridgeError('AgentSession 不可用于原生任务', 'TOOL_RUN_NOT_PREPARED');
      }
      const existing = (session.toolRuns || []).find(item => item.id === input.toolRunId);
      assertPreparedBinding(input, session, existing);
      assertConsumedAuthorization(input, session, existing);
      await host.createPlaceholder(hostInput(input, { preserveFailedBranch: true }));
      await sessionPort.attachCurrentNode(input.agentSessionId, input.nodeId, {
        requestId: requestId(input, 'attach-node'),
        workspaceScope: input.workspaceScope,
        kind: input.kind,
        nodeRole: input.nodeRole,
        toolRunId: input.toolRunId,
        parentNodeRef: input.parentNodeRef,
        branchRootRef: input.branchRootRef,
        supersedesRef: input.supersedesRef
      });
      return Object.freeze({
        status: 'queued',
        agentSessionId: input.agentSessionId,
        toolRunId: input.toolRunId,
        nodeId: input.nodeId,
        operationId: input.operationId
      });
    }

    async function submit(rawInput) {
      const input = normalizeExecution(rawInput, { requireSource: false });
      const sessionPayload = await sessionPort.getSession(input.agentSessionId);
      const session = sessionPayload?.session || sessionPayload;
      const toolRun = (session?.toolRuns || []).find(item => item.id === input.toolRunId);
      assertPreparedBinding(input, session, toolRun);
      const authorization = assertConsumedAuthorization(input, session, toolRun);
      await sessionPort.upsertToolRun(input.agentSessionId, input.toolRunId, toolRunPayload(input, 'submitting', 'tool-submitting'));
      let receipt = null;
      try {
        receipt = normalizedReceipt(await taskPort.submit({
          kind: input.kind,
          providerId: input.providerId,
          model: input.model,
          nodeId: input.nodeId,
          taskPayload: { ...input.taskPayload },
          agentTask: agentTask(input, authorization)
        }), input.kind);
        await host.attachTask(hostInput(input, {
          taskId: receipt.resumeTaskId,
          remoteTaskId: receipt.remoteTaskId,
          taskType: input.kind === 'video' ? 'video' : input.kind === 'audio' ? 'audio' : 'agent-native',
          providerId: input.providerId,
          model: input.model,
          status: receipt.status
        }));
        await sessionPort.upsertToolRun(input.agentSessionId, input.toolRunId, toolRunPayload(input, 'running', 'tool-running', {
          remoteTaskId: receipt.remoteTaskId
        }));
        return Object.freeze({
          status: 'running',
          agentSessionId: input.agentSessionId,
          toolRunId: input.toolRunId,
          nodeId: input.nodeId,
          taskId: receipt.resumeTaskId,
          localTaskId: receipt.localTaskId,
          remoteTaskId: receipt.remoteTaskId,
          idempotent: receipt.idempotent
        });
      } catch (cause) {
        const taskId = receipt?.resumeTaskId || optionalReceiptId(cause?.taskId, '恢复任务 ID');
        if (taskId) {
          try {
            await host.markRemoteUnknown(hostInput(input, {
              taskId,
              remoteTaskId: receipt?.remoteTaskId || optionalReceiptId(cause?.remoteTaskId, '远端任务 ID'),
              error: cause?.message || '任务提交结果未知'
            }));
          } catch (_hostError) {}
        }
        try {
          await sessionPort.upsertToolRun(input.agentSessionId, input.toolRunId, toolRunPayload(input, 'remote-unknown', 'tool-remote-unknown', {
            remoteTaskId: receipt?.remoteTaskId || '',
            error: boundedText(cause?.message || '任务提交结果未知', '任务错误', 500)
          }));
        } catch (_sessionError) {}
        const error = cause instanceof Error ? cause : bridgeError('任务提交结果未知', 'SUBMISSION_OUTCOME_UNKNOWN');
        error.reconcileRequired = true;
        if (cause?.localTaskId) error.localTaskId = cause.localTaskId;
        if (taskId) error.taskId = taskId;
        throw error;
      }
    }

    async function execute(rawInput) {
      await prepare(rawInput);
      return submit(rawInput);
    }

    async function executeStage(rawItems) {
      if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
        throw bridgeError('阶段执行项不合法', 'INVALID_STAGE_ITEMS');
      }
      const normalized = rawItems.map(item => normalizeExecution(item));
      for (const field of ['toolRunId', 'nodeId', 'operationId']) {
        if (new Set(normalized.map(item => item[field])).size !== normalized.length) {
          throw bridgeError('阶段执行身份不能重复', 'DUPLICATE_STAGE_EXECUTION_IDENTITY', { field });
        }
      }
      const modes = [];
      for (let index = 0; index < rawItems.length; index += 1) {
        try {
          await prepare(rawItems[index]);
          modes.push('submit');
        } catch (error) {
          if (['TOOL_RUN_ALREADY_SUBMITTED', 'TOOL_RUN_TERMINAL'].includes(error?.code)) modes.push('recover');
          else throw error;
        }
      }
      const results = await Promise.allSettled(rawItems.map((item, index) => modes[index] === 'recover' ? recover(item) : submit(item)));
      return Object.freeze({
        status: 'settled',
        results: Object.freeze(results.map(result => Object.freeze(result)))
      });
    }

    async function recover(rawInput) {
      const input = normalizeExecution(rawInput, { requireApproval: false, requireSource: false });
      const sessionPayload = await sessionPort.getSession(input.agentSessionId);
      const session = sessionPayload?.session || sessionPayload;
      const toolRun = (session?.toolRuns || []).find(item => item.id === input.toolRunId);
      assertRecoveryBinding(input, session, toolRun);
      const recoveryInput = Object.freeze({
        ...input,
        quantity: Math.max(1, Number(toolRun.quantity) || 1),
        estimatedCost: Math.max(0, Number(toolRun.estimatedCost) || 0),
        approvedBudget: Math.max(0, Number(toolRun.approvedBudget) || 0),
        retryBudget: Math.max(0, Number(toolRun.retryBudget) || 0),
        attempt: Math.max(1, Number(toolRun.attempt) || 1)
      });
      const beforePayload = await host.getNode(hostInput(input));
      const beforeNode = beforePayload?.node || beforePayload;
      const persistedTaskId = recoveryTaskId(input, beforeNode, toolRun);
      const existingStatus = terminalStatus(beforeNode);
      if (['succeeded', 'failed', 'cancelled'].includes(existingStatus)) {
        if (toolRun.status !== existingStatus) {
          await sessionPort.upsertToolRun(input.agentSessionId, input.toolRunId, toolRunPayload(recoveryInput, existingStatus, `recover-${existingStatus}`, {
            remoteTaskId: toolRun.remoteTaskId || '',
            error: existingStatus === 'failed' ? boundedText(beforeNode?.taskState?.message || '任务失败', '任务错误', 500) : ''
          }));
        }
        return Object.freeze({ status: existingStatus, agentSessionId: input.agentSessionId, toolRunId: input.toolRunId, nodeId: input.nodeId, taskId: '' });
      }
      const taskId = persistedTaskId;
      if (!taskId) {
        return Object.freeze({
          status: 'blocked',
          reconcileRequired: true,
          agentSessionId: input.agentSessionId,
          toolRunId: input.toolRunId,
          nodeId: input.nodeId,
          taskId: ''
        });
      }
      try {
        await host.resumeTask(hostInput(input, { taskId, remoteTaskId: toolRun.remoteTaskId || '' }));
      } catch (cause) {
        try {
          await sessionPort.upsertToolRun(input.agentSessionId, input.toolRunId, toolRunPayload(recoveryInput, 'remote-unknown', 'recover-remote-unknown', {
            remoteTaskId: toolRun.remoteTaskId || '',
            error: boundedText(cause?.message || '恢复查询结果未知', '任务错误', 500)
          }));
        } catch (_sessionError) {}
        const error = cause instanceof Error ? cause : bridgeError('恢复查询结果未知', 'RECOVERY_OUTCOME_UNKNOWN');
        error.reconcileRequired = true;
        error.taskId = taskId;
        throw error;
      }
      const afterPayload = await host.getNode(hostInput(input));
      const node = afterPayload?.node || afterPayload;
      const status = terminalStatus(node);
      await sessionPort.upsertToolRun(input.agentSessionId, input.toolRunId, toolRunPayload(recoveryInput, status, `recover-${status}`, {
        remoteTaskId: toolRun.remoteTaskId || '',
        error: status === 'failed' ? boundedText(node?.taskState?.message || '任务失败', '任务错误', 500) : ''
      }));
      return Object.freeze({
        status,
        reconcileRequired: status === 'remote-unknown',
        agentSessionId: input.agentSessionId,
        toolRunId: input.toolRunId,
        nodeId: input.nodeId,
        taskId
      });
    }

    async function detachCurrentNode(rawInput) {
      const input = normalizeNodeIdentity(rawInput);
      let sessionPayload;
      try {
        sessionPayload = await sessionPort.getSession(input.agentSessionId);
      } catch (error) {
        if (isMissingAgentSession(error)) return orphanedSessionDetach(input);
        throw error;
      }
      const session = sessionPayload?.session || sessionPayload;
      if (!session || session.id !== input.agentSessionId || session.workspaceScope !== 'canvas-agent') {
        throw bridgeError('AgentSession 节点归属不一致', 'AGENT_NODE_OWNERSHIP_CONFLICT');
      }
      const current = (session.currentNodeRefs || []).find(item => item.nodeId === input.nodeId);
      const detached = (session.detachedNodeRefs || []).find(item => item.nodeId === input.nodeId);
      const matches = item => item
        && item.workspaceScope === 'canvas-agent'
        && item.toolRunId === input.toolRunId
        && (!item.kind || item.kind === input.kind);
      if (!current) {
        if (matches(detached)) return Object.freeze({ status: 'detached', idempotent: true, ...input });
        throw bridgeError('节点不在当前 Agent 工作集中', 'AGENT_NODE_NOT_CURRENT');
      }
      if (!matches(current)) throw bridgeError('节点不属于指定 AgentSession/toolRun', 'AGENT_NODE_OWNERSHIP_CONFLICT');
      const toolRun = (session.toolRuns || []).find(item => item.id === input.toolRunId);
      if (!toolRun || toolRun.nodeId !== input.nodeId || toolRun.type !== `native-${input.kind}`) {
        throw bridgeError('节点与 ToolRun 绑定不一致', 'AGENT_NODE_OWNERSHIP_CONFLICT');
      }
      if (!['succeeded', 'failed', 'cancelled'].includes(toolRun.status)) {
        throw bridgeError('任务仍在执行或等待核对，暂不能删除节点', 'AGENT_NODE_DETACH_BLOCKED', { reconcileRequired: toolRun.status === 'remote-unknown' });
      }
      const nodePayload = await host.getNode(input);
      const node = nodePayload?.node || nodePayload;
      if (terminalStatus(node) !== toolRun.status) {
        throw bridgeError('节点状态尚未与 AgentSession 收敛，暂不能删除', 'AGENT_NODE_DETACH_BLOCKED');
      }
      let result;
      try {
        result = await sessionPort.detachCurrentNode(input.agentSessionId, input.nodeId, {
          requestId: requestId({ operationId: `${input.toolRunId}.${input.nodeId}` }, 'detach-node')
        });
      } catch (error) {
        if (isMissingAgentSession(error)) return orphanedSessionDetach(input);
        throw error;
      }
      return Object.freeze({ status: 'detached', idempotent: Boolean(result?.idempotent), ...input });
    }

    return Object.freeze({ capabilities, execute, executeStage, recover, detachCurrentNode });
  }

  async function responseJson(response) {
    if (!response || typeof response.json !== 'function') return response;
    const payload = await response.json().catch(() => ({}));
    if (response.ok === false || payload?.success === false) {
      throw bridgeError(payload?.error || payload?.detail || payload?.message || `请求失败：${response.status || 500}`, payload?.code || 'BRIDGE_REQUEST_FAILED', {
        status: Number(response.status || 500),
        payload
      });
    }
    return payload;
  }

  function createAgentSessionPort(adapter) {
    requirePort(adapter, ['fetch'], 'LavansCanvasAdapter');
    const request = async (path, method = 'GET', body) => responseJson(await adapter.fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    return Object.freeze({
      getSession(agentSessionId) {
        return request(`/agent-sessions/${encodeURIComponent(agentSessionId)}`);
      },
      upsertToolRun(agentSessionId, toolRunId, payload) {
        return request(`/agent-sessions/${encodeURIComponent(agentSessionId)}/tool-runs/${encodeURIComponent(toolRunId)}`, 'PUT', payload);
      },
      attachCurrentNode(agentSessionId, nodeId, payload) {
        return request(`/agent-sessions/${encodeURIComponent(agentSessionId)}/current-nodes/${encodeURIComponent(nodeId)}`, 'PUT', payload);
      },
      detachCurrentNode(agentSessionId, nodeId, payload) {
        return request(`/agent-sessions/${encodeURIComponent(agentSessionId)}/current-nodes/${encodeURIComponent(nodeId)}`, 'DELETE', payload);
      }
    });
  }

  function createAgentNativeTaskPort(adapter, sameOriginFetch) {
    requirePort(adapter, ['createTask'], 'LavansCanvasAdapter');
    if (typeof sameOriginFetch !== 'function') throw bridgeError('同源视频 transport 不可用', 'BRIDGE_PORT_UNAVAILABLE');
    return Object.freeze({
      async submit(input) {
        if (input.kind === 'image') {
          const payload = await adapter.createTask({
            ...input.taskPayload,
            type: 'generator',
            providerId: input.providerId,
            model: input.model,
            nodeId: input.nodeId,
            agentTask: input.agentTask
          });
          const task = payload?.task || payload;
          return {
            localTaskId: task?.id || '',
            remoteTaskId: task?.upstreamTaskId || task?.agentBinding?.remoteTaskId || '',
            resumeTaskId: task?.id || '',
            status: task?.status || 'running',
            idempotent: payload?.idempotent === true
          };
        }
        const endpoint = input.kind === 'audio' ? '/api/canvas-audio-tasks' : '/api/canvas-video';
        const response = await sameOriginFetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...input.taskPayload,
            provider_id: input.providerId,
            model: input.model,
            agentTask: input.agentTask
          })
        });
        let payload;
        try {
          payload = await responseJson(response);
        } catch (error) {
          const localTaskId = String(error?.payload?.local_task_id || '');
          if (localTaskId) {
            error.localTaskId = localTaskId;
            error.taskId = localTaskId;
          }
          throw error;
        }
        return {
          localTaskId: payload?.local_task_id || payload?.agent_binding?.taskId || '',
          remoteTaskId: payload?.task_id || payload?.agent_binding?.remoteTaskId || '',
          resumeTaskId: input.kind === 'audio'
            ? (payload?.local_task_id || payload?.task_id || payload?.agent_binding?.taskId || '')
            : (payload?.task_id || payload?.agent_binding?.remoteTaskId || ''),
          status: payload?.status || 'running',
          idempotent: payload?.idempotent === true
        };
      }
    });
  }

  return Object.freeze({
    createAgentNativeNodeBridge,
    createAgentSessionPort,
    createAgentNativeTaskPort
  });
});
