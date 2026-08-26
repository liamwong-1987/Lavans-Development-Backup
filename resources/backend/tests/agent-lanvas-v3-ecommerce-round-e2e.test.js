'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const canvasRoutes = require('../routes/canvasRoutes');
const { createAgentSkillImportService } = require('../services/agentSkillImportService');
const { createAgentSkillCompositionService } = require('../services/agentSkillCompositionService');
const { createAgentSessionService } = require('../services/agentSessionService');

const SKILL_ID = 'ecommerce-video-director-m7b';
const BRAINSTORM_ID = 'brainstorming-obra-share-m7b';
const BRAINSTORM_FILES = Object.freeze({
  'SKILL.md': `---
name: 头脑风暴 M8R
slug: ${BRAINSTORM_ID}
version: 1.0.0
description: verified creative-discovery dependency fixture
---
# 头脑风暴
比较至少两条创意路线，给出明确推荐，并在用户确认创意蓝图后才允许进入正式生产。
`
});
const SKILL_FILES = Object.freeze({
  'SKILL.md': `---
name: 电商带货 M7B
slug: ${SKILL_ID}
version: 1.7.0
description: M7B verified instruction-only fixture
---
# 电商带货 M7B
必须先读取 references/core-instructions.md。正式生产前完成创意蓝图；文档留在聊天，媒体才进入计划。
`,
  'references/core-instructions.md': '# 核心指令\n能力模式：对话规划，不执行 Skill 包代码。\n',
  'references/creative-discovery.md': '# 创意蓝图\n必须调用独立头脑风暴 Skill 比较创意路线，在持续聊天中确认。找不到时报告 BRAINSTORM_SKILL_UNAVAILABLE 并暂停正式生产。\n',
  'references/process-flow.md': '# 执行阶段流程\nCreative Discovery；Phase 0；Phase 1；Phase 2；Phase 3；Phase 4 纯文字剧本；Phase 5；Phase 6；Phase 7 分镜；Phase 8 资产；Phase 9；Phase 10 视频 PROMPT；Phase 11 剪辑交付。\n',
  'references/asset-workflow.md': '# 资产制备\n按剧本动态规划产品、人物、场景、道具、九宫格和关键帧，不套固定数量。\n',
  'references/model-specs.md': '# 模型规格\n超过 15 秒时拆成依赖明确的视频片段；模型与规格由 Lavans 设置锁定。\n',
  'references/prompt-delivery-contract.md': '# PROMPT 交付\n分镜和逐镜事实齐全后才规划视频。默认不生成 BGM。\n',
  'references/phase-checklist.md': '# 阶段核验\nPhase 4、Phase 7、Phase 8、Phase 10 必须在聊天中给出核验结论。\n',
  'video_api.cjs': 'globalThis.__m7bSkillScriptExecuted = true; throw new Error("M7B skill script must never execute");\n'
});

const MEDIA_DEFAULTS = Object.freeze({
  imageProviderId: 'fixture-media', imageModel: 'fixture-image', imageRatio: '9:16', imageResolution: '1K', imageQuantity: 1,
  videoProviderId: 'fixture-media', videoModel: 'fixture-video', videoRatio: '9:16', videoResolution: '480P', videoQuantity: 1,
  videoDuration: 15, autoGenerateMedia: false
});

function importSkill(outputRoot, skillId = SKILL_ID, skillFiles = SKILL_FILES) {
  const service = createAgentSkillImportService({
    outputRoot,
    makeId: () => `m7b-import-${Math.random().toString(16).slice(2)}`,
    now: () => new Date('2026-08-25T00:00:00.000Z')
  });
  const files = Object.entries(skillFiles).map(([relativePath, content]) => ({ relativePath, buffer: Buffer.from(content, 'utf8') }));
  const preview = service.preview({ files, relativePaths: files.map(file => file.relativePath) });
  return service.confirm({ importId: preview.importId, previewHash: preview.previewHash, skillId, confirm: true });
}

function createCompositionFixture(outputRoot, primary) {
  const dependency = importSkill(outputRoot, BRAINSTORM_ID, BRAINSTORM_FILES);
  const templateRoot = path.join(outputRoot, 'composition-templates');
  fs.mkdirSync(templateRoot, { recursive: true });
  const template = {
    schemaVersion: '1.0',
    templateId: 'm7b-ecommerce-with-brainstorm-v1',
    primaryMatch: {
      id: SKILL_ID,
      declaredVersion: '1.7.0',
      contentHash: primary.registration.contentHash,
      packageHash: primary.registration.packageHash,
      contextFiles: ['SKILL.md', 'references/core-instructions.md', 'references/creative-discovery.md', 'references/process-flow.md', 'references/asset-workflow.md', 'references/model-specs.md', 'references/prompt-delivery-contract.md', 'references/phase-checklist.md'],
      runtimeContract: { instructionOnly: true, executable: false }
    },
    dependencies: [{
      id: BRAINSTORM_ID,
      displayName: '头脑风暴',
      role: 'creative-discovery',
      required: true,
      declaredVersion: '1.0.0',
      entry: 'SKILL.md',
      entrySha256: crypto.createHash('sha256').update(BRAINSTORM_FILES['SKILL.md']).digest('hex'),
      contextFiles: ['SKILL.md'],
      runtimeContract: { instructionOnly: true, executable: false }
    }],
    promptOrder: ['host-safety', 'dependency:creative-discovery', 'primary'],
    limits: { maxDepth: 2, maxSkills: 4, maxContextBytes: 262144 }
  };
  fs.writeFileSync(path.join(templateRoot, 'm7b.composition.json'), `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  const service = createAgentSkillCompositionService({ outputRoot, templateRoot, now: () => new Date('2026-08-25T00:01:00.000Z') });
  service.confirm({
    primarySkillId: SKILL_ID,
    dependencySkillId: BRAINSTORM_ID,
    requestId: 'confirm-m7b-composition',
    confirm: true
  });
  return { dependency, service };
}

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

function post(baseUrl, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

function fixture(options = {}) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-m7b-ecommerce-'));
  const skillId = options.skillId || SKILL_ID;
  const imported = importSkill(outputRoot, skillId, options.skillFiles || SKILL_FILES);
  const compositionFixture = skillId === SKILL_ID ? createCompositionFixture(outputRoot, imported) : null;
  let id = 0;
  const sessionService = createAgentSessionService({ outputRoot, makeId: prefix => `${prefix}-m7b-${++id}` });
  const session = sessionService.createSession({
    requestId: 'request-m7b-session', canvasId: 'canvas-m7b', workspaceScope: 'canvas-agent', mode: 'generation', skillId
  }).session;
  sessionService.setStatus(session.id, {
    requestId: 'request-m7b-media-defaults', status: 'collecting',
    constraints: { mediaDefaults: { ...MEDIA_DEFAULTS, autoGenerateMedia: options.automatic === true } }
  });
  const calls = [];
  const responses = [...(options.responses || [])];
  const router = canvasRoutes({
    outputRoot,
    agentSessionService: sessionService,
    agentRunService: {},
    canvasConfig: {
      primaryProviderId: 'fixture-chat',
      providers: [{ id: 'fixture-chat', enabled: true, protocol: 'openai', api_key: 'fixture', base_url: 'https://fixture.invalid', chat_models: ['fixture-chat-model'] }]
    },
    agentSessionChatTransport: async input => {
      calls.push(input);
      const response = responses.shift();
      if (!response) throw new Error('M7B fake provider response exhausted');
      return response;
    },
    agentSkillCompositionService: compositionFixture?.service || undefined
  });
  return { outputRoot, imported, compositionFixture, skillId, sessionService, session, calls, router };
}

function appendUser(state, eventId, content) {
  state.sessionService.appendMessage(state.session.id, {
    requestId: `request-${eventId}`, eventId, role: 'user', kind: 'text', content
  });
}

function respond(baseUrl, state, eventId, requestId) {
  return post(baseUrl, `/api/canvas/agent-sessions/${state.session.id}/respond`, {
    requestId, triggerMessageEventId: eventId, providerId: 'fixture-chat', model: 'fixture-chat-model', selectedSkillId: state.skillId
  });
}

test('M7B：已验证的 1.7.0 指令推进聊天文档，再把动态资产与 15 秒视频锁进同一手动 Round', async t => {
  delete globalThis.__m7bSkillScriptExecuted;
  const state = fixture({ responses: [{
    text: '《视频创意蓝图》与 Phase 0–7 文档：需求、剧本、分镜表和核验结论都保留在当前聊天；确认后再规划媒体。'
  }, {
    text: 'Phase 8–11 交付：资产清单、逐镜视频 PROMPT 与最终剪辑说明均保留在本条聊天记录。',
    toolCalls: [{ name: 'plan_media_generation', arguments: JSON.stringify({ items: [
      { item_id: 'product-asset', stage_id: 'assets', kind: 'image', prompt: '真实产品资产图，无背景音乐' },
      { item_id: 'character-asset', stage_id: 'assets', kind: 'image', prompt: '人物身份资产图' },
      { item_id: 'storyboard-grid', stage_id: 'storyboard', kind: 'image', prompt: '3×3 九宫格分镜图', depends_on: [{ item_id: 'product-asset', role: 'product' }, { item_id: 'character-asset', role: 'character' }] },
      { item_id: 'hero-keyframe', stage_id: 'keyframes', kind: 'image', prompt: '主镜头高清关键帧', depends_on: [{ item_id: 'storyboard-grid', role: 'storyboard' }] },
      { item_id: 'video-slot-01', stage_id: 'video', kind: 'video', prompt: '15 秒竖屏电商视频，只含人声和画内音效', depends_on: [{ item_id: 'hero-keyframe', role: 'first_frame' }, { item_id: 'product-asset', role: 'product' }] }
    ] }) }]
  }] });
  t.after(() => fs.rmSync(state.outputRoot, { recursive: true, force: true }));
  appendUser(state, 'event-m7b-brief', '做一条 15 秒竖屏产品广告，先完成创意和剧本，不要立即生成。');

  await withServer(state.router, async baseUrl => {
    const first = await respond(baseUrl, state, 'event-m7b-brief', 'request-m7b-brief-response');
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.generationRound, null);
    assert.match(firstBody.message.content, /视频创意蓝图/);
    assert.deepEqual(firstBody.session.currentNodeRefs, []);
    assert.deepEqual(firstBody.session.toolRuns, []);

    const dependencyPrompt = state.calls[0].messages.find(message => message.role === 'system' && /\[DEPENDENCY role=creative-discovery\]/.test(message.content));
    const skillPrompt = state.calls[0].messages.find(message => message.role === 'system' && /\[PRIMARY\]/.test(message.content));
    const compositionContract = state.calls[0].messages.find(message => message.role === 'system' && /\[COMPOSITION CONTRACT\]/.test(message.content));
    assert(dependencyPrompt, 'LLM 必须先收到已验证的头脑风暴根指令');
    assert(skillPrompt, 'LLM 必须收到已验证的 Skill 指令上下文');
    assert(compositionContract, 'LLM 必须收到组合角色与生产硬门');
    assert.match(dependencyPrompt.content, /确认创意蓝图后才允许进入正式生产/);
    assert.match(skillPrompt.content, /1\.7\.0/);
    assert.match(skillPrompt.content, /BRAINSTORM_SKILL_UNAVAILABLE/);
    assert.match(skillPrompt.content, /Phase 0/);
    assert.match(skillPrompt.content, /Phase 11/);
    assert.match(compositionContract.content, /剧本、分镜表.*只作为聊天文字，不创建画布文档节点/);
    assert.doesNotMatch(skillPrompt.content, /__m7bSkillScriptExecuted|video_api\.cjs/);
    assert.equal(globalThis.__m7bSkillScriptExecuted, undefined);
    assert.equal(firstBody.session.skillComposition.dependencies[0].id, BRAINSTORM_ID);

    appendUser(state, 'event-m7b-confirm', '蓝图、剧本和分镜已确认。按计划生成全部必要资产与 15 秒视频。');
    const second = await respond(baseUrl, state, 'event-m7b-confirm', 'request-m7b-plan-response');
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.generationRound.mode, 'manual');
    assert.equal(secondBody.generationRound.status, 'awaiting-approval');
    assert.equal(secondBody.generationRound.items.length, 5);
    assert.match(secondBody.message.content, /Phase 8–11 交付/);
    assert.match(secondBody.message.content, /本轮媒体计划已建立/);
    assert.equal(secondBody.session.generationRounds.length, 1, '一轮创作只建立一个总确认 Round');
    assert.deepEqual(secondBody.session.currentNodeRefs, [], '规划阶段不得预建媒体或文档节点');
    assert.deepEqual(secondBody.session.toolRuns, [], '确认前不得建立付费媒体任务');
    assert.ok(secondBody.generationRound.items.every(item => ['image', 'video'].includes(item.kind)));
    assert.equal(secondBody.generationRound.items.find(item => item.kind === 'video').spec.duration, 15);
    assert.deepEqual(secondBody.generationRound.items.find(item => item.itemId === 'video-slot-01').dependsOn.map(item => item.itemId), ['hero-keyframe', 'product-asset']);
  });
});

test('M7B：自动模式零逐项弹窗，30 秒意图按 Skill 动态规划为两个 15 秒视频槽且默认无 BGM', async t => {
  const state = fixture({ automatic: true, responses: [{
    toolCalls: [{ name: 'plan_media_generation', arguments: JSON.stringify({ items: [
      { item_id: 'scene-anchor', stage_id: 'assets', kind: 'image', prompt: '场景锚点图' },
      { item_id: 'keyframe-a', stage_id: 'keyframes', kind: 'image', prompt: '前 15 秒首帧', depends_on: [{ item_id: 'scene-anchor', role: 'scene' }] },
      { item_id: 'video-slot-a', stage_id: 'video', kind: 'video', prompt: '第 1 段 15 秒，只有对白和环境音', depends_on: [{ item_id: 'keyframe-a', role: 'first_frame' }] },
      { item_id: 'video-slot-b', stage_id: 'video', kind: 'video', prompt: '第 2 段 15 秒，衔接上一段，只有对白和动作音效', depends_on: [{ item_id: 'video-slot-a', role: 'previous_segment' }] }
    ] }) }]
  }] });
  t.after(() => fs.rmSync(state.outputRoot, { recursive: true, force: true }));
  appendUser(state, 'event-m7b-auto', '自动完成一条 30 秒广告，按实际需要生成资产和视频，不要 BGM。');

  await withServer(state.router, async baseUrl => {
    const response = await respond(baseUrl, state, 'event-m7b-auto', 'request-m7b-auto-response');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.generationRound.mode, 'automatic');
    assert.equal(body.generationRound.items.length, 4, '节点数量必须来自本轮计划，不是固定模板');
    const videos = body.generationRound.items.filter(item => item.kind === 'video');
    assert.equal(videos.length, 2);
    assert.ok(videos.every(item => item.spec.duration === 15));
    assert.ok(videos.every(item => !/bgm|背景音乐|配乐/i.test(item.prompt)));
    assert.equal(body.session.generationRounds.length, 1);
    assert.deepEqual(body.session.toolRuns, []);
  });
});

test('M7B：只有 SKILL.md 的普通自定义 Skill 仍可安全聊天', async t => {
  const state = fixture({
    skillId: 'simple-custom-skill-m7b',
    skillFiles: { 'SKILL.md': '---\nname: Simple Custom Skill\nversion: 1.0.0\ndescription: root only\n---\n# Root-only instructions\n只做普通聊天。\n' },
    responses: [{ text: '普通自定义 Skill 已进入持续聊天。' }]
  });
  t.after(() => fs.rmSync(state.outputRoot, { recursive: true, force: true }));
  appendUser(state, 'event-m7b-simple', '你好，只聊天。');
  await withServer(state.router, async baseUrl => {
    const response = await respond(baseUrl, state, 'event-m7b-simple', 'request-m7b-simple-response');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.generationRound, null);
    assert.match(body.message.content, /持续聊天/);
    const context = state.calls[0].messages.find(message => /Root-only instructions/.test(message.content));
    assert(context);
    assert.doesNotMatch(context.content, /references\/process-flow\.md/);
  });
});
