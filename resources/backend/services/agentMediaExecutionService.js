'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { hashAgentNativeExecutionPayload, normalizeAgentNativeExecutionPayload } = require('./agentNativeTaskBinding');
const {
  assertGenerationPlanIdentity,
  normalizeGenerationPlan,
  selectReadyItems,
  summarizeGenerationCost
} = require('./agentGenerationRoundService');

const IMAGE_PRICES = Object.freeze({ '1k': 0.0085, '2k': 0.014, '4k': 0.021 });
const VIDEO_PRICES = Object.freeze({ '480p': 0.083, '720p': 0.179, '1080p': 0.404 });
const AUDIO_TTS_PRICE_CEILING = 0.015;
const AUDIO_TTS_MAX_CHARS = 60;
const IMAGE_RATIOS = Object.freeze({ '16:9': [16, 9], '4:3': [4, 3], '1:1': [1, 1], '3:4': [3, 4], '9:16': [9, 16] });
const VIDEO_RATIOS = new Set(['16:9', '9:16']);
const IMAGE_MODELS = new Set(['gpt-image-2']);
const VIDEO_MODELS = new Set(['seedance-2.0']);
const AUDIO_MODELS = new Set(['gpt-4o-mini-tts']);
const AUDIO_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
const AUDIO_FORMATS = new Set(['wav']);
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const IMAGE_REFERENCE_LIMIT = 10;
const VIDEO_REFERENCE_LIMIT = 9;

function mediaError(message, statusCode = 400, code = 'AGENT_MEDIA_EXECUTION_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function identifier(value, label) {
  const normalized = String(value || '').trim();
  if (!ID_RE.test(normalized)) throw mediaError(`${label} 不合法`, 400, 'INVALID_ID');
  return normalized;
}

function text(value, limit, label, required = false) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) throw mediaError(`${label} 不能为空`, 400, 'INVALID_INPUT');
  if (normalized.length > limit) throw mediaError(`${label} 超出长度限制`, 400, 'INVALID_INPUT');
  return normalized;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileDigest(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { contentHash: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}

function imageSize(ratio, resolution) {
  const pair = IMAGE_RATIOS[ratio];
  if (!pair) throw mediaError('图片比例不受支持', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
  const edge = ({ '1k': 1024, '2k': 2048, '4k': 4096 })[resolution];
  if (!edge) throw mediaError('图片规格不受支持', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
  const longest = Math.max(...pair);
  return `${Math.round(edge * pair[0] / longest)}x${Math.round(edge * pair[1] / longest)}`;
}

const IMAGE_SIZE_SPECS = new Map();
for (const ratio of Object.keys(IMAGE_RATIOS)) {
  for (const resolution of Object.keys(IMAGE_PRICES)) IMAGE_SIZE_SPECS.set(imageSize(ratio, resolution), { ratio, resolution });
}

function exactMoney(value) {
  return Number(Number(value).toFixed(6));
}

function verifyLockedImageReferences(references, inputRefs, maximum, label) {
  if (!Array.isArray(references) || references.length > maximum) {
    throw mediaError(`${label}超出已验证的数量边界`, 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
  }
  const lockedRefIds = new Set((Array.isArray(inputRefs) ? inputRefs : [])
    .filter(ref => ref?.workspaceScope === 'canvas-agent')
    .map(ref => String(ref?.refId || '').trim()));
  const seenReferenceIds = new Set();
  references.forEach((reference, index) => {
    const referenceId = String(reference?.referenceId || '').trim();
    const sourceItemId = String(reference?.sourceItemId || '').trim();
    const sourceImageIndex = Number(reference?.sourceImageIndex);
    const referenceUrl = String(reference?.url || '').trim();
    const contentHash = String(reference?.contentHash || '').trim().toLowerCase();
    const byteLength = Number(reference?.byteLength);
    const role = String(reference?.role || '').trim();
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || !ID_RE.test(referenceId) || seenReferenceIds.has(referenceId)
      || Number(reference.referenceIndex) !== index + 1
      || (sourceItemId && !ID_RE.test(sourceItemId)) || !ID_RE.test(role)
      || !Number.isInteger(sourceImageIndex) || sourceImageIndex < 0
      || !/^[a-f0-9]{64}$/.test(contentHash) || !Number.isInteger(byteLength) || byteLength < 1
      || !/^\/canvas-output\/[A-Za-z0-9._%()-]+$/.test(referenceUrl)
      || !lockedRefIds.has(referenceId)) {
      throw mediaError(`${label}不在已锁定的画布 AGENT 输入中`, 409, 'AGENT_MEDIA_REFERENCE_INVALID');
    }
    seenReferenceIds.add(referenceId);
  });
}

function verifyAgentMediaQuote({ binding, executionPayload, inputHash } = {}) {
  if (!binding || typeof binding !== 'object' || !executionPayload || typeof executionPayload !== 'object') {
    throw mediaError('媒体报价绑定不完整', 400, 'AGENT_MEDIA_QUOTE_INVALID');
  }
  const taskKind = String(binding.taskKind || '').trim();
  if (!['image', 'video', 'audio'].includes(taskKind)) throw mediaError('媒体任务类型不受支持', 409, 'AGENT_MEDIA_KIND_UNAVAILABLE');
  const provider = text(binding.provider, 160, 'Provider', true);
  const model = text(binding.model, 240, '模型', true);
  const refs = Array.isArray(binding.inputRefs) ? binding.inputRefs : [];
  const recalculatedHash = hashAgentNativeExecutionPayload(taskKind, executionPayload, refs);
  const claimedHash = String(inputHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(claimedHash) || claimedHash !== String(binding.inputHash || '').toLowerCase() || claimedHash !== recalculatedHash) {
    throw mediaError('媒体执行载荷与 inputHash 不一致', 409, 'AGENT_MEDIA_INPUT_HASH_CONFLICT');
  }
  if (Number(binding.quantity) !== 1 || Number(binding.retryBudget) !== 0 || binding.allowFallback !== false) {
    throw mediaError('媒体任务只允许数量 1、零重试且禁止 fallback', 409, 'AGENT_MEDIA_EXECUTION_POLICY_CONFLICT');
  }
  if (String(binding.currency || '').toUpperCase() !== 'USD') {
    throw mediaError('媒体价目只接受 USD', 409, 'AGENT_MEDIA_CURRENCY_CONFLICT');
  }

  let estimatedCost;
  let resolution;
  let aspectRatio;
  if (taskKind === 'image') {
    if (!IMAGE_MODELS.has(model) || executionPayload.type !== 'generator' || !Array.isArray(executionPayload.assets)) {
      throw mediaError('图片模型或载荷不在价目白名单', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    }
    verifyLockedImageReferences(executionPayload.assets, refs, IMAGE_REFERENCE_LIMIT, '图片参考素材');
    const spec = IMAGE_SIZE_SPECS.get(String(executionPayload.size || '').toLowerCase());
    if (!spec) throw mediaError('图片规格不在价目白名单', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    resolution = spec.resolution;
    aspectRatio = spec.ratio;
    estimatedCost = IMAGE_PRICES[spec.resolution];
  } else if (taskKind === 'video') {
    resolution = String(executionPayload.resolution || '').toLowerCase();
    const duration = Number(executionPayload.duration);
    aspectRatio = String(executionPayload.aspect_ratio || '').trim();
    const images = Array.isArray(executionPayload.images) ? executionPayload.images : null;
    if (!VIDEO_MODELS.has(model) || !Object.hasOwn(VIDEO_PRICES, resolution) || !VIDEO_RATIOS.has(aspectRatio)
      || !Number.isInteger(duration) || duration < 5 || duration > 15
      || !images) {
      throw mediaError('视频模型、规格或时长不在价目白名单', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    }
    verifyLockedImageReferences(images, refs, VIDEO_REFERENCE_LIMIT, '视频参考图');
    estimatedCost = exactMoney(VIDEO_PRICES[resolution] * duration);
  } else {
    const input = String(executionPayload.input || '').trim();
    const voice = String(executionPayload.voice || '').trim().toLowerCase();
    const format = String(executionPayload.response_format || '').trim().toLowerCase();
    const speed = Number(executionPayload.speed);
    if (!AUDIO_MODELS.has(model) || !input || input.length > AUDIO_TTS_MAX_CHARS
      || !AUDIO_VOICES.has(voice) || !AUDIO_FORMATS.has(format)
      || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      throw mediaError('音频模型、文本、音色、格式或语速不在首版白名单', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    }
    resolution = format;
    aspectRatio = voice;
    estimatedCost = AUDIO_TTS_PRICE_CEILING;
  }
  if (Number(binding.estimatedCost) !== estimatedCost || Number(binding.approvedBudget) !== estimatedCost) {
    throw mediaError('媒体任务费用与服务端价目不一致', 409, 'AGENT_MEDIA_QUOTE_CONFLICT');
  }
  return Object.freeze({
    verified: true,
    source: 'server-price-catalog',
    provider,
    model,
    taskKind,
    inputHash: recalculatedHash,
    quantity: 1,
    resolution,
    aspectRatio,
    estimatedCost,
    currency: 'USD'
  });
}

function createAgentMediaExecutionService(options = {}) {
  const sessionService = options.agentSessionService;
  const getCanvasConfig = options.getCanvasConfig;
  const getCanvasRecord = options.getCanvasRecord;
  const resolveCanvasAssetPath = options.resolveCanvasAssetPath;
  const foundation = options.foundation || null;
  if (!sessionService || typeof sessionService.loadSession !== 'function' || typeof sessionService.upsertToolRun !== 'function') {
    throw mediaError('AgentSession 服务不可用', 500, 'AGENT_SESSION_SERVICE_UNAVAILABLE');
  }
  if (typeof getCanvasConfig !== 'function') throw mediaError('画布模型配置不可用', 500, 'CANVAS_CONFIG_UNAVAILABLE');

  function trustedSourceImage(session, sourceNodeIdValue, sourceImageIndexValue = 0, metadata = {}) {
    const sourceNodeId = identifier(sourceNodeIdValue, '参考图片节点 ID');
    const sourceImageIndex = Number(sourceImageIndexValue);
    const referenceIndex = Number(metadata.referenceIndex ?? 1);
    const role = identifier(metadata.role || 'first_frame', '参考图片角色');
    const sourceItemId = metadata.sourceItemId ? identifier(metadata.sourceItemId, '参考图片生成项 ID') : '';
    if (!Number.isInteger(sourceImageIndex) || sourceImageIndex < 0) {
      throw mediaError('参考图片序号不合法', 400, 'AGENT_MEDIA_REFERENCE_INVALID');
    }
    if (!Number.isInteger(referenceIndex) || referenceIndex < 1) {
      throw mediaError('参考图片编号不合法', 400, 'AGENT_MEDIA_REFERENCE_INVALID');
    }
    if (typeof getCanvasRecord !== 'function') {
      throw mediaError('画布参考图校验端口不可用', 503, 'AGENT_MEDIA_REFERENCE_UNAVAILABLE');
    }
    if (typeof resolveCanvasAssetPath !== 'function') {
      throw mediaError('画布参考图文件校验端口不可用', 503, 'AGENT_MEDIA_REFERENCE_UNAVAILABLE');
    }
    const nodeRef = (session.currentNodeRefs || []).find(item => item?.nodeId === sourceNodeId
      && item?.workspaceScope === 'canvas-agent' && item?.kind === 'image');
    const sourceToolRun = nodeRef && (session.toolRuns || []).find(item => item?.id === nodeRef.toolRunId
      && item?.nodeId === sourceNodeId && item?.type === 'native-image' && item?.status === 'succeeded');
    const canvas = getCanvasRecord(session.canvasId);
    const node = canvas && Array.isArray(canvas.nodes) ? canvas.nodes.find(item => item?.id === sourceNodeId) : null;
    const image = Array.isArray(node?.images) ? node.images[sourceImageIndex] : null;
    const url = String(image?.url || '').trim();
    const resolvedAssetPath = /^\/canvas-output\/[A-Za-z0-9._%()-]+$/.test(url)
      ? resolveCanvasAssetPath(url)
      : null;
    if (!nodeRef || !sourceToolRun || !node
      || node?.agentNative?.workspaceScope !== 'canvas-agent'
      || node?.agentNative?.agentSessionId !== session.id
      || node?.agentNative?.toolRunId !== sourceToolRun.id
      || node?.agentNative?.kind !== 'image'
      || node?.taskState?.status !== 'completed'
      || String(image?.kind || 'image') !== 'image'
      || !resolvedAssetPath || !fs.existsSync(resolvedAssetPath) || !fs.statSync(resolvedAssetPath).isFile()) {
      throw mediaError('参考图片必须是当前 AgentSession 已完成的原生图片节点', 409, 'AGENT_MEDIA_REFERENCE_INVALID');
    }
    const integrity = fileDigest(resolvedAssetPath);
    return Object.freeze({
      referenceId: sourceNodeId,
      ...(sourceItemId ? { sourceItemId } : {}),
      referenceIndex,
      sourceImageIndex,
      role,
      url,
      originalName: text(image.name || `图${sourceImageIndex + 1}`, 160, '参考图片名称'),
      contentHash: integrity.contentHash,
      byteLength: integrity.byteLength
    });
  }

  function storedReferences(kind, payload) {
    if (kind === 'image') return Array.isArray(payload?.assets) ? payload.assets : [];
    if (kind === 'video') return Array.isArray(payload?.images) ? payload.images : [];
    return [];
  }

  function revalidateStoredReferences(session, kind, payload, message) {
    return storedReferences(kind, payload).map(reference => {
      let trusted;
      try {
        trusted = trustedSourceImage(session, reference?.referenceId, reference?.sourceImageIndex, {
          referenceIndex: reference?.referenceIndex,
          role: reference?.role,
          sourceItemId: reference?.sourceItemId
        });
      } catch (_error) {
        throw mediaError(message, 409, 'AGENT_MEDIA_REFERENCE_CONFLICT');
      }
      if (digest(trusted) !== digest(reference)) {
        throw mediaError(message, 409, 'AGENT_MEDIA_REFERENCE_CONFLICT');
      }
      return trusted;
    });
  }

  function dependencyRolePriority(roleValue) {
    const role = String(roleValue || '').trim();
    if (role === 'first_frame') return 0;
    if (role === 'last_frame') return 1;
    return 2;
  }

  function orderedDependencies(item) {
    return [...(Array.isArray(item?.dependsOn) ? item.dependsOn : [])].sort((left, right) => (
      dependencyRolePriority(left?.role) - dependencyRolePriority(right?.role)
      || String(left?.itemId || '').localeCompare(String(right?.itemId || ''))
      || String(left?.role || '').localeCompare(String(right?.role || ''))
    ));
  }

  function trustedDependencyImages(session, round, item, maximum) {
    const itemById = new Map((round.items || []).map(candidate => [candidate.itemId, candidate]));
    const queue = orderedDependencies(item).map(dependency => ({ ...dependency }));
    const expandedItemIds = new Set();
    const imageItemIds = new Set();
    const sources = [];
    while (queue.length) {
      const dependency = queue.shift();
      const sourceItem = itemById.get(dependency.itemId);
      if (!sourceItem) throw mediaError('媒体依赖在锁定后丢失', 409, 'GENERATION_PLAN_DRIFT');
      if (sourceItem.kind === 'image' && !imageItemIds.has(sourceItem.itemId)) {
        if (sourceItem.status !== 'succeeded' || !sourceItem.nodeId) {
          throw mediaError('图片依赖尚未成功，不能进入媒体任务', 409, 'AGENT_MEDIA_REFERENCE_INVALID');
        }
        imageItemIds.add(sourceItem.itemId);
        sources.push({ sourceItem, role: dependency.role || 'reference' });
        if (sources.length > maximum) {
          throw mediaError(`当前媒体项的图片依赖超过 ${maximum} 张`, 409, 'AGENT_MEDIA_REFERENCE_LIMIT');
        }
      }
      if (expandedItemIds.has(sourceItem.itemId)) continue;
      expandedItemIds.add(sourceItem.itemId);
      queue.push(...orderedDependencies(sourceItem).map(child => ({ ...child })));
    }
    return sources.map(({ sourceItem, role }, index) => trustedSourceImage(session, sourceItem.nodeId, 0, {
      sourceItemId: sourceItem.itemId,
      referenceIndex: index + 1,
      role
    }));
  }

  function terminalNodeStatus(node) {
    const status = String(node?.taskState?.status || node?.canvasTask?.status || '').trim().toLowerCase();
    if (['completed', 'succeeded'].includes(status)) return 'succeeded';
    if (status === 'failed') return 'failed';
    if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
    return '';
  }

  function trustedRedoSource(session, sourceNodeIdValue, expectedKindValue = '') {
    const sourceNodeId = identifier(sourceNodeIdValue, '重做源节点 ID');
    const expectedKind = String(expectedKindValue || '').trim().toLowerCase();
    if (typeof getCanvasRecord !== 'function') {
      throw mediaError('画布重做源节点校验端口不可用', 503, 'AGENT_MEDIA_BRANCH_SOURCE_UNAVAILABLE');
    }
    const nodeRef = (session.currentNodeRefs || []).find(item => item?.nodeId === sourceNodeId
      && item?.workspaceScope === 'canvas-agent' && ['image', 'video'].includes(item?.kind));
    const kind = String(nodeRef?.kind || '').trim();
    const toolRun = nodeRef && (session.toolRuns || []).find(item => item?.id === nodeRef.toolRunId
      && item?.nodeId === sourceNodeId && item?.type === `native-${kind}`);
    const canvas = getCanvasRecord(session.canvasId);
    const node = canvas && Array.isArray(canvas.nodes) ? canvas.nodes.find(item => item?.id === sourceNodeId) : null;
    const terminalStatus = terminalNodeStatus(node);
    if (!nodeRef || !toolRun || !node || (expectedKind && kind !== expectedKind)
      || !['succeeded', 'failed', 'cancelled'].includes(toolRun.status) || terminalStatus !== toolRun.status
      || node?.agentNative?.workspaceScope !== 'canvas-agent'
      || node?.agentNative?.agentSessionId !== session.id
      || node?.agentNative?.toolRunId !== toolRun.id
      || node?.agentNative?.kind !== kind) {
      throw mediaError('重做源节点必须是当前 AgentSession 的终态原生图片或视频节点', 409, 'AGENT_MEDIA_BRANCH_SOURCE_INVALID');
    }
    const branchRootRef = identifier(nodeRef.branchRootRef || sourceNodeId, '分支根节点 ID');
    const trustedReferences = revalidateStoredReferences(
      session,
      kind,
      toolRun.executionPayload,
      `${kind === 'video' ? '视频' : '图片'}重做源节点的参考图在锁定后发生变化`
    );
    return Object.freeze({
      sourceNodeId,
      kind,
      nodeRef,
      toolRun,
      node,
      branchRootRef,
      trustedReferences: Object.freeze(trustedReferences)
    });
  }

  function trustedBranchSource(session, item) {
    if (!item?.parentNodeRef) return null;
    const source = trustedRedoSource(session, item.parentNodeRef, item.kind);
    if (item.supersedesRef !== source.sourceNodeId || item.branchRootRef !== source.branchRootRef) {
      throw mediaError('重做分支血缘与当前源节点不一致', 409, 'AGENT_MEDIA_BRANCH_SOURCE_CONFLICT');
    }
    return source;
  }

  function executionFrom(session, toolRun) {
    if (!toolRun) throw mediaError('媒体 ToolRun 不存在', 404, 'AGENT_MEDIA_TOOL_RUN_NOT_FOUND');
    const kind = String(toolRun.type || '').replace(/^native-/, '');
    if (!['image', 'video', 'audio'].includes(kind)) throw mediaError('ToolRun 不是原生媒体任务', 409, 'AGENT_MEDIA_KIND_UNAVAILABLE');
    const trustedReferences = revalidateStoredReferences(session, kind, toolRun.executionPayload, '媒体参考图在锁定后发生变化');
    const trustedReference = kind === 'video' ? trustedReferences[0] || null : null;
    const sourceNodeRef = trustedReference
      ? (session.currentNodeRefs || []).find(item => item?.nodeId === trustedReference.referenceId)
      : null;
    const generationItem = (session.generationRounds || []).flatMap(round => round.items || [])
      .find(item => item?.toolRunId === toolRun.id && item?.nodeId === toolRun.nodeId);
    const branchIdentity = generationItem?.parentNodeRef ? generationItem : null;
    const execution = {
      kind,
      taskKind: kind,
      workspaceScope: 'canvas-agent',
      providerId: toolRun.provider,
      provider: toolRun.provider,
      model: toolRun.model,
      agentSessionId: session.id,
      toolRunId: toolRun.id,
      nodeId: toolRun.nodeId,
      sourceNodeId: trustedReference?.referenceId || '',
      parentNodeRef: branchIdentity?.parentNodeRef || trustedReference?.referenceId || '',
      branchRootRef: branchIdentity?.branchRootRef
        || (trustedReference ? (sourceNodeRef?.branchRootRef || trustedReference.referenceId) : toolRun.nodeId),
      supersedesRef: branchIdentity?.supersedesRef || '',
      operationId: toolRun.operationId,
      inputVersion: toolRun.inputVersion,
      inputVersionIds: [toolRun.inputVersion],
      inputHash: toolRun.inputHash,
      quantity: toolRun.quantity,
      estimatedCost: toolRun.estimatedCost,
      approvedBudget: toolRun.approvedBudget,
      retryBudget: toolRun.retryBudget,
      currency: toolRun.currency,
      inputRefs: toolRun.inputRefs,
      allowFallback: false,
      taskPayload: toolRun.executionPayload
    };
    const quote = verifyAgentMediaQuote({ binding: execution, executionPayload: execution.taskPayload, inputHash: execution.inputHash });
    const action = Object.freeze({
      ...execution,
      status: toolRun.status,
      quote,
      requiresConfirmation: session.constraints?.mediaDefaults?.autoGenerateMedia !== true
    });
    return { session, toolRun, execution: action, quote, ...action };
  }

  function configuredMediaBinding(kind, providerIdValue, modelValue, ratioValue, resolutionValue, durationValue = null) {
    const providerId = text(providerIdValue, 160, `${kind} Provider`, true);
    const model = text(modelValue, 240, `${kind} 模型`, true);
    const ratio = text(ratioValue, 20, `${kind} 比例`, true);
    const resolution = text(resolutionValue, 20, `${kind} 规格`, true).toLowerCase();
    const duration = kind === 'video' ? Number(durationValue ?? 5) : kind === 'audio' ? Number(durationValue ?? 1) : null;
    const config = getCanvasConfig() || {};
    const provider = (Array.isArray(config.providers) ? config.providers : []).find(item => item?.id === providerId);
    if (!provider || provider.enabled === false) throw mediaError('媒体 Provider 不存在或已禁用', 409, 'AGENT_MEDIA_PROVIDER_UNAVAILABLE');
    if (String(provider.protocol || '').toLowerCase() !== 'apimart') throw mediaError('当前媒体执行只接入 APIMart', 409, 'AGENT_MEDIA_PROTOCOL_UNAVAILABLE');
    if (!String(provider.api_key || '').trim() || !String(provider.base_url || '').trim()) {
      throw mediaError('媒体 Provider 缺少 API Key 或 Base URL', 409, 'AGENT_MEDIA_PROVIDER_INCOMPLETE');
    }
    const configuredModels = kind === 'image' ? provider.image_models : kind === 'video' ? provider.video_models : provider.audio_models;
    const allowedModels = kind === 'image' ? IMAGE_MODELS : kind === 'video' ? VIDEO_MODELS : AUDIO_MODELS;
    if (!Array.isArray(configuredModels) || !configuredModels.includes(model)
      || !allowedModels.has(model)) {
      throw mediaError('媒体模型未在 Provider 与价目白名单中启用', 409, 'AGENT_MEDIA_MODEL_UNAVAILABLE');
    }
    if (kind === 'image') imageSize(ratio, resolution);
    else if (kind === 'video' && (!VIDEO_RATIOS.has(ratio) || !Object.hasOwn(VIDEO_PRICES, resolution)
      || !Number.isInteger(duration) || duration < 5 || duration > 15)) {
      throw mediaError('视频比例、清晰度或时长不受支持', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    } else if (kind === 'audio' && (!AUDIO_VOICES.has(ratio) || !AUDIO_FORMATS.has(resolution)
      || !Number.isFinite(duration) || duration < 0.25 || duration > 4)) {
      throw mediaError('音频音色、格式或语速不受支持', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    }
    return Object.freeze({ providerId, model, ratio, resolution, duration });
  }

  function pureRoundPlan(round) {
    return {
      planRevision: round.planRevision,
      stages: (round.stages || []).map(stage => ({ stageId: stage.stageId, label: stage.label || '' })),
      items: (round.items || []).map(item => ({
        itemId: item.itemId,
        stageId: item.stageId,
        kind: item.kind,
        prompt: item.prompt,
        promptVersion: item.promptVersion || '',
        provider: item.provider,
        model: item.model,
        spec: item.spec,
        quantity: 1,
        dependsOn: item.dependsOn || [],
        ...(item.parentNodeRef ? {
          parentNodeRef: item.parentNodeRef,
          branchRootRef: item.branchRootRef,
          supersedesRef: item.supersedesRef
        } : {})
      }))
    };
  }

  function quoteRoundItem(item) {
    if (!['image', 'video', 'audio'].includes(item.kind)) {
      throw mediaError('当前 Round 只支持图片、视频和音频媒体项', 409, 'AGENT_MEDIA_KIND_UNAVAILABLE');
    }
    const spec = item.spec || {};
    const binding = configuredMediaBinding(
      item.kind,
      item.provider,
      item.model,
      item.kind === 'audio' ? spec.voice : (spec.ratio || spec.aspectRatio),
      item.kind === 'audio' ? spec.format : (spec.resolution || spec.size),
      item.kind === 'audio' ? spec.speed : spec.duration
    );
    const estimatedCost = item.kind === 'image' ? IMAGE_PRICES[binding.resolution]
      : item.kind === 'video' ? exactMoney(VIDEO_PRICES[binding.resolution] * binding.duration)
        : AUDIO_TTS_PRICE_CEILING;
    return Object.freeze({
      itemId: item.itemId,
      provider: binding.providerId,
      model: binding.model,
      taskKind: item.kind,
      quantity: 1,
      resolution: binding.resolution,
      aspectRatio: binding.ratio,
      duration: binding.duration,
      estimatedCost,
      budgetLimit: estimatedCost,
      currency: 'USD',
      retryLimit: 0,
      allowFallback: false
    });
  }

  function verifyGenerationRoundQuote({ session, round } = {}) {
    if (!session || !round || !(session.generationRounds || []).some(candidate => candidate.roundId === round.roundId)) {
      throw mediaError('GenerationRound 不属于当前 AgentSession', 409, 'GENERATION_ROUND_SESSION_CONFLICT');
    }
    if (session.workspaceScope !== 'canvas-agent') throw mediaError('媒体任务只能属于 canvas-agent', 409, 'INVALID_WORKSPACE_SCOPE');
    if (session.status === 'cancelled' || round.status === 'cancelled') {
      throw mediaError('已取消的 GenerationRound 不能报价', 409, 'GENERATION_ROUND_CANCELLED');
    }
    const config = getCanvasConfig() || {};
    if (!Array.isArray(config.providers) || !config.providers.length) {
      throw mediaError('GenerationRound 服务端报价不可用', 503, 'AGENT_GENERATION_ROUND_QUOTE_UNAVAILABLE');
    }
    const plan = assertGenerationPlanIdentity(pureRoundPlan(round), {
      planRevision: round.planRevision,
      planHash: round.planHash
    });
    const branchItems = plan.items.filter(item => item.parentNodeRef);
    if (branchItems.length && (branchItems.length !== 1 || plan.items.length !== 1 || branchItems[0].dependsOn.length)) {
      throw mediaError('Prompt 重做必须是无依赖的单项 GenerationRound', 409, 'AGENT_MEDIA_BRANCH_PLAN_INVALID');
    }
    branchItems.forEach(item => trustedBranchSource(session, item));
    const quotesByItemId = Object.fromEntries(plan.items.map(item => [item.itemId, quoteRoundItem(item)]));
    const summary = summarizeGenerationCost(plan, quotesByItemId);
    return Object.freeze({
      verified: true,
      source: 'server-price-catalog',
      agentSessionId: session.id,
      roundId: round.roundId,
      planRevision: plan.planRevision,
      planHash: round.planHash,
      totalQuantity: plan.items.length,
      estimatedCost: summary.estimatedCost,
      budgetLimit: summary.estimatedCost,
      currency: summary.currency,
      quotesByItemId: Object.freeze(quotesByItemId)
    });
  }

  function lockRoundItemInput(session, round, item, identity, taskPayload, inputRefs, quote) {
    if (!foundation || typeof foundation.createArtifact !== 'function'
      || !foundation.approvalGate || typeof foundation.approvalGate.requestReview !== 'function'
      || typeof foundation.approvalGate.approve !== 'function' || typeof foundation.approvalGate.lock !== 'function') {
      throw mediaError('媒体执行输入缺少 Foundation 锁定端口', 503, 'AGENT_MEDIA_FOUNDATION_UNAVAILABLE');
    }
    let inputArtifact = foundation.createArtifact({
      logicalArtifactId: `agent-round-item-input-${identity.key.slice(0, 40)}`,
      artifactType: 'agent-media-execution-input',
      operationId: `agent-round-item-input-create-${identity.key.slice(0, 40)}`,
      source: 'agent-media-execution-service',
      content: {
        triggerMessageEventId: round.sourceMessageEventId,
        roundIdentity: {
          roundId: round.roundId,
          planRevision: round.planRevision,
          planHash: round.planHash,
          itemId: item.itemId,
          stageId: item.stageId
        },
        normalizedExecutionPayload: normalizeAgentNativeExecutionPayload(item.kind, taskPayload, inputRefs),
        quote
      },
      extension: '.json',
      inputRefs: [{ artifactVersionId: round.planArtifactVersionId, role: 'locked-generation-plan' }],
      metadata: {
        canvasId: session.canvasId,
        agentSessionId: session.id,
        workspaceScope: 'canvas-agent',
        hidden: true,
        visibility: 'backend-only',
        roundId: round.roundId,
        itemId: item.itemId,
        toolRunId: identity.toolRunId,
        nodeId: identity.nodeId,
        inputHash: identity.inputHash
      }
    });
    if (inputArtifact.approvalState === 'draft') inputArtifact = foundation.approvalGate.requestReview(inputArtifact.artifactVersionId);
    if (inputArtifact.approvalState === 'awaiting-review') inputArtifact = foundation.approvalGate.approve(inputArtifact.artifactVersionId);
    if (inputArtifact.approvalState === 'approved') inputArtifact = foundation.approvalGate.lock(inputArtifact.artifactVersionId);
    if (inputArtifact.approvalState !== 'locked' || inputArtifact.validityState !== 'current') {
      throw mediaError('媒体执行输入未能锁定', 409, 'AGENT_MEDIA_INPUT_NOT_LOCKED');
    }
    return inputArtifact;
  }

  function materializeGenerationRoundReadyItems(sessionIdValue, roundIdValue, input = {}) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const requestId = identifier(input.requestId, 'requestId');
    let session = sessionService.loadSession(sessionId);
    if (!session) throw mediaError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
    const round = (session.generationRounds || []).find(candidate => candidate.roundId === roundId);
    if (!round) throw mediaError('GenerationRound 不存在', 404, 'GENERATION_ROUND_NOT_FOUND');
    if (session.status === 'cancelled' || round.status === 'cancelled') {
      throw mediaError('已取消的 GenerationRound 不能物化媒体任务', 409, 'GENERATION_ROUND_CANCELLED');
    }
    if (!['approved', 'running', 'partial'].includes(round.status)
      || round.authorizationState !== 'consumed' || !round.masterAuthorizationId || !round.planArtifactVersionId) {
      throw mediaError('GenerationRound 尚未完成主授权', 409, 'GENERATION_ROUND_NOT_AUTHORIZED');
    }
    const plan = assertGenerationPlanIdentity(pureRoundPlan(round), {
      planRevision: round.planRevision,
      planHash: round.planHash
    });
    const quote = verifyGenerationRoundQuote({ session, round });
    if (!foundation?.executionGuard || typeof foundation.executionGuard.consumeRoundAuthorization !== 'function'
      || typeof foundation.executionGuard.deriveRoundItemReceipt !== 'function') {
      throw mediaError('GenerationRound 缺少授权核验端口', 503, 'GENERATION_ROUND_GUARD_UNAVAILABLE');
    }
    foundation.executionGuard.consumeRoundAuthorization({
      authorizationId: round.masterAuthorizationId,
      agentSessionId: session.id,
      roundId: round.roundId,
      planRevision: round.planRevision,
      planHash: round.planHash,
      planArtifactVersionId: round.planArtifactVersionId
    });

    const failedStatuses = new Set(['failed', 'cancelled', 'blocked-by-dependency']);
    for (const item of round.items) {
      if (item.status !== 'planned') continue;
      const failedDependency = (item.dependsOn || []).find(dependency => {
        const source = round.items.find(candidate => candidate.itemId === dependency.itemId);
        return source && failedStatuses.has(source.status);
      });
      if (!failedDependency) continue;
      sessionService.updateGenerationRoundItem(session.id, round.roundId, item.itemId, {
        requestId: `${requestId}-block-${item.itemId}`,
        status: 'blocked-by-dependency',
        error: `依赖 ${failedDependency.itemId} 未成功，当前媒体项未物化`
      });
    }

    session = sessionService.loadSession(session.id);
    const currentRound = session.generationRounds.find(candidate => candidate.roundId === round.roundId);
    const statuses = Object.fromEntries(currentRound.items.map(item => [item.itemId, item.status]));
    const ready = selectReadyItems(plan, statuses);
    const executions = [];
    for (const plannedItem of ready) {
      const item = currentRound.items.find(candidate => candidate.itemId === plannedItem.itemId);
      const itemQuote = quote.quotesByItemId[item.itemId];
      const branchSource = trustedBranchSource(session, item);
      const trustedReferences = branchSource?.trustedReferences?.length
        ? [...branchSource.trustedReferences]
        : item.kind === 'image'
          ? trustedDependencyImages(session, currentRound, item, IMAGE_REFERENCE_LIMIT)
          : item.kind === 'video'
            ? trustedDependencyImages(session, currentRound, item, VIDEO_REFERENCE_LIMIT)
            : [];
      const key = digest({
        agentSessionId: session.id,
        roundId: currentRound.roundId,
        planRevision: currentRound.planRevision,
        planHash: currentRound.planHash,
        itemId: item.itemId
      });
      const operationId = `agent-round-${item.kind}-${key.slice(0, 32)}`;
      const toolRunId = `tool-agent-round-${key.slice(0, 32)}`;
      const nodeId = `node-agent-round-${key.slice(0, 32)}`;
      const inputRefs = [
        { refId: currentRound.sourceMessageEventId, workspaceScope: 'canvas-agent' },
        { refId: currentRound.planArtifactVersionId, workspaceScope: 'canvas-agent' },
        ...(branchSource ? [{ refId: branchSource.sourceNodeId, workspaceScope: 'canvas-agent' }] : []),
        ...trustedReferences.map(reference => ({ refId: reference.referenceId, workspaceScope: 'canvas-agent' }))
      ].filter((ref, index, refs) => refs.findIndex(candidate => candidate.refId === ref.refId) === index);
      const taskPayload = item.kind === 'image'
        ? {
            type: 'generator', prompt: item.prompt,
            size: imageSize(itemQuote.aspectRatio, itemQuote.resolution),
            assets: trustedReferences, canvasId: session.canvasId, nodeId
          }
        : item.kind === 'video' ? {
            prompt: item.prompt,
            duration: itemQuote.duration,
            resolution: itemQuote.resolution,
            aspect_ratio: itemQuote.aspectRatio,
            images: trustedReferences
          } : {
            input: item.prompt,
            voice: itemQuote.aspectRatio,
            response_format: itemQuote.resolution,
            speed: itemQuote.duration
          };
      const inputHash = hashAgentNativeExecutionPayload(item.kind, taskPayload, inputRefs);
      const binding = {
        provider: item.provider,
        model: item.model,
        taskKind: item.kind,
        inputHash,
        inputRefs,
        quantity: 1,
        estimatedCost: itemQuote.estimatedCost,
        approvedBudget: itemQuote.estimatedCost,
        retryBudget: 0,
        currency: 'USD',
        allowFallback: false
      };
      verifyAgentMediaQuote({ binding, executionPayload: taskPayload, inputHash });
      const identity = { key, operationId, toolRunId, nodeId, inputHash };
      const inputArtifact = lockRoundItemInput(session, currentRound, item, identity, taskPayload, inputRefs, itemQuote);
      sessionService.upsertToolRun(session.id, toolRunId, {
        requestId: `${requestId}-prepare-${item.itemId}`,
        type: `native-${item.kind}`,
        status: 'awaiting-approval',
        nodeId,
        provider: item.provider,
        model: item.model,
        operationId,
        inputVersion: inputArtifact.artifactVersionId,
        inputHash,
        quantity: 1,
        estimatedCost: itemQuote.estimatedCost,
        approvedBudget: itemQuote.estimatedCost,
        retryBudget: 0,
        attempt: 0,
        currency: 'USD',
        executionPayload: taskPayload,
        inputRefs
      });
      const child = foundation.executionGuard.deriveRoundItemReceipt({
        parentAuthorizationId: currentRound.masterAuthorizationId,
        itemId: item.itemId,
        operationId,
        provider: item.provider,
        model: item.model,
        inputVersionIds: [currentRound.planArtifactVersionId, inputArtifact.artifactVersionId],
        quantity: 1,
        estimatedCost: itemQuote.estimatedCost,
        budgetLimit: itemQuote.estimatedCost,
        currency: 'USD',
        retryLimit: 0,
        executionMode: currentRound.mode === 'automatic' ? 'auto' : 'manual',
        allowFallback: false,
        reviewGateId: 'generation-round-review',
        agentSessionId: session.id,
        toolRunId,
        nodeId,
        taskKind: item.kind,
        inputHash
      });
      sessionService.commitExecutionAuthorization(session.id, toolRunId, {
        requestId: `${requestId}-authorize-${item.itemId}`,
        authorization: { ...child, allowed: true }
      });
      const updated = sessionService.updateGenerationRoundItem(session.id, currentRound.roundId, item.itemId, {
        requestId: `${requestId}-bind-${item.itemId}`,
        status: 'queued',
        toolRunId,
        nodeId,
        operationId,
        inputHash
      });
      session = updated.session;
      const toolRun = session.toolRuns.find(candidate => candidate.id === toolRunId);
      executions.push(executionFrom(session, toolRun));
    }
    return Object.freeze({
      session: sessionService.loadSession(session.id),
      roundId: currentRound.roundId,
      planRevision: currentRound.planRevision,
      planHash: currentRound.planHash,
      readyExecutions: executions,
      blockedItemIds: sessionService.loadSession(session.id).generationRounds
        .find(candidate => candidate.roundId === currentRound.roundId).items
        .filter(item => item.status === 'blocked-by-dependency').map(item => item.itemId)
    });
  }

  function prepareBranchRedo(sessionIdValue, input = {}) {
    if (typeof sessionService.appendMessage !== 'function'
      || typeof sessionService.createGenerationRound !== 'function'
      || typeof sessionService.commitGenerationRound !== 'function') {
      throw mediaError('AgentSession 分支计划端口不可用', 500, 'AGENT_SESSION_SERVICE_UNAVAILABLE');
    }
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const requestId = identifier(input.requestId, 'requestId');
    const sourceNodeId = identifier(input.sourceNodeId, '重做源节点 ID');
    const prompt = text(input.prompt, 60_000, '重做 Prompt', true);
    const initialSession = sessionService.loadSession(sessionId);
    if (!initialSession) throw mediaError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
    if (initialSession.workspaceScope !== 'canvas-agent') throw mediaError('媒体任务只能属于 canvas-agent', 409, 'INVALID_WORKSPACE_SCOPE');
    if (initialSession.status === 'cancelled') throw mediaError('已取消的 AgentSession 不能建立重做分支', 409, 'SESSION_CANCELLED');
    const source = trustedRedoSource(initialSession, sourceNodeId);
    const defaults = initialSession.constraints?.mediaDefaults;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      throw mediaError('AgentSession 未保存媒体默认设置', 409, 'AGENT_MEDIA_DEFAULTS_MISSING');
    }
    const prefix = source.kind;
    if (defaults[`${prefix}Quantity`] !== 1) {
      throw mediaError('Prompt 重做每次只允许建立一个独立媒体项', 409, 'AGENT_MEDIA_QUANTITY_UNAVAILABLE');
    }
    const binding = configuredMediaBinding(
      source.kind,
      defaults[`${prefix}ProviderId`],
      defaults[`${prefix}Model`],
      defaults[`${prefix}Ratio`],
      defaults[`${prefix}Resolution`],
      source.kind === 'video' ? (defaults.videoDuration ?? 5) : null
    );
    const requestKey = digest({ sessionId, requestId });
    const bindingKey = digest({
      sessionId,
      requestId,
      sourceNodeId,
      sourceToolRunId: source.toolRun.id,
      sourceInputHash: source.toolRun.inputHash || '',
      branchRootRef: source.branchRootRef,
      kind: source.kind,
      prompt,
      provider: binding.providerId,
      model: binding.model,
      ratio: binding.ratio,
      resolution: binding.resolution,
      duration: binding.duration
    });
    const userEventId = `agent-branch-redo-user-${bindingKey.slice(0, 40)}`;
    const assistantEventId = `agent-branch-redo-assistant-${bindingKey.slice(0, 35)}`;
    const roundId = `agent-branch-redo-round-${bindingKey.slice(0, 39)}`;
    const itemId = `branch-redo-${source.kind}-${bindingKey.slice(0, 40)}`;
    const plan = normalizeGenerationPlan({
      planRevision: 1,
      stages: [{ stageId: 'stage-branch-redo', label: 'Prompt 重做' }],
      items: [{
        itemId,
        stageId: 'stage-branch-redo',
        kind: source.kind,
        prompt,
        promptVersion: `prompt-branch-${bindingKey.slice(0, 32)}`,
        provider: binding.providerId,
        model: binding.model,
        spec: {
          ratio: binding.ratio,
          resolution: binding.resolution,
          ...(source.kind === 'video' ? { duration: binding.duration } : {})
        },
        quantity: 1,
        dependsOn: [],
        parentNodeRef: source.sourceNodeId,
        branchRootRef: source.branchRootRef,
        supersedesRef: source.sourceNodeId
      }]
    }, { allowedKinds: ['image', 'video'] });
    const userWritten = sessionService.appendMessage(sessionId, {
      requestId: `agent-branch-redo-user-${requestKey.slice(0, 40)}`,
      eventId: userEventId,
      role: 'user',
      kind: 'text',
      content: prompt,
      attachments: [{
        assetId: source.sourceNodeId,
        kind: 'agent-node-ref',
        name: 'Prompt 重做源节点',
        mimeType: 'application/vnd.lanvas.agent-node-ref+json'
      }]
    });
    sessionService.createGenerationRound(sessionId, {
      requestId: `agent-branch-redo-create-${requestKey.slice(0, 38)}`,
      roundId,
      sourceMessageEventId: userEventId,
      mode: defaults.autoGenerateMedia === true ? 'automatic' : 'manual'
    });
    const committed = sessionService.commitGenerationRound(sessionId, roundId, {
      requestId: `agent-branch-redo-commit-${requestKey.slice(0, 38)}`,
      planRevision: plan.planRevision,
      stages: plan.stages,
      items: plan.items
    });
    if (committed.round.planHash !== plan.planHash) {
      throw mediaError('重做分支计划落库后摘要不一致', 500, 'GENERATION_ROUND_PLAN_CONFLICT');
    }
    const modeText = committed.round.mode === 'automatic'
      ? '已按自动模式锁定，等待安全执行层处理。'
      : '已锁定为一次总确认，确认前不会建立媒体任务或节点。';
    const assistantWritten = sessionService.appendMessage(sessionId, {
      requestId: `agent-branch-redo-assistant-${requestKey.slice(0, 35)}`,
      eventId: assistantEventId,
      role: 'assistant',
      kind: 'text',
      content: `已为当前${source.kind === 'video' ? '视频' : '图片'}建立 Prompt 重做分支。${modeText}`,
      attachments: [{
        assetId: committed.round.roundId,
        kind: 'agent-generation-round',
        name: 'GenerationRound',
        mimeType: 'application/vnd.lanvas.agent-generation-round+json'
      }]
    });
    const session = assistantWritten.session;
    return Object.freeze({
      session,
      userMessage: session.messages.find(message => message.eventId === userEventId)
        || userWritten.session.messages.find(message => message.eventId === userEventId),
      message: session.messages.find(message => message.eventId === assistantEventId),
      generationRound: session.generationRounds.find(round => round.roundId === roundId),
      idempotent: assistantWritten.idempotent
    });
  }

  function prepare(sessionIdValue, input = {}) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const requestId = identifier(input.requestId, 'requestId');
    const triggerMessageEventId = identifier(input.triggerMessageEventId, '触发消息 eventId');
    const kind = String(input.kind || '').trim().toLowerCase();
    if (!['image', 'video', 'audio'].includes(kind)) throw mediaError('媒体类型只支持 image、video 或 audio', 400, 'AGENT_MEDIA_KIND_UNAVAILABLE');
    const prompt = text(input.prompt, kind === 'audio' ? AUDIO_TTS_MAX_CHARS : 60_000, '媒体 Prompt', true);
    const sourceNodeId = kind === 'video' && String(input.sourceNodeId || '').trim()
      ? identifier(input.sourceNodeId, '参考图片节点 ID')
      : '';
    const sourceImageIndex = sourceNodeId ? Number(input.sourceImageIndex ?? 0) : 0;
    const session = sessionService.loadSession(sessionId);
    if (!session) throw mediaError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
    if (session.workspaceScope !== 'canvas-agent') throw mediaError('媒体任务只能属于 canvas-agent', 409, 'INVALID_WORKSPACE_SCOPE');
    if (session.status === 'cancelled') throw mediaError('已取消的 AgentSession 不能准备媒体任务', 409, 'SESSION_CANCELLED');
    const trigger = session.messages.find(message => message.eventId === triggerMessageEventId || message.id === triggerMessageEventId);
    if (!trigger || trigger.role !== 'user') throw mediaError('触发消息不属于当前 AgentSession 用户消息', 409, 'AGENT_MEDIA_TRIGGER_INVALID');

    const defaults = session.constraints?.mediaDefaults;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      throw mediaError('AgentSession 未保存媒体默认设置', 409, 'AGENT_MEDIA_DEFAULTS_MISSING');
    }
    const prefix = kind;
    const providerId = text(defaults[`${prefix}ProviderId`], 160, `${prefix} Provider`, true);
    const model = text(defaults[`${prefix}Model`], 240, `${prefix} 模型`, true);
    const ratio = text(kind === 'audio' ? defaults.audioVoice : defaults[`${prefix}Ratio`], 20, `${prefix} 比例或音色`, true).toLowerCase();
    const resolution = text(kind === 'audio' ? defaults.audioFormat : defaults[`${prefix}Resolution`], 20, `${prefix} 规格`, true).toLowerCase();
    const quantity = defaults[`${prefix}Quantity`];
    if (quantity !== 1) throw mediaError('当前每次媒体生成数量只能为 1', 409, 'AGENT_MEDIA_QUANTITY_UNAVAILABLE');
    const duration = kind === 'video' ? (defaults.videoDuration === undefined ? 5 : defaults.videoDuration)
      : kind === 'audio' ? (defaults.audioSpeed === undefined ? 1 : defaults.audioSpeed) : null;
    if (kind === 'video' && (!Number.isInteger(duration) || duration < 5 || duration > 15)) {
      throw mediaError('视频时长必须是 5 至 15 秒的整数', 409, 'AGENT_MEDIA_DURATION_UNAVAILABLE');
    }

    const config = getCanvasConfig() || {};
    const provider = (Array.isArray(config.providers) ? config.providers : []).find(item => item?.id === providerId);
    if (!provider || provider.enabled === false) throw mediaError('媒体 Provider 不存在或已禁用', 409, 'AGENT_MEDIA_PROVIDER_UNAVAILABLE');
    if (String(provider.protocol || '').toLowerCase() !== 'apimart') throw mediaError('当前媒体执行只接入 APIMart', 409, 'AGENT_MEDIA_PROTOCOL_UNAVAILABLE');
    if (!String(provider.api_key || '').trim() || !String(provider.base_url || '').trim()) {
      throw mediaError('媒体 Provider 缺少 API Key 或 Base URL', 409, 'AGENT_MEDIA_PROVIDER_INCOMPLETE');
    }
    const configuredModels = kind === 'image' ? provider.image_models : kind === 'video' ? provider.video_models : provider.audio_models;
    const allowedModels = kind === 'image' ? IMAGE_MODELS : kind === 'video' ? VIDEO_MODELS : AUDIO_MODELS;
    if (!Array.isArray(configuredModels) || !configuredModels.includes(model)
      || !allowedModels.has(model)) {
      throw mediaError('媒体模型未在 Provider 与价目白名单中启用', 409, 'AGENT_MEDIA_MODEL_UNAVAILABLE');
    }

    if (kind === 'image') imageSize(ratio, resolution);
    else if (kind === 'video' && (!VIDEO_RATIOS.has(ratio) || !Object.hasOwn(VIDEO_PRICES, resolution))) {
      throw mediaError('视频比例或清晰度不受支持', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    } else if (kind === 'audio' && (!AUDIO_VOICES.has(ratio) || !AUDIO_FORMATS.has(resolution)
      || !Number.isFinite(duration) || duration < 0.25 || duration > 4)) {
      throw mediaError('音频音色、格式或语速不受支持', 409, 'AGENT_MEDIA_SPEC_UNAVAILABLE');
    }
    const trustedReference = sourceNodeId ? trustedSourceImage(session, sourceNodeId, sourceImageIndex) : null;
    const canonical = { requestId, triggerMessageEventId, kind, prompt, canvasId: session.canvasId, providerId, model, ratio, resolution, quantity, duration, sourceNodeId, sourceImageIndex };
    const key = digest(canonical);
    const operationId = `agent-media-${kind}-${key.slice(0, 32)}`;
    const toolRunId = `tool-agent-media-${key.slice(0, 32)}`;
    const nodeId = `node-agent-media-${key.slice(0, 32)}`;
    const inputRefs = [
      { refId: triggerMessageEventId, workspaceScope: 'canvas-agent' },
      ...(trustedReference ? [{ refId: trustedReference.referenceId, workspaceScope: 'canvas-agent' }] : [])
    ];
    const taskPayload = kind === 'image'
      ? { type: 'generator', prompt, size: imageSize(ratio, resolution), assets: [], canvasId: session.canvasId, nodeId }
      : kind === 'video' ? { prompt, duration, resolution, aspect_ratio: ratio, images: trustedReference ? [trustedReference] : [] }
        : { input: prompt, voice: ratio, response_format: resolution, speed: duration };
    const inputHash = hashAgentNativeExecutionPayload(kind, taskPayload, inputRefs);
    const estimatedCost = kind === 'image' ? IMAGE_PRICES[resolution]
      : kind === 'video' ? exactMoney(VIDEO_PRICES[resolution] * duration) : AUDIO_TTS_PRICE_CEILING;
    const quoteBinding = {
      provider: providerId, model, taskKind: kind, inputHash, inputRefs,
      quantity: 1, estimatedCost, approvedBudget: estimatedCost, retryBudget: 0,
      currency: 'USD', allowFallback: false
    };
    const quote = verifyAgentMediaQuote({ binding: quoteBinding, executionPayload: taskPayload, inputHash });
    if (!foundation || typeof foundation.createArtifact !== 'function'
      || !foundation.approvalGate || typeof foundation.approvalGate.requestReview !== 'function'
      || typeof foundation.approvalGate.approve !== 'function' || typeof foundation.approvalGate.lock !== 'function') {
      throw mediaError('媒体执行输入缺少 Foundation 锁定端口', 503, 'AGENT_MEDIA_FOUNDATION_UNAVAILABLE');
    }
    let inputArtifact = foundation.createArtifact({
      logicalArtifactId: `agent-media-input-${key.slice(0, 40)}`,
      artifactType: 'agent-media-execution-input',
      operationId: `agent-media-input-create-${key.slice(0, 40)}`,
      source: 'agent-media-execution-service',
      content: {
        triggerMessageEventId,
        normalizedExecutionPayload: normalizeAgentNativeExecutionPayload(kind, taskPayload, inputRefs),
        mediaSettings: { kind, providerId, model, ratio, resolution, quantity: 1, duration },
        quote
      },
      extension: '.json',
      inputRefs: [],
      metadata: {
        canvasId: session.canvasId,
        agentSessionId: session.id,
        workspaceScope: 'canvas-agent',
        hidden: true,
        visibility: 'backend-only',
        triggerMessageEventId,
        toolRunId,
        nodeId,
        inputHash
      }
    });
    if (inputArtifact.approvalState === 'draft') inputArtifact = foundation.approvalGate.requestReview(inputArtifact.artifactVersionId);
    if (inputArtifact.approvalState === 'awaiting-review') inputArtifact = foundation.approvalGate.approve(inputArtifact.artifactVersionId);
    if (inputArtifact.approvalState === 'approved') inputArtifact = foundation.approvalGate.lock(inputArtifact.artifactVersionId);
    if (inputArtifact.approvalState !== 'locked' || inputArtifact.validityState !== 'current') {
      throw mediaError('媒体执行输入未能锁定', 409, 'AGENT_MEDIA_INPUT_NOT_LOCKED');
    }
    const inputVersion = inputArtifact.artifactVersionId;
    const stored = sessionService.upsertToolRun(sessionId, toolRunId, {
      requestId,
      type: `native-${kind}`,
      status: 'awaiting-approval',
      nodeId,
      provider: providerId,
      model,
      operationId,
      inputVersion,
      inputHash,
      quantity: 1,
      estimatedCost,
      approvedBudget: estimatedCost,
      retryBudget: 0,
      attempt: 0,
      currency: 'USD',
      executionPayload: taskPayload,
      inputRefs
    });
    const toolRun = stored.session.toolRuns.find(item => item.id === toolRunId);
    return { ...executionFrom(stored.session, toolRun), idempotent: stored.idempotent };
  }

  function describe(sessionIdValue, toolRunIdValue) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const toolRunId = identifier(toolRunIdValue, 'ToolRun ID');
    const session = sessionService.loadSession(sessionId);
    if (!session) throw mediaError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
    if (session.workspaceScope !== 'canvas-agent') throw mediaError('媒体任务只能属于 canvas-agent', 409, 'INVALID_WORKSPACE_SCOPE');
    return executionFrom(session, session.toolRuns.find(item => item.id === toolRunId));
  }

  return Object.freeze({
    prepare,
    prepareBranchRedo,
    describe,
    verifyQuote: verifyAgentMediaQuote,
    verifyGenerationRoundQuote,
    materializeGenerationRoundReadyItems
  });
}

module.exports = { createAgentMediaExecutionService, verifyAgentMediaQuote };
