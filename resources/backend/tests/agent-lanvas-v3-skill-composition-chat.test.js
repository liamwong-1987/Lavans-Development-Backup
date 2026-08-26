'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentSessionService } = require('../services/agentSessionService');
const { createAgentSessionChatService } = require('../services/agentSessionChatService');

const PRIMARY_ID = 'ecommerce-video-director-skill';
const COMPOSITION = Object.freeze({
  schemaVersion: '1.0',
  compositionId: `skill-composition-${'a'.repeat(32)}`,
  compositionHash: 'b'.repeat(64),
  templateId: 'ecommerce-video-director-with-brainstorming-v1',
  primary: Object.freeze({
    id: PRIMARY_ID,
    declaredVersion: '1.7.0',
    contentHash: 'c'.repeat(64),
    packageHash: 'd'.repeat(64),
    publisher: 'local-import',
    signatureStatus: 'unsigned-local'
  }),
  dependencies: Object.freeze([Object.freeze({
    id: 'brainstorming-obra-share',
    role: 'creative-discovery',
    declaredVersion: '1.0.0',
    contentHash: 'e'.repeat(64),
    packageHash: 'f'.repeat(64),
    publisher: 'local-import',
    signatureStatus: 'unsigned-local'
  })])
});

function fixture(t, options = {}) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-m8r3b-'));
  const contextRoot = path.join(outputRoot, 'contexts');
  fs.mkdirSync(contextRoot, { recursive: true });
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  const dependencyPath = path.join(contextRoot, 'brainstorming-SKILL.md');
  const primaryRootPath = path.join(contextRoot, 'ecommerce-SKILL.md');
  const primaryReferencePath = path.join(contextRoot, 'creative-discovery.md');
  const excludedScriptPath = path.join(contextRoot, 'do-not-run.js');
  fs.writeFileSync(dependencyPath, '# Brainstorm root\nDEPENDENCY_FULL_ROOT_MARKER\n', 'utf8');
  fs.writeFileSync(primaryRootPath, '# Ecommerce root\nPRIMARY_FULL_ROOT_MARKER\n', 'utf8');
  fs.writeFileSync(primaryReferencePath, '# Creative discovery\nPRIMARY_REFERENCE_MARKER\n', 'utf8');
  fs.writeFileSync(excludedScriptPath, 'EXCLUDED_SCRIPT_MARKER', 'utf8');

  let sequence = 0;
  const sessionService = createAgentSessionService({
    outputRoot,
    clock: () => 1_000 + sequence,
    makeId: prefix => `${prefix}-m8r3b-${++sequence}`
  });
  const session = sessionService.createSession({
    requestId: 'create-session-m8r3b',
    canvasId: 'canvas-m8r3b',
    workspaceScope: 'canvas-agent',
    mode: 'generation',
    skillId: options.skillId === undefined ? PRIMARY_ID : options.skillId
  }).session;
  sessionService.appendMessage(session.id, {
    requestId: 'append-user-m8r3b',
    eventId: 'event-user-m8r3b',
    role: 'user',
    kind: 'text',
    content: '先完成创意蓝图，只在聊天里回复。'
  });

  const resolution = {
    composition: COMPOSITION,
    primary: {
      runtime: { sourcePath: contextRoot, entryPath: primaryRootPath },
      contexts: [
        { relativePath: 'SKILL.md', absolutePath: primaryRootPath, size: fs.statSync(primaryRootPath).size },
        { relativePath: 'references/creative-discovery.md', absolutePath: primaryReferencePath, size: fs.statSync(primaryReferencePath).size }
      ]
    },
    dependencies: [{
      id: 'brainstorming-obra-share',
      role: 'creative-discovery',
      runtime: { sourcePath: contextRoot, entryPath: dependencyPath },
      contexts: [{ relativePath: 'SKILL.md', absolutePath: dependencyPath, size: fs.statSync(dependencyPath).size }]
    }],
    totalBytes: fs.statSync(dependencyPath).size + fs.statSync(primaryRootPath).size + fs.statSync(primaryReferencePath).size
  };
  const calls = [];
  let resolveCount = 0;
  const chatService = createAgentSessionChatService({
    agentSessionService: sessionService,
    getCanvasConfig: () => ({ providers: [{
      id: 'fixture-chat', enabled: true, protocol: 'openai', api_key: 'fixture', base_url: 'https://fixture.invalid',
      chat_models: ['fixture-chat-model']
    }] }),
    findSkill: id => id === PRIMARY_ID ? { id, displayName: 'Ecommerce', description: 'fixture' } : null,
    findSkillRuntime: () => null,
    resolveSkillComposition: id => {
      resolveCount += 1;
      if (options.resolveError) throw options.resolveError;
      return id === PRIMARY_ID ? resolution : { composition: null, primary: null, dependencies: [], totalBytes: 0 };
    },
    transport: async input => {
      calls.push(input);
      return { text: '创意蓝图已保留在聊天，不创建画布节点。', usage: { total_tokens: 21 } };
    }
  });
  return { outputRoot, sessionService, session, chatService, calls, get resolveCount() { return resolveCount; } };
}

function respond(state, requestId = 'respond-m8r3b') {
  return state.chatService.respond(state.session.id, {
    requestId,
    triggerMessageEventId: 'event-user-m8r3b',
    providerId: 'fixture-chat',
    model: 'fixture-chat-model',
    selectedSkillId: PRIMARY_ID
  });
}

test('M8R-3B：首次发送先绑定不可变组合，再按 dependency→primary→contract 顺序调用 Provider', async t => {
  const state = fixture(t);
  const result = await respond(state);
  assert.equal(state.calls.length, 1);
  const system = state.calls[0].messages.filter(message => message.role === 'system').map(message => message.content);
  const joined = system.join('\n');
  assert(system.findIndex(value => value.includes('[DEPENDENCY role=creative-discovery]')) > 0);
  assert(system.findIndex(value => value.includes('[PRIMARY]')) > system.findIndex(value => value.includes('[DEPENDENCY role=creative-discovery]')));
  assert(system.findIndex(value => value.includes('[COMPOSITION CONTRACT]')) > system.findIndex(value => value.includes('[PRIMARY]')));
  assert.match(joined, /DEPENDENCY_FULL_ROOT_MARKER/);
  assert.match(joined, /PRIMARY_FULL_ROOT_MARKER/);
  assert.match(joined, /PRIMARY_REFERENCE_MARKER/);
  assert.doesNotMatch(joined, /EXCLUDED_SCRIPT_MARKER|do-not-run\.js/);

  assert.equal(result.session.skillComposition.compositionHash, COMPOSITION.compositionHash);
  assert.equal(result.session.skillId, PRIMARY_ID);
  assert.equal(result.message.modelBinding.skillCompositionHash, COMPOSITION.compositionHash);
  assert.match(result.message.modelBinding.skillContextHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.session.toolRuns, []);
  assert.deepEqual(result.session.generationRounds, []);
  assert.deepEqual(result.session.currentNodeRefs, []);

  const restarted = createAgentSessionService({ outputRoot: state.outputRoot });
  const restored = restarted.loadSession(state.session.id);
  assert.equal(restored.schemaVersion, 4);
  assert.equal(restored.skillComposition.compositionHash, COMPOSITION.compositionHash);
  assert.deepEqual(restored.messages.at(-1).modelBinding, result.message.modelBinding);

  const replay = await respond(state);
  assert.equal(replay.idempotent, true);
  assert.equal(state.calls.length, 1, '幂等重放不得再次调用 Provider');
});

test('M8R-3B：依赖解析任一失败都在 Provider、ToolRun、Round 和节点之前闭合', async t => {
  for (const code of [
    'AGENT_SKILL_DEPENDENCY_MISSING',
    'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH',
    'AGENT_SKILL_DEPENDENCY_CYCLE',
    'AGENT_SKILL_CONTEXT_TOO_LARGE'
  ]) {
    await t.test(code, async subtest => {
      const error = Object.assign(new Error(code), { statusCode: 409, code });
      const state = fixture(subtest, { resolveError: error });
      await assert.rejects(() => respond(state, `respond-${code.toLowerCase()}`), candidate => candidate?.code === code);
      assert.equal(state.calls.length, 0);
      const stored = state.sessionService.loadSession(state.session.id);
      assert.equal(stored.messages.filter(message => message.role === 'assistant').length, 0);
      assert.equal(stored.skillComposition, null);
      assert.deepEqual(stored.toolRuns, []);
      assert.deepEqual(stored.generationRounds, []);
      assert.deepEqual(stored.currentNodeRefs, []);
    });
  }
});

test('M8R-3B：Session 已绑定后拒绝任何不同组合', t => {
  const state = fixture(t);
  const first = state.sessionService.bindSkillComposition(state.session.id, {
    requestId: 'bind-composition-first',
    composition: COMPOSITION
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.session.skillComposition.compositionHash, COMPOSITION.compositionHash);
  const replay = state.sessionService.bindSkillComposition(state.session.id, {
    requestId: 'bind-composition-second-request',
    composition: COMPOSITION
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.session.revision, first.session.revision, '相同组合不应制造空修订');
  assert.throws(() => state.sessionService.bindSkillComposition(state.session.id, {
    requestId: 'bind-composition-conflict',
    composition: { ...COMPOSITION, compositionHash: '9'.repeat(64) }
  }), error => error?.statusCode === 409 && error?.code === 'SESSION_SKILL_COMPOSITION_CONFLICT');
});

test('M8R-3B：未选 Skill 的普通聊天不解析也不绑定组合', async t => {
  const state = fixture(t, { skillId: '' });
  const result = await state.chatService.respond(state.session.id, {
    requestId: 'respond-no-skill-m8r3b',
    triggerMessageEventId: 'event-user-m8r3b',
    providerId: 'fixture-chat',
    model: 'fixture-chat-model'
  });
  assert.equal(state.resolveCount, 0);
  assert.equal(state.calls.length, 1);
  assert.equal(result.session.skillComposition, null);
  assert.deepEqual(result.message.modelBinding, {
    providerId: 'fixture-chat',
    model: 'fixture-chat-model',
    usage: { total_tokens: 21 }
  });
});

test('U1：显式选择 Skill 时拒绝未绑定该 Skill 的 Session，且不得调用 Provider', async t => {
  const state = fixture(t, { skillId: '' });
  await assert.rejects(
    () => respond(state, 'respond-u1-unbound-skill'),
    error => error?.statusCode === 409 && error?.code === 'SESSION_SKILL_CONFLICT'
  );
  assert.equal(state.resolveCount, 0);
  assert.equal(state.calls.length, 0);
  const stored = state.sessionService.loadSession(state.session.id);
  assert.equal(stored.skillId, '');
  assert.equal(stored.skillComposition, null);
  assert.deepEqual(stored.generationRounds, []);
  assert.deepEqual(stored.toolRuns, []);
});

test('U1：Skill 内交流沿用同一 Session，但不开放提问或媒体工具', async t => {
  const state = fixture(t);
  const result = await state.chatService.respond(state.session.id, {
    requestId: 'respond-u1-conversation-only',
    triggerMessageEventId: 'event-user-m8r3b',
    providerId: 'fixture-chat',
    model: 'fixture-chat-model',
    selectedSkillId: PRIMARY_ID,
    conversationOnly: true
  });
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0].tools, []);
  assert.match(state.calls[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n'), /交流模式/);
  assert.equal(result.session.id, state.session.id);
  assert.equal(result.session.skillId, PRIMARY_ID);
  assert.deepEqual(result.session.generationRounds, []);
  assert.deepEqual(result.session.toolRuns, []);
});
