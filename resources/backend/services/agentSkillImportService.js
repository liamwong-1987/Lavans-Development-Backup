const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const { sha256, stableStringify } = require('./canvasAgentFoundation/atomicJsonStore');

const STORE_SEGMENTS = ['.state', 'canvas-agent-skills'];
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const IMPORT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SCRIPT_RE = /\.(?:bat|cmd|com|cpl|dll|exe|js|mjs|cjs|ts|py|ps1|sh|bash|zsh|fish|rb|php|pl|jar|msi|scr|vbs|wsf)$/i;
const LIMITS = Object.freeze({
  files: 128,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  skillBytes: 512 * 1024,
  pathLength: 240,
  pathDepth: 12
});

function importError(message, statusCode = 400, code = 'AGENT_SKILL_IMPORT_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isInside(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(target) === normalize(root) || normalize(target).startsWith(`${normalize(root)}${path.sep}`);
}

function assertExistingDirectoryNotLink(directory, code = 'SKILL_IMPORT_STORE_INVALID') {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw importError('Skill 导入存储目录不安全', 409, code);
  }
}

function ensureDirectory(directory, rootPath) {
  const resolved = path.resolve(directory);
  if (!isInside(rootPath, resolved)) throw importError('Skill 导入写入路径越界', 409, 'SKILL_IMPORT_WRITE_PATH_INVALID');
  const relative = path.relative(path.resolve(rootPath), resolved);
  let cursor = path.resolve(rootPath);
  assertExistingDirectoryNotLink(cursor);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    assertExistingDirectoryNotLink(cursor);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
  }
}

function readJsonFile(filePath, code = 'SKILL_IMPORT_STORE_INVALID') {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) {
    throw importError('Skill 导入登记文件不安全', 409, code);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw importError('Skill 导入登记文件损坏', 409, code);
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

function strictUtf8(buffer, relativePath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw importError(`文件不是严格 UTF-8：${relativePath}`, 400, 'SKILL_IMPORT_UTF8_INVALID');
  }
}

function validatePath(rawPath) {
  const original = String(rawPath == null ? '' : rawPath);
  if (!original || original.includes('\0')) throw importError('Skill 文件路径为空或包含 NUL', 400, 'SKILL_IMPORT_PATH_INVALID');
  if (/^[a-zA-Z]:/.test(original) || original.startsWith('\\\\') || original.startsWith('//')
    || path.win32.isAbsolute(original) || path.posix.isAbsolute(original)) {
    throw importError('Skill 文件路径不能是绝对路径、盘符或 UNC 路径', 400, 'SKILL_IMPORT_PATH_INVALID');
  }
  const slashPath = original.replace(/\\/g, '/');
  const rawSegments = slashPath.split('/');
  if (rawSegments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw importError('Skill 文件路径不能包含空段、. 或 ..', 400, 'SKILL_IMPORT_PATH_INVALID');
  }
  const segments = rawSegments.map(segment => segment.normalize('NFC'));
  if (segments.length > LIMITS.pathDepth) throw importError('Skill 文件路径层级超过 12 层', 413, 'SKILL_IMPORT_LIMIT_EXCEEDED');
  for (const segment of segments) {
    if (segment.includes(':')) throw importError('Skill 文件路径不能包含 ADS 冒号', 400, 'SKILL_IMPORT_PATH_INVALID');
    if (/[. ]$/.test(segment)) throw importError('Skill 文件名不能以点或空格结尾', 400, 'SKILL_IMPORT_PATH_INVALID');
    if (DEVICE_NAME_RE.test(segment)) throw importError('Skill 文件路径包含 Windows 设备名', 400, 'SKILL_IMPORT_PATH_INVALID');
  }
  const normalized = segments.join('/');
  if (normalized.length > LIMITS.pathLength) throw importError('Skill 文件路径超过 240 字符', 413, 'SKILL_IMPORT_LIMIT_EXCEEDED');
  return normalized;
}

function validateNoCaseCollision(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const folded = entry.relativePath.normalize('NFC').toLowerCase();
    if (seen.has(folded)) {
      throw importError(`Skill 文件路径发生大小写冲突：${entry.relativePath}`, 400, 'SKILL_IMPORT_CASE_CONFLICT');
    }
    seen.set(folded, entry.relativePath);
  }
}

function parseRelativePaths(relativePaths) {
  if (relativePaths == null || relativePaths === '') return null;
  if (Array.isArray(relativePaths)) return relativePaths;
  if (typeof relativePaths === 'string') {
    try {
      const parsed = JSON.parse(relativePaths);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw importError('relativePaths 必须是路径数组', 400, 'SKILL_IMPORT_PATH_INVALID');
}

function fileBuffer(file) {
  if (Buffer.isBuffer(file)) return file;
  if (Buffer.isBuffer(file?.buffer)) return file.buffer;
  if (Buffer.isBuffer(file?.content)) return file.content;
  if (typeof file?.content === 'string') return Buffer.from(file.content, 'utf8');
  throw importError('Skill 文件缺少内存内容', 400, 'SKILL_IMPORT_FILES_INVALID');
}

function inputPath(file, explicitPath, index, count) {
  if (explicitPath != null && explicitPath !== '') return explicitPath;
  if (typeof file?.relativePath === 'string' && file.relativePath) return file.relativePath;
  if (typeof file?.webkitRelativePath === 'string' && file.webkitRelativePath) return file.webkitRelativePath;
  if (typeof file?.originalname === 'string' && file.originalname) return file.originalname;
  if (typeof file?.filename === 'string' && file.filename) return file.filename;
  if (Buffer.isBuffer(file) && count === 1) return 'SKILL.md';
  throw importError(`第 ${index + 1} 个 Skill 文件缺少相对路径`, 400, 'SKILL_IMPORT_PATH_INVALID');
}

function rootSkillEntries(entries) {
  validateNoCaseCollision(entries);
  const skillEntries = entries.filter(entry => path.posix.basename(entry.relativePath).toLowerCase() === 'skill.md');
  if (skillEntries.length !== 1 || path.posix.basename(skillEntries[0]?.relativePath || '') !== 'SKILL.md') {
    throw importError('Skill 包必须且只能包含一个根 SKILL.md', 400, 'SKILL_IMPORT_ENTRY_INVALID');
  }
  const entryPath = skillEntries[0].relativePath;
  const prefix = path.posix.dirname(entryPath);
  if (prefix === '.') return entries;
  const rootPrefix = `${prefix}/`;
  if (entries.some(entry => !entry.relativePath.startsWith(rootPrefix))) {
    throw importError('SKILL.md 必须位于所选 Skill 文件夹根目录', 400, 'SKILL_IMPORT_ENTRY_INVALID');
  }
  const stripped = entries.map(entry => ({ ...entry, relativePath: entry.relativePath.slice(rootPrefix.length) }));
  stripped.forEach(entry => { entry.relativePath = validatePath(entry.relativePath); });
  validateNoCaseCollision(stripped);
  return stripped;
}

function normalizeFiles(input) {
  const files = Array.isArray(input?.files) ? input.files : [];
  if (!files.length) throw importError('请选择 SKILL.md 或 Skill 文件夹', 400, 'SKILL_IMPORT_FILES_INVALID');
  if (files.length > LIMITS.files) throw importError('Skill 文件数超过 128 个', 413, 'SKILL_IMPORT_LIMIT_EXCEEDED');
  const explicitPaths = parseRelativePaths(input?.relativePaths);
  if (explicitPaths && explicitPaths.length !== files.length) {
    throw importError('relativePaths 与 files 数量不一致', 400, 'SKILL_IMPORT_PATH_INVALID');
  }
  let totalBytes = 0;
  let entries = files.map((file, index) => {
    const buffer = fileBuffer(file);
    const relativePath = validatePath(inputPath(file, explicitPaths?.[index], index, files.length));
    if (buffer.length > LIMITS.fileBytes) throw importError(`单个 Skill 文件超过 10MB：${relativePath}`, 413, 'SKILL_IMPORT_LIMIT_EXCEEDED');
    totalBytes += buffer.length;
    if (totalBytes > LIMITS.totalBytes) throw importError('Skill 文件总大小超过 50MB', 413, 'SKILL_IMPORT_LIMIT_EXCEEDED');
    return { relativePath, buffer };
  });
  entries = rootSkillEntries(entries);
  const skillEntry = entries.find(entry => entry.relativePath === 'SKILL.md');
  if (!skillEntry || skillEntry.buffer.length > LIMITS.skillBytes) {
    throw importError('SKILL.md 超过 512KB', 413, 'SKILL_IMPORT_LIMIT_EXCEEDED');
  }
  strictUtf8(skillEntry.buffer, 'SKILL.md');
  return { entries, totalBytes };
}

function scalar(value, key) {
  const raw = value.trim();
  if (!raw) return '';
  if (/^[|>{}\[\]&*!]/.test(raw)) throw importError(`SKILL.md frontmatter 的 ${key} 只允许单行字符串`, 400, 'SKILL_FRONTMATTER_INVALID');
  let parsed = raw;
  if (raw.startsWith('"')) {
    try { parsed = JSON.parse(raw); } catch { throw importError(`SKILL.md frontmatter 的 ${key} 引号无效`, 400, 'SKILL_FRONTMATTER_INVALID'); }
    if (typeof parsed !== 'string') throw importError(`SKILL.md frontmatter 的 ${key} 必须是字符串`, 400, 'SKILL_FRONTMATTER_INVALID');
  } else if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw importError(`SKILL.md frontmatter 的 ${key} 引号无效`, 400, 'SKILL_FRONTMATTER_INVALID');
    parsed = raw.slice(1, -1).replace(/''/g, "'");
  }
  const multiline = ['usage_scenario', 'how_to_use', 'output_content'].includes(key);
  const invalidControl = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (invalidControl.test(parsed)) throw importError(`SKILL.md frontmatter 的 ${key} 包含控制字符`, 400, 'SKILL_FRONTMATTER_INVALID');
  return parsed.trim();
}

function parseMetadata(markdown) {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const values = {};
  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closing < 0) throw importError('SKILL.md frontmatter 缺少结束标记', 400, 'SKILL_FRONTMATTER_INVALID');
    for (const line of lines.slice(1, closing)) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1].toLowerCase();
      if (['name', 'slug', 'description', 'version', 'publisher', 'usage_scenario', 'how_to_use', 'output_content', 'skill_type'].includes(key)) values[key] = scalar(match[2], key);
    }
  }
  const bodyStart = lines[0]?.trim() === '---' ? lines.findIndex((line, index) => index > 0 && line.trim() === '---') + 1 : 0;
  const heading = lines.slice(bodyStart).map(line => /^#\s+(.+?)\s*$/.exec(line)?.[1] || '').find(Boolean) || '';
  const name = (values.name || heading || '本地 Skill').slice(0, 80);
  const slug = String(values.slug || '').trim();
  if (slug && (slug !== slug.toLowerCase() || !SKILL_ID_RE.test(slug) || DEVICE_NAME_RE.test(slug))) {
    throw importError('SKILL.md frontmatter 的 slug 格式无效', 400, 'SKILL_FRONTMATTER_INVALID');
  }
  return {
    name,
    ...(slug ? { slug } : {}),
    description: String(values.description || '').slice(0, 500),
    version: String(values.version || '0.0.0-local').slice(0, 80),
    publisher: String(values.publisher || 'local-import').slice(0, 160),
    usageScenario: String(values.usage_scenario || '').slice(0, 2000),
    howToUse: String(values.how_to_use || '').slice(0, 2000),
    outputContent: String(values.output_content || '').slice(0, 2000),
    skillType: ['image', 'video', 'audio', 'other'].includes(String(values.skill_type || '').toLowerCase()) ? String(values.skill_type).toLowerCase() : 'other'
  };
}

function fileManifest(entries) {
  return entries.map(entry => ({
    path: entry.relativePath,
    size: entry.buffer.length,
    sha256: sha256(entry.buffer)
  })).sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function contentHash(files) {
  return sha256(stableStringify(files));
}

function suggestedSkillId(name, hash) {
  let id = String(name || '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (id.length < 3) id = `local-${id || 'skill'}-${hash.slice(0, 8)}`;
  if (!SKILL_ID_RE.test(id) || DEVICE_NAME_RE.test(id)) id = `local-skill-${hash.slice(0, 12)}`;
  return id;
}

function previewContract(importId, analysis) {
  const warnings = [
    '本地导入未包含数字签名，登记为 unsigned-local',
    '当前仅保存 Skill 指令，不执行脚本；执行器尚未绑定'
  ];
  if (analysis.files.some(file => SCRIPT_RE.test(file.path))) warnings.push('检测到脚本文件：只会保存，不会执行或授予权限');
  const preview = {
    importId,
    contentHash: analysis.contentHash,
    suggestedSkillId: analysis.suggestedSkillId,
    name: analysis.metadata.name,
    slug: analysis.metadata.slug || '',
    description: analysis.metadata.description,
    version: analysis.metadata.version,
    publisher: analysis.metadata.publisher,
    usageScenario: analysis.metadata.usageScenario,
    howToUse: analysis.metadata.howToUse,
    outputContent: analysis.metadata.outputContent,
    skillType: analysis.metadata.skillType,
    fileCount: analysis.files.length,
    bytes: analysis.files.reduce((sum, file) => sum + file.size, 0),
    signatureStatus: 'unsigned-local',
    executionStatus: 'adapter-required',
    warnings,
    conflicts: analysis.conflicts
  };
  const previewHash = sha256(stableStringify({
    importId,
    contentHash: preview.contentHash,
    slug: preview.slug,
    name: preview.name,
    description: preview.description,
    version: preview.version,
    publisher: preview.publisher,
    usageScenario: preview.usageScenario,
    howToUse: preview.howToUse,
    outputContent: preview.outputContent,
    skillType: preview.skillType,
    fileCount: preview.fileCount,
    bytes: preview.bytes,
    signatureStatus: preview.signatureStatus,
    executionStatus: preview.executionStatus,
    warnings: preview.warnings
  }));
  return { ...preview, previewHash };
}

function normalizeTimestamp(value) {
  const current = typeof value === 'function' ? value() : value;
  if (current instanceof Date) return current.toISOString();
  if (typeof current === 'number') return new Date(current).toISOString();
  const parsed = new Date(current == null ? Date.now() : current);
  if (Number.isNaN(parsed.getTime())) throw importError('Skill 导入时钟无效', 500, 'SKILL_IMPORT_CLOCK_INVALID');
  return parsed.toISOString();
}

function createAgentSkillImportService(options = {}) {
  if (!options.outputRoot) throw importError('outputRoot 不能为空', 500, 'SKILL_IMPORT_CONFIGURATION_INVALID');
  const outputRoot = path.resolve(options.outputRoot);
  const storeRoot = path.join(outputRoot, ...STORE_SEGMENTS);
  const incomingRoot = path.join(storeRoot, 'incoming');
  const packagesRoot = path.join(storeRoot, 'packages');
  const adaptersRoot = path.join(storeRoot, 'adapters');
  const registrationsRoot = path.join(storeRoot, 'registrations');
  const clock = options.now || (() => new Date());
  const makeId = options.makeId || (() => `import-${crypto.randomUUID()}`);
  const reservedIds = options.reservedIds;

  function prepareStore(subdirectory) {
    if (!fs.existsSync(outputRoot)) fs.mkdirSync(outputRoot, { recursive: true });
    assertExistingDirectoryNotLink(outputRoot);
    ensureDirectory(storeRoot, outputRoot);
    if (subdirectory) ensureDirectory(subdirectory, storeRoot);
  }

  function isReserved(id) {
    if (typeof reservedIds === 'function') return reservedIds(id) === true;
    if (reservedIds instanceof Set) return reservedIds.has(id);
    return Array.isArray(reservedIds) && reservedIds.includes(id);
  }

  function registrationPath(id) { return path.join(registrationsRoot, `${id}.json`); }
  function adapterPath(id) { return path.join(adaptersRoot, `${id}.adapter.json`); }

  function conflictsFor(id, hash) {
    const conflicts = [];
    if (isReserved(id)) conflicts.push({ code: 'SKILL_ID_RESERVED', skillId: id, message: 'Skill id 与内置 Skill 冲突' });
    const existing = readJsonFile(registrationPath(id));
    if (existing && existing.contentHash !== hash) conflicts.push({ code: 'SKILL_ID_CONFLICT', skillId: id, message: '相同 Skill id 已登记其他内容' });
    return conflicts;
  }

  function analyze(entries) {
    const files = fileManifest(entries);
    const hash = contentHash(files);
    const skill = entries.find(entry => entry.relativePath === 'SKILL.md');
    const metadata = parseMetadata(strictUtf8(skill.buffer, 'SKILL.md'));
    const id = suggestedSkillId(metadata.slug || metadata.name, hash);
    return { entries, files, contentHash: hash, metadata, suggestedSkillId: id, conflicts: conflictsFor(id, hash) };
  }

  function nextImportId() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const id = String(makeId('agent-skill-import')).trim();
      if (!IMPORT_ID_RE.test(id) || DEVICE_NAME_RE.test(id)) throw importError('生成的 importId 不安全', 500, 'SKILL_IMPORT_ID_INVALID');
      if (!fs.existsSync(path.join(incomingRoot, id))) return id;
    }
    throw importError('无法分配 Skill 导入暂存目录', 503, 'SKILL_IMPORT_ID_UNAVAILABLE');
  }

  function writeIncoming(importId, analysis, preview) {
    const importRoot = path.join(incomingRoot, importId);
    const payloadRoot = path.join(importRoot, 'payload');
    ensureDirectory(importRoot, incomingRoot);
    ensureDirectory(payloadRoot, storeRoot);
    try {
      for (const entry of analysis.entries) {
        const target = path.resolve(payloadRoot, ...entry.relativePath.split('/'));
        if (!isInside(payloadRoot, target)) throw importError('Skill 暂存路径越界', 409, 'SKILL_IMPORT_WRITE_PATH_INVALID');
        ensureDirectory(path.dirname(target), storeRoot);
        fs.writeFileSync(target, entry.buffer, { flag: 'wx' });
      }
      atomicCreateJson(path.join(importRoot, 'preview.json'), {
        schemaVersion: '1.0',
        createdAt: normalizeTimestamp(clock),
        preview,
        files: analysis.files
      }, storeRoot);
    } catch (error) {
      try { if (fs.existsSync(importRoot)) fs.rmSync(importRoot, { recursive: true }); } catch {}
      throw error;
    }
  }

  function preview(input = {}) {
    prepareStore(incomingRoot);
    const normalized = normalizeFiles(input);
    const analysis = analyze(normalized.entries);
    const importId = nextImportId();
    const value = previewContract(importId, analysis);
    writeIncoming(importId, analysis, value);
    return value;
  }

  function loadIncoming(importId) {
    if (!IMPORT_ID_RE.test(String(importId || '')) || DEVICE_NAME_RE.test(String(importId || ''))) {
      throw importError('importId 不合法', 400, 'SKILL_IMPORT_ID_INVALID');
    }
    const importRoot = path.resolve(incomingRoot, importId);
    if (!isInside(incomingRoot, importRoot) || importRoot === path.resolve(incomingRoot) || !fs.existsSync(importRoot)) {
      throw importError('Skill 导入预览不存在', 404, 'SKILL_IMPORT_NOT_FOUND');
    }
    const rootStat = fs.lstatSync(importRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw importError('Skill 导入暂存目录不安全', 409, 'SKILL_IMPORT_STORE_INVALID');
    const payloadRoot = path.join(importRoot, 'payload');
    const payloadStat = fs.existsSync(payloadRoot) ? fs.lstatSync(payloadRoot) : null;
    if (!payloadStat || payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) {
      throw importError('Skill 导入暂存内容缺失', 409, 'SKILL_IMPORT_STORE_INVALID');
    }
    const files = [];
    function walk(directory, parent = '') {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const itemPath = path.join(directory, item.name);
        const relativePath = parent ? `${parent}/${item.name}` : item.name;
        const stat = fs.lstatSync(itemPath);
        if (stat.isSymbolicLink()) throw importError('Skill 导入暂存内容不能包含符号链接', 409, 'SKILL_IMPORT_STORE_INVALID');
        if (stat.isDirectory()) walk(itemPath, relativePath);
        else if (stat.isFile()) files.push({ buffer: fs.readFileSync(itemPath), relativePath });
        else throw importError('Skill 导入暂存内容包含非普通文件', 409, 'SKILL_IMPORT_STORE_INVALID');
      }
    }
    walk(payloadRoot);
    return { importRoot, payloadRoot, normalized: normalizeFiles({ files, relativePaths: files.map(file => file.relativePath) }) };
  }

  function verifyPreview(importId, suppliedHash) {
    if (!/^[a-f0-9]{64}$/.test(String(suppliedHash || '').toLowerCase())) {
      throw importError('previewHash 不合法', 400, 'SKILL_IMPORT_PREVIEW_MISMATCH');
    }
    const incoming = loadIncoming(importId);
    const analysis = analyze(incoming.normalized.entries);
    const value = previewContract(importId, analysis);
    if (value.previewHash !== String(suppliedHash).toLowerCase()) {
      throw importError('Skill 导入内容已变化，请重新预览', 409, 'SKILL_IMPORT_PREVIEW_MISMATCH');
    }
    return { ...incoming, analysis, preview: value };
  }

  function validateSkillId(value) {
    const id = String(value || '').trim().toLowerCase();
    if (!SKILL_ID_RE.test(id) || DEVICE_NAME_RE.test(id)) throw importError('Skill id 格式无效', 400, 'SKILL_ID_INVALID');
    return id;
  }

  function packageDescriptor(id, analysis) {
    return {
      schemaVersion: '1.0',
      id,
      entry: 'SKILL.md',
      contentHash: analysis.contentHash,
      files: analysis.files,
      metadata: analysis.metadata,
      signatureStatus: 'unsigned-local',
      executionStatus: 'adapter-required',
      trust: { kind: 'unsigned-local', signed: false, verified: false },
      capabilities: { instructionOnly: true, executable: false }
    };
  }

  function safeAdapter(id, analysis, packageHash, payloadRoot) {
    const integrity = { algorithm: 'sha256', contentHash: analysis.contentHash, packageHash };
    const iconAsset = analysis.files.find(file => /^icon\.(?:png|jpe?g|webp|gif)$/i.test(file.path))?.path || '';
    return {
      schemaVersion: '1.0',
      id,
      displayName: analysis.metadata.name,
      description: analysis.metadata.description,
      status: 'partial',
      source: {
        kind: 'local-folder',
        path: payloadRoot,
        entry: 'SKILL.md',
        readOnly: true,
        importMode: 'immutable-local-package',
        signatureStatus: 'unsigned-local'
      },
      defaults: {},
      inputSchema: { type: 'object', additionalProperties: true },
      materialPolicy: { workspaceScope: 'canvas-agent', shareWithRecolor: false },
      dependencies: [],
      stages: [{
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
      }],
      runtimeContract: { instructionOnly: true, executable: false },
      capabilities: { chat: true, instructionOnly: true, executable: false },
      blockers: ['未绑定执行器'],
      integrity,
      trust: { kind: 'unsigned-local', signed: false, verified: false },
      ui: {
        version: analysis.metadata.version,
        publisher: analysis.metadata.publisher,
        iconAsset,
        usageScenario: analysis.metadata.usageScenario,
        howToUse: analysis.metadata.howToUse,
        outputContent: analysis.metadata.outputContent,
        skillType: analysis.metadata.skillType
      }
    };
  }

  function verifyPackage(packageRoot, expectedDescriptor, expectedHash) {
    const stat = fs.existsSync(packageRoot) ? fs.lstatSync(packageRoot) : null;
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw importError('Skill 不可变包缺失或不安全', 409, 'SKILL_PACKAGE_INVALID');
    const stored = readJsonFile(path.join(packageRoot, 'package.json'), 'SKILL_PACKAGE_INVALID');
    if (!stored || stored.packageHash !== expectedHash) throw importError('Skill 不可变包完整性不一致', 409, 'SKILL_PACKAGE_INVALID');
    const descriptor = { ...stored };
    delete descriptor.packageHash;
    if (sha256(stableStringify(descriptor)) !== expectedHash || stableStringify(descriptor) !== stableStringify(expectedDescriptor)) {
      throw importError('Skill 不可变包描述不一致', 409, 'SKILL_PACKAGE_INVALID');
    }
    const payloadRoot = path.join(packageRoot, 'payload');
    const files = [];
    function walk(directory, parent = '') {
      if (!fs.existsSync(directory)) throw importError('Skill 不可变包内容缺失', 409, 'SKILL_PACKAGE_INVALID');
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const itemPath = path.join(directory, item.name);
        const relativePath = parent ? `${parent}/${item.name}` : item.name;
        const itemStat = fs.lstatSync(itemPath);
        if (itemStat.isSymbolicLink()) throw importError('Skill 不可变包不能包含符号链接', 409, 'SKILL_PACKAGE_INVALID');
        if (itemStat.isDirectory()) walk(itemPath, relativePath);
        else if (itemStat.isFile()) files.push({ relativePath, buffer: fs.readFileSync(itemPath) });
        else throw importError('Skill 不可变包包含非普通文件', 409, 'SKILL_PACKAGE_INVALID');
      }
    }
    walk(payloadRoot);
    const actual = fileManifest(rootSkillEntries(files.map(file => ({ ...file, relativePath: validatePath(file.relativePath) }))));
    if (contentHash(actual) !== expectedDescriptor.contentHash || stableStringify(actual) !== stableStringify(expectedDescriptor.files)) {
      throw importError('Skill 不可变包内容校验失败', 409, 'SKILL_PACKAGE_INVALID');
    }
  }

  function ensurePackage(id, analysis, sourcePayloadRoot) {
    prepareStore(packagesRoot);
    const descriptor = packageDescriptor(id, analysis);
    const packageHash = sha256(stableStringify(descriptor));
    const skillPackagesRoot = path.join(packagesRoot, id);
    ensureDirectory(skillPackagesRoot, storeRoot);
    const packageRoot = path.join(skillPackagesRoot, analysis.contentHash);
    if (fs.existsSync(packageRoot)) {
      verifyPackage(packageRoot, descriptor, packageHash);
      return { packageRoot, payloadRoot: path.join(packageRoot, 'payload'), packageHash, descriptor };
    }
    const staging = path.join(skillPackagesRoot, `.staging-${crypto.randomUUID()}`);
    ensureDirectory(staging, storeRoot);
    try {
      const payloadRoot = path.join(staging, 'payload');
      ensureDirectory(payloadRoot, storeRoot);
      for (const file of analysis.files) {
        const source = path.resolve(sourcePayloadRoot, ...file.path.split('/'));
        const target = path.resolve(payloadRoot, ...file.path.split('/'));
        if (!isInside(sourcePayloadRoot, source) || !isInside(payloadRoot, target)) throw importError('Skill 包复制路径越界', 409, 'SKILL_IMPORT_WRITE_PATH_INVALID');
        const sourceStat = fs.lstatSync(source);
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw importError('Skill 暂存文件不安全', 409, 'SKILL_IMPORT_STORE_INVALID');
        ensureDirectory(path.dirname(target), storeRoot);
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
      const packageJson = { ...descriptor, packageHash };
      fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      verifyPackage(staging, descriptor, packageHash);
      fs.renameSync(staging, packageRoot);
    } catch (error) {
      try { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); } catch {}
      if (error?.code === 'EEXIST' && fs.existsSync(packageRoot)) verifyPackage(packageRoot, descriptor, packageHash);
      else throw error;
    }
    return { packageRoot, payloadRoot: path.join(packageRoot, 'payload'), packageHash, descriptor };
  }

  function registration(id, analysis, packageValue, adapter, registeredAt) {
    return {
      schemaVersion: '1.0',
      id,
      contentHash: analysis.contentHash,
      packageHash: packageValue.packageHash,
      registeredAt,
      signatureStatus: 'unsigned-local',
      executionStatus: 'adapter-required',
      trust: { kind: 'unsigned-local', signed: false, verified: false },
      integrity: { algorithm: 'sha256', contentHash: analysis.contentHash, packageHash: packageValue.packageHash },
      source: adapter.source,
      packagePath: packageValue.packageRoot,
      adapterPath: adapterPath(id),
      adapter
    };
  }

  function verifyExisting(id, analysis, expectedPackageHash) {
    const existing = readJsonFile(registrationPath(id));
    if (!existing) return null;
    if (existing.contentHash !== analysis.contentHash) throw importError('相同 Skill id 已登记其他内容', 409, 'SKILL_ID_CONFLICT');
    if (existing.packageHash !== expectedPackageHash || existing.signatureStatus !== 'unsigned-local'
      || existing.executionStatus !== 'adapter-required' || existing.trust?.signed !== false) {
      throw importError('现有 Skill 登记完整性不一致', 409, 'SKILL_REGISTRATION_INVALID');
    }
    const descriptor = packageDescriptor(id, analysis);
    const packageRoot = path.join(packagesRoot, id, analysis.contentHash);
    verifyPackage(packageRoot, descriptor, expectedPackageHash);
    const adapter = readJsonFile(adapterPath(id), 'SKILL_ADAPTER_INVALID');
    if (!adapter || adapter.integrity?.contentHash !== analysis.contentHash || adapter.integrity?.packageHash !== expectedPackageHash
      || adapter.capabilities?.instructionOnly !== true || adapter.capabilities?.executable !== false) {
      throw importError('现有 Skill adapter 完整性不一致', 409, 'SKILL_ADAPTER_INVALID');
    }
    return { registration: existing, adapter, package: { path: packageRoot, contentHash: analysis.contentHash, packageHash: expectedPackageHash }, idempotent: true };
  }

  function confirm(input = {}) {
    if (input.confirm !== true) throw importError('必须明确确认后才能导入 Skill', 400, 'SKILL_IMPORT_CONFIRMATION_REQUIRED');
    prepareStore(incomingRoot);
    const verified = verifyPreview(String(input.importId || ''), input.previewHash);
    const id = validateSkillId(input.skillId || verified.analysis.suggestedSkillId);
    if (isReserved(id)) throw importError('Skill id 与内置 Skill 冲突', 409, 'SKILL_ID_RESERVED');
    prepareStore(packagesRoot);
    const descriptor = packageDescriptor(id, verified.analysis);
    const expectedPackageHash = sha256(stableStringify(descriptor));
    const existing = verifyExisting(id, verified.analysis, expectedPackageHash);
    if (existing) return existing;

    const packageValue = ensurePackage(id, verified.analysis, verified.payloadRoot);
    const adapter = safeAdapter(id, verified.analysis, packageValue.packageHash, packageValue.payloadRoot);
    prepareStore(adaptersRoot);
    const currentAdapter = readJsonFile(adapterPath(id), 'SKILL_ADAPTER_INVALID');
    if (currentAdapter) {
      if (stableStringify(currentAdapter) !== stableStringify(adapter)) throw importError('相同 Skill id 已存在不同 adapter', 409, 'SKILL_ID_CONFLICT');
    } else {
      try { atomicCreateJson(adapterPath(id), adapter, storeRoot); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const raced = readJsonFile(adapterPath(id), 'SKILL_ADAPTER_INVALID');
        if (stableStringify(raced) !== stableStringify(adapter)) throw importError('相同 Skill id 并发登记冲突', 409, 'SKILL_ID_CONFLICT');
      }
    }
    prepareStore(registrationsRoot);
    const value = registration(id, verified.analysis, packageValue, adapter, normalizeTimestamp(clock));
    try { atomicCreateJson(registrationPath(id), value, storeRoot); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return verifyExisting(id, verified.analysis, packageValue.packageHash);
    }
    return {
      registration: value,
      adapter,
      package: { path: packageValue.packageRoot, contentHash: verified.analysis.contentHash, packageHash: packageValue.packageHash },
      idempotent: false
    };
  }

  function discard(input = {}) {
    prepareStore(incomingRoot);
    const verified = verifyPreview(String(input.importId || ''), input.previewHash);
    const target = path.resolve(verified.importRoot);
    const incoming = path.resolve(incomingRoot);
    if (target === incoming || !isInside(incoming, target)) throw importError('Skill 暂存删除目标越界', 409, 'SKILL_IMPORT_WRITE_PATH_INVALID');
    const realIncoming = fs.realpathSync(incoming);
    const realTarget = fs.realpathSync(target);
    if (realTarget === realIncoming || !isInside(realIncoming, realTarget) || fs.lstatSync(target).isSymbolicLink()) {
      throw importError('Skill 暂存删除目标不安全', 409, 'SKILL_IMPORT_WRITE_PATH_INVALID');
    }
    fs.rmSync(target, { recursive: true });
    return { importId: input.importId, previewHash: input.previewHash, discarded: true };
  }

  function guarded(action) {
    try { return action(); }
    catch (error) {
      if (error?.statusCode && error?.code) throw error;
      const wrapped = importError('Skill 导入存储操作失败', 500, 'SKILL_IMPORT_IO_ERROR');
      wrapped.cause = error;
      throw wrapped;
    }
  }

  return {
    preview: input => guarded(() => preview(input)),
    confirm: input => guarded(() => confirm(input)),
    discard: input => guarded(() => discard(input))
  };
}

module.exports = { createAgentSkillImportService, LIMITS };
