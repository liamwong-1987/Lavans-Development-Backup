const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createAgentRunService } = require('../services/agentRunService');
const { findAgentSkillRuntime } = require('../services/agentSkillRegistry');

function createStoryDatabase(pythonExecutable, databasePath) {
  const sourceRows = [
    ['校园误会', '校园', 'douyin', '老师误把学生的旧作业当成情书，同学起哄后通过值日表揭开误会。'],
    ['合租争执', '合租', 'douyin', '室友因为冰箱里的蛋糕发生争执，最后发现是邻居送错了门。'],
    ['职场反转', '职场', 'douyin', '新人拿错会议资料被主管追问，最终用备忘录解决信息差。']
  ];
  const script = [
    'import json, sqlite3, sys',
    'db=sys.argv[1]',
    'rows=json.loads(sys.argv[2])',
    'conn=sqlite3.connect(db)',
    'conn.execute("CREATE TABLE source_documents (id INTEGER PRIMARY KEY,file_name TEXT,stage TEXT,platform TEXT,content TEXT,char_count INTEGER)")',
    'conn.execute("CREATE TABLE canonical_scripts (id INTEGER PRIMARY KEY,file_name TEXT,stage TEXT,platform TEXT,content TEXT,char_count INTEGER)")',
    'conn.execute("CREATE VIRTUAL TABLE scripts_fts USING fts5(content)")',
    'for index,row in enumerate(rows,1):',
    '  name,stage,platform,content=row',
    '  values=(index,name,stage,platform,content,len(content))',
    '  conn.execute("INSERT INTO source_documents VALUES (?,?,?,?,?,?)", values)',
    '  conn.execute("INSERT INTO canonical_scripts VALUES (?,?,?,?,?,?)", values)',
    '  conn.execute("INSERT INTO scripts_fts(content) VALUES (?)", (content,))',
    'conn.commit(); conn.close()'
  ].join('\n');
  execFileSync(pythonExecutable, ['-c', script, databasePath, JSON.stringify(sourceRows)], { windowsHide: true });
}

test('微故事阶段执行两次离线检索、生成原创成稿并登记可见步骤与回执', async t => {
  const bundledPython = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const pythonExecutable = process.env.LAVANS_PYTHON_EXECUTABLE || (fs.existsSync(bundledPython) ? bundledPython : '');
  if (!pythonExecutable) return t.skip('当前环境没有可验证的 Python 解释器');
  const skillRuntime = findAgentSkillRuntime('create-product-microstory-seedance')?.runtime;
  if (!skillRuntime || !fs.existsSync(skillRuntime.entryPath)) return t.skip('用户 Skill 源目录当前不可用');

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-microstory-'));
  const previousPython = process.env.LAVANS_PYTHON_EXECUTABLE;
  process.env.LAVANS_PYTHON_EXECUTABLE = pythonExecutable;
  try {
    const storySkillRoot = path.join(outputRoot, 'story-skill');
    const scriptsRoot = path.join(storySkillRoot, 'scripts');
    const assetsRoot = path.join(storySkillRoot, 'assets');
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.mkdirSync(assetsRoot, { recursive: true });
    const bundledStoryScript = path.join(__dirname, '..', 'agent-skills', 'dependencies', 'douyin-tiktok-story-skill', 'skill', 'scripts', 'local_search.py');
    fs.copyFileSync(bundledStoryScript, path.join(scriptsRoot, 'local_search.py'));
    const databasePath = path.join(assetsRoot, 'douyin-story.sqlite3');
    createStoryDatabase(pythonExecutable, databasePath);

    const textCalls = [];
    const generateStoryText = async input => {
      textCalls.push({ purpose: input.purpose, systemPrompt: input.systemPrompt, userPrompt: input.userPrompt });
      if (input.purpose === 'concept-options') {
        return {
          text: '# 创意方向\n\n1. 宠物店闭店前的神秘订单\n2. 深夜仓库里的会发光玩具\n3. 主人与宠物交换任务\n4. 快递箱里的错误线索\n5. 公园寻物比赛\n6. 雨天临时避难所',
          providerId: 'test-provider', model: 'test-text-model', usage: { total_tokens: 120 }
        };
      }
      return {
        text: '# 最终剧本\n\n## 项目定位\n为真实测试产品制作30秒竖屏微故事。\n\n## 分段脚本\n0—3秒：毛绒小兽推着蓝色纸盒冲进宠物店。\n3—12秒：店员追问来源，小兽用爪印地图指出夜间仓库。\n12—22秒：纸盒打开，里面的真实测试产品帮助它完成寻物挑战。\n22—30秒：主人赶到，发现小兽只是提前准备生日惊喜。\n\n## 结尾钩子\n字幕：下一次它还会藏在哪里？',
        providerId: 'test-provider', model: 'test-text-model', usage: { total_tokens: 260 }
      };
    };
    const findStoryDependency = dependencyId => ({ runtime: {
      id: dependencyId,
      sourcePath: storySkillRoot,
      entryPath: path.join(storySkillRoot, 'SKILL.md'),
      searchScriptPath: path.join(scriptsRoot, 'local_search.py'),
      databasePath,
      licensePath: path.join(storySkillRoot, 'LICENSE'),
      codeAvailable: true,
      databaseAvailable: true,
      status: 'available'
    }, loadedAt: Date.now() });
    const service = createAgentRunService({
      outputRoot,
      findAgentSkillRuntime,
      findAgentDependencyRuntime: findStoryDependency,
      generateStoryText
    });
    const created = service.createRun({
      canvasId: 'microstory-canvas',
      skillId: 'create-product-microstory-seedance',
      brief: '为真实测试产品制作一条有反转的30秒竖屏短视频',
      questionnaireAnswers: {
        productName: '真实测试产品',
        facts: '净含量 100 克\n包装为蓝色纸盒',
        evidence: '产品规格文档',
        prohibitedClaims: '不得宣称治疗效果',
        audience: '抖音成年用户',
        cta: '点击了解详情',
        durationSeconds: '30 秒',
        aspectRatio: '9:16（竖屏）',
        visualStyle: '原创 stylized 3D',
        characterDirection: '毛绒小兽与宠物店员'
      },
      materials: []
    });
    const initialized = await service.executeInitProject(created.id);
    assert.equal(initialized.status, 'blocked');

    const completed = await service.executeMicrostoryStage(created.id);
    assert.equal(completed.stages[1].status, 'completed');
    assert.equal(completed.status, 'paused', '剧本生成后必须停在版本审核点');
    assert.equal(completed.currentStageId, 'microstory');
    assert.match(completed.error, /锁定剧本/);
    assert.equal(completed.scriptReview.versions.length, 1, '最终剧本必须自动归档为不可变 V1');
    assert.equal(completed.scriptReview.versions[0].id, 'script-v001');
    assert.equal(completed.scriptReview.activeVersionId, 'script-v001');

    const stillBlocked = service.resumeRun(created.id);
    assert.equal(stillBlocked.status, 'paused');
    assert.equal(stillBlocked.currentStageId, 'microstory');
    assert.match(stillBlocked.error, /锁定剧本/);

    service.scriptVersions.approveVersion(created.id, 'script-v001');
    const lockedReview = service.scriptVersions.lockVersion(created.id, 'script-v001', {});
    assert.equal(lockedReview.status, 'paused', '锁定只完成审核，不得自动执行分镜');
    assert.equal(lockedReview.currentStageId, 'microstory');
    assert.equal(lockedReview.error, '', '锁定成功后不得继续显示“请锁定剧本”的旧错误');
    assert.match(lockedReview.stages.find(stage => stage.id === 'microstory').message, /已锁定/);
    const readyForShots = service.resumeRun(created.id);
    assert.equal(readyForShots.status, 'queued');
    assert.equal(readyForShots.currentStageId, 'shot-and-asset-plan');
    assert.equal(readyForShots.stages.find(stage => stage.id === 'shot-and-asset-plan').status, 'queued');
    assert.deepEqual(completed.stages[1].executionSteps.map(step => step.status), Array(6).fill('completed'));
    assert.deepEqual(completed.stages[1].executionSteps.map(step => step.id), [
      'dependency-check', 'topic-search', 'mechanism-search', 'concept-options', 'final-script', 'similarity-check'
    ]);
    assert.equal(textCalls.length, 2, '正常通过相似度检查时只生成创意方向和最终剧本各一次');
    assert.deepEqual(textCalls.map(call => call.purpose), ['concept-options', 'final-script']);
    const outboundPrompts = textCalls.map(call => call.userPrompt).join('\n');
    assert.match(outboundPrompts, /抽象机制标签/, '外部文本模型只能收到本地提炼后的抽象机制标签');
    assert.equal(outboundPrompts.includes('老师误把学生的旧作业当成情书'), false, '不得把本地故事库摘录发送给外部文本模型');
    assert.equal(outboundPrompts.includes('校园误会'), false, '不得把本地故事库文件名发送给外部文本模型');

    const requiredArtifacts = [
      '/story/topic-search-receipt.json',
      '/story/mechanism-search-receipt.json',
      '/story/concept-options.md',
      '/story/final-script.md',
      '/story/similarity-check.json',
      '/story/story-execution-receipt.json'
    ];
    requiredArtifacts.forEach(suffix => assert(completed.artifacts.some(item => item.relativePath.endsWith(suffix)), `缺少 Artifact ${suffix}`));
    const finalScriptArtifact = completed.artifacts.find(item => item.relativePath.endsWith('/story/final-script.md'));
    const finalScript = service.artifactContent(completed.id, finalScriptArtifact.id).content;
    assert.match(finalScript, /真实测试产品/);
    assert.match(finalScript, /本地达人脚本库：检索2次/);
    const revisionSimilarity = await service.runScriptSimilarityCheck(completed.id, finalScript);
    assert.equal(revisionSimilarity.pass, true);
    assert.equal(revisionSimilarity.network_used, false);
    const reviewTempFiles = fs.existsSync(path.join(outputRoot, 'agent-projects', completed.project.slug, 'story', 'reviews'))
      ? fs.readdirSync(path.join(outputRoot, 'agent-projects', completed.project.slug, 'story', 'reviews'))
      : [];
    assert.equal(reviewTempFiles.length, 0, 'AI 修改防复刻临时文件必须清理');

    const executionArtifact = completed.artifacts.find(item => item.relativePath.endsWith('/story/story-execution-receipt.json'));
    const executionReceipt = JSON.parse(service.artifactContent(completed.id, executionArtifact.id).content);
    assert.equal(executionReceipt.network_used, false);
    assert.equal(executionReceipt.search_count, 2);
    assert.equal(executionReceipt.similarity.pass, true);
    assert.equal(executionReceipt.text_provider.id, 'test-provider');
    assert.equal(executionReceipt.text_provider.model, 'test-text-model');

    for (const suffix of ['/story/topic-search-receipt.json', '/story/mechanism-search-receipt.json']) {
      const artifact = completed.artifacts.find(item => item.relativePath.endsWith(suffix));
      const receiptText = service.artifactContent(completed.id, artifact.id).content;
      assert.equal(receiptText.includes('excerpt'), false, '检索回执不得向画布暴露源脚本摘录');
      assert.equal(receiptText.includes('content'), false, '检索回执不得向画布暴露源脚本正文');
    }
  } finally {
    if (previousPython === undefined) delete process.env.LAVANS_PYTHON_EXECUTABLE;
    else process.env.LAVANS_PYTHON_EXECUTABLE = previousPython;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
