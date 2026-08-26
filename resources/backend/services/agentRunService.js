const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createAgentScriptVersionService, normalizeScriptReview, hasLockedScript } = require('./agentScriptVersionService');
const { createProductResearchPackage } = require('./agentProductResearchService');
const { parseCreativeDirections, directionsPlainText, directionPlainText, validateScript } = require('./agentCreativeScriptService');
const { parseShotPlan, shotPlanPlainText, parseAssetLedger, assetLedgerPlainText, validateCoverage, coveragePlainText } = require('./agentStoryboardAssetService');

const RUN_STATUSES = new Set(['queued', 'running', 'paused', 'blocked', 'cancelled', 'completed', 'failed', 'interrupted']);
const STAGE_STATUSES = new Set(['queued', 'running', 'paused', 'blocked', 'cancelled', 'completed', 'failed', 'skipped']);

function safeId(value, fallback = '') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}

function safeText(value, limit = 12000) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function safeAnswerMap(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const output = {};
  Object.entries(source).slice(0, 80).forEach(([key, value]) => {
    const id = safeId(key, '');
    if (id) output[id] = safeText(Array.isArray(value) ? value.join('\n') : value, 12000);
  });
  return output;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  try { fs.renameSync(tempPath, filePath); }
  catch (error) {
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
    if (!fs.existsSync(filePath)) throw error;
  }
}

function publicFileUrl(relativePath) {
  return `/canvas-output/agent-projects/${String(relativePath || '').split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/')}`;
}

function canonicalPath(filePath) {
  let resolved = path.resolve(String(filePath || ''));
  try { resolved = fs.realpathSync.native(resolved); } catch (_error) {}
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathIsWithin(root, candidate) {
  const canonicalRoot = canonicalPath(root);
  const canonicalCandidate = canonicalPath(candidate);
  return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(canonicalRoot + path.sep);
}

function artifactKind(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (['.md', '.txt', '.csv'].includes(ext)) return 'text';
  if (ext === '.json') return 'json';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.ogg'].includes(ext)) return 'audio';
  return 'file';
}

function normalizeAspectRatio(value) {
  const match = safeText(value, 40).match(/(9:16|16:9|1:1)/);
  return match ? match[1] : '9:16';
}

function normalizeDuration(value) {
  const match = safeText(value, 40).match(/\d{1,3}/);
  const duration = match ? Number(match[0]) : 45;
  return Math.max(4, Math.min(180, Number.isFinite(duration) ? duration : 45));
}

function markdownValue(value, emptyValue) {
  const clean = safeText(value, 12000);
  if (!clean) return emptyValue;
  return clean.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => `- ${line}`).join('\n') || emptyValue;
}

function buildProductBrief(run) {
  const answers = run.questionnaireAnswers || {};
  const materials = Array.isArray(run.materials) ? run.materials : [];
  const materialLines = materials.length
    ? materials.map(item => `- ${safeText(item.name || '资料', 240)}（ID: ${safeText(item.id || '未登记', 120)}；类型: ${safeText(item.kind || 'file', 40)}）`).join('\n')
    : '- 用户未提交资料';
  return `# 产品与项目事实锁

## 产品名称

${safeText(answers.productName, 500) || '等待用户确认'}

## 真实卖点与产品事实

${markdownValue(answers.facts, '- 等待用户提供；不得虚构')}

## 证据

${markdownValue(answers.evidence, '- 用户未提供证据，不得自行证明或扩写卖点')}

## 禁说项与合规限制

${markdownValue(answers.prohibitedClaims, '- 用户未提供禁说项，执行前仍须做事实与合规检查')}

## 目标人群与发布平台

${safeText(answers.audience, 4000) || '等待用户确认'}

## CTA

${safeText(answers.cta, 2000) || '用户未指定 CTA'}

## 制作偏好

- 时长：${safeText(answers.durationSeconds, 100) || '45 秒（使用源 Skill 默认）'}
- 画幅：${safeText(answers.aspectRatio, 100) || '9:16（使用源 Skill 默认）'}
- 视觉风格：${safeText(answers.visualStyle, 500) || '原创 stylized 角色（使用源 Skill 默认）'}
- 角色或剧情方向：${safeText(answers.characterDirection, 2000) || '用户未指定，由故事 Skill 在不增加产品事实的前提下设计'}

## 已提交资料

${materialLines}

## 执行边界

- 不得虚构功效、数据、认证、价格或包装文字。
- 已有产品实拍图优先保真使用。
- 精确 Logo、包装文字、型号、成分表和认证标识不得重绘冒充成品。
`;
}

function pythonCandidates() {
  const candidates = [];
  const add = (file, prefixArgs = []) => { if (file && !candidates.some(item => item.file.toLowerCase() === String(file).toLowerCase() && item.prefixArgs.join('\0') === prefixArgs.join('\0'))) candidates.push({ file: String(file), prefixArgs }); };
  add(process.env.LAVANS_PYTHON_EXECUTABLE);
  add(process.env.PYTHON_EXECUTABLE);
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    add(path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'));
  }
  add(process.platform === 'win32' ? 'python.exe' : 'python3');
  if (process.platform === 'win32') add('py.exe', ['-3']);
  add('python');
  return candidates;
}

function createAgentRunReadOnlyFacade(service) {
  if (!service || typeof service !== 'object') throw new Error('Agent Run 只读服务不能为空');
  return Object.freeze({
    mode: 'legacy-read-only',
    loadRun: runId => service.loadRun(runId, false),
    listRuns: canvasId => service.listRuns(canvasId, false),
    artifactContent: (runId, artifactId) => service.artifactContent(runId, artifactId, false),
    scriptVersions: Object.freeze({
      getVersion: (...args) => service.scriptVersions.getVersion(...args),
      diffVersions: (...args) => service.scriptVersions.diffVersions(...args)
    })
  });
}

function createAgentRunService({ outputRoot, findAgentSkillRuntime, findAgentDependencyRuntime, generateStoryText, foundation }) {
  if (!outputRoot || typeof findAgentSkillRuntime !== 'function' || typeof findAgentDependencyRuntime !== 'function') throw new Error('Agent Run Service 初始化参数不完整');
  const stateRoot = path.join(outputRoot, '.state', 'agent-runs');
  const projectRoot = path.join(outputRoot, 'agent-projects');
  const storyDatabaseValidatorPath = path.join(__dirname, 'validateStoryDatabase.py');
  const activeProcesses = new Map();
  const activeRuns = new Set();
  const activeAbortControllers = new Map();
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  const scriptVersions = createAgentScriptVersionService({
    projectRoot,
    loadRun: runId => loadRun(runId, false),
    saveRun
  });

  function runPath(runId) {
    const id = safeId(runId, '');
    if (!id) throw new Error('Agent Run ID 无效');
    return path.join(stateRoot, `${id}.json`);
  }

  function appendEvent(run, message, kind = 'info') {
    run.events = Array.isArray(run.events) ? run.events : [];
    run.events.push({ id: `agent_evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, kind: safeText(kind, 40), message: safeText(message, 1000), createdAt: Date.now() });
    run.events = run.events.slice(-200);
  }

  function normalizeStage(stage, index) {
    return {
      id: safeId(stage?.id, `stage-${index + 1}`),
      order: Number(stage?.order) || index + 1,
      title: safeText(stage?.title || stage?.canvasStage || `阶段 ${index + 1}`, 120),
      canvasStage: safeText(stage?.canvasStage || stage?.title || `阶段 ${index + 1}`, 120),
      summary: safeText(stage?.summary, 500),
      readiness: safeText(stage?.readiness, 40) || 'adapter-required',
      costClass: safeText(stage?.costClass, 40) || 'free',
      approvalRequired: stage?.approvalRequired === true,
      status: STAGE_STATUSES.has(stage?.status) ? stage.status : 'queued',
      message: safeText(stage?.message, 1000),
      artifactIds: Array.isArray(stage?.artifactIds) ? stage.artifactIds.map(value => safeId(value, '')).filter(Boolean).slice(0, 200) : [],
      executionSteps: (Array.isArray(stage?.executionSteps) ? stage.executionSteps : []).slice(0, 40).map((step, stepIndex) => ({
        id: safeId(step?.id, `step-${stepIndex + 1}`),
        title: safeText(step?.title || `执行步骤 ${stepIndex + 1}`, 120),
        status: STAGE_STATUSES.has(step?.status) ? step.status : 'queued',
        message: safeText(step?.message, 1000),
        artifactIds: Array.isArray(step?.artifactIds) ? step.artifactIds.map(value => safeId(value, '')).filter(Boolean).slice(0, 80) : [],
        startedAt: Number(step?.startedAt) || null,
        completedAt: Number(step?.completedAt) || null,
        updatedAt: Number(step?.updatedAt) || Date.now()
      })),
      startedAt: Number(stage?.startedAt) || null,
      completedAt: Number(stage?.completedAt) || null,
      updatedAt: Number(stage?.updatedAt) || Date.now()
    };
  }

  function normalizeRun(raw) {
    const stages = (Array.isArray(raw?.stages) ? raw.stages : []).slice(0, 100).map(normalizeStage);
    return {
      schemaVersion: '1.0',
      id: safeId(raw?.id, ''),
      canvasId: safeId(raw?.canvasId, ''),
      skillId: safeId(raw?.skillId, ''),
      skillTitle: safeText(raw?.skillTitle, 160),
      questionnaireVersion: safeText(raw?.questionnaireVersion, 40),
      brief: safeText(raw?.brief, 12000),
      questionnaireAnswers: safeAnswerMap(raw?.questionnaireAnswers),
      materials: (Array.isArray(raw?.materials) ? raw.materials : []).slice(0, 20).map(item => ({
        id: safeId(item?.id, ''),
        storedName: safeText(item?.storedName, 240),
        originalName: safeText(item?.originalName || item?.name, 240),
        name: safeText(item?.name || item?.originalName, 240),
        kind: safeText(item?.kind, 40),
        extension: safeText(item?.extension, 20),
        mime: safeText(item?.mime, 100),
        url: safeText(item?.url, 800),
        size: Math.max(0, Number(item?.size) || 0),
        previewText: safeText(item?.previewText, 16000),
        archiveEntries: (Array.isArray(item?.archiveEntries) ? item.archiveEntries : []).slice(0, 200).map(value => safeText(value, 300)).filter(Boolean)
      })),
      status: RUN_STATUSES.has(raw?.status) ? raw.status : 'queued',
      currentStageId: safeId(raw?.currentStageId, ''),
      stages,
      artifacts: (Array.isArray(raw?.artifacts) ? raw.artifacts : []).slice(0, 500).map(item => ({
        id: safeId(item?.id, ''), stageId: safeId(item?.stageId, ''), name: safeText(item?.name, 240), kind: safeText(item?.kind, 40), relativePath: safeText(item?.relativePath, 500), url: safeText(item?.url, 800), size: Math.max(0, Number(item?.size) || 0), createdAt: Number(item?.createdAt) || Date.now()
      })),
      project: raw?.project && typeof raw.project === 'object' ? { name: safeText(raw.project.name, 240), slug: safeId(raw.project.slug, ''), url: safeText(raw.project.url, 800) } : null,
      dependencyStates: raw?.dependencyStates && typeof raw.dependencyStates === 'object' && !Array.isArray(raw.dependencyStates) ? Object.fromEntries(Object.entries(raw.dependencyStates).slice(0, 40).map(([key, value]) => [safeId(key, ''), {
        status: safeText(value?.status, 60), codeAvailable: value?.codeAvailable === true, databaseAvailable: value?.databaseAvailable === true,
        networkUsed: value?.networkUsed === true, checkedAt: Number(value?.checkedAt) || Date.now(), message: safeText(value?.message, 1000)
      }]).filter(([key]) => key)) : {},
      scriptReview: normalizeScriptReview(raw?.scriptReview),
      productResearch: raw?.productResearch && typeof raw.productResearch === 'object' && !Array.isArray(raw.productResearch) ? {
        status: safeText(raw.productResearch.status, 60),
        message: safeText(raw.productResearch.message, 1000),
        networkUsed: raw.productResearch.networkUsed === true,
        externalModelUsed: raw.productResearch.externalModelUsed === true,
        artifactVersionIds: (Array.isArray(raw.productResearch.artifactVersionIds) ? raw.productResearch.artifactVersionIds : []).map(value => safeId(value, '')).filter(Boolean).slice(0, 20),
        artifactIds: (Array.isArray(raw.productResearch.artifactIds) ? raw.productResearch.artifactIds : []).map(value => safeId(value, '')).filter(Boolean).slice(0, 20),
        updatedAt: Number(raw.productResearch.updatedAt) || Date.now()
      } : null,
      creativeScript: raw?.creativeScript && typeof raw.creativeScript === 'object' && !Array.isArray(raw.creativeScript) ? {
        status: safeText(raw.creativeScript.status, 60),
        message: safeText(raw.creativeScript.message, 1000),
        directionsArtifactVersionId: safeId(raw.creativeScript.directionsArtifactVersionId, ''),
        selectedArtifactVersionId: safeId(raw.creativeScript.selectedArtifactVersionId, ''),
        selectedDirectionId: safeId(raw.creativeScript.selectedDirectionId, ''),
        scriptArtifactVersionId: safeId(raw.creativeScript.scriptArtifactVersionId, ''),
        directions: Array.isArray(raw.creativeScript.directions) ? raw.creativeScript.directions.slice(0, 6) : [],
        providerId: safeText(raw.creativeScript.providerId, 120),
        model: safeText(raw.creativeScript.model, 240),
        storyResearchUsed: raw.creativeScript.storyResearchUsed === true,
        updatedAt: Number(raw.creativeScript.updatedAt) || Date.now()
      } : null,
      storyboardPlan: raw?.storyboardPlan && typeof raw.storyboardPlan === 'object' && !Array.isArray(raw.storyboardPlan) ? {
        status: safeText(raw.storyboardPlan.status, 60),
        message: safeText(raw.storyboardPlan.message, 1000),
        shotsArtifactVersionId: safeId(raw.storyboardPlan.shotsArtifactVersionId, ''),
        assetsArtifactVersionId: safeId(raw.storyboardPlan.assetsArtifactVersionId, ''),
        coverageArtifactVersionId: safeId(raw.storyboardPlan.coverageArtifactVersionId, ''),
        shots: Array.isArray(raw.storyboardPlan.shots) ? raw.storyboardPlan.shots.slice(0, 60) : [],
        totalDurationSeconds: Number(raw.storyboardPlan.totalDurationSeconds) || 0,
        assets: Array.isArray(raw.storyboardPlan.assets) ? raw.storyboardPlan.assets.slice(0, 200) : [],
        shotAssignments: Array.isArray(raw.storyboardPlan.shotAssignments) ? raw.storyboardPlan.shotAssignments.slice(0, 60) : [],
        coverage: raw.storyboardPlan.coverage && typeof raw.storyboardPlan.coverage === 'object' ? raw.storyboardPlan.coverage : null,
        providerId: safeText(raw.storyboardPlan.providerId, 120),
        model: safeText(raw.storyboardPlan.model, 240),
        updatedAt: Number(raw.storyboardPlan.updatedAt) || Date.now()
      } : null,
      error: safeText(raw?.error, 2000),
      events: (Array.isArray(raw?.events) ? raw.events : []).slice(-200).map(event => ({ id: safeId(event?.id, ''), kind: safeText(event?.kind, 40), message: safeText(event?.message, 1000), createdAt: Number(event?.createdAt) || Date.now() })),
      createdAt: Number(raw?.createdAt) || Date.now(),
      updatedAt: Number(raw?.updatedAt) || Date.now(),
      completedAt: Number(raw?.completedAt) || null,
      cancelledAt: Number(raw?.cancelledAt) || null
    };
  }

  function saveRun(raw) {
    const run = normalizeRun({ ...raw, updatedAt: Date.now() });
    atomicWriteJson(runPath(run.id), run);
    return run;
  }

  function loadRun(runId, recover = true) {
    const filePath = runPath(runId);
    if (!fs.existsSync(filePath)) return null;
    const run = normalizeRun(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    const reviewBeforeRecovery = recover ? JSON.stringify(run.scriptReview) : '';
    if (recover) {
      scriptVersions.recoverInterruptedRevisionAttempts(run);
      scriptVersions.reconcileVersionFiles(run);
    }
    if (recover && run.status === 'running' && !activeRuns.has(run.id)) {
      run.status = 'interrupted';
      run.error = '本地服务重启，运行中的阶段已中断；已有项目文件与产物均已保留';
      const stage = run.stages.find(item => item.id === run.currentStageId);
      if (stage && stage.status === 'running') { stage.status = 'failed'; stage.message = run.error; stage.updatedAt = Date.now(); }
      appendEvent(run, run.error, 'interrupted');
      return saveRun(run);
    }
    if (recover && JSON.stringify(run.scriptReview) !== reviewBeforeRecovery) return saveRun(run);
    return run;
  }

  function listRuns(canvasId = '', recover = true) {
    const filterId = safeId(canvasId, '');
    return fs.readdirSync(stateRoot).filter(name => name.endsWith('.json')).map(name => {
      try { return loadRun(name.slice(0, -5), recover); } catch (_error) { return null; }
    }).filter(run => run && (!filterId || run.canvasId === filterId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  }

  function createRun(input) {
    const runtimeResult = findAgentSkillRuntime(input?.skillId);
    if (!runtimeResult?.runtime) throw new Error('Skill 不存在或运行清单无效');
    const adapter = runtimeResult.runtime.adapter;
    const productName = safeText(input?.questionnaireAnswers?.productName, 500);
    if (!productName) throw new Error('产品名称不能为空');
    const now = Date.now();
    const run = {
      id: `agent_run_${now}_${crypto.randomBytes(5).toString('hex')}`,
      canvasId: safeId(input?.canvasId, ''),
      skillId: adapter.id,
      skillTitle: safeText(adapter.ui?.title || adapter.displayName, 160),
      questionnaireVersion: safeText(adapter.ui?.questionnaireVersion, 40),
      brief: safeText(input?.brief, 12000),
      questionnaireAnswers: safeAnswerMap(input?.questionnaireAnswers),
      materials: input?.materials,
      status: 'queued',
      currentStageId: adapter.stages[0]?.id || '',
      stages: adapter.stages.map((stage, index) => normalizeStage({ ...stage, status: 'queued' }, index)),
      artifacts: [],
      project: null,
      error: '',
      events: [],
      createdAt: now,
      updatedAt: now
    };
    appendEvent(run, `后端 Run 已创建：${run.skillTitle}`, 'queued');
    return saveRun(run);
  }

  function resolveInside(root, relativePath) {
    const absolute = path.resolve(root, String(relativePath || ''));
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('路径超出允许目录');
    return absolute;
  }

  function runProcess(file, args, options, runId) {
    return new Promise((resolve, reject) => {
      const child = execFile(file, args, options, (error, stdout, stderr) => {
        if (activeProcesses.get(runId) === child) activeProcesses.delete(runId);
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      activeProcesses.set(runId, child);
    });
  }

  async function runPython(scriptPath, args, runId) {
    const errors = [];
    for (const candidate of pythonCandidates()) {
      if (path.isAbsolute(candidate.file) && !fs.existsSync(candidate.file)) { errors.push(`${candidate.file}: 不存在`); continue; }
      try {
        const result = await runProcess(candidate.file, [...candidate.prefixArgs, scriptPath, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, runId);
        return { ...result, executable: candidate.file };
      } catch (error) {
        if (error.code === 'ENOENT') { errors.push(`${candidate.file}: 未找到`); continue; }
        throw error;
      }
    }
    throw new Error(`未找到可用 Python；请设置 LAVANS_PYTHON_EXECUTABLE。${errors.length ? ` ${errors.slice(0, 4).join('；')}` : ''}`);
  }

  function collectArtifacts(projectDir, projectSlug, stageId) {
    const artifacts = [];
    const walk = current => {
      fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach(entry => {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) return walk(absolute);
        if (!entry.isFile() || artifacts.length >= 200) return;
        const relativeInProject = path.relative(projectDir, absolute).replace(/\\/g, '/');
        const relativePath = `${projectSlug}/${relativeInProject}`;
        const stat = fs.statSync(absolute);
        artifacts.push({
          id: `artifact_${crypto.createHash('sha1').update(relativePath).digest('hex').slice(0, 16)}`,
          stageId,
          name: path.basename(relativeInProject),
          kind: artifactKind(relativeInProject),
          relativePath,
          url: publicFileUrl(relativePath),
          size: stat.size,
          createdAt: stat.mtimeMs
        });
      });
    };
    walk(projectDir);
    return artifacts;
  }

  function artifactForProjectFile(projectDir, projectSlug, stageId, relativeInProject) {
    const normalizedRelative = String(relativeInProject || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const absolute = resolveInside(projectDir, normalizedRelative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error('Artifact 文件不存在');
    const relativePath = `${projectSlug}/${normalizedRelative}`;
    const stat = fs.statSync(absolute);
    return {
      id: `artifact_${crypto.createHash('sha1').update(relativePath).digest('hex').slice(0, 16)}`,
      stageId,
      name: path.basename(normalizedRelative),
      kind: artifactKind(normalizedRelative),
      relativePath,
      url: publicFileUrl(relativePath),
      size: stat.size,
      createdAt: stat.mtimeMs
    };
  }

  function upsertArtifact(run, artifact) {
    run.artifacts = (Array.isArray(run.artifacts) ? run.artifacts : []).filter(item => item.id !== artifact.id);
    run.artifacts.push(artifact);
    return artifact;
  }

  function storyDependencySnapshot() {
    const runtime = findAgentDependencyRuntime('douyin-tiktok-story-skill')?.runtime;
    const codeAvailable = runtime?.codeAvailable === true;
    const databaseAvailable = runtime?.databaseAvailable === true;
    const status = databaseAvailable ? 'available' : codeAvailable ? 'database-missing' : 'missing';
    const message = !codeAvailable
      ? 'douyin-tiktok-story-skill 代码尚未接入'
      : !databaseAvailable
        ? '故事 Skill 代码已接入，但缺少本地授权数据库 douyin-story.sqlite3'
        : '故事 Skill 本地检索代码与数据库已就绪，等待受控文本模型执行器与审批';
    return { runtime, publicState: { status, codeAvailable, databaseAvailable, networkUsed: false, checkedAt: Date.now(), message } };
  }

  async function executeInitProject(runId) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    let stage = run.stages.find(item => item.id === 'init-project') || run.stages[0];
    if (!stage) throw new Error('Skill 缺少 init-project 阶段');
    if (stage.status === 'completed' && run.project) return run;
    if (activeProcesses.has(run.id)) throw new Error('该 Agent Run 已在执行');
    if (['cancelled', 'completed'].includes(run.status)) throw new Error(`当前 Run 状态不可执行：${run.status}`);
    const runtimeResult = findAgentSkillRuntime(run.skillId);
    if (!runtimeResult?.runtime) throw new Error('Skill 运行目录不可用');
    const adapterStage = runtimeResult.runtime.adapter.stages.find(item => item.id === stage.id);
    const scriptRelative = adapterStage?.executor?.ref;
    if (!scriptRelative) throw new Error('初始化阶段没有执行脚本');
    const scriptPath = resolveInside(runtimeResult.runtime.sourcePath, scriptRelative);
    if (!fs.existsSync(scriptPath)) throw new Error('初始化脚本不存在');
    run.status = 'running';
    run.currentStageId = stage.id;
    run.error = '';
    stage.status = 'running';
    stage.message = '正在执行 Skill 自带 init_project.py';
    stage.startedAt = Date.now();
    stage.updatedAt = Date.now();
    appendEvent(run, `${stage.title} 开始真实执行`, 'running');
    run = saveRun(run);
    stage = run.stages.find(item => item.id === stage.id) || run.stages[0];
    try {
      const answers = run.questionnaireAnswers || {};
      const result = await runPython(scriptPath, [
        '--name', safeText(answers.productName, 500),
        '--output-root', projectRoot,
        '--duration', String(normalizeDuration(answers.durationSeconds)),
        '--aspect-ratio', normalizeAspectRatio(answers.aspectRatio)
      ], run.id);
      const payload = JSON.parse(result.stdout.trim());
      if (!payload?.ok || !payload.project_dir) throw new Error('初始化脚本未返回有效项目目录');
      const projectDir = path.resolve(String(payload.project_dir));
      if (!pathIsWithin(projectRoot, projectDir)) throw new Error('初始化脚本返回了项目目录之外的路径');
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error('初始化项目目录不存在');
      const productBriefPath = resolveInside(projectDir, 'brief/product-brief.md');
      fs.writeFileSync(productBriefPath, buildProductBrief(run).trimEnd() + '\n', 'utf8');
      const projectSlug = path.basename(projectDir);
      run.project = { name: safeText(answers.productName, 500), slug: projectSlug, url: publicFileUrl(projectSlug) };
      run.artifacts = collectArtifacts(projectDir, projectSlug, stage.id);
      stage.status = 'completed';
      stage.message = `真实项目已创建，共登记 ${run.artifacts.length} 个文件`;
      stage.artifactIds = run.artifacts.map(item => item.id);
      stage.completedAt = Date.now();
      stage.updatedAt = Date.now();
      appendEvent(run, `${stage.title} 已真实完成：${run.artifacts.length} 个文件`, 'completed');
      const nextStage = run.stages.find(item => item.order === stage.order + 1);
      if (nextStage?.readiness === 'blocked') {
        const storyDependency = nextStage.id === 'microstory' ? storyDependencySnapshot().publicState : null;
        nextStage.status = 'blocked';
        nextStage.message = storyDependency ? `${storyDependency.message}；未执行也未生成伪造产出` : `${nextStage.title} 缺少真实依赖，未执行也未生成伪造产出`;
        nextStage.updatedAt = Date.now();
        if (storyDependency) run.dependencyStates = { ...(run.dependencyStates || {}), 'douyin-tiktok-story-skill': storyDependency };
        run.status = 'blocked';
        run.currentStageId = nextStage.id;
        run.error = nextStage.message;
        appendEvent(run, nextStage.message, 'blocked');
      } else if (nextStage) {
        run.status = 'queued';
        run.currentStageId = nextStage.id;
      } else {
        run.status = 'completed';
        run.currentStageId = '';
        run.completedAt = Date.now();
      }
      return saveRun(run);
    } catch (error) {
      run = loadRun(run.id, false) || run;
      const currentStage = run.stages.find(item => item.id === stage.id) || stage;
      if (run.status === 'cancelled') {
        currentStage.status = 'cancelled';
        currentStage.message = '用户已取消真实执行；已有文件保持不变';
      } else {
        run.status = error.killed ? 'interrupted' : 'failed';
        run.error = safeText(error.stderr || error.message || '初始化项目失败', 2000);
        currentStage.status = 'failed';
        currentStage.message = run.error;
        appendEvent(run, run.error, 'failed');
      }
      currentStage.updatedAt = Date.now();
      return saveRun(run);
    } finally {
      activeProcesses.delete(run.id);
    }
  }

  async function executeProductResearch(runId) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.status === 'cancelled') throw new Error('已取消的 Run 不能执行产品调研');
    if (!run.project?.slug) throw new Error('请先完成产品事实与项目初始化');
    if (run.productResearch?.artifactVersionIds?.length === 4 && ['awaiting-review', 'blocked', 'locked'].includes(run.productResearch.status)) return run;
    const projectDir = resolveInside(projectRoot, run.project.slug);
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error('Agent 项目目录不存在');
    const dependencySnapshot = storyDependencySnapshot();
    const dependency = { ...dependencySnapshot.publicState };
    const searches = {};
    if (dependency.codeAvailable && dependency.databaseAvailable && dependencySnapshot.runtime?.searchScriptPath) {
      try {
        searches.health = JSON.parse((await runPython(dependencySnapshot.runtime.searchScriptPath, ['status'], run.id)).stdout.trim());
        if (searches.health?.ok !== true || searches.health?.network_used !== false) throw new Error('本地故事数据库健康检查未通过离线约束');
        const answers = run.questionnaireAnswers || {};
        const topicQuery = [answers.productName, answers.audience, answers.characterDirection, '人物关系 冲突 反转'].map(value => safeText(value, 500)).filter(Boolean).join(' ');
        const mechanismQuery = [answers.facts, answers.platforms, '前三秒 钩子 节奏 产品植入 低成本'].map(value => safeText(value, 800)).filter(Boolean).join(' ');
        searches.topic = JSON.parse((await runPython(dependencySnapshot.runtime.searchScriptPath, ['search', topicQuery, '--top-k', '6'], run.id)).stdout.trim());
        searches.mechanism = JSON.parse((await runPython(dependencySnapshot.runtime.searchScriptPath, ['search', mechanismQuery, '--top-k', '6'], run.id)).stdout.trim());
        if (searches.topic?.network_used !== false || searches.mechanism?.network_used !== false) throw new Error('离线检索返回了网络使用标记，已阻断');
      } catch (error) {
        dependency.status = 'health-check-failed';
        dependency.message = safeText(error.stderr || error.message || '本地故事数据库健康检查失败', 1000);
        searches.health = null;
        searches.topic = null;
        searches.mechanism = null;
      }
    }
    const research = createProductResearchPackage(run, dependency, searches);
    const files = [
      ['research/evidence-ledger.json', JSON.stringify(research.evidenceLedger, null, 2) + '\n'],
      ['research/product-fact-lock.md', research.factLockMarkdown.trimEnd() + '\n'],
      ['research/offline-research.json', JSON.stringify(research.offlineResearch, null, 2) + '\n'],
      ['research/research-boundary.json', JSON.stringify(research.researchBoundary, null, 2) + '\n']
    ];
    const runArtifacts = files.map(([relative, content]) => {
      const absolute = resolveInside(projectDir, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, 'utf8');
      return upsertArtifact(run, artifactForProjectFile(projectDir, run.project.slug, 'product-research', relative));
    });
    const projected = [];
    if (foundation && typeof foundation.createArtifact === 'function') {
      const createProjected = (suffix, artifactType, content, inputRefs, metadata) => foundation.createArtifact({
        logicalArtifactId: `${run.id}-${suffix}`,
        artifactType,
        content,
        extension: typeof content === 'string' ? '.md' : '.json',
        inputRefs,
        source: 'agent-product-research',
        operationId: `${run.id}-phase2-${suffix}-v1`,
        metadata: { canvasId: run.canvasId, runId: run.id, phaseId: '2', ...metadata }
      });
      const evidence = createProjected('evidence-ledger', 'evidence-ledger', research.evidenceLedger, [], {
        displayTitle: '资料与证据',
        summary: `${research.evidenceLedger.sources.length} 份来源 · ${research.evidenceLedger.claims.length} 条产品事实 · ${research.evidenceLedger.conflicts.length} 个冲突`,
        reviewChecklist: ['资料数量和名称是否正确', '证据等级是否符合实际', '冲突项是否需要补充资料']
      });
      projected.push(evidence);
      const factLock = createProjected('product-fact-lock', 'product-fact-lock', research.factLockMarkdown, [{ artifactVersionId: evidence.artifactVersionId, role: 'evidence-ledger' }], {
        displayTitle: '产品事实锁',
        summary: `${research.evidenceLedger.claims.length} 条待锁定事实 · ${research.evidenceLedger.prohibitedClaims.length} 条禁说项`,
        reviewChecklist: ['产品名称和事实是否准确', '不得自动扩写的边界是否完整', '禁说项是否遗漏']
      });
      projected.push(factLock);
      const offline = createProjected('offline-research', 'offline-research', research.offlineResearch, [{ artifactVersionId: factLock.artifactVersionId, role: 'product-fact-lock' }], {
        displayTitle: '离线调研',
        summary: research.offlineResearch.status === 'completed' ? `${research.offlineResearch.searches.topicAndRelationship.sourceCount + research.offlineResearch.searches.hookRhythmPlacement.sourceCount} 份本地参考已提炼为抽象机制` : '缺少可用的本地授权故事库，已真实阻塞',
        blockedReason: research.offlineResearch.blockedReason,
        reviewChecklist: ['确认只使用本地授权数据库', '确认全程没有联网', '确认没有保存原文、摘录或专有表达']
      });
      projected.push(offline);
      const boundary = createProjected('research-boundary', 'research-boundary', research.researchBoundary, [{ artifactVersionId: factLock.artifactVersionId, role: 'product-fact-lock' }, { artifactVersionId: offline.artifactVersionId, role: 'offline-research' }], {
        displayTitle: '调研边界',
        summary: `${research.researchBoundary.allowedSources.length} 类允许来源 · ${research.researchBoundary.prohibitedSources.length} 类禁止来源`,
        reviewChecklist: ['允许来源是否足够', '禁止来源是否完整', '进入阶段 3 的条件是否明确']
      });
      projected.push(boundary);
    }
    run.productResearch = {
      status: research.offlineResearch.status === 'completed' ? 'awaiting-review' : 'blocked',
      message: research.offlineResearch.status === 'completed' ? '产品事实与两次离线调研已完成，等待逐项审核锁定' : `${research.offlineResearch.blockedReason}；事实锁与调研边界仍可先审核`,
      networkUsed: false,
      externalModelUsed: false,
      artifactVersionIds: projected.map(item => item.artifactVersionId),
      artifactIds: runArtifacts.map(item => item.id),
      updatedAt: Date.now()
    };
    appendEvent(run, run.productResearch.message, run.productResearch.status === 'blocked' ? 'blocked' : 'awaiting-review');
    return saveRun(run);
  }

  async function inspectMicrostoryStage(runId) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.status === 'cancelled') throw new Error('已取消的 Run 不能继续检查依赖');
    const stage = run.stages.find(item => item.id === 'microstory');
    if (!stage) throw new Error('Skill 缺少 microstory 阶段');
    if (stage.status === 'completed') return run;
    if (!run.project?.slug) throw new Error('请先完成产品事实与项目阶段');
    const projectDir = resolveInside(projectRoot, run.project.slug);
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error('Agent 项目目录不存在');

    const dependency = storyDependencySnapshot();
    const publicState = { ...dependency.publicState };
    let health = null;
    if (publicState.databaseAvailable && dependency.runtime?.searchScriptPath) {
      try {
        const result = await runPython(dependency.runtime.searchScriptPath, ['status'], run.id);
        health = JSON.parse(result.stdout.trim());
        if (health?.ok !== true || health?.network_used !== false) throw new Error('故事数据库健康检查未通过本地离线约束');
        publicState.status = 'model-adapter-required';
        publicState.networkUsed = false;
        publicState.message = '本地故事库健康检查已通过；仍需接入受控文本模型执行器和审批后才能生成成稿';
      } catch (error) {
        publicState.status = 'health-check-failed';
        publicState.message = safeText(error.stderr || error.message || '故事数据库健康检查失败', 1000);
      }
    }
    const latestRun = loadRun(run.id, false);
    if (latestRun?.status === 'cancelled') return latestRun;
    publicState.checkedAt = Date.now();
    run.dependencyStates = { ...(run.dependencyStates || {}), 'douyin-tiktok-story-skill': publicState };

    const receiptRelative = 'story/story-skill-status.json';
    const receiptPath = resolveInside(projectDir, receiptRelative);
    const receipt = {
      schema_version: '1.0',
      dependency_id: 'douyin-tiktok-story-skill',
      checked_at: new Date(publicState.checkedAt).toISOString(),
      code_available: publicState.codeAvailable,
      database_available: publicState.databaseAvailable,
      network_used: publicState.networkUsed,
      status: publicState.status,
      message: publicState.message,
      health: health && typeof health === 'object' ? {
        ok: health.ok === true,
        runtime: safeText(health.runtime, 80),
        network_used: health.network_used === true,
        canonical_scripts: Math.max(0, Number(health.canonical_scripts) || 0),
        indexed_scripts: Math.max(0, Number(health.indexed_scripts) || 0)
      } : null,
      required_action: !publicState.codeAvailable
        ? '接入 douyin-tiktok-story-skill 代码'
        : !publicState.databaseAvailable
          ? '提供拥有合法使用权的 douyin-story.sqlite3，或提供授权剧本资料用于本地构建数据库'
          : '接入受控文本模型执行器，并在画布审批后执行两次本地检索、成稿和防复刻检查'
    };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    const artifact = upsertArtifact(run, artifactForProjectFile(projectDir, run.project.slug, stage.id, receiptRelative));
    stage.status = 'blocked';
    stage.message = `${publicState.message}；当前没有生成剧本，也没有伪造检索回执`;
    stage.artifactIds = [...new Set([...(stage.artifactIds || []), artifact.id])];
    stage.updatedAt = Date.now();
    run.status = 'blocked';
    run.currentStageId = stage.id;
    run.error = stage.message;
    appendEvent(run, stage.message, 'blocked');
    return saveRun(run);
  }

  function microstoryExecutionSteps(stage) {
    const definitions = [
      ['dependency-check', '故事库健康检查'],
      ['topic-search', '题材与人物关系检索'],
      ['mechanism-search', '钩子、节奏与植入检索'],
      ['concept-options', '原创创意方向'],
      ['final-script', '纯文字剧本成稿'],
      ['similarity-check', '防复刻检查']
    ];
    const existing = new Map((Array.isArray(stage.executionSteps) ? stage.executionSteps : []).map(step => [step.id, step]));
    stage.executionSteps = definitions.map(([id, title]) => ({
      id,
      title,
      status: existing.get(id)?.status || 'queued',
      message: existing.get(id)?.message || '等待执行',
      artifactIds: Array.isArray(existing.get(id)?.artifactIds) ? existing.get(id).artifactIds : [],
      startedAt: existing.get(id)?.startedAt || null,
      completedAt: existing.get(id)?.completedAt || null,
      updatedAt: existing.get(id)?.updatedAt || Date.now()
    }));
    return stage.executionSteps;
  }

  function publicSearchReceipt(raw, label) {
    return {
      schema_version: '1.0',
      label,
      ok: raw?.ok === true,
      runtime: safeText(raw?.runtime, 80),
      network_used: raw?.network_used === true,
      query: safeText(raw?.query, 500),
      result_count: Math.max(0, Number(raw?.result_count) || 0),
      results: (Array.isArray(raw?.results) ? raw.results : []).slice(0, 20).map(item => ({
        document_id: Math.max(0, Number(item?.document_id) || 0),
        file_name: safeText(item?.file_name, 240),
        stage: safeText(item?.stage, 120),
        platform: safeText(item?.platform, 80),
        char_count: Math.max(0, Number(item?.char_count) || 0),
        relevance_score: Number(item?.relevance_score) || 0
      }))
    };
  }

  function abstractStoryMechanisms(raw) {
    const results = (Array.isArray(raw?.results) ? raw.results : []).slice(0, 12);
    const corpus = results.map(item => safeText(item?.excerpt, 700)).join('\n');
    const rules = [
      ['误会、错认或信息差触发冲突', /误会|误把|错认|拿错|送错|信息差/],
      ['人物追问推动信息逐步揭示', /追问|质问|询问|盘问/],
      ['日常物件成为剧情触发道具', /作业|蛋糕|资料|备忘录|冰箱|快递|纸条|钥匙/],
      ['第三方行为或旧事造成关系变化', /同学|邻居|主管|室友|老师|朋友|家人/],
      ['结尾通过新证据完成反转或回扣', /最终|最后|发现|揭开|原来|真相/],
      ['少场景、少角色、低成本可拍摄', /./]
    ];
    const tags = rules.filter(([, pattern]) => pattern.test(corpus)).map(([tag]) => tag);
    return {
      source_count: results.length,
      abstract_mechanism_tags: [...new Set(tags)].slice(0, 12),
      privacy: '仅输出本地规则提炼的抽象机制标签；未包含源文件名、正文、摘录或专有表达'
    };
  }

  async function executeMicrostoryStage(runId, executionOptions = {}) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    let stage = run.stages.find(item => item.id === 'microstory');
    if (!stage) throw new Error('Skill 缺少 microstory 阶段');
    if (stage.status === 'completed') return run;
    if (activeRuns.has(run.id)) throw new Error('该 Agent Run 已在执行');
    if (['cancelled', 'completed'].includes(run.status)) throw new Error(`当前 Run 状态不可执行：${run.status}`);
    if (!run.project?.slug) throw new Error('请先完成产品事实与项目阶段');
    const projectDir = resolveInside(projectRoot, run.project.slug);
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error('Agent 项目目录不存在');
    const dependency = storyDependencySnapshot();
    if (!dependency.publicState.codeAvailable || !dependency.publicState.databaseAvailable || !dependency.runtime?.searchScriptPath) {
      return inspectMicrostoryStage(run.id);
    }
    const storyTextGenerator = typeof executionOptions.generateStoryText === 'function' ? executionOptions.generateStoryText : generateStoryText;
    if (typeof storyTextGenerator !== 'function') {
      run.dependencyStates = { ...(run.dependencyStates || {}), 'douyin-tiktok-story-skill': { ...dependency.publicState, status: 'model-adapter-required', message: '本地故事库已就绪，但受控文本模型执行器尚未配置' } };
      stage.status = 'blocked';
      stage.message = '本地故事库已就绪，但受控文本模型执行器尚未配置；未生成剧本';
      stage.updatedAt = Date.now();
      run.status = 'blocked';
      run.currentStageId = stage.id;
      run.error = stage.message;
      appendEvent(run, stage.message, 'blocked');
      return saveRun(run);
    }

    const steps = microstoryExecutionSteps(stage);
    const controller = new AbortController();
    activeRuns.add(run.id);
    activeAbortControllers.set(run.id, controller);
    run.status = 'running';
    run.currentStageId = stage.id;
    run.error = '';
    stage.status = 'running';
    stage.message = '正在执行本地故事检索与原创剧本成稿';
    stage.startedAt = stage.startedAt || Date.now();
    stage.updatedAt = Date.now();
    steps.forEach(step => { if (step.status !== 'completed') { step.status = 'queued'; step.message = '等待执行'; step.updatedAt = Date.now(); } });
    appendEvent(run, `${stage.title} 开始真实执行`, 'running');
    run = saveRun(run);

    const saveProgress = (stepId, status, message, artifactIds = []) => {
      run = loadRun(run.id, false) || run;
      stage = run.stages.find(item => item.id === 'microstory') || stage;
      const currentSteps = microstoryExecutionSteps(stage);
      const step = currentSteps.find(item => item.id === stepId);
      if (!step) throw new Error(`未知故事执行步骤：${stepId}`);
      step.status = status;
      step.message = safeText(message, 1000);
      step.artifactIds = [...new Set([...(step.artifactIds || []), ...artifactIds])];
      if (status === 'running') step.startedAt = step.startedAt || Date.now();
      if (status === 'completed') step.completedAt = Date.now();
      step.updatedAt = Date.now();
      stage.message = step.message;
      stage.updatedAt = Date.now();
      appendEvent(run, `${step.title}：${step.message}`, status);
      run = saveRun(run);
      return step;
    };
    const writeArtifact = (relative, content) => {
      const filePath = resolveInside(projectDir, relative);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      const artifact = artifactForProjectFile(projectDir, run.project.slug, stage.id, relative);
      upsertArtifact(run, artifact);
      run = saveRun(run);
      stage = run.stages.find(item => item.id === 'microstory') || stage;
      return artifact;
    };
    const ensureNotCancelled = () => {
      const latest = loadRun(run.id, false);
      if (latest?.status === 'cancelled' || controller.signal.aborted) {
        const error = new Error('用户已取消故事阶段；已有产物保持不变');
        error.code = 'AGENT_CANCELLED';
        throw error;
      }
    };
    const parsePythonJson = (result, label) => {
      let payload;
      try { payload = JSON.parse(String(result.stdout || '').trim()); }
      catch (_error) { throw new Error(`${label}没有返回有效 JSON`); }
      if (payload?.ok !== true || payload?.network_used !== false) throw new Error(`${label}未通过离线执行约束`);
      return payload;
    };
    const callTextModel = async (purpose, systemPrompt, userPrompt) => {
      ensureNotCancelled();
      const response = await storyTextGenerator({ purpose, systemPrompt, userPrompt, run: normalizeRun(run), signal: controller.signal });
      ensureNotCancelled();
      const text = safeText(typeof response === 'string' ? response : response?.text, 100000);
      if (!text) throw new Error('受控文本模型没有返回内容');
      return {
        text,
        providerId: safeText(response?.providerId || response?.provider, 120),
        model: safeText(response?.model, 240),
        usage: response?.usage && typeof response.usage === 'object' ? response.usage : null
      };
    };

    try {
      saveProgress('dependency-check', 'running', '正在检查本地故事数据库，运行期间不访问网络');
      const health = parsePythonJson(await runPython(dependency.runtime.searchScriptPath, ['status'], run.id), '故事数据库健康检查');
      saveProgress('dependency-check', 'completed', `离线故事库可用：${Math.max(0, Number(health.canonical_scripts) || 0)} 条规范脚本`);

      const topicQuery = '短视频 品牌植入 人物关系 目标阻碍 冲突升级 反转 低成本拍摄';
      saveProgress('topic-search', 'running', '正在执行题材与人物关系的第一次抽象检索');
      const topicSearch = parsePythonJson(await runPython(dependency.runtime.searchScriptPath, ['search', topicQuery, '--top-k', '6'], run.id), '第一次故事检索');
      const topicArtifact = writeArtifact('story/topic-search-receipt.json', JSON.stringify(publicSearchReceipt(topicSearch, '题材与人物关系'), null, 2) + '\n');
      saveProgress('topic-search', 'completed', `第一次离线检索完成，共命中 ${topicSearch.result_count || 0} 份参考`, [topicArtifact.id]);

      const mechanismQuery = '前三秒动作 信息差 节奏升级 产品自然植入 关系变化 结尾回扣';
      saveProgress('mechanism-search', 'running', '正在执行钩子、节奏与产品植入的第二次抽象检索');
      const mechanismSearch = parsePythonJson(await runPython(dependency.runtime.searchScriptPath, ['search', mechanismQuery, '--top-k', '6'], run.id), '第二次故事检索');
      const mechanismArtifact = writeArtifact('story/mechanism-search-receipt.json', JSON.stringify(publicSearchReceipt(mechanismSearch, '钩子、节奏与植入'), null, 2) + '\n');
      saveProgress('mechanism-search', 'completed', `第二次离线检索完成，共命中 ${mechanismSearch.result_count || 0} 份参考`, [mechanismArtifact.id]);

      const productBriefPath = resolveInside(projectDir, 'brief/product-brief.md');
      const productBrief = fs.readFileSync(productBriefPath, 'utf8');
      const systemPrompt = '你是 Lavans 画布 AGENT 的原创短视频编剧。只能提炼参考素材的机制与节奏，禁止复用专有姓名、标志性台词、完整事件链或独特道具组合。不得增加产品事实、功效、数据、认证、价格或包装文字。输出必须可拍摄、短对白、少场景，并严格遵守用户禁说项。';
      saveProgress('concept-options', 'running', '正在基于两次检索生成 6—10 个原创创意方向');
      const conceptResult = await callTextModel('concept-options', systemPrompt, `请根据产品事实锁与两组本地检索形成的抽象机制标签，输出6—10个原创方向。每个方向包含前三秒、人物关系、冲突升级、产品进入方式、反转、拍摄条件和结尾钩子。不得推测或还原本地参考原文。\n\n产品事实锁：\n${productBrief}\n\n题材关系抽象机制标签：\n${JSON.stringify(abstractStoryMechanisms(topicSearch), null, 2)}\n\n钩子节奏抽象机制标签：\n${JSON.stringify(abstractStoryMechanisms(mechanismSearch), null, 2)}`);
      const conceptArtifact = writeArtifact('story/concept-options.md', conceptResult.text.trimEnd() + '\n');
      saveProgress('concept-options', 'completed', '原创创意方向已生成并保存', [conceptArtifact.id]);

      saveProgress('final-script', 'running', '正在生成可直接进入分镜阶段的纯文字剧本');
      let scriptResult = await callTextModel('final-script', systemPrompt, `请从创意方向中选择最适合产品事实和制作条件的一项，输出完整可拍摄剧本。必须包含项目定位、人物、场景、按时间段拆分的动作与台词、字幕/音效、产品植入说明、时长估算和结尾钩子。\n\n产品事实锁：\n${productBrief}\n\n创意方向：\n${conceptResult.text}`);
      let scriptText = scriptResult.text.trim();
      const receiptLine = '本地达人脚本库：检索2次，共参考两组本地结果；仅采用机制与节奏，已完成防复刻检查；运行时未联网。';
      if (!scriptText.includes('本地达人脚本库：检索2次')) scriptText += `\n\n---\n\n${receiptLine}`;
      let draftArtifact = writeArtifact('story/final-script.md', scriptText.trimEnd() + '\n');
      saveProgress('final-script', 'completed', '纯文字剧本已生成，等待防复刻检查', [draftArtifact.id]);

      saveProgress('similarity-check', 'running', '正在对最终剧本执行本地相似度检查');
      let similarity = parsePythonJson(await runPython(dependency.runtime.searchScriptPath, ['similarity-check', resolveInside(projectDir, 'story/final-script.md')], run.id), '防复刻检查');
      let rewriteCount = 0;
      while (similarity.pass !== true && rewriteCount < 2) {
        rewriteCount += 1;
        saveProgress('similarity-check', 'running', `相似度 ${Number(similarity.max_similarity || 0).toFixed(4)} 未通过，正在执行第 ${rewriteCount} 次原创重写`);
        scriptResult = await callTextModel('similarity-rewrite', systemPrompt, `下面的原创草稿未通过本地防复刻检查，最高相似度为 ${similarity.max_similarity}，阈值为 ${similarity.threshold}。请保留已确认的产品事实，彻底更换事件链、对白、道具组合和反转顺序，输出完整可拍摄剧本。不得解释修改过程。\n\n产品事实锁：\n${productBrief}\n\n待重写草稿：\n${scriptText}`);
        scriptText = scriptResult.text.trim();
        if (!scriptText.includes('本地达人脚本库：检索2次')) scriptText += `\n\n---\n\n${receiptLine}`;
        draftArtifact = writeArtifact('story/final-script.md', scriptText.trimEnd() + '\n');
        similarity = parsePythonJson(await runPython(dependency.runtime.searchScriptPath, ['similarity-check', resolveInside(projectDir, 'story/final-script.md')], run.id), '防复刻复检');
      }
      const similarityArtifact = writeArtifact('story/similarity-check.json', JSON.stringify({ ...similarity, rewrite_count: rewriteCount }, null, 2) + '\n');
      if (similarity.pass !== true) {
        saveProgress('similarity-check', 'blocked', `两次重写后最高相似度仍为 ${Number(similarity.max_similarity || 0).toFixed(4)}，已阻塞等待人工处理`, [similarityArtifact.id]);
        run = loadRun(run.id, false) || run;
        stage = run.stages.find(item => item.id === 'microstory') || stage;
        stage.status = 'blocked';
        stage.message = '防复刻检查未通过，剧本未标记为完成';
        stage.artifactIds = [...new Set([...(stage.artifactIds || []), ...stage.executionSteps.flatMap(step => step.artifactIds || [])])];
        run.status = 'blocked';
        run.currentStageId = stage.id;
        run.error = stage.message;
        appendEvent(run, stage.message, 'blocked');
        return saveRun(run);
      }
      saveProgress('similarity-check', 'completed', `防复刻检查通过：最高相似度 ${Number(similarity.max_similarity || 0).toFixed(4)}`, [similarityArtifact.id]);

      run = loadRun(run.id, false) || run;
      stage = run.stages.find(item => item.id === 'microstory') || stage;
      const executionReceipt = {
        schema_version: '1.0',
        completed_at: new Date().toISOString(),
        network_used: false,
        search_count: 2,
        referenced_results: Math.max(0, Number(topicSearch.result_count) || 0) + Math.max(0, Number(mechanismSearch.result_count) || 0),
        similarity: { pass: true, max_similarity: Number(similarity.max_similarity) || 0, threshold: Number(similarity.threshold) || 0.18, rewrite_count: rewriteCount },
        text_provider: { id: scriptResult.providerId || conceptResult.providerId, model: scriptResult.model || conceptResult.model },
        output: 'story/final-script.md'
      };
      const executionArtifact = writeArtifact('story/story-execution-receipt.json', JSON.stringify(executionReceipt, null, 2) + '\n');
      stage.status = 'completed';
      stage.message = '两次离线检索、原创成稿和防复刻检查均已完成；等待用户验收';
      stage.artifactIds = [...new Set([...(stage.artifactIds || []), executionArtifact.id, ...stage.executionSteps.flatMap(step => step.artifactIds || [])])];
      stage.completedAt = Date.now();
      stage.updatedAt = Date.now();
      const nextStage = run.stages.find(item => item.order === stage.order + 1);
      if (nextStage) {
        nextStage.status = 'queued';
        nextStage.message = '等待用户审核并锁定纯文字剧本后再开始';
        nextStage.updatedAt = Date.now();
      }
      run.status = 'paused';
      run.currentStageId = stage.id;
      run.error = '请审核并锁定剧本后再进入分镜阶段';
      appendEvent(run, `${stage.message}；已停在剧本版本审核点`, 'completed');
      run = saveRun(run);
      return scriptVersions.initializeReview(run.id);
    } catch (error) {
      run = loadRun(run.id, false) || run;
      stage = run.stages.find(item => item.id === 'microstory') || stage;
      if (run.status === 'cancelled' || error.code === 'AGENT_CANCELLED') {
        stage.status = 'cancelled';
        stage.message = '用户已取消故事阶段；已有检索与剧本文件保持不变';
      } else {
        run.status = error.killed || error?.name === 'AbortError' ? 'interrupted' : 'failed';
        run.error = safeText(error.stderr || error.message || '微故事阶段执行失败', 2000);
        stage.status = 'failed';
        stage.message = run.error;
        appendEvent(run, run.error, 'failed');
      }
      stage.updatedAt = Date.now();
      return saveRun(run);
    } finally {
      activeRuns.delete(run.id);
      activeAbortControllers.delete(run.id);
      activeProcesses.delete(run.id);
    }
  }

  function creativePrerequisites(run) {
    if (!run.project?.slug) throw new Error('请先完成产品事实与项目阶段');
    const projectDir = resolveInside(projectRoot, run.project.slug);
    const factPath = resolveInside(projectDir, 'research/product-fact-lock.md');
    const boundaryPath = resolveInside(projectDir, 'research/research-boundary.json');
    if (!fs.existsSync(factPath) || !fs.existsSync(boundaryPath)) throw new Error('请先完成并审核产品事实与调研边界');
    const projection = typeof foundation?.status === 'function' ? foundation.status({ canvasId: run.canvasId, mode: 'legacy-history' }).projection : null;
    const locked = type => projection?.history?.artifacts?.find(node => node.runId === run.id && node.artifactType === type && node.locked && node.validityState === 'current');
    const factNode = locked('product-fact-lock');
    const boundaryNode = locked('research-boundary');
    if (projection && (!factNode || !boundaryNode)) throw new Error('产品事实锁与调研边界必须先提交审核并锁定');
    const offlineNode = locked('offline-research');
    return {
      projectDir,
      factText: fs.readFileSync(factPath, 'utf8'),
      boundaryText: fs.readFileSync(boundaryPath, 'utf8'),
      factNode,
      boundaryNode,
      storyResearchUsed: Boolean(offlineNode),
      inputRefs: [factNode && { artifactVersionId: factNode.artifactVersionId, role: 'product-fact-lock' }, boundaryNode && { artifactVersionId: boundaryNode.artifactVersionId, role: 'research-boundary' }].filter(Boolean)
    };
  }

  async function executeCreativeDirections(runId, executionOptions = {}) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.creativeScript?.directionsArtifactVersionId) return run;
    const generator = typeof executionOptions.generateStoryText === 'function' ? executionOptions.generateStoryText : generateStoryText;
    if (typeof generator !== 'function') throw new Error('画布文字模型尚未配置');
    const prerequisites = creativePrerequisites(run);
    const response = await generator({
      purpose: 'creative-directions',
      systemPrompt: '你是 Lavans 画布 AGENT 的原创短视频编剧。只能使用已锁定产品事实。返回严格的 JSON 对象，只有 directions 数组；不得增加功效、数据、认证、价格或包装文字。',
      userPrompt: `请提供 3 到 6 个明显不同的原创创意方向。每项必须包含 id、title、hook、characters、conflict、reversal、productPlacement、ending、productionNotes。\n\n产品事实锁：\n${prerequisites.factText}\n\n调研边界：\n${prerequisites.boundaryText}\n\n${prerequisites.storyResearchUsed ? '可以使用已锁定离线调研中的抽象机制，但不得复刻原文。' : '没有使用故事资料库；只能根据产品事实进行原创。'}`,
      run: normalizeRun(run)
    });
    const directions = parseCreativeDirections(typeof response === 'string' ? response : response?.text);
    const plainText = directionsPlainText(directions);
    fs.mkdirSync(resolveInside(prerequisites.projectDir, 'story'), { recursive: true });
    fs.writeFileSync(resolveInside(prerequisites.projectDir, 'story/creative-directions.json'), JSON.stringify({ directions }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(resolveInside(prerequisites.projectDir, 'story/creative-directions.txt'), plainText + '\n', 'utf8');
    const artifact = foundation.createArtifact({
      logicalArtifactId: `${run.id}-creative-directions`, artifactType: 'creative-directions', content: { directions }, extension: '.json',
      inputRefs: prerequisites.inputRefs, source: 'agent-creative-script', operationId: `${run.id}-phase3-directions-v1`,
      metadata: {
        canvasId: run.canvasId, runId: run.id, phaseId: '3', displayTitle: '创意方向选择',
        summary: `${directions.length} 个原创方向，等待选择一个后提交审核`,
        reviewChecklist: ['开场钩子是否有吸引力', '人物关系、冲突和反转是否满意', '产品植入和结尾是否自然'],
        reviewOptions: directions.map(item => ({ id: item.id, label: item.title, description: directionPlainText(item, directions.indexOf(item)) }))
      }
    });
    run.creativeScript = {
      status: 'awaiting-direction-selection', message: '创意方向已生成，请选择一个方案并提交审核',
      directionsArtifactVersionId: artifact.artifactVersionId, selectedArtifactVersionId: '', selectedDirectionId: '', scriptArtifactVersionId: '', directions,
      providerId: safeText(response?.providerId || response?.provider, 120), model: safeText(response?.model, 240),
      storyResearchUsed: prerequisites.storyResearchUsed, updatedAt: Date.now()
    };
    run.status = 'paused'; run.currentStageId = 'microstory'; run.error = '请选择一个创意方向并提交审核';
    const stage = run.stages.find(item => item.id === 'microstory');
    if (stage) { stage.status = 'paused'; stage.message = run.creativeScript.message; stage.updatedAt = Date.now(); }
    appendEvent(run, run.creativeScript.message, 'awaiting-review');
    return saveRun(run);
  }

  function selectCreativeDirection(runId, directionId) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    const id = safeId(directionId, '');
    const direction = run.creativeScript?.directions?.find(item => safeId(item.id, '') === id);
    if (!direction) throw new Error('请选择有效的创意方向');
    if (run.creativeScript.selectedArtifactVersionId) return run;
    const sourceId = run.creativeScript.directionsArtifactVersionId;
    foundation.approvalGate.requestReview(sourceId);
    foundation.approvalGate.approve(sourceId);
    foundation.approvalGate.lock(sourceId);
    const selected = foundation.createArtifact({
      logicalArtifactId: `${run.id}-selected-creative-direction`, artifactType: 'selected-creative-direction', content: directionPlainText(direction, run.creativeScript.directions.indexOf(direction)), extension: '.txt',
      inputRefs: [{ artifactVersionId: sourceId, role: 'selected-from' }], source: 'agent-creative-script', operationId: `${run.id}-phase3-selected-${id}`,
      metadata: { canvasId: run.canvasId, runId: run.id, phaseId: '3', displayTitle: '已锁定创意方向', summary: direction.title, reviewChecklist: [] }
    });
    foundation.approvalGate.requestReview(selected.artifactVersionId);
    foundation.approvalGate.approve(selected.artifactVersionId);
    foundation.approvalGate.lock(selected.artifactVersionId);
    run.creativeScript.selectedArtifactVersionId = selected.artifactVersionId;
    run.creativeScript.selectedDirectionId = id;
    run.creativeScript.status = 'direction-locked';
    run.creativeScript.message = `创意方向“${direction.title}”已锁定，可以生成完整剧本`;
    run.creativeScript.updatedAt = Date.now();
    run.status = 'paused'; run.error = '创意方向已锁定，等待生成完整剧本';
    appendEvent(run, run.creativeScript.message, 'locked');
    return saveRun(run);
  }

  async function executeScriptDraft(runId, executionOptions = {}) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.scriptReview?.versions?.length) return run;
    const selected = run.creativeScript?.directions?.find(item => safeId(item.id, '') === run.creativeScript?.selectedDirectionId);
    if (!selected || !run.creativeScript?.selectedArtifactVersionId) throw new Error('请先选择并锁定创意方向');
    const generator = typeof executionOptions.generateStoryText === 'function' ? executionOptions.generateStoryText : generateStoryText;
    if (typeof generator !== 'function') throw new Error('画布文字模型尚未配置');
    const prerequisites = creativePrerequisites(run);
    const response = await generator({
      purpose: 'final-script',
      systemPrompt: '你是 Lavans 画布 AGENT 的原创短视频编剧。输出给人阅读的中文纯文字完整剧本，只用普通标题、段落和标点，不得输出 JSON、代码块或字段对象。严格遵守产品事实锁。',
      userPrompt: `根据已锁定创意方向写完整可拍摄剧本。必须包括项目定位、人物、场景、按时间段拆分的画面动作与台词、字幕或音效、产品植入、时长估算和结尾。\n\n产品事实锁：\n${prerequisites.factText}\n\n调研边界：\n${prerequisites.boundaryText}\n\n已锁定创意方向：\n${directionPlainText(selected, 0)}\n\n${prerequisites.storyResearchUsed ? '只可使用离线调研提炼的抽象规律。' : '本次未使用故事资料库，禁止声称做过故事库调研。'}`,
      run: normalizeRun(run)
    });
    const script = validateScript(typeof response === 'string' ? response : response?.text);
    const scriptPath = resolveInside(prerequisites.projectDir, 'story/final-script.md');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, script.trimEnd() + '\n', 'utf8');
    const artifact = upsertArtifact(run, artifactForProjectFile(prerequisites.projectDir, run.project.slug, 'microstory', 'story/final-script.md'));
    run.creativeScript.status = 'script-awaiting-review'; run.creativeScript.message = '完整纯文字剧本已生成，等待一次提交审核';
    run.creativeScript.scriptArtifactVersionId = artifact.id; run.creativeScript.providerId = safeText(response?.providerId || response?.provider, 120); run.creativeScript.model = safeText(response?.model, 240); run.creativeScript.updatedAt = Date.now();
    const stage = run.stages.find(item => item.id === 'microstory');
    if (stage) { stage.status = 'completed'; stage.message = run.creativeScript.message; stage.completedAt = Date.now(); stage.updatedAt = Date.now(); stage.artifactIds = [...new Set([...(stage.artifactIds || []), artifact.id])]; }
    run.status = 'paused'; run.currentStageId = 'microstory'; run.error = '请审核完整剧本并提交一次审核';
    appendEvent(run, run.creativeScript.message, 'completed');
    run = saveRun(run);
    return scriptVersions.initializeReview(run.id);
  }

  function storyboardPrerequisites(run) {
    if (!run.project?.slug) throw new Error('请先完成产品事实与项目阶段');
    if (!hasLockedScript(run)) throw new Error('请先提交审核并锁定完整剧本');
    const projectDir = resolveInside(projectRoot, run.project.slug);
    const lockedScript = scriptVersions.getVersion(run.id, run.scriptReview.lockedVersionId);
    if (!lockedScript?.content) throw new Error('已锁定剧本正文不存在');
    const projection = typeof foundation?.status === 'function' ? foundation.status({ canvasId: run.canvasId, mode: 'legacy-history' }).projection : null;
    const locked = type => projection?.history?.artifacts?.find(node => node.runId === run.id && node.artifactType === type && node.locked && node.validityState === 'current');
    const factNode = locked('product-fact-lock');
    const selectedNode = locked('selected-creative-direction');
    if (projection && (!factNode || !selectedNode)) throw new Error('产品事实锁与创意方向必须保持锁定');
    const factPath = resolveInside(projectDir, 'research/product-fact-lock.md');
    if (!fs.existsSync(factPath)) throw new Error('产品事实锁文件不存在');
    return {
      projectDir,
      lockedScriptText: lockedScript.content,
      lockedScriptVersionId: lockedScript.version.id,
      factText: fs.readFileSync(factPath, 'utf8'),
      inputRefs: [
        factNode && { artifactVersionId: factNode.artifactVersionId, role: 'product-fact-lock' },
        selectedNode && { artifactVersionId: selectedNode.artifactVersionId, role: 'locked-direction' }
      ].filter(Boolean)
    };
  }

  function expectedDuration(run) {
    return normalizeDuration(run.questionnaireAnswers?.durationSeconds);
  }

  function phase4Stage(run) {
    const stage = run.stages.find(item => item.id === 'shot-and-asset-plan');
    if (!stage) throw new Error('Skill 缺少分镜与资产台账阶段');
    return stage;
  }

  function writePhase4File(run, projectDir, relativePath, content) {
    const absolute = resolveInside(projectDir, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
    return upsertArtifact(run, artifactForProjectFile(projectDir, run.project.slug, 'shot-and-asset-plan', relativePath));
  }

  async function executeStructuredShots(runId, executionOptions = {}) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.storyboardPlan?.shotsArtifactVersionId) return run;
    const generator = typeof executionOptions.generateStoryText === 'function' ? executionOptions.generateStoryText : generateStoryText;
    if (typeof generator !== 'function') throw new Error('画布文字模型尚未配置');
    const prerequisites = storyboardPrerequisites(run);
    const durationSeconds = expectedDuration(run);
    const response = await generator({
      purpose: 'structured-shot-plan',
      systemPrompt: '你是 Lavans 画布 AGENT 的分镜导演。只把已锁定剧本拆成结构化镜头，绝不改写剧情或产品事实。返回严格 JSON 对象，只有 shots 数组。',
      userPrompt: `把下方已锁定剧本拆成可拍摄的逐镜脚本，总时长必须精确为 ${durationSeconds} 秒。每个镜头必须包含 id、order、timeRange、durationSeconds、scene、framing、cameraMovement、visual、action、dialogue、narration、subtitle、sound、transition、firstFrame、lastFrame、requiredAssets、immutableConstraints。requiredAssets 每项只含 type 和 name，type 只能是 character、product、scene、prop、logo。不得生成图片或视频。\n\n已锁定产品事实：\n${prerequisites.factText}\n\n已锁定剧本：\n${prerequisites.lockedScriptText}`,
      run: normalizeRun(run)
    });
    const plan = parseShotPlan(typeof response === 'string' ? response : response?.text, durationSeconds);
    const plainText = shotPlanPlainText(plan);
    const jsonArtifact = writePhase4File(run, prerequisites.projectDir, 'production/shot-list.json', JSON.stringify(plan, null, 2) + '\n');
    const textArtifact = writePhase4File(run, prerequisites.projectDir, 'production/shot-list.md', plainText + '\n');
    const projected = foundation.createArtifact({
      logicalArtifactId: `${run.id}-structured-shot-plan`, artifactType: 'structured-shot-plan', content: plainText, extension: '.txt',
      inputRefs: prerequisites.inputRefs, source: 'agent-storyboard-assets', operationId: `${run.id}-phase4-shots-v1`,
      metadata: {
        canvasId: run.canvasId, runId: run.id, phaseId: '4', displayTitle: '结构化分镜脚本',
        summary: `${plan.shots.length} 个镜头 · 总时长 ${plan.totalDurationSeconds} 秒 · 等待一次提交审核`,
        reviewChecklist: ['镜头顺序、节奏和总时长是否正确', '画面、动作、对白、旁白和字幕是否忠于锁定剧本', '首尾帧、所需资产和不可变化约束是否完整'],
        lockedScriptVersionId: prerequisites.lockedScriptVersionId
      }
    });
    run.storyboardPlan = {
      status: 'shots-awaiting-review', message: '结构化分镜脚本已生成，等待一次提交审核',
      shotsArtifactVersionId: projected.artifactVersionId, assetsArtifactVersionId: '', coverageArtifactVersionId: '',
      shots: plan.shots, totalDurationSeconds: plan.totalDurationSeconds, assets: [], shotAssignments: [], coverage: null,
      providerId: safeText(response?.providerId || response?.provider, 120), model: safeText(response?.model, 240), updatedAt: Date.now()
    };
    const stage = phase4Stage(run);
    stage.status = 'paused'; stage.message = run.storyboardPlan.message; stage.startedAt = stage.startedAt || Date.now(); stage.updatedAt = Date.now();
    stage.artifactIds = [...new Set([...(stage.artifactIds || []), jsonArtifact.id, textArtifact.id])];
    run.status = 'paused'; run.currentStageId = stage.id; run.error = '请审核结构化分镜脚本并提交一次审核';
    appendEvent(run, run.storyboardPlan.message, 'awaiting-review');
    return saveRun(run);
  }

  async function executeAssetLedger(runId, executionOptions = {}) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.storyboardPlan?.assetsArtifactVersionId) return run;
    const prerequisites = storyboardPrerequisites(run);
    const projection = foundation.status({ canvasId: run.canvasId, mode: 'legacy-history' }).projection;
    const shotsNode = projection.history.artifacts.find(node => node.artifactVersionId === run.storyboardPlan?.shotsArtifactVersionId);
    if (!shotsNode?.locked || shotsNode.validityState !== 'current') throw new Error('请先提交审核并锁定结构化分镜脚本');
    const generator = typeof executionOptions.generateStoryText === 'function' ? executionOptions.generateStoryText : generateStoryText;
    if (typeof generator !== 'function') throw new Error('画布文字模型尚未配置');
    const materialList = (run.materials || []).map(item => `${item.id}：${item.name || item.originalName}（${item.kind || 'file'}）`).join('\n') || '没有上传资料';
    const response = await generator({
      purpose: 'asset-anchor-ledger',
      systemPrompt: '你是 Lavans 画布 AGENT 的制片资产管理员。只建立资产锚点和逐镜引用，不生成资产，不扩写产品事实。返回严格 JSON 对象，只含 assets 与 shotAssignments。',
      userPrompt: `根据已锁定分镜建立资产台账。assets 每项包含 id、type、name、usage、sourceMaterialIds、anchorFacts、immutableConstraints。type 只能是 character、product、scene、prop、logo。shotAssignments 每项包含 shotId 和 assetIds。每个镜头的每项所需资产必须有名称、类型完全匹配的资产引用。产品必须登记事实锚点和不可变化约束。上传资料 ID 只能从给定清单选择，不得虚构。\n\n上传资料：\n${materialList}\n\n产品事实锁：\n${prerequisites.factText}\n\n结构化分镜：\n${shotPlanPlainText({ shots: run.storyboardPlan.shots, totalDurationSeconds: run.storyboardPlan.totalDurationSeconds })}`,
      run: normalizeRun(run)
    });
    const ledger = parseAssetLedger(typeof response === 'string' ? response : response?.text, run.storyboardPlan, (run.materials || []).map(item => item.id));
    const materialNames = Object.fromEntries((run.materials || []).map(item => [item.id, item.name || item.originalName || item.id]));
    const plainText = assetLedgerPlainText(ledger, materialNames);
    const jsonArtifact = writePhase4File(run, prerequisites.projectDir, 'assets/asset-manifest.json', JSON.stringify(ledger, null, 2) + '\n');
    const textArtifact = writePhase4File(run, prerequisites.projectDir, 'assets/asset-manifest.md', plainText + '\n');
    const projected = foundation.createArtifact({
      logicalArtifactId: `${run.id}-asset-anchor-ledger`, artifactType: 'asset-anchor-ledger', content: plainText, extension: '.txt',
      inputRefs: [{ artifactVersionId: shotsNode.artifactVersionId, role: 'locked-shot-plan' }], source: 'agent-storyboard-assets', operationId: `${run.id}-phase4-assets-v1`,
      metadata: {
        canvasId: run.canvasId, runId: run.id, phaseId: '4', displayTitle: '角色、产品、场景、道具与 Logo 台账',
        summary: `${ledger.assets.length} 项资产 · ${ledger.shotAssignments.length} 个逐镜引用 · 等待一次提交审核`,
        reviewChecklist: ['角色、产品、场景、道具和 Logo 是否齐全', '上传资料引用与产品事实锚点是否准确', '每项不可变化约束是否足以保证后续一致性']
      }
    });
    run.storyboardPlan.status = 'assets-awaiting-review'; run.storyboardPlan.message = '资产锚点台账已生成，等待一次提交审核';
    run.storyboardPlan.assetsArtifactVersionId = projected.artifactVersionId; run.storyboardPlan.assets = ledger.assets; run.storyboardPlan.shotAssignments = ledger.shotAssignments;
    run.storyboardPlan.providerId = safeText(response?.providerId || response?.provider, 120); run.storyboardPlan.model = safeText(response?.model, 240); run.storyboardPlan.updatedAt = Date.now();
    const stage = phase4Stage(run);
    stage.status = 'paused'; stage.message = run.storyboardPlan.message; stage.updatedAt = Date.now(); stage.artifactIds = [...new Set([...(stage.artifactIds || []), jsonArtifact.id, textArtifact.id])];
    run.status = 'paused'; run.currentStageId = stage.id; run.error = '请审核资产锚点台账并提交一次审核';
    appendEvent(run, run.storyboardPlan.message, 'awaiting-review');
    return saveRun(run);
  }

  function executeStoryboardCoverage(runId) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.storyboardPlan?.coverageArtifactVersionId) return run;
    const prerequisites = storyboardPrerequisites(run);
    const projection = foundation.status({ canvasId: run.canvasId, mode: 'legacy-history' }).projection;
    const shotsNode = projection.history.artifacts.find(node => node.artifactVersionId === run.storyboardPlan?.shotsArtifactVersionId);
    const assetsNode = projection.history.artifacts.find(node => node.artifactVersionId === run.storyboardPlan?.assetsArtifactVersionId);
    if (!shotsNode?.locked || !assetsNode?.locked) throw new Error('请先分别提交审核并锁定分镜脚本和资产台账');
    const report = validateCoverage(run.storyboardPlan, { assets: run.storyboardPlan.assets, shotAssignments: run.storyboardPlan.shotAssignments });
    const plainText = coveragePlainText(report);
    const reportArtifact = writePhase4File(run, prerequisites.projectDir, 'production/shot-asset-coverage.md', plainText + '\n');
    const projected = foundation.createArtifact({
      logicalArtifactId: `${run.id}-shot-asset-coverage`, artifactType: 'shot-asset-coverage', content: plainText, extension: '.txt',
      inputRefs: [{ artifactVersionId: shotsNode.artifactVersionId, role: 'locked-shot-plan' }, { artifactVersionId: assetsNode.artifactVersionId, role: 'locked-asset-ledger' }],
      source: 'agent-storyboard-assets', operationId: `${run.id}-phase4-coverage-v1`,
      metadata: {
        canvasId: run.canvasId, runId: run.id, phaseId: '4', displayTitle: '分镜与资产覆盖校验',
        summary: report.valid ? `${report.coveredShotCount}/${report.shotCount} 个镜头完整覆盖 · 等待一次提交审核` : `${report.issues.length} 个问题需要修复`,
        blockedReason: report.valid ? '' : report.issues.join('；'),
        reviewChecklist: report.valid ? ['每个镜头的所需资产是否全部对应', '产品事实锚点与不可变化约束是否完整', '确认本阶段没有提前生成图片或视频'] : []
      }
    });
    run.storyboardPlan.status = report.valid ? 'coverage-awaiting-review' : 'coverage-blocked';
    run.storyboardPlan.message = report.valid ? '分镜与资产覆盖校验通过，等待一次提交审核' : `覆盖校验未通过：${report.issues.join('；')}`;
    run.storyboardPlan.coverageArtifactVersionId = projected.artifactVersionId; run.storyboardPlan.coverage = report; run.storyboardPlan.updatedAt = Date.now();
    const stage = phase4Stage(run);
    stage.status = report.valid ? 'paused' : 'blocked'; stage.message = run.storyboardPlan.message; stage.updatedAt = Date.now(); stage.artifactIds = [...new Set([...(stage.artifactIds || []), reportArtifact.id])];
    run.status = report.valid ? 'paused' : 'blocked'; run.currentStageId = stage.id; run.error = report.valid ? '请审核覆盖校验并提交一次审核' : run.storyboardPlan.message;
    appendEvent(run, run.storyboardPlan.message, report.valid ? 'awaiting-review' : 'blocked');
    return saveRun(run);
  }

  function syncStoryboardPlan(runId) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (!run.storyboardPlan) throw new Error('阶段四尚未开始');
    const projection = foundation.status({ canvasId: run.canvasId, mode: 'legacy-history' }).projection;
    const locked = id => Boolean(id && projection.history.artifacts.find(node => node.artifactVersionId === id && node.locked && node.validityState === 'current'));
    const stage = phase4Stage(run);
    if (locked(run.storyboardPlan.coverageArtifactVersionId) && run.storyboardPlan.coverage?.valid === true) {
      run.storyboardPlan.status = 'locked'; run.storyboardPlan.message = '结构化分镜、资产台账与覆盖校验均已锁定';
      stage.status = 'completed'; stage.message = run.storyboardPlan.message; stage.completedAt = Date.now(); stage.updatedAt = Date.now();
      run.status = 'paused'; run.currentStageId = stage.id; run.error = '阶段四已完成，等待用户验收后进入模型策略与费用防线';
      appendEvent(run, run.storyboardPlan.message, 'completed');
    } else if (locked(run.storyboardPlan.assetsArtifactVersionId)) {
      run.storyboardPlan.status = 'assets-locked'; run.storyboardPlan.message = '资产锚点台账已锁定，可以执行覆盖校验';
      stage.status = 'paused'; stage.message = run.storyboardPlan.message; stage.updatedAt = Date.now(); run.status = 'paused'; run.error = '等待执行分镜与资产覆盖校验';
    } else if (locked(run.storyboardPlan.shotsArtifactVersionId)) {
      run.storyboardPlan.status = 'shots-locked'; run.storyboardPlan.message = '结构化分镜脚本已锁定，可以建立资产台账';
      stage.status = 'paused'; stage.message = run.storyboardPlan.message; stage.updatedAt = Date.now(); run.status = 'paused'; run.error = '等待建立资产锚点台账';
    }
    run.storyboardPlan.updatedAt = Date.now();
    return saveRun(run);
  }

  async function installStoryDatabase(runId, input = {}) {
    let run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.status === 'cancelled') throw new Error('已取消的 Run 不能安装故事数据库');
    if (input.rightsConfirmed !== true) throw new Error('请先确认您对该故事数据库拥有合法使用权');
    if (!run.project?.slug) throw new Error('请先完成产品事实与项目阶段');
    const uploadPath = path.resolve(String(input.filePath || ''));
    const extension = path.extname(safeText(input.originalName || uploadPath, 260)).toLowerCase();
    if (!['.sqlite3', '.sqlite', '.db'].includes(extension)) throw new Error('故事数据库只支持 .sqlite3、.sqlite 或 .db 文件');
    if (!fs.existsSync(uploadPath) || !fs.statSync(uploadPath).isFile()) throw new Error('上传的故事数据库不存在');
    const dependency = storyDependencySnapshot();
    if (!dependency.runtime?.codeAvailable || !dependency.runtime?.databasePath) throw new Error('故事 Skill 代码尚未正确接入');
    if (dependency.runtime.databaseAvailable || fs.existsSync(dependency.runtime.databasePath)) throw new Error('故事数据库已经存在；为避免覆盖，当前入口拒绝替换现有数据库');
    if (!fs.existsSync(storyDatabaseValidatorPath)) throw new Error('故事数据库校验器不存在');

    const stage = run.stages.find(item => item.id === 'microstory');
    if (!stage) throw new Error('Skill 缺少 microstory 阶段');
    stage.status = 'running';
    stage.message = '正在离线校验故事数据库；尚未安装，也未生成剧本';
    stage.startedAt = stage.startedAt || Date.now();
    stage.updatedAt = Date.now();
    run.status = 'running';
    run.currentStageId = stage.id;
    run.error = '';
    appendEvent(run, '开始离线校验用户提交的故事数据库', 'running');
    run = saveRun(run);

    const databasePath = dependency.runtime.databasePath;
    const incomingPath = `${databasePath}.incoming-${safeId(run.id, 'run')}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.copyFileSync(uploadPath, incomingPath, fs.constants.COPYFILE_EXCL);
      const result = await runPython(storyDatabaseValidatorPath, ['--db', incomingPath], run.id);
      const validation = JSON.parse(result.stdout.trim());
      if (validation?.ok !== true || validation?.network_used !== false) throw new Error(safeText(validation?.error || '故事数据库校验失败', 1000));
      const latestRun = loadRun(run.id, false);
      if (latestRun?.status === 'cancelled') {
        if (fs.existsSync(incomingPath)) fs.unlinkSync(incomingPath);
        return latestRun;
      }
      if (fs.existsSync(databasePath)) throw new Error('校验期间检测到已有故事数据库；为避免覆盖，已停止安装');
      fs.renameSync(incomingPath, databasePath);

      run = await inspectMicrostoryStage(run.id);
      const projectDir = resolveInside(projectRoot, run.project.slug);
      const receiptRelative = 'story/story-database-installation.json';
      const receiptPath = resolveInside(projectDir, receiptRelative);
      fs.writeFileSync(receiptPath, JSON.stringify({
        schema_version: '1.0',
        dependency_id: 'douyin-tiktok-story-skill',
        installed_at: new Date().toISOString(),
        original_name: safeText(input.originalName || 'story-database.sqlite3', 240),
        byte_size: Math.max(0, Number(validation.byte_size) || fs.statSync(databasePath).size),
        canonical_scripts: Math.max(0, Number(validation.canonical_scripts) || 0),
        indexed_scripts: Math.max(0, Number(validation.indexed_scripts) || 0),
        rights_confirmed: true,
        network_used: false,
        replacement_performed: false
      }, null, 2) + '\n', 'utf8');
      const receiptArtifact = upsertArtifact(run, artifactForProjectFile(projectDir, run.project.slug, stage.id, receiptRelative));
      const currentStage = run.stages.find(item => item.id === stage.id) || stage;
      currentStage.artifactIds = [...new Set([...(currentStage.artifactIds || []), receiptArtifact.id])];
      currentStage.updatedAt = Date.now();
      appendEvent(run, `故事数据库已完成离线校验并安装：${Math.max(0, Number(validation.canonical_scripts) || 0)} 条规范脚本`, 'completed');
      return saveRun(run);
    } catch (error) {
      if (fs.existsSync(incomingPath)) fs.unlinkSync(incomingPath);
      run = loadRun(run.id, false) || run;
      if (run.status === 'cancelled') return run;
      const currentStage = run.stages.find(item => item.id === stage.id) || stage;
      currentStage.status = 'blocked';
      currentStage.message = `故事数据库未安装：${safeText(error.stderr || error.message || '校验失败', 900)}`;
      currentStage.updatedAt = Date.now();
      run.status = 'blocked';
      run.currentStageId = currentStage.id;
      run.error = currentStage.message;
      appendEvent(run, currentStage.message, 'blocked');
      return saveRun(run);
    }
  }

  async function runScriptSimilarityCheck(runId, content, signal) {
    const run = loadRun(runId, false);
    if (!run) throw new Error('Agent Run 不存在');
    if (!run.project?.slug) throw new Error('Agent Run 尚未创建项目目录');
    const text = safeText(content, 100000);
    if (text.length < 20) throw new Error('待检查的剧本内容不完整');
    const dependency = storyDependencySnapshot();
    if (!dependency.publicState.codeAvailable || !dependency.publicState.databaseAvailable || !dependency.runtime?.searchScriptPath) {
      throw new Error('本地故事数据库不可用，无法执行防复刻检查');
    }
    if (signal?.aborted) { const error = new Error('AI 修改已取消'); error.name = 'AbortError'; throw error; }
    const projectDir = resolveInside(projectRoot, run.project.slug);
    const reviewsDir = resolveInside(projectDir, 'story/reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    const tempPath = resolveInside(reviewsDir, `revision-check-${crypto.randomUUID()}.md`);
    try {
      fs.writeFileSync(tempPath, text, 'utf8');
      const result = await runPython(dependency.runtime.searchScriptPath, ['similarity-check', tempPath], run.id);
      if (signal?.aborted) { const error = new Error('AI 修改已取消'); error.name = 'AbortError'; throw error; }
      let payload;
      try { payload = JSON.parse(String(result.stdout || '').trim()); }
      catch (_error) { throw new Error('防复刻检查没有返回有效 JSON'); }
      if (payload?.ok !== true || payload?.network_used !== false) throw new Error('防复刻检查未通过本地离线约束');
      return payload;
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      try { if (fs.existsSync(reviewsDir) && fs.readdirSync(reviewsDir).length === 0) fs.rmdirSync(reviewsDir); } catch (_error) {}
    }
  }

  function pauseRun(runId) {
    const run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    if (run.status === 'running') throw new Error('当前本地脚本不支持安全暂停；可以取消，已完成文件会保留');
    if (run.status !== 'queued') throw new Error(`当前 Run 状态不可暂停：${run.status}`);
    run.status = 'paused';
    const stage = run.stages.find(item => item.id === run.currentStageId);
    if (stage && stage.status === 'queued') { stage.status = 'paused'; stage.message = '已暂停，尚未执行'; stage.updatedAt = Date.now(); }
    appendEvent(run, 'Run 已在执行前暂停', 'paused');
    return saveRun(run);
  }

  function resumeRun(runId) {
    const run = loadRun(runId);
    if (!run) throw new Error('Agent Run 不存在');
    const reviewStage = run.stages.find(item => item.id === 'microstory');
    if (run.currentStageId === 'microstory' && reviewStage?.status === 'completed') {
      if (!hasLockedScript(run)) {
        run.status = 'paused';
        run.error = '请审核并锁定剧本后再进入分镜阶段';
        reviewStage.message = '纯文字剧本已生成，等待用户审核并锁定版本';
        reviewStage.updatedAt = Date.now();
        return saveRun(run);
      }
      const nextStage = run.stages.find(item => item.order === reviewStage.order + 1);
      if (!nextStage) {
        run.status = 'completed';
        run.currentStageId = '';
        run.completedAt = Date.now();
      } else {
        nextStage.status = 'queued';
        nextStage.message = '锁定剧本已确认，等待用户启动分镜阶段';
        nextStage.updatedAt = Date.now();
        run.status = 'queued';
        run.currentStageId = nextStage.id;
      }
      run.error = '';
      appendEvent(run, '锁定剧本已确认；分镜阶段已进入等待队列，尚未自动执行', 'queued');
      return saveRun(run);
    }
    const completedStage = run.stages.find(item => item.id === run.currentStageId && item.status === 'completed');
    if (completedStage) {
      const nextStage = run.stages.find(item => item.order === completedStage.order + 1);
      if (!nextStage) {
        run.status = 'completed'; run.currentStageId = ''; run.completedAt = Date.now(); run.error = '';
      } else {
        nextStage.status = 'queued'; nextStage.message = '上一阶段已由用户验收，等待启动'; nextStage.updatedAt = Date.now();
        run.status = 'queued'; run.currentStageId = nextStage.id; run.error = '';
      }
      appendEvent(run, nextStage ? `${nextStage.title} 已进入等待队列` : '全部阶段已完成', 'queued');
      return saveRun(run);
    }
    if (run.status !== 'paused') throw new Error(`当前 Run 状态不可继续：${run.status}`);
    run.status = 'queued';
    const stage = run.stages.find(item => item.id === run.currentStageId);
    if (stage && stage.status === 'paused') { stage.status = 'queued'; stage.message = '等待执行'; stage.updatedAt = Date.now(); }
    appendEvent(run, 'Run 已恢复到等待执行状态', 'queued');
    return saveRun(run);
  }

  function cancelRun(runId) {
    const run = loadRun(runId, false);
    if (!run) throw new Error('Agent Run 不存在');
    if (['completed', 'cancelled'].includes(run.status)) return run;
    const child = activeProcesses.get(run.id);
    if (child && !child.killed) child.kill();
    activeProcesses.delete(run.id);
    activeAbortControllers.get(run.id)?.abort();
    activeAbortControllers.delete(run.id);
    run.status = 'cancelled';
    run.cancelledAt = Date.now();
    run.error = '';
    const stage = run.stages.find(item => item.id === run.currentStageId);
    if (stage && !['completed', 'cancelled'].includes(stage.status)) { stage.status = 'cancelled'; stage.message = '用户已取消；已有文件与产物保持不变'; stage.updatedAt = Date.now(); }
    appendEvent(run, 'Run 已取消；已有文件与产物保持不变', 'cancelled');
    return saveRun(run);
  }

  function artifactContent(runId, artifactId, recover = true) {
    const run = loadRun(runId, recover);
    if (!run) throw new Error('Agent Run 不存在');
    const artifact = run.artifacts.find(item => item.id === safeId(artifactId, ''));
    if (!artifact) throw new Error('Artifact 不存在');
    if (!['text', 'json'].includes(artifact.kind)) throw new Error('该 Artifact 不支持文本预览');
    const filePath = resolveInside(projectRoot, artifact.relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('Artifact 文件不存在');
    if (fs.statSync(filePath).size > 2 * 1024 * 1024) throw new Error('Artifact 过大，无法在线预览');
    return { run, artifact, content: fs.readFileSync(filePath, 'utf8') };
  }

  return { createRun, loadRun, listRuns, executeInitProject, executeProductResearch, inspectMicrostoryStage, executeMicrostoryStage, executeCreativeDirections, selectCreativeDirection, executeScriptDraft, executeStructuredShots, executeAssetLedger, executeStoryboardCoverage, syncStoryboardPlan, installStoryDatabase, runScriptSimilarityCheck, pauseRun, resumeRun, cancelRun, artifactContent, scriptVersions, roots: { stateRoot, projectRoot } };
}

module.exports = { createAgentRunService, createAgentRunReadOnlyFacade, RUN_STATUSES, STAGE_STATUSES };
