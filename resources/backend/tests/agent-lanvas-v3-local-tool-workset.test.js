'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAgentSessionService } = require('../services/agentSessionService');
const canvasRoutes = require('../routes/canvasRoutes');

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

function requestJson(baseUrl, pathname, method, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function fixture() {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-local-workset-'));
  let id = 0;
  const verifierCalls = [];
  const service = createAgentSessionService({
    outputRoot,
    makeId: prefix => `${prefix}-local-${++id}`,
    verifyLocalWorksetSources(input) {
      verifierCalls.push(input);
      return input.sourceRefs.map(ref => ({
        nodeId: ref.nodeId,
        kind: ref.kind,
        toolRunId: ref.toolRunId,
        url: `/canvas-output/${ref.nodeId}.${ref.kind === 'audio' ? 'wav' : 'mp4'}`,
        contentHash: ref.kind === 'audio' ? 'b'.repeat(64) : 'a'.repeat(64),
        byteLength: ref.kind === 'audio' ? 64 : 128
      }));
    }
  });
  const session = service.createSession({
    requestId: 'create-local-workset-session',
    canvasId: 'canvas-local-workset',
    workspaceScope: 'canvas-agent',
    mode: 'generation'
  }).session;
  seedNativeSource(service, session.id, 'video-source', 'video');
  seedNativeSource(service, session.id, 'audio-source', 'audio');
  return { outputRoot, service, session, verifierCalls };
}

function seedNativeSource(service, sessionId, nodeId, kind) {
  const toolRunId = `tool-${nodeId}`;
  service.upsertToolRun(sessionId, toolRunId, {
    requestId: `seed-tool-${nodeId}`,
    type: `native-${kind}`,
    status: 'succeeded',
    nodeId,
    provider: 'fixture-provider',
    model: `fixture-${kind}`
  });
  service.attachCurrentNode(sessionId, nodeId, {
    requestId: `seed-node-${nodeId}`,
    workspaceScope: 'canvas-agent',
    kind,
    nodeRole: `${kind}-output`,
    toolRunId
  });
}

function establishInput(overrides = {}) {
  return {
    requestId: 'establish-smart-edit-request',
    action: 'establish-smart-edit',
    toolRunId: 'tool-smart-edit',
    nodeId: 'node-smart-edit',
    eventId: 'event-smart-edit-established',
    sourceNodeIds: ['video-source', 'audio-source'],
    ...overrides
  };
}

function exportPlan({ withBgm = true } = {}) {
  return {
    clips: [{ nodeId: 'video-source', start: 0, end: 1.5 }],
    bgm: withBgm ? { nodeId: 'audio-source', volume: 0.25 } : null,
    output: { width: 720, height: 1280 }
  };
}

test('M6C1：建立智能剪辑工作集在一次原子写中提交 ToolRun、current ref 与消息，重放不复制', () => {
  const state = fixture();
  const before = state.service.loadSession(state.session.id);
  const result = state.service.commitLocalToolWorksetAction(state.session.id, establishInput());
  assert.equal(result.idempotent, false);
  assert.equal(result.session.revision, before.revision + 1);
  assert.equal(state.verifierCalls.length, 1);

  const toolRun = result.session.toolRuns.find(item => item.id === 'tool-smart-edit');
  assert.equal(toolRun.type, 'canvas-smart-edit');
  assert.equal(toolRun.status, 'succeeded');
  assert.equal(toolRun.provider, 'local');
  assert.equal(toolRun.model, 'ffmpeg-timeline');
  assert.deepEqual(toolRun.inputRefs.map(ref => [ref.nodeId, ref.kind]), [
    ['video-source', 'video'],
    ['audio-source', 'audio']
  ]);

  const nodeRef = result.session.currentNodeRefs.find(item => item.nodeId === 'node-smart-edit');
  assert.equal(nodeRef.kind, 'tool');
  assert.equal(nodeRef.nodeRole, 'smart-edit-workbench');
  assert.equal(nodeRef.toolRunId, toolRun.id);
  const message = result.session.messages.find(item => item.eventId === 'event-smart-edit-established');
  assert.equal(message.kind, 'tool-status');
  assert.equal(message.attachments[0].assetId, 'node-smart-edit');

  const replay = state.service.commitLocalToolWorksetAction(state.session.id, establishInput());
  assert.equal(replay.idempotent, true);
  assert.equal(state.verifierCalls.length, 1, '幂等重放不得重新读取或复制来源');
  assert.equal(replay.session.revision, result.session.revision);
  assert.equal(replay.session.toolRuns.filter(item => item.id === 'tool-smart-edit').length, 1);
  assert.equal(replay.session.currentNodeRefs.filter(item => item.nodeId === 'node-smart-edit').length, 1);
  assert.equal(replay.session.messages.filter(item => item.eventId === 'event-smart-edit-established').length, 1);
  assert.throws(() => state.service.commitLocalToolWorksetAction(state.session.id, establishInput({
    sourceNodeIds: ['video-source']
  })), error => error?.code === 'IDEMPOTENCY_CONFLICT');
});

test('M6C1：非法来源在写入前失败，Session 文件字节不变', () => {
  const state = fixture();
  const before = fs.readFileSync(state.service.roots.storePath);
  assert.throws(() => state.service.commitLocalToolWorksetAction(state.session.id, establishInput({
    requestId: 'non-current-source-request',
    sourceNodeIds: ['missing-source']
  })), error => error?.code === 'AGENT_LOCAL_SOURCE_INVALID');
  assert.deepEqual(fs.readFileSync(state.service.roots.storePath), before);
});

test('M6C1：导出到画布只预留一个本地视频 ToolRun、current ref 与消息', () => {
  const state = fixture();
  state.service.commitLocalToolWorksetAction(state.session.id, establishInput());
  const result = state.service.commitLocalToolWorksetAction(state.session.id, {
    requestId: 'prepare-canvas-export-request',
    action: 'prepare-canvas-export',
    toolRunId: 'tool-local-export',
    nodeId: 'node-local-export',
    eventId: 'event-local-export-prepared',
    smartEditNodeId: 'node-smart-edit',
    exportId: 'export-local-video-1',
    exportPlan: exportPlan()
  });
  const toolRun = result.session.toolRuns.find(item => item.id === 'tool-local-export');
  assert.equal(toolRun.type, 'canvas-local-video-export');
  assert.equal(toolRun.status, 'queued');
  assert.equal(toolRun.operationId, 'export-local-video-1');
  assert.deepEqual(toolRun.executionPayload.exportPlan, exportPlan());
  const nodeRef = result.session.currentNodeRefs.find(item => item.nodeId === 'node-local-export');
  assert.equal(nodeRef.kind, 'video');
  assert.equal(nodeRef.nodeRole, 'local-video-export');
  assert.equal(nodeRef.toolRunId, toolRun.id);
  assert.equal(result.session.messages.filter(item => item.eventId === 'event-local-export-prepared').length, 1);

  const replay = state.service.commitLocalToolWorksetAction(state.session.id, {
    requestId: 'prepare-canvas-export-request',
    action: 'prepare-canvas-export',
    toolRunId: 'tool-local-export',
    nodeId: 'node-local-export',
    eventId: 'event-local-export-prepared',
    smartEditNodeId: 'node-smart-edit',
    exportId: 'export-local-video-1',
    exportPlan: exportPlan()
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.session.currentNodeRefs.filter(item => item.nodeId === 'node-local-export').length, 1);
  const beforeDuplicate = fs.readFileSync(state.service.roots.storePath);
  assert.throws(() => state.service.commitLocalToolWorksetAction(state.session.id, {
    requestId: 'prepare-canvas-export-with-new-request',
    action: 'prepare-canvas-export',
    toolRunId: 'tool-local-export-duplicate',
    nodeId: 'node-local-export-duplicate',
    eventId: 'event-local-export-duplicate',
    smartEditNodeId: 'node-smart-edit',
    exportId: 'export-local-video-1',
    exportPlan: exportPlan()
  }), error => error?.code === 'AGENT_LOCAL_EXPORT_EXISTS');
  assert.deepEqual(fs.readFileSync(state.service.roots.storePath), beforeDuplicate);
});

test('M6C2：导出计划必须原子锁定片段顺序、裁剪、BGM 与输出规格', () => {
  const state = fixture();
  state.service.commitLocalToolWorksetAction(state.session.id, establishInput());
  const beforeMissingPlan = fs.readFileSync(state.service.roots.storePath);
  assert.throws(() => state.service.commitLocalToolWorksetAction(state.session.id, {
    requestId: 'prepare-export-without-plan',
    action: 'prepare-canvas-export',
    toolRunId: 'tool-export-without-plan',
    nodeId: 'node-export-without-plan',
    eventId: 'event-export-without-plan',
    smartEditNodeId: 'node-smart-edit',
    exportId: 'export-without-plan'
  }), error => error?.code === 'AGENT_LOCAL_EXPORT_PLAN_INVALID');
  assert.deepEqual(fs.readFileSync(state.service.roots.storePath), beforeMissingPlan);

  const input = {
    requestId: 'prepare-locked-export-plan',
    action: 'prepare-canvas-export',
    toolRunId: 'tool-locked-export-plan',
    nodeId: 'node-locked-export-plan',
    eventId: 'event-locked-export-plan',
    smartEditNodeId: 'node-smart-edit',
    exportId: 'export-locked-plan',
    exportPlan: exportPlan()
  };
  const prepared = state.service.commitLocalToolWorksetAction(state.session.id, input);
  const run = prepared.session.toolRuns.find(item => item.id === input.toolRunId);
  assert.deepEqual(run.executionPayload.exportPlan, exportPlan());
  assert.throws(() => state.service.commitLocalToolWorksetAction(state.session.id, {
    ...input,
    exportPlan: { ...exportPlan(), bgm: { nodeId: 'audio-source', volume: 0.5 } }
  }), error => error?.code === 'IDEMPOTENCY_CONFLICT');
});

test('M6C1：HTTP 入口只接受物理节点、Session ref、ToolRun 与本地文件四方一致的来源', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-local-workset-route-'));
  const canvasId = 'canvas-local-route';
  const sourceNodeId = 'video-route-source';
  const sourceToolRunId = 'tool-video-route-source';
  const sourceName = 'video-route-source.mp4';
  const sourceBytes = Buffer.from('m6c1-local-video-fixture');
  fs.writeFileSync(path.join(outputRoot, sourceName), sourceBytes);
  fs.mkdirSync(path.join(outputRoot, 'canvases'), { recursive: true });
  const router = canvasRoutes({ outputRoot, agentRunService: {} });

  await withServer(router, async baseUrl => {
    const createdResponse = await requestJson(baseUrl, '/api/canvas/agent-sessions', 'POST', {
      requestId: 'create-local-route-session',
      canvasId,
      workspaceScope: 'canvas-agent',
      mode: 'generation'
    });
    assert.equal(createdResponse.status, 201);
    const session = (await createdResponse.json()).session;
    assert.ok(session?.id);

    assert.equal((await requestJson(baseUrl, `/api/canvas/agent-sessions/${session.id}/tool-runs/${sourceToolRunId}`, 'PUT', {
      requestId: 'seed-route-source-tool',
      type: 'native-video',
      status: 'succeeded',
      nodeId: sourceNodeId,
      provider: 'fixture-provider',
      model: 'fixture-video'
    })).status, 200);
    assert.equal((await requestJson(baseUrl, `/api/canvas/agent-sessions/${session.id}/current-nodes/${sourceNodeId}`, 'PUT', {
      requestId: 'seed-route-source-ref',
      workspaceScope: 'canvas-agent',
      kind: 'video',
      nodeRole: 'video-output',
      toolRunId: sourceToolRunId
    })).status, 200);

    const canvasPath = path.join(outputRoot, 'canvases', `${canvasId}.json`);
    const physicalNode = {
      id: sourceNodeId,
      type: 'smart-image',
      x: 0,
      y: 0,
      outputKind: 'video',
      images: [{ kind: 'video', url: `/canvas-output/${sourceName}`, name: sourceName }],
      taskState: { status: 'completed' },
      agentNative: {
        workspaceScope: 'canvas-agent',
        agentSessionId: session.id,
        toolRunId: sourceToolRunId,
        kind: 'video'
      }
    };
    fs.writeFileSync(canvasPath, JSON.stringify({ id: canvasId, title: 'M6C1', nodes: [physicalNode], connections: [] }));

    const actionPath = `/api/canvas/agent-sessions/${session.id}/local-workset-actions`;
    const input = establishInput({
      requestId: 'route-establish-smart-edit',
      toolRunId: 'tool-route-smart-edit',
      nodeId: 'node-route-smart-edit',
      eventId: 'event-route-smart-edit',
      sourceNodeIds: [sourceNodeId]
    });
    const response = await requestJson(baseUrl, actionPath, 'POST', input);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.session.toolRuns.filter(item => item.id === input.toolRunId).length, 1);
    assert.equal(body.session.currentNodeRefs.filter(item => item.nodeId === input.nodeId).length, 1);
    assert.equal(body.session.messages.filter(item => item.eventId === input.eventId).length, 1);
    assert.equal(body.session.toolRuns.find(item => item.id === input.toolRunId).inputRefs[0].contentHash,
      require('node:crypto').createHash('sha256').update(sourceBytes).digest('hex'));

    const replay = await requestJson(baseUrl, actionPath, 'POST', input);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);

    const smartToolNode = {
      id: input.nodeId,
      type: 'smart-minimax',
      x: 100,
      y: 100,
      images: [],
      agentNative: {
        workspaceScope: 'canvas-agent',
        agentSessionId: session.id,
        toolRunId: input.toolRunId,
        kind: 'tool',
        nodeRole: 'smart-edit-workbench'
      }
    };
    fs.writeFileSync(canvasPath, JSON.stringify({
      id: canvasId,
      title: 'M6C1',
      nodes: [physicalNode, smartToolNode],
      connections: []
    }));
    const exportInput = {
      requestId: 'route-prepare-canvas-export',
      action: 'prepare-canvas-export',
      toolRunId: 'tool-route-local-export',
      nodeId: 'node-route-local-export',
      eventId: 'event-route-local-export',
      smartEditNodeId: input.nodeId,
      exportId: 'export-route-local-video-1',
      exportPlan: {
        clips: [{ nodeId: sourceNodeId, start: 0, end: 1.25 }],
        bgm: null,
        output: { width: 720, height: 1280 }
      }
    };
    const exportResponse = await requestJson(baseUrl, actionPath, 'POST', exportInput);
    assert.equal(exportResponse.status, 201);
    const exportBody = await exportResponse.json();
    assert.equal(exportBody.session.toolRuns.filter(item => item.id === exportInput.toolRunId).length, 1);
    assert.equal(exportBody.session.currentNodeRefs.filter(item => item.nodeId === exportInput.nodeId).length, 1);
    assert.equal(exportBody.session.messages.filter(item => item.eventId === exportInput.eventId).length, 1);
    const exportReplay = await requestJson(baseUrl, actionPath, 'POST', exportInput);
    assert.equal(exportReplay.status, 200);
    assert.equal((await exportReplay.json()).idempotent, true);

    const storePath = path.join(outputRoot, '.state', 'agent-sessions', 'sessions.json');
    const beforeInvalid = fs.readFileSync(storePath);
    fs.writeFileSync(canvasPath, JSON.stringify({ id: canvasId, title: 'M6C1', nodes: [], connections: [] }));
    const invalid = await requestJson(baseUrl, actionPath, 'POST', establishInput({
      requestId: 'route-missing-physical-source',
      toolRunId: 'tool-route-invalid',
      nodeId: 'node-route-invalid',
      eventId: 'event-route-invalid',
      sourceNodeIds: [sourceNodeId]
    }));
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json()).code, 'AGENT_LOCAL_SOURCE_INVALID');
    assert.deepEqual(fs.readFileSync(storePath), beforeInvalid, '物理来源失败不得留下半写 Session 状态');
  });
});

function makePhysicalMediaNode({ sessionId, nodeId, toolRunId, kind, fileName }) {
  return {
    id: nodeId,
    type: 'smart-image',
    x: 0,
    y: 0,
    outputKind: kind,
    images: [{ kind, url: `/canvas-output/${fileName}`, name: fileName }],
    taskState: { status: 'completed' },
    agentNative: {
      workspaceScope: 'canvas-agent',
      agentSessionId: sessionId,
      toolRunId,
      kind
    }
  };
}

function agentExportFixture({ withBgm = false, failFfmpeg = false } = {}) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m6c2-export-'));
  const canvasId = `canvas-m6c2-${withBgm ? 'bgm' : 'plain'}`;
  const sourceFiles = {
    'video-source': { kind: 'video', name: 'm6c2-video-source.mp4', bytes: Buffer.from('m6c2-video-source') },
    'audio-source': { kind: 'audio', name: 'm6c2-audio-source.wav', bytes: Buffer.from('m6c2-audio-source') }
  };
  for (const source of Object.values(sourceFiles)) fs.writeFileSync(path.join(outputRoot, source.name), source.bytes);
  const service = createAgentSessionService({
    outputRoot,
    verifyLocalWorksetSources({ sourceRefs }) {
      return sourceRefs.map(ref => {
        const source = sourceFiles[ref.nodeId];
        return {
          nodeId: ref.nodeId,
          kind: ref.kind,
          toolRunId: ref.toolRunId,
          url: `/canvas-output/${source.name}`,
          contentHash: crypto.createHash('sha256').update(source.bytes).digest('hex'),
          byteLength: source.bytes.length
        };
      });
    }
  });
  const session = service.createSession({
    requestId: `create-${canvasId}`,
    canvasId,
    workspaceScope: 'canvas-agent',
    mode: 'generation'
  }).session;
  seedNativeSource(service, session.id, 'video-source', 'video');
  if (withBgm) seedNativeSource(service, session.id, 'audio-source', 'audio');
  const sourceNodeIds = withBgm ? ['video-source', 'audio-source'] : ['video-source'];
  service.commitLocalToolWorksetAction(session.id, establishInput({
    requestId: `establish-${canvasId}`,
    sourceNodeIds
  }));
  const exportId = `export-${canvasId}`;
  const exportToolRunId = `tool-export-${canvasId}`;
  const exportNodeId = `node-export-${canvasId}`;
  service.commitLocalToolWorksetAction(session.id, {
    requestId: `prepare-${canvasId}`,
    action: 'prepare-canvas-export',
    toolRunId: exportToolRunId,
    nodeId: exportNodeId,
    eventId: `event-export-${canvasId}`,
    smartEditNodeId: 'node-smart-edit',
    exportId,
    exportPlan: exportPlan({ withBgm })
  });

  fs.mkdirSync(path.join(outputRoot, 'canvases'), { recursive: true });
  const physicalNodes = sourceNodeIds.map(nodeId => makePhysicalMediaNode({
    sessionId: session.id,
    nodeId,
    toolRunId: `tool-${nodeId}`,
    kind: sourceFiles[nodeId].kind,
    fileName: sourceFiles[nodeId].name
  }));
  physicalNodes.push({
    id: 'node-smart-edit',
    type: 'smart-minimax',
    x: 100,
    y: 100,
    images: [],
    agentNative: {
      workspaceScope: 'canvas-agent',
      agentSessionId: session.id,
      toolRunId: 'tool-smart-edit',
      kind: 'tool',
      nodeRole: 'smart-edit-workbench'
    }
  });
  physicalNodes.push({
    id: exportNodeId,
    type: 'smart-image',
    x: 200,
    y: 100,
    outputKind: 'video',
    images: [],
    taskState: { status: 'queued' },
    agentNative: {
      workspaceScope: 'canvas-agent',
      agentSessionId: session.id,
      toolRunId: exportToolRunId,
      kind: 'video',
      nodeRole: 'local-video-export'
    }
  });
  fs.writeFileSync(path.join(outputRoot, 'canvases', `${canvasId}.json`), JSON.stringify({
    id: canvasId,
    title: 'M6C2',
    nodes: physicalNodes,
    connections: []
  }));

  const processCalls = [];
  const runSmartCanvasMediaProcess = async (binary, args) => {
    processCalls.push({ binary, args: [...args] });
    if (binary === 'fixture-ffprobe') {
      if (args.includes('-select_streams')) return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: JSON.stringify({
        streams: [
          { codec_type: 'video', width: 720, height: 1280, duration: '1.5' },
          { codec_type: 'audio', duration: '1.5' }
        ],
        format: { duration: '1.5' }
      }), stderr: '' };
    }
    if (failFfmpeg) return { code: 1, stdout: '', stderr: 'fixture ffmpeg failure' };
    const target = args.at(-1);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(`m6c2-render-${processCalls.length}`));
    return { code: 0, stdout: '', stderr: '' };
  };
  const router = canvasRoutes({
    outputRoot,
    agentRunService: {},
    agentSessionService: service,
    smartCanvasFfmpegBinary: 'fixture-ffmpeg',
    smartCanvasFfprobeBinary: 'fixture-ffprobe',
    runSmartCanvasMediaProcess
  });
  return {
    outputRoot,
    service,
    session,
    exportId,
    exportToolRunId,
    exportNodeId,
    sourceFiles,
    processCalls,
    router,
    body: {
      agentSessionId: session.id,
      toolRunId: exportToolRunId,
      exportId,
      requestId: `execute-${exportId}`
    }
  };
}

test('M6C2：Agent 本地导出使用稳定 exportId、临时输出和成功重放零重复合成', async () => {
  const state = agentExportFixture();
  await withServer(state.router, async baseUrl => {
    const first = await requestJson(baseUrl, '/api/smart-canvas/minimax-export', 'POST', state.body);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const expectedName = `agent-local-export-${state.exportId}.mp4`;
    const finalPath = path.join(state.outputRoot, expectedName);
    assert.equal(firstBody.name, expectedName);
    assert.equal(firstBody.url, `/canvas-output/${expectedName}`);
    assert.equal(firstBody.idempotent, false);
    assert.ok(fs.existsSync(finalPath));
    assert.ok(state.processCalls.filter(call => call.binary === 'fixture-ffmpeg').every(call => call.args.at(-1) !== finalPath),
      'ffmpeg 不得直接写最终文件');
    assert.ok(!state.processCalls.some(call => call.args.includes(path.join(state.outputRoot, state.sourceFiles['audio-source'].name))),
      '无 BGM 计划不得偷偷加入音频来源');
    const callCount = state.processCalls.length;

    const replay = await requestJson(baseUrl, '/api/smart-canvas/minimax-export', 'POST', state.body);
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.idempotent, true);
    assert.equal(state.processCalls.length, callCount, '成功重放不得再次调用 ffmpeg/ffprobe');
    const session = state.service.loadSession(state.session.id);
    assert.equal(session.toolRuns.find(item => item.id === state.exportToolRunId).status, 'succeeded');
    assert.equal(session.currentNodeRefs.filter(item => item.nodeId === state.exportNodeId).length, 1);
  });
});

test('M6C2：BGM 只从已锁定音频节点混入，来源摘要变化在执行前失败', async () => {
  const state = agentExportFixture({ withBgm: true });
  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, '/api/smart-canvas/minimax-export', 'POST', state.body);
    assert.equal(response.status, 200);
    const audioPath = path.join(state.outputRoot, state.sourceFiles['audio-source'].name);
    const mixCall = state.processCalls.find(call => call.binary === 'fixture-ffmpeg'
      && call.args.includes(audioPath)
      && call.args.some(value => String(value).includes('amix=inputs=2')));
    assert.ok(mixCall, 'BGM 计划必须形成一条显式混音命令');
  });

  const changed = agentExportFixture({ withBgm: true });
  fs.appendFileSync(path.join(changed.outputRoot, changed.sourceFiles['audio-source'].name), 'changed-after-plan-lock');
  await withServer(changed.router, async baseUrl => {
    const before = fs.readFileSync(changed.service.roots.storePath);
    const response = await requestJson(baseUrl, '/api/smart-canvas/minimax-export', 'POST', changed.body);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'AGENT_LOCAL_SOURCE_INVALID');
    assert.equal(changed.processCalls.length, 0, '来源失配必须在 ffmpeg 前失败');
    assert.deepEqual(fs.readFileSync(changed.service.roots.storePath), before);
  });
});

test('M6C2：ffmpeg 失败不发布最终文件，导出占位保持可诊断状态', async () => {
  const state = agentExportFixture({ failFfmpeg: true });
  await withServer(state.router, async baseUrl => {
    const response = await requestJson(baseUrl, '/api/smart-canvas/minimax-export', 'POST', state.body);
    assert.equal(response.status, 500);
    const finalPath = path.join(state.outputRoot, `agent-local-export-${state.exportId}.mp4`);
    assert.equal(fs.existsSync(finalPath), false);
    const session = state.service.loadSession(state.session.id);
    const run = session.toolRuns.find(item => item.id === state.exportToolRunId);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /fixture ffmpeg failure/);
    assert.equal(session.currentNodeRefs.filter(item => item.nodeId === state.exportNodeId).length, 1,
      '失败只更新占位状态，不删除节点身份');
  });
});

test('M6C2：普通 requestId 不会误入 Agent 分支，不完整 Agent 身份则失败关闭', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-m6c2-legacy-identity-'));
  const router = canvasRoutes({
    outputRoot,
    agentRunService: {},
    smartCanvasFfmpegBinary: 'fixture-ffmpeg'
  });
  await withServer(router, async baseUrl => {
    const ordinary = await requestJson(baseUrl, '/api/smart-canvas/minimax-export', 'POST', {
      requestId: 'ordinary-export-request',
      clips: []
    });
    assert.equal(ordinary.status, 400);
    assert.equal((await ordinary.json()).detail, '时间轴里还没有可导出的视频');

    const partialAgent = await requestJson(baseUrl, '/api/smart-canvas/minimax-export', 'POST', {
      agentSessionId: 'partial-agent-session'
    });
    assert.equal(partialAgent.status, 400);
    assert.equal((await partialAgent.json()).code, 'AGENT_LOCAL_EXPORT_IDENTITY_INVALID');
  });
});
