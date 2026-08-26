'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createAgentSessionService } = require('../services/agentSessionService');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');
const { sha256 } = require('../services/canvasAgentFoundation/atomicJsonStore');
const createCanvasRoutes = require('../routes/canvasRoutes');

function createService(rootPath, seed = 0) {
  let tick = 20_000 + seed;
  let sequence = seed;
  return createAgentSessionService({
    rootPath,
    clock: () => ++tick,
    makeId: prefix => `${prefix}-${++sequence}`
  });
}

function createSession(service, suffix = '1') {
  return service.createSession({
    requestId: `create-session-${suffix}`,
    canvasId: `canvas-history-${suffix}`,
    workspaceScope: 'canvas-agent',
    mode: 'generation',
    title: '持续聊天'
  }).session;
}

function historyRef(eventId, salt = eventId) {
  return { eventId, artifactVersionId: `history-${eventId}`, contentHash: sha256(salt) };
}

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

test('M3B：新消息与 pending 同次原子保存，eventId 不能由另一 requestId 重用', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-history-outbox-'));
  const service = createService(rootPath);
  const session = createSession(service, 'outbox');
  service.setStatus(session.id, {
    requestId: 'set-completed-before-message',
    status: 'completed',
    composerDraft: '保留草稿',
    unreadBoundary: 'message-before',
    currentPhase: 'delivery'
  });
  const input = {
    requestId: 'append-message-outbox',
    eventId: 'event-outbox-1',
    role: 'user',
    kind: 'text',
    content: '继续调整片尾'
  };
  const appended = service.appendMessage(session.id, input);
  assert.equal(appended.session.status, 'collecting');
  assert.equal(appended.session.composerDraft, '保留草稿');
  assert.equal(appended.session.unreadBoundary, 'message-before');
  assert.equal(appended.session.currentPhase, 'delivery');
  assert.equal(appended.session.messages[0].historyMirror.status, 'pending');

  const storePath = path.join(rootPath, 'sessions.json');
  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(persisted.sessions[0].messages[0].content, input.content);
  assert.equal(persisted.sessions[0].messages[0].historyMirror.status, 'pending');
  assert.equal(service.appendMessage(session.id, input).idempotent, true);
  assert.equal(service.loadSession(session.id).messages.length, 1);

  const beforeConflict = fs.readFileSync(storePath);
  assert.throws(
    () => service.appendMessage(session.id, { ...input, requestId: 'another-request-same-event' }),
    error => error?.code === 'SESSION_EVENT_CONFLICT' && error?.statusCode === 409
  );
  assert.deepEqual(fs.readFileSync(storePath), beforeConflict);
});

test('M3B：专用 mirrored 确认只更新目标消息，不覆盖较新的聊天状态', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-history-ack-'));
  const service = createService(rootPath, 100);
  const session = createSession(service, 'ack');
  service.appendMessage(session.id, {
    requestId: 'append-message-ack',
    eventId: 'event-ack-1',
    role: 'assistant',
    kind: 'document',
    content: '剧本文档留在聊天'
  });
  const newer = service.setStatus(session.id, {
    requestId: 'newer-chat-state',
    status: 'paused',
    composerDraft: '稍后继续输入',
    unreadBoundary: 'event-ack-1',
    currentPhase: 'script-review'
  }).session;
  const ref = historyRef('event-ack-1');
  const marked = service.markMessageHistoryMirrored(session.id, 'event-ack-1', ref);
  assert.equal(marked.idempotent, false);
  assert.equal(marked.session.status, 'paused');
  assert.equal(marked.session.composerDraft, '稍后继续输入');
  assert.equal(marked.session.unreadBoundary, 'event-ack-1');
  assert.equal(marked.session.currentPhase, 'script-review');
  assert.equal(marked.session.revision, newer.revision);
  assert.deepEqual(marked.session.messages[0].historyMirror, { status: 'mirrored', historyRef: ref });
  assert.deepEqual(marked.session.historyRefs, [ref]);
  assert.equal(service.markMessageHistoryMirrored(session.id, 'event-ack-1', ref).idempotent, true);

  const storePath = path.join(rootPath, 'sessions.json');
  const beforeConflict = fs.readFileSync(storePath);
  assert.throws(
    () => service.markMessageHistoryMirrored(session.id, 'event-ack-1', historyRef('event-ack-1', 'different-ref')),
    error => error?.code === 'SESSION_HISTORY_REF_CONFLICT' && error?.statusCode === 409
  );
  assert.deepEqual(fs.readFileSync(storePath), beforeConflict);
});

test('M3B：消息路由失败仍返回聊天，重放按原 requestId 补写而不是误用最后一条消息', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-history-route-'));
  const sessionsPath = path.join(outputRoot, '.state', 'agent-sessions', 'sessions.json');
  const calls = [];
  const failEvents = new Set(['event-route-old']);
  const foundation = {
    appendSessionEvent(event) {
      const store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      const persisted = store.sessions.find(item => item.id === event.agentSessionId)?.messages.find(item => item.eventId === event.eventId);
      calls.push({
        eventId: event.eventId,
        workspaceScope: event.workspaceScope,
        canvasId: event.canvasId,
        agentSessionId: event.agentSessionId,
        persistedStatus: persisted?.historyMirror?.status,
        payload: event.payload
      });
      if (failEvents.has(event.eventId)) {
        const error = new Error('模拟 Foundation 暂时不可用');
        error.code = 'FOUNDATION_TEMPORARY_FAILURE';
        throw error;
      }
      return { historyRef: historyRef(event.eventId), idempotent: false };
    }
  };
  const router = createCanvasRoutes({ outputRoot, canvasAgentFoundation: foundation, agentRunService: {} });

  await withServer(router, async baseUrl => {
    const created = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-create-history', canvasId: 'canvas-route-history', workspaceScope: 'canvas-agent', mode: 'generation' })
    });
    const sessionId = created.body.session.id;
    await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${sessionId}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'route-before-message', status: 'completed', composerDraft: '草稿仍在', unreadBoundary: 'before-history' })
    });
    const oldInput = {
      requestId: 'route-message-old', eventId: 'event-route-old', role: 'user', kind: 'text', content: '先保存我',
      workspaceScope: 'recolor', canvasId: 'another-canvas', agentSessionId: 'another-session'
    };
    const first = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(oldInput)
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.session.status, 'collecting');
    assert.equal(first.body.session.composerDraft, '草稿仍在');
    assert.equal(first.body.session.messages[0].historyMirror.status, 'pending');

    const newInput = { requestId: 'route-message-new', eventId: 'event-route-new', role: 'assistant', kind: 'text', content: '后来的消息' };
    const second = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(newInput)
    });
    assert.equal(second.body.session.messages.length, 2);
    assert.equal(second.body.session.messages[1].historyMirror.status, 'mirrored');

    failEvents.delete('event-route-old');
    const replayed = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(oldInput)
    });
    assert.equal(replayed.response.status, 200);
    assert.equal(replayed.body.idempotent, true);
    assert.equal(replayed.body.session.messages.length, 2);
    assert.equal(replayed.body.session.messages[0].historyMirror.status, 'mirrored');
    assert.deepEqual(calls.map(item => item.eventId), ['event-route-old', 'event-route-new', 'event-route-old']);
    assert.equal(calls.every(item => item.persistedStatus === 'pending'), true, 'Foundation 调用前消息和 pending 必须已经落盘');
    assert.equal(calls.at(-1).payload.content, oldInput.content, '重放必须定位旧 requestId 对应消息');
    assert.equal(calls.at(-1).workspaceScope, 'canvas-agent');
    assert.equal(calls.at(-1).canvasId, 'canvas-route-history');
    assert.equal(calls.at(-1).agentSessionId, sessionId);
    assert.deepEqual(Object.keys(calls.at(-1).payload).sort(), ['attachments', 'content', 'createdAt', 'kind', 'messageId', 'requestId', 'role']);
  });
});

test('M3B：Foundation 已落盘但确认失败时，重启 GET 用同 eventId 收敛且不重复 Artifact', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-history-crash-'));
  const sessionRoot = path.join(outputRoot, '.state', 'agent-sessions');
  const foundationRoot = path.join(outputRoot, 'foundation-history');
  const foundation = createCanvasAgentFoundation({ rootPath: foundationRoot });
  const service = createService(sessionRoot, 200);
  const session = createSession(service, 'crash');
  let failAck = true;
  const failingAckService = {
    ...service,
    markMessageHistoryMirrored(...args) {
      if (failAck) throw Object.assign(new Error('模拟确认写入前崩溃'), { code: 'ACK_CRASH' });
      return service.markMessageHistoryMirrored(...args);
    }
  };
  const firstRouter = createCanvasRoutes({ outputRoot, canvasAgentFoundation: foundation, agentSessionService: failingAckService, agentRunService: {} });
  await withServer(firstRouter, async baseUrl => {
    const response = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'message-before-ack-crash', eventId: 'event-before-ack-crash', role: 'assistant', kind: 'document', content: '已写聊天和 Foundation，尚未确认' })
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.body.session.messages[0].historyMirror.status, 'pending');
  });
  assert.equal(foundation.artifactStore.list({ canvasId: session.canvasId, artifactType: 'agent-session-event' }).length, 1);

  failAck = false;
  const restarted = createService(sessionRoot, 300);
  const secondRouter = createCanvasRoutes({ outputRoot, canvasAgentFoundation: foundation, agentSessionService: restarted, agentRunService: {} });
  await withServer(secondRouter, async baseUrl => {
    const recovered = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${session.id}`);
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.session.messages[0].historyMirror.status, 'mirrored');
    assert.equal(recovered.body.session.messages[0].content, '已写聊天和 Foundation，尚未确认');
  });
  assert.equal(foundation.artifactStore.list({ canvasId: session.canvasId, artifactType: 'agent-session-event' }).length, 1);
});

test('M3B：重启时显式损坏或错绑的镜像引用回到 pending，真正旧消息才是 legacy-untracked', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-history-tamper-'));
  const sessionRoot = path.join(outputRoot, '.state', 'agent-sessions');
  const service = createService(sessionRoot, 350);
  const session = createSession(service, 'tamper');
  const eventIds = ['event-tamper-swapped', 'event-tamper-hash', 'event-tamper-extra'];
  eventIds.forEach((eventId, index) => {
    service.appendMessage(session.id, {
      requestId: `message-tamper-${index + 1}`,
      eventId,
      role: index === 1 ? 'assistant' : 'user',
      kind: 'text',
      content: `保留聊天 ${index + 1}`
    });
    service.markMessageHistoryMirrored(session.id, eventId, historyRef(eventId));
  });

  const storePath = path.join(sessionRoot, 'sessions.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const messages = store.sessions[0].messages;
  messages[0].historyMirror.historyRef = { ...messages[1].historyMirror.historyRef };
  messages[1].historyMirror.historyRef.contentHash = 'f'.repeat(64);
  messages[2].historyMirror.historyRef.untrusted = 'must-be-removed';
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);

  const restarted = createService(sessionRoot, 375);
  const normalized = restarted.loadSession(session.id);
  assert.equal(normalized.messages[0].historyMirror.status, 'pending');
  assert.equal(normalized.messages[1].historyMirror.status, 'pending');
  assert.deepEqual(normalized.messages[2].historyMirror, {
    status: 'mirrored',
    historyRef: historyRef('event-tamper-extra')
  });

  const calls = [];
  const unavailableFoundation = {
    appendSessionEvent(event) {
      calls.push(event.eventId);
      throw Object.assign(new Error('模拟恢复时 Foundation 不可用'), { code: 'FOUNDATION_TEMPORARY_FAILURE' });
    }
  };
  const router = createCanvasRoutes({
    outputRoot,
    canvasAgentFoundation: unavailableFoundation,
    agentSessionService: restarted,
    agentRunService: {}
  });
  await withServer(router, async baseUrl => {
    const loaded = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${session.id}`);
    assert.equal(loaded.response.status, 200);
    assert.deepEqual(loaded.body.session.messages.map(message => message.content), ['保留聊天 1', '保留聊天 2', '保留聊天 3']);
    assert.deepEqual(loaded.body.session.messages.map(message => message.historyMirror.status), ['pending', 'pending', 'mirrored']);
  });
  assert.deepEqual(calls, ['event-tamper-swapped', 'event-tamper-hash']);
});

test('M3B：损坏的 Foundation 历史不阻断聊天读取，旧消息也不会自动全量回灌', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-history-corrupt-'));
  const sessionRoot = path.join(outputRoot, '.state', 'agent-sessions');
  const foundation = createCanvasAgentFoundation({ rootPath: path.join(outputRoot, 'foundation-history') });
  const service = createService(sessionRoot, 400);
  const session = createSession(service, 'corrupt');
  const eventInput = { requestId: 'message-corrupt-history', eventId: 'event-corrupt-history', role: 'user', kind: 'text', content: '聊天必须继续可读' };
  service.appendMessage(session.id, eventInput);
  const mirrored = foundation.appendSessionEvent({
    workspaceScope: 'canvas-agent', canvasId: session.canvasId, agentSessionId: session.id,
    eventId: eventInput.eventId, eventType: 'message',
    payload: { messageId: service.loadSession(session.id).messages[0].id, requestId: eventInput.requestId, role: eventInput.role, kind: eventInput.kind, content: eventInput.content, attachments: [], createdAt: service.loadSession(session.id).messages[0].createdAt }
  });
  fs.writeFileSync(path.join(foundationRootOf(foundation), mirrored.artifact.contentPath), 'tampered-history');

  const router = createCanvasRoutes({ outputRoot, canvasAgentFoundation: foundation, agentSessionService: createService(sessionRoot, 500), agentRunService: {} });
  await withServer(router, async baseUrl => {
    const loaded = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${session.id}`);
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.success, true);
    assert.equal(loaded.body.session.messages[0].content, eventInput.content);
    assert.equal(loaded.body.session.messages[0].historyMirror.status, 'pending');
  });

  const storePath = path.join(sessionRoot, 'sessions.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  delete store.sessions[0].messages[0].historyMirror;
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
  let legacyMirrorCalls = 0;
  const legacyFoundation = { appendSessionEvent() { legacyMirrorCalls += 1; throw new Error('不应调用'); } };
  const legacyRouter = createCanvasRoutes({ outputRoot, canvasAgentFoundation: legacyFoundation, agentSessionService: createService(sessionRoot, 600), agentRunService: {} });
  await withServer(legacyRouter, async baseUrl => {
    const loaded = await jsonRequest(`${baseUrl}/api/canvas/agent-sessions/${session.id}`);
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.session.messages[0].historyMirror.status, 'legacy-untracked');
  });
  assert.equal(legacyMirrorCalls, 0);
});

function foundationRootOf(foundation) {
  return path.join(foundation.rootPath, 'artifacts');
}
