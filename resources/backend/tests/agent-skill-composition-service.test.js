const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAgentSkillImportService } = require('../services/agentSkillImportService');
const { createAgentSkillCompositionService } = require('../services/agentSkillCompositionService');
const { findAgentSkill, findAgentSkillRuntime } = require('../services/agentSkillRegistry');

const DEFAULT_TEMPLATE = path.join(
  __dirname,
  '..',
  'agent-skills',
  'compositions',
  'ecommerce-video-director-brainstorming.composition.json'
);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-skill-composition-'));
  const outputRoot = path.join(root, 'output');
  const templateRoot = path.join(root, 'templates');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(templateRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let importNumber = 0;
  const imports = createAgentSkillImportService({
    outputRoot,
    makeId: () => `composition-import-${++importNumber}`,
    now: () => '2026-08-25T14:30:00.000Z'
  });
  return { root, outputRoot, templateRoot, imports };
}

function upload(relativePath, content) {
  return { originalname: path.posix.basename(relativePath), relativePath, buffer: Buffer.from(content, 'utf8') };
}

function importSkill(imports, { id, version = '1.0.0', files = {}, slug = id }) {
  const markdown = `---\nname: ${id}\nslug: ${slug}\nversion: ${version}\npublisher: local-import\n---\n# ${id}\n`;
  const uploaded = [upload('SKILL.md', markdown), ...Object.entries(files).map(([name, value]) => upload(name, value))];
  const preview = imports.preview({ files: uploaded, relativePaths: uploaded.map(file => file.relativePath) });
  const confirmed = imports.confirm({ importId: preview.importId, previewHash: preview.previewHash, skillId: id, confirm: true });
  return { markdown, preview, confirmed };
}

function registerSkill(outputRoot, { id, version = '1.0.0', files = {} }) {
  const markdown = `---\nname: ${id}\nslug: ${id}\nversion: ${version}\npublisher: local-import\n---\n# ${id}\n`;
  const contents = { 'SKILL.md': markdown, ...files };
  const manifest = Object.entries(contents).map(([name, content]) => ({
    path: name,
    size: Buffer.byteLength(content),
    sha256: sha256(content)
  })).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const contentHash = sha256(stableStringify(manifest));
  const storeRoot = path.join(outputRoot, '.state', 'canvas-agent-skills');
  const packagePath = path.join(storeRoot, 'packages', id, contentHash);
  const sourcePath = path.join(packagePath, 'payload');
  for (const [name, content] of Object.entries(contents)) {
    const filePath = path.join(sourcePath, ...name.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  const descriptor = {
    schemaVersion: '1.0', id, contentHash, files: manifest,
    metadata: { name: id, slug: id, version, publisher: 'local-import' },
    signatureStatus: 'unsigned-local', executionStatus: 'adapter-required',
    trust: { kind: 'unsigned-local', signed: false, verified: false },
    capabilities: { instructionOnly: true, executable: false }
  };
  const packageHash = sha256(stableStringify(descriptor));
  fs.writeFileSync(path.join(packagePath, 'package.json'), `${JSON.stringify({ ...descriptor, packageHash }, null, 2)}\n`, 'utf8');
  const integrity = { algorithm: 'sha256', contentHash, packageHash };
  const adapter = {
    schemaVersion: '1.0', id, displayName: id, description: 'Temporary composition fixture', status: 'partial',
    source: { kind: 'local-folder', path: sourcePath, entry: 'SKILL.md', readOnly: true },
    defaults: {}, inputSchema: { type: 'object' }, materialPolicy: {}, dependencies: [],
    stages: [{
      id: 'skill-chat', order: 1, title: 'Skill chat', canvasStage: 'skill-chat', summary: 'instruction only',
      executor: { kind: 'skill', ref: 'SKILL.md' }, readiness: 'adapter-required', costClass: 'free', approvalRequired: false, outputArtifacts: []
    }],
    runtimeContract: { instructionOnly: true, executable: false },
    capabilities: { chat: true, instructionOnly: true, executable: false },
    blockers: [], integrity, trust: { kind: 'unsigned-local', signed: false, verified: false },
    ui: { version, publisher: 'local-import' }
  };
  const adaptersRoot = path.join(storeRoot, 'adapters');
  const registrationsRoot = path.join(storeRoot, 'registrations');
  fs.mkdirSync(adaptersRoot, { recursive: true });
  fs.mkdirSync(registrationsRoot, { recursive: true });
  const adapterPath = path.join(adaptersRoot, `${id}.adapter.json`);
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf8');
  const registration = {
    schemaVersion: '1.0', id, contentHash, packageHash, integrity,
    signatureStatus: 'unsigned-local', executionStatus: 'adapter-required',
    trust: { kind: 'unsigned-local', signed: false, verified: false },
    source: adapter.source, packagePath, adapterPath, adapter
  };
  fs.writeFileSync(path.join(registrationsRoot, `${id}.json`), `${JSON.stringify(registration, null, 2)}\n`, 'utf8');
  return { markdown, confirmed: { registration, adapter, package: { path: packagePath, contentHash, packageHash } } };
}

function templateFor(primary, dependency, overrides = {}) {
  return {
    schemaVersion: '1.0',
    templateId: 'test-primary-with-brainstorming-v1',
    primaryMatch: {
      id: primary.confirmed.registration.id,
      declaredVersion: '1.7.0',
      contentHash: primary.confirmed.registration.contentHash,
      packageHash: primary.confirmed.registration.packageHash,
      contextFiles: ['SKILL.md', 'references/core.md'],
      runtimeContract: { instructionOnly: true, executable: false }
    },
    dependencies: [{
      id: dependency?.confirmed.registration.id || 'test-brainstorming-skill',
      displayName: '头脑风暴',
      role: 'creative-discovery',
      required: true,
      declaredVersion: '1.0.0',
      entry: 'SKILL.md',
      entrySha256: dependency ? sha256(dependency.markdown) : '0'.repeat(64),
      contextFiles: ['SKILL.md'],
      runtimeContract: { instructionOnly: true, executable: false }
    }],
    promptOrder: ['host-safety', 'dependency:creative-discovery', 'primary'],
    limits: { maxDepth: 2, maxSkills: 4, maxContextBytes: 262144 },
    ...overrides
  };
}

function writeTemplate(templateRoot, value, name = 'test.composition.json') {
  fs.writeFileSync(path.join(templateRoot, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function serviceFor(outputRoot, templateRoot, options = {}) {
  return createAgentSkillCompositionService({
    outputRoot,
    templateRoot,
    now: () => '2026-08-25T14:31:00.000Z',
    ...options
  });
}

function hasCode(code, statusCode = 409) {
  return error => error?.code === code && error?.statusCode === statusCode;
}

test('真实导入优先使用合法 slug，脚本保存但绝不执行', t => {
  const { root, imports } = fixture(t);
  const marker = path.join(root, 'import-script-ran.txt');
  const imported = importSkill(imports, {
    id: 'brainstorming-obra-share',
    files: { 'scripts/do-not-run.js': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` }
  });
  assert.equal(imported.preview.suggestedSkillId, 'brainstorming-obra-share');
  assert.equal(imported.preview.slug, 'brainstorming-obra-share');
  assert.equal(fs.existsSync(path.join(imported.confirmed.package.path, 'payload', 'scripts', 'do-not-run.js')), true);
  assert.equal(fs.existsSync(marker), false);
});

test('默认电商组合模板冻结用户确认的精确身份与安全上限', () => {
  const value = JSON.parse(fs.readFileSync(DEFAULT_TEMPLATE, 'utf8'));
  assert.equal(value.templateId, 'ecommerce-video-director-with-brainstorming-v1');
  assert.equal(value.primaryMatch.id, 'ecommerce-video-director-skill');
  assert.equal(value.primaryMatch.declaredVersion, '1.7.0');
  assert.equal(value.primaryMatch.contentHash, '309a77b6e868809d99831a33e357fe585e67cab1c5284cb9a98abefd48e95f20');
  assert.equal(value.primaryMatch.packageHash, 'e37df59978f40ea94a75f006244d5f30fb77bd04832f1e418c108c23235303f1');
  assert.equal(value.dependencies[0].id, 'brainstorming-obra-share');
  assert.equal(value.dependencies[0].entrySha256, '03f6a3afa3f8f56fa348d31032a58c08cc973335b734e9b1940d5c9626c81b1a');
  assert.deepEqual(value.limits, { maxDepth: 2, maxSkills: 4, maxContextBytes: 262144 });
});

test('默认组合可由仓库内置 Skill 精确解析且仍需显式确认', t => {
  const { outputRoot } = fixture(t);
  const service = serviceFor(outputRoot, path.dirname(DEFAULT_TEMPLATE));
  const before = service.inspect('ecommerce-video-director-skill');
  assert.equal(before.status, 'link-required');
  const confirmed = service.confirm({
    primarySkillId: 'ecommerce-video-director-skill',
    dependencySkillId: 'brainstorming-obra-share',
    requestId: 'confirm-bundled-composition-1',
    confirm: true
  });
  assert.equal(confirmed.idempotent, false);
  assert.equal(confirmed.composition.primary.contentHash, '309a77b6e868809d99831a33e357fe585e67cab1c5284cb9a98abefd48e95f20');
  assert.equal(confirmed.composition.dependencies[0].entrySha256, '03f6a3afa3f8f56fa348d31032a58c08cc973335b734e9b1940d5c9626c81b1a');
  assert.equal(service.inspect('ecommerce-video-director-skill').status, 'ready');
});

test('精确依赖先显示 link-required，确认后原子创建且重放幂等', t => {
  const { root, outputRoot, templateRoot } = fixture(t);
  const marker = path.join(root, 'script-ran.txt');
  const primary = registerSkill(outputRoot, { id: 'test-primary-skill', version: '1.7.0', files: { 'references/core.md': '# core\n' } });
  const dependency = registerSkill(outputRoot, {
    id: 'test-brainstorming-skill',
    files: { 'scripts/do-not-run.js': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` }
  });
  writeTemplate(templateRoot, templateFor(primary, dependency));
  const service = serviceFor(outputRoot, templateRoot);

  const before = service.inspect('test-primary-skill');
  assert.equal(before.status, 'link-required');
  assert.equal(JSON.stringify(before).includes(root), false);

  const input = {
    primarySkillId: 'test-primary-skill',
    dependencySkillId: 'test-brainstorming-skill',
    requestId: 'confirm-test-composition-1',
    confirm: true
  };
  const first = service.confirm(input);
  const second = service.confirm(input);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.composition.compositionHash, first.composition.compositionHash);
  assert.equal(second.composition.confirmation.confirmedAt, first.composition.confirmation.confirmedAt);
  assert.equal(fs.existsSync(marker), false, '保存的 dependency 脚本绝不能执行');
  assert.equal(service.inspect('test-primary-skill').status, 'ready');
  assert.equal(JSON.stringify(service.inspect('test-primary-skill')).includes(root), false);

  const recordPath = path.join(outputRoot, '.state', 'canvas-agent-skills', 'compositions', 'test-primary-skill.composition.json');
  const stored = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(stored.compositionHash, first.composition.compositionHash);
  assert.equal(stored.dependencies[0].entrySha256, sha256(dependency.markdown));
});

test('依赖缺失、身份漂移和 executable 均在关联前确定性失败', async t => {
  await t.test('missing', subtest => {
    const { outputRoot, templateRoot } = fixture(subtest);
    const primary = registerSkill(outputRoot, { id: 'missing-primary', version: '1.7.0', files: { 'references/core.md': '# core\n' } });
    writeTemplate(templateRoot, templateFor(primary, null));
    const service = serviceFor(outputRoot, templateRoot);
    assert.equal(service.inspect('missing-primary').status, 'missing');
    assert.throws(() => service.confirm({ primarySkillId: 'missing-primary', dependencySkillId: 'test-brainstorming-skill', requestId: 'missing-1', confirm: true }), hasCode('AGENT_SKILL_DEPENDENCY_MISSING'));
  });

  await t.test('identity drift', subtest => {
    const { outputRoot, templateRoot } = fixture(subtest);
    const primary = registerSkill(outputRoot, { id: 'drift-primary', version: '1.7.0', files: { 'references/core.md': '# core\n' } });
    const dependency = registerSkill(outputRoot, { id: 'test-brainstorming-skill' });
    const template = templateFor(primary, dependency);
    template.dependencies[0].entrySha256 = 'f'.repeat(64);
    writeTemplate(templateRoot, template);
    const service = serviceFor(outputRoot, templateRoot);
    assert.equal(service.inspect('drift-primary').status, 'drift');
    assert.throws(() => service.confirm({ primarySkillId: 'drift-primary', dependencySkillId: dependency.confirmed.registration.id, requestId: 'drift-1', confirm: true }), hasCode('AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH'));
  });

  await t.test('unsafe executable', subtest => {
    const { outputRoot, templateRoot } = fixture(subtest);
    const primary = registerSkill(outputRoot, { id: 'unsafe-primary', version: '1.7.0', files: { 'references/core.md': '# core\n' } });
    const dependency = registerSkill(outputRoot, { id: 'test-brainstorming-skill' });
    writeTemplate(templateRoot, templateFor(primary, dependency));
    const storeRoot = path.join(outputRoot, '.state', 'canvas-agent-skills');
    const registryOptions = { additionalRoots: [storeRoot] };
    const dependencyPublic = findAgentSkill('test-brainstorming-skill', registryOptions);
    const dependencyRuntime = findAgentSkillRuntime('test-brainstorming-skill', registryOptions);
    const unsafeRuntime = {
      ...dependencyRuntime,
      runtime: {
        ...dependencyRuntime.runtime,
        adapter: {
          ...dependencyRuntime.runtime.adapter,
          runtimeContract: { instructionOnly: false, executable: true },
          capabilities: { instructionOnly: false, executable: true }
        }
      }
    };
    const service = serviceFor(outputRoot, templateRoot, {
      findSkill: (id, options) => id === 'test-brainstorming-skill' ? dependencyPublic : findAgentSkill(id, options),
      findRuntime: (id, options) => id === 'test-brainstorming-skill' ? unsafeRuntime : findAgentSkillRuntime(id, options)
    });
    assert.equal(service.inspect('unsafe-primary').status, 'unsupported');
    assert.throws(() => service.confirm({ primarySkillId: 'unsafe-primary', dependencySkillId: dependency.confirmed.registration.id, requestId: 'unsafe-1', confirm: true }), hasCode('AGENT_SKILL_DEPENDENCY_UNSAFE'));
  });
});

test('已存在的不同组合不能覆盖，模板循环在任何 Registry 读取前失败', async t => {
  await t.test('immutable conflict', subtest => {
    const { outputRoot, templateRoot } = fixture(subtest);
    const primary = registerSkill(outputRoot, { id: 'conflict-primary', version: '1.7.0', files: { 'references/core.md': '# core\n' } });
    const dependency = registerSkill(outputRoot, { id: 'test-brainstorming-skill' });
    const initial = templateFor(primary, dependency);
    writeTemplate(templateRoot, initial);
    const firstService = serviceFor(outputRoot, templateRoot);
    firstService.confirm({ primarySkillId: 'conflict-primary', dependencySkillId: dependency.confirmed.registration.id, requestId: 'conflict-1', confirm: true });

    initial.limits.maxContextBytes = 200000;
    writeTemplate(templateRoot, initial);
    const changedService = serviceFor(outputRoot, templateRoot);
    assert.throws(() => changedService.confirm({ primarySkillId: 'conflict-primary', dependencySkillId: dependency.confirmed.registration.id, requestId: 'conflict-2', confirm: true }), hasCode('AGENT_SKILL_COMPOSITION_CONFLICT'));
  });

  await t.test('cycle', subtest => {
    const { outputRoot, templateRoot } = fixture(subtest);
    const base = {
      schemaVersion: '1.0',
      promptOrder: ['host-safety', 'dependency:creative-discovery', 'primary'],
      limits: { maxDepth: 2, maxSkills: 4, maxContextBytes: 262144 }
    };
    const identity = id => ({ id, declaredVersion: '1.0.0', contentHash: 'a'.repeat(64), packageHash: 'b'.repeat(64), contextFiles: ['SKILL.md'], runtimeContract: { instructionOnly: true, executable: false } });
    const dependency = id => ({ id, displayName: id, role: 'creative-discovery', required: true, declaredVersion: '1.0.0', entry: 'SKILL.md', entrySha256: 'c'.repeat(64), contextFiles: ['SKILL.md'], runtimeContract: { instructionOnly: true, executable: false } });
    writeTemplate(templateRoot, { ...base, templateId: 'cycle-a', primaryMatch: identity('cycle-a-skill'), dependencies: [dependency('cycle-b-skill')] }, 'a.composition.json');
    writeTemplate(templateRoot, { ...base, templateId: 'cycle-b', primaryMatch: identity('cycle-b-skill'), dependencies: [dependency('cycle-a-skill')] }, 'b.composition.json');
    const service = serviceFor(outputRoot, templateRoot);
    assert.throws(() => service.inspect('cycle-a-skill'), hasCode('AGENT_SKILL_DEPENDENCY_CYCLE'));
  });
});
