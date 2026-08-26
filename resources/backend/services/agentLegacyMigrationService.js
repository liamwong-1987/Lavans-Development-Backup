'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  clone,
  safeId,
  sha256
} = require('./canvasAgentFoundation/atomicJsonStore');

const SCHEMA_VERSION = 1;
const ALGORITHM_VERSION = 'lanvas-agent-legacy-v1';
const MAX_NODES = 100;
const MAX_CONNECTIONS = 200;
const SHELL_TYPES = new Set([
  'smart-agent-stage',
  'smart-agent-approval-artifact',
  'smart-agent-script-version',
  'smart-agent-script-revision'
]);
const DOCUMENT_TYPES = new Set(['prompt', 'text', 'document', 'markdown', 'table', 'smart-document', 'smart-text']);
const IMAGE_TYPES = new Set(['image', 'smart-image', 'result']);
const VIDEO_TYPES = new Set(['video', 'smart-video', 'minimax']);
const AUDIO_TYPES = new Set(['audio', 'smart-audio', 'music']);
const TOOL_TYPES = new Set(['tool', 'smart-tool', 'smart-edit', 'intelligent-edit', 'intelligent-editor']);
const TERMINAL_TASK_STATUSES = new Set(['idle', 'succeeded', 'success', 'completed', 'complete', 'done', 'failed', 'cancelled', 'canceled']);
const SAFE_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'blocked']);
const NON_CURRENT_NODE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'superseded', 'stale']);
const VERSION_CONFLICT_STATUSES = new Set(['ambiguous', 'conflict']);
const MANIFEST_STATUSES = new Set(['prepared', 'session-created', 'completed', 'failed']);

function migrationError(message, statusCode = 400, code = 'LEGACY_MIGRATION_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function identifier(value, label) {
  try {
    return safeId(value, label);
  } catch (_error) {
    throw migrationError(`${label} 不合法`, 400, 'INVALID_ID');
  }
}

function optionalIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try { return safeId(text, 'ID'); } catch (_error) { return ''; }
}

function optionalSourceIdentifier(value, label, code = 'LEGACY_SOURCE_INVALID') {
  const text = String(value || '').trim();
  if (!text) return '';
  try { return safeId(text, label); }
  catch (_error) { throw migrationError(`${label} 不合法`, 409, code); }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function relativePortable(rootPath, filePath) {
  return path.relative(rootPath, filePath).replace(/\\/g, '/');
}

function resolveInside(rootPath, relativePath, code = 'LEGACY_MIGRATION_MANIFEST_INVALID') {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw migrationError('Legacy 内容路径不合法', 409, code);
  }
  const absolute = path.resolve(rootPath, ...normalized.split('/'));
  if (absolute !== rootPath && !absolute.startsWith(`${rootPath}${path.sep}`)) {
    throw migrationError('Legacy 内容路径越界', 409, code);
  }
  return absolute;
}

function fileSnapshot(outputRoot, filePath, required = true) {
  if (!fs.existsSync(filePath)) {
    if (required) throw migrationError('Legacy 来源文件不存在', 404, 'LEGACY_SOURCE_NOT_FOUND');
    return {
      exists: false,
      path: relativePortable(outputRoot, filePath),
      bytes: 0,
      sha256: ''
    };
  }
  let stat;
  let buffer;
  try {
    const relative = path.relative(outputRoot, filePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw migrationError('Legacy 来源路径越界', 409, 'LEGACY_SOURCE_INVALID');
    }
    let cursor = outputRoot;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw migrationError('Legacy 来源路径不能包含符号链接', 409, 'LEGACY_SOURCE_INVALID');
      }
    }
    const realRoot = fs.realpathSync.native(outputRoot);
    const realFile = fs.realpathSync.native(filePath);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
      throw migrationError('Legacy 来源真实路径越界', 409, 'LEGACY_SOURCE_INVALID');
    }
    stat = fs.statSync(realFile);
    if (!stat.isFile()) throw migrationError('Legacy 来源不是普通文件', 409, 'LEGACY_SOURCE_INVALID');
    buffer = fs.readFileSync(realFile);
  } catch (error) {
    if (error?.statusCode) throw error;
    throw migrationError('Legacy 来源在读取期间不可用', 409, 'LEGACY_SOURCE_INVALID');
  }
  return {
    exists: true,
    path: relativePortable(outputRoot, filePath),
    bytes: buffer.length,
    sha256: sha256(buffer),
    buffer
  };
}

function publicSnapshot(snapshot) {
  const value = { ...snapshot };
  delete value.buffer;
  return value;
}

function parseSnapshotJson(snapshot, code, label) {
  try {
    const value = JSON.parse(snapshot.buffer.toString('utf8'));
    if (!isPlainObject(value)) throw new Error('根值必须是对象');
    return value;
  } catch (error) {
    throw migrationError(`${label} 无法解析：${error.message}`, 409, code);
  }
}

function hasRecolorScope(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/^(workspaceScope|scope|namespaceScope)$/i.test(key) && String(child || '').trim().toLowerCase() === 'recolor') return true;
    if (child && typeof child === 'object' && hasRecolorScope(child, seen)) return true;
  }
  return false;
}

function stableOutputValue(node) {
  const values = [
    node.outputUrl,
    node.url,
    node.mediaUrl,
    node.videoUrl,
    node.audioUrl,
    node.resultUrl,
    node.asset?.url
  ];
  for (const collection of [node.images, node.mediaItems, node.outputs]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      values.push(item?.outputUrl, item?.url, item?.asset?.url);
    }
  }
  return values.some(value => {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^(?:https?:\/\/|data:(?:image|video|audio)\/|\/(?:canvas-output|canvas-assets)\/)/i.test(text);
  });
}

function inferKind(node) {
  const explicit = String(node.agentNative?.kind || node.agentKind || node.nodeKind || '').trim().toLowerCase();
  if (['image', 'video', 'audio', 'tool'].includes(explicit)) return explicit;
  const type = String(node.type || '').trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return 'image';
  if (VIDEO_TYPES.has(type)) return 'video';
  if (AUDIO_TYPES.has(type)) return 'audio';
  if (TOOL_TYPES.has(type)) return 'tool';
  if (type === 'output') {
    const url = String(node.outputUrl || node.url || node.mediaUrl || '').toLowerCase();
    if (/\.(mp4|webm|mov)(?:[?#]|$)/.test(url)) return 'video';
    if (/\.(mp3|wav|m4a|ogg)(?:[?#]|$)/.test(url)) return 'audio';
    if (/\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#]|$)/.test(url)) return 'image';
  }
  return '';
}

function taskIdentity(value) {
  return String(value?.remoteTaskId || value?.taskId || value?.currentTaskId || '').trim().slice(0, 240);
}

function taskStatus(value) {
  return String(value?.status || value?.taskStatus || value?.task_status || '').trim().toLowerCase();
}

function taskNeedsReconcile(value, knownTaskEntry = false) {
  const status = taskStatus(value);
  const taskId = taskIdentity(value);
  if (taskId && (!status || !TERMINAL_TASK_STATUSES.has(status))) return true;
  if (status && !TERMINAL_TASK_STATUSES.has(status)) return true;
  return knownTaskEntry && !status;
}

function pushAmbiguity(target, seen, value) {
  const normalized = {
    source: String(value.source || ''),
    runId: String(value.runId || ''),
    nodeId: String(value.nodeId || ''),
    artifactVersionId: String(value.artifactVersionId || ''),
    stageId: String(value.stageId || ''),
    attemptId: String(value.attemptId || ''),
    status: String(value.status || 'unknown'),
    taskId: String(value.taskId || ''),
    reason: String(value.reason || 'remote-state-ambiguous')
  };
  const key = sha256(normalized);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(normalized);
}

function collectRunAmbiguities(run, target, seen) {
  const runId = String(run.id || '');
  const status = taskStatus(run);
  if (!SAFE_RUN_STATUSES.has(status)) {
    pushAmbiguity(target, seen, {
      source: 'legacy-run',
      runId,
      status,
      taskId: taskIdentity(run),
      reason: taskIdentity(run) ? 'legacy-run-not-terminal' : 'legacy-run-missing-task-id'
    });
  }
  for (const stage of Array.isArray(run.stages) ? run.stages : []) {
    const stageStatus = taskStatus(stage);
    if (!taskNeedsReconcile(stage)) continue;
    pushAmbiguity(target, seen, {
      source: 'legacy-stage',
      runId,
      stageId: String(stage?.id || ''),
      status: stageStatus,
      taskId: taskIdentity(stage),
      reason: taskIdentity(stage) ? 'legacy-stage-not-terminal' : 'legacy-stage-missing-task-id'
    });
  }
  for (const attempt of Array.isArray(run.scriptReview?.attempts) ? run.scriptReview.attempts : []) {
    const attemptStatus = taskStatus(attempt);
    if (!taskNeedsReconcile(attempt, true)) continue;
    pushAmbiguity(target, seen, {
      source: 'legacy-script-attempt',
      runId,
      attemptId: String(attempt?.id || ''),
      status: attemptStatus,
      taskId: taskIdentity(attempt),
      reason: taskIdentity(attempt) ? 'legacy-script-attempt-not-terminal' : 'legacy-script-attempt-missing-task-id'
    });
  }
}

function collectNodeAmbiguities(node, runIds, target, seen) {
  const values = [
    { value: node.canvasTask, knownTaskEntry: false },
    { value: isPlainObject(node.taskState) ? node.taskState : null, knownTaskEntry: false },
    { value: node.agentNative, knownTaskEntry: false },
    ...(Array.isArray(node.pendingTasks) ? node.pendingTasks.map(value => ({ value, knownTaskEntry: true })) : [])
  ].filter(entry => isPlainObject(entry.value));
  if (typeof node.taskState === 'string') values.push({ value: { status: node.taskState, taskId: node.taskId, remoteTaskId: node.remoteTaskId }, knownTaskEntry: false });
  if (typeof node.videoStatus === 'string') values.push({ value: { status: node.videoStatus, taskId: node.taskId, remoteTaskId: node.remoteTaskId }, knownTaskEntry: false });
  if (taskNeedsReconcile(node)) values.push({ value: node, knownTaskEntry: false });
  for (const entry of values) {
    const value = entry.value;
    const status = taskStatus(value);
    if (!taskNeedsReconcile(value, entry.knownTaskEntry)) continue;
    const taskId = taskIdentity(value);
    pushAmbiguity(target, seen, {
      source: 'legacy-node-task',
      runId: [...runIds].sort().join(','),
      nodeId: String(node.id || ''),
      status,
      taskId,
      reason: taskId ? 'legacy-node-task-not-terminal' : 'legacy-node-task-missing-task-id'
    });
  }
}

function createAgentLegacyMigrationService(options = {}) {
  const outputRoot = options.outputRoot ? path.resolve(options.outputRoot) : '';
  if (!outputRoot) throw migrationError('迁移输出目录不能为空', 500, 'INVALID_STORE_ROOT');
  const runService = options.agentRunService;
  if (!runService || typeof runService.loadRun !== 'function') {
    throw migrationError('Legacy Run 只读服务不可用', 500, 'LEGACY_RUN_READER_MISSING');
  }
  const sessionServiceProvider = typeof options.getAgentSessionService === 'function'
    ? options.getAgentSessionService
    : () => options.agentSessionService;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const canvasesRoot = path.join(outputRoot, 'canvases');
  const legacyWorkspacePath = path.join(outputRoot, 'canvas-workspace.json');
  const runsRoot = path.join(outputRoot, '.state', 'agent-runs');
  const foundationRoot = path.join(outputRoot, 'agent-foundation', 'artifacts');
  const foundationIndexPath = path.join(foundationRoot, 'artifact-index.json');
  const migrationRoot = path.join(outputRoot, '.state', 'agent-legacy-migrations');
  const sessionRoot = path.join(outputRoot, '.state', 'agent-sessions');

  function now() {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  function assertSafeStateWriteRoot(targetRoot, label) {
    const relative = path.relative(outputRoot, targetRoot);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw migrationError(`${label} 写入路径越界`, 409, 'LEGACY_MIGRATION_WRITE_PATH_INVALID');
    }
    let realOutputRoot;
    try { realOutputRoot = fs.realpathSync.native(outputRoot); }
    catch (_error) { throw migrationError('迁移输出目录不可用', 409, 'LEGACY_MIGRATION_WRITE_PATH_INVALID'); }
    let cursor = outputRoot;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      let stat;
      try { stat = fs.lstatSync(cursor); }
      catch (error) {
        if (error?.code === 'ENOENT') break;
        throw migrationError(`${label} 写入路径不可用`, 409, 'LEGACY_MIGRATION_WRITE_PATH_INVALID');
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw migrationError(`${label} 写入路径不能经过链接或文件`, 409, 'LEGACY_MIGRATION_WRITE_PATH_INVALID');
      }
      let realCursor;
      try { realCursor = fs.realpathSync.native(cursor); }
      catch (_error) { throw migrationError(`${label} 写入路径不可用`, 409, 'LEGACY_MIGRATION_WRITE_PATH_INVALID'); }
      if (realCursor !== realOutputRoot && !realCursor.startsWith(`${realOutputRoot}${path.sep}`)) {
        throw migrationError(`${label} 写入真实路径越界`, 409, 'LEGACY_MIGRATION_WRITE_PATH_INVALID');
      }
    }
  }

  function assertSafeMigrationWriteRoots() {
    assertSafeStateWriteRoot(migrationRoot, '迁移 manifest');
    assertSafeStateWriteRoot(sessionRoot, 'AgentSession');
  }

  function loadWorkspace(canvasId) {
    const primary = path.join(canvasesRoot, `${canvasId}.json`);
    const selected = fs.existsSync(primary) ? primary : canvasId === 'default' ? legacyWorkspacePath : primary;
    if (!fs.existsSync(selected)) throw migrationError('Legacy 画布不存在', 404, 'LEGACY_CANVAS_NOT_FOUND');
    const snapshot = fileSnapshot(outputRoot, selected);
    const raw = parseSnapshotJson(snapshot, 'LEGACY_WORKSPACE_INVALID', 'Legacy 画布');
    const workspace = isPlainObject(raw.workspace) ? raw.workspace : raw;
    const storedId = String(raw.id || workspace.id || canvasId).trim();
    if (storedId !== canvasId) throw migrationError('Legacy 画布 ID 与请求不一致', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
    if (raw.deleted_at || workspace.deleted_at) throw migrationError('已删除画布不能迁移', 409, 'LEGACY_CANVAS_DELETED');
    if (hasRecolorScope(raw)) throw migrationError('一键复色数据不能进入画布 AGENT 迁移', 409, 'RECOLOR_REFERENCE_FORBIDDEN');
    const nodes = Array.isArray(workspace.nodes) ? workspace.nodes : [];
    const connections = Array.isArray(workspace.connections) ? workspace.connections : [];
    if (nodes.length > MAX_NODES || connections.length > MAX_CONNECTIONS) {
      throw migrationError('Legacy 画布超过安全节点或连线限制', 409, 'LEGACY_WORKSPACE_LIMIT_EXCEEDED');
    }
    const nodeIds = new Set();
    for (const node of nodes) {
      if (!isPlainObject(node)) throw migrationError('Legacy 节点不合法', 409, 'LEGACY_WORKSPACE_INVALID');
      const nodeId = identifier(node.id, 'Legacy 节点 ID');
      if (nodeIds.has(nodeId)) throw migrationError('Legacy 节点 ID 重复', 409, 'LEGACY_WORKSPACE_INVALID');
      nodeIds.add(nodeId);
      const nodeCanvasId = String(node.canvasId || node.agentNative?.canvasId || '').trim();
      if (nodeCanvasId && nodeCanvasId !== canvasId) {
        throw migrationError('Legacy 节点引用其他画布', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
      }
    }
    for (const edge of connections) {
      if (!isPlainObject(edge) || !nodeIds.has(String(edge.from || '')) || !nodeIds.has(String(edge.to || ''))) {
        throw migrationError('Legacy 连线引用无效节点', 409, 'LEGACY_WORKSPACE_INVALID');
      }
    }
    return { raw, workspace, nodes, connections, snapshot: publicSnapshot(snapshot) };
  }

  function readPhysicalRuns(canvasId, workspace) {
    const allRuns = new Map();
    const matching = [];
    if (fs.existsSync(runsRoot)) {
      let entries;
      try { entries = fs.readdirSync(runsRoot, { withFileTypes: true }); }
      catch (_error) { throw migrationError('Legacy Run 目录在读取期间不可用', 409, 'LEGACY_SOURCE_INVALID'); }
      for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        const runId = identifier(entry.name.slice(0, -5), 'Legacy Run ID');
        const absolute = path.join(runsRoot, entry.name);
        const snapshot = fileSnapshot(outputRoot, absolute);
        const raw = parseSnapshotJson(snapshot, 'LEGACY_RUN_SOURCE_INVALID', 'Legacy Run');
        if (String(raw.id || '') !== runId) throw migrationError('Legacy Run 文件名与 ID 不一致', 409, 'LEGACY_RUN_SOURCE_INVALID');
        if (hasRecolorScope(raw)) throw migrationError('一键复色数据不能进入画布 AGENT 迁移', 409, 'RECOLOR_REFERENCE_FORBIDDEN');
        let run;
        try { run = runService.loadRun(runId); }
        catch (_error) { throw migrationError('Legacy Run 无法只读加载', 409, 'LEGACY_RUN_SOURCE_INVALID'); }
        if (!run || String(run.id || '') !== runId) throw migrationError('Legacy Run 无法只读加载', 409, 'LEGACY_RUN_SOURCE_INVALID');
        const runCanvasId = String(run.canvasId || raw.canvasId || '').trim();
        if (!runCanvasId) throw migrationError('Legacy Run 缺少 canvasId', 409, 'LEGACY_RUN_SOURCE_INVALID');
        if (String(raw.canvasId || '').trim() !== runCanvasId) {
          throw migrationError('Legacy Run 原始 canvasId 与只读结果不一致', 409, 'LEGACY_RUN_SOURCE_INVALID');
        }
        const record = { run, raw, canvasId: runCanvasId, snapshot: publicSnapshot(snapshot) };
        allRuns.set(runId, record);
        if (runCanvasId === canvasId) matching.push(record);
      }
    }

    const referenced = new Set();
    for (const item of Array.isArray(workspace.workspace.agentRuns) ? workspace.workspace.agentRuns : []) {
      const itemCanvasId = String(item?.canvasId || '').trim();
      if (itemCanvasId && itemCanvasId !== canvasId) {
        throw migrationError('Legacy workspace Run 清单引用其他画布', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
      }
      if (hasRecolorScope(item)) throw migrationError('Legacy workspace Run 清单引用一键复色数据', 409, 'RECOLOR_REFERENCE_FORBIDDEN');
      const runId = optionalSourceIdentifier(item?.id, 'Legacy workspace Run ID');
      if (runId) referenced.add(runId);
    }
    const activeRunId = optionalSourceIdentifier(workspace.workspace.activeAgentRunId, 'Legacy active Run ID');
    if (activeRunId) referenced.add(activeRunId);
    for (const node of workspace.nodes) {
      const runId = optionalSourceIdentifier(node.agentRunId || node.legacyRunId || node.agentNative?.legacyRunId, 'Legacy 节点 Run ID');
      if (runId) referenced.add(runId);
    }
    for (const runId of referenced) {
      const record = allRuns.get(runId);
      if (record && record.canvasId !== canvasId) {
        throw migrationError('Legacy Run 引用属于其他画布', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
      }
    }
    return { allRuns, matching, referenced };
  }

  function readFoundation(canvasId, allRuns) {
    const indexSnapshot = fileSnapshot(outputRoot, foundationIndexPath, false);
    if (!indexSnapshot.exists) {
      return {
        refs: [],
        ambiguities: [],
        sourceIndex: publicSnapshot(indexSnapshot),
        contentSnapshots: []
      };
    }
    const index = parseSnapshotJson(indexSnapshot, 'LEGACY_MIGRATION_MANIFEST_INVALID', 'Foundation 索引');
    if (!isPlainObject(index.artifacts)) throw migrationError('Foundation 索引缺少 artifacts', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
    const refs = [];
    const ambiguities = [];
    const ambiguitySeen = new Set();
    const contentSnapshots = [];
    const artifacts = index.artifacts;
    for (const [artifactKey, artifact] of Object.entries(artifacts)) {
      if (!isPlainObject(artifact)) throw migrationError('Foundation Artifact 不合法', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
      const artifactVersionId = identifier(artifact.artifactVersionId || artifactKey, 'Foundation Artifact ID');
      if (artifactVersionId !== artifactKey) throw migrationError('Foundation Artifact 键与 ID 不一致', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
      const metadata = isPlainObject(artifact.metadata) ? artifact.metadata : {};
      const metadataRunId = optionalSourceIdentifier(
        metadata.runId,
        'Foundation Run ID',
        'LEGACY_MIGRATION_MANIFEST_INVALID'
      );
      if (metadataRunId && allRuns.has(metadataRunId)
        && allRuns.get(metadataRunId).canvasId !== String(metadata.canvasId || '').trim()) {
        throw migrationError('Foundation Artifact 的 canvasId 与 Run 不一致', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
      }
      if (String(metadata.canvasId || '') !== canvasId) continue;
      if (hasRecolorScope(artifact)) throw migrationError('一键复色 Artifact 不能进入画布 AGENT 迁移', 409, 'RECOLOR_REFERENCE_FORBIDDEN');
      const runId = metadataRunId;
      if (runId && allRuns.has(runId) && allRuns.get(runId).canvasId !== canvasId) {
        throw migrationError('Foundation Artifact 引用其他画布的 Run', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
      }
      if (artifact.inputRefs !== undefined && !Array.isArray(artifact.inputRefs)) {
        throw migrationError('Foundation inputRefs 必须是数组', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
      }
      for (const inputRef of artifact.inputRefs || []) {
        const inputId = identifier(inputRef?.artifactVersionId, 'Foundation inputRef');
        const inputArtifact = artifacts[inputId];
        if (!isPlainObject(inputArtifact)) throw migrationError('Foundation inputRef 不存在', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
        const inputCanvasId = String(inputArtifact.metadata?.canvasId || '').trim();
        if (!inputCanvasId) {
          throw migrationError('Foundation inputRef 缺少 canvasId', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
        }
        if (inputCanvasId !== canvasId) {
          throw migrationError('Foundation inputRef 指向其他画布', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
        }
        if (hasRecolorScope(inputArtifact)) throw migrationError('Foundation inputRef 指向一键复色数据', 409, 'RECOLOR_REFERENCE_FORBIDDEN');
      }
      const contentPath = String(artifact.contentPath || '').trim();
      const contentAbsolute = resolveInside(foundationRoot, contentPath);
      const contentSnapshot = fileSnapshot(outputRoot, contentAbsolute);
      const expectedHash = String(artifact.contentHash || '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash) || contentSnapshot.sha256 !== expectedHash) {
        throw migrationError('Foundation Artifact 内容哈希不一致', 409, 'FOUNDATION_CONTENT_HASH_MISMATCH');
      }
      contentSnapshots.push({ artifactVersionId, ...publicSnapshot(contentSnapshot) });
      const status = String(metadata.taskStatus || '').trim().toLowerCase();
      const taskId = String(metadata.taskId || '').trim();
      if (taskNeedsReconcile({ status, taskId })) {
        pushAmbiguity(ambiguities, ambiguitySeen, {
          source: 'foundation-artifact',
          artifactVersionId,
          runId,
          status,
          taskId,
          reason: taskId ? 'foundation-task-not-terminal' : 'foundation-task-status-unknown'
        });
      }
      if (runId && !allRuns.has(runId)) {
        pushAmbiguity(ambiguities, ambiguitySeen, {
          source: 'foundation-artifact',
          artifactVersionId,
          runId,
          status: 'missing',
          reason: 'foundation-run-source-missing'
        });
      }
      refs.push({
        artifactVersionId,
        logicalArtifactId: optionalIdentifier(artifact.logicalArtifactId),
        artifactType: optionalIdentifier(artifact.artifactType),
        version: Math.max(0, Number(artifact.version) || 0),
        contentHash: expectedHash,
        approvalState: String(artifact.approvalState || ''),
        validityState: String(artifact.validityState || ''),
        runId
      });
    }
    refs.sort((left, right) => left.artifactVersionId.localeCompare(right.artifactVersionId));
    contentSnapshots.sort((left, right) => left.artifactVersionId.localeCompare(right.artifactVersionId));
    return {
      refs,
      ambiguities,
      sourceIndex: publicSnapshot(indexSnapshot),
      contentSnapshots
    };
  }

  function classifyNodes(canvasId, workspace, runs, ambiguities, ambiguitySeen) {
    const runIdsForCanvas = new Set(runs.matching.map(item => String(item.run.id)));
    const byId = new Map(workspace.nodes.map(node => [String(node.id), node]));
    const shellRuns = new Map();
    for (const node of workspace.nodes) {
      if (!SHELL_TYPES.has(String(node.type || '').toLowerCase())) continue;
      const runId = optionalSourceIdentifier(node.agentRunId || node.legacyRunId, 'Legacy shell Run ID');
      if (runId) shellRuns.set(String(node.id), runId);
    }
    const adjacentShellRuns = new Map();
    for (const edge of workspace.connections) {
      const fromRun = shellRuns.get(String(edge.from));
      const toRun = shellRuns.get(String(edge.to));
      if (fromRun) {
        const set = adjacentShellRuns.get(String(edge.to)) || new Set();
        set.add(fromRun);
        adjacentShellRuns.set(String(edge.to), set);
      }
      if (toRun) {
        const set = adjacentShellRuns.get(String(edge.from)) || new Set();
        set.add(toRun);
        adjacentShellRuns.set(String(edge.from), set);
      }
    }

    const legacyNodeRefs = [];
    const provisional = [];
    for (const node of workspace.nodes) {
      const nodeId = String(node.id);
      const type = String(node.type || '').trim().toLowerCase();
      const directRunId = optionalSourceIdentifier(node.agentRunId || node.legacyRunId || node.agentNative?.legacyRunId, 'Legacy 节点 Run ID');
      const associatedRunIds = new Set(adjacentShellRuns.get(nodeId) || []);
      if (directRunId) associatedRunIds.add(directRunId);
      for (const runId of associatedRunIds) {
        const record = runs.allRuns.get(runId);
        if (record && record.canvasId !== canvasId) {
          throw migrationError('Legacy 节点与其他画布 Run 相连', 409, 'CROSS_CANVAS_LEGACY_REFERENCE');
        }
      }
      const reasons = [];
      let classification = 'unproven-legacy-node';
      if (node.agentFoundationProjection === true || SHELL_TYPES.has(type)) {
        classification = 'historical-shell';
        reasons.push('legacy-shell-never-current');
      } else if (DOCUMENT_TYPES.has(type) || node.document === true || node.isDocument === true) {
        classification = 'chat-document';
        reasons.push('documents-stay-in-chat');
      } else if (node.agentNative?.agentSessionId) {
        classification = 'owned-by-other-session';
        reasons.push('agent-session-ownership-preserved');
      } else {
        const kind = inferKind(node);
        if (!kind) reasons.push('not-ordinary-media-or-tool');
        if (!associatedRunIds.size) reasons.push('missing-legacy-run-proof');
        if ([...associatedRunIds].some(runId => !runIdsForCanvas.has(runId))) reasons.push('legacy-run-source-missing');
        if (associatedRunIds.size > 1) reasons.push('multiple-legacy-run-owners');
        if (NON_CURRENT_NODE_STATUSES.has(taskStatus(node))) reasons.push('node-status-not-current');
        const before = ambiguities.length;
        collectNodeAmbiguities(node, associatedRunIds, ambiguities, ambiguitySeen);
        if (ambiguities.length > before) reasons.push('remote-task-ambiguous');
        if (VERSION_CONFLICT_STATUSES.has(String(node.versionStatus || '').trim().toLowerCase()) || node.currentVersionAmbiguous === true) {
          reasons.push('current-version-ambiguous');
          pushAmbiguity(ambiguities, ambiguitySeen, {
            source: 'legacy-node-version',
            runId: [...associatedRunIds].sort().join(','),
            nodeId,
            status: 'ambiguous',
            reason: 'current-version-ambiguous'
          });
        }
        if (kind !== 'tool' && !stableOutputValue(node)) reasons.push('stable-output-missing');
        if (!reasons.length) {
          classification = 'current-candidate';
          provisional.push({
            nodeId,
            workspaceScope: 'canvas-agent',
            kind,
            nodeRole: 'legacy-current',
            toolRunId: '',
            assetVersionId: '',
            parentNodeRef: '',
            branchRootRef: '',
            supersedesRef: '',
            finalDelivery: node.finalDelivery === true
          });
        }
      }
      legacyNodeRefs.push({
        nodeId,
        type,
        classification,
        legacyRunIds: [...associatedRunIds].sort(),
        reasons
      });
    }

    const groups = new Map();
    for (const candidate of provisional) {
      const node = byId.get(candidate.nodeId);
      const logicalId = optionalIdentifier(node?.logicalArtifactId || node?.logicalAssetId || node?.assetLogicalId);
      if (!logicalId) continue;
      const group = groups.get(logicalId) || [];
      group.push(candidate);
      groups.set(logicalId, group);
    }
    const rejected = new Set();
    for (const [logicalId, group] of groups.entries()) {
      if (group.length < 2) continue;
      const selected = group.filter(candidate => {
        const node = byId.get(candidate.nodeId);
        return node?.isCurrent === true || String(node?.versionStatus || '').toLowerCase() === 'current';
      });
      if (selected.length === 1) {
        group.filter(candidate => candidate !== selected[0]).forEach(candidate => rejected.add(candidate.nodeId));
      } else {
        group.forEach(candidate => rejected.add(candidate.nodeId));
        pushAmbiguity(ambiguities, ambiguitySeen, {
          source: 'legacy-node-version-group',
          status: 'ambiguous',
          reason: `multiple-current-versions:${logicalId}`
        });
      }
    }
    for (const ref of legacyNodeRefs) {
      if (!rejected.has(ref.nodeId)) continue;
      ref.classification = 'historical-or-ambiguous-version';
      ref.reasons.push('not-selected-current-version');
    }
    return {
      legacyNodeRefs,
      currentNodeCandidates: provisional.filter(candidate => !rejected.has(candidate.nodeId))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    };
  }

  function buildPreview(canvasIdValue) {
    const canvasId = identifier(canvasIdValue, 'Canvas ID');
    const workspace = loadWorkspace(canvasId);
    const runs = readPhysicalRuns(canvasId, workspace);
    const foundation = readFoundation(canvasId, runs.allRuns);
    const ambiguities = [];
    const ambiguitySeen = new Set();
    for (const record of runs.matching) collectRunAmbiguities(record.run, ambiguities, ambiguitySeen);
    for (const runId of runs.referenced) {
      if (runs.allRuns.has(runId)) continue;
      pushAmbiguity(ambiguities, ambiguitySeen, {
        source: 'legacy-run-reference',
        runId,
        status: 'missing',
        reason: 'legacy-run-source-missing'
      });
    }
    for (const ambiguity of foundation.ambiguities) pushAmbiguity(ambiguities, ambiguitySeen, ambiguity);
    const nodes = classifyNodes(canvasId, workspace, runs, ambiguities, ambiguitySeen);
    const legacyRunRefs = runs.matching.map(record => ({
      runId: String(record.run.id),
      status: String(record.run.status || ''),
      updatedAt: Math.max(0, Number(record.run.updatedAt) || 0),
      skillId: optionalIdentifier(record.run.skillId),
      sourcePath: record.snapshot.path,
      sourceHash: record.snapshot.sha256
    })).sort((left, right) => left.runId.localeCompare(right.runId));
    const hasLegacyData = legacyRunRefs.length || foundation.refs.length
      || nodes.legacyNodeRefs.some(ref => ref.classification !== 'unproven-legacy-node');
    if (!hasLegacyData) throw migrationError('该画布没有可迁移的 Legacy AGENT 数据', 404, 'NO_LEGACY_AGENT_DATA');
    ambiguities.sort((left, right) => sha256(left).localeCompare(sha256(right)));
    const reconcileReasons = [...new Set(ambiguities.map(item => item.reason))].sort();
    const base = {
      schemaVersion: SCHEMA_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      canvasId,
      legacyRunRefs,
      foundationArtifactRefs: foundation.refs,
      legacyNodeRefs: nodes.legacyNodeRefs,
      currentNodeCandidates: nodes.currentNodeCandidates,
      ambiguousRemoteTasks: ambiguities,
      reconcileRequired: ambiguities.length > 0,
      reconcileReasons,
      sourceHashes: {
        workspace: workspace.snapshot,
        runs: runs.matching.map(record => ({ runId: String(record.run.id), ...record.snapshot }))
          .sort((left, right) => left.runId.localeCompare(right.runId)),
        foundationIndex: foundation.sourceIndex,
        foundationContents: foundation.contentSnapshots
      }
    };
    const previewHash = sha256(base);
    return clone({
      ...base,
      migrationId: `legacy-migration-${previewHash.slice(0, 32)}`,
      previewHash
    });
  }

  function preview(input = {}) {
    const canvasId = typeof input === 'string' ? input : input.canvasId;
    return buildPreview(canvasId);
  }

  function manifestPath(migrationIdValue) {
    const migrationId = identifier(migrationIdValue, 'Migration ID');
    return path.join(migrationRoot, `${migrationId}.json`);
  }

  function manifestPayload(value) {
    const payload = clone(value);
    delete payload.manifestHash;
    return payload;
  }

  function writeManifest(value) {
    assertSafeStateWriteRoot(migrationRoot, '迁移 manifest');
    const payload = manifestPayload(value);
    const manifest = { ...payload, manifestHash: sha256(payload) };
    atomicWriteJson(manifestPath(manifest.migrationId), manifest);
    return manifest;
  }

  function readManifest(migrationId) {
    assertSafeStateWriteRoot(migrationRoot, '迁移 manifest');
    const filePath = manifestPath(migrationId);
    if (!fs.existsSync(filePath)) return null;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (_error) { throw migrationError('迁移 manifest 无法解析', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID'); }
    if (!isPlainObject(manifest) || !/^[a-f0-9]{64}$/.test(String(manifest.manifestHash || ''))
      || sha256(manifestPayload(manifest)) !== manifest.manifestHash) {
      throw migrationError('迁移 manifest 完整性校验失败', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
    }
    const arrayFields = ['legacyRunRefs', 'foundationArtifactRefs', 'legacyNodeRefs', 'currentNodeCandidates', 'ambiguousRemoteTasks', 'reconcileReasons'];
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.algorithmVersion !== ALGORITHM_VERSION
      || !MANIFEST_STATUSES.has(String(manifest.status || ''))
      || !/^[a-f0-9]{64}$/.test(String(manifest.previewHash || ''))
      || !isPlainObject(manifest.sourceHashes)
      || arrayFields.some(field => !Array.isArray(manifest[field]))) {
      throw migrationError('迁移 manifest 结构校验失败', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
    }
    identifier(manifest.migrationId, 'Migration ID');
    identifier(manifest.canvasId, 'Canvas ID');
    if (manifest.agentSessionId) identifier(manifest.agentSessionId, 'AgentSession ID');
    return manifest;
  }

  function assertPreviewMatches(expected) {
    let current;
    try { current = buildPreview(expected.canvasId); }
    catch (error) {
      const detail = error?.statusCode ? error.message : 'Legacy 来源不可读取';
      throw migrationError(`Legacy 来源无法复核：${detail}`, 409, 'LEGACY_SOURCE_HASH_MISMATCH');
    }
    if (current.previewHash !== expected.previewHash || current.migrationId !== expected.migrationId
      || sha256(current.sourceHashes) !== sha256(expected.sourceHashes)) {
      throw migrationError('Legacy 来源在确认期间发生变化', 409, 'LEGACY_SOURCE_HASH_MISMATCH');
    }
    return current;
  }

  function getSessionService() {
    const service = sessionServiceProvider();
    if (!service || typeof service.createSession !== 'function' || typeof service.setStatus !== 'function'
      || typeof service.loadSession !== 'function' || typeof service.attachCurrentNode !== 'function'
      || typeof service.detachCurrentNode !== 'function') {
      throw migrationError('AgentSession 服务不可用', 500, 'AGENT_SESSION_SERVICE_MISSING');
    }
    return service;
  }

  function sessionSnapshot(previewValue, pending) {
    const reasons = previewValue.reconcileReasons;
    return {
      requestId: `legacy-migration-${pending ? 'stage' : 'finalize'}:${previewValue.previewHash}`,
      status: pending || previewValue.reconcileRequired ? 'blocked' : 'idle',
      currentPhase: pending ? 'legacy-migration-source-check' : 'legacy-migration-complete',
      nextAction: previewValue.reconcileRequired ? '核对旧任务与当前版本后再继续' : '在持续聊天中继续工作',
      recoveryStatus: pending ? 'migration-pending-source-check' : previewValue.reconcileRequired ? 'reconcile-required' : 'migration-complete',
      blockedReason: pending ? '迁移来源尚未完成最终哈希复核' : reasons.join('；'),
      reconcileRequired: pending || previewValue.reconcileRequired,
      legacyRunRefs: previewValue.legacyRunRefs,
      foundationArtifactRefs: previewValue.foundationArtifactRefs,
      plan: {
        kind: 'legacy-agent-migration',
        migrationId: previewValue.migrationId,
        previewHash: previewValue.previewHash,
        currentNodeCandidateIds: previewValue.currentNodeCandidates.map(item => item.nodeId)
      },
      constraints: {
        sourceHashes: previewValue.sourceHashes,
        ambiguousRemoteTasks: previewValue.ambiguousRemoteTasks,
        reconcileReasons: previewValue.reconcileReasons
      }
    };
  }

  function assertMigrationSession(session, previewValue, sessionId) {
    if (!session || session.id !== sessionId || session.canvasId !== previewValue.canvasId
      || session.workspaceScope !== 'canvas-agent') {
      throw migrationError('迁移 manifest 与 AgentSession 归属不一致', 409, 'LEGACY_MIGRATION_MANIFEST_INVALID');
    }
    return session;
  }

  function failAfterSession(manifest, previewValue, sessionService, sessionId, error) {
    const session = assertMigrationSession(sessionService.loadSession(sessionId), previewValue, sessionId);
    for (const ref of Array.isArray(session?.currentNodeRefs) ? session.currentNodeRefs : []) {
      sessionService.detachCurrentNode(sessionId, ref.nodeId, {
        requestId: `legacy-migration-fail-detach:${previewValue.previewHash.slice(0, 20)}:${sha256({
          nodeId: ref.nodeId,
          attachedAt: ref.attachedAt,
          sessionRevision: session.revision
        }).slice(0, 20)}`
      });
    }
    let current = assertMigrationSession(sessionService.loadSession(sessionId), previewValue, sessionId);
    if (current.currentNodeRefs.length) {
      throw migrationError('迁移引用尚未全部移出当前工作集', 503, 'LEGACY_MIGRATION_CLEANUP_INCOMPLETE');
    }
    sessionService.setStatus(sessionId, {
      requestId: `legacy-migration-fail:${previewValue.previewHash}`,
      status: 'blocked',
      currentPhase: 'legacy-migration-failed',
      nextAction: '重新预览旧数据，不要重发任何远端任务',
      recoveryStatus: 'migration-source-drift',
      blockedReason: 'Legacy 来源已变化，迁移引用已移出当前工作集',
      reconcileRequired: true,
      legacyRunRefs: previewValue.legacyRunRefs,
      foundationArtifactRefs: previewValue.foundationArtifactRefs,
      constraints: {
        sourceHashes: previewValue.sourceHashes,
        ambiguousRemoteTasks: previewValue.ambiguousRemoteTasks,
        reconcileReasons: [...new Set([...previewValue.reconcileReasons, 'legacy-source-drift'])]
      }
    });
    const failedAt = now();
    current = assertMigrationSession(sessionService.loadSession(sessionId), previewValue, sessionId);
    if (current.currentNodeRefs.length) {
      throw migrationError('迁移引用清理后被重新挂接', 503, 'LEGACY_MIGRATION_CLEANUP_INCOMPLETE');
    }
    return writeManifest({
      ...manifest,
      agentSessionId: sessionId,
      status: 'failed',
      updatedAt: failedAt,
      failure: { code: String(error.code || 'LEGACY_SOURCE_HASH_MISMATCH'), message: error.message }
    });
  }

  function failBeforeSession(manifest, error) {
    return writeManifest({
      ...manifest,
      status: 'failed',
      updatedAt: now(),
      failure: { code: String(error.code || 'LEGACY_SOURCE_HASH_MISMATCH'), message: error.message }
    });
  }

  function cleanupSessionAfterDrift(manifest, previewValue, sessionService, sessionId, error) {
    try { return failAfterSession(manifest, previewValue, sessionService, sessionId, error); }
    catch (cleanupError) {
      if (cleanupError?.code === 'LEGACY_MIGRATION_MANIFEST_INVALID') throw cleanupError;
      throw migrationError('迁移清理尚未完成，请使用相同确认请求重试', 503, 'LEGACY_MIGRATION_CLEANUP_INCOMPLETE');
    }
  }

  function failExistingMigrationForDrift(manifest, error) {
    if (manifest.agentSessionId) {
      const sessionService = getSessionService();
      cleanupSessionAfterDrift(manifest, manifest, sessionService, manifest.agentSessionId, error);
    } else {
      failBeforeSession(manifest, error);
    }
  }

  function confirm(input = {}) {
    if (input.confirm !== true) {
      throw migrationError('必须显式确认 Legacy 迁移', 400, 'EXPLICIT_MIGRATION_CONFIRMATION_REQUIRED');
    }
    const canvasId = identifier(input.canvasId, 'Canvas ID');
    const migrationId = identifier(input.migrationId, 'Migration ID');
    const previewHash = String(input.previewHash || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(previewHash)) throw migrationError('previewHash 不合法', 400, 'MIGRATION_PREVIEW_MISMATCH');
    assertSafeMigrationWriteRoots();
    let manifest = readManifest(migrationId);
    if (manifest) {
      if (manifest.canvasId !== canvasId || manifest.previewHash !== previewHash || manifest.migrationId !== migrationId) {
        throw migrationError('同一 migrationId 已绑定其他来源', 409, 'LEGACY_MIGRATION_CONFLICT');
      }
      if (manifest.status === 'completed') {
        const sessionService = getSessionService();
        const session = assertMigrationSession(sessionService.loadSession(manifest.agentSessionId), manifest, manifest.agentSessionId);
        return { manifest, session, idempotent: true };
      }
      if (manifest.status === 'failed') throw migrationError('失败的迁移不能覆盖重做，请重新预览', 409, 'LEGACY_MIGRATION_CONFLICT');
    }

    let previewValue;
    try { previewValue = buildPreview(canvasId); }
    catch (error) {
      if (!manifest) throw error;
      const driftError = migrationError('Legacy 来源在崩溃恢复期间已变化', 409, 'LEGACY_SOURCE_HASH_MISMATCH');
      failExistingMigrationForDrift(manifest, driftError);
      throw driftError;
    }
    if (previewValue.migrationId !== migrationId || previewValue.previewHash !== previewHash) {
      if (!manifest) throw migrationError('迁移确认与当前预览不一致', 409, 'MIGRATION_PREVIEW_MISMATCH');
      const driftError = migrationError('Legacy 来源在崩溃恢复期间已变化', 409, 'LEGACY_SOURCE_HASH_MISMATCH');
      failExistingMigrationForDrift(manifest, driftError);
      throw driftError;
    }

    if (!manifest) {
      const createdAt = now();
      manifest = writeManifest({
        ...previewValue,
        agentSessionId: '',
        status: 'prepared',
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        failure: null
      });
    }

    assertPreviewMatches(previewValue);
    const sessionService = getSessionService();
    const skillIds = [...new Set(previewValue.legacyRunRefs.map(item => item.skillId).filter(Boolean))];
    const created = sessionService.createSession({
      requestId: `legacy-migration-create:${previewHash}`,
      canvasId,
      workspaceScope: 'canvas-agent',
      mode: 'generation',
      skillId: skillIds.length === 1 ? skillIds[0] : '',
      title: '旧版 AGENT 历史迁移'
    });
    const sessionId = created.session.id;
    if (manifest.agentSessionId && manifest.agentSessionId !== sessionId) {
      throw migrationError('迁移 manifest 与幂等 Session 不一致', 409, 'LEGACY_MIGRATION_CONFLICT');
    }
    manifest = writeManifest({ ...manifest, agentSessionId: sessionId, status: 'session-created', updatedAt: now() });

    try {
      sessionService.setStatus(sessionId, sessionSnapshot(previewValue, true));
      assertPreviewMatches(previewValue);
      for (const candidate of previewValue.currentNodeCandidates) {
        sessionService.attachCurrentNode(sessionId, candidate.nodeId, {
          requestId: `legacy-migration-attach:${previewHash.slice(0, 24)}:${sha256(candidate.nodeId).slice(0, 24)}`,
          workspaceScope: 'canvas-agent',
          kind: candidate.kind,
          nodeRole: candidate.nodeRole,
          toolRunId: candidate.toolRunId,
          assetVersionId: candidate.assetVersionId,
          parentNodeRef: candidate.parentNodeRef,
          branchRootRef: candidate.branchRootRef,
          supersedesRef: candidate.supersedesRef,
          finalDelivery: candidate.finalDelivery
        });
      }
      assertPreviewMatches(previewValue);
      sessionService.setStatus(sessionId, sessionSnapshot(previewValue, false));
      assertPreviewMatches(previewValue);
    } catch (error) {
      if (error?.code === 'LEGACY_SOURCE_HASH_MISMATCH') {
        cleanupSessionAfterDrift(manifest, previewValue, sessionService, sessionId, error);
      }
      throw error;
    }

    const completedAt = now();
    try { assertPreviewMatches(previewValue); }
    catch (error) {
      if (error?.code === 'LEGACY_SOURCE_HASH_MISMATCH') {
        cleanupSessionAfterDrift(manifest, previewValue, sessionService, sessionId, error);
      }
      throw error;
    }
    manifest = writeManifest({
      ...manifest,
      status: 'completed',
      updatedAt: completedAt,
      completedAt,
      failure: null
    });
    return { manifest, session: sessionService.loadSession(sessionId), idempotent: false };
  }

  return Object.freeze({ preview, confirm });
}

module.exports = { createAgentLegacyMigrationService };
