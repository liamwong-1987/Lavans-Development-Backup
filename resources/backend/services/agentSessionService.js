'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  atomicWriteJson,
  clone,
  readJson,
  safeId,
  sha256
} = require('./canvasAgentFoundation/atomicJsonStore');
const { recoverGenerationRoundState } = require('./agentGenerationRoundService');

const SCHEMA_VERSION = 4;
const SKILL_COMPOSITION_SCHEMA_VERSION = '1.0';
const MAX_SNAPSHOT_BYTES = 100_000;
const SESSION_STATUSES = new Set(['idle', 'collecting', 'waiting-user', 'running', 'paused', 'blocked', 'completed', 'cancelled']);
const TERMINAL_SESSION_STATUSES = new Set(['cancelled']);
const TOOL_RUN_STATUSES = new Set(['planned', 'queued', 'awaiting-approval', 'submitting', 'running', 'remote-unknown', 'succeeded', 'failed', 'cancelled']);
const TERMINAL_TOOL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const DELETE_BLOCKING_TOOL_RUN_STATUSES = new Set(['submitting', 'running', 'remote-unknown']);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const MESSAGE_KINDS = new Set(['text', 'choice', 'question', 'approval', 'document', 'tool-status', 'failure-recovery', 'media', 'cost-confirmation', 'final-receipt']);
const SESSION_MODES = new Set(['prompt-only', 'generation']);
const LOCKED_TOOL_STATUSES = new Set(['submitting', 'running', 'remote-unknown', 'succeeded', 'failed', 'cancelled']);
const EXECUTION_BINDING_FIELDS = ['provider', 'model', 'operationId', 'inputVersion', 'inputHash', 'currency'];
const GENERATION_ROUND_MODES = new Set(['automatic', 'manual']);
const GENERATION_ROUND_STATUSES = new Set(['planning', 'awaiting-approval', 'approved', 'running', 'partial', 'completed', 'failed', 'cancelled', 'remote-unknown']);
const TERMINAL_GENERATION_ROUND_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const COMMITTED_GENERATION_ROUND_STATUSES = new Set(['awaiting-approval', 'approved', 'running', 'partial', 'completed', 'remote-unknown']);
const GENERATION_ITEM_KINDS = new Set(['image', 'video', 'audio', 'tool']);
const GENERATION_ITEM_STATUSES = new Set(['planned', 'queued', 'submitting', 'running', 'remote-unknown', 'succeeded', 'failed', 'cancelled', 'blocked-by-dependency']);
const TERMINAL_GENERATION_ITEM_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked-by-dependency']);
const GENERATION_ITEM_BINDING_FIELDS = ['toolRunId', 'nodeId', 'operationId', 'inputHash', 'remoteTaskId'];
const GENERATION_ITEM_STATUS_BY_TOOL_STATUS = Object.freeze({
  queued: 'queued',
  submitting: 'submitting',
  running: 'running',
  'remote-unknown': 'remote-unknown',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled'
});
const LOCAL_WORKSET_ACTIONS = new Set(['establish-smart-edit', 'prepare-canvas-export']);
const SNAPSHOT_FIELDS = Object.freeze({
  plan: 'object',
  constraints: 'object',
  safeBoundary: 'object',
  approvals: 'array',
  attachmentRefs: 'array',
  historyRefs: 'array',
  foundationArtifactRefs: 'array',
  legacyRunRefs: 'array',
  qaRefs: 'array',
  costRefs: 'array'
});

function serviceError(message, statusCode = 400, code = 'AGENT_SESSION_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function identifier(value, label) {
  try {
    return safeId(value, label);
  } catch (_error) {
    throw serviceError(`${label} 不合法`, 400, 'INVALID_ID');
  }
}

function optionalIdentifier(value, label) {
  return value === undefined || value === null || String(value).trim() === '' ? '' : identifier(value, label);
}

function plainText(value, limit, label, required = false) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (required && !text) throw serviceError(`${label} 不能为空`, 400, 'INVALID_INPUT');
  if (text.length > limit) throw serviceError(`${label} 超出长度限制`, 400, 'INVALID_INPUT');
  return text;
}

function enumValue(value, allowed, label, fallback = '') {
  const normalized = String(value === undefined || value === null ? fallback : value).trim();
  if (!allowed.has(normalized)) throw serviceError(`${label} 不合法`, 400, 'INVALID_INPUT');
  return normalized;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function workspaceScope(value) {
  const normalized = plainText(value === undefined ? 'canvas-agent' : value, 80, '工作区', true);
  if (normalized !== 'canvas-agent') throw serviceError('AgentSession 只能属于画布 AGENT 工作区', 400, 'INVALID_WORKSPACE_SCOPE');
  return normalized;
}

function booleanValue(value, label, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw serviceError(`${label} 必须是布尔值`, 400, 'INVALID_INPUT');
  return value;
}

function optionalNumber(value, label, options = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(number) || number < minimum || number > maximum || (options.integer && !Number.isInteger(number))) {
    throw serviceError(`${label} 超出允许范围`, 400, 'INVALID_NUMERIC_BOUND');
  }
  return number;
}

function optionalHash(value, label) {
  const normalized = plainText(value, 128, label);
  if (normalized && !/^[a-f0-9]{64}$/i.test(normalized)) throw serviceError(`${label} 必须是 64 位十六进制摘要`, 400, 'INVALID_INPUT_HASH');
  return normalized.toLowerCase();
}

function normalizeLocalExportPlan(value) {
  const invalid = message => { throw serviceError(message, 400, 'AGENT_LOCAL_EXPORT_PLAN_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('本地导出计划不能为空');
  const rawClips = Array.isArray(value.clips) ? value.clips : [];
  if (rawClips.length < 1 || rawClips.length > 3) invalid('本地导出计划只接受一至三个视频片段');
  const clips = rawClips.map((clip, index) => {
    if (!clip || typeof clip !== 'object' || Array.isArray(clip)) invalid(`视频片段 ${index + 1} 不合法`);
    const nodeId = identifier(clip.nodeId, `视频片段 ${index + 1} 节点 ID`);
    const start = Number(clip.start);
    const end = Number(clip.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 86_400) {
      invalid(`视频片段 ${index + 1} 裁剪区间不合法`);
    }
    return { nodeId, start, end };
  });
  if (new Set(clips.map(item => item.nodeId)).size !== clips.length) invalid('本地导出计划不能重复使用同一视频节点');

  let bgm = null;
  if (value.bgm !== undefined && value.bgm !== null) {
    if (typeof value.bgm !== 'object' || Array.isArray(value.bgm)) invalid('BGM 计划不合法');
    const volume = Number(value.bgm.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) invalid('BGM 音量必须在 0 至 1 之间');
    bgm = { nodeId: identifier(value.bgm.nodeId, 'BGM 节点 ID'), volume };
  }

  if (!value.output || typeof value.output !== 'object' || Array.isArray(value.output)) invalid('本地导出规格不能为空');
  const width = Number(value.output.width);
  const height = Number(value.output.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 360 || width > 2160 || height < 360 || height > 2160) {
    invalid('本地导出宽高必须是 360 至 2160 的整数');
  }
  return { clips, bgm, output: { width, height } };
}

function validateJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (depth > 24) throw serviceError('状态快照嵌套过深', 400, 'INVALID_JSON_SNAPSHOT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') throw serviceError('状态快照必须可安全序列化为 JSON', 400, 'INVALID_JSON_SNAPSHOT');
  if (seen.has(value)) throw serviceError('状态快照不能包含循环引用', 400, 'INVALID_JSON_SNAPSHOT');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw serviceError('状态快照只能包含普通对象和数组', 400, 'INVALID_JSON_SNAPSHOT');
  }
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  if (entries.length > 2_000) throw serviceError('状态快照项目过多', 400, 'SNAPSHOT_TOO_LARGE');
  for (const item of entries) validateJsonValue(item, seen, depth + 1);
  seen.delete(value);
}

function jsonSnapshot(value, label, shape) {
  validateJsonValue(value);
  if (shape === 'array' && !Array.isArray(value)) throw serviceError(`${label} 必须是数组`, 400, 'INVALID_JSON_SNAPSHOT');
  if (shape === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw serviceError(`${label} 必须是对象`, 400, 'INVALID_JSON_SNAPSHOT');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) throw serviceError(`${label} 超出大小限制`, 400, 'SNAPSHOT_TOO_LARGE');
  return JSON.parse(serialized);
}

function normalizedSkillIdentity(input) {
  const identity = {
    skillRef: plainText(input.skillRef, 320, 'Skill 引用'),
    signedVersion: plainText(input.signedVersion, 80, 'Skill 签名版本'),
    declaredVersion: plainText(input.declaredVersion, 80, 'Skill 声明版本'),
    contentHash: plainText(input.contentHash, 128, 'Skill 内容摘要').toLowerCase(),
    publisher: plainText(input.publisher, 160, 'Skill 发布者')
  };
  const hasSignedIdentity = Object.values(identity).some(Boolean);
  if (!hasSignedIdentity) return identity;
  if (Object.values(identity).some(value => !value)
    || !/^[a-f0-9]{64}$/.test(identity.contentHash)
    || !identity.skillRef.startsWith(`${identity.publisher}/`)) {
    throw serviceError('Skill 签名身份不完整或不一致', 400, 'INVALID_SKILL_SIGNATURE');
  }
  return identity;
}

function normalizedCompositionSkillIdentity(value, label, dependency = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(`${label} 不合法`, 400, 'INVALID_SKILL_COMPOSITION');
  }
  const identity = {
    id: identifier(value.id, `${label} ID`),
    ...(dependency ? { role: identifier(value.role, `${label}角色`) } : {}),
    declaredVersion: plainText(value.declaredVersion, 80, `${label}版本`, true),
    contentHash: optionalHash(value.contentHash, `${label}内容摘要`),
    packageHash: optionalHash(value.packageHash, `${label}包摘要`),
    publisher: plainText(value.publisher, 160, `${label}发布者`, true),
    signatureStatus: plainText(value.signatureStatus, 80, `${label}签名状态`, true)
  };
  if (!identity.contentHash || !identity.packageHash) {
    throw serviceError(`${label}缺少完整摘要`, 400, 'INVALID_SKILL_COMPOSITION');
  }
  return identity;
}

function normalizedSkillComposition(value, options = {}) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SKILL_COMPOSITION_SCHEMA_VERSION) {
    throw serviceError('Skill 组合不合法', 400, 'INVALID_SKILL_COMPOSITION');
  }
  const dependencies = Array.isArray(value.dependencies)
    ? value.dependencies.map((item, index) => normalizedCompositionSkillIdentity(item, `Skill 依赖 ${index + 1}`, true))
    : [];
  if (dependencies.length < 1 || dependencies.length > 3
    || new Set(dependencies.map(item => item.id)).size !== dependencies.length
    || new Set(dependencies.map(item => item.role)).size !== dependencies.length) {
    throw serviceError('Skill 组合依赖集合不合法', 400, 'INVALID_SKILL_COMPOSITION');
  }
  const primary = normalizedCompositionSkillIdentity(value.primary, '主 Skill');
  if (dependencies.some(item => item.id === primary.id)) {
    throw serviceError('Skill 组合不能依赖自身', 400, 'INVALID_SKILL_COMPOSITION');
  }
  const result = {
    schemaVersion: SKILL_COMPOSITION_SCHEMA_VERSION,
    compositionId: identifier(value.compositionId, 'Skill 组合 ID'),
    compositionHash: optionalHash(value.compositionHash, 'Skill 组合摘要'),
    templateId: identifier(value.templateId, 'Skill 组合模板 ID'),
    primary,
    dependencies
  };
  if (!result.compositionHash) throw serviceError('Skill 组合缺少摘要', 400, 'INVALID_SKILL_COMPOSITION');
  if (options.persisted) {
    const boundAt = optionalNumber(value.boundAt, 'Skill 组合绑定时间', { minimum: 1, integer: true, maximum: Number.MAX_SAFE_INTEGER });
    if (!boundAt) throw serviceError('Skill 组合缺少绑定时间', 400, 'INVALID_SKILL_COMPOSITION');
    result.boundAt = boundAt;
  }
  return result;
}

function normalizedAttachment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw serviceError('消息附件不合法', 400, 'INVALID_INPUT');
  return {
    assetId: optionalIdentifier(value.assetId, '附件 Asset ID'),
    kind: optionalIdentifier(value.kind || 'document', '附件类型'),
    name: plainText(value.name, 240, '附件名称'),
    mimeType: plainText(value.mimeType, 120, '附件 MIME')
  };
}

function normalizedMessageModelBinding(value, role) {
  if (value === undefined || value === null) return null;
  if (role !== 'assistant' && role !== 'tool') throw serviceError('只有 Agent 回复可以记录模型绑定', 400, 'INVALID_MESSAGE_MODEL_BINDING');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw serviceError('消息模型绑定不合法', 400, 'INVALID_MESSAGE_MODEL_BINDING');
  const skillCompositionHash = optionalHash(value.skillCompositionHash, '消息 Skill 组合摘要');
  const skillContextHash = optionalHash(value.skillContextHash, '消息 Skill 上下文摘要');
  if (Boolean(skillCompositionHash) !== Boolean(skillContextHash)) {
    throw serviceError('消息 Skill 组合与上下文摘要必须成对记录', 400, 'INVALID_MESSAGE_MODEL_BINDING');
  }
  return {
    providerId: identifier(value.providerId, '消息 Provider ID'),
    model: plainText(value.model, 240, '消息模型', true),
    usage: value.usage === undefined || value.usage === null ? null : jsonSnapshot(value.usage, '消息用量', 'object'),
    ...(skillCompositionHash ? { skillCompositionHash, skillContextHash } : {})
  };
}

function normalizedStructuredQuestion(value, role, kind) {
  if (value === undefined || value === null) return null;
  if (role !== 'assistant' || kind !== 'question') {
    throw serviceError('只有 Agent 问题消息可以携带结构化问题集', 400, 'INVALID_STRUCTURED_QUESTION');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('结构化问题集不合法', 400, 'INVALID_STRUCTURED_QUESTION');
  }
  const schemaVersion = Number(value.schemaVersion);
  if (schemaVersion !== 1) throw serviceError('结构化问题集版本不受支持', 400, 'INVALID_STRUCTURED_QUESTION');
  const rawQuestions = Array.isArray(value.questions) ? value.questions : [];
  if (rawQuestions.length < 1 || rawQuestions.length > 5) {
    throw serviceError('一次结构化提问只能包含 1 至 5 道题', 400, 'INVALID_STRUCTURED_QUESTION');
  }
  const questions = rawQuestions.map((question, questionIndex) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw serviceError(`结构化问题 ${questionIndex + 1} 不合法`, 400, 'INVALID_STRUCTURED_QUESTION');
    }
    const type = enumValue(question.type, new Set(['single', 'multiple', 'text']), `结构化问题 ${questionIndex + 1} 类型`);
    const rawChoices = question.choices === undefined ? [] : question.choices;
    if (!Array.isArray(rawChoices) || rawChoices.length > 8) {
      throw serviceError(`结构化问题 ${questionIndex + 1} 选项不合法`, 400, 'INVALID_STRUCTURED_QUESTION');
    }
    if (type === 'text' && rawChoices.length) {
      throw serviceError('文字题不能携带预设选项', 400, 'INVALID_STRUCTURED_QUESTION');
    }
    if (type !== 'text' && rawChoices.length < 2) {
      throw serviceError('选择题至少需要两个选项', 400, 'INVALID_STRUCTURED_QUESTION');
    }
    const choices = rawChoices.map((choice, choiceIndex) => {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
        throw serviceError(`结构化问题 ${questionIndex + 1} 选项 ${choiceIndex + 1} 不合法`, 400, 'INVALID_STRUCTURED_QUESTION');
      }
      const choiceValue = identifier(choice.value, `结构化问题 ${questionIndex + 1} 选项值`);
      if (choiceValue === '__custom__') throw serviceError('结构化问题选项使用了保留值', 400, 'INVALID_STRUCTURED_QUESTION');
      return {
        value: choiceValue,
        label: plainText(choice.label, 240, `结构化问题 ${questionIndex + 1} 选项标签`, true),
        description: plainText(choice.description, 500, `结构化问题 ${questionIndex + 1} 选项说明`)
      };
    });
    if (new Set(choices.map(choice => choice.value)).size !== choices.length) {
      throw serviceError(`结构化问题 ${questionIndex + 1} 包含重复选项`, 400, 'INVALID_STRUCTURED_QUESTION');
    }
    return {
      id: identifier(question.id, `结构化问题 ${questionIndex + 1} ID`),
      title: plainText(question.title, 160, `结构化问题 ${questionIndex + 1} 标题`, true),
      prompt: plainText(question.prompt, 1_000, `结构化问题 ${questionIndex + 1} 内容`, true),
      type,
      required: booleanValue(question.required, `结构化问题 ${questionIndex + 1} 必填标记`, true),
      allowCustom: type === 'text' ? false : booleanValue(question.allowCustom, `结构化问题 ${questionIndex + 1} 自定义选项标记`),
      placeholder: plainText(question.placeholder, 240, `结构化问题 ${questionIndex + 1} 占位提示`),
      choices
    };
  });
  if (new Set(questions.map(question => question.id)).size !== questions.length) {
    throw serviceError('结构化问题集包含重复问题 ID', 400, 'INVALID_STRUCTURED_QUESTION');
  }
  return {
    schemaVersion,
    id: identifier(value.id, '结构化问题集 ID'),
    title: plainText(value.title, 240, '结构化问题集标题', true),
    submitLabel: plainText(value.submitLabel || '继续', 80, '结构化问题集提交按钮', true),
    questions
  };
}

function normalizedStructuredAnswer(value, role, kind) {
  if (value === undefined || value === null) return null;
  if (role !== 'user' || kind !== 'choice') {
    throw serviceError('只有用户选择消息可以携带结构化答案', 400, 'INVALID_STRUCTURED_ANSWER');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('结构化答案不合法', 400, 'INVALID_STRUCTURED_ANSWER');
  }
  const rawAnswers = Array.isArray(value.answers) ? value.answers : [];
  if (rawAnswers.length < 1 || rawAnswers.length > 5) {
    throw serviceError('结构化答案数量不合法', 400, 'INVALID_STRUCTURED_ANSWER');
  }
  const answers = rawAnswers.map((answer, answerIndex) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      throw serviceError(`结构化答案 ${answerIndex + 1} 不合法`, 400, 'INVALID_STRUCTURED_ANSWER');
    }
    const values = Array.isArray(answer.values)
      ? answer.values.map((item, valueIndex) => plainText(item, 2_000, `结构化答案 ${answerIndex + 1} 值 ${valueIndex + 1}`, true))
      : [];
    if (values.length > 8 || new Set(values).size !== values.length) {
      throw serviceError(`结构化答案 ${answerIndex + 1} 选值不合法`, 400, 'INVALID_STRUCTURED_ANSWER');
    }
    return {
      questionId: identifier(answer.questionId, `结构化答案 ${answerIndex + 1} 问题 ID`),
      values,
      customText: plainText(answer.customText, 2_000, `结构化答案 ${answerIndex + 1} 自定义内容`),
      skipped: booleanValue(answer.skipped, `结构化答案 ${answerIndex + 1} 忽略标记`)
    };
  });
  if (new Set(answers.map(answer => answer.questionId)).size !== answers.length) {
    throw serviceError('结构化答案包含重复问题 ID', 400, 'INVALID_STRUCTURED_ANSWER');
  }
  return {
    questionSetId: identifier(value.questionSetId, '结构化答案问题集 ID'),
    questionEventId: identifier(value.questionEventId, '结构化答案问题消息 eventId'),
    answers
  };
}

function assertStructuredAnswerMatchesSession(session, structuredAnswer) {
  const source = session.messages.find(message => message.eventId === structuredAnswer.questionEventId
    && message.role === 'assistant' && message.kind === 'question'
    && message.structuredQuestion?.id === structuredAnswer.questionSetId);
  if (!source) throw serviceError('结构化答案找不到对应的问题集', 409, 'STRUCTURED_QUESTION_NOT_FOUND');
  if (session.messages.some(message => message.role === 'user'
    && message.structuredAnswer?.questionSetId === structuredAnswer.questionSetId)) {
    throw serviceError('该结构化问题集已经提交', 409, 'STRUCTURED_QUESTION_ALREADY_ANSWERED');
  }
  const questions = source.structuredQuestion.questions;
  if (structuredAnswer.answers.length !== questions.length) {
    throw serviceError('结构化答案没有完整覆盖问题集', 409, 'STRUCTURED_ANSWER_INCOMPLETE');
  }
  const byQuestion = new Map(structuredAnswer.answers.map(answer => [answer.questionId, answer]));
  for (const question of questions) {
    const answer = byQuestion.get(question.id);
    if (!answer) throw serviceError('结构化答案缺少对应问题', 409, 'STRUCTURED_ANSWER_INCOMPLETE');
    if (answer.skipped) {
      if (question.required) throw serviceError('必填问题不能忽略', 409, 'STRUCTURED_ANSWER_INCOMPLETE');
      if (answer.values.length || answer.customText) throw serviceError('已忽略问题不能同时提交答案', 409, 'STRUCTURED_ANSWER_INVALID');
      continue;
    }
    if (question.type === 'text') {
      if (answer.values.length !== 1 || answer.customText) throw serviceError('文字题答案不合法', 409, 'STRUCTURED_ANSWER_INVALID');
      continue;
    }
    const minimum = 1;
    const maximum = question.type === 'single' ? 1 : question.choices.length + (question.allowCustom ? 1 : 0);
    if (answer.values.length < minimum || answer.values.length > maximum) {
      throw serviceError('选择题答案数量不合法', 409, 'STRUCTURED_ANSWER_INVALID');
    }
    const allowed = new Set(question.choices.map(choice => choice.value));
    for (const selected of answer.values) {
      if (selected === '__custom__') {
        if (!question.allowCustom || !answer.customText) throw serviceError('自定义选项答案不完整', 409, 'STRUCTURED_ANSWER_INVALID');
      } else if (!allowed.has(selected)) {
        throw serviceError('结构化答案包含未知选项', 409, 'STRUCTURED_ANSWER_INVALID');
      }
    }
    if (!answer.values.includes('__custom__') && answer.customText) {
      throw serviceError('未选择自定义选项时不能提交自定义内容', 409, 'STRUCTURED_ANSWER_INVALID');
    }
  }
}

function normalizedGenerationStage(value, index) {
  const stage = jsonSnapshot(value, `生成阶段 ${index + 1}`, 'object');
  return { ...stage, stageId: identifier(stage.stageId, `生成阶段 ${index + 1} ID`) };
}

function normalizedGenerationDependency(value, itemIndex, dependencyIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('生成计划依赖不合法', 400, 'INVALID_GENERATION_ROUND_PLAN');
  }
  return {
    itemId: identifier(value.itemId, `生成项 ${itemIndex + 1} 依赖 ${dependencyIndex + 1} ID`),
    role: optionalIdentifier(value.role, `生成项 ${itemIndex + 1} 依赖角色`)
  };
}

function normalizedGenerationBranchIdentity(value, itemIndex) {
  const identity = {
    parentNodeRef: optionalIdentifier(value.parentNodeRef, `生成项 ${itemIndex + 1} 父节点`),
    branchRootRef: optionalIdentifier(value.branchRootRef, `生成项 ${itemIndex + 1} 分支根节点`),
    supersedesRef: optionalIdentifier(value.supersedesRef, `生成项 ${itemIndex + 1} 被替代节点`)
  };
  const refs = Object.values(identity);
  if (!refs.some(Boolean)) return {};
  if (refs.some(ref => !ref) || identity.parentNodeRef !== identity.supersedesRef) {
    throw serviceError('重做分支身份必须完整，且父节点必须是被替代节点', 400, 'INVALID_GENERATION_BRANCH_IDENTITY');
  }
  return identity;
}

function normalizedGenerationItem(value, index) {
  const item = jsonSnapshot(value, `生成项 ${index + 1}`, 'object');
  const quantity = optionalNumber(item.quantity, `生成项 ${index + 1} 数量`, { integer: true, minimum: 1, maximum: 1 });
  if (quantity !== 1) throw serviceError('每个生成项必须对应一个独立输出', 400, 'INVALID_GENERATION_ITEM_QUANTITY');
  const dependencies = Array.isArray(item.dependsOn) ? item.dependsOn : [];
  if (dependencies.length > 1_000) throw serviceError('生成项依赖过多', 400, 'INVALID_GENERATION_ROUND_PLAN');
  const branchIdentity = normalizedGenerationBranchIdentity(item, index);
  return {
    itemId: identifier(item.itemId, `生成项 ${index + 1} ID`),
    stageId: identifier(item.stageId, `生成项 ${index + 1} 阶段 ID`),
    kind: enumValue(item.kind, GENERATION_ITEM_KINDS, `生成项 ${index + 1} 类型`),
    prompt: plainText(item.prompt, 60_000, `生成项 ${index + 1} Prompt`, true),
    promptVersion: optionalIdentifier(item.promptVersion, `生成项 ${index + 1} Prompt 版本`),
    provider: plainText(item.provider, 160, `生成项 ${index + 1} Provider`, true),
    model: plainText(item.model, 240, `生成项 ${index + 1} 模型`, true),
    spec: jsonSnapshot(item.spec || {}, `生成项 ${index + 1} 规格`, 'object'),
    quantity,
    dependsOn: dependencies.map((dependency, dependencyIndex) => normalizedGenerationDependency(dependency, index, dependencyIndex)),
    ...branchIdentity,
    status: enumValue(item.status, GENERATION_ITEM_STATUSES, `生成项 ${index + 1} 状态`, 'planned'),
    toolRunId: optionalIdentifier(item.toolRunId, `生成项 ${index + 1} ToolRun ID`),
    nodeId: optionalIdentifier(item.nodeId, `生成项 ${index + 1} 节点 ID`),
    operationId: optionalIdentifier(item.operationId, `生成项 ${index + 1}操作 ID`),
    inputHash: optionalHash(item.inputHash, `生成项 ${index + 1}输入摘要`),
    remoteTaskId: plainText(item.remoteTaskId, 320, `生成项 ${index + 1}远端任务 ID`),
    error: plainText(item.error, 2_000, `生成项 ${index + 1}失败摘要`),
    reconcileRequired: booleanValue(item.reconcileRequired, `生成项 ${index + 1}核对标记`),
    updatedAt: optionalNumber(item.updatedAt, `生成项 ${index + 1}更新时间`, { maximum: Number.MAX_SAFE_INTEGER }) ?? 0
  };
}

function generationPlanIdentity(stages, items) {
  return {
    stages,
    items: items.map(item => ({
      itemId: item.itemId,
      stageId: item.stageId,
      kind: item.kind,
      prompt: item.prompt,
      promptVersion: item.promptVersion,
      provider: item.provider,
      model: item.model,
      spec: item.spec,
      quantity: item.quantity,
      dependsOn: item.dependsOn,
      ...(item.parentNodeRef ? {
        parentNodeRef: item.parentNodeRef,
        branchRootRef: item.branchRootRef,
        supersedesRef: item.supersedesRef
      } : {})
    }))
  };
}

function normalizedGenerationPlan(input, options = {}) {
  const planRevision = optionalNumber(input.planRevision, '生成计划版本', { integer: true, minimum: 1, maximum: 1_000_000 });
  if (planRevision === null) throw serviceError('生成计划版本不能为空', 400, 'INVALID_GENERATION_ROUND_PLAN');
  const rawStages = jsonSnapshot(input.stages, '生成阶段', 'array');
  const rawItems = jsonSnapshot(input.items, '生成项目', 'array');
  if (!rawStages.length || !rawItems.length || rawStages.length > 1_000 || rawItems.length > 2_000) {
    throw serviceError('生成计划必须包含有界阶段和项目', 400, 'INVALID_GENERATION_ROUND_PLAN');
  }
  const stages = rawStages.map(normalizedGenerationStage);
  const items = rawItems.map(normalizedGenerationItem);
  if (new Set(stages.map(stage => stage.stageId)).size !== stages.length
    || new Set(items.map(item => item.itemId)).size !== items.length) {
    throw serviceError('生成阶段或项目 ID 重复', 400, 'INVALID_GENERATION_ROUND_PLAN');
  }
  const stageIds = new Set(stages.map(stage => stage.stageId));
  if (items.some(item => !stageIds.has(item.stageId))) {
    throw serviceError('生成项目引用了不存在的阶段', 400, 'INVALID_GENERATION_ROUND_PLAN');
  }
  if (!options.allowExecutionState && items.some(item => item.status !== 'planned'
    || GENERATION_ITEM_BINDING_FIELDS.some(field => item[field])
    || item.error
    || item.reconcileRequired)) {
    throw serviceError('提交计划不能预写执行状态或远端绑定', 400, 'INVALID_GENERATION_ROUND_PLAN');
  }
  const identity = generationPlanIdentity(stages, items);
  jsonSnapshot(identity, '生成计划', 'object');
  return { planRevision, stages, items, planHash: sha256(identity) };
}

function pendingHistoryMirror() {
  return { status: 'pending', historyRef: null };
}

function canonicalStoredHistoryRef(value, expectedEventId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const historyRef = {
    eventId: String(value.eventId || ''),
    artifactVersionId: String(value.artifactVersionId || ''),
    contentHash: String(value.contentHash || '').toLowerCase()
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(historyRef.eventId)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(historyRef.artifactVersionId)
    || !/^[a-f0-9]{64}$/.test(historyRef.contentHash)
    || (expectedEventId && historyRef.eventId !== expectedEventId)) return null;
  return historyRef;
}

function normalizedStoredHistoryMirror(value, expectedEventId, hasStoredValue, sessionHistoryRefs = []) {
  if (!hasStoredValue) return { status: 'legacy-untracked', historyRef: null };
  if (value && typeof value === 'object' && !Array.isArray(value)
    && value.status === 'legacy-untracked' && value.historyRef == null) {
    return { status: 'legacy-untracked', historyRef: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'mirrored') {
    return pendingHistoryMirror();
  }
  const historyRef = canonicalStoredHistoryRef(value.historyRef, expectedEventId);
  const trackedRef = sessionHistoryRefs
    .map(ref => canonicalStoredHistoryRef(ref, expectedEventId))
    .find(ref => ref
      && ref.artifactVersionId === historyRef?.artifactVersionId
      && ref.contentHash === historyRef?.contentHash);
  return historyRef && trackedRef ? { status: 'mirrored', historyRef } : pendingHistoryMirror();
}

function publicSession(value) {
  const session = clone(value);
  delete session.requestReceipts;
  return session;
}

function createAgentSessionService(options = {}) {
  const stateRoot = options.rootPath
    ? path.resolve(options.rootPath)
    : options.outputRoot
      ? path.join(path.resolve(options.outputRoot), '.state', 'agent-sessions')
      : '';
  if (!stateRoot) throw serviceError('AgentSession 存储目录不能为空', 500, 'INVALID_STORE_ROOT');

  const storePath = path.join(stateRoot, 'sessions.json');
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const makeId = typeof options.makeId === 'function'
    ? options.makeId
    : prefix => `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const verifyLocalWorksetSources = typeof options.verifyLocalWorksetSources === 'function'
    ? options.verifyLocalWorksetSources
    : null;
  let recoveryChecked = false;

  const now = () => {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  };

  const emptyStore = () => ({ schemaVersion: SCHEMA_VERSION, sessions: [], createReceipts: {}, updatedAt: 0 });

  function validateStoredGenerationRound(session, round) {
    const status = round && typeof round === 'object' && !Array.isArray(round)
      ? String(round.status || '')
      : '';
    try {
      if (!round || typeof round !== 'object' || Array.isArray(round)) throw new Error('round-shape');
      identifier(round.roundId, '持久化轮次 ID');
      if (identifier(round.sessionId, '持久化轮次 Session ID') !== session.id) throw new Error('round-session');
      identifier(round.sourceMessageEventId, '持久化轮次消息事件 ID');
      enumValue(round.mode, GENERATION_ROUND_MODES, '持久化轮次模式');
      enumValue(round.status, GENERATION_ROUND_STATUSES, '持久化轮次状态');
      const planRevision = optionalNumber(round.planRevision, '持久化计划版本', { integer: true, maximum: 1_000_000 }) ?? 0;
      const planHash = optionalHash(round.planHash, '持久化计划摘要');
      const hasPlan = planRevision > 0 || Boolean(planHash)
        || (Array.isArray(round.stages) && round.stages.length > 0)
        || (Array.isArray(round.items) && round.items.length > 0);
      if (COMMITTED_GENERATION_ROUND_STATUSES.has(status) && !hasPlan) {
        throw serviceError('已提交生成轮次缺少锁定计划', 500, 'CORRUPT_GENERATION_ROUND_PLAN');
      }
      if (hasPlan) {
        const normalized = normalizedGenerationPlan({
          planRevision,
          stages: round.stages,
          items: round.items
        }, { allowExecutionState: true });
        if (!planHash || normalized.planHash !== planHash) {
          throw serviceError('持久化生成计划摘要不一致', 500, 'CORRUPT_GENERATION_ROUND_PLAN');
        }
      } else if (!['planning', 'failed', 'cancelled'].includes(status)) {
        throw serviceError('生成轮次状态缺少计划依据', 500, 'CORRUPT_GENERATION_ROUND_PLAN');
      }
      const authorizationState = String(round.authorizationState || '');
      if (!['', 'prepared', 'consumed'].includes(authorizationState)) {
        throw serviceError('持久化 Round 授权状态不合法', 500, 'CORRUPT_GENERATION_ROUND_AUTHORIZATION');
      }
      if (authorizationState) {
        const request = normalizedGenerationRoundAuthorizationRequest(session.id, round.roundId, round.authorizationRequest);
        if (request.planRevision !== planRevision || request.planHash !== planHash
          || request.totalQuantity !== round.items.length
          || request.planArtifactVersionId !== round.planArtifactVersionId
          || request.executionMode !== (round.mode === 'automatic' ? 'auto' : 'manual')) {
          throw serviceError('持久化 Round 授权准备回执与计划不一致', 500, 'CORRUPT_GENERATION_ROUND_AUTHORIZATION');
        }
        if ((optionalNumber(round.authorizationPreparedAt, '持久化 Round 授权准备时间', { minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) ?? 0) < 1) {
          throw serviceError('持久化 Round 授权缺少准备时间', 500, 'CORRUPT_GENERATION_ROUND_AUTHORIZATION');
        }
      }
      if (authorizationState === 'consumed') {
        identifier(round.masterAuthorizationId, '持久化 Round 主授权 ID');
        if ((optionalNumber(round.authorizationConsumedAt, '持久化 Round 授权消费时间', { minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) ?? 0) < 1) {
          throw serviceError('持久化 Round 授权缺少消费时间', 500, 'CORRUPT_GENERATION_ROUND_AUTHORIZATION');
        }
      }
      optionalNumber(round.createdAt, '持久化轮次创建时间', { maximum: Number.MAX_SAFE_INTEGER });
      optionalNumber(round.updatedAt, '持久化轮次更新时间', { maximum: Number.MAX_SAFE_INTEGER });
    } catch (error) {
      if (error?.statusCode === 500) throw error;
      const code = COMMITTED_GENERATION_ROUND_STATUSES.has(status)
        ? 'CORRUPT_GENERATION_ROUND_PLAN'
        : 'CORRUPT_GENERATION_ROUND';
      throw serviceError('持久化 GenerationRound 已损坏', 500, code);
    }
  }

  function normalizeStore(raw) {
    const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptyStore();
    let migrated = store.schemaVersion !== SCHEMA_VERSION;
    store.schemaVersion = SCHEMA_VERSION;
    store.sessions = Array.isArray(store.sessions) ? store.sessions : [];
    store.createReceipts = store.createReceipts && typeof store.createReceipts === 'object' && !Array.isArray(store.createReceipts)
      ? store.createReceipts
      : {};
    store.sessions.forEach(session => {
      const setDefault = (key, fallback) => {
        if (hasOwn(session, key)) return;
        session[key] = clone(fallback);
        migrated = true;
      };
      if (session.schemaVersion !== SCHEMA_VERSION) {
        session.schemaVersion = SCHEMA_VERSION;
        migrated = true;
      }
      if (!hasOwn(session, 'workspaceScope')) {
        session.workspaceScope = 'canvas-agent';
        migrated = true;
      } else if (session.workspaceScope !== 'canvas-agent') {
        throw serviceError('持久化会话包含非画布 AGENT 工作区', 500, 'CORRUPT_SESSION_SCOPE');
      }
      if (!SESSION_MODES.has(session.mode)) {
        if (session.mode) throw serviceError('持久化会话包含未知运行模式', 500, 'CORRUPT_SESSION_MODE');
        session.mode = 'generation';
        migrated = true;
      }
      for (const key of ['skillId', 'skillRef', 'signedVersion', 'declaredVersion', 'contentHash', 'publisher']) setDefault(key, '');
      setDefault('skillComposition', null);
      if (session.skillComposition !== null) {
        try {
          const normalized = normalizedSkillComposition(session.skillComposition, { persisted: true });
          if (session.skillId && session.skillId !== normalized.primary.id) {
            throw serviceError('持久化会话的 Skill 与组合主身份不一致', 500, 'CORRUPT_SESSION_SKILL_COMPOSITION');
          }
          if (JSON.stringify(session.skillComposition) !== JSON.stringify(normalized)) migrated = true;
          session.skillComposition = normalized;
        } catch (error) {
          if (error?.code === 'CORRUPT_SESSION_SKILL_COMPOSITION') throw error;
          throw serviceError('持久化会话的 Skill 组合已损坏', 500, 'CORRUPT_SESSION_SKILL_COMPOSITION');
        }
      }
      session.messages = Array.isArray(session.messages) ? session.messages : [];
      session.toolRuns = Array.isArray(session.toolRuns) ? session.toolRuns : [];
      session.currentNodeRefs = Array.isArray(session.currentNodeRefs) ? session.currentNodeRefs : [];
      if (!hasOwn(session, 'generationRounds')) setDefault('generationRounds', []);
      if (!Array.isArray(session.generationRounds)) {
        throw serviceError('持久化 GenerationRound 集合已损坏', 500, 'CORRUPT_GENERATION_ROUND');
      }
      setDefault('detachedNodeRefs', []);
      setDefault('composerDraft', '');
      setDefault('attachmentRefs', []);
      setDefault('unreadBoundary', '');
      setDefault('currentPhase', '');
      setDefault('plan', {});
      setDefault('constraints', {});
      setDefault('safeBoundary', {});
      setDefault('nextAction', '');
      setDefault('approvals', []);
      setDefault('executionAuthorizations', []);
      setDefault('historyRefs', []);
      setDefault('foundationArtifactRefs', []);
      setDefault('legacyRunRefs', []);
      setDefault('qaRefs', []);
      setDefault('costRefs', []);
      setDefault('finalDeliveryRef', '');
      setDefault('lastHeartbeatAt', 0);
      setDefault('recoveryStatus', 'clean');
      setDefault('blockedReason', '');
      setDefault('reconcileRequired', false);
      for (const message of session.messages) {
        if (!hasOwn(message, 'eventId')) {
          message.eventId = message.id || '';
          migrated = true;
        }
        if (!hasOwn(message, 'requestId')) {
          message.requestId = '';
          migrated = true;
        }
        if (!Array.isArray(message.attachments)) {
          message.attachments = [];
          migrated = true;
        }
        if (hasOwn(message, 'modelBinding')) {
          const normalized = normalizedMessageModelBinding(message.modelBinding, message.role);
          if (JSON.stringify(message.modelBinding) !== JSON.stringify(normalized)) migrated = true;
          message.modelBinding = normalized;
        }
        if (hasOwn(message, 'structuredQuestion')) {
          const normalized = normalizedStructuredQuestion(message.structuredQuestion, message.role, message.kind);
          if (JSON.stringify(message.structuredQuestion) !== JSON.stringify(normalized)) migrated = true;
          message.structuredQuestion = normalized;
        }
        if (hasOwn(message, 'structuredAnswer')) {
          const normalized = normalizedStructuredAnswer(message.structuredAnswer, message.role, message.kind);
          if (JSON.stringify(message.structuredAnswer) !== JSON.stringify(normalized)) migrated = true;
          message.structuredAnswer = normalized;
        }
        const hasStoredHistoryMirror = hasOwn(message, 'historyMirror');
        const historyMirror = normalizedStoredHistoryMirror(
          message.historyMirror,
          message.eventId,
          hasStoredHistoryMirror,
          session.historyRefs
        );
        if (JSON.stringify(message.historyMirror || null) !== JSON.stringify(historyMirror)) migrated = true;
        message.historyMirror = historyMirror;
      }
      for (const toolRun of session.toolRuns) {
        for (const key of ['operationId', 'inputVersion', 'inputHash', 'remoteTaskId', 'authorizationId', 'authorizationState']) {
          if (hasOwn(toolRun, key)) continue;
          toolRun[key] = '';
          migrated = true;
        }
        if (!hasOwn(toolRun, 'currency')) {
          toolRun.currency = 'CNY';
          migrated = true;
        }
        if (!hasOwn(toolRun, 'executionPayload')) {
          toolRun.executionPayload = {};
          migrated = true;
        }
        if (!hasOwn(toolRun, 'inputRefs')) {
          toolRun.inputRefs = [];
          migrated = true;
        }
        for (const key of ['quantity', 'estimatedCost', 'approvedBudget', 'retryBudget', 'attempt']) {
          if (hasOwn(toolRun, key)) continue;
          toolRun[key] = 0;
          migrated = true;
        }
      }
      for (const nodeRef of [...session.currentNodeRefs, ...session.detachedNodeRefs]) {
        if (!hasOwn(nodeRef, 'workspaceScope')) {
          nodeRef.workspaceScope = 'canvas-agent';
          migrated = true;
        }
        if (!hasOwn(nodeRef, 'nodeRole')) {
          nodeRef.nodeRole = nodeRef.role || '';
          migrated = true;
        }
        for (const key of ['parentNodeRef', 'branchRootRef', 'supersedesRef']) {
          if (hasOwn(nodeRef, key)) continue;
          nodeRef[key] = '';
          migrated = true;
        }
        if (!hasOwn(nodeRef, 'finalDelivery')) {
          nodeRef.finalDelivery = false;
          migrated = true;
        }
      }
      const storedRoundIds = new Set();
      const storedRoundSources = new Set();
      session.generationRounds.forEach(round => {
        const roundDefaults = {
          planArtifactVersionId: '',
          masterAuthorizationId: '',
          authorizationState: '',
          authorizationRequest: {},
          authorizationPreparedAt: 0,
          authorizedBy: '',
          authorizationConsumedAt: 0
        };
        for (const [key, fallback] of Object.entries(roundDefaults)) {
          if (hasOwn(round, key)) continue;
          round[key] = fallback;
          migrated = true;
        }
        validateStoredGenerationRound(session, round);
        if (storedRoundIds.has(round.roundId) || storedRoundSources.has(round.sourceMessageEventId)) {
          throw serviceError('持久化 GenerationRound 身份重复', 500, 'CORRUPT_GENERATION_ROUND');
        }
        storedRoundIds.add(round.roundId);
        storedRoundSources.add(round.sourceMessageEventId);
      });
      session.requestReceipts = session.requestReceipts && typeof session.requestReceipts === 'object' && !Array.isArray(session.requestReceipts)
        ? session.requestReceipts
        : {};
      session.revision = Math.max(1, Number(session.revision) || 1);
    });
    return { store, migrated };
  }

  function writeStore(store) {
    store.updatedAt = now();
    atomicWriteJson(storePath, store);
  }

  function recoverInterruptedRuns(store) {
    let changed = false;
    const recoveredAt = now();
    for (const session of store.sessions) {
      let sessionChanged = false;
      for (const toolRun of session.toolRuns) {
        if (toolRun.status !== 'submitting' && toolRun.status !== 'running') continue;
        toolRun.status = 'remote-unknown';
        toolRun.recoveryReason = 'service-restart';
        toolRun.recoveredAt = recoveredAt;
        toolRun.updatedAt = recoveredAt;
        projectToolRunToGenerationRound(session, toolRun, recoveredAt);
        sessionChanged = true;
      }
      let sessionNeedsReconcile = session.toolRuns.some(toolRun => toolRun.status === 'remote-unknown');
      for (const round of session.generationRounds) {
        if (TERMINAL_GENERATION_ROUND_STATUSES.has(round.status) || !round.items.length) continue;
        const identity = generationPlanIdentity(round.stages, round.items);
        const recovery = recoverGenerationRoundState(
          { planRevision: round.planRevision, ...identity },
          Object.fromEntries(round.items.map(item => [item.itemId, item.status]))
        );
        for (const item of round.items) {
          const nextStatus = recovery.statusByItemId[item.itemId];
          const nextReconcileRequired = nextStatus === 'remote-unknown';
          if (item.status !== nextStatus || item.reconcileRequired !== nextReconcileRequired) {
            item.status = nextStatus;
            item.reconcileRequired = nextReconcileRequired;
            item.updatedAt = recoveredAt;
            sessionChanged = true;
          }
        }
        let nextRoundStatus = recovery.status;
        if (round.status === 'awaiting-approval' && nextRoundStatus === 'planning') nextRoundStatus = round.status;
        if (round.status === 'approved'
          && Object.values(recovery.statusByItemId).every(status => ['planned', 'queued'].includes(status))) {
          nextRoundStatus = round.status;
        }
        if (round.status === 'partial' && ['planning', 'running'].includes(nextRoundStatus)) nextRoundStatus = round.status;
        if (round.status === 'remote-unknown') nextRoundStatus = round.status;
        const roundNeedsReconcile = recovery.reconcileRequired || round.status === 'remote-unknown';
        const recoverySummary = roundNeedsReconcile
          ? `service-restart:${recovery.interruptedItemIds.length ? `interrupted:${recovery.interruptedItemIds.join(',')}` : 'reconcile-existing'}`
          : round.recoverySummary;
        if (round.status !== nextRoundStatus || round.reconcileRequired !== roundNeedsReconcile
          || round.recoverySummary !== recoverySummary) {
          round.status = nextRoundStatus;
          round.reconcileRequired = roundNeedsReconcile;
          round.recoverySummary = recoverySummary;
          round.updatedAt = recoveredAt;
          if (TERMINAL_GENERATION_ROUND_STATUSES.has(nextRoundStatus) && !round.settledAt) round.settledAt = recoveredAt;
          sessionChanged = true;
        }
        if (roundNeedsReconcile) sessionNeedsReconcile = true;
      }
      if (sessionNeedsReconcile) {
        const nextStatus = TERMINAL_SESSION_STATUSES.has(session.status) ? session.status : 'blocked';
        if (session.status !== nextStatus || session.recoveryStatus !== 'reconcile-required'
          || session.reconcileRequired !== true || session.blockedReason !== 'service-restart-pending-reconcile') {
          session.status = nextStatus;
          session.recoveryStatus = 'reconcile-required';
          session.reconcileRequired = true;
          session.blockedReason = 'service-restart-pending-reconcile';
          sessionChanged = true;
        }
      }
      if (!sessionChanged) continue;
      session.revision += 1;
      session.updatedAt = recoveredAt;
      changed = true;
    }
    return changed;
  }

  function readStore() {
    const normalized = normalizeStore(readJson(storePath, emptyStore()));
    const store = normalized.store;
    let changed = normalized.migrated;
    if (!recoveryChecked) {
      recoveryChecked = true;
      if (recoverInterruptedRuns(store)) changed = true;
    }
    if (changed) writeStore(store);
    return store;
  }

  function findSession(store, sessionId) {
    const id = identifier(sessionId, 'AgentSession ID');
    const session = store.sessions.find(item => item.id === id);
    if (!session) throw serviceError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
    return session;
  }

  function payloadHash(operation, payload) {
    return sha256({ operation, payload });
  }

  function checkedReceipt(receipts, requestId, operation, payload) {
    const receipt = receipts[requestId];
    if (!receipt) return null;
    if (receipt.operation !== operation || receipt.payloadHash !== payloadHash(operation, payload)) {
      throw serviceError('requestId 已用于不同载荷', 409, 'IDEMPOTENCY_CONFLICT');
    }
    return receipt;
  }

  function mutateSession(sessionId, requestIdValue, operation, payload, mutate) {
    const requestId = identifier(requestIdValue, 'requestId');
    const store = readStore();
    const session = findSession(store, sessionId);
    if (checkedReceipt(session.requestReceipts, requestId, operation, payload)) {
      return { session: publicSession(session), idempotent: true };
    }

    mutate(session);
    session.revision += 1;
    session.updatedAt = now();
    session.requestReceipts[requestId] = {
      operation,
      payloadHash: payloadHash(operation, payload),
      revision: session.revision,
      recordedAt: session.updatedAt
    };
    writeStore(store);
    return { session: publicSession(session), idempotent: false };
  }

  function findGenerationRound(session, roundIdValue) {
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const round = session.generationRounds.find(item => item.roundId === roundId);
    if (!round) throw serviceError('GenerationRound 不存在', 404, 'GENERATION_ROUND_NOT_FOUND');
    return round;
  }

  function reconcileGenerationRoundFromItems(round, timestamp) {
    if (TERMINAL_GENERATION_ROUND_STATUSES.has(round.status)) return;
    const statuses = round.items.map(item => item.status);
    const allSucceeded = statuses.length > 0 && statuses.every(status => status === 'succeeded');
    const allTerminal = statuses.length > 0 && statuses.every(status => TERMINAL_GENERATION_ITEM_STATUSES.has(status));
    const hasRemoteUnknown = statuses.includes('remote-unknown');
    const hasSettledItem = statuses.some(status => TERMINAL_GENERATION_ITEM_STATUSES.has(status));
    const hasActiveItem = statuses.some(status => ['submitting', 'running'].includes(status));
    round.reconcileRequired = hasRemoteUnknown;
    if (allSucceeded) {
      round.status = 'completed';
      round.settledAt = round.settledAt || timestamp;
    } else if (allTerminal) {
      round.status = 'failed';
      round.settledAt = round.settledAt || timestamp;
    } else if (hasRemoteUnknown) {
      round.status = 'remote-unknown';
    } else if (hasSettledItem) {
      round.status = 'partial';
    } else if (hasActiveItem) {
      round.status = 'running';
    }
    round.updatedAt = timestamp;
  }

  function projectToolRunToGenerationRound(session, toolRun, timestamp) {
    const nextStatus = GENERATION_ITEM_STATUS_BY_TOOL_STATUS[toolRun.status];
    if (!nextStatus) return;
    const matches = [];
    for (const round of session.generationRounds) {
      for (const item of round.items) {
        if (item.toolRunId === toolRun.id) matches.push({ round, item });
      }
    }
    if (matches.length > 1) throw serviceError('同一 ToolRun 绑定了多个 GenerationRound item', 500, 'CORRUPT_GENERATION_ROUND');
    if (matches.length === 0) return;
    const { round, item } = matches[0];
    if (TERMINAL_GENERATION_ROUND_STATUSES.has(round.status)) return;
    for (const field of ['nodeId', 'operationId', 'inputHash']) {
      if (item[field] && toolRun[field] && item[field] !== toolRun[field]) {
        throw serviceError('ToolRun 与 GenerationRound item 执行绑定不一致', 500, 'CORRUPT_GENERATION_ROUND');
      }
    }
    if (TERMINAL_GENERATION_ITEM_STATUSES.has(item.status) && item.status !== nextStatus) {
      throw serviceError('终态 GenerationRound item 与 ToolRun 状态不一致', 409, 'INVALID_GENERATION_ITEM_TRANSITION');
    }
    item.status = nextStatus;
    if (toolRun.remoteTaskId) {
      if (item.remoteTaskId && item.remoteTaskId !== toolRun.remoteTaskId) {
        throw serviceError('GenerationRound item 远端任务绑定不可更改', 500, 'CORRUPT_GENERATION_ROUND');
      }
      item.remoteTaskId = toolRun.remoteTaskId;
    }
    item.error = nextStatus === 'failed' ? toolRun.error : '';
    item.reconcileRequired = nextStatus === 'remote-unknown';
    item.updatedAt = timestamp;
    reconcileGenerationRoundFromItems(round, timestamp);
  }

  function roundMutationResult(result, roundId) {
    const round = result.session.generationRounds.find(item => item.roundId === roundId);
    if (!round) throw serviceError('GenerationRound 写入结果缺失', 500, 'CORRUPT_GENERATION_ROUND');
    return { ...result, round: clone(round) };
  }

  function createGenerationRound(sessionId, input = {}) {
    const payload = {
      roundId: identifier(input.roundId, 'GenerationRound ID'),
      sourceMessageEventId: identifier(input.sourceMessageEventId, 'GenerationRound 消息事件 ID'),
      mode: enumValue(input.mode, GENERATION_ROUND_MODES, 'GenerationRound 模式')
    };
    const result = mutateSession(sessionId, input.requestId, 'create-generation-round', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能创建生成轮次', 409, 'SESSION_CANCELLED');
      if (session.generationRounds.some(round => round.roundId === payload.roundId)) {
        throw serviceError('GenerationRound ID 已存在', 409, 'GENERATION_ROUND_CONFLICT');
      }
      if (session.generationRounds.some(round => round.sourceMessageEventId === payload.sourceMessageEventId)) {
        throw serviceError('同一消息只能建立一个 GenerationRound', 409, 'GENERATION_ROUND_SOURCE_CONFLICT');
      }
      if (!session.messages.some(message => message.eventId === payload.sourceMessageEventId)) {
        throw serviceError('GenerationRound 来源消息不存在', 409, 'GENERATION_ROUND_SOURCE_CONFLICT');
      }
      const timestamp = now();
      session.generationRounds.push({
        roundId: payload.roundId,
        sessionId: session.id,
        sourceMessageEventId: payload.sourceMessageEventId,
        mode: payload.mode,
        status: 'planning',
        planRevision: 0,
        planHash: '',
        stages: [],
        items: [],
        failureSummary: '',
        recoverySummary: '',
        reconcileRequired: false,
        cancelReason: '',
        createdAt: timestamp,
        updatedAt: timestamp,
        committedAt: 0,
        approvedAt: 0,
        planArtifactVersionId: '',
        masterAuthorizationId: '',
        authorizationState: '',
        authorizationRequest: {},
        authorizationPreparedAt: 0,
        authorizedBy: '',
        authorizationConsumedAt: 0,
        settledAt: 0
      });
    });
    return roundMutationResult(result, payload.roundId);
  }

  function commitGenerationRound(sessionId, roundIdValue, input = {}) {
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const plan = normalizedGenerationPlan(input);
    const payload = { roundId, ...plan };
    const result = mutateSession(sessionId, input.requestId, 'commit-generation-round', payload, session => {
      const round = findGenerationRound(session, roundId);
      if (round.status !== 'planning') {
        throw serviceError('只有 planning 轮次可以锁定计划', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      if (plan.planRevision !== 1) {
        throw serviceError('首次锁定的生成计划版本必须为 1', 409, 'GENERATION_ROUND_PLAN_CONFLICT');
      }
      const timestamp = now();
      Object.assign(round, plan, {
        status: 'awaiting-approval',
        committedAt: timestamp,
        updatedAt: timestamp
      });
    });
    return roundMutationResult(result, roundId);
  }

  function approveGenerationRound(sessionId, roundIdValue, input = {}) {
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const payload = {
      roundId,
      planRevision: optionalNumber(input.planRevision, '批准计划版本', { integer: true, minimum: 1, maximum: 1_000_000 }),
      planHash: optionalHash(input.planHash, '批准计划摘要')
    };
    if (payload.planRevision === null || !payload.planHash) {
      throw serviceError('批准必须绑定计划版本和摘要', 400, 'INVALID_GENERATION_ROUND_APPROVAL');
    }
    const result = mutateSession(sessionId, input.requestId, 'approve-generation-round', payload, session => {
      const round = findGenerationRound(session, roundId);
      if (round.status !== 'awaiting-approval') {
        throw serviceError('当前轮次不能批准', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      if (round.planRevision !== payload.planRevision || round.planHash !== payload.planHash) {
        throw serviceError('批准的生成计划已漂移', 409, 'GENERATION_ROUND_PLAN_CONFLICT');
      }
      const timestamp = now();
      round.status = 'approved';
      round.approvedAt = timestamp;
      round.updatedAt = timestamp;
    });
    return roundMutationResult(result, roundId);
  }

  function cancelGenerationRound(sessionId, roundIdValue, input = {}) {
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const payload = { roundId, reason: plainText(input.reason, 2_000, '取消原因') };
    const result = mutateSession(sessionId, input.requestId, 'cancel-generation-round', payload, session => {
      const round = findGenerationRound(session, roundId);
      if (TERMINAL_GENERATION_ROUND_STATUSES.has(round.status)) {
        throw serviceError('终态 GenerationRound 不能再次取消', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      if (round.items.some(item => ['submitting', 'running', 'remote-unknown'].includes(item.status))) {
        throw serviceError('GenerationRound 存在尚未核对的远端任务，不能取消', 409, 'GENERATION_ROUND_CANCEL_BLOCKED');
      }
      const timestamp = now();
      round.items.forEach(item => {
        if (!TERMINAL_GENERATION_ITEM_STATUSES.has(item.status)) {
          item.status = 'cancelled';
          item.updatedAt = timestamp;
        }
      });
      round.status = 'cancelled';
      round.cancelReason = payload.reason;
      round.settledAt = timestamp;
      round.updatedAt = timestamp;
    });
    return roundMutationResult(result, roundId);
  }

  function normalizedGenerationRoundAuthorizationRequest(sessionId, roundId, input = {}) {
    const request = jsonSnapshot(input, 'Round 授权请求', 'object');
    if (request.agentSessionId !== sessionId || request.roundId !== roundId) {
      throw serviceError('Round 主授权不属于当前轮次', 409, 'ROUND_AUTHORIZATION_IDENTITY_CONFLICT');
    }
    const planRevision = optionalNumber(request.planRevision, 'Round 授权计划版本', { integer: true, minimum: 1, maximum: 1_000_000 });
    const planHash = optionalHash(request.planHash, 'Round 授权计划摘要');
    const planArtifactContentHash = optionalHash(request.planArtifactContentHash, 'Round 计划产物内容摘要');
    const totalQuantity = optionalNumber(request.totalQuantity, 'Round 授权总数量', { integer: true, minimum: 1, maximum: 2_000 });
    const estimatedCost = optionalNumber(request.estimatedCost, 'Round 授权预计费用', { maximum: 1_000_000_000 });
    const budgetLimit = optionalNumber(request.budgetLimit, 'Round 授权预算', { maximum: 1_000_000_000 });
    const currency = plainText(request.currency, 12, 'Round 授权币种', true).toUpperCase();
    const executionMode = enumValue(request.executionMode, new Set(['auto', 'manual']), 'Round 授权执行模式');
    if (planRevision === null || !planHash || !planArtifactContentHash || totalQuantity === null
      || estimatedCost === null || budgetLimit === null || budgetLimit < estimatedCost || !/^[A-Z]{3,8}$/.test(currency)) {
      throw serviceError('Round 主授权缺少精确计划或预算绑定', 400, 'INVALID_ROUND_AUTHORIZATION_REQUEST');
    }
    return {
      agentSessionId: sessionId,
      roundId,
      planRevision,
      planHash,
      planArtifactVersionId: identifier(request.planArtifactVersionId, 'Round 计划产物版本'),
      planArtifactContentHash,
      totalQuantity,
      estimatedCost,
      budgetLimit,
      currency,
      executionMode,
      reviewGateId: identifier(request.reviewGateId, 'Round 授权审核关')
    };
  }

  function prepareGenerationRoundAuthorization(sessionIdValue, roundIdValue, input = {}) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const authorizationRequest = normalizedGenerationRoundAuthorizationRequest(sessionId, roundId, input.authorizationRequest);
    const payload = { roundId, authorizationRequest };
    const result = mutateSession(sessionId, input.requestId, 'prepare-generation-round-authorization', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能准备 Round 授权', 409, 'SESSION_CANCELLED');
      const round = findGenerationRound(session, roundId);
      if (round.status !== 'awaiting-approval') {
        throw serviceError('当前 GenerationRound 不能准备主授权', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      if (round.planRevision !== authorizationRequest.planRevision || round.planHash !== authorizationRequest.planHash
        || round.items.length !== authorizationRequest.totalQuantity
        || (round.mode === 'automatic' ? 'auto' : 'manual') !== authorizationRequest.executionMode) {
        throw serviceError('Round 授权准备与锁定计划不一致', 409, 'ROUND_AUTHORIZATION_IDENTITY_CONFLICT');
      }
      if ((round.planArtifactVersionId && round.planArtifactVersionId !== authorizationRequest.planArtifactVersionId)
        || (round.authorizationState === 'prepared'
          && sha256(round.authorizationRequest) !== sha256(authorizationRequest))) {
        throw serviceError('GenerationRound 已准备另一条主授权', 409, 'ROUND_AUTHORIZATION_BINDING_CONFLICT');
      }
      round.planArtifactVersionId = authorizationRequest.planArtifactVersionId;
      round.authorizationRequest = authorizationRequest;
      round.authorizationState = 'prepared';
      if (!round.authorizationPreparedAt) round.authorizationPreparedAt = now();
      round.updatedAt = now();
    });
    return roundMutationResult(result, roundId);
  }

  function normalizedGenerationRoundAuthorization(sessionId, roundId, input = {}) {
    const authorization = jsonSnapshot(input.authorization, 'Round 授权回执', 'object');
    const request = normalizedGenerationRoundAuthorizationRequest(sessionId, roundId, authorization.request);
    const signature = optionalHash(authorization.signature, 'Round 授权签名');
    const consumedAt = optionalNumber(authorization.consumedAt, 'Round 授权消费时间', { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    if (authorization.authorizationType !== 'round-master' || !signature || consumedAt === null) {
      throw serviceError('只接受已消费的 Round 主授权回执', 400, 'INVALID_CONSUMED_ROUND_AUTHORIZATION');
    }
    return {
      authorizationId: identifier(authorization.authorizationId, 'Round 主授权 ID'),
      authorizationType: 'round-master',
      signature,
      authorizedBy: plainText(authorization.authorizedBy, 160, 'Round 授权人'),
      authorizedAt: optionalNumber(authorization.authorizedAt, 'Round 授权时间', { maximum: Number.MAX_SAFE_INTEGER }) ?? 0,
      consumedAt,
      request
    };
  }

  function commitGenerationRoundAuthorization(sessionIdValue, roundIdValue, input = {}) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const authorization = normalizedGenerationRoundAuthorization(sessionId, roundId, input);
    const payload = { roundId, authorization };
    const result = mutateSession(sessionId, input.requestId, 'commit-generation-round-authorization', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能记录 Round 授权', 409, 'SESSION_CANCELLED');
      const round = findGenerationRound(session, roundId);
      if (!['awaiting-approval', 'approved'].includes(round.status)) {
        throw serviceError('当前 GenerationRound 不能提交主授权', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      const request = authorization.request;
      if (!['prepared', 'consumed'].includes(round.authorizationState)
        || !round.authorizationRequest || sha256(round.authorizationRequest) !== sha256(request)) {
        throw serviceError('Round 主授权与消费前准备回执不一致', 409, 'ROUND_AUTHORIZATION_BINDING_CONFLICT');
      }
      if (round.planRevision !== request.planRevision || round.planHash !== request.planHash
        || round.items.length !== request.totalQuantity
        || (round.mode === 'automatic' ? 'auto' : 'manual') !== request.executionMode) {
        throw serviceError('Round 主授权与锁定计划不一致', 409, 'ROUND_AUTHORIZATION_IDENTITY_CONFLICT');
      }
      if ((round.masterAuthorizationId && round.masterAuthorizationId !== authorization.authorizationId)
        || (round.planArtifactVersionId && round.planArtifactVersionId !== request.planArtifactVersionId)) {
        throw serviceError('GenerationRound 已绑定另一条主授权', 409, 'ROUND_AUTHORIZATION_BINDING_CONFLICT');
      }
      const timestamp = now();
      round.status = 'approved';
      round.planArtifactVersionId = request.planArtifactVersionId;
      round.masterAuthorizationId = authorization.authorizationId;
      round.authorizationState = 'consumed';
      round.authorizedBy = authorization.authorizedBy;
      round.authorizationConsumedAt = authorization.consumedAt;
      if (!round.approvedAt) round.approvedAt = timestamp;
      round.updatedAt = timestamp;
    });
    return roundMutationResult(result, roundId);
  }

  function updateGenerationRoundStatus(sessionId, roundIdValue, input = {}) {
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const payload = {
      roundId,
      status: enumValue(input.status, GENERATION_ROUND_STATUSES, 'GenerationRound 状态'),
      failureSummary: hasOwn(input, 'failureSummary') ? plainText(input.failureSummary, 2_000, '轮次失败摘要') : null,
      recoverySummary: hasOwn(input, 'recoverySummary') ? plainText(input.recoverySummary, 2_000, '轮次恢复摘要') : null,
      reconcileRequired: hasOwn(input, 'reconcileRequired') ? booleanValue(input.reconcileRequired, '轮次核对标记') : null
    };
    if (['planning', 'awaiting-approval', 'approved', 'cancelled'].includes(payload.status)) {
      throw serviceError('该轮次状态必须使用专用操作', 400, 'INVALID_GENERATION_ROUND_TRANSITION');
    }
    const result = mutateSession(sessionId, input.requestId, 'update-generation-round-status', payload, session => {
      const round = findGenerationRound(session, roundId);
      if (TERMINAL_GENERATION_ROUND_STATUSES.has(round.status)) {
        if (round.status === payload.status) return;
        throw serviceError('终态 GenerationRound 不能重新进入活动状态', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      const planningFailure = round.status === 'planning' && payload.status === 'failed';
      if ((!COMMITTED_GENERATION_ROUND_STATUSES.has(round.status) || round.status === 'awaiting-approval') && !planningFailure) {
        throw serviceError('未批准的 GenerationRound 不能执行', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      if (payload.status === 'completed' && round.items.some(item => item.status !== 'succeeded')) {
        throw serviceError('存在未成功生成项时不能完成轮次', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      const timestamp = now();
      round.status = payload.status;
      if (payload.failureSummary !== null) round.failureSummary = payload.failureSummary;
      if (payload.recoverySummary !== null) round.recoverySummary = payload.recoverySummary;
      if (payload.reconcileRequired !== null) round.reconcileRequired = payload.reconcileRequired;
      if (TERMINAL_GENERATION_ROUND_STATUSES.has(payload.status)) round.settledAt = timestamp;
      round.updatedAt = timestamp;
    });
    return roundMutationResult(result, roundId);
  }

  function updateGenerationRoundItem(sessionId, roundIdValue, itemIdValue, input = {}) {
    const roundId = identifier(roundIdValue, 'GenerationRound ID');
    const itemId = identifier(itemIdValue, 'GenerationRound item ID');
    const payload = {
      roundId,
      itemId,
      status: hasOwn(input, 'status') ? enumValue(input.status, GENERATION_ITEM_STATUSES, '生成项状态') : '',
      toolRunId: hasOwn(input, 'toolRunId') ? optionalIdentifier(input.toolRunId, '生成项 ToolRun ID') : null,
      nodeId: hasOwn(input, 'nodeId') ? optionalIdentifier(input.nodeId, '生成项节点 ID') : null,
      operationId: hasOwn(input, 'operationId') ? optionalIdentifier(input.operationId, '生成项操作 ID') : null,
      inputHash: hasOwn(input, 'inputHash') ? optionalHash(input.inputHash, '生成项输入摘要') : null,
      remoteTaskId: hasOwn(input, 'remoteTaskId') ? plainText(input.remoteTaskId, 320, '生成项远端任务 ID') : null,
      error: hasOwn(input, 'error') ? plainText(input.error, 2_000, '生成项失败摘要') : null,
      reconcileRequired: hasOwn(input, 'reconcileRequired') ? booleanValue(input.reconcileRequired, '生成项核对标记') : null
    };
    if (!payload.status && GENERATION_ITEM_BINDING_FIELDS.every(field => payload[field] === null)
      && payload.error === null && payload.reconcileRequired === null) {
      throw serviceError('生成项更新内容不能为空', 400, 'INVALID_INPUT');
    }
    const result = mutateSession(sessionId, input.requestId, 'update-generation-round-item', payload, session => {
      const round = findGenerationRound(session, roundId);
      if (!COMMITTED_GENERATION_ROUND_STATUSES.has(round.status) || TERMINAL_GENERATION_ROUND_STATUSES.has(round.status)) {
        throw serviceError('当前 GenerationRound 不能更新生成项', 409, 'INVALID_GENERATION_ROUND_TRANSITION');
      }
      const item = round.items.find(candidate => candidate.itemId === itemId);
      if (!item) throw serviceError('GenerationRound item 不存在', 404, 'GENERATION_ROUND_ITEM_NOT_FOUND');
      if (payload.status && TERMINAL_GENERATION_ITEM_STATUSES.has(item.status) && payload.status !== item.status) {
        throw serviceError('终态生成项不能重新进入活动状态', 409, 'INVALID_GENERATION_ITEM_TRANSITION');
      }
      if (payload.status === 'planned' && item.status !== 'planned') {
        throw serviceError('生成项不能退回 planned', 409, 'INVALID_GENERATION_ITEM_TRANSITION');
      }
      for (const field of GENERATION_ITEM_BINDING_FIELDS) {
        if (payload[field] === null) continue;
        if (item[field] && payload[field] && item[field] !== payload[field]) {
          throw serviceError('生成项执行绑定不可更改', 409, 'IMMUTABLE_GENERATION_ITEM_BINDING');
        }
        if (payload[field]) item[field] = payload[field];
      }
      if (payload.status) item.status = payload.status;
      if (payload.error !== null) item.error = payload.error;
      if (payload.reconcileRequired !== null) item.reconcileRequired = payload.reconcileRequired;
      const timestamp = now();
      item.updatedAt = timestamp;
      reconcileGenerationRoundFromItems(round, timestamp);
    });
    return roundMutationResult(result, roundId);
  }

  function createSession(input = {}) {
    const requestId = identifier(input.requestId, 'requestId');
    const skillIdentity = normalizedSkillIdentity(input);
    const payload = {
      canvasId: identifier(input.canvasId, 'Canvas ID'),
      skillId: optionalIdentifier(input.skillId, 'Skill ID'),
      title: plainText(input.title, 160, '会话标题'),
      workspaceScope: workspaceScope(input.workspaceScope),
      mode: enumValue(input.mode, SESSION_MODES, 'AgentSession 模式', 'generation'),
      constraints: hasOwn(input, 'constraints') ? jsonSnapshot(input.constraints, '会话约束', 'object') : {},
      ...skillIdentity
    };
    const store = readStore();
    const receipt = checkedReceipt(store.createReceipts, requestId, 'create-session', payload);
    if (receipt) {
      const session = store.sessions.find(item => item.id === receipt.sessionId);
      if (!session) throw serviceError('幂等回执指向的 AgentSession 不存在', 500, 'CORRUPT_IDEMPOTENCY_RECEIPT');
      return { session: publicSession(session), idempotent: true };
    }

    const createdAt = now();
    const id = identifier(makeId('agent-session'), 'AgentSession ID');
    if (store.sessions.some(item => item.id === id)) throw serviceError('AgentSession ID 冲突', 409, 'AGENT_SESSION_ID_CONFLICT');
    const session = {
      schemaVersion: SCHEMA_VERSION,
      id,
      canvasId: payload.canvasId,
      skillId: payload.skillId,
      title: payload.title,
      workspaceScope: payload.workspaceScope,
      mode: payload.mode,
      skillRef: payload.skillRef,
      signedVersion: payload.signedVersion,
      declaredVersion: payload.declaredVersion,
      contentHash: payload.contentHash,
      publisher: payload.publisher,
      skillComposition: null,
      status: 'idle',
      messages: [],
      toolRuns: [],
      generationRounds: [],
      currentNodeRefs: [],
      detachedNodeRefs: [],
      composerDraft: '',
      attachmentRefs: [],
      unreadBoundary: '',
      currentPhase: '',
      plan: {},
      constraints: payload.constraints,
      safeBoundary: {},
      nextAction: '',
      approvals: [],
      executionAuthorizations: [],
      historyRefs: [],
      foundationArtifactRefs: [],
      legacyRunRefs: [],
      qaRefs: [],
      costRefs: [],
      finalDeliveryRef: '',
      lastHeartbeatAt: 0,
      recoveryStatus: 'clean',
      blockedReason: '',
      reconcileRequired: false,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      requestReceipts: {}
    };
    store.sessions.push(session);
    store.createReceipts[requestId] = {
      operation: 'create-session',
      payloadHash: payloadHash('create-session', payload),
      sessionId: id,
      recordedAt: createdAt
    };
    writeStore(store);
    return { session: publicSession(session), idempotent: false };
  }

  function listSessions(canvasIdValue) {
    const canvasId = canvasIdValue === undefined || canvasIdValue === null || String(canvasIdValue).trim() === ''
      ? ''
      : identifier(canvasIdValue, 'Canvas ID');
    return readStore().sessions
      .filter(session => !canvasId || session.canvasId === canvasId)
      .slice()
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .map(publicSession);
  }

  function loadSession(sessionIdValue) {
    const id = identifier(sessionIdValue, 'AgentSession ID');
    const session = readStore().sessions.find(item => item.id === id);
    return session ? publicSession(session) : null;
  }

  function renameSession(sessionId, input = {}) {
    const payload = { title: plainText(input.title, 160, '会话标题', true) };
    return mutateSession(sessionId, input.requestId, 'rename-session', payload, session => {
      session.title = payload.title;
    });
  }

  function deleteSession(sessionIdValue) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const store = readStore();
    const sessionIndex = store.sessions.findIndex(item => item.id === sessionId);
    if (sessionIndex < 0) return { deleted: false };
    if (store.sessions[sessionIndex].toolRuns.some(toolRun => DELETE_BLOCKING_TOOL_RUN_STATUSES.has(toolRun.status))) {
      throw serviceError('AgentSession 存在尚未核对的远端任务，不能删除', 409, 'SESSION_DELETE_BLOCKED');
    }

    store.sessions.splice(sessionIndex, 1);
    for (const [requestId, receipt] of Object.entries(store.createReceipts)) {
      if (receipt?.sessionId === sessionId) delete store.createReceipts[requestId];
    }
    writeStore(store);
    return { deleted: true };
  }

  function normalizedHistoryRef(source, eventId) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw serviceError('历史镜像引用不合法', 400, 'INVALID_HISTORY_REF');
    }
    const historyRef = {
      eventId: identifier(source.eventId, '历史 eventId'),
      artifactVersionId: identifier(source.artifactVersionId, '历史 Artifact 版本'),
      contentHash: optionalHash(source.contentHash, '历史内容摘要')
    };
    if (historyRef.eventId !== eventId || !historyRef.contentHash) {
      throw serviceError('历史镜像引用与 Session 事件不一致', 409, 'SESSION_HISTORY_REF_CONFLICT');
    }
    return historyRef;
  }

  function markMessageHistoryMirrored(sessionIdValue, eventIdValue, historyRefValue) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const eventId = identifier(eventIdValue, '消息事件 ID');
    const historyRef = normalizedHistoryRef(historyRefValue, eventId);
    const store = readStore();
    const session = findSession(store, sessionId);
    const message = session.messages.find(item => item.eventId === eventId);
    if (!message) throw serviceError('Session 消息不存在', 404, 'SESSION_MESSAGE_NOT_FOUND');
    if (message.historyMirror?.status === 'mirrored') {
      if (sha256(message.historyMirror.historyRef) !== sha256(historyRef)) {
        throw serviceError('Session 消息已绑定另一份历史', 409, 'SESSION_HISTORY_REF_CONFLICT');
      }
      return { session: publicSession(session), historyRef, idempotent: true };
    }
    if (message.historyMirror?.status !== 'pending') {
      throw serviceError('旧消息未纳入自动历史回灌', 409, 'SESSION_HISTORY_NOT_PENDING');
    }
    const existing = session.historyRefs.find(ref => ref && typeof ref === 'object' && ref.eventId === eventId);
    if (existing && sha256(existing) !== sha256(historyRef)) {
      throw serviceError('Session 历史引用发生冲突', 409, 'SESSION_HISTORY_REF_CONFLICT');
    }
    if (!existing) session.historyRefs.push(historyRef);
    message.historyMirror = { status: 'mirrored', historyRef };
    writeStore(store);
    return { session: publicSession(session), historyRef, idempotent: false };
  }

  function appendMessage(sessionId, input = {}) {
    const requestId = identifier(input.requestId, 'requestId');
    const attachments = Array.isArray(input.attachments) ? input.attachments.map(normalizedAttachment) : [];
    if (attachments.length > 20) throw serviceError('消息附件不能超过 20 个', 400, 'INVALID_INPUT');
    const role = enumValue(input.role, MESSAGE_ROLES, '消息角色');
    const payload = {
      eventId: optionalIdentifier(input.eventId, '消息事件 ID'),
      role,
      kind: enumValue(input.kind, MESSAGE_KINDS, '消息类型', 'text'),
      content: plainText(input.content, 60_000, '消息内容'),
      attachments,
      ...(input.structuredQuestion === undefined ? {} : { structuredQuestion: normalizedStructuredQuestion(input.structuredQuestion, role, input.kind || 'text') }),
      ...(input.structuredAnswer === undefined ? {} : { structuredAnswer: normalizedStructuredAnswer(input.structuredAnswer, role, input.kind || 'text') }),
      ...(input.modelBinding === undefined ? {} : { modelBinding: normalizedMessageModelBinding(input.modelBinding, role) })
    };
    if (payload.structuredQuestion && payload.structuredAnswer) throw serviceError('同一消息不能同时携带问题集和答案', 400, 'INVALID_STRUCTURED_INTERACTION');
    if (!payload.content && payload.attachments.length === 0) throw serviceError('消息内容和附件不能同时为空', 400, 'INVALID_INPUT');
    return mutateSession(sessionId, requestId, 'append-message', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能追加消息', 409, 'SESSION_CANCELLED');
      if (payload.eventId && session.messages.some(message => message.eventId === payload.eventId)) {
        throw serviceError('消息 eventId 已存在', 409, 'SESSION_EVENT_CONFLICT');
      }
      if (payload.structuredAnswer) assertStructuredAnswerMatchesSession(session, payload.structuredAnswer);
      const createdAt = now();
      const messageId = identifier(makeId('message'), '消息 ID');
      session.messages.push({
        id: messageId,
        ...payload,
        eventId: payload.eventId || messageId,
        requestId,
        createdAt,
        historyMirror: pendingHistoryMirror()
      });
      if (session.status === 'completed') session.status = 'collecting';
    });
  }

  function bindSkillComposition(sessionId, input = {}) {
    const composition = normalizedSkillComposition(input.composition);
    if (!composition) throw serviceError('Skill 组合不能为空', 400, 'INVALID_SKILL_COMPOSITION');
    const current = findSession(readStore(), sessionId);
    if (current.skillComposition) {
      const existing = normalizedSkillComposition(current.skillComposition, { persisted: true });
      const { boundAt: _boundAt, ...existingIdentity } = existing;
      if (sha256(existingIdentity) === sha256(composition)) {
        return { session: publicSession(current), idempotent: true };
      }
      throw serviceError('AgentSession 已绑定另一份 Skill 组合', 409, 'SESSION_SKILL_COMPOSITION_CONFLICT');
    }
    return mutateSession(sessionId, input.requestId, 'bind-skill-composition', { composition }, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能绑定 Skill 组合', 409, 'SESSION_CANCELLED');
      if (session.skillComposition) {
        const existing = normalizedSkillComposition(session.skillComposition, { persisted: true });
        const { boundAt: _boundAt, ...existingIdentity } = existing;
        if (sha256(existingIdentity) !== sha256(composition)) {
          throw serviceError('AgentSession 已绑定另一份 Skill 组合', 409, 'SESSION_SKILL_COMPOSITION_CONFLICT');
        }
        return;
      }
      if (session.skillId && session.skillId !== composition.primary.id) {
        throw serviceError('所选 Skill 与 AgentSession 固定身份不一致', 409, 'SESSION_SKILL_COMPOSITION_CONFLICT');
      }
      const fixedIdentity = {
        declaredVersion: composition.primary.declaredVersion,
        contentHash: composition.primary.contentHash,
        publisher: composition.primary.publisher
      };
      for (const [key, value] of Object.entries(fixedIdentity)) {
        if (session[key] && session[key] !== value) {
          throw serviceError('AgentSession 固定的 Skill 身份与组合不一致', 409, 'SESSION_SKILL_COMPOSITION_CONFLICT');
        }
      }
      session.skillId = composition.primary.id;
      Object.assign(session, fixedIdentity);
      session.skillComposition = { ...composition, boundAt: now() };
    });
  }

  function setStatus(sessionId, input = {}) {
    const payload = { status: enumValue(input.status, SESSION_STATUSES, 'AgentSession 状态') };
    const textFields = {
      currentPhase: [160, '当前阶段'],
      nextAction: [2_000, '下一动作'],
      composerDraft: [60_000, '输入草稿'],
      unreadBoundary: [240, '未读边界'],
      recoveryStatus: [160, '恢复状态'],
      blockedReason: [2_000, '阻塞原因']
    };
    for (const [key, [limit, label]] of Object.entries(textFields)) {
      if (hasOwn(input, key)) payload[key] = plainText(input[key], limit, label);
    }
    for (const [key, shape] of Object.entries(SNAPSHOT_FIELDS)) {
      if (hasOwn(input, key)) payload[key] = jsonSnapshot(input[key], key, shape);
    }
    if (hasOwn(input, 'lastHeartbeatAt')) {
      payload.lastHeartbeatAt = optionalNumber(input.lastHeartbeatAt, '最后心跳时间', { maximum: Number.MAX_SAFE_INTEGER }) ?? 0;
    }
    if (hasOwn(input, 'reconcileRequired')) payload.reconcileRequired = booleanValue(input.reconcileRequired, '是否需要核对');
    return mutateSession(sessionId, input.requestId, 'set-status', payload, session => {
      if (TERMINAL_SESSION_STATUSES.has(session.status) && session.status !== payload.status) {
        throw serviceError('终态 AgentSession 不能重新进入活动状态', 409, 'INVALID_SESSION_TRANSITION');
      }
      Object.assign(session, payload);
    });
  }

  function normalizedExecutionAuthorization(sessionId, toolRunId, input = {}) {
    const authorization = jsonSnapshot(input.authorization, '执行授权回执', 'object');
    const consumedAt = Number(authorization.consumedAt);
    if (authorization.allowed !== true || !Number.isFinite(consumedAt) || consumedAt <= 0) {
      throw serviceError('只接受已消费的付费授权回执', 400, 'INVALID_CONSUMED_AUTHORIZATION');
    }
    const request = jsonSnapshot(authorization.request, '授权请求', 'object');
    if (request.agentSessionId !== sessionId) throw serviceError('付费授权不属于当前 AgentSession', 409, 'AUTHORIZATION_SESSION_CONFLICT');
    if (request.toolRunId !== toolRunId) throw serviceError('付费授权不属于当前 toolRun', 409, 'AUTHORIZATION_TOOL_RUN_CONFLICT');
    const requiredIds = ['operationId', 'provider', 'model', 'agentSessionId', 'toolRunId', 'nodeId', 'taskKind'];
    try { requiredIds.forEach(field => identifier(request[field], `授权 ${field}`)); }
    catch (error) { throw serviceError(error.message, 400, 'INVALID_CONSUMED_AUTHORIZATION'); }
    const inputHash = optionalHash(request.inputHash, '授权输入摘要');
    const signature = optionalHash(authorization.signature, '授权签名');
    const inputVersionIds = Array.isArray(request.inputVersionIds) ? request.inputVersionIds : [];
    if (!inputHash || !signature || !inputVersionIds.length || inputVersionIds.some(value => !optionalIdentifier(value, '授权输入版本'))
      || !Number.isInteger(Number(request.quantity)) || Number(request.quantity) < 1
      || !Number.isFinite(Number(request.estimatedCost)) || Number(request.estimatedCost) < 0
      || !Number.isFinite(Number(request.budgetLimit)) || Number(request.budgetLimit) < Number(request.estimatedCost)
      || !Number.isInteger(Number(request.retryLimit)) || Number(request.retryLimit) < 0
      || request.allowFallback !== false) {
      throw serviceError('付费授权回执缺少精确执行绑定', 400, 'INVALID_CONSUMED_AUTHORIZATION');
    }
    return {
      source: 'execution-guard',
      allowed: true,
      authorizationId: identifier(authorization.authorizationId, '付费授权 ID'),
      signature,
      authorizedBy: plainText(authorization.authorizedBy, 160, '授权人'),
      authorizedAt: optionalNumber(authorization.authorizedAt, '授权时间', { maximum: Number.MAX_SAFE_INTEGER }) ?? 0,
      consumedAt,
      request
    };
  }

  function assertAuthorizationMatchesToolRun(authorization, toolRun) {
    const request = authorization.request;
    const matches = toolRun
      && toolRun.type === `native-${request.taskKind}`
      && toolRun.nodeId === request.nodeId
      && toolRun.provider === request.provider
      && toolRun.model === request.model
      && toolRun.operationId === request.operationId
      && toolRun.inputHash === request.inputHash
      && request.inputVersionIds.includes(toolRun.inputVersion)
      && Number(toolRun.quantity) === Number(request.quantity)
      && Number(toolRun.estimatedCost) === Number(request.estimatedCost)
      && Number(toolRun.approvedBudget) === Number(request.budgetLimit)
      && Number(toolRun.retryBudget) === Number(request.retryLimit)
      && String(toolRun.currency || 'CNY') === String(request.currency || 'CNY');
    if (!matches) throw serviceError('付费授权与 toolRun 精确执行绑定不一致', 409, 'AUTHORIZATION_BINDING_CONFLICT');
  }

  function commitExecutionAuthorization(sessionIdValue, toolRunIdValue, input = {}) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const toolRunId = identifier(toolRunIdValue, 'Tool Run ID');
    const authorization = normalizedExecutionAuthorization(sessionId, toolRunId, input);
    return mutateSession(sessionId, input.requestId, 'commit-execution-authorization', { toolRunId, authorization }, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能记录付费授权', 409, 'SESSION_CANCELLED');
      const toolRun = session.toolRuns.find(item => item.id === toolRunId);
      assertAuthorizationMatchesToolRun(authorization, toolRun);
      if (!['awaiting-approval', 'queued'].includes(toolRun.status)) {
        throw serviceError('toolRun 当前状态不能提交付费授权', 409, 'INVALID_TOOL_RUN_TRANSITION');
      }
      const existing = session.executionAuthorizations.find(item => item.authorizationId === authorization.authorizationId);
      if (existing && sha256(existing) !== sha256(authorization)) {
        throw serviceError('同一付费授权 ID 的回执内容不一致', 409, 'AUTHORIZATION_BINDING_CONFLICT');
      }
      const boundElsewhere = session.executionAuthorizations.find(item => item.request?.toolRunId === toolRunId && item.authorizationId !== authorization.authorizationId);
      if (boundElsewhere || (toolRun.authorizationId && toolRun.authorizationId !== authorization.authorizationId)) {
        throw serviceError('toolRun 已绑定另一条付费授权', 409, 'AUTHORIZATION_BINDING_CONFLICT');
      }
      if (!existing) session.executionAuthorizations.push(authorization);
      toolRun.authorizationId = authorization.authorizationId;
      toolRun.authorizationState = 'consumed';
      toolRun.status = 'queued';
      toolRun.updatedAt = now();
    });
  }

  function upsertToolRun(sessionId, toolRunIdValue, input = {}) {
    const toolRunId = identifier(toolRunIdValue, 'Tool Run ID');
    const payload = {
      toolRunId,
      type: optionalIdentifier(input.type, '工具类型'),
      status: input.status === undefined || input.status === null || String(input.status).trim() === ''
        ? ''
        : enumValue(input.status, TOOL_RUN_STATUSES, '工具任务状态'),
      nodeId: optionalIdentifier(input.nodeId, '节点 ID'),
      provider: plainText(input.provider, 160, 'Provider'),
      model: plainText(input.model, 240, '模型'),
      operationId: plainText(input.operationId, 240, '操作 ID'),
      inputVersion: plainText(input.inputVersion, 160, '输入版本'),
      inputHash: optionalHash(input.inputHash, '输入摘要'),
      quantity: optionalNumber(input.quantity, '生成数量', { integer: true, maximum: 1_000 }),
      estimatedCost: optionalNumber(input.estimatedCost, '预估费用', { maximum: 1_000_000_000 }),
      approvedBudget: optionalNumber(input.approvedBudget, '批准预算', { maximum: 1_000_000_000 }),
      retryBudget: optionalNumber(input.retryBudget, '重试预算', { integer: true, maximum: 100 }),
      attempt: optionalNumber(input.attempt, '执行次数', { integer: true, maximum: 1_000 }),
      currency: input.currency === undefined || input.currency === null || String(input.currency).trim() === ''
        ? ''
        : plainText(input.currency, 12, '币种', true).toUpperCase(),
      executionPayload: hasOwn(input, 'executionPayload') ? jsonSnapshot(input.executionPayload, 'Provider 执行载荷', 'object') : null,
      inputRefs: hasOwn(input, 'inputRefs') ? jsonSnapshot(input.inputRefs, '输入引用', 'array') : null,
      remoteTaskId: plainText(input.remoteTaskId, 320, '远端任务 ID'),
      error: plainText(input.error, 500, '工具错误')
    };
    return mutateSession(sessionId, input.requestId, 'upsert-tool-run', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能执行工具任务', 409, 'SESSION_CANCELLED');
      const existing = session.toolRuns.find(item => item.id === toolRunId);
      const nextStatus = payload.status || existing?.status || 'queued';
      if (existing && TERMINAL_TOOL_RUN_STATUSES.has(existing.status) && existing.status !== nextStatus) {
        throw serviceError('终态工具任务不能重新进入活动状态', 409, 'INVALID_TOOL_RUN_TRANSITION');
      }
      if (!existing && !payload.type) throw serviceError('新工具任务必须提供类型', 400, 'INVALID_INPUT');
      if (existing && (LOCKED_TOOL_STATUSES.has(existing.status) || existing.authorizationState === 'consumed')) {
        for (const field of EXECUTION_BINDING_FIELDS) {
          if (payload[field] && payload[field] !== existing[field]) {
            throw serviceError('已提交任务的 Provider、模型和输入绑定不可更改', 409, 'IMMUTABLE_EXECUTION_BINDING');
          }
        }
        if (payload.executionPayload && sha256(payload.executionPayload) !== sha256(existing.executionPayload || {})) {
          throw serviceError('已提交任务的 Provider 执行载荷不可更改', 409, 'IMMUTABLE_EXECUTION_BINDING');
        }
        if (payload.inputRefs && sha256(payload.inputRefs) !== sha256(existing.inputRefs || [])) {
          throw serviceError('已提交任务的输入引用不可更改', 409, 'IMMUTABLE_EXECUTION_BINDING');
        }
      }

      const candidate = {
        id: toolRunId,
        type: payload.type || existing?.type || '',
        status: nextStatus,
        nodeId: payload.nodeId || existing?.nodeId || '',
        provider: payload.provider || existing?.provider || '',
        model: payload.model || existing?.model || '',
        operationId: payload.operationId || existing?.operationId || '',
        inputVersion: payload.inputVersion || existing?.inputVersion || '',
        inputHash: payload.inputHash || existing?.inputHash || '',
        quantity: payload.quantity ?? existing?.quantity ?? 0,
        estimatedCost: payload.estimatedCost ?? existing?.estimatedCost ?? 0,
        approvedBudget: payload.approvedBudget ?? existing?.approvedBudget ?? 0,
        retryBudget: payload.retryBudget ?? existing?.retryBudget ?? 0,
        attempt: payload.attempt ?? existing?.attempt ?? 0,
        currency: payload.currency || existing?.currency || 'CNY',
        executionPayload: payload.executionPayload || existing?.executionPayload || {},
        inputRefs: payload.inputRefs || existing?.inputRefs || [],
        remoteTaskId: payload.remoteTaskId || existing?.remoteTaskId || '',
        authorizationId: existing?.authorizationId || '',
        authorizationState: existing?.authorizationState || '',
        error: payload.error || existing?.error || ''
      };
      if (candidate.approvedBudget < candidate.estimatedCost) {
        throw serviceError('批准预算不能低于预估费用', 400, 'APPROVED_BUDGET_TOO_LOW');
      }
      if (candidate.status === 'awaiting-approval' && candidate.remoteTaskId) {
        throw serviceError('等待付费确认时不能已有远端任务 ID', 400, 'REMOTE_TASK_BEFORE_APPROVAL');
      }
      if (session.skillRef && ['submitting', 'running', 'remote-unknown'].includes(candidate.status)) {
        const missingBinding = EXECUTION_BINDING_FIELDS.some(field => !candidate[field]) || candidate.quantity < 1;
        if (missingBinding) throw serviceError('签名 Skill 提交任务前必须锁定 Provider、模型、操作和输入', 400, 'MISSING_EXECUTION_BINDING');
      }

      const updatedAt = now();
      if (!existing) {
        const created = {
          ...candidate,
          createdAt: updatedAt,
          updatedAt,
          startedAt: ['submitting', 'running'].includes(candidate.status) ? updatedAt : 0,
          settledAt: TERMINAL_TOOL_RUN_STATUSES.has(candidate.status) ? updatedAt : 0
        };
        session.toolRuns.push(created);
        projectToolRunToGenerationRound(session, created, updatedAt);
        return;
      }
      Object.assign(existing, candidate);
      if (!existing.startedAt && ['submitting', 'running'].includes(candidate.status)) existing.startedAt = updatedAt;
      if (TERMINAL_TOOL_RUN_STATUSES.has(candidate.status) && !existing.settledAt) existing.settledAt = updatedAt;
      existing.updatedAt = updatedAt;
      projectToolRunToGenerationRound(session, existing, updatedAt);
    });
  }

  function commitLocalToolWorksetAction(sessionId, input = {}) {
    const action = enumValue(input.action, LOCAL_WORKSET_ACTIONS, '本地工具动作');
    const payload = {
      action,
      toolRunId: identifier(input.toolRunId, '本地工具 ToolRun ID'),
      nodeId: identifier(input.nodeId, '本地工具节点 ID'),
      eventId: identifier(input.eventId, '本地工具消息事件 ID')
    };
    if (action === 'establish-smart-edit') {
      const sourceNodeIds = Array.isArray(input.sourceNodeIds)
        ? input.sourceNodeIds.map((value, index) => identifier(value, `来源节点 ${index + 1}`))
        : [];
      if (!sourceNodeIds.length || sourceNodeIds.length > 4 || new Set(sourceNodeIds).size !== sourceNodeIds.length) {
        throw serviceError('智能剪辑只接受一个至四个不重复来源节点', 400, 'AGENT_LOCAL_SOURCE_INVALID');
      }
      payload.sourceNodeIds = sourceNodeIds;
    } else {
      payload.smartEditNodeId = identifier(input.smartEditNodeId, '智能剪辑节点 ID');
      payload.exportId = identifier(input.exportId, '本地导出 ID');
      payload.exportPlan = normalizeLocalExportPlan(input.exportPlan);
    }

    return mutateSession(sessionId, input.requestId, 'commit-local-tool-workset-action', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能建立本地工具工作集', 409, 'SESSION_CANCELLED');
      if (session.workspaceScope !== 'canvas-agent') {
        throw serviceError('本地工具只能属于画布 AGENT 工作区', 409, 'INVALID_WORKSPACE_SCOPE');
      }
      if (session.toolRuns.some(item => item.id === payload.toolRunId)
        || session.currentNodeRefs.some(item => item.nodeId === payload.nodeId)
        || session.messages.some(item => item.eventId === payload.eventId)) {
        throw serviceError('本地工具身份已被其他动作占用', 409, 'AGENT_LOCAL_IDENTITY_CONFLICT');
      }
      if (action === 'prepare-canvas-export' && session.toolRuns.some(item => item.type === 'canvas-local-video-export'
        && item.operationId === payload.exportId)) {
        throw serviceError('本地导出 ID 已绑定既有输出；请恢复原任务，不要重复建立节点', 409, 'AGENT_LOCAL_EXPORT_EXISTS');
      }
      if (!verifyLocalWorksetSources) {
        throw serviceError('本地工具来源验证端口不可用', 503, 'AGENT_LOCAL_SOURCE_VERIFIER_UNAVAILABLE');
      }

      let sourceRefs;
      let sourceToolRef = null;
      let sourceToolRun = null;
      if (action === 'establish-smart-edit') {
        sourceRefs = payload.sourceNodeIds.map(nodeId => {
          const ref = session.currentNodeRefs.find(item => item.nodeId === nodeId);
          const kind = String(ref?.kind || '');
          const run = ref && session.toolRuns.find(item => item.id === ref.toolRunId && item.nodeId === nodeId);
          const allowedType = kind === 'video'
            ? ['native-video', 'canvas-local-video-export'].includes(run?.type)
            : kind === 'audio' && run?.type === 'native-audio';
          if (!ref || ref.workspaceScope !== 'canvas-agent' || !['video', 'audio'].includes(kind)
            || !run || !allowedType || run.status !== 'succeeded') {
            throw serviceError('来源必须是当前 AgentSession 已成功的视频或音频节点', 409, 'AGENT_LOCAL_SOURCE_INVALID');
          }
          return clone(ref);
        });
        const videoCount = sourceRefs.filter(ref => ref.kind === 'video').length;
        const audioCount = sourceRefs.filter(ref => ref.kind === 'audio').length;
        if (videoCount < 1 || videoCount > 3 || audioCount > 1) {
          throw serviceError('首版智能剪辑只接受一至三个视频和至多一条音频', 409, 'AGENT_LOCAL_SOURCE_INVALID');
        }
      } else {
        sourceToolRef = session.currentNodeRefs.find(item => item.nodeId === payload.smartEditNodeId);
        sourceToolRun = sourceToolRef && session.toolRuns.find(item => item.id === sourceToolRef.toolRunId
          && item.nodeId === payload.smartEditNodeId);
        if (!sourceToolRef || sourceToolRef.workspaceScope !== 'canvas-agent' || sourceToolRef.kind !== 'tool'
          || sourceToolRef.nodeRole !== 'smart-edit-workbench' || !sourceToolRun
          || sourceToolRun.type !== 'canvas-smart-edit' || sourceToolRun.status !== 'succeeded') {
          throw serviceError('画布导出必须来自当前 AgentSession 已建立的智能剪辑工具', 409, 'AGENT_LOCAL_SOURCE_INVALID');
        }
        sourceRefs = clone(sourceToolRun.inputRefs || []);
        const videoNodeIds = new Set(sourceRefs.filter(ref => ref.kind === 'video').map(ref => ref.nodeId));
        const audioNodeIds = new Set(sourceRefs.filter(ref => ref.kind === 'audio').map(ref => ref.nodeId));
        if (payload.exportPlan.clips.some(clip => !videoNodeIds.has(clip.nodeId))
          || (payload.exportPlan.bgm && !audioNodeIds.has(payload.exportPlan.bgm.nodeId))) {
          throw serviceError('本地导出计划只能引用智能剪辑已锁定的视频和音频来源', 409, 'AGENT_LOCAL_EXPORT_PLAN_INVALID');
        }
      }

      const verifiedRaw = verifyLocalWorksetSources({
        action,
        session: publicSession(session),
        sourceRefs: clone(sourceRefs),
        sourceToolRef: sourceToolRef ? clone(sourceToolRef) : null,
        sourceToolRun: sourceToolRun ? clone(sourceToolRun) : null
      });
      if (!Array.isArray(verifiedRaw) || verifiedRaw.length !== sourceRefs.length) {
        throw serviceError('本地工具来源验证结果不完整', 409, 'AGENT_LOCAL_SOURCE_INVALID');
      }
      const verifiedRefs = verifiedRaw.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw serviceError('本地工具来源验证结果不合法', 409, 'AGENT_LOCAL_SOURCE_INVALID');
        }
        const expected = sourceRefs[index];
        const verified = {
          nodeId: identifier(value.nodeId, `已验证来源 ${index + 1} 节点 ID`),
          kind: enumValue(value.kind, new Set(['video', 'audio']), `已验证来源 ${index + 1} 类型`),
          toolRunId: identifier(value.toolRunId, `已验证来源 ${index + 1} ToolRun ID`),
          url: plainText(value.url, 500, `已验证来源 ${index + 1} URL`, true),
          contentHash: optionalHash(value.contentHash, `已验证来源 ${index + 1}摘要`),
          byteLength: optionalNumber(value.byteLength, `已验证来源 ${index + 1}字节数`, { integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
        };
        if (verified.nodeId !== expected.nodeId || verified.kind !== expected.kind
          || verified.toolRunId !== expected.toolRunId || !verified.contentHash || verified.byteLength === null
          || (expected.contentHash && verified.contentHash !== expected.contentHash)
          || (expected.byteLength && verified.byteLength !== expected.byteLength)
          || !/^\/canvas-output\/[A-Za-z0-9._%()-]+$/.test(verified.url)) {
          throw serviceError('本地工具来源身份或本地文件不可信', 409, 'AGENT_LOCAL_SOURCE_INVALID');
        }
        return verified;
      });

      const timestamp = now();
      const isSmartEdit = action === 'establish-smart-edit';
      const toolRun = {
        id: payload.toolRunId,
        type: isSmartEdit ? 'canvas-smart-edit' : 'canvas-local-video-export',
        status: isSmartEdit ? 'succeeded' : 'queued',
        nodeId: payload.nodeId,
        provider: 'local',
        model: 'ffmpeg-timeline',
        operationId: isSmartEdit ? payload.toolRunId : payload.exportId,
        inputVersion: isSmartEdit ? 'canvas-smart-edit-v1' : 'canvas-local-video-export-v1',
        inputHash: sha256({
          action,
          sourceToolNodeId: payload.smartEditNodeId || '',
          sourceToolRunId: sourceToolRun?.id || '',
          exportPlan: payload.exportPlan || null,
          inputRefs: verifiedRefs
        }),
        quantity: 1,
        estimatedCost: 0,
        approvedBudget: 0,
        retryBudget: 0,
        attempt: 0,
        currency: 'CNY',
        executionPayload: isSmartEdit
          ? { sourceNodeIds: payload.sourceNodeIds }
          : { exportId: payload.exportId, smartEditNodeId: payload.smartEditNodeId, exportPlan: payload.exportPlan },
        inputRefs: verifiedRefs,
        remoteTaskId: '',
        authorizationId: '',
        authorizationState: '',
        error: '',
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: isSmartEdit ? timestamp : 0,
        settledAt: isSmartEdit ? timestamp : 0
      };
      session.toolRuns.push(toolRun);
      session.currentNodeRefs.push({
        nodeId: payload.nodeId,
        workspaceScope: 'canvas-agent',
        kind: isSmartEdit ? 'tool' : 'video',
        role: isSmartEdit ? 'smart-edit-workbench' : 'local-video-export',
        nodeRole: isSmartEdit ? 'smart-edit-workbench' : 'local-video-export',
        toolRunId: payload.toolRunId,
        assetVersionId: '',
        parentNodeRef: isSmartEdit ? '' : payload.smartEditNodeId,
        branchRootRef: '',
        supersedesRef: '',
        finalDelivery: false,
        attachedAt: timestamp
      });
      const messageId = identifier(makeId('message'), '消息 ID');
      session.messages.push({
        id: messageId,
        eventId: payload.eventId,
        requestId: identifier(input.requestId, 'requestId'),
        role: 'assistant',
        kind: 'tool-status',
        content: isSmartEdit ? '已建立本地智能剪辑工作集。' : '已创建本地视频导出占位，等待合成。',
        attachments: [{
          assetId: payload.nodeId,
          kind: isSmartEdit ? 'agent-local-tool' : 'agent-local-video',
          name: isSmartEdit ? '智能剪辑' : '本地视频导出',
          mimeType: isSmartEdit ? '' : 'video/mp4'
        }],
        createdAt: timestamp,
        historyMirror: pendingHistoryMirror()
      });
    });
  }

  function attachCurrentNode(sessionId, nodeIdValue, input = {}) {
    const nodeId = identifier(nodeIdValue, '节点 ID');
    const nodeRole = optionalIdentifier(input.nodeRole || input.role, '节点角色');
    const payload = {
      nodeId,
      workspaceScope: workspaceScope(input.workspaceScope),
      kind: optionalIdentifier(input.kind || 'artifact', '节点类型'),
      role: nodeRole,
      nodeRole,
      toolRunId: optionalIdentifier(input.toolRunId, 'Tool Run ID'),
      assetVersionId: optionalIdentifier(input.assetVersionId, 'Asset Version ID'),
      parentNodeRef: optionalIdentifier(input.parentNodeRef, '父节点引用'),
      branchRootRef: optionalIdentifier(input.branchRootRef, '分支根引用'),
      supersedesRef: optionalIdentifier(input.supersedesRef, '替代节点引用'),
      finalDelivery: booleanValue(input.finalDelivery, '最终交付标记'),
      hasFinalDelivery: hasOwn(input, 'finalDelivery'),
      finalDeliveryRef: optionalIdentifier(input.finalDeliveryRef, '最终交付引用')
    };
    return mutateSession(sessionId, input.requestId, 'attach-current-node', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能添加当前节点', 409, 'SESSION_CANCELLED');
      const existing = session.currentNodeRefs.find(item => item.nodeId === nodeId);
      if (existing) {
        existing.workspaceScope = payload.workspaceScope;
        existing.kind = payload.kind || existing.kind;
        existing.role = payload.nodeRole || existing.role;
        existing.nodeRole = payload.nodeRole || existing.nodeRole;
        if (payload.toolRunId) existing.toolRunId = payload.toolRunId;
        if (payload.assetVersionId) existing.assetVersionId = payload.assetVersionId;
        if (payload.parentNodeRef) existing.parentNodeRef = payload.parentNodeRef;
        if (payload.branchRootRef) existing.branchRootRef = payload.branchRootRef;
        if (payload.supersedesRef) existing.supersedesRef = payload.supersedesRef;
        if (payload.hasFinalDelivery) existing.finalDelivery = payload.finalDelivery;
      } else {
        session.currentNodeRefs.push({
          nodeId: payload.nodeId,
          workspaceScope: payload.workspaceScope,
          kind: payload.kind,
          role: payload.nodeRole,
          nodeRole: payload.nodeRole,
          toolRunId: payload.toolRunId,
          assetVersionId: payload.assetVersionId,
          parentNodeRef: payload.parentNodeRef,
          branchRootRef: payload.branchRootRef,
          supersedesRef: payload.supersedesRef,
          finalDelivery: payload.finalDelivery,
          attachedAt: now()
        });
      }
      if (payload.finalDelivery) session.finalDeliveryRef = payload.finalDeliveryRef || nodeId;
      if (payload.hasFinalDelivery && !payload.finalDelivery && session.finalDeliveryRef === nodeId) session.finalDeliveryRef = '';
    });
  }

  function detachCurrentNode(sessionId, nodeIdValue, input = {}) {
    const nodeId = identifier(nodeIdValue, '节点 ID');
    const payload = { nodeId };
    return mutateSession(sessionId, input.requestId, 'detach-current-node', payload, session => {
      if (session.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能移除当前节点', 409, 'SESSION_CANCELLED');
      const existing = session.currentNodeRefs.find(item => item.nodeId === nodeId);
      if (existing && !session.detachedNodeRefs.some(item => item.nodeId === nodeId)) {
        session.detachedNodeRefs.push({ ...clone(existing), detachedAt: now() });
      }
      session.currentNodeRefs = session.currentNodeRefs.filter(item => item.nodeId !== nodeId);
      if (session.finalDeliveryRef === nodeId) session.finalDeliveryRef = '';
    });
  }

  return Object.freeze({
    createSession,
    listSessions,
    loadSession,
    renameSession,
    deleteSession,
    appendMessage,
    bindSkillComposition,
    markMessageHistoryMirrored,
    setStatus,
    createGenerationRound,
    commitGenerationRound,
    approveGenerationRound,
    cancelGenerationRound,
    prepareGenerationRoundAuthorization,
    commitGenerationRoundAuthorization,
    updateGenerationRoundStatus,
    updateGenerationRoundItem,
    commitExecutionAuthorization,
    upsertToolRun,
    commitLocalToolWorksetAction,
    attachCurrentNode,
    detachCurrentNode,
    roots: Object.freeze({ stateRoot, storePath })
  });
}

module.exports = { createAgentSessionService };
