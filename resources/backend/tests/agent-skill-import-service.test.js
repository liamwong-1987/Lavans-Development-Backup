const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAgentSkillImportService } = require('../services/agentSkillImportService');

function fixture(t, options = {}) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-agent-skill-import-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  let id = 0;
  const service = createAgentSkillImportService({
    outputRoot,
    now: () => '2026-08-24T12:00:00.000Z',
    makeId: () => `import-test-${++id}`,
    ...options
  });
  return { outputRoot, service };
}

function uploaded(relativePath, content) {
  return { originalname: path.posix.basename(relativePath), relativePath, buffer: Buffer.from(content, 'utf8') };
}

function skill(name = 'demo-skill', extra = '') {
  return `---\nname: ${name}\ndescription: 本地测试 Skill\nversion: 1.2.3\npublisher: Test Studio\n---\n# ${name}\n${extra}\n`;
}

function storeRoot(outputRoot) {
  return path.join(outputRoot, '.state', 'canvas-agent-skills');
}

function allFiles(root) {
  const found = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(absolute);
    }
  }
  walk(root);
  return found;
}

function hasCode(code, statusCode) {
  return error => error?.code === code && (statusCode === undefined || error?.statusCode === statusCode);
}

test('单个 SKILL.md 可预览并确认成不可变 unsigned-local 指令包', t => {
  const { outputRoot, service } = fixture(t);
  const preview = service.preview({ files: [uploaded('SKILL.md', skill())] });
  assert.match(preview.importId, /^import-test-/);
  assert.match(preview.previewHash, /^[a-f0-9]{64}$/);
  assert.match(preview.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.name, 'demo-skill');
  assert.equal(preview.fileCount, 1);
  assert.equal(preview.signatureStatus, 'unsigned-local');
  assert.equal(preview.executionStatus, 'adapter-required');

  const result = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  assert.equal(result.idempotent, false);
  assert.equal(result.registration.id, 'demo-skill');
  assert.equal(result.registration.signatureStatus, 'unsigned-local');
  assert.deepEqual(result.registration.trust, { kind: 'unsigned-local', signed: false, verified: false });
  assert.equal(result.adapter.capabilities.instructionOnly, true);
  assert.equal(result.adapter.capabilities.executable, false);
  assert.equal(result.adapter.stages.length, 1);
  assert.deepEqual(result.adapter.stages[0], {
    id: 'skill-chat',
    order: 1,
    title: 'Skill 对话',
    canvasStage: 'skill-chat',
    summary: '只读取导入的 Skill 指令；执行器绑定后才能运行工具',
    executor: { kind: 'skill', ref: 'unbound' },
    readiness: 'adapter-required',
    costClass: 'free',
    approvalRequired: false,
    outputArtifacts: []
  });
  assert.deepEqual(result.adapter.blockers, ['未绑定执行器']);
  assert.ok(result.registration.source.path.startsWith(storeRoot(outputRoot) + path.sep));
  assert.equal(result.registration.source.entry, 'SKILL.md');
  assert.equal(fs.readFileSync(path.join(result.package.path, 'payload', 'SKILL.md'), 'utf8'), skill());
});

test('完整 Skill 编辑字段随不可变包保存并在公开 UI 元数据中恢复', t => {
  const { service } = fixture(t);
  const markdown = `---\nname: complete-editor-skill\ndescription: 完整编辑页测试\nusage_scenario: \"剧情广告\\n商品短片\"\nhow_to_use: \"输入产品、时长和画幅\"\noutput_content: \"脚本、分镜与视频节点\"\nskill_type: \"video\"\n---\n# 完整编辑页\n`;
  const preview = service.preview({ files: [uploaded('SKILL.md', markdown)] });
  assert.equal(preview.usageScenario, '剧情广告\n商品短片');
  assert.equal(preview.howToUse, '输入产品、时长和画幅');
  assert.equal(preview.outputContent, '脚本、分镜与视频节点');
  assert.equal(preview.skillType, 'video');
  const result = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  assert.equal(result.adapter.ui.usageScenario, preview.usageScenario);
  assert.equal(result.adapter.ui.howToUse, preview.howToUse);
  assert.equal(result.adapter.ui.outputContent, preview.outputContent);
  assert.equal(result.adapter.ui.skillType, 'video');
  assert.equal(fs.readFileSync(path.join(result.package.path, 'payload', 'SKILL.md'), 'utf8'), markdown);
});

test('文件夹导入去掉上传顶层目录并保留 UTF-8 资源', t => {
  const { service } = fixture(t);
  const files = [
    uploaded('my-skill/SKILL.md', skill('folder-skill')),
    uploaded('my-skill/references/notes.md', '# 参考\n只读资料'),
    uploaded('my-skill/assets/config.json', '{"enabled":false}')
  ];
  const preview = service.preview({ files, relativePaths: files.map(file => file.relativePath) });
  assert.equal(preview.fileCount, 3);
  const result = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  assert.equal(fs.existsSync(path.join(result.package.path, 'payload', 'my-skill')), false);
  assert.equal(fs.readFileSync(path.join(result.package.path, 'payload', 'references', 'notes.md'), 'utf8'), '# 参考\n只读资料');
});

test('preview 只创建随机 incoming，不登记 adapter、registration 或 package', t => {
  const { outputRoot, service } = fixture(t);
  const preview = service.preview({ files: [uploaded('SKILL.md', skill())] });
  const root = storeRoot(outputRoot);
  assert.equal(fs.existsSync(path.join(root, 'incoming', preview.importId, 'payload', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'adapters')), false);
  assert.equal(fs.existsSync(path.join(root, 'registrations')), false);
  assert.equal(fs.existsSync(path.join(root, 'packages')), false);
});

test('相同 id 与 contentHash 重复确认幂等且不覆盖登记时间', t => {
  const { service } = fixture(t);
  const preview = service.preview({ files: [uploaded('SKILL.md', skill())] });
  const first = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  const second = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  assert.equal(second.idempotent, true);
  assert.equal(second.registration.registeredAt, first.registration.registeredAt);
  assert.equal(second.registration.contentHash, first.registration.contentHash);
  assert.equal(second.registration.packageHash, first.registration.packageHash);
});

test('相同 id 的不同内容返回 409 且绝不覆盖', t => {
  const { outputRoot, service } = fixture(t);
  const firstPreview = service.preview({ files: [uploaded('SKILL.md', skill('same-skill', '第一版'))] });
  const first = service.confirm({ importId: firstPreview.importId, previewHash: firstPreview.previewHash, confirm: true });
  const registrationPath = path.join(storeRoot(outputRoot), 'registrations', 'same-skill.json');
  const before = fs.readFileSync(registrationPath);
  const secondPreview = service.preview({ files: [uploaded('SKILL.md', skill('same-skill', '第二版'))] });
  assert.ok(secondPreview.conflicts.some(conflict => conflict.code === 'SKILL_ID_CONFLICT'));
  assert.throws(
    () => service.confirm({ importId: secondPreview.importId, previewHash: secondPreview.previewHash, confirm: true }),
    hasCode('SKILL_ID_CONFLICT', 409)
  );
  assert.deepEqual(fs.readFileSync(registrationPath), before);
  assert.equal(JSON.parse(before).contentHash, first.registration.contentHash);
});

test('确认必须明确授权且 reserved 内置 id 失败关闭', t => {
  const { service } = fixture(t, { reservedIds: new Set(['reserved-skill']) });
  const preview = service.preview({ files: [uploaded('SKILL.md', skill('reserved-skill'))] });
  assert.ok(preview.conflicts.some(conflict => conflict.code === 'SKILL_ID_RESERVED'));
  assert.throws(
    () => service.confirm({ importId: preview.importId, previewHash: preview.previewHash }),
    hasCode('SKILL_IMPORT_CONFIRMATION_REQUIRED', 400)
  );
  assert.throws(
    () => service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true }),
    hasCode('SKILL_ID_RESERVED', 409)
  );
});

test('拒绝路径穿越、盘符、UNC、ADS、设备名、尾点空格和过深路径', async t => {
  const attacks = [
    '../SKILL.md',
    'C:/SKILL.md',
    '\\\\server\\share\\SKILL.md',
    '/SKILL.md',
    'folder/file.txt:stream',
    'CON/readme.md',
    'folder./SKILL.md',
    `a/b/c/d/e/f/g/h/i/j/k/l/m/SKILL.md`
  ];
  for (const relativePath of attacks) {
    await t.test(relativePath.replaceAll('\\', '_'), subtest => {
      const { service } = fixture(subtest);
      assert.throws(
        () => service.preview({ files: [uploaded(relativePath, skill())], relativePaths: [relativePath] }),
        error => error?.statusCode === 400 || error?.statusCode === 413
      );
    });
  }
});

test('拒绝缺少、多个根 SKILL.md 和大小写路径冲突', async t => {
  await t.test('missing', subtest => {
    const { service } = fixture(subtest);
    assert.throws(() => service.preview({ files: [uploaded('README.md', '# no skill')] }), hasCode('SKILL_IMPORT_ENTRY_INVALID', 400));
  });
  await t.test('multiple', subtest => {
    const { service } = fixture(subtest);
    assert.throws(() => service.preview({ files: [
      uploaded('SKILL.md', skill()),
      uploaded('nested/SKILL.md', skill('nested-skill'))
    ] }), hasCode('SKILL_IMPORT_ENTRY_INVALID', 400));
  });
  await t.test('case conflict', subtest => {
    const { service } = fixture(subtest);
    assert.throws(() => service.preview({ files: [
      uploaded('SKILL.md', skill()),
      uploaded('Refs/Guide.md', 'A'),
      uploaded('refs/guide.md', 'B')
    ] }), hasCode('SKILL_IMPORT_CASE_CONFLICT', 400));
  });
});

test('严格拒绝非 UTF-8 和超限 SKILL.md', async t => {
  await t.test('invalid utf8', subtest => {
    const { service } = fixture(subtest);
    assert.throws(
      () => service.preview({ files: [{ originalname: 'SKILL.md', buffer: Buffer.from([0xc3, 0x28]) }] }),
      hasCode('SKILL_IMPORT_UTF8_INVALID', 400)
    );
  });
  await t.test('oversized entry', subtest => {
    const { service } = fixture(subtest);
    const oversized = Buffer.alloc(512 * 1024 + 1, 0x61);
    assert.throws(
      () => service.preview({ files: [{ originalname: 'SKILL.md', buffer: oversized }] }),
      hasCode('SKILL_IMPORT_LIMIT_EXCEEDED', 413)
    );
  });
});

test('导入脚本仅保存，既不执行也不授予执行能力', t => {
  const { outputRoot, service } = fixture(t);
  const marker = path.join(outputRoot, 'script-was-executed.txt');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`;
  const preview = service.preview({ files: [
    uploaded('scripted/SKILL.md', skill('scripted-skill')),
    uploaded('scripted/scripts/run.js', script)
  ] });
  assert.ok(preview.warnings.some(warning => warning.includes('不会执行')));
  const result = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(path.join(result.package.path, 'payload', 'scripts', 'run.js'), 'utf8'), script);
  assert.equal(result.adapter.runtimeContract.executable, false);
  assert.equal(result.adapter.stages[0].readiness, 'adapter-required');
  assert.equal(result.adapter.stages[0].costClass, 'free');
});

test('所有运行期写入严格限制在 outputRoot/.state/canvas-agent-skills', t => {
  const { outputRoot, service } = fixture(t);
  const siblingSentinel = path.join(path.dirname(outputRoot), `outside-${crypto.randomBytes(8).toString('hex')}.sentinel`);
  t.after(() => { if (fs.existsSync(siblingSentinel)) fs.unlinkSync(siblingSentinel); });
  const preview = service.preview({ files: [uploaded('SKILL.md', skill('scope-skill'))] });
  service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  const root = storeRoot(outputRoot);
  for (const file of allFiles(outputRoot)) assert.ok(file === root || file.startsWith(root + path.sep), file);
  assert.equal(fs.existsSync(path.join(outputRoot, 'resources', 'backend', 'agent-skills')), false);
  assert.equal(fs.existsSync(siblingSentinel), false);
});

test('discard 校验 previewHash 后只删除对应 incoming 暂存', t => {
  const { outputRoot, service } = fixture(t);
  const first = service.preview({ files: [uploaded('SKILL.md', skill('first-skill'))] });
  const second = service.preview({ files: [uploaded('SKILL.md', skill('second-skill'))] });
  assert.throws(
    () => service.discard({ importId: first.importId, previewHash: second.previewHash }),
    hasCode('SKILL_IMPORT_PREVIEW_MISMATCH', 409)
  );
  const result = service.discard({ importId: first.importId, previewHash: first.previewHash });
  assert.equal(result.discarded, true);
  assert.equal(fs.existsSync(path.join(storeRoot(outputRoot), 'incoming', first.importId)), false);
  assert.equal(fs.existsSync(path.join(storeRoot(outputRoot), 'incoming', second.importId)), true);
});

test('自定义图标随 Skill 包持久化并登记为安全相对资源', t => {
  const { service } = fixture(t);
  const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const preview = service.preview({ files: [
    uploaded('custom-icon/SKILL.md', skill('custom-icon-skill')),
    uploaded('custom-icon/icon.png', icon)
  ] });
  const result = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, confirm: true });
  assert.equal(result.adapter.ui.iconAsset, 'icon.png');
  assert.deepEqual(fs.readFileSync(path.join(result.package.path, 'payload', 'icon.png')), icon);
  assert.equal(path.isAbsolute(result.adapter.ui.iconAsset), false);
});
