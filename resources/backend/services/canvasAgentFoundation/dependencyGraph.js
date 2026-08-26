const fs = require('fs');
const path = require('path');
const { atomicWriteJson, clone, ensureDir, readJson, safeId } = require('./atomicJsonStore');

class DependencyGraph {
  constructor(rootPath, options = {}) {
    this.filePath = path.join(path.resolve(rootPath), 'dependency-graph.json');
    this.clock = options.clock || (() => Date.now());
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) this._save({ schemaVersion: 1, inputsByArtifact: {}, audit: [] });
  }

  _load() {
    const graph = readJson(this.filePath, { schemaVersion: 1, inputsByArtifact: {}, audit: [] });
    graph.inputsByArtifact ||= {};
    graph.audit ||= [];
    return graph;
  }

  _save(graph) { atomicWriteJson(this.filePath, graph); }

  inputsOf(artifactVersionId) {
    const graph = this._load();
    return clone(graph.inputsByArtifact[safeId(artifactVersionId, 'artifactVersionId')] || []);
  }

  dependentsOf(artifactVersionId) {
    const target = safeId(artifactVersionId, 'artifactVersionId');
    const graph = this._load();
    return Object.entries(graph.inputsByArtifact)
      .filter(([, refs]) => refs.some(ref => ref.artifactVersionId === target))
      .map(([id]) => id)
      .sort();
  }

  _hasPath(graph, from, to, visited = new Set()) {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return (graph.inputsByArtifact[from] || []).some(ref => this._hasPath(graph, ref.artifactVersionId, to, visited));
  }

  setInputs(artifactVersionId, refs = [], options = {}) {
    const id = safeId(artifactVersionId, 'artifactVersionId');
    const normalized = refs.map(ref => ({ artifactVersionId: safeId(ref.artifactVersionId, 'inputRef'), role: String(ref.role || 'input') }));
    if (normalized.some(ref => ref.artifactVersionId === id)) throw new Error('依赖关系不能指向自身');
    const graph = this._load();
    const previous = graph.inputsByArtifact[id] || [];
    graph.inputsByArtifact[id] = normalized;
    if (normalized.some(ref => this._hasPath(graph, ref.artifactVersionId, id))) {
      graph.inputsByArtifact[id] = previous;
      throw new Error('检测到循环依赖');
    }
    graph.audit.push({ type: options.auditType || 'dependencies-set', artifactVersionId: id, refs: clone(normalized), operationId: options.operationId || null, at: this.clock() });
    this._save(graph);
    return clone(normalized);
  }

  descendantsOf(artifactVersionId) {
    const root = safeId(artifactVersionId, 'artifactVersionId');
    const queue = this.dependentsOf(root).map(id => ({ id, depth: 1 }));
    const visited = new Map();
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current.id) && visited.get(current.id) <= current.depth) continue;
      visited.set(current.id, current.depth);
      this.dependentsOf(current.id).forEach(id => queue.push({ id, depth: current.depth + 1 }));
    }
    return [...visited.entries()].map(([id, depth]) => ({ artifactVersionId: id, depth })).sort((a, b) => a.depth - b.depth || a.artifactVersionId.localeCompare(b.artifactVersionId));
  }

  snapshot() { return clone(this._load()); }
}

module.exports = { DependencyGraph };
