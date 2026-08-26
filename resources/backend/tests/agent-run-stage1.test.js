const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAgentRunService } = require('../services/agentRunService');
const { findAgentSkillRuntime } = require('../services/agentSkillRegistry');

test('真实 Skill 第 1 阶段创建项目、登记 Artifact，并在缺依赖处阻塞', async t => {
  const bundledPython = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const pythonExecutable = process.env.LAVANS_PYTHON_EXECUTABLE || (fs.existsSync(bundledPython) ? bundledPython : '');
  if (!pythonExecutable) return t.skip('当前环境没有可验证的 Python 解释器');
  const runtime = findAgentSkillRuntime('create-product-microstory-seedance')?.runtime;
  if (!runtime || !fs.existsSync(runtime.entryPath)) return t.skip('用户 Skill 源目录当前不可用');

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-stage1-'));
  const previousPython = process.env.LAVANS_PYTHON_EXECUTABLE;
  process.env.LAVANS_PYTHON_EXECUTABLE = pythonExecutable;
  try {
    const storySkillRoot = path.join(outputRoot, 'test-story-skill');
    const storyAssetsRoot = path.join(storySkillRoot, 'assets');
    fs.mkdirSync(storyAssetsRoot, { recursive: true });
    const testFindAgentDependencyRuntime = dependencyId => {
      const databasePath = path.join(storyAssetsRoot, 'douyin-story.sqlite3');
      const databaseAvailable = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
      return { runtime: {
        id: dependencyId,
        sourcePath: storySkillRoot,
        entryPath: path.join(storySkillRoot, 'SKILL.md'),
        searchScriptPath: path.join(storySkillRoot, 'scripts', 'local_search.py'),
        databasePath,
        licensePath: path.join(storySkillRoot, 'LICENSE'),
        codeAvailable: true,
        databaseAvailable,
        status: databaseAvailable ? 'available' : 'database-missing'
      }, loadedAt: Date.now() };
    };
    const service = createAgentRunService({ outputRoot, findAgentSkillRuntime, findAgentDependencyRuntime: testFindAgentDependencyRuntime });
    const created = service.createRun({
      canvasId: 'integration-canvas',
      skillId: 'create-product-microstory-seedance',
      brief: '为真实测试产品制作一条短视频',
      questionnaireAnswers: {
        productName: '真实测试产品',
        facts: '净含量 100 克\n包装为蓝色纸盒',
        evidence: '产品规格文档',
        prohibitedClaims: '不得宣称治疗效果',
        audience: '抖音成年用户',
        cta: '点击了解详情',
        durationSeconds: '30 秒',
        aspectRatio: '9:16（竖屏）',
        visualStyle: '原创 stylized 3D'
      },
      materials: [{ id: 'material-1', name: '产品实拍图.jpg', kind: 'image', url: '/canvas-assets/agent-materials/test.jpg', size: 1024 }]
    });
    assert.equal(created.status, 'queued');

    const executed = await service.executeInitProject(created.id);
    assert.equal(executed.status, 'blocked', `第 2 阶段依赖缺失时必须阻塞；实际错误：${executed.error || '无'}`);
    assert.equal(executed.stages[0].status, 'completed');
    assert.equal(executed.stages[1].status, 'blocked');
    assert(executed.artifacts.length >= 2, '真实项目至少应登记 project.json 和 product-brief.md');
    assert(executed.artifacts.every(item => item.url.startsWith('/canvas-output/agent-projects/')), 'Artifact 只能公开静态 URL');
    assert.equal(JSON.stringify(executed).includes(runtime.sourcePath), false, 'Run API 不得泄露用户 Skill 绝对路径');
    assert.equal(JSON.stringify(executed).includes(outputRoot), false, 'Run API 不得泄露项目绝对路径');

    const briefArtifact = executed.artifacts.find(item => item.relativePath.endsWith('/brief/product-brief.md'));
    assert(briefArtifact, '必须登记真实 product-brief.md');
    const preview = service.artifactContent(executed.id, briefArtifact.id);
    assert.match(preview.content, /真实测试产品/);
    assert.match(preview.content, /净含量 100 克/);
    assert.match(preview.content, /不得宣称治疗效果/);
    assert.match(preview.content, /产品实拍图\.jpg/);

    const storyChecked = await service.inspectMicrostoryStage(executed.id);
    assert.equal(storyChecked.status, 'blocked');
    assert.equal(storyChecked.stages[1].status, 'blocked');
    assert.match(storyChecked.stages[1].message, /缺少本地授权数据库 douyin-story\.sqlite3/);
    const storyStatusArtifact = storyChecked.artifacts.find(item => item.relativePath.endsWith('/story/story-skill-status.json'));
    assert(storyStatusArtifact, '第 2 节点必须登记真实依赖状态 Artifact');
    const storyStatus = JSON.parse(service.artifactContent(storyChecked.id, storyStatusArtifact.id).content);
    assert.equal(storyStatus.code_available, true, '开源故事 Skill 代码应已接入');
    assert.equal(storyStatus.database_available, false, '没有授权数据库时必须如实阻塞');
    assert.equal(storyStatus.network_used, false, '依赖检查不得联网执行素材检索');

    const invalidDatabase = path.join(outputRoot, 'invalid-story.sqlite3');
    fs.writeFileSync(invalidDatabase, 'not-a-sqlite-database', 'utf8');
    await assert.rejects(
      service.installStoryDatabase(storyChecked.id, { filePath: invalidDatabase, originalName: 'invalid-story.sqlite3', rightsConfirmed: false }),
      /合法使用权/,
      '未确认资料权利时必须拒绝安装'
    );
    const invalidInstall = await service.installStoryDatabase(storyChecked.id, { filePath: invalidDatabase, originalName: 'invalid-story.sqlite3', rightsConfirmed: true });
    assert.equal(invalidInstall.status, 'blocked');
    assert.match(invalidInstall.stages[1].message, /未安装/);
    assert.match(invalidInstall.stages[1].message, /为空或不完整|不是有效的 SQLite 3 数据库/);
  } finally {
    if (previousPython === undefined) delete process.env.LAVANS_PYTHON_EXECUTABLE;
    else process.env.LAVANS_PYTHON_EXECUTABLE = previousPython;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
