const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { sha256, stableStringify } = require('./canvasAgentFoundation/atomicJsonStore');
const { findAgentSkill, findAgentSkillRuntime } = require('./agentSkillRegistry');

const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ROLE_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const REQUEST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_TEMPLATE_BYTES = 1024 * 1024;
const DEFAULT_TEMPLATE_ROOT = path.resolve(__dirname, '..', 'agent-skills', 'compositions');

function compositionError(message, statusCode = 409, code = 'AGENT_SKILL_COMPOSITION_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function inside(rootPath, targetPath, allowSame = true) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return (allowSame || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertDirectory(directory, code = 'AGENT_SKILL_COMPOSITION_STORE_UNSAFE') {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw compositionError('Skill 组合目录不安全', 409, code);
}

function ensureDirectory(directory, rootPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(directory);
  if (!inside(root, target)) throw compositionError('Skill 组合写入路径越界', 409, 'AGENT_SKILL_COMPOSITION_STORE_UNSAFE');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  assertDirectory(root);
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    assertDirectory(cursor);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
  }
}

function readJson(filePath, code = 'AGENT_SKILL_COMPOSITION_CORRUPT') {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TEMPLATE_BYTES) {
    throw compositionError('Skill 组合记录不安全', 500, code);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw compositionError('Skill 组合记录损坏', 500, code);
  }
}

function atomicCreateJson(filePath, value, storeRoot) {
  ensureDirectory(path.dirname(filePath), storeRoot);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    JSON.parse(fs.readFileSync(temporary, 'utf8'));
    fs.linkSync(temporary, filePath);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function exactText(value, label, pattern, max = 160) {
  const result = String(value == null ? '' : value).trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) {
    throw compositionError(`Skill 组合模板的 ${label} 无效`, 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  return result;
}

function exactHash(value, label) {
  return exactText(value, label, SHA256_RE, 64).toLowerCase();
}

function relativeFile(value, label) {
  const raw = String(value == null ? '' : value).trim().replaceAll('\\', '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw compositionError(`Skill 组合模板的 ${label} 路径无效`, 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw compositionError(`Skill 组合模板的 ${label} 路径无效`, 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  return parts.join('/');
}

function contextFiles(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw compositionError(`Skill 组合模板的 ${label} 无效`, 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  const files = value.map((item, index) => relativeFile(item, `${label}[${index}]`));
  if (new Set(files.map(item => item.toLowerCase())).size !== files.length) {
    throw compositionError(`Skill 组合模板的 ${label} 重复`, 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  return files;
}

function runtimeContract(value, label) {
  if (!value || value.instructionOnly !== true || value.executable !== false) {
    throw compositionError(`Skill 组合模板的 ${label} 必须是 instruction-only`, 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  return { instructionOnly: true, executable: false };
}

function validateTemplate(value, filename) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== '1.0') {
    throw compositionError(`Skill 组合模板无效：${path.basename(filename)}`, 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  const limits = {
    maxDepth: Number(value.limits?.maxDepth),
    maxSkills: Number(value.limits?.maxSkills),
    maxContextBytes: Number(value.limits?.maxContextBytes)
  };
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 2
    || !Number.isInteger(limits.maxSkills) || limits.maxSkills < 1 || limits.maxSkills > 4
    || !Number.isInteger(limits.maxContextBytes) || limits.maxContextBytes < 1 || limits.maxContextBytes > 262144) {
    throw compositionError('Skill 组合模板的安全上限无效', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  const primary = value.primaryMatch || {};
  const primaryMatch = {
    id: exactText(primary.id, 'primaryMatch.id', SKILL_ID_RE, 64),
    declaredVersion: exactText(primary.declaredVersion, 'primaryMatch.declaredVersion', null, 80),
    contentHash: exactHash(primary.contentHash, 'primaryMatch.contentHash'),
    packageHash: exactHash(primary.packageHash, 'primaryMatch.packageHash'),
    contextFiles: contextFiles(primary.contextFiles || ['SKILL.md'], 'primaryMatch.contextFiles'),
    runtimeContract: runtimeContract(primary.runtimeContract || { instructionOnly: true, executable: false }, 'primaryMatch.runtimeContract')
  };
  if (!Array.isArray(value.dependencies) || value.dependencies.length < 1 || value.dependencies.length >= limits.maxSkills) {
    throw compositionError('Skill 组合模板的 dependencies 无效', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  const dependencies = value.dependencies.map((dependency, index) => ({
    id: exactText(dependency?.id, `dependencies[${index}].id`, SKILL_ID_RE, 64),
    displayName: exactText(dependency?.displayName, `dependencies[${index}].displayName`, null, 80),
    role: exactText(dependency?.role, `dependencies[${index}].role`, ROLE_RE, 64),
    required: dependency?.required === true,
    declaredVersion: exactText(dependency?.declaredVersion, `dependencies[${index}].declaredVersion`, null, 80),
    entry: relativeFile(dependency?.entry, `dependencies[${index}].entry`),
    entrySha256: exactHash(dependency?.entrySha256, `dependencies[${index}].entrySha256`),
    contextFiles: contextFiles(dependency?.contextFiles, `dependencies[${index}].contextFiles`),
    runtimeContract: runtimeContract(dependency?.runtimeContract, `dependencies[${index}].runtimeContract`)
  }));
  if (dependencies.some(item => !item.required)) {
    throw compositionError('首期 Skill 组合只允许 required dependency', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  if (new Set(dependencies.map(item => item.id)).size !== dependencies.length
    || new Set(dependencies.map(item => item.role)).size !== dependencies.length) {
    throw compositionError('Skill 组合模板包含重复依赖或角色', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  const promptOrder = Array.isArray(value.promptOrder) ? value.promptOrder.map(item => String(item)) : [];
  const expectedOrder = ['host-safety', ...dependencies.map(item => `dependency:${item.role}`), 'primary'];
  if (stableStringify(promptOrder) !== stableStringify(expectedOrder)) {
    throw compositionError('Skill 组合模板的 promptOrder 无效', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  }
  return {
    schemaVersion: '1.0',
    templateId: exactText(value.templateId, 'templateId', SKILL_ID_RE, 100),
    primaryMatch,
    dependencies,
    promptOrder,
    limits
  };
}

function loadTemplateCatalog(templateRoot) {
  if (!fs.existsSync(templateRoot)) return new Map();
  assertDirectory(templateRoot, 'AGENT_SKILL_COMPOSITION_CORRUPT');
  const realRoot = fs.realpathSync.native(templateRoot);
  const templates = new Map();
  for (const name of fs.readdirSync(templateRoot).filter(item => item.endsWith('.composition.json')).sort()) {
    const filePath = path.join(templateRoot, name);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TEMPLATE_BYTES
      || !inside(realRoot, fs.realpathSync.native(filePath), false)) {
      throw compositionError('Skill 组合模板路径不安全', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
    }
    const template = validateTemplate(readJson(filePath), filePath);
    if (templates.has(template.primaryMatch.id)) {
      throw compositionError('同一主 Skill 存在多个组合模板', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
    }
    templates.set(template.primaryMatch.id, template);
  }
  return templates;
}

function templateGraph(templates, primarySkillId) {
  const root = templates.get(primarySkillId);
  if (!root) return null;
  const dependencies = [];
  const seen = new Set([primarySkillId]);
  const roles = new Set();
  function visit(template, depth, stack) {
    if (depth > root.limits.maxDepth) {
      throw compositionError('Skill 组合深度超过上限', 409, 'AGENT_SKILL_DEPENDENCY_CYCLE');
    }
    for (const dependency of template.dependencies) {
      if (stack.includes(dependency.id)) {
        throw compositionError('Skill 组合存在循环依赖', 409, 'AGENT_SKILL_DEPENDENCY_CYCLE');
      }
      if (seen.has(dependency.id) || roles.has(dependency.role)) {
        throw compositionError('Skill 组合存在重复依赖或角色', 409, 'AGENT_SKILL_DEPENDENCY_CYCLE');
      }
      seen.add(dependency.id);
      roles.add(dependency.role);
      dependencies.push(dependency);
      if (seen.size > root.limits.maxSkills) {
        throw compositionError('Skill 组合数量超过上限', 409, 'AGENT_SKILL_DEPENDENCY_CYCLE');
      }
      const nested = templates.get(dependency.id);
      if (nested) visit(nested, depth + 1, [...stack, dependency.id]);
    }
  }
  visit(root, 1, [primarySkillId]);
  return { root, dependencies };
}

function safeContextFiles(runtime, files, maxBytes) {
  const sourcePath = path.resolve(runtime.sourcePath);
  const realSource = fs.realpathSync.native(sourcePath);
  const result = [];
  let totalBytes = 0;
  for (const relativePath of files) {
    const target = path.resolve(sourcePath, ...relativePath.split('/'));
    if (!inside(sourcePath, target, false) || !fs.existsSync(target)) {
      throw compositionError('Skill 上下文文件缺失或越界', 409, 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH');
    }
    let cursor = sourcePath;
    for (const segment of path.relative(sourcePath, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw compositionError('Skill 上下文文件包含链接', 409, 'AGENT_SKILL_DEPENDENCY_UNSAFE');
      }
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || !inside(realSource, fs.realpathSync.native(target), false)) {
      throw compositionError('Skill 上下文文件类型不安全', 409, 'AGENT_SKILL_DEPENDENCY_UNSAFE');
    }
    totalBytes += stat.size;
    if (totalBytes > maxBytes) {
      throw compositionError('Skill 组合上下文超过上限', 409, 'AGENT_SKILL_CONTEXT_TOO_LARGE');
    }
    result.push({ relativePath, absolutePath: target, size: stat.size });
  }
  return { files: result, bytes: totalBytes };
}

function normalizedTime(value) {
  const raw = typeof value === 'function' ? value() : value;
  const date = raw instanceof Date ? raw : new Date(raw == null ? Date.now() : raw);
  if (Number.isNaN(date.getTime())) throw compositionError('Skill 组合时钟无效', 500, 'AGENT_SKILL_COMPOSITION_CLOCK_INVALID');
  return date.getTime();
}

function createAgentSkillCompositionService(options = {}) {
  if (!options.outputRoot) throw compositionError('outputRoot 不能为空', 500, 'AGENT_SKILL_COMPOSITION_CONFIGURATION_INVALID');
  const outputRoot = path.resolve(options.outputRoot);
  const storeRoot = path.join(outputRoot, '.state', 'canvas-agent-skills');
  const compositionsRoot = path.join(storeRoot, 'compositions');
  const templateRoot = path.resolve(options.templateRoot || DEFAULT_TEMPLATE_ROOT);
  const clock = options.now || (() => new Date());
  const lookupSkill = options.findSkill || findAgentSkill;
  const lookupRuntime = options.findRuntime || findAgentSkillRuntime;

  function registryConfig() {
    const roots = [storeRoot, ...(Array.isArray(options.additionalRoots) ? options.additionalRoots : [])]
      .map(item => path.resolve(item))
      .filter((item, index, all) => fs.existsSync(item) && all.indexOf(item) === index);
    return { additionalRoots: roots };
  }

  function compositionPath(primarySkillId) {
    return path.join(compositionsRoot, `${primarySkillId}.composition.json`);
  }

  function runtimeFor(id, missingCode) {
    const publicResult = lookupSkill(id, registryConfig());
    const runtimeResult = lookupRuntime(id, registryConfig());
    if (!publicResult?.skill || !runtimeResult?.runtime) {
      throw compositionError('必需 Skill 尚未安全导入', 409, missingCode);
    }
    return { skill: publicResult.skill, runtime: runtimeResult.runtime };
  }

  function identityFor(expectation, kind, maxContextBytes) {
    const missingCode = kind === 'primary' ? 'AGENT_SKILL_PRIMARY_UNAVAILABLE' : 'AGENT_SKILL_DEPENDENCY_MISSING';
    const loaded = runtimeFor(expectation.id, missingCode);
    const { skill, runtime } = loaded;
    const contract = runtime.adapter.runtimeContract || {};
    const capabilities = runtime.adapter.capabilities || {};
    if (contract.instructionOnly !== true || contract.executable !== false
      || capabilities.instructionOnly !== true || capabilities.executable !== false) {
      throw compositionError('Skill 不是安全的 instruction-only 包', 409, 'AGENT_SKILL_DEPENDENCY_UNSAFE');
    }
    const version = String(skill.ui?.version || '').trim();
    const contentHash = String(skill.integrity?.contentHash || '').toLowerCase();
    const packageHash = String(skill.integrity?.packageHash || '').toLowerCase();
    if (version !== expectation.declaredVersion
      || (expectation.contentHash && contentHash !== expectation.contentHash)
      || (expectation.packageHash && packageHash !== expectation.packageHash)) {
      throw compositionError('Skill 身份与组合模板不一致', 409, 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH');
    }
    const contexts = safeContextFiles(runtime, expectation.contextFiles, maxContextBytes);
    if (expectation.entrySha256) {
      const entryPath = path.resolve(runtime.sourcePath, ...expectation.entry.split('/'));
      if (!contexts.files.some(file => path.resolve(file.absolutePath) === entryPath)
        || sha256(fs.readFileSync(entryPath)) !== expectation.entrySha256) {
        throw compositionError('Skill 根入口摘要与组合模板不一致', 409, 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH');
      }
    }
    return {
      public: {
        id: expectation.id,
        role: kind === 'primary' ? 'primary' : expectation.role,
        ...(kind === 'dependency' ? { required: expectation.required } : {}),
        declaredVersion: version,
        contentHash,
        packageHash,
        publisher: String(skill.ui?.publisher || 'local-import').slice(0, 160),
        signatureStatus: String(skill.signatureStatus || 'unsigned-local').slice(0, 40),
        ...(kind === 'dependency' ? { entrySha256: expectation.entrySha256 } : {}),
        contextFiles: [...expectation.contextFiles],
        instructionOnly: true,
        executable: false
      },
      runtime,
      contexts
    };
  }

  function prepare(primarySkillId) {
    const id = exactText(primarySkillId, 'primarySkillId', SKILL_ID_RE, 64);
    const templates = loadTemplateCatalog(templateRoot);
    const graph = templateGraph(templates, id);
    if (!graph) return { id, graph: null };
    const primary = identityFor(graph.root.primaryMatch, 'primary', graph.root.limits.maxContextBytes);
    const dependencies = graph.dependencies.map(item => ({ expectation: item, ...identityFor(item, 'dependency', graph.root.limits.maxContextBytes) }));
    const totalBytes = primary.contexts.bytes + dependencies.reduce((sum, item) => sum + item.contexts.bytes, 0);
    if (totalBytes > graph.root.limits.maxContextBytes) {
      throw compositionError('Skill 组合上下文超过上限', 409, 'AGENT_SKILL_CONTEXT_TOO_LARGE');
    }
    const policy = {
      promptOrder: [...graph.root.promptOrder],
      maxDepth: graph.root.limits.maxDepth,
      maxSkills: graph.root.limits.maxSkills,
      maxContextBytes: graph.root.limits.maxContextBytes
    };
    const hashValue = {
      templateId: graph.root.templateId,
      primary: primary.public,
      dependencies: dependencies.map(item => item.public),
      policy
    };
    const compositionHash = sha256(stableStringify(hashValue));
    return {
      id,
      graph,
      primary,
      dependencies,
      totalBytes,
      value: {
        schemaVersion: '1.0',
        ...hashValue,
        compositionId: `skill-composition-${compositionHash.slice(0, 32)}`,
        compositionHash
      }
    };
  }

  function verifyStored(record) {
    if (!record || record.schemaVersion !== '1.0' || !record.confirmation || !SHA256_RE.test(String(record.compositionHash || ''))) {
      throw compositionError('Skill 组合记录结构损坏', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
    }
    const hashValue = {
      templateId: record.templateId,
      primary: record.primary,
      dependencies: record.dependencies,
      policy: record.policy
    };
    const expectedHash = sha256(stableStringify(hashValue));
    if (record.compositionHash !== expectedHash
      || record.compositionId !== `skill-composition-${expectedHash.slice(0, 32)}`
      || !SHA256_RE.test(String(record.confirmation.payloadHash || ''))
      || !REQUEST_ID_RE.test(String(record.confirmation.requestId || ''))
      || !Number.isSafeInteger(record.confirmation.confirmedAt)) {
      throw compositionError('Skill 组合记录摘要损坏', 500, 'AGENT_SKILL_COMPOSITION_CORRUPT');
    }
    return record;
  }

  function dependencySummary(graph, status) {
    return graph.dependencies.map(item => ({
      id: item.id,
      displayName: item.displayName,
      role: item.role,
      required: item.required,
      declaredVersion: item.declaredVersion,
      status
    }));
  }

  function inspect(primarySkillId) {
    const id = exactText(primarySkillId, 'primarySkillId', SKILL_ID_RE, 64);
    const templates = loadTemplateCatalog(templateRoot);
    const graph = templateGraph(templates, id);
    if (!graph) return { status: 'not-required', primary: { id }, dependencies: [], actions: [] };
    let prepared;
    try {
      prepared = prepare(id);
    } catch (error) {
      if (error?.code === 'AGENT_SKILL_DEPENDENCY_MISSING') {
        return { status: 'missing', primary: { id, declaredVersion: graph.root.primaryMatch.declaredVersion }, dependencies: dependencySummary(graph, 'missing'), actions: ['import-dependency', 'use-without-skill'] };
      }
      if (error?.code === 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH') {
        return { status: 'drift', primary: { id, declaredVersion: graph.root.primaryMatch.declaredVersion }, dependencies: dependencySummary(graph, 'drift'), actions: ['restore-exact-dependency', 'use-without-skill'] };
      }
      if (error?.code === 'AGENT_SKILL_DEPENDENCY_UNSAFE' || error?.code === 'AGENT_SKILL_PRIMARY_UNAVAILABLE' || error?.code === 'AGENT_SKILL_CONTEXT_TOO_LARGE') {
        return { status: 'unsupported', primary: { id, declaredVersion: graph.root.primaryMatch.declaredVersion }, dependencies: dependencySummary(graph, 'unsupported'), actions: ['use-without-skill'] };
      }
      throw error;
    }
    const existing = readJson(compositionPath(id));
    if (!existing) {
      return {
        status: 'link-required',
        primary: { id, declaredVersion: prepared.value.primary.declaredVersion },
        dependencies: dependencySummary(graph, 'available'),
        actions: ['confirm-link', 'use-without-skill']
      };
    }
    const verified = verifyStored(existing);
    if (verified.compositionHash !== prepared.value.compositionHash) {
      return { status: 'drift', primary: { id, declaredVersion: prepared.value.primary.declaredVersion }, dependencies: dependencySummary(graph, 'drift'), actions: ['restore-exact-dependency', 'new-conversation'] };
    }
    return {
      status: 'ready',
      compositionId: verified.compositionId,
      compositionHash: verified.compositionHash,
      templateId: verified.templateId,
      primary: { id, declaredVersion: verified.primary.declaredVersion },
      dependencies: dependencySummary(graph, 'ready'),
      actions: []
    };
  }

  function requestedDependencies(input, graph) {
    const supplied = Array.isArray(input.dependencySkillIds)
      ? input.dependencySkillIds
      : [input.dependencySkillId].filter(Boolean);
    const normalized = supplied.map(item => exactText(item, 'dependencySkillId', SKILL_ID_RE, 64)).sort();
    const expected = graph.dependencies.map(item => item.id).sort();
    if (stableStringify(normalized) !== stableStringify(expected)) {
      throw compositionError('确认的依赖集合与模板不一致', 409, 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH');
    }
    return normalized;
  }

  function confirm(input = {}) {
    if (input.confirm !== true) throw compositionError('必须明确确认后才能关联 Skill', 400, 'AGENT_SKILL_COMPOSITION_CONFIRMATION_REQUIRED');
    const requestId = exactText(input.requestId, 'requestId', REQUEST_ID_RE, 128);
    const prepared = prepare(input.primarySkillId);
    if (!prepared.graph) throw compositionError('该 Skill 没有组合模板', 409, 'AGENT_SKILL_COMPOSITION_UNSUPPORTED');
    const dependencySkillIds = requestedDependencies(input, prepared.graph);
    const payloadHash = sha256(stableStringify({
      templateId: prepared.value.templateId,
      primarySkillId: prepared.id,
      dependencySkillIds
    }));
    const candidate = {
      ...prepared.value,
      confirmation: {
        requestId,
        payloadHash,
        confirmedAt: normalizedTime(clock)
      }
    };
    const filePath = compositionPath(prepared.id);
    const existing = readJson(filePath);
    if (existing) {
      const verified = verifyStored(existing);
      if (verified.compositionHash !== candidate.compositionHash) {
        throw compositionError('已存在不同的不可变 Skill 组合', 409, 'AGENT_SKILL_COMPOSITION_CONFLICT');
      }
      return { composition: verified, idempotent: true };
    }
    ensureDirectory(compositionsRoot, storeRoot);
    try {
      atomicCreateJson(filePath, candidate, storeRoot);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = verifyStored(readJson(filePath));
      if (raced.compositionHash !== candidate.compositionHash) {
        throw compositionError('并发创建了不同的 Skill 组合', 409, 'AGENT_SKILL_COMPOSITION_CONFLICT');
      }
      return { composition: raced, idempotent: true };
    }
    return { composition: candidate, idempotent: false };
  }

  function resolve(primarySkillId) {
    const prepared = prepare(primarySkillId);
    if (!prepared.graph) return { composition: null, primary: null, dependencies: [], totalBytes: 0 };
    const existing = readJson(compositionPath(prepared.id));
    if (!existing) throw compositionError('必需 Skill 尚未关联', 409, 'AGENT_SKILL_DEPENDENCY_MISSING');
    const stored = verifyStored(existing);
    if (stored.compositionHash !== prepared.value.compositionHash) {
      throw compositionError('Skill 组合身份已经漂移', 409, 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH');
    }
    return {
      composition: stored,
      primary: { runtime: prepared.primary.runtime, contexts: prepared.primary.contexts.files },
      dependencies: prepared.dependencies.map(item => ({ id: item.public.id, role: item.public.role, runtime: item.runtime, contexts: item.contexts.files })),
      totalBytes: prepared.totalBytes
    };
  }

  return { inspect, confirm, resolve };
}

module.exports = { createAgentSkillCompositionService };
