const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createProductResearchPackage } = require('../services/agentProductResearchService');
const { createAgentRunService } = require('../services/agentRunService');
const { findAgentSkillRuntime } = require('../services/agentSkillRegistry');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');

function createStoryDatabase(pythonExecutable, databasePath) {
  const rows = [
    ['校园误会', '校园', 'douyin', '老师误把学生的旧作业当成情书，同学追问后通过值日表揭开误会。'],
    ['合租争执', '合租', 'douyin', '室友因为冰箱里的蛋糕争执，最后发现是邻居送错了门。'],
    ['职场反转', '职场', 'douyin', '新人拿错会议资料被主管追问，最终用备忘录解决信息差。']
  ];
  const script = [
    'import json, sqlite3, sys',
    'db=sys.argv[1]; rows=json.loads(sys.argv[2]); conn=sqlite3.connect(db)',
    'conn.execute("CREATE TABLE source_documents (id INTEGER PRIMARY KEY,file_name TEXT,stage TEXT,platform TEXT,content TEXT,char_count INTEGER)")',
    'conn.execute("CREATE TABLE canonical_scripts (id INTEGER PRIMARY KEY,file_name TEXT,stage TEXT,platform TEXT,content TEXT,char_count INTEGER)")',
    'conn.execute("CREATE VIRTUAL TABLE scripts_fts USING fts5(content)")',
    'for index,row in enumerate(rows,1):',
    '  name,stage,platform,content=row; values=(index,name,stage,platform,content,len(content))',
    '  conn.execute("INSERT INTO source_documents VALUES (?,?,?,?,?,?)", values)',
    '  conn.execute("INSERT INTO canonical_scripts VALUES (?,?,?,?,?,?)", values)',
    '  conn.execute("INSERT INTO scripts_fts(content) VALUES (?)", (content,))',
    'conn.commit(); conn.close()'
  ].join('\n');
  execFileSync(pythonExecutable, ['-c', script, databasePath, JSON.stringify(rows)], { windowsHide: true });
}

function runInput(canvasId) {
  return {
    canvasId,
    skillId: 'create-product-microstory-seedance',
    brief: '为测试产品制作30秒竖屏短视频',
    questionnaireAnswers: {
      productName: '阶段2测试产品',
      facts: '净含量：100 克\n包装颜色：蓝色\n包装颜色：深蓝色',
      evidence: '说明书或规格文档',
      prohibitedClaims: '不得宣称治疗效果\n不能修改 Logo 或包装文字',
      audience: '年轻消费者',
      platforms: '抖音',
      cta: '点击了解',
      durationSeconds: '30 秒',
      aspectRatio: '9:16（竖屏）',
      visualStyle: '原创 stylized 3D',
      characterDirection: '温暖治愈'
    },
    materials: [{
      id: 'material_spec',
      name: '产品规格.md',
      originalName: '产品规格.md',
      kind: 'text',
      extension: '.md',
      mime: 'text/markdown',
      size: 120,
      url: '/canvas-assets/agent-materials/spec.md',
      previewText: '产品名称：阶段2测试产品\n净含量：100 克\n包装颜色：蓝色\n用途：日常展示测试',
      archiveEntries: []
    }]
  };
}

test('证据分级、冲突与调研边界均为确定性本地结果', () => {
  const research = createProductResearchPackage(runInput('pure-canvas'), { codeAvailable: false, databaseAvailable: false, message: '缺少本地授权数据库' }, {});
  assert.equal(research.evidenceLedger.sources[0].evidenceGrade, 'A');
  assert.equal(research.evidenceLedger.materials[0].previewText.includes('净含量：100 克'), true);
  assert.equal(research.evidenceLedger.conflicts.length, 1);
  assert.deepEqual(research.evidenceLedger.conflicts[0].statements, ['包装颜色：蓝色', '包装颜色：深蓝色']);
  assert.equal(research.offlineResearch.status, 'blocked');
  assert.equal(research.offlineResearch.networkUsed, false);
  assert.equal(research.researchBoundary.externalModelUsed, false);
  assert.match(research.factLockMarkdown, /不得宣称治疗效果/);
});

test('阶段2执行生成四个不可变可视节点、两次离线检索且重复执行幂等', async t => {
  const bundledPython = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const pythonExecutable = process.env.LAVANS_PYTHON_EXECUTABLE || (fs.existsSync(bundledPython) ? bundledPython : '');
  const skillRuntime = findAgentSkillRuntime('create-product-microstory-seedance')?.runtime;
  if (!pythonExecutable || !skillRuntime || !fs.existsSync(skillRuntime.entryPath)) return t.skip('真实 Skill 或 Python 当前不可用');
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-product-research-'));
  const storyRoot = path.join(outputRoot, 'story-skill');
  const scriptsRoot = path.join(storyRoot, 'scripts');
  const assetsRoot = path.join(storyRoot, 'assets');
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.mkdirSync(assetsRoot, { recursive: true });
  const searchScriptPath = path.join(scriptsRoot, 'local_search.py');
  fs.copyFileSync(path.join(__dirname, '..', 'agent-skills', 'dependencies', 'douyin-tiktok-story-skill', 'skill', 'scripts', 'local_search.py'), searchScriptPath);
  const databasePath = path.join(assetsRoot, 'douyin-story.sqlite3');
  createStoryDatabase(pythonExecutable, databasePath);
  const previousPython = process.env.LAVANS_PYTHON_EXECUTABLE;
  process.env.LAVANS_PYTHON_EXECUTABLE = pythonExecutable;
  try {
    const foundation = createCanvasAgentFoundation({ rootPath: path.join(outputRoot, 'foundation') });
    const service = createAgentRunService({
      outputRoot,
      findAgentSkillRuntime,
      findAgentDependencyRuntime: id => ({ runtime: { id, sourcePath: storyRoot, entryPath: path.join(storyRoot, 'SKILL.md'), searchScriptPath, databasePath, codeAvailable: true, databaseAvailable: true, status: 'available' } }),
      foundation
    });
    const created = service.createRun(runInput('phase2-canvas'));
    assert.match(service.loadRun(created.id).materials[0].previewText, /净含量/);
    await service.executeInitProject(created.id);
    const executed = await service.executeProductResearch(created.id);
    assert.equal(executed.productResearch.status, 'awaiting-review');
    assert.equal(executed.productResearch.networkUsed, false);
    assert.equal(executed.productResearch.externalModelUsed, false);
    assert.equal(executed.productResearch.artifactVersionIds.length, 4);
    const projection = foundation.status({ canvasId: 'phase2-canvas', mode: 'legacy-history' }).projection;
    const artifacts = projection.history.artifacts;
    assert.equal(artifacts.length, 4);
    assert.equal(projection.history.dependencies.length, 4);
    assert.deepEqual(artifacts.map(node => node.displayTitle), ['资料与证据', '产品事实锁', '离线调研', '调研边界']);
    assert.equal(artifacts.find(node => node.artifactType === 'offline-research').blockedReason, '');
    assert.equal(JSON.parse(artifacts.find(node => node.artifactType === 'offline-research').contentPreview).networkUsed, false);
    const factNode = artifacts.find(node => node.artifactType === 'product-fact-lock');
    assert.match(foundation.artifactStore.readContent(factNode.artifactVersionId), /包装颜色/);
    const repeated = await service.executeProductResearch(created.id);
    assert.deepEqual(repeated.productResearch.artifactVersionIds, executed.productResearch.artifactVersionIds);
    assert.equal(foundation.artifactStore.list({ canvasId: 'phase2-canvas' }).length, 4);
  } finally {
    if (previousPython === undefined) delete process.env.LAVANS_PYTHON_EXECUTABLE;
    else process.env.LAVANS_PYTHON_EXECUTABLE = previousPython;
  }
});

test('缺少授权故事库时生成真实阻塞节点且后端拒绝提交审核', async t => {
  const skillRuntime = findAgentSkillRuntime('create-product-microstory-seedance')?.runtime;
  if (!skillRuntime || !fs.existsSync(skillRuntime.entryPath)) return t.skip('真实 Skill 当前不可用');
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-product-research-blocked-'));
  const foundation = createCanvasAgentFoundation({ rootPath: path.join(outputRoot, 'foundation') });
  const service = createAgentRunService({
    outputRoot,
    findAgentSkillRuntime,
    findAgentDependencyRuntime: id => ({ runtime: { id, codeAvailable: true, databaseAvailable: false, status: 'database-missing' } }),
    foundation
  });
  const created = service.createRun(runInput('blocked-canvas'));
  await service.executeInitProject(created.id);
  const executed = await service.executeProductResearch(created.id);
  assert.equal(executed.productResearch.status, 'blocked');
  const offline = foundation.status({ canvasId: 'blocked-canvas', mode: 'legacy-history' }).projection.history.artifacts.find(node => node.artifactType === 'offline-research');
  assert.match(offline.blockedReason, /数据库/);
  assert.throws(() => foundation.approvalGate.requestReview(offline.artifactVersionId), /真实阻塞/);
});
