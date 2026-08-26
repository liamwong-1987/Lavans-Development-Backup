const fs = require('fs');
const path = require('path');
const { atomicWriteJson, clone, ensureDir, readJson, safeId } = require('./atomicJsonStore');

class ImpactPropagator {
  constructor(artifactStore, dependencyGraph, options = {}) {
    this.artifactStore = artifactStore;
    this.dependencyGraph = dependencyGraph;
    this.clock = options.clock || (() => Date.now());
    this.filePath = path.join(path.resolve(options.rootPath || artifactStore.rootPath), 'impact-operations.json');
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) atomicWriteJson(this.filePath, { operations: {}, audit: [] });
  }

  _load() { return readJson(this.filePath, { operations: {}, audit: [] }); }
  _save(state) { atomicWriteJson(this.filePath, state); }

  propagateReplacement(oldVersionId, newVersionId, options = {}) {
    const oldId = safeId(oldVersionId, 'oldVersionId');
    const newId = safeId(newVersionId, 'newVersionId');
    const operationId = safeId(options.operationId, 'operationId');
    const state = this._load();
    if (state.operations[operationId]) return clone(state.operations[operationId]);
    if (!this.artifactStore.get(oldId, { verify: false }) || !this.artifactStore.get(newId, { verify: false })) throw new Error('替换版本不存在');
    const affected = this.dependencyGraph.descendantsOf(oldId).map(entry => {
      const validityState = entry.depth === 1 ? 'stale' : 'needs-review';
      this.artifactStore.updateState(entry.artifactVersionId, { validityState }, 'upstream-version-replaced');
      return { ...entry, validityState };
    });
    const result = { operationId, oldVersionId: oldId, newVersionId: newId, affected, deletedFiles: 0, at: this.clock() };
    state.audit.push(result);
    state.operations[operationId] = result;
    this._save(state);
    return clone(result);
  }

  confirmReuse(artifactVersionId, oldVersionId, newVersionId, options = {}) {
    const id = safeId(artifactVersionId, 'artifactVersionId');
    const oldId = safeId(oldVersionId, 'oldVersionId');
    const newId = safeId(newVersionId, 'newVersionId');
    const artifact = this.artifactStore.get(id, { verify: false });
    if (!artifact) throw new Error('产物版本不存在');
    const oldArtifact = this.artifactStore.get(oldId, { verify: false });
    const newArtifact = this.artifactStore.get(newId, { verify: false });
    if (!oldArtifact || !newArtifact) throw new Error('输入版本不存在');
    const identical = oldArtifact.contentHash === newArtifact.contentHash;
    if (!identical && options.userConfirmed !== true) throw new Error('内容变化必须由用户明确确认复用');
    const currentRefs = this.dependencyGraph.inputsOf(id);
    if (!currentRefs.some(ref => ref.artifactVersionId === oldId)) throw new Error('产物没有引用旧版本');
    const rebound = currentRefs.map(ref => ref.artifactVersionId === oldId ? { ...ref, artifactVersionId: newId } : ref);
    this.dependencyGraph.setInputs(id, rebound, { auditType: 'dependency-rebound', operationId: options.operationId });
    this.artifactStore.replaceInputRefs(id, rebound, { type: 'artifact-reuse-confirmed' });
    this.artifactStore.updateState(id, { validityState: 'current' }, 'artifact-revalidated');
    const entry = { type: 'reuse-confirmed', artifactVersionId: id, oldVersionId: oldId, newVersionId: newId, identical, userConfirmed: options.userConfirmed === true, at: this.clock() };
    const state = this._load();
    state.audit.push(entry);
    this._save(state);
    return clone(entry);
  }

  audit() { return clone(this._load().audit); }
}

module.exports = { ImpactPropagator };
