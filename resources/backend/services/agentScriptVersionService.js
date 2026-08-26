const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION_STATUSES = new Set(['draft', 'awaiting-review', 'approved', 'locked', 'superseded']);
const ATTEMPT_STATUSES = new Set(['queued', 'running', 'failed', 'cancelled', 'interrupted', 'completed']);
const REVISION_SCOPES = new Set(['hook', 'character', 'conflict', 'reversal', 'product-placement', 'ending', 'dialogue', 'duration', 'other']);

function safeId(value, fallback = '') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}

function safeText(value, limit = 12000) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function safeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function safeScopes(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(scope => safeId(scope, '')).filter(scope => {
    if (!scope || seen.has(scope)) return false;
    seen.add(scope);
    return true;
  }).slice(0, 20);
}

function resolveInside(root, relativePath) {
  const absolute = path.resolve(root, String(relativePath || ''));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('剧本版本路径超出允许目录');
  return absolute;
}

function atomicWriteFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) throw new Error('剧本版本文件已经存在，拒绝覆盖');
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }
}

function atomicReplaceFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function lineDiff(leftText, rightText) {
  const left = String(leftText).replace(/\r\n?/g, '\n').split('\n');
  const right = String(rightText).replace(/\r\n?/g, '\n').split('\n');
  if (left.length > 1200 || right.length > 1200) throw new Error('剧本行数过多，无法在线对比');
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const rows = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) {
      rows.push({ type: 'same', text: left[leftIndex] });
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftIndex < left.length && (rightIndex >= right.length || table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1])) {
      rows.push({ type: 'removed', text: left[leftIndex] });
      leftIndex += 1;
    } else {
      rows.push({ type: 'added', text: right[rightIndex] });
      rightIndex += 1;
    }
  }
  let changedSections = 0;
  let insideChange = false;
  rows.forEach(row => {
    if (row.type === 'same') insideChange = false;
    else if (!insideChange) {
      changedSections += 1;
      insideChange = true;
    }
  });
  return {
    addedLines: rows.filter(row => row.type === 'added').length,
    removedLines: rows.filter(row => row.type === 'removed').length,
    changedSections,
    rows
  };
}

function normalizeVersion(raw, index) {
  const id = safeId(raw?.id, '');
  if (!id) return null;
  return {
    id,
    number: Math.max(1, Math.floor(Number(raw?.number) || index + 1)),
    parentVersionId: safeId(raw?.parentVersionId, ''),
    operationId: safeId(raw?.operationId, ''),
    source: safeText(raw?.source, 40) || 'initial',
    status: VERSION_STATUSES.has(raw?.status) ? raw.status : 'awaiting-review',
    relativePath: safeText(raw?.relativePath, 500),
    metadataPath: safeText(raw?.metadataPath, 500),
    contentHash: safeText(raw?.contentHash, 128),
    changeScopes: safeScopes(raw?.changeScopes),
    providerId: safeText(raw?.providerId, 120),
    model: safeText(raw?.model, 240),
    createdAt: safeTimestamp(raw?.createdAt),
    approvedAt: safeTimestamp(raw?.approvedAt),
    lockedAt: safeTimestamp(raw?.lockedAt)
  };
}

function normalizeAttempt(raw) {
  const id = safeId(raw?.id, '');
  if (!id) return null;
  return {
    id,
    baseVersionId: safeId(raw?.baseVersionId, ''),
    operationId: safeId(raw?.operationId, ''),
    status: ATTEMPT_STATUSES.has(raw?.status) ? raw.status : 'failed',
    changeScopes: safeScopes(raw?.changeScopes),
    customInstruction: safeText(raw?.customInstruction, 4000),
    providerId: safeText(raw?.providerId, 120),
    model: safeText(raw?.model, 240),
    resultVersionId: safeId(raw?.resultVersionId, ''),
    error: safeText(raw?.error, 2000),
    createdAt: safeTimestamp(raw?.createdAt),
    updatedAt: safeTimestamp(raw?.updatedAt),
    completedAt: safeTimestamp(raw?.completedAt)
  };
}

function uniqueRecords(records, normalizeRecord) {
  const seen = new Set();
  const output = [];
  records.forEach((record, index) => {
    const normalized = normalizeRecord(record, index);
    if (!normalized || seen.has(normalized.id)) return;
    seen.add(normalized.id);
    output.push(normalized);
  });
  return output;
}

function normalizeScriptReview(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const versions = uniqueRecords((Array.isArray(source.versions) ? source.versions : []).slice(0, 500), normalizeVersion);
  const attempts = uniqueRecords((Array.isArray(source.attempts) ? source.attempts : []).slice(-500), normalizeAttempt);
  const versionIds = new Set(versions.map(version => version.id));
  const validReference = value => {
    const id = safeId(value, '');
    return versionIds.has(id) ? id : '';
  };
  return {
    activeVersionId: validReference(source.activeVersionId),
    approvedVersionId: validReference(source.approvedVersionId),
    lockedVersionId: validReference(source.lockedVersionId),
    versions,
    attempts,
    initializedAt: safeTimestamp(source.initializedAt),
    updatedAt: safeTimestamp(source.updatedAt)
  };
}

function hasLockedScript(run) {
  const review = run?.scriptReview;
  if (!review || typeof review !== 'object') return false;
  const lockedVersionId = safeId(review.lockedVersionId, '');
  return Boolean(lockedVersionId && Array.isArray(review.versions) && review.versions.some(version => (
    safeId(version?.id, '') === lockedVersionId && version?.status === 'locked'
  )));
}

function createAgentScriptVersionService(options = {}) {
  if (!options.projectRoot || typeof options.saveRun !== 'function') {
    throw new Error('剧本版本服务初始化参数不完整');
  }
  const projectRoot = path.resolve(String(options.projectRoot));
  const activeRevisionControllers = new Map();

  function loadRun(runId) {
    if (typeof options.loadRun !== 'function') throw new Error('剧本版本服务尚未接入 Run 读取器');
    const run = options.loadRun(safeId(runId, ''));
    if (!run) throw new Error('Agent Run 不存在');
    return run;
  }

  function projectDirectory(run) {
    const slug = safeId(run?.project?.slug, '');
    if (!slug) throw new Error('Agent Run 尚未创建项目目录');
    return resolveInside(projectRoot, slug);
  }

  function ensureReviewState(run) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('Agent Run 无效');
    run.scriptReview = normalizeScriptReview(run.scriptReview);
    return run.scriptReview;
  }

  function initializeReview(runId) {
    const run = loadRun(runId);
    const review = ensureReviewState(run);
    if (review.versions.length > 0) return run;

    const projectDir = projectDirectory(run);
    const sourcePath = resolveInside(projectDir, 'story/final-script.md');
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('阶段 1 最终剧本不存在');
    const content = fs.readFileSync(sourcePath, 'utf8');
    if (content.trim().length < 20) throw new Error('阶段 1 最终剧本内容不完整');

    const now = Date.now();
    const relativePath = 'story/versions/script-v001.md';
    const metadataPath = 'story/versions/script-v001.json';
    const hash = contentHash(content);
    const version = {
      id: 'script-v001',
      number: 1,
      parentVersionId: '',
      operationId: '',
      source: 'initial',
      status: 'awaiting-review',
      relativePath,
      metadataPath,
      contentHash: hash,
      changeScopes: [],
      providerId: '',
      model: '',
      createdAt: now,
      approvedAt: null,
      lockedAt: null
    };

    atomicWriteFile(resolveInside(projectDir, relativePath), content);
    atomicWriteFile(resolveInside(projectDir, metadataPath), JSON.stringify({
      schemaVersion: '1.0',
      ...version
    }, null, 2) + '\n');
    review.versions.push(version);
    review.activeVersionId = version.id;
    review.initializedAt = now;
    review.updatedAt = now;
    return options.saveRun(run);
  }

  function createManualVersion(runId, input = {}) {
    const run = loadRun(runId);
    const review = ensureReviewState(run);
    const operationId = safeId(input.operationId, '');
    if (!operationId) throw new Error('手动修改操作 ID 不能为空');
    const existing = review.versions.find(version => version.operationId === operationId);
    if (existing) return run;

    const content = String(input.content == null ? '' : input.content);
    if (content.trim().length < 20) throw new Error('手动修改后的完整剧本内容不完整');
    const baseVersionId = safeId(input.baseVersionId, '');
    const baseVersion = review.versions.find(version => version.id === baseVersionId);
    if (!baseVersion) throw new Error('手动修改的基准版本不存在');

    const nextNumber = review.versions.reduce((maximum, version) => Math.max(maximum, Number(version.number) || 0), 0) + 1;
    const id = `script-v${String(nextNumber).padStart(3, '0')}`;
    if (review.versions.some(version => version.id === id)) throw new Error('下一个剧本版本 ID 已存在');
    const projectDir = projectDirectory(run);
    const relativePath = `story/versions/${id}.md`;
    const metadataPath = `story/versions/${id}.json`;
    const now = Date.now();
    const hash = contentHash(content);
    const version = {
      id,
      number: nextNumber,
      parentVersionId: baseVersion.id,
      operationId,
      source: 'manual',
      status: 'awaiting-review',
      relativePath,
      metadataPath,
      contentHash: hash,
      changeScopes: [],
      providerId: '',
      model: '',
      createdAt: now,
      approvedAt: null,
      lockedAt: null
    };

    atomicWriteFile(resolveInside(projectDir, relativePath), content);
    atomicWriteFile(resolveInside(projectDir, metadataPath), JSON.stringify({
      schemaVersion: '1.0',
      ...version
    }, null, 2) + '\n');
    review.versions.push(version);
    review.activeVersionId = version.id;
    review.updatedAt = now;
    return options.saveRun(run);
  }

  function appendReviewEvent(run, message, kind) {
    run.events = Array.isArray(run.events) ? run.events : [];
    run.events.push({
      id: `agent_evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      kind: safeText(kind, 40),
      message: safeText(message, 1000),
      createdAt: Date.now()
    });
    run.events = run.events.slice(-200);
  }

  function approveVersion(runId, versionId) {
    const run = loadRun(runId);
    const review = ensureReviewState(run);
    const targetId = safeId(versionId, '');
    const target = review.versions.find(version => version.id === targetId);
    if (!target) throw new Error('剧本版本不存在');
    if (target.status === 'locked' && review.lockedVersionId === target.id) return run;
    review.versions.forEach(version => {
      if (version.id !== target.id && version.status === 'approved') {
        version.status = 'superseded';
        version.approvedAt = null;
      }
    });
    const now = Date.now();
    target.status = 'approved';
    target.approvedAt = now;
    review.activeVersionId = target.id;
    review.approvedVersionId = target.id;
    review.updatedAt = now;
    appendReviewEvent(run, `剧本版本 ${target.id} 已通过，尚未锁定`, 'approved');
    return options.saveRun(run);
  }

  function lockVersion(runId, versionId, lockOptions = {}) {
    const run = loadRun(runId);
    const review = ensureReviewState(run);
    const targetId = safeId(versionId, '');
    const target = review.versions.find(version => version.id === targetId);
    if (!target) throw new Error('剧本版本不存在');
    if (review.lockedVersionId === target.id && target.status === 'locked') return run;
    if (target.status !== 'approved') throw new Error('请先通过该剧本版本');

    const previousLockedId = safeId(review.lockedVersionId, '');
    if (previousLockedId && previousLockedId !== target.id) {
      const confirmedReplacementId = safeId(lockOptions.replaceLockedVersionId, '');
      if (lockOptions.confirmed !== true || confirmedReplacementId !== previousLockedId) {
        throw new Error('替换已锁定版本需要再次确认');
      }
    }

    const projectDir = projectDirectory(run);
    const versionPath = resolveInside(projectDir, target.relativePath);
    if (!fs.existsSync(versionPath) || !fs.statSync(versionPath).isFile()) throw new Error('待锁定的剧本版本文件不存在');
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(versionPath)).digest('hex');
    if (!target.contentHash || actualHash !== target.contentHash) throw new Error('待锁定的剧本版本文件哈希不一致');

    const now = Date.now();
    review.versions.forEach(version => {
      if (version.id !== target.id && version.status === 'locked') {
        version.status = 'superseded';
        version.lockedAt = null;
      }
    });
    target.status = 'locked';
    target.lockedAt = now;
    review.activeVersionId = target.id;
    review.approvedVersionId = '';
    review.lockedVersionId = target.id;
    review.updatedAt = now;
    atomicReplaceFile(resolveInside(projectDir, 'story/locked-script.json'), JSON.stringify({
      schemaVersion: '1.0',
      versionId: target.id,
      relativePath: target.relativePath,
      contentHash: target.contentHash,
      lockedAt: now
    }, null, 2) + '\n');
    if (run.currentStageId === 'microstory') {
      const reviewStage = Array.isArray(run.stages) ? run.stages.find(stage => stage?.id === 'microstory') : null;
      if (reviewStage?.status === 'completed') {
        reviewStage.message = `剧本版本 ${target.id} 已锁定，等待用户确认进入分镜阶段`;
        reviewStage.updatedAt = now;
      }
      run.error = '';
    }
    appendReviewEvent(run, previousLockedId && previousLockedId !== target.id
      ? `已将锁定剧本从 ${previousLockedId} 替换为 ${target.id}`
      : `剧本版本 ${target.id} 已锁定`, 'locked');
    return options.saveRun(run);
  }

  function submitVersion(runId, versionId) {
    let run = loadRun(runId);
    const review = ensureReviewState(run);
    const targetId = safeId(versionId, '');
    const target = review.versions.find(version => version.id === targetId);
    if (!target) throw new Error('剧本版本不存在');
    if (target.status === 'locked' && review.lockedVersionId === targetId) return run;
    const previousLockedId = safeId(review.lockedVersionId, '');
    if (target.status !== 'approved') run = approveVersion(runId, targetId);
    return lockVersion(runId, targetId, { confirmed: true, replaceLockedVersionId: previousLockedId && previousLockedId !== targetId ? previousLockedId : '' });
  }

  function diffVersions(runId, leftVersionId, rightVersionId) {
    const run = loadRun(runId);
    const review = ensureReviewState(run);
    const leftId = safeId(leftVersionId, '');
    const rightId = safeId(rightVersionId, '');
    const leftVersion = review.versions.find(version => version.id === leftId);
    const rightVersion = review.versions.find(version => version.id === rightId);
    if (!leftVersion || !rightVersion) throw new Error('用于对比的剧本版本不存在');
    const projectDir = projectDirectory(run);
    const leftPath = resolveInside(projectDir, leftVersion.relativePath);
    const rightPath = resolveInside(projectDir, rightVersion.relativePath);
    if (!fs.existsSync(leftPath) || !fs.statSync(leftPath).isFile()) throw new Error('左侧剧本版本文件不存在');
    if (!fs.existsSync(rightPath) || !fs.statSync(rightPath).isFile()) throw new Error('右侧剧本版本文件不存在');
    return {
      leftVersionId: leftVersion.id,
      rightVersionId: rightVersion.id,
      ...lineDiff(fs.readFileSync(leftPath, 'utf8'), fs.readFileSync(rightPath, 'utf8'))
    };
  }

  function getVersion(runId, versionId) {
    const run = loadRun(runId);
    const review = ensureReviewState(run);
    const id = safeId(versionId, '');
    const version = review.versions.find(item => item.id === id);
    if (!version) throw new Error('剧本版本不存在');
    const projectDir = projectDirectory(run);
    const versionPath = resolveInside(projectDir, version.relativePath);
    if (!fs.existsSync(versionPath) || !fs.statSync(versionPath).isFile()) throw new Error('剧本版本文件不存在');
    return { run, version, content: fs.readFileSync(versionPath, 'utf8') };
  }

  function revisionPrompt(run, baseContent, changeScopes, customInstruction) {
    const answers = run.questionnaireAnswers && typeof run.questionnaireAnswers === 'object' ? run.questionnaireAnswers : {};
    const scopeLabels = {
      hook: '前三秒钩子', character: '人物关系', conflict: '冲突升级', reversal: '反转',
      'product-placement': '产品自然植入', ending: '结尾回扣', dialogue: '对白', duration: '整体时长', other: '其他修改'
    };
    const facts = [
      `产品名称：${safeText(answers.productName, 500) || '未提供'}`,
      `已确认产品事实：${safeText(answers.facts, 4000) || '未提供，不得虚构'}`,
      `禁说项：${safeText(answers.prohibitedClaims, 2000) || '未提供，仍不得增加未经确认的功效或数据'}`,
      `目标时长：${safeText(answers.durationSeconds, 100) || '沿用原剧本'}`,
      `画幅：${safeText(answers.aspectRatio, 100) || '沿用原设置'}`
    ].join('\n');
    return `请输出修改后的完整剧本，不能只输出片段或修改说明。\n\n修改范围：\n${changeScopes.map(scope => `- ${scopeLabels[scope]}`).join('\n')}\n${changeScopes.includes('other') ? `\n用户补充要求：\n${customInstruction}\n` : ''}\n产品事实锁：\n${facts}\n\n基准剧本：\n${baseContent}`;
  }

  async function startAiRevision(runId, input = {}, runtime = {}) {
    let run = loadRun(runId);
    let review = ensureReviewState(run);
    const operationId = safeId(input.operationId, '');
    if (!operationId) throw new Error('AI 修改操作 ID 不能为空');
    const existingVersion = review.versions.find(version => version.operationId === operationId);
    if (existingVersion) return run;
    const existingAttempt = review.attempts.find(attempt => attempt.operationId === operationId);
    if (existingAttempt) return run;

    const changeScopes = safeScopes(input.changeScopes);
    if (!changeScopes.length || changeScopes.some(scope => !REVISION_SCOPES.has(scope))) throw new Error('请选择有效的剧本修改范围');
    const customInstruction = safeText(input.customInstruction, 4000);
    if (customInstruction && !changeScopes.includes('other')) throw new Error('只有选择“其他修改”后才能填写补充要求');
    if (changeScopes.includes('other') && !customInstruction) throw new Error('选择“其他修改”后请填写补充要求');
    const baseVersionId = safeId(input.baseVersionId, '');
    const baseVersion = review.versions.find(version => version.id === baseVersionId);
    if (!baseVersion) throw new Error('AI 修改的基准版本不存在');
    if (review.attempts.some(attempt => ['queued', 'running'].includes(attempt.status))) {
      const error = new Error('该 Run 已有 AI 修改任务正在运行');
      error.code = 'AGENT_REVISION_BUSY';
      throw error;
    }
    const providerId = safeText(runtime.providerId, 120);
    const model = safeText(runtime.model, 240);
    if (!providerId || !model || typeof runtime.generateText !== 'function' || typeof runtime.runSimilarityCheck !== 'function') {
      throw new Error('AI 修改运行时配置不完整');
    }

    const now = Date.now();
    const attempt = {
      id: `revision-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      baseVersionId,
      operationId,
      status: 'queued',
      changeScopes,
      customInstruction: changeScopes.includes('other') ? customInstruction : '',
      providerId,
      model,
      resultVersionId: '',
      error: '',
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    review.attempts.push(attempt);
    review.updatedAt = now;
    run = options.saveRun(run);
    review = ensureReviewState(run);
    let currentAttempt = review.attempts.find(item => item.id === attempt.id);
    currentAttempt.status = 'running';
    currentAttempt.updatedAt = Date.now();
    run = options.saveRun(run);

    const controller = new AbortController();
    activeRevisionControllers.set(attempt.id, controller);
    const forwardAbort = () => controller.abort();
    if (runtime.signal?.aborted) controller.abort();
    else runtime.signal?.addEventListener?.('abort', forwardAbort, { once: true });
    try {
      const projectDir = projectDirectory(run);
      const basePath = resolveInside(projectDir, baseVersion.relativePath);
      if (!fs.existsSync(basePath) || !fs.statSync(basePath).isFile()) throw new Error('AI 修改的基准版本文件不存在');
      const baseContent = fs.readFileSync(basePath, 'utf8');
      const userPrompt = revisionPrompt(run, baseContent, changeScopes, customInstruction);
      const response = await runtime.generateText({
        purpose: 'script-revision',
        providerId,
        model,
        systemPrompt: '你是 Lavans 画布 AGENT 的剧本修改器。只修改用户勾选的范围，严格遵守产品事实锁，输出完整原创剧本。',
        userPrompt,
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        const error = new Error('AI 修改已取消');
        error.name = 'AbortError';
        throw error;
      }
      const content = safeText(typeof response === 'string' ? response : response?.text, 100000);
      if (content.length < 20) throw new Error('AI 没有返回完整剧本');
      const productName = safeText(run.questionnaireAnswers?.productName, 500);
      if (productName && !content.includes(productName)) throw new Error('AI 修改结果缺少已确认的产品名称');
      const similarity = await runtime.runSimilarityCheck({ content, signal: controller.signal });
      if (controller.signal.aborted) {
        const error = new Error('AI 修改已取消');
        error.name = 'AbortError';
        throw error;
      }
      if (similarity?.pass !== true) throw new Error('AI 修改结果未通过防复刻检查');

      run = loadRun(runId);
      review = ensureReviewState(run);
      currentAttempt = review.attempts.find(item => item.id === attempt.id);
      if (!currentAttempt || currentAttempt.status === 'cancelled') return run;
      const nextNumber = review.versions.reduce((maximum, version) => Math.max(maximum, Number(version.number) || 0), 0) + 1;
      const id = `script-v${String(nextNumber).padStart(3, '0')}`;
      const relativePath = `story/versions/${id}.md`;
      const metadataPath = `story/versions/${id}.json`;
      const createdAt = Date.now();
      const version = {
        id, number: nextNumber, parentVersionId: baseVersion.id, operationId,
        source: 'ai-revision', status: 'awaiting-review', relativePath, metadataPath,
        contentHash: contentHash(content), changeScopes, providerId, model,
        createdAt, approvedAt: null, lockedAt: null
      };
      atomicWriteFile(resolveInside(projectDir, relativePath), content);
      atomicWriteFile(resolveInside(projectDir, metadataPath), JSON.stringify({ schemaVersion: '1.0', ...version }, null, 2) + '\n');
      review.versions.push(version);
      review.activeVersionId = version.id;
      currentAttempt.status = 'completed';
      currentAttempt.resultVersionId = version.id;
      currentAttempt.error = '';
      currentAttempt.updatedAt = createdAt;
      currentAttempt.completedAt = createdAt;
      review.updatedAt = createdAt;
      appendReviewEvent(run, `AI 修改任务 ${attempt.id} 已生成 ${version.id}`, 'completed');
      return options.saveRun(run);
    } catch (error) {
      run = loadRun(runId);
      review = ensureReviewState(run);
      currentAttempt = review.attempts.find(item => item.id === attempt.id);
      if (currentAttempt && currentAttempt.status !== 'cancelled') {
        currentAttempt.status = controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
        currentAttempt.error = safeText(error?.message || 'AI 修改失败', 2000);
        currentAttempt.updatedAt = Date.now();
        currentAttempt.completedAt = Date.now();
        review.updatedAt = Date.now();
        appendReviewEvent(run, `AI 修改任务 ${attempt.id}：${currentAttempt.error}`, currentAttempt.status);
        run = options.saveRun(run);
      }
      return run;
    } finally {
      activeRevisionControllers.delete(attempt.id);
      runtime.signal?.removeEventListener?.('abort', forwardAbort);
    }
  }

  function cancelRevisionAttempt(runId, attemptId) {
    const run = loadRun(runId);
    const review = ensureReviewState(run);
    const id = safeId(attemptId, '');
    const attempt = review.attempts.find(item => item.id === id);
    if (!attempt) throw new Error('AI 修改任务不存在');
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(attempt.status)) return run;
    attempt.status = 'cancelled';
    attempt.error = '用户已取消 AI 修改；已有剧本版本保持不变';
    attempt.updatedAt = Date.now();
    attempt.completedAt = Date.now();
    review.updatedAt = Date.now();
    activeRevisionControllers.get(id)?.abort();
    appendReviewEvent(run, `AI 修改任务 ${id} 已取消`, 'cancelled');
    return options.saveRun(run);
  }

  function recoverInterruptedRevisionAttempts(run) {
    const review = ensureReviewState(run);
    const interrupted = review.attempts.filter(attempt => ['queued', 'running'].includes(attempt.status));
    if (!interrupted.length) return run;
    const now = Date.now();
    interrupted.forEach(attempt => {
      attempt.status = 'interrupted';
      attempt.error = '本地服务重启，AI 修改已中断；已有剧本版本保持不变，可重新发起本次修改';
      attempt.updatedAt = now;
      attempt.completedAt = now;
    });
    review.updatedAt = now;
    appendReviewEvent(run, `服务重启后恢复了 ${interrupted.length} 个中断的 AI 修改任务`, 'interrupted');
    return run;
  }

  function reconcileVersionFiles(run) {
    const review = ensureReviewState(run);
    if (!run?.project?.slug) return run;
    const projectDir = projectDirectory(run);
    const versionsDir = resolveInside(projectDir, 'story/versions');
    if (!fs.existsSync(versionsDir) || !fs.statSync(versionsDir).isDirectory()) return run;
    const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
    const atomicTempPattern = /\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    entries.filter(entry => entry.isFile() && atomicTempPattern.test(entry.name)).forEach(entry => {
      fs.unlinkSync(path.join(versionsDir, entry.name));
    });

    const registeredIds = new Set(review.versions.map(version => version.id));
    const registeredNumbers = new Set(review.versions.map(version => Number(version.number)).filter(Number.isFinite));
    const candidates = entries.filter(entry => entry.isFile() && /^script-v\d{3,}\.json$/i.test(entry.name)).map(entry => {
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(versionsDir, entry.name), 'utf8'));
        return { entry, metadata };
      } catch (_error) { return null; }
    }).filter(Boolean).sort((left, right) => Number(left.metadata?.number) - Number(right.metadata?.number));
    let added = 0;
    candidates.forEach(({ entry, metadata }) => {
      if (String(metadata?.schemaVersion || '') !== '1.0') return;
      const version = normalizeVersion(metadata, review.versions.length);
      if (!version || registeredIds.has(version.id)) return;
      const expectedStem = version.id;
      if (!/^script-v\d{3,}$/i.test(expectedStem)) return;
      if (entry.name !== `${expectedStem}.json`) return;
      if (version.metadataPath !== `story/versions/${expectedStem}.json`) return;
      if (version.relativePath !== `story/versions/${expectedStem}.md`) return;
      if (registeredNumbers.has(Number(version.number))) return;
      if (version.parentVersionId && !registeredIds.has(version.parentVersionId)) return;
      const contentPath = resolveInside(projectDir, version.relativePath);
      if (!fs.existsSync(contentPath) || !fs.statSync(contentPath).isFile()) return;
      if (!version.contentHash || contentHash(fs.readFileSync(contentPath, 'utf8')) !== version.contentHash) return;
      review.versions.push(version);
      registeredIds.add(version.id);
      registeredNumbers.add(Number(version.number));
      review.activeVersionId = version.id;
      added += 1;
    });
    if (added) {
      review.versions.sort((left, right) => Number(left.number) - Number(right.number));
      review.updatedAt = Date.now();
      appendReviewEvent(run, `从完整版本文件安全补登记了 ${added} 个剧本版本`, 'recovered');
    }
    return run;
  }

  return {
    ensureReviewState,
    initializeReview,
    createManualVersion,
    approveVersion,
    lockVersion,
    submitVersion,
    diffVersions,
    getVersion,
    startAiRevision,
    cancelRevisionAttempt,
    recoverInterruptedRevisionAttempts,
    reconcileVersionFiles,
    roots: { projectRoot }
  };
}

module.exports = {
  createAgentScriptVersionService,
  normalizeScriptReview,
  hasLockedScript,
  REVISION_SCOPES,
  VERSION_STATUSES,
  ATTEMPT_STATUSES
};
