const fs = require('fs');
const path = require('path');
const { atomicWriteJson, clone, ensureDir, readJson, safeId, sha256, stableStringify } = require('./atomicJsonStore');

const APPROVAL_STATES = new Set(['draft', 'awaiting-review', 'approved', 'locked', 'superseded']);
const VALIDITY_STATES = new Set(['current', 'needs-review', 'stale', 'invalid']);

class ArtifactVersionStore {
  constructor(rootPath, options = {}) {
    this.rootPath = path.resolve(rootPath);
    this.indexPath = path.join(this.rootPath, 'artifact-index.json');
    this.clock = options.clock || (() => Date.now());
    ensureDir(this.rootPath);
    if (!fs.existsSync(this.indexPath)) this._save({ schemaVersion: 1, artifacts: {}, operations: {}, audit: [] });
  }

  _load() {
    const data = readJson(this.indexPath, { schemaVersion: 1, artifacts: {}, operations: {}, audit: [] });
    data.artifacts ||= {};
    data.operations ||= {};
    data.audit ||= [];
    return data;
  }

  _save(data) { atomicWriteJson(this.indexPath, data); }

  _contentBuffer(input) {
    if (Buffer.isBuffer(input.content)) return input.content;
    if (input.content !== undefined) return Buffer.from(typeof input.content === 'string' ? input.content : stableStringify(input.content), 'utf8');
    if (input.sourcePath) return fs.readFileSync(path.resolve(input.sourcePath));
    throw new Error('产物内容不能为空');
  }

  createVersion(input = {}) {
    const logicalArtifactId = safeId(input.logicalArtifactId, 'logicalArtifactId');
    const artifactType = safeId(input.artifactType, 'artifactType');
    const operationId = safeId(input.operationId, 'operationId');
    const data = this._load();
    if (data.operations[operationId]) return clone(data.artifacts[data.operations[operationId]]);
    const siblings = Object.values(data.artifacts).filter(item => item.logicalArtifactId === logicalArtifactId);
    const version = siblings.reduce((maximum, item) => Math.max(maximum, Number(item.version) || 0), 0) + 1;
    const artifactVersionId = safeId(input.artifactVersionId || `${logicalArtifactId}-v${String(version).padStart(3, '0')}`, 'artifactVersionId');
    if (data.artifacts[artifactVersionId]) throw new Error('产物版本不可覆盖');
    const content = this._contentBuffer(input);
    const rawExtension = String(input.extension || (typeof input.content === 'object' && !Buffer.isBuffer(input.content) ? '.json' : '.bin'));
    const extension = rawExtension.replace(/[^.a-zA-Z0-9_-]/g, '') || '.bin';
    const relativeContentPath = path.posix.join('content', logicalArtifactId, `${artifactVersionId}${extension.startsWith('.') ? extension : `.${extension}`}`);
    const absoluteContentPath = path.join(this.rootPath, ...relativeContentPath.split('/'));
    ensureDir(path.dirname(absoluteContentPath));
    if (fs.existsSync(absoluteContentPath)) throw new Error('产物内容文件已存在，拒绝覆盖');
    fs.writeFileSync(absoluteContentPath, content);
    const now = this.clock();
    const artifact = {
      artifactVersionId,
      artifactType,
      logicalArtifactId,
      version,
      source: String(input.source || 'unknown'),
      contentPath: relativeContentPath,
      contentHash: sha256(content),
      inputRefs: Array.isArray(input.inputRefs) ? input.inputRefs.map(ref => ({ artifactVersionId: safeId(ref.artifactVersionId, 'inputRef'), role: String(ref.role || 'input') })) : [],
      approvalState: 'draft',
      validityState: 'current',
      createdAt: now,
      approvedAt: null,
      lockedAt: null,
      metadata: clone(input.metadata || {})
    };
    data.artifacts[artifactVersionId] = artifact;
    data.operations[operationId] = artifactVersionId;
    data.audit.push({ type: 'artifact-created', artifactVersionId, operationId, at: now });
    this._save(data);
    return clone(artifact);
  }

  get(artifactVersionId, options = {}) {
    const id = safeId(artifactVersionId, 'artifactVersionId');
    const artifact = this._load().artifacts[id];
    if (!artifact) return null;
    if (options.verify !== false) {
      const validation = this.verify(id);
      if (!validation.valid && options.throwOnInvalid) throw new Error(validation.error);
      return { ...clone(artifact), validation };
    }
    return clone(artifact);
  }

  list(filter = {}) {
    return Object.values(this._load().artifacts)
      .filter(item => !filter.logicalArtifactId || item.logicalArtifactId === filter.logicalArtifactId)
      .filter(item => !filter.artifactType || item.artifactType === filter.artifactType)
      .filter(item => !filter.canvasId || item.metadata?.canvasId === filter.canvasId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  verify(artifactVersionId) {
    const artifact = this._load().artifacts[safeId(artifactVersionId, 'artifactVersionId')];
    if (!artifact) return { valid: false, error: '产物版本不存在' };
    const absolute = path.resolve(this.rootPath, artifact.contentPath);
    if (absolute !== this.rootPath && !absolute.startsWith(`${this.rootPath}${path.sep}`)) return { valid: false, error: '产物路径越界' };
    if (!fs.existsSync(absolute)) return { valid: false, error: '产物内容文件缺失' };
    const actualHash = sha256(fs.readFileSync(absolute));
    return actualHash === artifact.contentHash ? { valid: true, contentHash: actualHash } : { valid: false, error: '产物内容哈希不一致', expectedHash: artifact.contentHash, actualHash };
  }

  readContent(artifactVersionId, options = {}) {
    const artifact = this.get(artifactVersionId, { verify: false });
    if (!artifact) throw new Error('产物版本不存在');
    const validation = this.verify(artifactVersionId);
    if (!validation.valid) throw new Error(validation.error);
    const absolute = path.resolve(this.rootPath, artifact.contentPath);
    const maximum = Math.max(1, Math.min(1024 * 1024, Number(options.maxBytes) || 24000));
    const buffer = fs.readFileSync(absolute);
    if (buffer.length > maximum) return buffer.subarray(0, maximum).toString(options.encoding || 'utf8') + '\n…内容已截断';
    return buffer.toString(options.encoding || 'utf8');
  }

  updateState(artifactVersionId, patch = {}, auditType = 'artifact-state-updated') {
    const id = safeId(artifactVersionId, 'artifactVersionId');
    const data = this._load();
    const artifact = data.artifacts[id];
    if (!artifact) throw new Error('产物版本不存在');
    if (patch.approvalState && !APPROVAL_STATES.has(patch.approvalState)) throw new Error('审核状态不合法');
    if (patch.validityState && !VALIDITY_STATES.has(patch.validityState)) throw new Error('有效性状态不合法');
    ['approvalState', 'validityState', 'approvedAt', 'lockedAt', 'inputRefs'].forEach(key => {
      if (Object.prototype.hasOwnProperty.call(patch, key)) artifact[key] = clone(patch[key]);
    });
    data.audit.push({ type: auditType, artifactVersionId: id, patch: clone(patch), at: this.clock() });
    this._save(data);
    return clone(artifact);
  }

  replaceInputRefs(artifactVersionId, inputRefs, audit = {}) {
    return this.updateState(artifactVersionId, { inputRefs }, audit.type || 'artifact-inputs-rebound');
  }

  audit() { return clone(this._load().audit); }
}

module.exports = { APPROVAL_STATES, ArtifactVersionStore, VALIDITY_STATES };
