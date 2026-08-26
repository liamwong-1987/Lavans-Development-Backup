const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
  loadAgentSkillRegistry,
  findAgentSkill,
  findAgentSkillRuntime
} = require('../services/agentSkillRegistry');
const { createAgentSkillImportService } = require('../services/agentSkillImportService');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-agent-skill-registry-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function importedAdapter(id, sourcePath, integrity, overrides = {}) {
  return {
    schemaVersion: '1.0',
    id,
    legacyIds: [],
    displayName: `Imported ${id}`,
    description: 'Local instruction skill',
    status: 'ready',
    source: { kind: 'local-folder', path: sourcePath, entry: 'SKILL.md', readOnly: true },
    defaults: {},
    inputSchema: { type: 'object' },
    materialPolicy: {},
    dependencies: [],
    stages: [{
      id: 'skill-chat', order: 1, title: 'Skill chat', canvasStage: 'Skill chat',
      executor: { kind: 'local-script', ref: 'scripts/run.js' }, readiness: 'ready',
      costClass: 'potentially-paid', approvalRequired: true, outputArtifacts: []
    }],
    runtimeContract: { executable: true },
    capabilities: { instructionOnly: false, executable: true },
    trust: { kind: 'verified-trusted', signed: true, verified: true },
    integrity,
    blockers: [],
    ui: { title: `Imported ${id}`, badge: 'local' },
    ...overrides
  };
}

function createImported(storeRoot, id, overrides = {}) {
  const content = overrides.content || `---\nname: ${id}\n---\n# ${id}\n`;
  const initialEntry = { path: 'SKILL.md', size: Buffer.byteLength(content), sha256: sha256(content) };
  const contentHash = sha256(stableStringify([initialEntry]));
  const packagePath = path.join(storeRoot, 'packages', id, contentHash);
  const sourcePath = path.join(packagePath, 'payload');
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.writeFileSync(path.join(sourcePath, 'SKILL.md'), content, 'utf8');
  const descriptor = {
    schemaVersion: '1.0', id, contentHash,
    files: [initialEntry]
  };
  const packageHash = sha256(stableStringify(descriptor));
  fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ ...descriptor, packageHash }, null, 2), 'utf8');
  const integrity = { algorithm: 'sha256', contentHash, packageHash };
  const adapter = importedAdapter(id, sourcePath, integrity, overrides.adapter || {});
  const adaptersRoot = path.join(storeRoot, 'adapters');
  const registrationsRoot = path.join(storeRoot, 'registrations');
  fs.mkdirSync(adaptersRoot, { recursive: true });
  fs.mkdirSync(registrationsRoot, { recursive: true });
  const adapterPath = path.join(adaptersRoot, `${id}.adapter.json`);
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2), 'utf8');
  const registration = {
    schemaVersion: '1.0', id, contentHash, packageHash, integrity,
    signatureStatus: 'unsigned-local', executionStatus: 'adapter-required',
    trust: { kind: 'unsigned-local', signed: false, verified: false },
    source: adapter.source, adapterPath, packagePath, adapter
  };
  const registrationPath = path.join(registrationsRoot, `${id}.json`);
  fs.writeFileSync(registrationPath, JSON.stringify(registration, null, 2), 'utf8');
  return { storeRoot, id, contentHash, packageHash, packagePath, sourcePath, adapterPath, registrationPath };
}

test('无参 Registry 与 bundled 旧别名保持兼容', () => {
  const registry = loadAgentSkillRegistry();
  assert.equal(registry.errors.length, 0);
  for (const id of ['create-product-microstory-seedance', 'ecommerce-video-director-skill', 'brainstorming-obra-share']) {
    assert(registry.skills.some(skill => skill.id === id), `缺少内置 Skill：${id}`);
    const runtime = findAgentSkillRuntime(id)?.runtime;
    assert(runtime);
    assert.equal(fs.existsSync(runtime.entryPath), true);
    assert.equal(runtime.sourcePath.startsWith(path.join(__dirname, '..', 'agent-skills', 'bundled') + path.sep), true);
  }
  assert.equal(findAgentSkill('pixar-video-ad')?.skill?.id, 'create-product-microstory-seedance');
});

test('bundled 与 imported 合并，registration/adapter 重复登记只显示一次', () => {
  const storeRoot = path.join(tempRoot, 'merge-store');
  const fixture = createImported(storeRoot, 'local-story-skill');
  const options = { additionalRoots: [storeRoot, path.join(storeRoot, 'adapters'), path.join(storeRoot, 'registrations')] };
  const registry = loadAgentSkillRegistry(options);
  assert.equal(registry.skills.filter(skill => skill.id === fixture.id).length, 1);
  const skill = findAgentSkill(fixture.id, options).skill;
  assert.equal(skill.source.available, true);
  assert.equal(skill.signatureStatus, 'unsigned-local');
  assert.equal(skill.executionStatus, 'instruction-only');
  assert.equal(skill.trust.signed, false);
  assert.equal(skill.trust.verified, false);
  assert.equal(skill.capabilities.instructionOnly, true);
  assert.equal(skill.capabilities.executable, false);
  assert.equal(skill.integrity.status, 'verified');
  assert.equal(JSON.stringify(skill).includes(storeRoot), false, '公共 DTO 不得泄露本机绝对路径');
  const runtime = findAgentSkillRuntime(fixture.id, options).runtime;
  assert(runtime);
  assert.equal(runtime.adapter.stages[0].readiness, 'adapter-required');
  assert.equal(runtime.adapter.stages[0].costClass, 'free');
  assert.equal(runtime.adapter.stages[0].executor.kind, 'skill');
});

test('真实 import service 输出可被 Registry 校验并读取', () => {
  const outputRoot = path.join(tempRoot, 'service-integration-output');
  const service = createAgentSkillImportService({ outputRoot, makeId: () => 'registry-integration-preview', now: () => new Date('2026-08-24T00:00:00.000Z') });
  const preview = service.preview({ files: [{ originalname: 'SKILL.md', buffer: Buffer.from('---\nname: Registry Integration\ndescription: imported service fixture\n---\n# Registry Integration\n', 'utf8') }] });
  const confirmed = service.confirm({ importId: preview.importId, previewHash: preview.previewHash, skillId: 'registry-integration-skill', confirm: true });
  const storeRoot = path.join(outputRoot, '.state', 'canvas-agent-skills');
  const registry = loadAgentSkillRegistry({ additionalRoots: [storeRoot] });
  const skill = registry.skills.find(item => item.id === 'registry-integration-skill');
  assert(skill);
  assert.equal(skill.integrity.contentHash, confirmed.registration.contentHash);
  assert.equal(skill.integrity.packageHash, confirmed.registration.packageHash);
  assert.equal(skill.integrity.status, 'verified');
  assert(findAgentSkillRuntime(skill.id, { additionalRoots: [storeRoot] }).runtime);
});

test('bundled id/legacyId 永远优先，imported 的 id 与别名冲突均被隔离', () => {
  const storeRoot = path.join(tempRoot, 'conflict-store');
  createImported(storeRoot, 'create-product-microstory-seedance');
  createImported(storeRoot, 'alias-conflict-skill', { adapter: { legacyIds: ['pixar-video-ad'] } });
  createImported(storeRoot, 'pixar-video-ad');
  createImported(storeRoot, 'imported-alpha', { adapter: { legacyIds: ['shared-imported-alias'] } });
  createImported(storeRoot, 'shared-imported-alias');
  const registry = loadAgentSkillRegistry({ additionalRoots: [storeRoot] });
  assert.equal(registry.skills.filter(skill => skill.id === 'create-product-microstory-seedance').length, 1);
  assert.equal(registry.skills.some(skill => skill.id === 'alias-conflict-skill'), false);
  assert.equal(registry.skills.some(skill => skill.id === 'pixar-video-ad'), false);
  assert.equal(registry.skills.some(skill => skill.id === 'shared-imported-alias'), false);
  assert.equal(registry.skills.some(skill => skill.id === 'imported-alpha'), true);
  assert(registry.errors.filter(item => item.error.includes('冲突')).length >= 3);
});

test('坏 imported 不阻断 bundled，错误不泄露绝对路径', () => {
  const storeRoot = path.join(tempRoot, 'bad-store');
  const registrationsRoot = path.join(storeRoot, 'registrations');
  fs.mkdirSync(registrationsRoot, { recursive: true });
  fs.writeFileSync(path.join(registrationsRoot, 'broken.json'), '{bad json', 'utf8');
  const malformed = createImported(storeRoot, 'malformed-integrity-skill');
  const malformedRegistration = JSON.parse(fs.readFileSync(malformed.registrationPath, 'utf8'));
  malformedRegistration.integrity.contentHash = 'not-a-hash';
  fs.writeFileSync(malformed.registrationPath, JSON.stringify(malformedRegistration, null, 2), 'utf8');
  const registry = loadAgentSkillRegistry({ additionalRoots: [storeRoot] });
  assert(registry.skills.some(skill => skill.id === 'create-product-microstory-seedance'));
  assert(registry.errors.some(item => item.file.endsWith('broken.json')));
  assert(registry.errors.some(item => item.error.includes('contentHash 格式无效')));
  assert.equal(JSON.stringify(registry.errors).includes(tempRoot), false);
});

test('只有 packageHash 而没有 contentHash 时拒绝 runtime', () => {
  const storeRoot = path.join(tempRoot, 'package-only-store');
  const fixture = createImported(storeRoot, 'package-only-skill');
  const packageJsonPath = path.join(fixture.packagePath, 'package.json');
  const descriptor = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  delete descriptor.packageHash;
  delete descriptor.contentHash;
  delete descriptor.files;
  const packageHash = sha256(stableStringify(descriptor));
  fs.writeFileSync(packageJsonPath, JSON.stringify({ ...descriptor, packageHash }, null, 2), 'utf8');
  for (const manifestPath of [fixture.registrationPath, fixture.adapterPath]) {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const adapter = value.adapter || value;
    delete adapter.integrity.contentHash;
    adapter.integrity.packageHash = packageHash;
    if (value.adapter) {
      delete value.contentHash;
      value.packageHash = packageHash;
      value.integrity = { algorithm: 'sha256', packageHash };
    }
    fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2), 'utf8');
  }
  const result = findAgentSkillRuntime(fixture.id, { additionalRoots: [storeRoot] });
  assert.equal(result.runtime, null);
  assert(result.errors.some(item => item.error.includes('缺少 contentHash')));
});

test('公共 imported DTO 递归移除嵌套绝对路径', () => {
  const storeRoot = path.join(tempRoot, 'public-path-store');
  const fixture = createImported(storeRoot, 'public-path-skill', { adapter: {
    defaults: { localPath: 'C:\\private\\defaults.json' },
    inputSchema: { nested: { location: '\\\\server\\private\\schema.json' } },
    ui: { title: 'Safe title', debug: { source: 'D:\\secret\\SKILL.md' } }
  } });
  const skill = findAgentSkill(fixture.id, { additionalRoots: [storeRoot] }).skill;
  assert(skill);
  assert.equal(skill.defaults.localPath, '');
  assert.equal(skill.inputSchema.nested.location, '');
  assert.equal(skill.ui.debug.source, '');
  assert.equal(JSON.stringify(skill).includes('D:\\secret'), false);
});

test('坏的同 id 记录不占位，且相同 hash 的不同包路径仍按冲突处理', () => {
  const badStore = path.join(tempRoot, 'duplicate-bad-store');
  const goodStore = path.join(tempRoot, 'duplicate-good-store');
  const bad = createImported(badStore, 'duplicate-local-skill');
  const good = createImported(goodStore, 'duplicate-local-skill');
  fs.appendFileSync(path.join(bad.sourcePath, 'SKILL.md'), '\ndrifted', 'utf8');
  const recovered = loadAgentSkillRegistry({ additionalRoots: [badStore, goodStore] });
  assert.equal(recovered.skills.filter(skill => skill.id === good.id).length, 1);
  const runtime = findAgentSkillRuntime(good.id, { additionalRoots: [badStore, goodStore] }).runtime;
  assert(runtime);
  assert.equal(path.resolve(runtime.sourcePath), path.resolve(good.sourcePath));

  const firstStore = path.join(tempRoot, 'duplicate-first-store');
  const secondStore = path.join(tempRoot, 'duplicate-second-store');
  createImported(firstStore, 'same-hash-different-path');
  createImported(secondStore, 'same-hash-different-path');
  const conflict = loadAgentSkillRegistry({ additionalRoots: [firstStore, secondStore] });
  assert.equal(conflict.skills.filter(skill => skill.id === 'same-hash-different-path').length, 1);
  assert(conflict.errors.some(item => item.error.includes('冲突')));
});

test('integrity.algorithm 不是 sha256 时失败关闭', () => {
  const storeRoot = path.join(tempRoot, 'algorithm-store');
  const fixture = createImported(storeRoot, 'algorithm-mismatch-skill');
  for (const manifestPath of [fixture.registrationPath, fixture.adapterPath]) {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    value.integrity.algorithm = 'sha512';
    if (value.adapter) value.adapter.integrity.algorithm = 'sha512';
    fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2), 'utf8');
  }
  const result = findAgentSkillRuntime(fixture.id, { additionalRoots: [storeRoot] });
  assert.equal(result.runtime, null);
  assert(result.errors.some(item => item.error.includes('algorithm 必须为 sha256')));
});

test('imported runtime 拒绝源目录越界', () => {
  const storeRoot = path.join(tempRoot, 'outside-store');
  const fixture = createImported(storeRoot, 'outside-source-skill');
  const outsideRoot = path.join(tempRoot, 'outside-payload');
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, 'SKILL.md'), '# outside', 'utf8');
  const registration = JSON.parse(fs.readFileSync(fixture.registrationPath, 'utf8'));
  registration.adapter.source.path = outsideRoot;
  fs.writeFileSync(fixture.registrationPath, JSON.stringify(registration, null, 2), 'utf8');
  const result = findAgentSkillRuntime(fixture.id, { additionalRoots: [path.join(storeRoot, 'registrations')] });
  assert.equal(result.runtime, null);
  assert(result.errors.some(item => item.error.includes('超出独立存储目录')));
});

test('imported 内容或 package 清单漂移后不再加载 runtime', () => {
  const storeRoot = path.join(tempRoot, 'drift-store');
  const fixture = createImported(storeRoot, 'drifted-local-skill');
  const options = { additionalRoots: [storeRoot] };
  assert(findAgentSkillRuntime(fixture.id, options).runtime);
  fs.appendFileSync(path.join(fixture.sourcePath, 'SKILL.md'), '\nchanged', 'utf8');
  const drifted = findAgentSkillRuntime(fixture.id, options);
  assert.equal(drifted.runtime, null);
  assert(drifted.errors.some(item => /完整性|漂移/.test(item.error)));

  const packageStore = path.join(tempRoot, 'package-drift-store');
  const packageFixture = createImported(packageStore, 'package-drift-skill');
  const descriptor = JSON.parse(fs.readFileSync(path.join(packageFixture.packagePath, 'package.json'), 'utf8'));
  descriptor.registeredAt = 'changed';
  fs.writeFileSync(path.join(packageFixture.packagePath, 'package.json'), JSON.stringify(descriptor, null, 2), 'utf8');
  const packageDrifted = findAgentSkillRuntime(packageFixture.id, { additionalRoots: [packageStore] });
  assert.equal(packageDrifted.runtime, null);
  assert(packageDrifted.errors.some(item => item.error.includes('包清单完整性')));
});

test('imported runtime 拒绝 symlink/Junction/reparse 路径', t => {
  const storeRoot = path.join(tempRoot, 'link-store');
  const fixture = createImported(storeRoot, 'linked-local-skill');
  const outsideRoot = path.join(tempRoot, 'linked-outside');
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, 'SKILL.md'), '# linked outside', 'utf8');
  const entryPath = path.join(fixture.sourcePath, 'SKILL.md');
  fs.rmSync(entryPath);
  try {
    fs.symlinkSync(path.join(outsideRoot, 'SKILL.md'), entryPath, 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('当前 Windows 环境不允许创建测试链接');
    throw error;
  }
  const result = findAgentSkillRuntime(fixture.id, { additionalRoots: [storeRoot] });
  assert.equal(result.runtime, null);
  assert(result.errors.some(item => /链接|Junction/.test(item.error)));
});

test('imported runtime 拒绝作为 source.path 的 Junction', t => {
  const storeRoot = path.join(tempRoot, 'junction-store');
  const fixture = createImported(storeRoot, 'junction-source-skill');
  const junctionPath = path.join(fixture.packagePath, 'payload-junction');
  try {
    fs.symlinkSync(fixture.sourcePath, junctionPath, 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('当前 Windows 环境不允许创建 Junction');
    throw error;
  }
  for (const manifestPath of [fixture.registrationPath, fixture.adapterPath]) {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (value.adapter) value.adapter.source.path = junctionPath;
    else value.source.path = junctionPath;
    fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2), 'utf8');
  }
  const result = findAgentSkillRuntime(fixture.id, { additionalRoots: [storeRoot] });
  assert.equal(result.runtime, null);
  assert(result.errors.some(item => /链接|Junction/.test(item.error)));
});
