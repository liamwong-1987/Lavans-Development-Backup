'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const canvasRoutes = require('../routes/canvasRoutes');
const { createAgentMaterialStore } = require('../services/agentMaterialStore');
const { createAgentSessionService } = require('../services/agentSessionService');

const MEDIA_DEFAULTS = Object.freeze({
  imageProviderId: 'fixture-apimart',
  imageModel: 'gpt-image-2',
  imageRatio: '1:1',
  imageResolution: '1K',
  imageQuantity: 1,
  videoProviderId: 'fixture-apimart',
  videoModel: 'seedance-2.0',
  videoRatio: '9:16',
  videoResolution: '480P',
  videoQuantity: 1,
  videoDuration: 5,
  audioProviderId: 'fixture-apimart',
  audioModel: 'gpt-4o-mini-tts',
  audioVoice: 'alloy',
  audioFormat: 'wav',
  audioSpeed: 1,
  audioQuantity: 1,
  autoGenerateMedia: false
});

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function requestJson(baseUrl, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function fixture(options = {}) {
  const outputRoot = path.join(os.tmpdir(), `lavans-agent-session-chat-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let id = 0;
  const sessionService = createAgentSessionService({ outputRoot, makeId: prefix => `${prefix}-chat-${++id}` });
  const session = sessionService.createSession({
    requestId: 'request-create-chat-session',
    canvasId: 'canvas-session-chat',
    workspaceScope: 'canvas-agent',
    mode: 'generation',
    skillId: options.skillId || ''
  }).session;
  (Array.isArray(options.historyMessages) ? options.historyMessages : []).forEach((message, index) => {
    sessionService.appendMessage(session.id, {
      requestId: `request-history-chat-message-${index + 1}`,
      eventId: message.eventId || `event-history-chat-message-${index + 1}`,
      role: message.role || 'user',
      kind: message.kind || 'text',
      content: message.content || '',
      attachments: message.attachments || []
    });
  });
  sessionService.appendMessage(session.id, {
    requestId: 'request-user-chat-message',
    eventId: 'event-user-chat-message',
    role: 'user',
    kind: 'text',
    content: options.userContent || '先和我普通聊聊，不要生成媒体',
    attachments: options.attachments || []
  });
  sessionService.setStatus(session.id, {
    requestId: 'request-session-chat-media-defaults',
    status: 'collecting',
    constraints: { mediaDefaults: { ...MEDIA_DEFAULTS, ...(options.mediaDefaults || {}) } }
  });
  const providers = [{
    id: 'fixture-chat',
    name: 'Fixture Chat',
    enabled: true,
    protocol: 'openai',
    api_key: 'fixture-key-never-sent',
    base_url: 'https://fixture.invalid',
    chat_models: ['fixture-chat-model', 'fixture-chat-model-2']
  }, {
    id: 'fixture-disabled',
    name: 'Fixture Disabled',
    enabled: false,
    protocol: 'openai',
    api_key: 'fixture-key-never-sent',
    base_url: 'https://fixture.invalid',
    chat_models: ['fixture-chat-model']
  }];
  const calls = [];
  const transport = options.transport || (async input => {
    calls.push(input);
    return { text: '这是同一 AgentSession 中的普通文字回复。', usage: { total_tokens: 12 } };
  });
  const router = canvasRoutes({
    outputRoot,
    agentSessionService: sessionService,
    agentRunService: {},
    canvasConfig: { primaryProviderId: 'fixture-chat', providers },
    agentSessionChatTransport: transport,
    agentSessionMessageContent: options.messageContent,
    agentSessionPrepareVideoContext: options.prepareVideoContext,
    agentMediaExecutionService: options.agentMediaExecutionService,
    findAgentSessionSkill: options.findSkill
  });
  return { outputRoot, sessionService, session, calls, router };
}

test('U6：会话重命名路由保存标题并立即出现在历史列表', async () => {
  const state = fixture();
  await withServer(state.router, async baseUrl => {
    const renamed = await fetch(`${baseUrl}/api/canvas/agent-sessions/${state.session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'request-rename-through-route', title: '新品发布会' })
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).session.title, '新品发布会');

    const history = await fetch(`${baseUrl}/api/canvas/agent-sessions?canvasId=canvas-session-chat`);
    assert.equal(history.status, 200);
    assert.equal((await history.json()).sessions[0].title, '新品发布会');
  });
});

test('用户附件解析后的文字和图片内容会原样进入同一次 Provider 请求', async () => {
  const state = fixture({
    userContent: '请读取附件',
    attachments: [{ assetId: 'material_ffffffffffffffff', kind: 'image', name: '产品.png', mimeType: 'image/png' }],
    messageContent: message => message.role === 'user'
      ? [{ type: 'text', text: `${message.content}\n附件文字` }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]
      : message.content
  });
  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody());
    assert.equal(response.status, 200);
    assert.equal(state.calls.length, 1);
    assert.ok(Array.isArray(state.calls[0].messages.at(-1).content));
    assert.match(state.calls[0].messages.at(-1).content[0].text, /附件文字/);
    assert.match(state.calls[0].messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
  });
});

test('视频分析必须先确认，且确认后先分析视频再执行原 AGENT 回复', async () => {
  const events = [];
  const state = fixture({
    userContent: '请看视频后回答',
    attachments: [{ assetId: 'material_abababababababab', kind: 'video', name: '演示.mp4', mimeType: 'video/mp4' }],
    messageContent: message => message.role === 'user' ? `${message.content}\nGemini 视频分析：产品在桌面旋转展示。` : message.content,
    prepareVideoContext: async (_message, context) => {
      events.push(`prepare:${context.confirmed}`);
      if(context.confirmed !== true){
        const error = new Error('请确认两次模型调用');
        error.statusCode = 409;
        error.code = 'AGENT_CHAT_VIDEO_CONFIRMATION_REQUIRED';
        throw error;
      }
    },
    transport: async input => {
      events.push('agent');
      assert.match(input.messages.at(-1).content, /Gemini 视频分析/);
      return { text: '已根据视频回答。', usage: { total_tokens: 18 } };
    }
  });
  await withServer(state.router, async baseUrl => {
    const blocked = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody({ requestId: 'request-video-unconfirmed' }));
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, 'AGENT_CHAT_VIDEO_CONFIRMATION_REQUIRED');
    assert.deepEqual(events, ['prepare:false']);

    const approved = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody({
      requestId: 'request-video-confirmed',
      videoAnalysisConfirmed: true
    }));
    assert.equal(approved.status, 200);
    assert.deepEqual(events, ['prepare:false', 'prepare:true', 'agent']);
  });
});

test('APIMART Gemini 视频使用原生 inlineData，一次分析后把缓存摘要交回原工具聊天链', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-video-route-'));
  const materialRoot = path.join(outputRoot, 'materials');
  const registryRoot = path.join(outputRoot, 'material-registry');
  fs.mkdirSync(materialRoot, { recursive: true });
  const materialStore = createAgentMaterialStore({ materialRoot, registryRoot });
  fs.writeFileSync(path.join(materialRoot, 'demo.mp4'), Buffer.from('00000018667479706d703432', 'hex'));
  materialStore.register({
    id: 'material_cdcdcdcdcdcdcdcd',
    storedName: 'demo.mp4',
    originalName: 'demo.mp4',
    mime: 'video/mp4',
    kind: 'video'
  });
  const sessionService = createAgentSessionService({ outputRoot });
  const session = sessionService.createSession({
    requestId: 'request-create-video-session',
    canvasId: 'canvas-video-session',
    workspaceScope: 'canvas-agent',
    mode: 'generation'
  }).session;
  sessionService.appendMessage(session.id, {
    requestId: 'request-video-message',
    eventId: 'event-video-message',
    role: 'user',
    kind: 'text',
    content: '这个视频里发生了什么？',
    attachments: [{ assetId: 'material_cdcdcdcdcdcdcdcd', kind: 'video', name: 'demo.mp4', mimeType: 'video/mp4' }]
  });
  const calls = [];
  const provider = {
    id: 'apimart',
    name: 'APIMART',
    enabled: true,
    protocol: 'apimart',
    api_key: 'fixture-key-never-sent',
    base_url: 'https://api.apimart.ai/v1',
    chat_models: ['gemini-3.6-flash']
  };
  const router = canvasRoutes({
    outputRoot,
    agentSessionService: sessionService,
    agentRunService: {},
    agentMaterialStore: materialStore,
    canvasConfig: { primaryProviderId: 'apimart', providers: [provider] },
    agentVideoAnalysisFetch: async (url, options) => {
      calls.push({ kind: 'video', url, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: { candidates: [{ content: { role: 'model', parts: [{ text: '00:00 产品在桌面旋转展示。' }] } }] },
          usageMetadata: { totalTokenCount: 21 }
        })
      };
    },
    agentSessionChatTransport: async input => {
      calls.push({ kind: 'agent', input });
      assert.match(input.messages.at(-1).content, /产品在桌面旋转展示/);
      assert.equal(input.tools.some(tool => tool?.function?.name === 'ask_user_questions'), true, '视频分析不能替换原 AGENT 工具链');
      return { text: '视频展示了桌面上的产品。', usage: { total_tokens: 15 } };
    }
  });

  await withServer(router, async baseUrl => {
    const blocked = await requestJson(baseUrl, `/api/canvas/agent-sessions/${session.id}/respond`, {
      requestId: 'request-video-native-unconfirmed',
      triggerMessageEventId: 'event-video-message',
      providerId: 'apimart',
      model: 'gemini-3.6-flash'
    });
    assert.equal(blocked.status, 409);
    assert.equal(calls.length, 0);

    const approved = await requestJson(baseUrl, `/api/canvas/agent-sessions/${session.id}/respond`, {
      requestId: 'request-video-native-confirmed',
      triggerMessageEventId: 'event-video-message',
      providerId: 'apimart',
      model: 'gemini-3.6-flash',
      videoAnalysisConfirmed: true
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(calls.map(call => call.kind), ['video', 'agent']);
    assert.equal(calls[0].url, 'https://api.apimart.ai/v1beta/models/gemini-3.6-flash:generateContent');
    assert.equal(calls[0].body.contents[0].parts[0].inlineData.mimeType, 'video/mp4');
    assert.match(calls[0].body.contents[0].parts[0].inlineData.data, /^[A-Za-z0-9+/=]+$/);
  });
});

test('切换模型后旧历史附件不可用不会阻断当前消息', async () => {
  const contexts = [];
  const state = fixture({
    historyMessages: [{
      eventId: 'event-legacy-unregistered-material',
      content: '旧版本消息',
      attachments: [{ assetId: 'material_eeeeeeeeeeeeeeee', kind: 'image', name: '旧产品.png' }]
    }],
    userContent: '这是切换模型后的新消息',
    messageContent: (message, context) => {
      contexts.push({ eventId: message.eventId, historical: context.historical });
      if (message.eventId === 'event-legacy-unregistered-material' && context.historical !== true) {
        throw new Error('旧历史附件错误地按当前消息处理');
      }
      return message.content;
    }
  });
  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody({
      model: 'fixture-chat-model-2'
    }));
    assert.equal(response.status, 200);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].model, 'fixture-chat-model-2');
    assert.deepEqual(contexts, [
      { eventId: 'event-legacy-unregistered-material', historical: true },
      { eventId: 'event-user-chat-message', historical: false }
    ]);
  });
});

function respondBody(overrides = {}) {
  return {
    requestId: 'request-session-respond',
    triggerMessageEventId: 'event-user-chat-message',
    providerId: 'fixture-chat',
    model: 'fixture-chat-model',
    ...overrides
  };
}

test('M5：未选 Skill 也用显式 Provider/模型回复，并把 assistant 原子写回同一 Session', async () => {
  const state = fixture();
  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.providerId, 'fixture-chat');
    assert.equal(body.model, 'fixture-chat-model');
    assert.equal(body.message.role, 'assistant');
    assert.deepEqual(body.message.modelBinding, {
      providerId: 'fixture-chat',
      model: 'fixture-chat-model',
      usage: { total_tokens: 12 }
    });
    assert.equal(body.session.id, state.session.id);
    assert.equal(body.session.messages.at(-1).content, '这是同一 AgentSession 中的普通文字回复。');
    assert.deepEqual(body.session.toolRuns, []);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].messages.at(-1).content, '先和我普通聊聊，不要生成媒体');
    const restarted = createAgentSessionService({ outputRoot: state.outputRoot });
    assert.deepEqual(restarted.loadSession(state.session.id).messages.at(-1).modelBinding, body.message.modelBinding);
  });
});

test('M8：结构化提问工具在右栏形成可恢复问题集，提交后沿用同一 AgentSession 继续回复', async () => {
  let callCount = 0;
  const state = fixture({
    userContent: '帮我做一条啤酒广告，先按 Skill 把关键信息问清楚',
    transport: async input => {
      state.calls.push(input);
      callCount += 1;
      if (callCount === 1) {
        return {
          toolCalls: [{
            id: 'provider-ask-creative-brief',
            name: 'ask_user_questions',
            arguments: JSON.stringify({
              title: '啤酒广告 · 快速确认',
              submit_label: '继续',
              questions: [{
                question_id: 'product-name',
                title: '产品信息',
                prompt: '啤酒品牌或产品名称是什么？',
                type: 'text',
                required: true,
                placeholder: '请输入品牌或产品名称'
              }, {
                question_id: 'creative-direction',
                title: '视频方向',
                prompt: '更想要哪一种广告方向？',
                type: 'single',
                required: true,
                allow_custom: true,
                choices: [{ value: 'story', label: '剧情带货', description: '用人物冲突带出卖点' }, { value: 'brand', label: '品牌氛围片' }]
              }]
            })
          }]
        };
      }
      return { text: '收到，你选择了剧情带货方向；我会继续在同一对话中完善创意。' };
    }
  });

  await withServer(state.router, async baseUrl => {
    const pathname = `/api/canvas/agent-sessions/${state.session.id}/respond`;
    const first = await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-structured-question' }));
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(callCount, 1);
    assert.deepEqual(state.calls[0].tools.map(item => item.function.name), [
      'ask_user_questions',
      'plan_media_generation',
      'create_image',
      'create_video',
      'create_audio'
    ]);
    assert.equal(body.message.kind, 'question');
    assert.equal(body.message.structuredQuestion.schemaVersion, 1);
    assert.match(body.message.structuredQuestion.id, /^agent-question-/);
    assert.equal(body.message.structuredQuestion.title, '啤酒广告 · 快速确认');
    assert.equal(body.message.structuredQuestion.submitLabel, '继续');
    assert.equal(body.message.structuredQuestion.questions.length, 2);
    assert.equal(body.message.structuredQuestion.questions[1].allowCustom, true);
    assert.deepEqual(body.session.generationRounds, []);
    assert.deepEqual(body.session.toolRuns, []);

    const replay = await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-structured-question' }));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
    assert.equal(callCount, 1, '问题集重放不得再次调用文字 Provider');

    const restarted = createAgentSessionService({ outputRoot: state.outputRoot });
    assert.deepEqual(restarted.loadSession(state.session.id).messages.at(-1).structuredQuestion, body.message.structuredQuestion);

    const answer = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/messages`, {
      requestId: 'request-structured-answer',
      eventId: 'event-structured-answer',
      role: 'user',
      kind: 'choice',
      content: '产品信息：夜航麦浪\n视频方向：剧情带货',
      structuredAnswer: {
        questionSetId: body.message.structuredQuestion.id,
        questionEventId: body.message.eventId,
        answers: [{ questionId: 'product-name', values: ['夜航麦浪'], customText: '', skipped: false }, { questionId: 'creative-direction', values: ['story'], customText: '', skipped: false }]
      }
    });
    assert.equal(answer.status, 200);
    const answered = await answer.json();
    assert.equal(answered.session.messages.at(-1).structuredAnswer.questionSetId, body.message.structuredQuestion.id);

    const continued = await requestJson(baseUrl, pathname, respondBody({
      requestId: 'request-after-structured-answer',
      triggerMessageEventId: 'event-structured-answer'
    }));
    assert.equal(continued.status, 200);
    const continuedBody = await continued.json();
    assert.equal(callCount, 2);
    assert.equal(continuedBody.session.id, state.session.id);
    assert.match(continuedBody.message.content, /同一对话/);
    assert.ok(state.calls[1].messages.some(message => message.role === 'assistant' && /啤酒广告 · 快速确认/.test(message.content)));
    assert.ok(state.calls[1].messages.some(message => message.role === 'user' && /夜航麦浪/.test(message.content)));
    assert.deepEqual(continuedBody.session.generationRounds, []);
    assert.deepEqual(continuedBody.session.toolRuns, []);
  });
});

test('Skill 路线比较误输出 Markdown 时只纠正一次并形成结构化问题卡', async () => {
  const routeText = [
    '### 路线比较（请选择或微调）',
    '#### 路线 A：老板盲测',
    '#### 路线 B：28 天风味倒计时',
    '请告诉我：你更喜欢路线 A 还是路线 B？'
  ].join('\n');
  const state = fixture({
    skillId: 'fixture-instruction-skill',
    findSkill: id => id === 'fixture-instruction-skill' ? {
      id,
      displayName: 'Fixture Instruction Skill',
      description: '比较创意路线并让用户确认',
      capabilities: { instructionOnly: true, executable: false },
      stages: []
    } : null,
    transport: async input => {
      state.calls.push(input);
      if (state.calls.length === 1) return { text: routeText, usage: { total_tokens: 20 } };
      return {
        toolCalls: [{
          id: 'provider-repair-route-choice',
          name: 'ask_user_questions',
          arguments: JSON.stringify({
            title: '选择创意路线',
            questions: [{
              question_id: 'creative-route',
              title: '创意路线',
              prompt: '你更喜欢哪一条路线？',
              type: 'single',
              required: true,
              allow_custom: true,
              choices: [{ value: 'route-a', label: '路线 A · 老板盲测' }, { value: 'route-b', label: '路线 B · 28 天风味倒计时' }]
            }]
          })
        }],
        usage: { total_tokens: 8 }
      };
    }
  });

  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody({
      requestId: 'request-route-question-repair',
      selectedSkillId: 'fixture-instruction-skill'
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(state.calls.length, 2);
    assert.equal(state.calls[0].toolChoice, undefined);
    assert.deepEqual(state.calls[1].tools.map(item => item.function.name), ['ask_user_questions']);
    assert.deepEqual(state.calls[1].toolChoice, { type: 'function', function: { name: 'ask_user_questions' } });
    assert.match(state.calls[1].messages.at(-1).content, /把上面的选择要求改为一次 ask_user_questions/);
    assert.equal(body.message.kind, 'question');
    assert.equal(body.message.content, routeText);
    assert.equal(body.message.structuredQuestion.title, '选择创意路线');
    assert.equal(body.message.structuredQuestion.questions[0].choices.length, 2);
    assert.equal(body.message.modelBinding.usage.total_tokens, 28);
    assert.deepEqual(body.session.generationRounds, []);
    assert.deepEqual(body.session.toolRuns, []);
  });
});

test('M5E-3：一条消息的十张图片只形成一个 GenerationRound，重放不再次调用 Provider', async () => {
  const state = fixture({
    userContent: '生成十张互相独立的商品图',
    mediaDefaults: { autoGenerateMedia: true },
    transport: async input => {
      state.calls.push(input);
      return {
        toolCalls: [{
          id: 'provider-plan-10-images',
          name: 'plan_media_generation',
          arguments: JSON.stringify({
            items: Array.from({ length: 10 }, (_unused, index) => ({
              item_id: `product-image-${index + 1}`,
              stage_id: 'product-assets',
              kind: 'image',
              prompt: `商品图 ${index + 1}`
            }))
          })
        }]
      };
    }
  });
  await withServer(state.router, async baseUrl => {
    const pathname = `/api/canvas/agent-sessions/${state.session.id}/respond`;
    const response = await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-media-tool-response' }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(state.calls.length, 1);
    assert.deepEqual(state.calls[0].tools.map(item => item.function.name), ['ask_user_questions', 'plan_media_generation', 'create_image', 'create_video', 'create_audio']);
    const planTool = state.calls[0].tools.find(item => item.function.name === 'plan_media_generation').function;
    assert.match(planTool.description, /直接列全当前镜头实际需要的资产图、分镜图、逐镜图和首尾帧/);
    assert.match(planTool.parameters.properties.items.items.properties.depends_on.description, /first_frame、last_frame/);
    assert.equal(body.generationRound.mode, 'automatic');
    assert.equal(body.generationRound.status, 'awaiting-approval');
    assert.equal(body.generationRound.items.length, 10);
    assert.equal(new Set(body.generationRound.items.map(item => item.itemId)).size, 10);
    assert.ok(body.generationRound.items.every(item => item.kind === 'image' && item.quantity === 1));
    assert.ok(body.generationRound.items.every(item => item.provider === 'fixture-apimart' && item.model === 'gpt-image-2'));
    assert.deepEqual(body.session.toolRuns, []);
    assert.equal(body.message.attachments[0].assetId, body.generationRound.roundId);
    assert.equal(body.message.attachments[0].kind, 'agent-generation-round');

    const replay = await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-media-tool-response' }));
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.idempotent, true);
    assert.equal(state.calls.length, 1, '重放不得再次调用文字 Provider');
    assert.equal(replayBody.generationRound.roundId, body.generationRound.roundId);
    assert.equal(state.sessionService.loadSession(state.session.id).generationRounds.length, 1);
    assert.deepEqual(state.sessionService.loadSession(state.session.id).toolRuns, []);
  });
});

test('M6：用户明确要求短文本配音时，文字模型可规划 audio 并只注入已保存的 TTS 设置', async () => {
  const state = fixture({
    userContent: '把“你好，Lavans”生成一段配音',
    transport: async input => {
      state.calls.push(input);
      return {
        toolCalls: [{
          id: 'provider-plan-audio',
          name: 'create_audio',
          arguments: JSON.stringify({ prompt: '你好，Lavans' })
        }]
      };
    }
  });
  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody({ requestId: 'request-audio-response' }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.generationRound.items.length, 1);
    const item = body.generationRound.items[0];
    assert.equal(item.stageId, 'audio-generation');
    assert.equal(item.kind, 'audio');
    assert.equal(item.prompt, '你好，Lavans');
    assert.equal(item.provider, 'fixture-apimart');
    assert.equal(item.model, 'gpt-4o-mini-tts');
    assert.deepEqual(item.spec, { voice: 'alloy', format: 'wav', speed: 1 });
    assert.equal(item.quantity, 1);
    assert.deepEqual(item.dependsOn, []);
    assert.equal(item.status, 'planned');
    assert.match(body.message.content, /音频 1 项/);
  });
});

test('M5E-3：参考图片生成视频只规划视频项，并把参考绑定写入同一 Round', async () => {
  const state = fixture({
    userContent: '用这只猫的参考图生成小猫奔跑的视频',
    transport: async input => {
      state.calls.push(input);
      return {
        toolCalls: [{
          id: 'provider-plan-reference-video',
          name: 'plan_media_generation',
          arguments: JSON.stringify({ items: [{
            item_id: 'cat-running-video',
            stage_id: 'video-generation',
            kind: 'video',
            prompt: '小猫向前奔跑，镜头跟随',
            use_selected_image: true
          }] })
        }]
      };
    }
  });
  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, respondBody({
      requestId: 'request-reference-video-response',
      selectedImageNodeId: 'node-source-image-1',
      selectedImageIndex: 0
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.generationRound.items.length, 1);
    assert.equal(body.generationRound.items[0].kind, 'video');
    assert.equal(body.generationRound.items[0].spec.sourceNodeId, 'node-source-image-1');
    assert.equal(body.generationRound.items[0].spec.sourceImageIndex, 0);
    assert.equal(body.generationRound.items[0].provider, 'fixture-apimart');
    assert.equal(body.generationRound.items[0].model, 'seedance-2.0');
    assert.deepEqual(body.session.toolRuns, []);
    assert.match(state.calls[0].messages[1].content, /只能包含 video item/);
    const videoTool = state.calls[0].tools.find(item => item.function.name === 'create_video');
    assert.equal(videoTool.function.parameters.properties.use_selected_image.type, 'boolean');
  });

  const blocked = fixture({
    userContent: '用这只猫的参考图生成小猫奔跑的视频',
    transport: async () => ({
      text: '错误地准备图片',
      toolCalls: [{ id: 'wrong-tool', name: 'create_image', arguments: JSON.stringify({ prompt: '重新生成猫图' }) }]
    })
  });
  await withServer(blocked.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${blocked.session.id}/respond`, respondBody({
      requestId: 'request-block-wrong-reference-tool',
      selectedImageNodeId: 'node-source-image-1'
    }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'AGENT_REFERENCE_VIDEO_TOOL_MISMATCH');
  });
  const blockedSession = blocked.sessionService.loadSession(blocked.session.id);
  assert.deepEqual(blockedSession.toolRuns, [], '错误图片计划必须在媒体任务和节点前被阻断');
  assert.equal(blockedSession.generationRounds.length, 0);
  assert.equal(blockedSession.messages.at(-1).kind, 'failure-recovery');
});

test('M5E-3：非法计划失败闭合，同 requestId 不重调 Provider，后续消息不继承旧失败请求', async () => {
  let callCount = 0;
  const state = fixture({
    userContent: '生成两张图，但模型返回一份非法重复计划',
    transport: async input => {
      state.calls.push(input);
      callCount += 1;
      if (callCount === 1) {
        return {
          toolCalls: [{
            name: 'plan_media_generation',
            arguments: JSON.stringify({ items: [
              { item_id: 'duplicate-image', stage_id: 'assets', kind: 'image', prompt: '图一' },
              { item_id: 'duplicate-image', stage_id: 'assets', kind: 'image', prompt: '图二' }
            ] })
          }]
        };
      }
      return { text: '新的普通对话已经独立处理。' };
    }
  });
  await withServer(state.router, async baseUrl => {
    const pathname = `/api/canvas/agent-sessions/${state.session.id}/respond`;
    const first = await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-invalid-media-plan' }));
    assert.notEqual(first.status, 200);
    const afterFailure = state.sessionService.loadSession(state.session.id);
    assert.equal(afterFailure.messages.at(-1).kind, 'failure-recovery');
    assert.equal(afterFailure.messages.at(-1).attachments[0].kind, 'agent-generation-plan-failure');
    assert.equal(afterFailure.generationRounds.length, 0);
    assert.deepEqual(afterFailure.toolRuns, []);

    const replay = await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-invalid-media-plan' }));
    assert.notEqual(replay.status, 200);
    assert.equal(callCount, 1, '失败重放不得再次调用文字 Provider');

    state.sessionService.appendMessage(state.session.id, {
      requestId: 'request-second-user-message',
      eventId: 'event-second-user-message',
      role: 'user',
      kind: 'text',
      content: '现在只进行普通聊天'
    });
    const second = await requestJson(baseUrl, pathname, respondBody({
      requestId: 'request-second-response',
      triggerMessageEventId: 'event-second-user-message'
    }));
    assert.equal(second.status, 200);
    assert.equal(callCount, 2);
    const secondHistory = state.calls[1].messages.map(message => message.content);
    assert.ok(secondHistory.includes('现在只进行普通聊天'));
    assert.ok(!secondHistory.includes('生成两张图，但模型返回一份非法重复计划'));
  });
});

test('M5：同 requestId 同绑定重放不再次调用 Provider，同 requestId 漂移返回 409', async () => {
  const state = fixture();
  await withServer(state.router, async baseUrl => {
    const pathname = `/api/canvas/agent-sessions/${state.session.id}/respond`;
    assert.equal((await requestJson(baseUrl, pathname, respondBody())).status, 200);
    const replayResponse = await requestJson(baseUrl, pathname, respondBody());
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent, true);
    assert.equal(state.calls.length, 1);
    assert.equal(replay.session.messages.filter(message => message.role === 'assistant').length, 1);

    const conflictResponse = await requestJson(baseUrl, pathname, respondBody({ model: 'fixture-chat-model-2' }));
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(state.calls.length, 1);

    const triggerConflict = await requestJson(baseUrl, pathname, respondBody({ triggerMessageEventId: 'event-other-user-message' }));
    assert.equal(triggerConflict.status, 409);
    assert.equal((await triggerConflict.json()).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(state.calls.length, 1);
  });
});

test('M5：并发同 requestId 合并为一次 Provider 调用', async () => {
  let release;
  let calls = 0;
  const state = fixture({
    transport: async () => {
      calls += 1;
      await new Promise(resolve => { release = resolve; });
      return { text: '并发只生成一次' };
    }
  });
  await withServer(state.router, async baseUrl => {
    const pathname = `/api/canvas/agent-sessions/${state.session.id}/respond`;
    const first = requestJson(baseUrl, pathname, respondBody());
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const second = requestJson(baseUrl, pathname, respondBody());
    await new Promise(resolve => setImmediate(resolve));
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(calls, 1);
    assert.equal(state.sessionService.loadSession(state.session.id).messages.filter(message => message.role === 'assistant').length, 1);
  });
});

test('M5：Provider/模型严格校验且 cancelled Session 在 transport 前拒绝', async () => {
  const state = fixture();
  await withServer(state.router, async baseUrl => {
    const pathname = `/api/canvas/agent-sessions/${state.session.id}/respond`;
    assert.equal((await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-unknown-provider', providerId: 'missing-provider' }))).status, 409);
    assert.equal((await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-disabled-provider', providerId: 'fixture-disabled' }))).status, 409);
    assert.equal((await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-unknown-model', model: 'missing-model' }))).status, 409);
    assert.equal(state.calls.length, 0);

    state.sessionService.setStatus(state.session.id, { requestId: 'request-cancel-chat-session', status: 'cancelled' });
    const cancelled = await requestJson(baseUrl, pathname, respondBody({ requestId: 'request-cancelled-response' }));
    assert.equal(cancelled.status, 409);
    assert.equal((await cancelled.json()).code, 'SESSION_CANCELLED');
    assert.equal(state.calls.length, 0);
  });
});

test('M5：Provider 失败保留 user 且不伪造 assistant；instruction-only Skill 只进入系统上下文', async () => {
  const failed = fixture({ transport: async () => { throw new Error('fixture provider failed'); } });
  await withServer(failed.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${failed.session.id}/respond`, respondBody());
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'AGENT_CHAT_PROVIDER_FAILED');
    const session = failed.sessionService.loadSession(failed.session.id);
    assert.equal(session.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(session.messages.filter(message => message.role === 'assistant').length, 0);
  });

  const skillCalls = [];
  const skill = fixture({
    skillId: 'fixture-instruction-skill',
    findSkill: id => id === 'fixture-instruction-skill' ? {
      id,
      displayName: 'Fixture Instruction Skill',
      description: '只提供文字建议',
      capabilities: { instructionOnly: true, executable: false },
      stages: [{ id: 'paid-media', title: '付费媒体', summary: '需要独立审批' }]
    } : null,
    transport: async input => {
      skillCalls.push(input);
      return { text: '只提供建议，不执行 Skill。' };
    }
  });
  await withServer(skill.router, async baseUrl => {
    const response = await requestJson(baseUrl, `/api/canvas/agent-sessions/${skill.session.id}/respond`, respondBody({
      selectedSkillId: 'fixture-instruction-skill'
    }));
    assert.equal(response.status, 200);
    assert.equal(skillCalls.length, 1);
    assert.match(skillCalls[0].messages[1].content, /不得执行其工具、脚本、阶段或任何付费媒体操作/);
    assert.match(skillCalls[0].messages[1].content, /只提供文字建议/);
    assert.deepEqual(skill.sessionService.loadSession(skill.session.id).toolRuns, []);
  });
});
