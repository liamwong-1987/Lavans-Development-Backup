const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..', 'agent-skills');
const ADAPTER_SUFFIX = '.adapter.json';
const STORY_SKILL_REPO_ROOT = path.join(SKILL_ROOT, 'dependencies', 'douyin-tiktok-story-skill');
const STORY_SKILL_ROOT = path.join(STORY_SKILL_REPO_ROOT, 'skill');
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const DEPENDENCY_STATES = new Set(['available', 'missing', 'database-missing', 'deferred', 'host-adapter-required']);
const STAGE_READINESS = new Set(['ready', 'adapter-required', 'blocked']);
const COST_CLASSES = new Set(['free', 'potentially-paid']);
const IMPORTED_FILE_LIMIT = 128;
const IMPORTED_BYTE_LIMIT = 50 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function verifyBundledPackage(adapter) {
  if (!adapter.integrity) return;
  const integrity = adapter.integrity;
  if (integrity.algorithm !== 'sha256') throw new Error('内置 Skill integrity.algorithm 必须为 sha256');
  if (!SHA256_RE.test(String(integrity.contentHash || '')) || !SHA256_RE.test(String(integrity.packageHash || ''))) {
    throw new Error('内置 Skill 完整性摘要格式无效');
  }
  const sourcePath = path.resolve(adapter.source.path);
  const descriptorPath = path.join(sourcePath, 'package.json');
  const descriptor = JSON.parse(safeReadFile(sourcePath, descriptorPath, 2 * 1024 * 1024).toString('utf8'));
  if (descriptor.id !== adapter.id || !Array.isArray(descriptor.files) || descriptor.files.length > IMPORTED_FILE_LIMIT) {
    throw new Error('内置 Skill 包清单无效');
  }
  const packageHash = String(descriptor.packageHash || '').toLowerCase();
  const hashValue = { ...descriptor };
  delete hashValue.packageHash;
  if (packageHash !== String(integrity.packageHash).toLowerCase() || sha256(stableStringify(hashValue)) !== packageHash) {
    throw new Error('内置 Skill 包清单完整性校验失败');
  }
  const contentHash = sha256(stableStringify(descriptor.files));
  if (contentHash !== String(integrity.contentHash).toLowerCase() || contentHash !== String(descriptor.contentHash || '').toLowerCase()) {
    throw new Error('内置 Skill 内容清单完整性校验失败');
  }
  let totalBytes = 0;
  for (const file of descriptor.files) {
    const relative = String(file?.path || '');
    if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('内置 Skill 文件路径无效');
    }
    const value = safeReadFile(sourcePath, path.join(sourcePath, ...relative.split('/')));
    totalBytes += value.length;
    if (value.length !== Number(file.size) || sha256(value) !== String(file.sha256 || '').toLowerCase()) {
      throw new Error('内置 Skill 文件完整性校验失败');
    }
  }
  if (totalBytes > IMPORTED_BYTE_LIMIT || !descriptor.files.some(file => file.path === adapter.source.entry)) {
    throw new Error('内置 Skill 文件数量、大小或入口无效');
  }
  adapter.integrity = {
    algorithm: 'sha256',
    contentHash,
    packageHash,
    status: 'verified'
  };
}

function inside(rootPath, targetPath, allowSame = true) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return (allowSame || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function registryOptions(options) {
  if (Array.isArray(options)) return { additionalRoots: options };
  return options && typeof options === 'object' ? options : {};
}

function importedRootDescriptor(value) {
  const rawPath = typeof value === 'string' ? value : value?.path;
  if (!text(rawPath, 4000)) throw new Error('附加 Skill 根目录不能为空');
  const rootPath = path.resolve(String(rawPath));
  const basePath = fs.existsSync(rootPath) && fs.lstatSync(rootPath).isFile() ? path.dirname(rootPath) : rootPath;
  const baseName = path.basename(basePath).toLowerCase();
  const anchorPath = baseName === 'adapters' || baseName === 'registrations' ? path.dirname(basePath) : basePath;
  return { rootPath, anchorPath };
}

function assertNoLinkPath(anchorPath, targetPath, expectedType = '') {
  const anchor = path.resolve(anchorPath);
  const target = path.resolve(targetPath);
  if (!inside(anchor, target)) throw new Error('导入 Skill 路径超出独立存储目录');
  if (!fs.existsSync(anchor) || !fs.existsSync(target)) throw new Error('导入 Skill 路径不存在');
  const anchorStat = fs.lstatSync(anchor);
  if (anchorStat.isSymbolicLink()) throw new Error('导入 Skill 存储目录不能是链接或 Junction');
  const relative = path.relative(anchor, target);
  let cursor = anchor;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('导入 Skill 路径包含链接或 Junction');
  }
  const realAnchor = fs.realpathSync.native(anchor);
  const realTarget = fs.realpathSync.native(target);
  if (!inside(realAnchor, realTarget)) throw new Error('导入 Skill 实际路径超出独立存储目录');
  const targetStat = fs.lstatSync(target);
  if (expectedType === 'file' && !targetStat.isFile()) throw new Error('导入 Skill 入口不是文件');
  if (expectedType === 'directory' && !targetStat.isDirectory()) throw new Error('导入 Skill 源目录不是文件夹');
  return { realAnchor, realTarget };
}

function safeReadFile(anchorPath, filePath, maxBytes = IMPORTED_BYTE_LIMIT) {
  const before = assertNoLinkPath(anchorPath, filePath, 'file');
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('导入 Skill 文件大小或类型无效');
    const value = fs.readFileSync(descriptor);
    const afterStat = fs.fstatSync(descriptor);
    if (afterStat.size !== stat.size || afterStat.mtimeMs !== stat.mtimeMs) throw new Error('导入 Skill 文件在校验时发生变化');
    const after = assertNoLinkPath(anchorPath, filePath, 'file');
    if (after.realTarget !== before.realTarget) throw new Error('导入 Skill 文件路径在校验时发生变化');
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeManifestLabel(filePath) {
  return `${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`;
}

function safeImportedError(error) {
  const code = text(error?.code, 40);
  if (/^E[A-Z0-9]+$/.test(code)) return `导入 Skill 文件访问失败（${code}）`;
  return text(error?.message || error, 500).replace(/[a-zA-Z]:[\\/][^\r\n'"`]+/g, '[本地路径]');
}

function importedPublicValue(value, depth = 0) {
  if (depth > 12 || value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || value.startsWith('\\\\')) return '';
    return value;
  }
  if (Array.isArray(value)) return value.map(item => importedPublicValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, importedPublicValue(item, depth + 1)]));
  return '';
}

function validateAdapter(adapter, filename) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) throw new Error('适配器顶层必须是对象');
  if (adapter.schemaVersion !== '1.0') throw new Error('schemaVersion 必须为 1.0');
  if (!SKILL_ID_RE.test(String(adapter.id || ''))) throw new Error('Skill id 格式无效');
  if (!text(adapter.displayName, 80)) throw new Error('displayName 不能为空');
  if (!adapter.source || typeof adapter.source !== 'object') throw new Error('source 不能为空');
  if (!text(adapter.source.path, 1000) || !text(adapter.source.entry, 260)) throw new Error('source.path 与 source.entry 不能为空');
  if (!Array.isArray(adapter.dependencies)) throw new Error('dependencies 必须是数组');
  adapter.dependencies.forEach((dependency, index) => {
    if (!dependency || typeof dependency !== 'object' || !text(dependency.id, 160)) throw new Error(`dependencies[${index}] 无效`);
    if (!DEPENDENCY_STATES.has(dependency.status)) throw new Error(`dependencies[${index}].status 无效`);
  });
  if (!Array.isArray(adapter.stages) || !adapter.stages.length) throw new Error('stages 不能为空');
  const ids = new Set();
  const orders = new Set();
  adapter.stages.forEach((stage, index) => {
    if (!stage || typeof stage !== 'object') throw new Error(`stages[${index}] 无效`);
    if (!SKILL_ID_RE.test(String(stage.id || ''))) throw new Error(`stages[${index}].id 无效`);
    if (ids.has(stage.id)) throw new Error(`阶段 id 重复：${stage.id}`);
    ids.add(stage.id);
    if (!Number.isInteger(stage.order) || stage.order < 1 || orders.has(stage.order)) throw new Error(`阶段顺序无效：${stage.order}`);
    orders.add(stage.order);
    if (!text(stage.title, 100) || !text(stage.canvasStage, 100)) throw new Error(`阶段标题不能为空：${stage.id}`);
    if (!STAGE_READINESS.has(stage.readiness)) throw new Error(`阶段 readiness 无效：${stage.id}`);
    if (!COST_CLASSES.has(stage.costClass)) throw new Error(`阶段 costClass 无效：${stage.id}`);
    if (stage.costClass === 'potentially-paid' && stage.approvalRequired !== true) throw new Error(`付费阶段必须审批：${stage.id}`);
    if (!Array.isArray(stage.outputArtifacts)) throw new Error(`阶段 outputArtifacts 必须是数组：${stage.id}`);
  });
  const ordered = [...orders].sort((a, b) => a - b);
  ordered.forEach((order, index) => { if (order !== index + 1) throw new Error(`阶段顺序必须从 1 连续排列：${filename}`); });
  return adapter;
}

function sourceStatus(adapter, verification = null) {
  const sourcePath = path.resolve(String(adapter.source.path || ''));
  const entryPath = path.resolve(sourcePath, String(adapter.source.entry || ''));
  const entryInsideSource = inside(sourcePath, entryPath);
  return {
    kind: text(verification ? importedPublicValue(adapter.source.kind) : adapter.source.kind, 40),
    entry: text(verification ? importedPublicValue(adapter.source.entry) : adapter.source.entry, 260),
    readOnly: adapter.source.readOnly !== false,
    available: verification ? verification.ok === true : entryInsideSource && fs.existsSync(entryPath)
  };
}

function importedManifestFiles(descriptor) {
  const { rootPath, anchorPath } = descriptor;
  if (!fs.existsSync(rootPath)) throw new Error('附加 Skill 根目录不存在');
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink()) throw new Error('附加 Skill 根目录不能是链接或 Junction');
  if (rootStat.isFile()) {
    assertNoLinkPath(anchorPath, rootPath, 'file');
    return [rootPath];
  }
  if (!rootStat.isDirectory()) throw new Error('附加 Skill 根目录类型无效');
  assertNoLinkPath(anchorPath, rootPath, 'directory');
  const baseName = path.basename(rootPath).toLowerCase();
  const directories = baseName === 'adapters' || baseName === 'registrations' ? [rootPath] : [rootPath, path.join(rootPath, 'registrations'), path.join(rootPath, 'adapters')];
  const files = [];
  for (const directory of directories) {
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) continue;
    assertNoLinkPath(anchorPath, directory, 'directory');
    const registrations = path.basename(directory).toLowerCase() === 'registrations';
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      if (!name.endsWith(ADAPTER_SUFFIX) && !(registrations && name.endsWith('.json'))) continue;
      const filePath = path.join(directory, name);
      if (!fs.lstatSync(filePath).isFile()) continue;
      assertNoLinkPath(anchorPath, filePath, 'file');
      files.push(filePath);
    }
  }
  return [...new Set(files)];
}

function normalizeImportedAdapter(adapter) {
  const trust = adapter.trust && typeof adapter.trust === 'object' ? adapter.trust : {};
  const integrity = adapter.integrity && typeof adapter.integrity === 'object' ? adapter.integrity : {};
  return {
    ...adapter,
    status: adapter.status === 'disabled' ? 'disabled' : 'partial',
    signatureStatus: 'unsigned-local',
    executionStatus: 'instruction-only',
    trust: {
      warnings: Array.isArray(trust.warnings) ? trust.warnings.map(value => text(value, 300)).filter(Boolean) : [],
      kind: 'unsigned-local', status: 'unsigned-local', signatureStatus: 'unsigned-local', executionStatus: 'instruction-only', signed: false, verified: false
    },
    integrity: {
      algorithm: 'sha256',
      contentHash: text(integrity.contentHash, 64).toLowerCase(),
      packageHash: text(integrity.packageHash, 64).toLowerCase()
    },
    capabilities: { ...(adapter.capabilities && typeof adapter.capabilities === 'object' ? adapter.capabilities : {}), instructionOnly: true, executable: false },
    runtimeContract: { ...(adapter.runtimeContract && typeof adapter.runtimeContract === 'object' ? adapter.runtimeContract : {}), instructionOnly: true, executable: false },
    stages: adapter.stages.map(stage => ({
      ...stage,
      executor: { kind: 'skill', ref: text(adapter.source?.entry, 260) || 'SKILL.md' },
      readiness: 'adapter-required',
      costClass: 'free',
      approvalRequired: false
    }))
  };
}

function readImportedRecord(filePath, descriptor) {
  const raw = JSON.parse(safeReadFile(descriptor.anchorPath, filePath, 2 * 1024 * 1024).toString('utf8'));
  let adapter = raw?.adapter && typeof raw.adapter === 'object' ? raw.adapter : null;
  let adapterManifestPath = filePath;
  if (!adapter && text(raw?.adapterPath, 4000)) {
    const candidate = path.isAbsolute(raw.adapterPath) ? path.resolve(raw.adapterPath) : path.resolve(path.dirname(filePath), raw.adapterPath);
    assertNoLinkPath(descriptor.anchorPath, candidate, 'file');
    adapter = JSON.parse(safeReadFile(descriptor.anchorPath, candidate, 2 * 1024 * 1024).toString('utf8'));
    adapterManifestPath = candidate;
  }
  if (!adapter) adapter = raw;
  validateAdapter(adapter, path.basename(adapterManifestPath));
  const normalized = normalizeImportedAdapter(adapter);
  return {
    adapter: normalized,
    originalAdapter: adapter,
    metadata: raw,
    manifestPath: filePath,
    adapterManifestPath,
    label: safeManifestLabel(filePath),
    origin: 'imported',
    anchorPath: descriptor.anchorPath,
    rank: raw?.adapter || raw?.adapterPath ? 0 : 1
  };
}

function normalizedHash(value, label) {
  const hash = text(value, 128).toLowerCase();
  if (hash && !SHA256_RE.test(hash)) throw new Error(`${label} 格式无效`);
  return hash;
}

function integrityValue(record, key, descriptor = null) {
  const values = [
    record.metadata?.[key],
    record.metadata?.integrity?.[key],
    record.originalAdapter?.integrity?.[key],
    record.originalAdapter?.source?.integrity?.[key],
    descriptor?.[key]
  ].map(value => normalizedHash(value, key)).filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length > 1) throw new Error(`${key} 元数据不一致`);
  return unique[0] || '';
}

function validateIntegrityAlgorithm(record) {
  const algorithms = [
    record.metadata?.integrity?.algorithm,
    record.originalAdapter?.integrity?.algorithm,
    record.originalAdapter?.source?.integrity?.algorithm
  ].map(value => text(value, 40).toLowerCase()).filter(Boolean);
  if (algorithms.some(value => value !== 'sha256')) throw new Error('integrity.algorithm 必须为 sha256');
}

function payloadEntries(anchorPath, sourcePath) {
  const entries = [];
  let totalBytes = 0;
  function visit(directory, relativeRoot = '') {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const filePath = path.join(directory, dirent.name);
      const relativePath = path.posix.join(relativeRoot.replaceAll(path.sep, '/'), dirent.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || dirent.isSymbolicLink()) throw new Error('导入 Skill 包含链接或 Junction');
      if (stat.isDirectory()) {
        visit(filePath, relativePath);
        continue;
      }
      if (!stat.isFile()) throw new Error('导入 Skill 包含不支持的文件类型');
      totalBytes += stat.size;
      if (entries.length >= IMPORTED_FILE_LIMIT || totalBytes > IMPORTED_BYTE_LIMIT) throw new Error('导入 Skill 超出安全文件限制');
      entries.push({ path: relativePath, size: stat.size, sha256: sha256(safeReadFile(anchorPath, filePath)) });
    }
  }
  visit(sourcePath);
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function importedSourcePaths(record) {
  const rawSource = text(record.adapter.source?.path, 4000);
  const sourcePath = path.isAbsolute(rawSource) ? path.resolve(rawSource) : path.resolve(record.anchorPath, rawSource);
  if (!inside(record.anchorPath, sourcePath, false)) throw new Error('导入 Skill 源目录超出独立存储目录');
  assertNoLinkPath(record.anchorPath, sourcePath, 'directory');
  const rawEntry = text(record.adapter.source?.entry, 1000);
  if (!rawEntry || path.isAbsolute(rawEntry)) throw new Error('导入 Skill 入口必须是相对路径');
  const entryPath = path.resolve(sourcePath, rawEntry);
  if (!inside(sourcePath, entryPath, false)) throw new Error('Skill 入口超出源目录');
  assertNoLinkPath(sourcePath, entryPath, 'file');
  const rawPackagePath = text(record.metadata?.packagePath, 4000);
  const packagePath = rawPackagePath
    ? (path.isAbsolute(rawPackagePath) ? path.resolve(rawPackagePath) : path.resolve(record.anchorPath, rawPackagePath))
    : path.dirname(sourcePath);
  if (!inside(record.anchorPath, packagePath, false)) throw new Error('导入 Skill 包目录超出独立存储目录');
  assertNoLinkPath(record.anchorPath, packagePath, 'directory');
  return { sourcePath, entryPath, packagePath };
}

function verifyImportedRecord(record) {
  validateIntegrityAlgorithm(record);
  const { sourcePath, entryPath, packagePath } = importedSourcePaths(record);
  const entries = payloadEntries(record.anchorPath, sourcePath);
  const actualContentHash = sha256(stableStringify(entries));
  const packageManifestPath = path.join(packagePath, 'package.json');
  let descriptor = null;
  if (fs.existsSync(packageManifestPath)) {
    assertNoLinkPath(record.anchorPath, packageManifestPath, 'file');
    descriptor = JSON.parse(safeReadFile(record.anchorPath, packageManifestPath, 2 * 1024 * 1024).toString('utf8'));
  }
  const expectedContentHash = integrityValue(record, 'contentHash', descriptor);
  if (!expectedContentHash) throw new Error('导入 Skill 缺少 contentHash 完整性元数据');
  if (expectedContentHash !== actualContentHash) throw new Error('导入 Skill 内容完整性校验失败');
  if (descriptor?.files) {
    if (!Array.isArray(descriptor.files)) throw new Error('导入 Skill 文件清单格式无效');
    const declaredEntries = descriptor.files.map(item => ({ path: text(item?.path, 1000).replaceAll('\\', '/'), size: Number(item?.size), sha256: normalizedHash(item?.sha256, '文件 sha256') }));
    if (stableStringify(declaredEntries) !== stableStringify(entries)) throw new Error('导入 Skill 文件清单发生漂移');
  }
  const expectedPackageHash = integrityValue(record, 'packageHash', descriptor);
  let actualPackageHash = '';
  if (descriptor) {
    const unsignedDescriptor = { ...descriptor };
    delete unsignedDescriptor.packageHash;
    actualPackageHash = sha256(stableStringify(unsignedDescriptor));
    if (expectedPackageHash && expectedPackageHash !== actualPackageHash) throw new Error('导入 Skill 包清单完整性校验失败');
  } else if (expectedPackageHash) {
    throw new Error('导入 Skill 缺少包清单');
  }
  return {
    ok: true,
    status: expectedContentHash || expectedPackageHash ? 'verified' : 'unverified',
    sourcePath,
    entryPath,
    packagePath,
    contentHash: expectedContentHash || actualContentHash,
    packageHash: expectedPackageHash || actualPackageHash
  };
}

function findAgentDependencyRuntime(dependencyId) {
  const id = text(dependencyId, 160);
  if (id !== 'douyin-tiktok-story-skill') return { runtime: null, loadedAt: Date.now() };
  const entryPath = path.join(STORY_SKILL_ROOT, 'SKILL.md');
  const searchScriptPath = path.join(STORY_SKILL_ROOT, 'scripts', 'local_search.py');
  const databasePath = path.join(STORY_SKILL_ROOT, 'assets', 'douyin-story.sqlite3');
  const licensePath = path.join(STORY_SKILL_REPO_ROOT, 'LICENSE');
  const codeAvailable = fs.existsSync(entryPath) && fs.existsSync(searchScriptPath) && fs.existsSync(licensePath);
  const databaseAvailable = codeAvailable && fs.existsSync(databasePath) && fs.statSync(databasePath).isFile() && fs.statSync(databasePath).size > 0;
  return {
    runtime: {
      id,
      sourcePath: STORY_SKILL_ROOT,
      entryPath,
      searchScriptPath,
      databasePath,
      licensePath,
      codeAvailable,
      databaseAvailable,
      status: databaseAvailable ? 'available' : codeAvailable ? 'database-missing' : 'missing'
    },
    loadedAt: Date.now()
  };
}

function resolvedDependency(dependency) {
  if (dependency.id !== 'douyin-tiktok-story-skill') return dependency;
  const runtime = findAgentDependencyRuntime(dependency.id).runtime;
  return { ...dependency, status: runtime?.status || 'missing' };
}

function legacyIdsOf(adapter) {
  return Array.isArray(adapter.legacyIds) ? adapter.legacyIds.map(value => text(value, 80)).filter(Boolean) : [];
}

function sameImportedRegistration(left, right) {
  if (!left || left.origin !== 'imported' || right.origin !== 'imported' || left.adapter.id !== right.adapter.id) return false;
  return left.verification?.ok === true
    && right.verification?.ok === true
    && left.verification.contentHash === right.verification.contentHash
    && path.resolve(left.verification.sourcePath) === path.resolve(right.verification.sourcePath)
    && path.resolve(left.verification.packagePath) === path.resolve(right.verification.packagePath);
}

function loadRegistryRecords(options) {
  const config = registryOptions(options);
  const records = [];
  const errors = [];
  const identifiers = new Map();
  const bundled = [];
  if (!fs.existsSync(SKILL_ROOT)) {
    errors.push({ file: '', error: 'agent-skills 目录不存在' });
  } else {
    for (const filename of fs.readdirSync(SKILL_ROOT).filter(name => name.endsWith(ADAPTER_SUFFIX)).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      try {
        const manifestPath = path.join(SKILL_ROOT, filename);
        const adapter = validateAdapter(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), filename);
        if (!path.isAbsolute(adapter.source.path)) {
          const sourcePath = path.resolve(path.dirname(manifestPath), adapter.source.path);
          if (!inside(SKILL_ROOT, sourcePath)) throw new Error('内置 Skill 源目录超出 agent-skills');
          adapter.source.path = sourcePath;
        }
        verifyBundledPackage(adapter);
        bundled.push({ adapter, manifestPath, label: filename, origin: 'bundled', rank: -1 });
      } catch (error) {
        errors.push({ file: filename, error: text(error.message || error, 500) });
      }
    }
  }
  const imported = [];
  for (const root of Array.isArray(config.additionalRoots) ? config.additionalRoots : []) {
    let descriptor;
    try {
      descriptor = importedRootDescriptor(root);
      for (const filePath of importedManifestFiles(descriptor)) {
        try {
          imported.push(readImportedRecord(filePath, descriptor));
        } catch (error) {
          errors.push({ file: safeManifestLabel(filePath), error: safeImportedError(error) });
        }
      }
    } catch (error) {
      const fallback = typeof root === 'string' ? path.basename(root) : path.basename(String(root?.path || ''));
      errors.push({ file: fallback, error: safeImportedError(error) });
    }
  }
  imported.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'zh-CN'));
  for (const record of [...bundled, ...imported]) {
    if (record.origin === 'imported') {
      try {
        record.verification = verifyImportedRecord(record);
      } catch (error) {
        errors.push({ file: record.label, error: safeImportedError(error) });
        continue;
      }
    }
    const recordIds = [...new Set([record.adapter.id, ...legacyIdsOf(record.adapter)])];
    const collision = recordIds.map(id => ({ id, prior: identifiers.get(id) })).find(item => item.prior);
    if (collision) {
      if (sameImportedRegistration(collision.prior, record)) continue;
      errors.push({ file: record.label, error: `Skill id 或别名冲突：${collision.id}` });
      continue;
    }
    records.push(record);
    recordIds.forEach(id => identifiers.set(id, record));
  }
  return { records, errors, loadedAt: Date.now() };
}

function publicAdapter(adapter, record = null) {
  const imported = record?.origin === 'imported';
  const visible = value => imported ? importedPublicValue(value) : value;
  const result = {
    schemaVersion: adapter.schemaVersion,
    id: adapter.id,
    legacyIds: legacyIdsOf(adapter).map(value => text(visible(value), 80)).filter(Boolean),
    displayName: text(visible(adapter.displayName), 80),
    description: text(visible(adapter.description), 500),
    status: text(adapter.status, 30) || 'partial',
    source: sourceStatus(adapter, imported ? record.verification : null),
    defaults: adapter.defaults && typeof adapter.defaults === 'object' ? visible(adapter.defaults) : {},
    inputSchema: adapter.inputSchema && typeof adapter.inputSchema === 'object' ? visible(adapter.inputSchema) : {},
    materialPolicy: adapter.materialPolicy && typeof adapter.materialPolicy === 'object' ? visible(adapter.materialPolicy) : {},
    dependencies: adapter.dependencies.map(resolvedDependency).map(item => ({
      id: text(visible(item.id), 160),
      kind: text(visible(item.kind), 50),
      required: item.required === true,
      status: item.status
    })),
    stages: [...adapter.stages].sort((a, b) => a.order - b.order).map(stage => ({
      id: stage.id,
      order: stage.order,
      title: text(visible(stage.title), 100),
      canvasStage: text(visible(stage.canvasStage), 100),
      summary: text(visible(stage.summary), 300),
      executor: stage.executor && typeof stage.executor === 'object' ? { kind: text(visible(stage.executor.kind), 40), ref: text(visible(stage.executor.ref), 200) } : { kind: '', ref: '' },
      readiness: stage.readiness,
      costClass: stage.costClass,
      approvalRequired: stage.approvalRequired === true,
      outputArtifacts: stage.outputArtifacts.map(value => text(visible(value), 260)).filter(Boolean)
    })),
    runtimeContract: adapter.runtimeContract && typeof adapter.runtimeContract === 'object' ? visible(adapter.runtimeContract) : {},
    capabilities: adapter.capabilities && typeof adapter.capabilities === 'object' ? visible(adapter.capabilities) : {},
    blockers: Array.isArray(adapter.blockers) ? adapter.blockers.map(value => text(visible(value), 500)).filter(Boolean) : [],
    ui: adapter.ui && typeof adapter.ui === 'object' ? visible(adapter.ui) : {}
  };
  if (imported) {
    result.signatureStatus = 'unsigned-local';
    result.executionStatus = 'instruction-only';
    result.trust = adapter.trust;
    result.integrity = {
      algorithm: 'sha256',
      contentHash: text(record.verification?.contentHash || adapter.integrity?.contentHash, 64).toLowerCase(),
      packageHash: text(record.verification?.packageHash || adapter.integrity?.packageHash, 64).toLowerCase(),
      status: record.verification?.ok ? record.verification.status : 'failed'
    };
  } else if (adapter.integrity?.status === 'verified') {
    result.signatureStatus = text(adapter.source?.signatureStatus, 40) || 'unsigned-local';
    result.executionStatus = adapter.runtimeContract?.instructionOnly === true ? 'instruction-only' : 'adapter-required';
    result.trust = adapter.trust;
    result.integrity = {
      algorithm: 'sha256',
      contentHash: adapter.integrity.contentHash,
      packageHash: adapter.integrity.packageHash,
      status: 'verified'
    };
  }
  return result;
}

function loadAgentSkillRegistry(options = {}) {
  const registry = loadRegistryRecords(options);
  return { skills: registry.records.map(record => publicAdapter(record.adapter, record)), errors: registry.errors, loadedAt: registry.loadedAt };
}

function findAgentSkill(skillId, options = {}) {
  const requested = text(skillId, 80);
  if (!requested) return null;
  const registry = loadAgentSkillRegistry(options);
  const skill = registry.skills.find(item => item.id === requested || item.legacyIds.includes(requested)) || null;
  return { skill, errors: registry.errors, loadedAt: registry.loadedAt };
}

function findAgentSkillRuntime(skillId, options = {}) {
  const requested = text(skillId, 80);
  const registry = loadRegistryRecords(options);
  if (!requested) return { runtime: null, errors: registry.errors, loadedAt: registry.loadedAt };
  const record = registry.records.find(item => item.adapter.id === requested || legacyIdsOf(item.adapter).includes(requested));
  if (!record) return { runtime: null, errors: registry.errors, loadedAt: registry.loadedAt };
  if (record.origin === 'imported') {
    if (!record.verification?.ok) return { runtime: null, errors: registry.errors, loadedAt: registry.loadedAt };
    return {
      runtime: {
        adapter: record.adapter,
        sourcePath: record.verification.sourcePath,
        entryPath: record.verification.entryPath,
        manifestPath: record.manifestPath,
        packagePath: record.verification.packagePath,
        origin: 'imported'
      },
      errors: registry.errors,
      loadedAt: registry.loadedAt
    };
  }
  try {
    const sourcePath = path.resolve(String(record.adapter.source.path || ''));
    const entryPath = path.resolve(sourcePath, String(record.adapter.source.entry || ''));
    if (!inside(sourcePath, entryPath)) throw new Error('Skill 入口超出源目录');
    return { runtime: { adapter: record.adapter, sourcePath, entryPath, manifestPath: record.manifestPath }, errors: registry.errors, loadedAt: registry.loadedAt };
  } catch (error) {
    return { runtime: null, errors: [...registry.errors, { file: record.label, error: text(error.message || error, 500) }], loadedAt: registry.loadedAt };
  }
}

module.exports = {
  SKILL_ROOT,
  loadAgentSkillRegistry,
  findAgentSkill,
  findAgentSkillRuntime,
  findAgentDependencyRuntime,
  validateAdapter
};
