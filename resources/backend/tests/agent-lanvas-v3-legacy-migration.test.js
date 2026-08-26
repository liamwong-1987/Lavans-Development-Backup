'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createAgentLegacyMigrationService } = require('../services/agentLegacyMigrationService');
const { createAgentSessionService } = require('../services/agentSessionService');
const createCanvasRoutes = require('../routes/canvasRoutes');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function treeSnapshot(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const rows = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) rows.push(`${path.relative(rootPath, absolute).replaceAll('\\', '/')}|${digest(absolute)}`);
    }
  };
  visit(rootPath);
  return rows.sort();
}

function hasCode(code, statusCode) {
  return error => error?.code === code && (statusCode === undefined || error?.statusCode === statusCode);
}

function fixture(options = {}) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-legacy-migration-'));
  const canvasId = options.canvasId || 'canvas-legacy-a';
  const runId = options.runId || 'legacy-run-a';
  const runPath = path.join(outputRoot, '.state', 'agent-runs', `${runId}.json`);
  const workspacePath = path.join(outputRoot, 'canvases', `${canvasId}.json`);
  const foundationIndexPath = path.join(outputRoot, 'agent-foundation', 'artifacts', 'artifact-index.json');
  const foundationContentPath = path.join(outputRoot, 'agent-foundation', 'artifacts', 'content', 'legacy-brief', 'legacy-brief-v001.md');
  const recolorPath = path.join(outputRoot, 'recolor-private', 'sentinel.json');
  const foundationContent = '# 旧剧本文档\n只应进入后台历史，不进入画布当前工作集。\n';
  fs.mkdirSync(path.dirname(foundationContentPath), { recursive: true });
  fs.writeFileSync(foundationContentPath, foundationContent, 'utf8');

  const run = {
    id: runId,
    canvasId,
    skillId: 'legacy-story-tvc',
    skillTitle: '旧剧情 TVC',
    status: options.runStatus || 'completed',
    currentStageId: 'delivery',
    stages: options.stages || [{ id: 'delivery', status: 'completed' }],
    artifacts: [],
    scriptReview: { versions: [], attempts: options.attempts || [] },
    createdAt: 10,
    updatedAt: 20
  };
  writeJson(runPath, run);

  const nodes = options.nodes || [
    { id: 'legacy-stage', type: 'smart-agent-stage', agentRunId: runId, title: '旧阶段' },
    { id: 'legacy-approval', type: 'smart-agent-approval-artifact', agentRunId: runId, agentFoundationProjection: true },
    { id: 'legacy-prompt', type: 'prompt', agentRunId: runId, prompt: '文档只留在聊天' },
    { id: 'legacy-image-connected', type: 'smart-image', url: '/canvas-output/image-a.png' },
    { id: 'legacy-video-direct', type: 'video', agentRunId: runId, outputUrl: '/canvas-output/video-a.mp4', assetVersionId: 'unproven-asset-version', toolRunId: 'unproven-tool-run' },
    { id: 'legacy-audio-direct', type: 'audio', agentRunId: runId, audioUrl: '/canvas-output/audio-a.mp3' },
    { id: 'legacy-tool-direct', type: 'tool', agentRunId: runId, title: '智能剪辑' },
    { id: 'plain-unproven-image', type: 'image', url: '/canvas-output/unrelated.png' },
    {
      id: 'owned-native-image',
      type: 'smart-image',
      agentRunId: runId,
      url: '/canvas-output/owned.png',
      agentNative: { workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-existing', kind: 'image' }
    }
  ];
  const connections = options.connections || [
    { id: 'edge-stage-image', from: 'legacy-stage', to: 'legacy-image-connected' }
  ];
  const workspace = {
    id: canvasId,
    title: 'Legacy 迁移画布',
    deleted_at: options.deletedAt || null,
    nodes,
    connections,
    agentRuns: [{ id: runId, status: run.status }],
    activeAgentRunId: run.status === 'completed' ? '' : runId
  };
  writeJson(workspacePath, workspace);
  writeJson(foundationIndexPath, {
    schemaVersion: 1,
    artifacts: {
      'legacy-brief-v001': {
        artifactVersionId: 'legacy-brief-v001',
        artifactType: 'script',
        logicalArtifactId: 'legacy-brief',
        version: 1,
        contentPath: 'content/legacy-brief/legacy-brief-v001.md',
        contentHash: crypto.createHash('sha256').update(foundationContent).digest('hex'),
        inputRefs: [],
        approvalState: 'locked',
        validityState: 'current',
        metadata: { canvasId, runId }
      }
    },
    operations: {},
    audit: []
  });
  writeJson(recolorPath, { workspaceScope: 'recolor', untouched: true });

  const runService = {
    loadRun(requestedRunId) {
      const filePath = path.join(outputRoot, '.state', 'agent-runs', `${requestedRunId}.json`);
      return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
    },
    listRuns() { return []; },
    artifactContent() { return null; },
    scriptVersions: { getVersion() { return null; }, diffVersions() { return null; } }
  };
  return {
    outputRoot,
    canvasId,
    runId,
    runPath,
    workspacePath,
    foundationIndexPath,
    foundationContentPath,
    recolorPath,
    runService
  };
}

function legacyHashes(value) {
  return {
    run: digest(value.runPath),
    workspace: digest(value.workspacePath),
    foundationIndex: digest(value.foundationIndexPath),
    foundationContent: digest(value.foundationContentPath),
    recolor: digest(value.recolorPath)
  };
}

function sessionServiceFor(value, overrides = {}) {
  let sequence = 0;
  const base = createAgentSessionService({
    outputRoot: value.outputRoot,
    clock: (() => { let time = 1000; return () => ++time; })(),
    makeId: prefix => `${prefix}-migration-${++sequence}`
  });
  return Object.keys(overrides).length ? { ...base, ...overrides } : base;
}

function migrationServiceFor(value, sessionService, options = {}) {
  return createAgentLegacyMigrationService({
    outputRoot: value.outputRoot,
    agentRunService: value.runService,
    getAgentSessionService: () => sessionService || (() => { throw new Error('preview 不得读取 Session'); })(),
    clock: options.clock || (() => { let time = 2000; return () => ++time; })()
  });
}

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('M3E：preview 严格零写入，只把有 Run 证据的普通媒体与工具列为候选', () => {
  const value = fixture();
  const beforeTree = treeSnapshot(value.outputRoot);
  const beforeHashes = legacyHashes(value);
  const service = migrationServiceFor(value, null);
  const preview = service.preview({ canvasId: value.canvasId });

  assert.deepEqual(treeSnapshot(value.outputRoot), beforeTree);
  assert.deepEqual(legacyHashes(value), beforeHashes);
  assert.equal(fs.existsSync(path.join(value.outputRoot, '.state', 'agent-legacy-migrations')), false);
  assert.equal(fs.existsSync(path.join(value.outputRoot, '.state', 'agent-sessions')), false);
  assert.match(preview.migrationId, /^legacy-migration-[a-f0-9]{32}$/);
  assert.match(preview.previewHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(preview).includes(value.outputRoot), false, 'API 不得泄露本机绝对路径');
  assert.deepEqual(preview.currentNodeCandidates.map(item => item.nodeId), [
    'legacy-audio-direct',
    'legacy-image-connected',
    'legacy-tool-direct',
    'legacy-video-direct'
  ]);
  const videoCandidate = preview.currentNodeCandidates.find(item => item.nodeId === 'legacy-video-direct');
  assert.equal(videoCandidate.assetVersionId, '', '旧节点自报的资产版本未经同画布证明，不得迁入');
  assert.equal(videoCandidate.toolRunId, '', '新 Session 没有对应 toolRun，不得迁入悬空引用');
  for (const nodeId of ['legacy-stage', 'legacy-approval', 'legacy-prompt', 'plain-unproven-image', 'owned-native-image']) {
    assert.equal(preview.currentNodeCandidates.some(item => item.nodeId === nodeId), false, nodeId);
  }
  assert.equal(preview.legacyNodeRefs.find(item => item.nodeId === 'legacy-stage').classification, 'historical-shell');
  assert.equal(preview.legacyNodeRefs.find(item => item.nodeId === 'legacy-prompt').classification, 'chat-document');
  assert.equal(preview.legacyNodeRefs.find(item => item.nodeId === 'plain-unproven-image').classification, 'unproven-legacy-node');
  assert.equal(preview.legacyNodeRefs.find(item => item.nodeId === 'owned-native-image').classification, 'owned-by-other-session');
  assert.equal(preview.foundationArtifactRefs.length, 1);
  assert.equal(preview.reconcileRequired, false);
});

test('M3E：缺显式确认时零写入；确认只新增一个 Session 和一个 manifest，重放不增加修订', () => {
  const value = fixture();
  const sessions = sessionServiceFor(value);
  const service = migrationServiceFor(value, sessions);
  const preview = service.preview({ canvasId: value.canvasId });
  const before = legacyHashes(value);
  const beforeTree = treeSnapshot(value.outputRoot);

  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash }),
    hasCode('EXPLICIT_MIGRATION_CONFIRMATION_REQUIRED', 400)
  );
  assert.deepEqual(treeSnapshot(value.outputRoot), beforeTree);

  const first = service.confirm({
    canvasId: value.canvasId,
    migrationId: preview.migrationId,
    previewHash: preview.previewHash,
    confirm: true
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.manifest.status, 'completed');
  assert.equal(first.session.canvasId, value.canvasId);
  assert.equal(first.session.workspaceScope, 'canvas-agent');
  assert.equal(first.session.status, 'idle');
  assert.equal(first.session.reconcileRequired, false);
  assert.deepEqual(first.session.currentNodeRefs.map(item => item.nodeId).sort(), preview.currentNodeCandidates.map(item => item.nodeId).sort());
  assert.deepEqual(first.session.legacyRunRefs, preview.legacyRunRefs);
  assert.deepEqual(first.session.foundationArtifactRefs, preview.foundationArtifactRefs);
  assert.deepEqual(legacyHashes(value), before, '旧 Run、workspace、Foundation 与复色哨兵必须逐字节不变');
  const migrationFiles = fs.readdirSync(path.join(value.outputRoot, '.state', 'agent-legacy-migrations'));
  assert.deepEqual(migrationFiles, [`${preview.migrationId}.json`]);
  assert.equal(sessions.listSessions(value.canvasId).length, 1);

  const evolved = sessions.setStatus(first.session.id, {
    requestId: 'post-migration-plan-evolution',
    status: 'collecting',
    currentPhase: 'next-brief',
    nextAction: '继续在持续聊天中工作',
    plan: { steps: ['接收下一条用户消息'] }
  }).session;
  const revision = evolved.revision;
  const second = service.confirm({
    canvasId: value.canvasId,
    migrationId: preview.migrationId,
    previewHash: preview.previewHash,
    confirm: true
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.session.revision, revision);
  assert.deepEqual(second.session.plan, evolved.plan, '迁移完成后正常演进的聊天计划不能被当作 manifest 损坏');
  assert.equal(sessions.listSessions(value.canvasId).length, 1);
  assert.deepEqual(legacyHashes(value), before);
});

test('M3E：未知远端状态只进入歧义清单，Session 固定 blocked + reconcile-required', () => {
  const value = fixture({
    runStatus: 'running',
    stages: [{ id: 'video-generation', status: 'running' }],
    attempts: [{ id: 'attempt-running', status: 'running' }]
  });
  const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
  workspace.nodes.push({
    id: 'legacy-running-video',
    type: 'video',
    agentRunId: value.runId,
    outputUrl: '/canvas-output/running.mp4',
    canvasTask: { status: 'remote-unknown', remoteTaskId: 'remote-task-existing' }
  });
  workspace.nodes.push({
    id: 'legacy-waiting-image',
    type: 'image',
    agentRunId: value.runId,
    url: '/canvas-output/waiting.png',
    taskState: 'waiting'
  });
  workspace.nodes.push({
    id: 'legacy-statusless-task-image',
    type: 'image',
    agentRunId: value.runId,
    url: '/canvas-output/statusless.png',
    remoteTaskId: 'remote-without-status'
  });
  writeJson(value.workspacePath, workspace);
  const sessions = sessionServiceFor(value);
  const service = migrationServiceFor(value, sessions);
  const preview = service.preview({ canvasId: value.canvasId });
  assert.equal(preview.reconcileRequired, true);
  assert.ok(preview.ambiguousRemoteTasks.length >= 4);
  assert.equal(preview.currentNodeCandidates.some(item => item.nodeId === 'legacy-running-video'), false);
  assert.equal(preview.currentNodeCandidates.some(item => item.nodeId === 'legacy-waiting-image'), false);
  assert.equal(preview.currentNodeCandidates.some(item => item.nodeId === 'legacy-statusless-task-image'), false);

  const result = service.confirm({
    canvasId: value.canvasId,
    migrationId: preview.migrationId,
    previewHash: preview.previewHash,
    confirm: true
  });
  assert.equal(result.session.status, 'blocked');
  assert.equal(result.session.reconcileRequired, true);
  assert.equal(result.session.recoveryStatus, 'reconcile-required');
  assert.match(result.session.blockedReason, /legacy-/);
});

test('M3E：预览后来源漂移在 Session 创建前失败关闭', () => {
  const value = fixture();
  const sessions = sessionServiceFor(value);
  const service = migrationServiceFor(value, sessions);
  const preview = service.preview({ canvasId: value.canvasId });
  const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
  workspace.title = '预览后被修改';
  writeJson(value.workspacePath, workspace);

  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('MIGRATION_PREVIEW_MISMATCH', 409)
  );
  assert.equal(sessions.listSessions(value.canvasId).length, 0);
  assert.equal(fs.existsSync(path.join(value.outputRoot, '.state', 'agent-legacy-migrations')), false);
});

test('M3E：Session 建立后的来源漂移清空 currentNodeRefs，并留下 failed manifest', () => {
  const value = fixture();
  const base = sessionServiceFor(value);
  let drifted = false;
  const sessionService = {
    ...base,
    setStatus(...args) {
      const result = base.setStatus(...args);
      if (!drifted && args[1]?.recoveryStatus === 'migration-pending-source-check') {
        drifted = true;
        const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
        workspace.title = '确认中发生来源漂移';
        writeJson(value.workspacePath, workspace);
      }
      return result;
    }
  };
  const service = migrationServiceFor(value, sessionService);
  const preview = service.preview({ canvasId: value.canvasId });
  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_SOURCE_HASH_MISMATCH', 409)
  );
  const sessions = base.listSessions(value.canvasId);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].currentNodeRefs, []);
  assert.equal(sessions[0].status, 'blocked');
  assert.equal(sessions[0].reconcileRequired, true);
  assert.equal(sessions[0].recoveryStatus, 'migration-source-drift');
  const manifest = JSON.parse(fs.readFileSync(path.join(value.outputRoot, '.state', 'agent-legacy-migrations', `${preview.migrationId}.json`), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.failure.code, 'LEGACY_SOURCE_HASH_MISMATCH');
});

test('M3E：部分候选已挂接后发生漂移，也必须移除全部 currentNodeRefs', () => {
  const value = fixture();
  const base = sessionServiceFor(value);
  let drifted = false;
  const sessionService = {
    ...base,
    attachCurrentNode(...args) {
      const result = base.attachCurrentNode(...args);
      if (!drifted) {
        drifted = true;
        const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
        workspace.title = '挂接首个候选后漂移';
        writeJson(value.workspacePath, workspace);
      }
      return result;
    }
  };
  const service = migrationServiceFor(value, sessionService);
  const preview = service.preview({ canvasId: value.canvasId });
  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_SOURCE_HASH_MISMATCH', 409)
  );
  const session = base.listSessions(value.canvasId)[0];
  assert.deepEqual(session.currentNodeRefs, []);
  assert.ok(session.detachedNodeRefs.length >= 1, '已挂接候选应转入后台脱离历史，而不是被删除');
  assert.equal(session.recoveryStatus, 'migration-source-drift');
});

test('M3E：完成 manifest 被篡改后不可由重复 confirm 覆盖', () => {
  const value = fixture();
  const sessions = sessionServiceFor(value);
  const service = migrationServiceFor(value, sessions);
  const preview = service.preview({ canvasId: value.canvasId });
  service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true });
  const manifestPath = path.join(value.outputRoot, '.state', 'agent-legacy-migrations', `${preview.migrationId}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.status = 'prepared';
  writeJson(manifestPath, manifest);
  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_MIGRATION_MANIFEST_INVALID', 409)
  );
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'prepared', '坏 manifest 不得被覆盖修复');
});

test('M3E：崩溃后旧源再漂移，重放仍读取 session-created manifest 并清理残留引用', () => {
  const value = fixture();
  const base = sessionServiceFor(value);
  let crashed = false;
  const sessionService = {
    ...base,
    attachCurrentNode(...args) {
      const result = base.attachCurrentNode(...args);
      if (!crashed) {
        crashed = true;
        const error = new Error('模拟进程在首次挂接后崩溃');
        error.code = 'SIMULATED_PROCESS_CRASH';
        throw error;
      }
      return result;
    }
  };
  const service = migrationServiceFor(value, sessionService);
  const preview = service.preview({ canvasId: value.canvasId });
  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    error => error?.code === 'SIMULATED_PROCESS_CRASH'
  );
  const manifestPath = path.join(value.outputRoot, '.state', 'agent-legacy-migrations', `${preview.migrationId}.json`);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'session-created');
  assert.equal(base.listSessions(value.canvasId)[0].currentNodeRefs.length, 1);

  const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
  workspace.title = '崩溃后来源漂移';
  writeJson(value.workspacePath, workspace);
  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_SOURCE_HASH_MISMATCH', 409)
  );
  const recovered = base.listSessions(value.canvasId)[0];
  assert.deepEqual(recovered.currentNodeRefs, []);
  assert.equal(recovered.recoveryStatus, 'migration-source-drift');
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'failed');
});

test('M3E：清理中断后同 nodeId 重挂接，后续重放仍按引用实例清空', () => {
  const value = fixture();
  const base = sessionServiceFor(value);
  let finalizeCrashed = false;
  const crashAfterAttach = {
    ...base,
    setStatus(sessionId, input) {
      if (!finalizeCrashed && input?.recoveryStatus === 'migration-complete') {
        finalizeCrashed = true;
        const error = new Error('模拟全部候选挂接后的进程崩溃');
        error.code = 'SIMULATED_FINALIZE_CRASH';
        throw error;
      }
      return base.setStatus(sessionId, input);
    }
  };
  const initialService = migrationServiceFor(value, crashAfterAttach);
  const preview = initialService.preview({ canvasId: value.canvasId });
  assert.throws(
    () => initialService.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    error => error?.code === 'SIMULATED_FINALIZE_CRASH'
  );
  assert.equal(base.listSessions(value.canvasId)[0].currentNodeRefs.length, 4);
  const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
  workspace.title = '清理重放来源漂移';
  writeJson(value.workspacePath, workspace);

  let detachCount = 0;
  const crashDuringCleanup = {
    ...base,
    detachCurrentNode(...args) {
      const result = base.detachCurrentNode(...args);
      detachCount += 1;
      if (detachCount === 2) throw new Error('模拟清理中断');
      return result;
    }
  };
  const interruptedCleanup = migrationServiceFor(value, crashDuringCleanup);
  assert.throws(
    () => interruptedCleanup.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_MIGRATION_CLEANUP_INCOMPLETE', 503)
  );
  const partial = base.listSessions(value.canvasId)[0];
  assert.equal(partial.currentNodeRefs.length, 2);
  const detached = partial.detachedNodeRefs[0];
  base.attachCurrentNode(partial.id, detached.nodeId, {
    requestId: 'reattach-same-node-after-partial-cleanup',
    workspaceScope: 'canvas-agent',
    kind: detached.kind,
    nodeRole: detached.nodeRole
  });
  assert.equal(base.listSessions(value.canvasId)[0].currentNodeRefs.length, 3);

  const resumedCleanup = migrationServiceFor(value, base);
  assert.throws(
    () => resumedCleanup.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_SOURCE_HASH_MISMATCH', 409)
  );
  const session = base.listSessions(value.canvasId)[0];
  assert.deepEqual(session.currentNodeRefs, []);
  assert.equal(session.recoveryStatus, 'migration-source-drift');
  const manifestPath = path.join(value.outputRoot, '.state', 'agent-legacy-migrations', `${preview.migrationId}.json`);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'failed');
});

test('M3E：completed 写入后才发现漂移且清理中断，重放仍继续清空残留引用', () => {
  const value = fixture();
  const base = sessionServiceFor(value);
  let detachCount = 0;
  const crashDuringCleanup = {
    ...base,
    detachCurrentNode(...args) {
      const result = base.detachCurrentNode(...args);
      detachCount += 1;
      if (detachCount === 2) throw new Error('模拟 completed 后置复核的清理中断');
      return result;
    }
  };
  let ticks = 0;
  let time = 2000;
  const clock = () => {
    ticks += 1;
    if (ticks === 3) {
      const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
      workspace.title = 'completedAt 时刻发生来源漂移';
      writeJson(value.workspacePath, workspace);
    }
    return ++time;
  };
  const service = migrationServiceFor(value, crashDuringCleanup, { clock });
  const preview = service.preview({ canvasId: value.canvasId });
  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_MIGRATION_CLEANUP_INCOMPLETE', 503)
  );
  const manifestPath = path.join(value.outputRoot, '.state', 'agent-legacy-migrations', `${preview.migrationId}.json`);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'session-created', '清理未完成时不得保留 completed');
  assert.equal(base.listSessions(value.canvasId)[0].currentNodeRefs.length, 2);

  const replay = migrationServiceFor(value, base);
  assert.throws(
    () => replay.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_SOURCE_HASH_MISMATCH', 409)
  );
  const recovered = base.listSessions(value.canvasId)[0];
  assert.deepEqual(recovered.currentNodeRefs, []);
  assert.equal(recovered.recoveryStatus, 'migration-source-drift');
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'failed');
});

test('M3E：引用与 Session 已清理但 failed manifest 写前中断，重放仍能收敛', () => {
  const value = fixture();
  const base = sessionServiceFor(value);
  let drifted = false;
  const driftAfterAttach = {
    ...base,
    attachCurrentNode(...args) {
      const result = base.attachCurrentNode(...args);
      if (!drifted) {
        drifted = true;
        const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
        workspace.title = '清理完成但 manifest 写前漂移';
        writeJson(value.workspacePath, workspace);
      }
      return result;
    }
  };
  let ticks = 0;
  let time = 2000;
  const clock = () => {
    ticks += 1;
    if (ticks === 3) throw new Error('模拟 failed manifest 写入前中断');
    return ++time;
  };
  const service = migrationServiceFor(value, driftAfterAttach, { clock });
  const preview = service.preview({ canvasId: value.canvasId });
  assert.throws(
    () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_MIGRATION_CLEANUP_INCOMPLETE', 503)
  );
  const manifestPath = path.join(value.outputRoot, '.state', 'agent-legacy-migrations', `${preview.migrationId}.json`);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'session-created');
  const cleaned = base.listSessions(value.canvasId)[0];
  assert.deepEqual(cleaned.currentNodeRefs, []);
  assert.equal(cleaned.recoveryStatus, 'migration-source-drift');

  const replay = migrationServiceFor(value, base);
  assert.throws(
    () => replay.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
    hasCode('LEGACY_SOURCE_HASH_MISMATCH', 409)
  );
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'failed');
  assert.deepEqual(base.listSessions(value.canvasId)[0].currentNodeRefs, []);
});

test('M3E：跨画布、复色、坏 Foundation hash 和被删除画布均失败关闭', async t => {
  await t.test('跨画布 Run 引用', () => {
    const value = fixture();
    const otherRunPath = path.join(value.outputRoot, '.state', 'agent-runs', 'legacy-run-other.json');
    writeJson(otherRunPath, { id: 'legacy-run-other', canvasId: 'canvas-other', status: 'completed', stages: [], artifacts: [], updatedAt: 1 });
    const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
    workspace.nodes.push({ id: 'cross-canvas-node', type: 'image', agentRunId: 'legacy-run-other', url: '/canvas-output/cross.png' });
    writeJson(value.workspacePath, workspace);
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('CROSS_CANVAS_LEGACY_REFERENCE', 409));
  });

  await t.test('workspace Run 清单显式跨画布', () => {
    const value = fixture();
    const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
    workspace.agentRuns[0].canvasId = 'canvas-other';
    writeJson(value.workspacePath, workspace);
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('CROSS_CANVAS_LEGACY_REFERENCE', 409));
  });

  await t.test('复色 scope', () => {
    const value = fixture();
    const workspace = JSON.parse(fs.readFileSync(value.workspacePath, 'utf8'));
    workspace.nodes[0].workspaceScope = 'recolor';
    writeJson(value.workspacePath, workspace);
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('RECOLOR_REFERENCE_FORBIDDEN', 409));
  });

  await t.test('Foundation 内容 hash 不一致', () => {
    const value = fixture();
    fs.appendFileSync(value.foundationContentPath, 'tampered', 'utf8');
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('FOUNDATION_CONTENT_HASH_MISMATCH', 409));
  });

  await t.test('Foundation content 符号链接不能越出根目录', t => {
    const value = fixture();
    const outsidePath = path.join(path.dirname(value.outputRoot), `outside-foundation-${crypto.randomBytes(6).toString('hex')}.md`);
    fs.writeFileSync(outsidePath, 'outside content', 'utf8');
    fs.unlinkSync(value.foundationContentPath);
    try { fs.symlinkSync(outsidePath, value.foundationContentPath, 'file'); }
    catch (error) {
      t.skip(`当前文件系统不能建立测试符号链接：${error.code || error.message}`);
      return;
    }
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('LEGACY_SOURCE_INVALID', 409));
  });

  await t.test('Foundation inputRef 跨画布', () => {
    const value = fixture();
    const index = JSON.parse(fs.readFileSync(value.foundationIndexPath, 'utf8'));
    const otherContent = 'other canvas';
    const otherPath = path.join(value.outputRoot, 'agent-foundation', 'artifacts', 'content', 'other', 'other-v001.txt');
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    fs.writeFileSync(otherPath, otherContent, 'utf8');
    index.artifacts['other-v001'] = {
      artifactVersionId: 'other-v001',
      artifactType: 'script',
      logicalArtifactId: 'other',
      version: 1,
      contentPath: 'content/other/other-v001.txt',
      contentHash: crypto.createHash('sha256').update(otherContent).digest('hex'),
      inputRefs: [],
      metadata: { canvasId: 'canvas-other' }
    };
    index.artifacts['legacy-brief-v001'].inputRefs = [{ artifactVersionId: 'other-v001', role: 'cross' }];
    writeJson(value.foundationIndexPath, index);
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('CROSS_CANVAS_LEGACY_REFERENCE', 409));
  });

  await t.test('Foundation inputRef 缺少 canvasId', () => {
    const value = fixture();
    const index = JSON.parse(fs.readFileSync(value.foundationIndexPath, 'utf8'));
    const orphanContent = 'unscoped artifact';
    const orphanPath = path.join(value.outputRoot, 'agent-foundation', 'artifacts', 'content', 'orphan', 'orphan-v001.txt');
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(orphanPath, orphanContent, 'utf8');
    index.artifacts['orphan-v001'] = {
      artifactVersionId: 'orphan-v001',
      artifactType: 'script',
      logicalArtifactId: 'orphan',
      version: 1,
      contentPath: 'content/orphan/orphan-v001.txt',
      contentHash: crypto.createHash('sha256').update(orphanContent).digest('hex'),
      inputRefs: [],
      metadata: {}
    };
    index.artifacts['legacy-brief-v001'].inputRefs = [{ artifactVersionId: 'orphan-v001', role: 'unscoped' }];
    writeJson(value.foundationIndexPath, index);
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('LEGACY_MIGRATION_MANIFEST_INVALID', 409));
  });

  await t.test('Foundation runId 来源缺失进入 reconcile-required', () => {
    const value = fixture();
    const index = JSON.parse(fs.readFileSync(value.foundationIndexPath, 'utf8'));
    index.artifacts['legacy-brief-v001'].metadata.runId = 'missing-foundation-run';
    writeJson(value.foundationIndexPath, index);
    const preview = migrationServiceFor(value, null).preview({ canvasId: value.canvasId });
    assert.equal(preview.reconcileRequired, true);
    assert.ok(preview.reconcileReasons.includes('foundation-run-source-missing'));
  });

  await t.test('Foundation 非空非法 runId 不能被当成缺省值', () => {
    const value = fixture();
    const index = JSON.parse(fs.readFileSync(value.foundationIndexPath, 'utf8'));
    index.artifacts['legacy-brief-v001'].metadata.runId = '../foreign-run';
    writeJson(value.foundationIndexPath, index);
    const sessions = sessionServiceFor(value);
    assert.throws(
      () => migrationServiceFor(value, sessions).preview({ canvasId: value.canvasId }),
      hasCode('LEGACY_MIGRATION_MANIFEST_INVALID', 409)
    );
    assert.equal(sessions.listSessions(value.canvasId).length, 0);
  });

  for (const malformed of [{ bad: true }, 'legacy-brief-v000']) {
    await t.test(`Foundation 非数组 inputRefs 失败关闭：${typeof malformed}`, () => {
      const value = fixture();
      const index = JSON.parse(fs.readFileSync(value.foundationIndexPath, 'utf8'));
      index.artifacts['legacy-brief-v001'].inputRefs = malformed;
      writeJson(value.foundationIndexPath, index);
      assert.throws(
        () => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }),
        hasCode('LEGACY_MIGRATION_MANIFEST_INVALID', 409)
      );
    });
  }

  await t.test('deleted canvas', () => {
    const value = fixture({ deletedAt: 123 });
    assert.throws(() => migrationServiceFor(value, null).preview({ canvasId: value.canvasId }), hasCode('LEGACY_CANVAS_DELETED', 409));
  });
});

test('M3E：迁移与 Session 写目录不能通过链接逃逸输出根', async t => {
  for (const entry of [
    { name: 'migration manifest', relative: path.join('.state', 'agent-legacy-migrations') },
    { name: 'AgentSession', relative: path.join('.state', 'agent-sessions') }
  ]) {
    await t.test(entry.name, subtest => {
      const value = fixture();
      const sessions = sessionServiceFor(value);
      const service = migrationServiceFor(value, sessions);
      const preview = service.preview({ canvasId: value.canvasId });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-legacy-write-outside-'));
      const linkPath = path.join(value.outputRoot, entry.relative);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try { fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        subtest.skip(`当前文件系统不能建立测试目录链接：${error.code || error.message}`);
        return;
      }
      assert.throws(
        () => service.confirm({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true }),
        hasCode('LEGACY_MIGRATION_WRITE_PATH_INVALID', 409)
      );
      assert.deepEqual(fs.readdirSync(outside), [], '根外目录不得出现 manifest 或 Session 文件');
      assert.equal(sessions.listSessions(value.canvasId).length, 0);
    });
  }
});

test('M3E：只有 default 可回退旧 canvas-workspace.json，其他画布不能误读', () => {
  const value = fixture({ canvasId: 'default' });
  const legacyPath = path.join(value.outputRoot, 'canvas-workspace.json');
  fs.renameSync(value.workspacePath, legacyPath);
  const service = migrationServiceFor(value, null);
  assert.equal(service.preview({ canvasId: 'default' }).canvasId, 'default');
  assert.throws(() => service.preview({ canvasId: 'another-canvas' }), hasCode('LEGACY_CANVAS_NOT_FOUND', 404));
});

test('M3E：HTTP preview/confirm 暴露固定错误 code，且 preview 不初始化 Session', async () => {
  const value = fixture();
  const router = createCanvasRoutes({ outputRoot: value.outputRoot, agentRunService: value.runService });
  const sourceBefore = legacyHashes(value);
  const sessionsPath = path.join(value.outputRoot, '.state', 'agent-sessions', 'sessions.json');
  await withServer(router, async baseUrl => {
    const previewResponse = await requestJson(`${baseUrl}/api/canvas/agent-legacy-migrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: value.canvasId })
    });
    assert.equal(previewResponse.response.status, 200);
    assert.equal(previewResponse.body.success, true);
    assert.equal(fs.existsSync(sessionsPath), false, 'preview 不得触发 AgentSession schema 恢复或写盘');

    const missingConfirmation = await requestJson(`${baseUrl}/api/canvas/agent-legacy-migrations/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: value.canvasId,
        migrationId: previewResponse.body.preview.migrationId,
        previewHash: previewResponse.body.preview.previewHash
      })
    });
    assert.equal(missingConfirmation.response.status, 400);
    assert.equal(missingConfirmation.body.code, 'EXPLICIT_MIGRATION_CONFIRMATION_REQUIRED');
    assert.equal(fs.existsSync(sessionsPath), false);

    const confirmed = await requestJson(`${baseUrl}/api/canvas/agent-legacy-migrations/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: value.canvasId,
        migrationId: previewResponse.body.preview.migrationId,
        previewHash: previewResponse.body.preview.previewHash,
        confirm: true
      })
    });
    assert.equal(confirmed.response.status, 201);
    assert.equal(confirmed.body.manifest.status, 'completed');
    assert.equal(confirmed.body.session.currentNodeRefs.length, 4);
  });
  assert.deepEqual(legacyHashes(value), sourceBefore);
});

test('M3E：确认竞态中的文件消失只返回安全错误，不泄露绝对路径', async () => {
  const value = fixture();
  const base = sessionServiceFor(value);
  let removed = false;
  const sessionService = {
    ...base,
    setStatus(sessionId, input) {
      const result = base.setStatus(sessionId, input);
      if (!removed && input?.recoveryStatus === 'migration-pending-source-check') {
        removed = true;
        fs.unlinkSync(value.foundationContentPath);
      }
      return result;
    }
  };
  const router = createCanvasRoutes({
    outputRoot: value.outputRoot,
    agentRunService: value.runService,
    agentSessionService: sessionService
  });
  await withServer(router, async baseUrl => {
    const previewResponse = await requestJson(`${baseUrl}/api/canvas/agent-legacy-migrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: value.canvasId })
    });
    const preview = previewResponse.body.preview;
    const confirmed = await requestJson(`${baseUrl}/api/canvas/agent-legacy-migrations/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: value.canvasId, migrationId: preview.migrationId, previewHash: preview.previewHash, confirm: true })
    });
    assert.equal(confirmed.response.status, 409);
    assert.equal(confirmed.body.code, 'LEGACY_SOURCE_HASH_MISMATCH');
    assert.equal(JSON.stringify(confirmed.body).includes(value.outputRoot), false);
    assert.doesNotMatch(confirmed.body.error, /ENOENT|EACCES|agent-foundation[\\/]/i);
  });
  const session = base.listSessions(value.canvasId)[0];
  assert.deepEqual(session.currentNodeRefs, []);
  assert.equal(session.recoveryStatus, 'migration-source-drift');
});
