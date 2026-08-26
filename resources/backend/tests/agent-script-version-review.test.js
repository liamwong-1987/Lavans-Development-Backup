const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  createAgentScriptVersionService,
  normalizeScriptReview,
  hasLockedScript,
  VERSION_STATUSES,
  ATTEMPT_STATUSES
} = require('../services/agentScriptVersionService');
const { createAgentRunService } = require('../services/agentRunService');

function createVersionFixture(finalScript = '# 完整剧本\n\n旧开头：角色拿起产品，冲突发生，最后自然展示产品价值。\n') {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-script-version-'));
  const projectDir = path.join(outputRoot, 'test-project');
  fs.mkdirSync(path.join(projectDir, 'story'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'story', 'final-script.md'), finalScript, 'utf8');
  let storedRun = {
    id: 'agent-run-version-test',
    project: { slug: 'test-project' },
    questionnaireAnswers: {
      productName: '测试产品',
      facts: '净含量 100 克，蓝色纸盒包装',
      prohibitedClaims: '不得宣称治疗效果',
      durationSeconds: '30 秒',
      aspectRatio: '9:16（竖屏）'
    },
    databaseExcerpt: '数据库原句绝密，不得发送',
    apiKey: 'sk-test-key-must-not-send',
    recolorPrivateData: 'RECOLOR_PRIVATE_MUST_NOT_SEND',
    scriptReview: {}
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const service = createAgentScriptVersionService({
    projectRoot: outputRoot,
    loadRun(runId) {
      return runId === storedRun.id ? clone(storedRun) : null;
    },
    saveRun(run) {
      storedRun = clone(run);
      storedRun.scriptReview = normalizeScriptReview(storedRun.scriptReview);
      return clone(storedRun);
    }
  });
  return {
    outputRoot,
    projectDir,
    service,
    getRun: () => clone(storedRun),
    setRun: run => { storedRun = clone(run); },
    cleanup: () => fs.rmSync(outputRoot, { recursive: true, force: true })
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listRelativeFiles(root) {
  const output = [];
  const walk = current => fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(entry => {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile()) output.push(path.relative(root, absolute).replace(/\\/g, '/'));
  });
  walk(root);
  return output;
}

test('normalizes review records to unique ids and allowed statuses', () => {
  const normalized = normalizeScriptReview({
    activeVersionId: 'script-v001',
    approvedVersionId: 'missing-version',
    lockedVersionId: 'script-v001',
    versions: [
      {
        id: 'script-v001',
        number: 1,
        status: 'locked',
        relativePath: 'story/versions/script-v001.md',
        laterAddedUnsafeField: 'must-not-leak'
      },
      { id: 'script-v001', number: 99, status: 'bad-status' },
      { id: 'script-v002', number: 2, status: 'bad-status' }
    ],
    attempts: [
      { id: 'attempt-1', status: 'running', baseVersionId: 'script-v001' },
      { id: 'attempt-1', status: 'completed' },
      { id: 'attempt-2', status: 'bad-status' }
    ],
    unknownTopLevelField: 'must-not-leak'
  });

  assert.equal(normalized.versions.length, 2, 'duplicate version ids must collapse to the first record');
  assert.equal(normalized.versions[0].status, 'locked');
  assert.equal(normalized.versions[1].status, 'awaiting-review', 'invalid version statuses must use a safe review state');
  assert.equal(normalized.attempts.length, 2, 'duplicate attempt ids must collapse to the first record');
  assert.equal(normalized.attempts[0].status, 'running');
  assert.equal(normalized.attempts[1].status, 'failed', 'invalid attempt statuses must not look successful or running');
  assert.equal(normalized.activeVersionId, 'script-v001');
  assert.equal(normalized.lockedVersionId, 'script-v001');
  assert.equal(normalized.approvedVersionId, '', 'references to missing versions must be cleared');
  assert.equal('unknownTopLevelField' in normalized, false);
  assert.equal('laterAddedUnsafeField' in normalized.versions[0], false);
  assert(VERSION_STATUSES.has(normalized.versions[1].status));
  assert(ATTEMPT_STATUSES.has(normalized.attempts[1].status));
});

test('ensureReviewState changes only scriptReview and preserves later-added run fields', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-script-review-boundary-'));
  try {
    const saved = [];
    const service = createAgentScriptVersionService({
      projectRoot: outputRoot,
      saveRun(run) {
        saved.push(run);
        return run;
      }
    });
    const run = {
      id: 'agent-run-1',
      laterAddedCanvasFeature: { enabled: true },
      scriptReview: { versions: [{ id: 'script-v001', number: 1, status: 'locked' }] }
    };

    const review = service.ensureReviewState(run);

    assert.equal(review.versions[0].id, 'script-v001');
    assert.deepEqual(run.laterAddedCanvasFeature, { enabled: true });
    assert.equal(run.scriptReview, review);
    assert.equal(saved.length, 0, 'normalizing in-memory state must not persist before an explicit operation');
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('new agent runs include a normalized empty script review state', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-run-review-state-'));
  try {
    const runService = createAgentRunService({
      outputRoot,
      findAgentSkillRuntime() {
        return {
          runtime: {
            adapter: {
              id: 'test-agent-skill',
              displayName: 'Test Agent Skill',
              ui: { title: 'Test Agent Skill', questionnaireVersion: '1' },
              stages: [{ id: 'microstory', title: '微故事', canvasStage: '微故事' }]
            }
          }
        };
      },
      findAgentDependencyRuntime() {
        return { runtime: null };
      }
    });

    const run = runService.createRun({
      canvasId: 'canvas-1',
      skillId: 'test-agent-skill',
      questionnaireAnswers: { productName: '测试产品' }
    });

    assert.deepEqual(run.scriptReview.versions, []);
    assert.deepEqual(run.scriptReview.attempts, []);
    assert.equal(run.scriptReview.lockedVersionId, '');
    assert.deepEqual(runService.loadRun(run.id).scriptReview, run.scriptReview);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('imports the final script once and never overwrites version one', () => {
  const fixture = createVersionFixture();
  try {
    const first = fixture.service.initializeReview('agent-run-version-test');
    assert.equal(first.scriptReview.versions.length, 1);
    const version = first.scriptReview.versions[0];
    assert.equal(version.id, 'script-v001');
    assert.equal(version.number, 1);
    assert.equal(version.source, 'initial');
    assert.equal(version.status, 'awaiting-review');
    assert.equal(first.scriptReview.activeVersionId, version.id);

    const versionPath = path.join(fixture.projectDir, version.relativePath);
    const metadataPath = path.join(fixture.projectDir, version.metadataPath);
    const originalContent = fs.readFileSync(versionPath, 'utf8');
    const originalHash = sha256File(versionPath);
    assert.equal(version.contentHash, originalHash);
    assert.equal(fs.existsSync(metadataPath), true);

    fs.writeFileSync(
      path.join(fixture.projectDir, 'story', 'final-script.md'),
      '# 被外部改动的源剧本\n\n这段内容绝不能覆盖已经导入的 V1。\n',
      'utf8'
    );
    const second = fixture.service.initializeReview('agent-run-version-test');

    assert.equal(second.scriptReview.versions.length, 1);
    assert.equal(fs.readFileSync(versionPath, 'utf8'), originalContent);
    assert.equal(sha256File(versionPath), originalHash);
    assert.equal(second.scriptReview.versions[0].contentHash, originalHash);
  } finally {
    fixture.cleanup();
  }
});

test('manual revision creates one full immutable child version per operation id', () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    const versionOnePath = path.join(fixture.projectDir, versionOne.relativePath);
    const versionOneContent = fs.readFileSync(versionOnePath, 'utf8');
    const versionOneHash = sha256File(versionOnePath);
    const revisedContent = versionOneContent.replace('旧开头', '新开头');

    const updated = fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: versionOne.id,
      content: revisedContent,
      operationId: 'manual-op-1'
    });

    assert.equal(updated.scriptReview.versions.length, 2);
    const versionTwo = updated.scriptReview.versions[1];
    assert.equal(versionTwo.id, 'script-v002');
    assert.equal(versionTwo.number, 2);
    assert.equal(versionTwo.parentVersionId, versionOne.id);
    assert.equal(versionTwo.source, 'manual');
    assert.equal(versionTwo.status, 'awaiting-review');
    assert.equal(versionTwo.operationId, 'manual-op-1');
    assert.equal(updated.scriptReview.activeVersionId, versionTwo.id);
    assert.equal(fs.readFileSync(versionOnePath, 'utf8'), versionOneContent);
    assert.equal(sha256File(versionOnePath), versionOneHash);

    const versionTwoPath = path.join(fixture.projectDir, versionTwo.relativePath);
    const versionTwoMetadataPath = path.join(fixture.projectDir, versionTwo.metadataPath);
    assert.equal(fs.readFileSync(versionTwoPath, 'utf8'), revisedContent);
    assert.equal(versionTwo.contentHash, sha256File(versionTwoPath));
    assert.equal(JSON.parse(fs.readFileSync(versionTwoMetadataPath, 'utf8')).contentHash, versionTwo.contentHash);

    const repeated = fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: versionOne.id,
      content: revisedContent + '\n这次重复请求不得生成 V3。',
      operationId: 'manual-op-1'
    });
    assert.equal(repeated.scriptReview.versions.length, 2);
    assert.equal(repeated.scriptReview.versions[1].contentHash, versionTwo.contentHash);
    assert.equal(fs.readFileSync(versionOnePath, 'utf8'), versionOneContent);
    assert.equal(sha256File(versionOnePath), versionOneHash);
  } finally {
    fixture.cleanup();
  }
});

test('manual revision rejects incomplete content and missing base without creating files', () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    assert.throws(() => fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: versionOne.id,
      content: '太短',
      operationId: 'manual-short'
    }), /内容不完整/);
    assert.throws(() => fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: 'script-v999',
      content: '# 完整剧本\n\n这是长度足够、但基准版本不存在的手动修改内容。\n',
      operationId: 'manual-missing-base'
    }), /基准版本不存在/);
    assert.equal(fixture.getRun().scriptReview.versions.length, 1);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, 'story', 'versions', 'script-v002.md')), false);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, 'story', 'versions', 'script-v002.json')), false);
  } finally {
    fixture.cleanup();
  }
});

test('requires approval before locking and writes one verified lock pointer', () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    const revised = fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: versionOne.id,
      content: '# 完整剧本 V2\n\n新开头：角色先遇到冲突，再自然展示产品，最后完成回扣。\n',
      operationId: 'manual-lock-v2'
    });
    const versionTwo = revised.scriptReview.versions[1];

    assert.throws(
      () => fixture.service.lockVersion('agent-run-version-test', versionTwo.id, {}),
      /先通过/
    );
    const approved = fixture.service.approveVersion('agent-run-version-test', versionTwo.id);
    assert.equal(approved.scriptReview.approvedVersionId, versionTwo.id);
    assert.equal(approved.scriptReview.versions.find(version => version.id === versionTwo.id).status, 'approved');
    const locked = fixture.service.lockVersion('agent-run-version-test', versionTwo.id, {});

    assert.equal(locked.scriptReview.lockedVersionId, versionTwo.id);
    assert.equal(locked.scriptReview.approvedVersionId, '');
    assert.equal(locked.scriptReview.versions.filter(version => version.status === 'locked').length, 1);
    assert.equal(hasLockedScript(locked), true);
    const pointer = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, 'story', 'locked-script.json'), 'utf8'));
    assert.equal(pointer.versionId, versionTwo.id);
    assert.equal(pointer.relativePath, versionTwo.relativePath);
    assert.equal(pointer.contentHash, versionTwo.contentHash);
    assert.equal(typeof pointer.lockedAt, 'number');
  } finally {
    fixture.cleanup();
  }
});

test('replacing a locked version requires exact confirmation and preserves one lock', () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    fixture.service.approveVersion('agent-run-version-test', versionOne.id);
    fixture.service.lockVersion('agent-run-version-test', versionOne.id, {});
    const withVersionTwo = fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: versionOne.id,
      content: '# 完整剧本 V2\n\n替换版本拥有新的冲突、新的对白和新的结尾回扣，内容完整。\n',
      operationId: 'manual-replace-lock'
    });
    const versionTwo = withVersionTwo.scriptReview.versions[1];
    fixture.service.approveVersion('agent-run-version-test', versionTwo.id);

    assert.throws(
      () => fixture.service.lockVersion('agent-run-version-test', versionTwo.id, {}),
      /再次确认/
    );
    assert.throws(
      () => fixture.service.lockVersion('agent-run-version-test', versionTwo.id, {
        confirmed: true,
        replaceLockedVersionId: 'script-v999'
      }),
      /再次确认/
    );
    const replaced = fixture.service.lockVersion('agent-run-version-test', versionTwo.id, {
      confirmed: true,
      replaceLockedVersionId: versionOne.id
    });

    assert.equal(replaced.scriptReview.lockedVersionId, versionTwo.id);
    assert.equal(replaced.scriptReview.versions.filter(version => version.status === 'locked').length, 1);
    assert.equal(replaced.scriptReview.versions.find(version => version.id === versionOne.id).status, 'superseded');
    assert.equal(replaced.scriptReview.versions.find(version => version.id === versionTwo.id).status, 'locked');
    assert.equal(hasLockedScript(replaced), true);
    const pointer = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, 'story', 'locked-script.json'), 'utf8'));
    assert.equal(pointer.versionId, versionTwo.id);
  } finally {
    fixture.cleanup();
  }
});

test('refuses to lock a version whose immutable file hash changed', () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    fixture.service.approveVersion('agent-run-version-test', versionOne.id);
    fs.appendFileSync(path.join(fixture.projectDir, versionOne.relativePath), '\n外部篡改内容', 'utf8');

    assert.throws(
      () => fixture.service.lockVersion('agent-run-version-test', versionOne.id, {}),
      /哈希不一致/
    );
    const run = fixture.getRun();
    assert.equal(hasLockedScript(run), false);
    assert.equal(run.scriptReview.lockedVersionId, '');
    assert.equal(fs.existsSync(path.join(fixture.projectDir, 'story', 'locked-script.json')), false);
  } finally {
    fixture.cleanup();
  }
});

test('computes a local line diff without writing project files', () => {
  const fixture = createVersionFixture('# 完整剧本\n\n旧开头：角色拿起产品并直接介绍卖点。\n');
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    const revised = fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: versionOne.id,
      content: '# 完整剧本\n\n新开头：角色先遇到冲突。\n新增结尾：产品自然完成回扣。\n',
      operationId: 'manual-diff-v2'
    });
    const versionTwo = revised.scriptReview.versions[1];
    const filesBefore = listRelativeFiles(fixture.projectDir);

    const diff = fixture.service.diffVersions('agent-run-version-test', versionOne.id, versionTwo.id);

    assert.equal(diff.leftVersionId, versionOne.id);
    assert.equal(diff.rightVersionId, versionTwo.id);
    assert.equal(diff.addedLines, 2);
    assert.equal(diff.removedLines, 1);
    assert.equal(diff.changedSections, 1);
    assert.deepEqual(diff.rows, [
      { type: 'same', text: '# 完整剧本' },
      { type: 'same', text: '' },
      { type: 'removed', text: '旧开头：角色拿起产品并直接介绍卖点。' },
      { type: 'added', text: '新开头：角色先遇到冲突。' },
      { type: 'added', text: '新增结尾：产品自然完成回扣。' },
      { type: 'same', text: '' }
    ]);
    assert.deepEqual(listRelativeFiles(fixture.projectDir), filesBefore);
  } finally {
    fixture.cleanup();
  }
});

test('reads one immutable version with its full content', () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    const result = fixture.service.getVersion('agent-run-version-test', versionOne.id);
    assert.equal(result.run.id, 'agent-run-version-test');
    assert.equal(result.version.id, versionOne.id);
    assert.equal(result.content, fs.readFileSync(path.join(fixture.projectDir, versionOne.relativePath), 'utf8'));
  } finally {
    fixture.cleanup();
  }
});

test('recovers interrupted revision attempts without changing completed work', () => {
  const fixture = createVersionFixture();
  try {
    const run = fixture.service.initializeReview('agent-run-version-test');
    run.scriptReview.attempts = [
      { id: 'attempt-running', operationId: 'recover-running', baseVersionId: 'script-v001', status: 'running', changeScopes: ['hook'], createdAt: Date.now(), updatedAt: Date.now() },
      { id: 'attempt-complete', operationId: 'recover-complete', baseVersionId: 'script-v001', status: 'completed', resultVersionId: 'script-v001', changeScopes: ['ending'], createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now() }
    ];
    const versionSnapshot = JSON.stringify(run.scriptReview.versions);

    const recovered = fixture.service.recoverInterruptedRevisionAttempts(run);

    assert.equal(recovered.scriptReview.attempts[0].status, 'interrupted');
    assert.match(recovered.scriptReview.attempts[0].error, /服务重启/);
    assert.equal(recovered.scriptReview.attempts[1].status, 'completed');
    assert.equal(JSON.stringify(recovered.scriptReview.versions), versionSnapshot, '已完成版本不得被恢复逻辑改写');
  } finally {
    fixture.cleanup();
  }
});

test('reconciles one complete orphan version and only removes known atomic temp files', () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    const withSecond = fixture.service.createManualVersion('agent-run-version-test', {
      baseVersionId: versionOne.id,
      content: '# 完整剧本 V2\n\n测试产品先遭遇冲突，再用真实功能完成解决并自然收束。\n',
      operationId: 'orphan-v2'
    });
    const orphan = withSecond.scriptReview.versions[1];
    const missingRegistration = fixture.getRun();
    missingRegistration.scriptReview.versions = [missingRegistration.scriptReview.versions[0]];
    missingRegistration.scriptReview.activeVersionId = versionOne.id;
    fixture.setRun(missingRegistration);
    const versionsDir = path.join(fixture.projectDir, 'story', 'versions');
    const knownTemp = path.join(versionsDir, `script-v099.md.tmp-123-${crypto.randomUUID()}`);
    const unrelated = path.join(versionsDir, 'keep-me.tmp-custom');
    const incompleteMetadata = path.join(versionsDir, 'script-v099.json');
    fs.writeFileSync(knownTemp, 'atomic temp', 'utf8');
    fs.writeFileSync(unrelated, 'unrelated', 'utf8');
    fs.writeFileSync(incompleteMetadata, JSON.stringify({ schemaVersion: '1.0', id: 'script-v099', number: 99, relativePath: 'story/versions/script-v099.md', metadataPath: 'story/versions/script-v099.json', contentHash: 'bad' }), 'utf8');

    const reconciled = fixture.service.reconcileVersionFiles(fixture.getRun());

    assert.equal(reconciled.scriptReview.versions.filter(version => version.id === orphan.id).length, 1, '完整孤儿版本只能补登记一次');
    assert.equal(reconciled.scriptReview.activeVersionId, orphan.id);
    assert.equal(fs.existsSync(knownTemp), false, '只清理已知原子写临时文件');
    assert.equal(fs.existsSync(unrelated), true, '未知临时文件不得删除');
    assert.equal(reconciled.scriptReview.versions.some(version => version.id === 'script-v099'), false, '缺少正文或哈希错误的元数据不得登记');
    const secondPass = fixture.service.reconcileVersionFiles(reconciled);
    assert.equal(secondPass.scriptReview.versions.filter(version => version.id === orphan.id).length, 1, '重复对账不得重复登记');
  } finally {
    fixture.cleanup();
  }
});

test('agent run reload automatically persists interrupted attempts and orphan reconciliation', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-review-reload-'));
  try {
    const runService = createAgentRunService({
      outputRoot,
      findAgentSkillRuntime() {
        return { runtime: { adapter: { id: 'reload-skill', displayName: 'Reload Skill', ui: { title: 'Reload Skill', questionnaireVersion: '1' }, stages: [{ id: 'microstory', title: '微故事', canvasStage: '微故事' }] } } };
      },
      findAgentDependencyRuntime() { return { runtime: null }; }
    });
    const created = runService.createRun({ canvasId: 'canvas-reload', skillId: 'reload-skill', questionnaireAnswers: { productName: '测试产品' } });
    const slug = 'reload-project';
    const versionsDir = path.join(runService.roots.projectRoot, slug, 'story', 'versions');
    fs.mkdirSync(versionsDir, { recursive: true });
    const content = '# 服务重启恢复剧本\n\n测试产品在冲突后自然完成解决，并保持所有事实准确。\n';
    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const version = { schemaVersion: '1.0', id: 'script-v001', number: 1, parentVersionId: '', operationId: '', source: 'initial', status: 'awaiting-review', relativePath: 'story/versions/script-v001.md', metadataPath: 'story/versions/script-v001.json', contentHash: hash, changeScopes: [], providerId: '', model: '', createdAt: Date.now(), approvedAt: null, lockedAt: null };
    fs.writeFileSync(path.join(versionsDir, 'script-v001.md'), content, 'utf8');
    fs.writeFileSync(path.join(versionsDir, 'script-v001.json'), JSON.stringify(version), 'utf8');
    const runFile = path.join(runService.roots.stateRoot, `${created.id}.json`);
    const stored = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    stored.project = { name: 'Reload project', slug, url: '' };
    stored.scriptReview = { versions: [], attempts: [{ id: 'attempt-reload', operationId: 'reload-operation', baseVersionId: 'script-v001', status: 'running', changeScopes: ['hook'], createdAt: Date.now(), updatedAt: Date.now() }] };
    fs.writeFileSync(runFile, JSON.stringify(stored), 'utf8');

    const recovered = runService.loadRun(created.id);
    assert.equal(recovered.scriptReview.versions[0].id, 'script-v001');
    assert.equal(recovered.scriptReview.attempts[0].status, 'interrupted');
    const eventCount = recovered.events.length;
    const loadedAgain = runService.loadRun(created.id);
    assert.equal(loadedAgain.events.length, eventCount, '第二次读取不得重复写恢复事件');
    assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).scriptReview.attempts[0].status, 'interrupted', '恢复状态必须持久化到 Run JSON');
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('accepts custom revision text only when other scope is selected', async () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    await assert.rejects(() => fixture.service.startAiRevision('agent-run-version-test', {
      baseVersionId: versionOne.id,
      changeScopes: ['hook'],
      customInstruction: '这段自由文字不应被偷偷发送',
      operationId: 'ai-invalid-custom'
    }, {
      providerId: 'test-provider',
      model: 'test-model',
      generateText: async () => ({ text: '不会执行到这里' }),
      runSimilarityCheck: async () => ({ pass: true })
    }), /其他修改/);
    assert.equal(fixture.getRun().scriptReview.attempts.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('AI revision failures and cancellation keep existing versions unchanged', async () => {
  const cases = [
    {
      operationId: 'ai-throws',
      generateText: async () => { throw new Error('受控生成器失败'); },
      runSimilarityCheck: async () => ({ pass: true }),
      expectedStatus: 'failed'
    },
    {
      operationId: 'ai-empty',
      generateText: async () => ({ text: '' }),
      runSimilarityCheck: async () => ({ pass: true }),
      expectedStatus: 'failed'
    },
    {
      operationId: 'ai-similarity',
      generateText: async () => ({ text: '# AI 完整剧本\n\n测试产品进入新的冲突，并在结尾完成原创回扣。\n' }),
      runSimilarityCheck: async () => ({ pass: false, maxSimilarity: 0.91 }),
      expectedStatus: 'failed'
    }
  ];
  for (const testCase of cases) {
    const fixture = createVersionFixture();
    try {
      const initialized = fixture.service.initializeReview('agent-run-version-test');
      const versionOne = initialized.scriptReview.versions[0];
      const result = await fixture.service.startAiRevision('agent-run-version-test', {
        baseVersionId: versionOne.id,
        changeScopes: ['hook', 'ending'],
        customInstruction: '',
        operationId: testCase.operationId
      }, {
        providerId: 'test-provider',
        model: 'test-model',
        generateText: testCase.generateText,
        runSimilarityCheck: testCase.runSimilarityCheck
      });
      assert.equal(result.scriptReview.versions.length, 1, `${testCase.operationId} 不得生成版本`);
      assert.equal(result.scriptReview.attempts.at(-1).status, testCase.expectedStatus);
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    const pending = fixture.service.startAiRevision('agent-run-version-test', {
      baseVersionId: versionOne.id,
      changeScopes: ['dialogue'],
      customInstruction: '',
      operationId: 'ai-cancelled'
    }, {
      providerId: 'test-provider',
      model: 'test-model',
      generateText: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('用户取消');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
      runSimilarityCheck: async () => ({ pass: true })
    });
    const running = fixture.getRun().scriptReview.attempts.at(-1);
    assert.equal(running.status, 'running');
    fixture.service.cancelRevisionAttempt('agent-run-version-test', running.id);
    const cancelled = await pending;
    assert.equal(cancelled.scriptReview.versions.length, 1);
    assert.equal(cancelled.scriptReview.attempts.at(-1).status, 'cancelled');
  } finally {
    fixture.cleanup();
  }
});

test('successful AI revision sends only approved scope and creates a full child version', async () => {
  const fixture = createVersionFixture();
  try {
    const initialized = fixture.service.initializeReview('agent-run-version-test');
    const versionOne = initialized.scriptReview.versions[0];
    let generatorInput = null;
    const result = await fixture.service.startAiRevision('agent-run-version-test', {
      baseVersionId: versionOne.id,
      changeScopes: ['hook', 'product-placement', 'other'],
      customInstruction: '让前三秒先出现动作，不增加产品功效',
      operationId: 'ai-success-v2'
    }, {
      providerId: 'canvas-provider-a',
      model: 'canvas-model-a',
      generateText: async input => {
        generatorInput = input;
        return { text: '# AI 完整剧本\n\n测试产品在前三秒动作冲突后自然出现，保持净含量 100 克事实，结尾完成原创回扣。\n' };
      },
      runSimilarityCheck: async ({ content }) => ({ pass: content.includes('原创回扣'), maxSimilarity: 0.08 })
    });

    assert(generatorInput);
    assert.equal(generatorInput.providerId, 'canvas-provider-a');
    assert.equal(generatorInput.model, 'canvas-model-a');
    assert.match(generatorInput.userPrompt, /旧开头/);
    assert.match(generatorInput.userPrompt, /测试产品/);
    assert.match(generatorInput.userPrompt, /净含量 100 克/);
    assert.match(generatorInput.userPrompt, /不得宣称治疗效果/);
    assert.match(generatorInput.userPrompt, /让前三秒先出现动作/);
    assert.equal(generatorInput.userPrompt.includes('数据库原句绝密'), false);
    assert.equal(generatorInput.userPrompt.includes('sk-test-key-must-not-send'), false);
    assert.equal(generatorInput.userPrompt.includes('RECOLOR_PRIVATE_MUST_NOT_SEND'), false);

    assert.equal(result.scriptReview.versions.length, 2);
    const versionTwo = result.scriptReview.versions[1];
    assert.equal(versionTwo.parentVersionId, versionOne.id);
    assert.equal(versionTwo.source, 'ai-revision');
    assert.equal(versionTwo.providerId, 'canvas-provider-a');
    assert.equal(versionTwo.model, 'canvas-model-a');
    assert.deepEqual(versionTwo.changeScopes, ['hook', 'product-placement', 'other']);
    assert.equal(result.scriptReview.attempts.at(-1).status, 'completed');
    assert.equal(result.scriptReview.attempts.at(-1).resultVersionId, versionTwo.id);
  } finally {
    fixture.cleanup();
  }
});
