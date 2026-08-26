'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { normalizeGenerationPlan } = require('./agentGenerationRoundService');

const BLOCKED_PROTOCOLS = new Set(['codex', 'gemini-cli', 'jimeng', 'runninghub']);
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const MEDIA_TOOL_NAMES = new Map([['create_image', 'image'], ['create_video', 'video'], ['create_audio', 'audio']]);
const STRUCTURED_QUESTION_TOOL_NAME = 'ask_user_questions';
const STRUCTURED_QUESTION_TOOL = Object.freeze({
  type: 'function',
  function: Object.freeze({
    name: STRUCTURED_QUESTION_TOOL_NAME,
    description: '当继续创作前确实需要用户补充或确认信息时，在持续聊天右栏显示 1 至 5 道可交互问题。不得用 Markdown 选项冒充此工具。',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['title', 'questions']),
      properties: Object.freeze({
        title: Object.freeze({ type: 'string' }),
        submit_label: Object.freeze({ type: 'string' }),
        questions: Object.freeze({
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: Object.freeze({
            type: 'object',
            additionalProperties: false,
            required: Object.freeze(['question_id', 'title', 'prompt', 'type', 'required']),
            properties: Object.freeze({
              question_id: Object.freeze({ type: 'string' }),
              title: Object.freeze({ type: 'string' }),
              prompt: Object.freeze({ type: 'string' }),
              type: Object.freeze({ type: 'string', enum: Object.freeze(['single', 'multiple', 'text']) }),
              required: Object.freeze({ type: 'boolean' }),
              allow_custom: Object.freeze({ type: 'boolean' }),
              placeholder: Object.freeze({ type: 'string' }),
              choices: Object.freeze({
                type: 'array',
                maxItems: 8,
                items: Object.freeze({
                  type: 'object',
                  additionalProperties: false,
                  required: Object.freeze(['value', 'label']),
                  properties: Object.freeze({
                    value: Object.freeze({ type: 'string' }),
                    label: Object.freeze({ type: 'string' }),
                    description: Object.freeze({ type: 'string' })
                  })
                })
              })
            })
          })
        })
      })
    })
  })
});
const MEDIA_PLAN_TOOL_NAME = 'plan_media_generation';
const MEDIA_PLAN_TOOL = Object.freeze({
  type: 'function',
  function: Object.freeze({
    name: MEDIA_PLAN_TOOL_NAME,
    description: '把用户本轮要求的全部图片、视频和明确要求的音频输出组成一个完整计划。每个输出都必须是一个独立 item；图片或视频 item 必须在 depends_on 中直接列全当前镜头实际需要的资产图、分镜图、逐镜图和首尾帧；不要提供 Provider、模型、规格或数量字段。',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['items']),
      properties: Object.freeze({
        items: Object.freeze({
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          items: Object.freeze({
            type: 'object',
            additionalProperties: false,
            required: Object.freeze(['item_id', 'stage_id', 'kind', 'prompt']),
            properties: Object.freeze({
              item_id: Object.freeze({ type: 'string', description: '本轮内稳定且唯一的 item ID' }),
              stage_id: Object.freeze({ type: 'string', description: '本轮内稳定的阶段 ID' }),
              kind: Object.freeze({ type: 'string', enum: Object.freeze(['image', 'video', 'audio']) }),
              prompt: Object.freeze({ type: 'string' }),
              depends_on: Object.freeze({
                type: 'array',
                description: '当前 item 的媒体依赖。执行层先按 first_frame、last_frame，再按 item_id 排序直接图片依赖，并逐层补入未重复的传递图片依赖；prompt 中的 @图片N 必须严格对应这个顺序。',
                items: Object.freeze({
                  type: 'object',
                  additionalProperties: false,
                  required: Object.freeze(['item_id']),
                  properties: Object.freeze({
                    item_id: Object.freeze({ type: 'string' }),
                    role: Object.freeze({ type: 'string', description: '准确用途，例如 first_frame、last_frame、product、character、scene、storyboard 或 reference' })
                  })
                })
              }),
              use_selected_image: Object.freeze({ type: 'boolean' })
            })
          })
        })
      })
    })
  })
});
const LEGACY_MEDIA_TOOLS = [...MEDIA_TOOL_NAMES.keys()].map(name => {
  const properties = {
    prompt: Object.freeze({ type: 'string', description: '交给媒体模型的完整生成提示词' })
  };
  if (name === 'create_video') {
    properties.use_selected_image = Object.freeze({
      type: 'boolean',
      description: '只有用户明确要求使用当前已选图片作为视频参考图或首帧时才设为 true'
    });
  }
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name,
      description: name === 'create_image'
        ? '兼容旧单图请求：只表示一个无依赖图片输出。多个输出应使用 plan_media_generation。规格由 Lavans 已保存设置决定。'
        : name === 'create_video'
          ? '兼容旧单视频请求：只表示一个无依赖视频输出。若用户要求用当前图片生成视频，设置 use_selected_image=true。多个或有依赖的输出应使用 plan_media_generation。'
          : '兼容单条 TTS 请求：只表示一个无依赖音频输出。仅在用户明确要求朗读或配音时使用。',
      parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        properties: Object.freeze(properties),
        required: Object.freeze(['prompt'])
      })
    })
  });
});
const AGENT_TOOLS = Object.freeze([STRUCTURED_QUESTION_TOOL, MEDIA_PLAN_TOOL, ...LEGACY_MEDIA_TOOLS]);
const PLAN_ITEM_KEYS = new Set(['item_id', 'stage_id', 'kind', 'prompt', 'depends_on', 'use_selected_image']);
const PLAN_DEPENDENCY_KEYS = new Set(['item_id', 'role']);
const QUESTION_SET_KEYS = new Set(['title', 'submit_label', 'questions']);
const QUESTION_KEYS = new Set(['question_id', 'title', 'prompt', 'type', 'required', 'allow_custom', 'placeholder', 'choices']);
const QUESTION_CHOICE_KEYS = new Set(['value', 'label', 'description']);
const STRUCTURED_CHOICE_PROMPT_RE = /(?:请选择|请确认|请回复|请告诉我|你更喜欢|是否有需要修改|是否同意)/u;
const STRUCTURED_CHOICE_OPTIONS_RE = /(?:(?:路线|方案)\s*[A-H1-9]|(?:^|\n)\s*\d{1,2}[.、]\s*)/mu;
const MAX_SKILL_CONTEXT_BYTES = 256 * 1024;
const SKILL_PLANNING_FILES = Object.freeze([
  'SKILL.md',
  'references/core-instructions.md',
  'references/creative-discovery.md',
  'references/process-flow.md',
  'references/asset-workflow.md',
  'references/model-specs.md',
  'references/prompt-delivery-contract.md',
  'references/phase-checklist.md'
]);

function serviceError(message, statusCode = 400, code = 'AGENT_SESSION_CHAT_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function identifier(value, label) {
  const normalized = String(value || '').trim();
  if (!ID_RE.test(normalized)) throw serviceError(`${label} 不合法`, 400, 'INVALID_ID');
  return normalized;
}

function text(value, limit, label, required = false) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) throw serviceError(`${label} 不能为空`, 400, 'INVALID_INPUT');
  if (normalized.length > limit) throw serviceError(`${label} 超出长度限制`, 400, 'INVALID_INPUT');
  return normalized;
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function skillSystemPrompt(skill) {
  if (!skill) return '';
  const stages = Array.isArray(skill.stages)
    ? skill.stages.slice(0, 20).map(stage => `${stage.title || stage.id}: ${stage.summary || ''}`.trim()).filter(Boolean)
    : [];
  return [
    '当前 Skill 只作为对话与规划参考。不得执行其工具、脚本、阶段或任何付费媒体操作，也不得声称已经执行。这里的“其”仅指 Skill 自带执行能力；Skill 要求结构化澄清或继续创作前确实缺少关键信息时，必须调用 ask_user_questions，让问题显示为当前聊天里的真实选项卡，不得输出 Markdown 选项冒充弹窗。用户明确要求生成媒体时，只能通过系统提供的 plan_media_generation 或兼容的 create_image/create_video/create_audio 表达计划，由独立授权链执行。不得在收到工具结果前声称已经完成。',
    `Skill：${text(skill.displayName || skill.id, 160, 'Skill 名称')}`,
    text(skill.description, 1000, 'Skill 描述'),
    stages.length ? `阶段说明：\n${stages.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inside(root, target) {
  const normalizedRoot = normalizedPath(root);
  const normalizedTarget = normalizedPath(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function importedSkillSystemPrompt(skill, runtime, session) {
  const integrity = skill?.integrity && typeof skill.integrity === 'object' ? skill.integrity : null;
  if (!integrity || integrity.status !== 'verified') return skillSystemPrompt(skill);
  if (!runtime || runtime.origin !== 'imported') {
    throw serviceError('已验证的导入 Skill 缺少可信运行时', 409, 'AGENT_SKILL_CONTEXT_UNAVAILABLE');
  }
  const adapter = runtime.adapter && typeof runtime.adapter === 'object' ? runtime.adapter : {};
  const contentHash = text(integrity.contentHash, 64, 'Skill 内容摘要').toLowerCase();
  const packageHash = text(integrity.packageHash, 64, 'Skill 包摘要').toLowerCase();
  const adapterContentHash = text(adapter.integrity?.contentHash, 64, 'Skill 运行时内容摘要').toLowerCase();
  const adapterPackageHash = text(adapter.integrity?.packageHash, 64, 'Skill 运行时包摘要').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash) || !/^[a-f0-9]{64}$/.test(packageHash)
    || contentHash !== adapterContentHash || packageHash !== adapterPackageHash
    || adapter.id !== skill.id || adapter.capabilities?.instructionOnly !== true || adapter.capabilities?.executable !== false) {
    throw serviceError('Skill 公开身份与可信运行时不一致', 409, 'AGENT_SKILL_CONTEXT_IDENTITY_MISMATCH');
  }
  if (session?.contentHash && session.contentHash !== contentHash) {
    throw serviceError('AgentSession 固定的 Skill 内容摘要已漂移', 409, 'SESSION_SKILL_IDENTITY_CONFLICT');
  }
  const declaredVersion = text(skill.ui?.version, 80, 'Skill 版本');
  if (session?.declaredVersion && session.declaredVersion !== declaredVersion) {
    throw serviceError('AgentSession 固定的 Skill 版本已漂移', 409, 'SESSION_SKILL_IDENTITY_CONFLICT');
  }

  let sections;
  try {
    const sourcePath = fs.realpathSync(runtime.sourcePath);
    const entryPath = fs.realpathSync(runtime.entryPath);
    if (!inside(sourcePath, entryPath) || path.basename(entryPath).toLowerCase() !== 'skill.md') {
      throw serviceError('Skill 指令入口不在可信包内', 409, 'AGENT_SKILL_CONTEXT_INVALID');
    }
    let totalBytes = 0;
    sections = [];
    for (const relativePath of SKILL_PLANNING_FILES) {
      const requested = path.resolve(sourcePath, relativePath);
      if (relativePath !== 'SKILL.md' && !fs.existsSync(requested)) continue;
      const target = fs.realpathSync(requested);
      if (!inside(sourcePath, target) || !fs.statSync(target).isFile()) {
        throw serviceError('Skill 规划引用不在可信包内', 409, 'AGENT_SKILL_CONTEXT_INVALID');
      }
      const bytes = fs.readFileSync(target);
      totalBytes += bytes.length;
      if (totalBytes > MAX_SKILL_CONTEXT_BYTES) {
        throw serviceError('Skill 规划上下文超出安全边界', 409, 'AGENT_SKILL_CONTEXT_TOO_LARGE');
      }
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (_error) { throw serviceError('Skill 规划上下文不是有效 UTF-8', 409, 'AGENT_SKILL_CONTEXT_INVALID'); }
      sections.push(`--- ${relativePath} ---\n${content}`);
    }
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) throw error;
    throw serviceError('Skill 只读规划上下文无法安全读取', 409, 'AGENT_SKILL_CONTEXT_INVALID');
  }
  return [
    '以下内容来自 Lavans 已完成完整性校验的不可变导入 Skill，只允许作为对话和媒体规划指令读取。',
    `Skill 身份：${skill.id}@${declaredVersion || 'unknown'}；contentHash=${contentHash}；packageHash=${packageHash}。`,
    '安全适配规则：不得执行、导入或模拟运行 Skill 包内的脚本、CLI、API 客户端或任意代码；不得读取下列白名单以外的包文件。Skill 中要求调用外部头脑风暴或结构化提问工具时，必须调用 ask_user_questions，在当前持续聊天中显示真实选项卡并等待用户提交，不得启动第二套运行系统，也不得用 Markdown 问卷替代。Brief、创意蓝图、剧本、分镜表、检查表与最终说明只能作为聊天文字回复，不得规划为画布节点。只有真正需要生成的图片、视频和用户明确要求的 TTS 音频才可进入 plan_media_generation。一次完整创作流程的全部媒体输出必须按实际内容动态列成独立 item，并用 depends_on 表达资产、关键帧和视频片段依赖；不得套固定节点数。每个图片或视频 item 必须直接列全当前镜头实际需要的资产图、分镜图、逐镜图和首尾帧，不能只依赖传递关系；role 必须写真实用途。执行层按 first_frame、last_frame、其余 item_id 升序排列直接图片依赖，再逐层补入未重复的传递图片依赖；Prompt 使用 @图片N 时必须与此图号顺序完全一致。自动模式不逐项询问，手动模式由 GenerationRound 统一确认一次。除非用户明确要求，默认不规划音频；首版音频只支持短文本 TTS，不支持 BGM、音乐或声音克隆。不得改变软件锁定的 Provider、模型、比例、清晰度、时长或数量。',
    '经过验证的只读规划上下文如下：',
    sections.join('\n\n')
  ].join('\n\n');
}

function readCompositionContexts(contexts, label) {
  if (!Array.isArray(contexts) || !contexts.length) {
    throw serviceError(`${label}缺少只读上下文`, 409, 'AGENT_SKILL_CONTEXT_INVALID');
  }
  let totalBytes = 0;
  const sections = contexts.map((context, index) => {
    try {
      const relativePath = text(context?.relativePath, 320, `${label}上下文路径`, true).replaceAll('\\', '/');
      const absolutePath = path.resolve(text(context?.absolutePath, 2_000, `${label}上下文绝对路径`, true));
      const bytes = fs.readFileSync(absolutePath);
      if (Number(context?.size) !== bytes.length) {
        throw serviceError(`${label}上下文大小已漂移`, 409, 'AGENT_SKILL_CONTEXT_IDENTITY_MISMATCH');
      }
      totalBytes += bytes.length;
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (_error) { throw serviceError(`${label}上下文不是有效 UTF-8`, 409, 'AGENT_SKILL_CONTEXT_INVALID'); }
      return `--- ${relativePath} ---\n${content}`;
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) throw error;
      throw serviceError(`${label}上下文无法安全读取（${index + 1}）`, 409, 'AGENT_SKILL_CONTEXT_INVALID');
    }
  });
  return { sections, totalBytes };
}

function composedSkillSystemPrompts(resolution, selectedSkillId) {
  const composition = resolution?.composition;
  if (!composition || composition.schemaVersion !== '1.0' || composition.primary?.id !== selectedSkillId
    || !/^[a-f0-9]{64}$/.test(String(composition.compositionHash || ''))) {
    throw serviceError('Skill 组合解析结果不合法', 409, 'AGENT_SKILL_COMPOSITION_INVALID');
  }
  const declaredDependencies = Array.isArray(composition.dependencies) ? composition.dependencies : [];
  const resolvedDependencies = Array.isArray(resolution.dependencies) ? resolution.dependencies : [];
  if (!resolution.primary || declaredDependencies.length < 1 || declaredDependencies.length !== resolvedDependencies.length) {
    throw serviceError('Skill 组合解析结果不完整', 409, 'AGENT_SKILL_COMPOSITION_INVALID');
  }

  let totalBytes = 0;
  const dependencyPrompts = declaredDependencies.map(identity => {
    const dependency = resolvedDependencies.find(item => item?.id === identity.id && item?.role === identity.role);
    if (!dependency) throw serviceError('Skill 组合依赖身份不一致', 409, 'AGENT_SKILL_COMPOSITION_INVALID');
    const context = readCompositionContexts(dependency.contexts, `依赖 Skill ${identity.id}`);
    totalBytes += context.totalBytes;
    return [
      `[DEPENDENCY role=${identity.role}]`,
      `Skill 身份：${identity.id}@${identity.declaredVersion}；contentHash=${identity.contentHash}；packageHash=${identity.packageHash}。`,
      '职责：只负责创意发现、意图澄清、路线比较与风险追问；不得越权改变主 Skill 的生产流程或执行媒体任务。',
      ...context.sections
    ].join('\n\n');
  });
  const primaryContext = readCompositionContexts(resolution.primary.contexts, `主 Skill ${selectedSkillId}`);
  totalBytes += primaryContext.totalBytes;
  const maximum = Number(composition.policy?.maxContextBytes || MAX_SKILL_CONTEXT_BYTES);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_SKILL_CONTEXT_BYTES
    || totalBytes !== Number(resolution.totalBytes) || totalBytes > maximum) {
    throw serviceError('Skill 组合上下文超出安全边界', 409, 'AGENT_SKILL_CONTEXT_TOO_LARGE');
  }
  const primaryPrompt = [
    '[PRIMARY]',
    `Skill 身份：${composition.primary.id}@${composition.primary.declaredVersion}；contentHash=${composition.primary.contentHash}；packageHash=${composition.primary.packageHash}。`,
    '职责：在依赖完成创意发现后，负责电商视频的完整规划、阶段核验和媒体计划；不得执行 Skill 包中的脚本、CLI 或 API 客户端。',
    ...primaryContext.sections
  ].join('\n\n');
  const contractPrompt = [
    '[COMPOSITION CONTRACT]',
    '宿主安全与工具契约始终高于依赖和主 Skill；依赖只做创意发现，主 Skill 负责正式生产规划，发生冲突时按此优先级裁决。',
    '继续创作前缺少关键信息时必须调用 ask_user_questions，问题留在当前持续聊天；不得用 Markdown 问卷替代。',
    '创意蓝图、Brief、剧本、分镜表、检查表和最终说明只作为聊天文字，不创建画布文档节点。',
    '生产硬门：用户明确确认创意蓝图之前，不得调用 plan_media_generation 或兼容媒体工具；确认后才可按实际依赖规划图片、视频和明确要求的短文本 TTS 音频。',
    '所有 Provider、模型、规格、授权、失败关闭和恢复仍由 Lavans 固定安全链控制；不得切换、回退、自动重试或伪造完成。'
  ].join('\n\n');
  const prompts = [...dependencyPrompts, primaryPrompt, contractPrompt];
  return { prompts, skillContextHash: sha256(prompts), composition };
}

function toolArguments(call) {
  let args = call?.arguments ?? call?.function?.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); }
    catch (_error) { throw serviceError('文字模型返回的工具参数不是有效 JSON', 502, 'AGENT_CHAT_TOOL_INVALID'); }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw serviceError('文字模型返回的工具参数不合法', 502, 'AGENT_CHAT_TOOL_INVALID');
  }
  return args;
}

function normalizeStructuredQuestionRequest(value, questionSetId) {
  const calls = Array.isArray(value) ? value : [];
  const questionCalls = calls.filter(call => String(call?.name || call?.function?.name || '').trim() === STRUCTURED_QUESTION_TOOL_NAME);
  if (!questionCalls.length) return null;
  if (questionCalls.length !== 1 || calls.length !== 1) {
    throw serviceError('结构化提问不能与媒体或其他工具混在同一次回复中', 502, 'AGENT_CHAT_TOOL_MIXED');
  }
  const args = toolArguments(questionCalls[0]);
  if (Object.keys(args).some(key => !QUESTION_SET_KEYS.has(key)) || !Array.isArray(args.questions)
    || args.questions.length < 1 || args.questions.length > 5) {
    throw serviceError('文字模型返回的结构化问题集不合法', 502, 'AGENT_CHAT_QUESTION_INVALID');
  }
  const questions = args.questions.map((question, questionIndex) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || Object.keys(question).some(key => !QUESTION_KEYS.has(key))) {
      throw serviceError('文字模型返回了不合法的结构化问题', 502, 'AGENT_CHAT_QUESTION_INVALID');
    }
    const type = text(question.type, 20, `结构化问题 ${questionIndex + 1} 类型`, true).toLowerCase();
    if (!['single', 'multiple', 'text'].includes(type) || typeof question.required !== 'boolean'
      || (question.allow_custom !== undefined && typeof question.allow_custom !== 'boolean')) {
      throw serviceError('文字模型返回的结构化问题类型不合法', 502, 'AGENT_CHAT_QUESTION_INVALID');
    }
    const rawChoices = question.choices === undefined ? [] : question.choices;
    if (!Array.isArray(rawChoices) || rawChoices.length > 8 || (type === 'text' && rawChoices.length)
      || (type !== 'text' && rawChoices.length < 2)) {
      throw serviceError('文字模型返回的结构化问题选项不合法', 502, 'AGENT_CHAT_QUESTION_INVALID');
    }
    const choices = rawChoices.map((choice, choiceIndex) => {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)
        || Object.keys(choice).some(key => !QUESTION_CHOICE_KEYS.has(key))) {
        throw serviceError('文字模型返回的结构化问题选项不合法', 502, 'AGENT_CHAT_QUESTION_INVALID');
      }
      const value = identifier(choice.value, `结构化问题 ${questionIndex + 1} 选项 ${choiceIndex + 1} 值`);
      if (value === '__custom__') throw serviceError('文字模型使用了保留选项值', 502, 'AGENT_CHAT_QUESTION_INVALID');
      return {
        value,
        label: text(choice.label, 240, `结构化问题 ${questionIndex + 1} 选项 ${choiceIndex + 1} 标签`, true),
        description: text(choice.description, 500, `结构化问题 ${questionIndex + 1} 选项 ${choiceIndex + 1} 说明`)
      };
    });
    if (new Set(choices.map(choice => choice.value)).size !== choices.length) {
      throw serviceError('文字模型返回了重复的结构化问题选项', 502, 'AGENT_CHAT_QUESTION_INVALID');
    }
    return {
      id: identifier(question.question_id, `结构化问题 ${questionIndex + 1} ID`),
      title: text(question.title, 160, `结构化问题 ${questionIndex + 1} 标题`, true),
      prompt: text(question.prompt, 1_000, `结构化问题 ${questionIndex + 1} 内容`, true),
      type,
      required: question.required,
      allowCustom: type === 'text' ? false : question.allow_custom === true,
      placeholder: text(question.placeholder, 240, `结构化问题 ${questionIndex + 1} 占位提示`),
      choices
    };
  });
  if (new Set(questions.map(question => question.id)).size !== questions.length) {
    throw serviceError('文字模型返回了重复的结构化问题 ID', 502, 'AGENT_CHAT_QUESTION_INVALID');
  }
  return {
    schemaVersion: 1,
    id: questionSetId,
    title: text(args.title, 240, '结构化问题集标题', true),
    submitLabel: text(args.submit_label || '继续', 80, '结构化问题集提交按钮', true),
    questions
  };
}

function structuredQuestionContent(questionSet) {
  return [questionSet.title, ...questionSet.questions.map((question, index) => `${index + 1}. ${question.prompt}`)].join('\n');
}

function needsStructuredQuestionRepair(value, toolCalls, hasSkillContext) {
  const content = String(value || '').trim();
  return hasSkillContext === true
    && (!Array.isArray(toolCalls) || toolCalls.length === 0)
    && STRUCTURED_CHOICE_PROMPT_RE.test(content)
    && STRUCTURED_CHOICE_OPTIONS_RE.test(content);
}

function mergeProviderUsage(primary, secondary) {
  if (!primary || typeof primary !== 'object' || Array.isArray(primary)) return secondary || null;
  if (!secondary || typeof secondary !== 'object' || Array.isArray(secondary)) return primary;
  const merged = { ...primary };
  Object.entries(secondary).forEach(([key, value]) => {
    if (typeof value === 'number' && Number.isFinite(value) && typeof merged[key] === 'number' && Number.isFinite(merged[key])) {
      merged[key] += value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)
      && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = mergeProviderUsage(merged[key], value);
    } else if (merged[key] === undefined || merged[key] === null) {
      merged[key] = value;
    }
  });
  return merged;
}

function normalizeMediaIntents(value) {
  const calls = Array.isArray(value) ? value : [];
  if (calls.length > 2000) throw serviceError('本轮媒体计划超出安全边界', 502, 'AGENT_CHAT_MEDIA_PLAN_INVALID');
  const planned = [];
  const legacy = [];
  calls.forEach(call => {
    const name = String(call?.name || call?.function?.name || '').trim();
    const args = toolArguments(call);
    if (name === MEDIA_PLAN_TOOL_NAME) {
      if (Object.keys(args).some(key => key !== 'items') || !Array.isArray(args.items) || !args.items.length) {
        throw serviceError('文字模型返回的媒体计划结构不合法', 502, 'AGENT_CHAT_MEDIA_PLAN_INVALID');
      }
      for (const item of args.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).some(key => !PLAN_ITEM_KEYS.has(key))) {
          throw serviceError('文字模型返回了越权或不合法的媒体计划项', 502, 'AGENT_CHAT_MEDIA_PLAN_INVALID');
        }
        const dependencies = item.depends_on === undefined ? [] : item.depends_on;
        if (!Array.isArray(dependencies) || dependencies.some(dependency => !dependency || typeof dependency !== 'object'
          || Array.isArray(dependency) || Object.keys(dependency).some(key => !PLAN_DEPENDENCY_KEYS.has(key)))) {
          throw serviceError('文字模型返回的媒体计划依赖不合法', 502, 'AGENT_CHAT_MEDIA_PLAN_INVALID');
        }
        planned.push({
          itemId: identifier(item.item_id, '媒体计划 item ID'),
          stageId: identifier(item.stage_id, '媒体计划阶段 ID'),
          kind: text(item.kind, 20, '媒体计划类型', true).toLowerCase(),
          prompt: text(item.prompt, 60_000, '媒体 Prompt', true),
          dependsOn: dependencies.map(dependency => ({
            itemId: identifier(dependency.item_id, '媒体计划依赖 ID'),
            role: text(dependency.role, 160, '媒体计划依赖角色')
          })),
          useSelectedImage: item.use_selected_image === true
        });
      }
      return;
    }
    const kind = MEDIA_TOOL_NAMES.get(name);
    if (!kind) throw serviceError('文字模型请求了未授权的工具', 409, 'AGENT_CHAT_TOOL_UNAVAILABLE');
    const allowedKeys = kind === 'video' ? new Set(['prompt', 'use_selected_image']) : new Set(['prompt']);
    if (Object.keys(args).some(key => !allowedKeys.has(key))) {
      throw serviceError('文字模型在兼容媒体工具中返回了越权字段', 502, 'AGENT_CHAT_MEDIA_PLAN_INVALID');
    }
    const prompt = text(args.prompt, 60_000, '媒体 Prompt', true);
    const useSelectedImage = kind === 'video' && args.use_selected_image === true;
    legacy.push({ kind, prompt, useSelectedImage });
  });
  if (planned.length && legacy.length) {
    throw serviceError('文字模型不能混用完整媒体计划与兼容单项工具', 502, 'AGENT_CHAT_MEDIA_PLAN_INVALID');
  }
  if (planned.length) return planned;
  const occurrences = new Map();
  return legacy.map(item => {
    const fingerprint = sha256(item).slice(0, 24);
    const occurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, occurrence);
    return {
      itemId: `${item.kind}-${fingerprint}-${occurrence}`,
      stageId: `${item.kind}-generation`,
      ...item,
      dependsOn: []
    };
  });
}

function mediaDefaults(session, kind) {
  const defaults = session?.constraints?.mediaDefaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw serviceError('AgentSession 未保存媒体默认设置', 409, 'AGENT_MEDIA_DEFAULTS_MISSING');
  }
  const prefix = kind;
  if (defaults[`${prefix}Quantity`] !== 1) {
    throw serviceError('媒体默认设置必须保持每个计划项一个独立输出', 409, 'AGENT_MEDIA_DEFAULTS_INVALID');
  }
  const spec = kind === 'audio' ? {
    voice: text(defaults.audioVoice, 20, 'audio 音色', true).toLowerCase(),
    format: text(defaults.audioFormat, 20, 'audio 格式', true).toLowerCase(),
    speed: Number(defaults.audioSpeed ?? 1)
  } : {
    ratio: text(defaults[`${prefix}Ratio`], 20, `${prefix} 比例`, true),
    resolution: text(defaults[`${prefix}Resolution`], 20, `${prefix} 规格`, true)
  };
  if (kind === 'video') {
    const duration = defaults.videoDuration === undefined ? 5 : Number(defaults.videoDuration);
    if (!Number.isInteger(duration) || duration < 5 || duration > 15) {
      throw serviceError('视频默认时长必须是 5 至 15 秒的整数', 409, 'AGENT_MEDIA_DEFAULTS_INVALID');
    }
    spec.duration = duration;
  } else if (kind === 'audio' && (!Number.isFinite(spec.speed) || spec.speed < 0.25 || spec.speed > 4)) {
    throw serviceError('音频默认语速必须是 0.25 至 4', 409, 'AGENT_MEDIA_DEFAULTS_INVALID');
  }
  return {
    provider: text(defaults[`${prefix}ProviderId`], 160, `${prefix} Provider`, true),
    model: text(defaults[`${prefix}Model`], 240, `${prefix} 模型`, true),
    spec
  };
}

function buildGenerationPlan(session, intents, selectedImageNodeId, selectedImageIndex) {
  const stages = [...new Set(intents.map(item => item.stageId))].map(stageId => ({ stageId, label: stageId }));
  const items = intents.map(intent => {
    if (!['image', 'video', 'audio'].includes(intent.kind)) {
      throw serviceError('文字模型返回了越权媒体类型', 502, 'AGENT_CHAT_MEDIA_PLAN_INVALID');
    }
    if (intent.useSelectedImage && (intent.kind !== 'video' || !selectedImageNodeId)) {
      throw serviceError('媒体计划引用了不存在或不适用的当前图片', 502, 'AGENT_MEDIA_REFERENCE_INVALID');
    }
    const defaults = mediaDefaults(session, intent.kind);
    return {
      itemId: intent.itemId,
      stageId: intent.stageId,
      kind: intent.kind,
      prompt: intent.prompt,
      promptVersion: 'llm-media-plan-v1',
      provider: defaults.provider,
      model: defaults.model,
      spec: {
        ...defaults.spec,
        ...(intent.useSelectedImage ? { sourceNodeId: selectedImageNodeId, sourceImageIndex: selectedImageIndex } : {})
      },
      quantity: 1,
      dependsOn: intent.dependsOn
    };
  });
  return normalizeGenerationPlan({ planRevision: 1, stages, items }, { allowedKinds: ['image', 'video', 'audio'] });
}

function roundSummary(round) {
  const counts = (round.items || []).reduce((result, item) => {
    result[item.kind] = (result[item.kind] || 0) + 1;
    return result;
  }, {});
  const detail = [counts.image ? `图片 ${counts.image} 项` : '', counts.video ? `视频 ${counts.video} 项` : '', counts.audio ? `音频 ${counts.audio} 项` : ''].filter(Boolean).join('、');
  const suffix = round.mode === 'automatic'
    ? '已按自动模式锁定，等待安全执行层按依赖处理。'
    : '已锁定为一次总确认，确认前不会建立媒体任务或节点。';
  return `本轮媒体计划已建立：${detail || `${round.items?.length || 0} 项`}。${suffix}`;
}

function roundFromMessage(session, message) {
  const ref = (message?.attachments || []).find(item => item.kind === 'agent-generation-round');
  return ref ? session.generationRounds.find(round => round.roundId === ref.assetId) || null : null;
}

function failureFromMessage(message) {
  const ref = (message?.attachments || []).find(item => item.kind === 'agent-generation-plan-failure');
  return ref ? { code: ref.name || 'AGENT_CHAT_MEDIA_PLAN_INVALID', triggerMessageEventId: ref.assetId } : null;
}

function closedFailureTriggers(session) {
  return new Set(session.messages.flatMap(message => {
    const failure = failureFromMessage(message);
    return failure ? [failure.triggerMessageEventId] : [];
  }));
}

function explicitReferenceVideoIntent(content) {
  const value = String(content || '').toLowerCase();
  return /(视频|video)/i.test(value) && /(这张|这只|当前|选中|参考图|图片|图像|首帧|reference|selected|image)/i.test(value);
}

function createAgentSessionChatService(options = {}) {
  const sessionService = options.agentSessionService;
  const getCanvasConfig = options.getCanvasConfig;
  const findSkill = typeof options.findSkill === 'function' ? options.findSkill : () => null;
  const findSkillRuntime = typeof options.findSkillRuntime === 'function' ? options.findSkillRuntime : () => null;
  const resolveSkillComposition = typeof options.resolveSkillComposition === 'function' ? options.resolveSkillComposition : null;
  const transport = options.transport;
  const messageContent = typeof options.messageContent === 'function' ? options.messageContent : message => message.content;
  const prepareVideoContext = typeof options.prepareVideoContext === 'function' ? options.prepareVideoContext : null;
  const describeMediaExecution = typeof options.describeMediaExecution === 'function' ? options.describeMediaExecution : null;
  if (!sessionService || typeof sessionService.loadSession !== 'function'
    || typeof sessionService.appendMessage !== 'function'
    || typeof sessionService.createGenerationRound !== 'function'
    || typeof sessionService.commitGenerationRound !== 'function'
    || typeof sessionService.updateGenerationRoundStatus !== 'function') {
    throw serviceError('AgentSession 服务不可用', 500, 'AGENT_SESSION_SERVICE_UNAVAILABLE');
  }
  if (resolveSkillComposition && typeof sessionService.bindSkillComposition !== 'function') {
    throw serviceError('AgentSession 缺少 Skill 组合绑定能力', 500, 'AGENT_SESSION_SERVICE_UNAVAILABLE');
  }
  if (typeof getCanvasConfig !== 'function' || typeof transport !== 'function') {
    throw serviceError('AgentSession 文字 Provider 未配置', 500, 'AGENT_CHAT_TRANSPORT_UNAVAILABLE');
  }

  const inflight = new Map();

  async function respond(sessionIdValue, input = {}) {
    const sessionId = identifier(sessionIdValue, 'AgentSession ID');
    const requestId = identifier(input.requestId, 'requestId');
    const triggerMessageEventId = identifier(input.triggerMessageEventId, '触发消息 eventId');
    const providerId = identifier(String(input.providerId || '').trim().toLowerCase(), 'Provider ID');
    const model = text(input.model, 240, '模型', true);
    const selectedImageNodeId = input.selectedImageNodeId === undefined || input.selectedImageNodeId === null || String(input.selectedImageNodeId).trim() === ''
      ? ''
      : identifier(input.selectedImageNodeId, '当前选中图片节点 ID');
    const selectedImageIndex = selectedImageNodeId ? Number(input.selectedImageIndex ?? 0) : 0;
    if (selectedImageNodeId && (!Number.isInteger(selectedImageIndex) || selectedImageIndex < 0)) {
      throw serviceError('当前选中图片序号不合法', 400, 'AGENT_MEDIA_REFERENCE_INVALID');
    }
    const requestedSkillId = input.selectedSkillId === undefined || input.selectedSkillId === null || String(input.selectedSkillId).trim() === ''
      ? ''
      : identifier(input.selectedSkillId, 'Skill ID');
    const conversationOnly = input.conversationOnly === true;
    const videoAnalysisConfirmed = input.videoAnalysisConfirmed === true;
    let initialSession = sessionService.loadSession(sessionId);
    if (!initialSession) throw serviceError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
    if (requestedSkillId && requestedSkillId !== String(initialSession.skillId || '').trim()) {
      throw serviceError('所选 Skill 与 AgentSession 固定身份不一致', 409, 'SESSION_SKILL_CONFLICT');
    }
    const selectedSkillId = requestedSkillId || String(initialSession.skillId || '').trim();
    const skill = selectedSkillId ? findSkill(selectedSkillId) : null;
    if (selectedSkillId && !skill) throw serviceError('所选 Skill 不存在或不可读', 404, 'AGENT_SKILL_NOT_FOUND');
    const skillRuntime = selectedSkillId ? findSkillRuntime(selectedSkillId) : null;
    let skillPrompts = [];
    let skillContextHash = '';
    let skillCompositionHash = '';
    if (skill) {
      const resolution = resolveSkillComposition ? resolveSkillComposition(selectedSkillId) : null;
      if (resolution?.composition) {
        const composed = composedSkillSystemPrompts(resolution, selectedSkillId);
        const bound = sessionService.bindSkillComposition(sessionId, {
          requestId: `agent-skill-composition-bind-${sha256(requestId).slice(0, 32)}`,
          composition: composed.composition
        });
        initialSession = bound.session;
        skillPrompts = composed.prompts;
        skillContextHash = composed.skillContextHash;
        skillCompositionHash = composed.composition.compositionHash;
      } else {
        const skillPrompt = importedSkillSystemPrompt(skill, skillRuntime, initialSession);
        skillPrompts = skillPrompt ? [skillPrompt] : [];
        skillContextHash = skillPrompt ? sha256(skillPrompt) : '';
      }
    }
    const appendRequestId = `agent-respond-${sha256(requestId).slice(0, 32)}`;
    const binding = {
      triggerMessageEventId,
      providerId,
      model,
      selectedSkillId,
      conversationOnly,
      videoAnalysisConfirmed,
      skillCompositionHash,
      skillContextHash,
      selectedImageNodeId,
      selectedImageIndex,
      mediaDefaults: initialSession.constraints?.mediaDefaults || null
    };
    const bindingHash = sha256(binding);
    const assistantEventId = `agent-response-${bindingHash.slice(0, 48)}`;
    const questionSetId = `agent-question-${bindingHash.slice(0, 48)}`;
    const roundId = `agent-round-${bindingHash.slice(0, 48)}`;
    let providerUsage = null;
    const messageModelBinding = (usage = providerUsage) => ({
      providerId,
      model,
      usage: usage || null,
      ...(skillCompositionHash ? { skillCompositionHash, skillContextHash } : {})
    });

    const appendRoundMessage = (round, usage = null, assistantText = '') => {
      const summary = roundSummary(round);
      const written = sessionService.appendMessage(sessionId, {
        requestId: appendRequestId,
        eventId: assistantEventId,
        role: 'assistant',
        kind: 'text',
        content: assistantText ? `${assistantText}\n\n${summary}` : summary,
        attachments: [{
          assetId: round.roundId,
          kind: 'agent-generation-round',
          name: 'GenerationRound',
          mimeType: 'application/vnd.lanvas.agent-generation-round+json'
        }],
        modelBinding: messageModelBinding(usage)
      });
      const message = written.session.messages.find(item => item.eventId === assistantEventId);
      return {
        session: written.session,
        message,
        generationRound: written.session.generationRounds.find(item => item.roundId === round.roundId) || round,
        mediaExecutions: [],
        usage,
        providerId,
        model,
        idempotent: written.idempotent
      };
    };

    const persistPlanFailure = (error, relatedRound = null) => {
      const failureCode = text(error?.code || 'AGENT_CHAT_MEDIA_PLAN_INVALID', 240, '计划失败代码');
      const content = `本轮媒体计划未执行：${text(error?.message || '媒体计划不合法', 2_000, '计划失败摘要')}`;
      sessionService.appendMessage(sessionId, {
        requestId: appendRequestId,
        eventId: assistantEventId,
        role: 'assistant',
        kind: 'failure-recovery',
        content,
        attachments: [{
          assetId: triggerMessageEventId,
          kind: 'agent-generation-plan-failure',
          name: failureCode,
          mimeType: 'application/vnd.lanvas.agent-generation-plan-failure+json'
        }, ...(relatedRound ? [{
          assetId: relatedRound.roundId,
          kind: 'agent-generation-round',
          name: 'GenerationRound',
          mimeType: 'application/vnd.lanvas.agent-generation-round+json'
        }] : [])],
        modelBinding: messageModelBinding()
      });
      throw error;
    };

    const existing = initialSession.messages.find(message => message.role === 'assistant' && message.requestId === appendRequestId);
    if (existing) {
      if (existing.eventId !== assistantEventId) throw serviceError('requestId 已用于不同聊天绑定', 409, 'IDEMPOTENCY_CONFLICT');
      const failure = failureFromMessage(existing);
      if (failure) throw serviceError(existing.content, 502, failure.code);
      const mediaExecutions = describeMediaExecution
        ? (await Promise.all((existing.attachments || []).filter(item => item.kind === 'agent-media-tool-run').map(item => describeMediaExecution(sessionId, item.assetId)))).filter(Boolean)
        : [];
      return {
        session: initialSession,
        message: existing,
        generationRound: roundFromMessage(initialSession, existing),
        mediaExecutions,
        usage: null,
        providerId,
        model,
        idempotent: true
      };
    }

    const inflightKey = `${sessionId}:${appendRequestId}`;
    const pending = inflight.get(inflightKey);
    if (pending) {
      if (pending.bindingHash !== bindingHash) throw serviceError('requestId 已用于不同聊天绑定', 409, 'IDEMPOTENCY_CONFLICT');
      const result = await pending.promise;
      return { ...result, idempotent: true };
    }

    const promise = (async () => {
      if (initialSession.status === 'cancelled') throw serviceError('已取消的 AgentSession 不能请求文字回复', 409, 'SESSION_CANCELLED');
      const triggerIndex = initialSession.messages.findIndex(message => message.eventId === triggerMessageEventId || message.id === triggerMessageEventId);
      const trigger = triggerIndex < 0 ? null : initialSession.messages[triggerIndex];
      const triggerHasContent = Boolean(String(trigger?.content || '').trim()) || Boolean(trigger?.attachments?.length);
      if (!trigger || trigger.role !== 'user' || !['text', 'choice'].includes(trigger.kind) || !triggerHasContent) {
        throw serviceError('触发消息必须是当前 AgentSession 中的用户文字或结构化答案', 409, 'AGENT_CHAT_TRIGGER_INVALID');
      }

      if (closedFailureTriggers(initialSession).has(triggerMessageEventId)) {
        throw serviceError('该消息的媒体计划已经失败闭合，不能自动重新规划', 409, 'AGENT_MEDIA_PLAN_ALREADY_CLOSED');
      }
      const sourceRound = initialSession.generationRounds.find(round => round.sourceMessageEventId === triggerMessageEventId);
      if (sourceRound) {
        if (sourceRound.roundId !== roundId) {
          throw serviceError('该消息已经绑定另一份媒体计划', 409, 'GENERATION_ROUND_SOURCE_CONFLICT');
        }
        if (sourceRound.status === 'planning') {
          const recoveryError = serviceError('检测到未完成锁定的媒体计划，已失败闭合；系统不会自动重调文字模型', 409, 'AGENT_MEDIA_PLAN_INTERRUPTED');
          const failed = sessionService.updateGenerationRoundStatus(sessionId, roundId, {
            requestId: `agent-round-fail-${bindingHash.slice(0, 32)}`,
            status: 'failed',
            failureSummary: recoveryError.message
          });
          return persistPlanFailure(recoveryError, failed.round);
        }
        if (sourceRound.status === 'failed' || sourceRound.status === 'cancelled') {
          return persistPlanFailure(serviceError(
            sourceRound.failureSummary || sourceRound.cancelReason || '该媒体计划已经关闭',
            409,
            sourceRound.status === 'failed' ? 'AGENT_MEDIA_PLAN_FAILED' : 'AGENT_MEDIA_PLAN_CANCELLED'
          ), sourceRound);
        }
        return appendRoundMessage(sourceRound);
      }

      const config = getCanvasConfig() || {};
      const provider = (Array.isArray(config.providers) ? config.providers : [])
        .find(item => String(item?.id || '').trim().toLowerCase() === providerId);
      if (!provider || provider.enabled === false) throw serviceError('指定 Provider 不存在或已禁用', 409, 'AGENT_CHAT_PROVIDER_UNAVAILABLE');
      if (!Array.isArray(provider.chat_models) || !provider.chat_models.includes(model)) {
        throw serviceError('指定模型未在 Provider 的 chat_models 中启用', 409, 'AGENT_CHAT_MODEL_UNAVAILABLE');
      }
      if (BLOCKED_PROTOCOLS.has(String(provider.protocol || '').toLowerCase())) {
        throw serviceError('指定 Provider 的普通文字协议尚未接入', 409, 'AGENT_CHAT_PROTOCOL_UNAVAILABLE');
      }
      if (!provider.api_key || !provider.base_url) {
        throw serviceError('指定 Provider 的 API Key 或 Base URL 未配置', 409, 'AGENT_CHAT_PROVIDER_INCOMPLETE');
      }

      if (prepareVideoContext) {
        try {
          await prepareVideoContext(trigger, {
            provider,
            providerId,
            model,
            confirmed: videoAnalysisConfirmed,
            sessionId,
            requestId,
            triggerMessageEventId
          });
        } catch (error) {
          if (Number.isInteger(error?.statusCode)) throw error;
          throw serviceError(error?.message || 'Gemini 视频分析失败', 502, error?.code || 'AGENT_CHAT_VIDEO_ANALYSIS_FAILED');
        }
      }

      const closedTriggers = closedFailureTriggers(initialSession);
      const historyRecords = initialSession.messages.slice(0, triggerIndex + 1)
        .filter(message => (message.role === 'user' || message.role === 'assistant') && ['text', 'question', 'choice'].includes(message.kind) && (message.content || message.attachments?.length))
        .filter(message => message.role !== 'user' || !closedTriggers.has(message.eventId || message.id))
        .slice(-40);
      const history = await Promise.all(historyRecords.map(async message => ({
        role: message.role,
        content: await messageContent(message, {
          provider,
          providerId,
          model,
          historical: String(message.eventId || message.id || '') !== triggerMessageEventId
        })
      })));
      const messages = [
        { role: 'system', content: '你是持续存在于 Lavans 画布右侧的媒体创作 Agent。普通问题直接对话。继续创作前确实缺少关键信息，或所选 Skill 要求结构化澄清时，必须调用 ask_user_questions；不得输出 Markdown 选项冒充交互卡片。用户明确要求实际生成图片、视频或短文本 TTS 音频时：多个输出、有依赖输出或完整创作流程必须用 plan_media_generation 一次提交全部独立 item；单个无依赖输出可使用兼容工具。结构化提问与媒体计划不能在同一次回复混用。不得提供或改变 Provider、模型、规格、数量字段，这些只由软件已保存设置注入。不得主动规划音频；只有用户明确要求朗读或配音时才规划 audio。当前不支持音乐、BGM 或声音克隆。除非收到独立工具结果，否则不得声称已经完成。' },
        ...(conversationOnly ? [{ role: 'system', content: '当前消息处于 Skill 流程内的交流模式。只回答、解释、澄清或讨论；不得调用任何工具，不得推进或替用户回答当前结构化问题，不得创建媒体计划。原问题与答案草稿由 Lavans 保持不变。' }] : []),
        ...(selectedImageNodeId ? [{ role: 'system', content: '当前画布已选中一张属于本次 AgentSession 的已完成图片。用户若说“用这张图、这只猫、当前图片或参考图生成视频”，本轮计划只能包含 video item，并且每项必须设置 use_selected_image=true；不得包含 image item，也不得先重新生成图片。' }] : []),
        ...skillPrompts.map(content => ({ role: 'system', content })),
        ...history
      ];

      let response;
      try {
        response = await transport({ provider, providerId, model, messages, tools: conversationOnly ? [] : AGENT_TOOLS, sessionId, requestId, triggerMessageEventId });
        providerUsage = response?.usage || null;
      } catch (error) {
        if (Number.isInteger(error?.statusCode)) throw error;
        throw serviceError(error?.message || '文字 Provider 调用失败', 502, 'AGENT_CHAT_PROVIDER_FAILED');
      }
      if (conversationOnly && Array.isArray(response?.toolCalls) && response.toolCalls.length) {
        throw serviceError('交流模式禁止工具调用，已停止本轮回复', 502, 'AGENT_CHAT_CONVERSATION_TOOL_FORBIDDEN');
      }
      if (!conversationOnly && needsStructuredQuestionRepair(response?.text, response?.toolCalls, skillPrompts.length > 0)) {
        const draftText = text(response?.text, 60_000, 'Provider 回复');
        let repaired;
        try {
          repaired = await transport({
            provider,
            providerId,
            model,
            messages: [{
              role: 'system',
              content: '你只负责把已经写出的明确选择或确认要求转换为一次 ask_user_questions 调用。只能使用草稿中已有的问题和选项，不得补充新事实、不得调用媒体工具、不得输出正文。'
            }, {
              role: 'assistant',
              content: draftText
            }, {
              role: 'user',
              content: '把上面的选择要求改为一次 ask_user_questions；原路线正文由 Lavans 保留。'
            }],
            tools: [STRUCTURED_QUESTION_TOOL],
            toolChoice: { type: 'function', function: { name: STRUCTURED_QUESTION_TOOL_NAME } },
            sessionId,
            requestId: `${requestId}:structured-question-repair`,
            triggerMessageEventId
          });
        } catch (error) {
          if (Number.isInteger(error?.statusCode)) throw error;
          throw serviceError(error?.message || '文字 Provider 未能生成结构化问题', 502, 'AGENT_CHAT_QUESTION_REQUIRED');
        }
        if (!normalizeStructuredQuestionRequest(repaired?.toolCalls, questionSetId)) {
          throw serviceError('文字 Provider 未按要求返回结构化问题，已停止本轮回复', 502, 'AGENT_CHAT_QUESTION_REQUIRED');
        }
        providerUsage = mergeProviderUsage(response?.usage, repaired?.usage);
        response = { ...repaired, text: draftText, usage: providerUsage };
      }
      let intents;
      let plan;
      let structuredQuestion;
      try {
        structuredQuestion = normalizeStructuredQuestionRequest(response?.toolCalls, questionSetId);
        intents = structuredQuestion ? [] : normalizeMediaIntents(response?.toolCalls);
        if (selectedImageNodeId && explicitReferenceVideoIntent(trigger.content)
          && (!intents.length || intents.some(item => item.kind !== 'video' || item.useSelectedImage !== true))) {
          throw serviceError('文字模型没有把“参考图生成视频”映射为纯视频计划，已阻止错误的图片付费任务', 502, 'AGENT_REFERENCE_VIDEO_TOOL_MISMATCH');
        }
        plan = intents.length ? buildGenerationPlan(initialSession, intents, selectedImageNodeId, selectedImageIndex) : null;
      } catch (error) {
        return persistPlanFailure(error);
      }

      if (structuredQuestion) {
        const latestSession = sessionService.loadSession(sessionId);
        if (!latestSession) throw serviceError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
        if (latestSession.status === 'cancelled') throw serviceError('AgentSession 已取消，Provider 问题集未写入', 409, 'SESSION_CANCELLED');
        const written = sessionService.appendMessage(sessionId, {
          requestId: appendRequestId,
          eventId: assistantEventId,
          role: 'assistant',
          kind: 'question',
          content: text(response?.text, 60_000, 'Provider 回复') || structuredQuestionContent(structuredQuestion),
          structuredQuestion,
          attachments: [],
          modelBinding: messageModelBinding(response?.usage || null)
        });
        const message = written.session.messages.find(item => item.eventId === assistantEventId);
        return {
          session: written.session,
          message,
          generationRound: null,
          mediaExecutions: [],
          usage: response?.usage || null,
          providerId,
          model,
          idempotent: written.idempotent
        };
      }

      if (plan) {
        let createdRound = null;
        try {
          const created = sessionService.createGenerationRound(sessionId, {
            requestId: `agent-round-create-${bindingHash.slice(0, 32)}`,
            roundId,
            sourceMessageEventId: triggerMessageEventId,
            mode: initialSession.constraints?.mediaDefaults?.autoGenerateMedia === true ? 'automatic' : 'manual'
          });
          createdRound = created.round;
          const committed = sessionService.commitGenerationRound(sessionId, roundId, {
            requestId: `agent-round-commit-${bindingHash.slice(0, 32)}`,
            planRevision: plan.planRevision,
            stages: plan.stages,
            items: plan.items
          });
          if (committed.round.planHash !== plan.planHash) {
            throw serviceError('媒体计划落库后摘要不一致', 500, 'GENERATION_ROUND_PLAN_CONFLICT');
          }
          return appendRoundMessage(committed.round, response?.usage || null, text(response?.text, 60_000, 'Provider 回复'));
        } catch (error) {
          const latest = sessionService.loadSession(sessionId);
          const relatedRound = latest?.generationRounds?.find(round => round.roundId === roundId) || createdRound;
          let closedRound = relatedRound;
          if (relatedRound?.status === 'planning') {
            const failed = sessionService.updateGenerationRoundStatus(sessionId, roundId, {
              requestId: `agent-round-fail-${bindingHash.slice(0, 32)}`,
              status: 'failed',
              failureSummary: text(error?.message || '媒体计划锁定失败', 2_000, '计划失败摘要')
            });
            closedRound = failed.round;
          }
          return persistPlanFailure(error, closedRound);
        }
      }

      const content = text(response?.text, 60_000, 'Provider 回复');
      if (!content) return persistPlanFailure(serviceError('文字 Provider 未返回可识别的内容', 502, 'AGENT_CHAT_PROVIDER_INVALID_RESPONSE'));
      const latestSession = sessionService.loadSession(sessionId);
      if (!latestSession) throw serviceError('AgentSession 不存在', 404, 'AGENT_SESSION_NOT_FOUND');
      if (latestSession.status === 'cancelled') throw serviceError('AgentSession 已取消，Provider 回复未写入', 409, 'SESSION_CANCELLED');
      const written = sessionService.appendMessage(sessionId, {
        requestId: appendRequestId,
        eventId: assistantEventId,
        role: 'assistant',
        kind: 'text',
        content,
        attachments: [],
        modelBinding: messageModelBinding(response?.usage || null)
      });
      const message = written.session.messages.find(item => item.eventId === assistantEventId);
      return {
        session: written.session,
        message,
        generationRound: null,
        mediaExecutions: [],
        usage: response?.usage || null,
        providerId,
        model,
        idempotent: written.idempotent
      };
    })();

    inflight.set(inflightKey, { bindingHash, promise });
    try { return await promise; }
    finally { inflight.delete(inflightKey); }
  }

  return Object.freeze({ respond });
}

module.exports = { createAgentSessionChatService };
