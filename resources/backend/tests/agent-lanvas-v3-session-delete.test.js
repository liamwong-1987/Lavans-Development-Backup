'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentSessionService } = require('../services/agentSessionService');

function createService(rootPath, seed = 0) {
  let tick = 30_000 + seed;
  let sequence = seed;
  return createAgentSessionService({
    rootPath,
    clock: () => ++tick,
    makeId: prefix => `${prefix}-${++sequence}`
  });
}

function createSession(service, suffix) {
  return service.createSession({
    requestId: `create-${suffix}`,
    canvasId: 'canvas-session-delete',
    workspaceScope: 'canvas-agent',
    mode: 'generation',
    title: suffix
  }).session;
}

function hasCode(code, statusCode) {
  return error => error?.code === code && error?.statusCode === statusCode;
}

test('完成和空白会话可原子删除，创建回执被清理且画布与其他会话不变', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-session-delete-'));
  const sessionRoot = path.join(outputRoot, '.state', 'agent-sessions');
  const canvasPath = path.join(outputRoot, 'canvas-fixture.json');
  fs.writeFileSync(canvasPath, JSON.stringify({
    nodes: [{ id: 'node-final-video', type: 'video', data: { url: 'fixture.mp4' } }],
    connections: [{ id: 'connection-1', from: 'node-input', to: 'node-final-video' }]
  }, null, 2));
  const canvasBefore = fs.readFileSync(canvasPath);

  const service = createService(sessionRoot);
  const blank = createSession(service, 'blank');
  const completed = createSession(service, 'completed');
  const survivor = createSession(service, 'survivor');
  service.attachCurrentNode(completed.id, 'node-final-video', {
    requestId: 'attach-final-video',
    workspaceScope: 'canvas-agent',
    kind: 'video',
    finalDelivery: true
  });
  service.upsertToolRun(completed.id, 'tool-finished', {
    requestId: 'finish-tool',
    type: 'native-video',
    status: 'succeeded',
    nodeId: 'node-final-video'
  });
  service.setStatus(completed.id, { requestId: 'complete-session', status: 'completed' });

  assert.deepEqual(service.deleteSession(blank.id), { deleted: true });
  assert.deepEqual(service.deleteSession(completed.id), { deleted: true });
  assert.equal(service.loadSession(blank.id), null);
  assert.equal(service.loadSession(completed.id), null);
  assert.equal(service.loadSession(survivor.id)?.title, 'survivor');
  assert.deepEqual(fs.readFileSync(canvasPath), canvasBefore, '删除 Session 不得改写画布 nodes/connections');

  const persisted = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'sessions.json'), 'utf8'));
  assert.deepEqual(persisted.sessions.map(session => session.id), [survivor.id]);
  assert.deepEqual(Object.keys(persisted.createReceipts), ['create-survivor']);
  assert.equal(persisted.createReceipts['create-survivor'].sessionId, survivor.id);
  assert.deepEqual(fs.readdirSync(sessionRoot), ['sessions.json'], '状态服务不得产生节点文件或遗留临时文件');

  const restarted = createService(sessionRoot, 100);
  assert.equal(restarted.loadSession(blank.id), null);
  assert.equal(restarted.loadSession(completed.id), null);
  assert.deepEqual(restarted.listSessions().map(session => session.id), [survivor.id]);
  assert.deepEqual(fs.readFileSync(canvasPath), canvasBefore);
});

test('submitting、running 和 remote-unknown 任务以 409 阻断删除并完整保留恢复事实', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-session-delete-blocked-'));
  const service = createService(rootPath, 200);
  const sessions = ['submitting', 'running', 'remote-unknown'].map(status => {
    const session = createSession(service, status);
    service.upsertToolRun(session.id, `tool-${status}`, {
      requestId: `run-${status}`,
      type: 'native-video',
      status,
      nodeId: `node-${status}`,
      remoteTaskId: `remote-${status}`
    });
    return { session, status };
  });
  const storePath = path.join(rootPath, 'sessions.json');
  const before = fs.readFileSync(storePath);

  for (const { session, status } of sessions) {
    assert.throws(
      () => service.deleteSession(session.id),
      hasCode('SESSION_DELETE_BLOCKED', 409)
    );
    const retained = service.loadSession(session.id);
    assert.equal(retained.toolRuns[0].status, status);
    assert.equal(retained.toolRuns[0].remoteTaskId, `remote-${status}`);
  }
  assert.deepEqual(fs.readFileSync(storePath), before, '阻断删除不能改写会话或恢复任务');
});

test('删除不存在的会话幂等返回 deleted:false 且不改写存储', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-session-delete-missing-'));
  const service = createService(rootPath, 300);
  const survivor = createSession(service, 'missing-survivor');
  const storePath = path.join(rootPath, 'sessions.json');
  const before = fs.readFileSync(storePath);

  assert.deepEqual(service.deleteSession('agent-session-missing'), { deleted: false });
  assert.deepEqual(service.deleteSession('agent-session-missing'), { deleted: false });
  assert.deepEqual(fs.readFileSync(storePath), before);
  assert.equal(service.loadSession(survivor.id)?.id, survivor.id);
});
