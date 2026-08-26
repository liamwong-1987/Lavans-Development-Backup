const fs = require('fs');
const path = require('path');
const { atomicWriteJson, clone, ensureDir, readJson } = require('./atomicJsonStore');

class RecoveryAuditor {
  constructor(options = {}) {
    this.rootPath = path.resolve(options.rootPath);
    this.artifactStore = options.artifactStore;
    this.dependencyGraph = options.dependencyGraph;
    this.taskLedger = options.taskLedger;
    this.clock = options.clock || (() => Date.now());
    this.operationsPath = path.join(this.rootPath, 'execution-operations.json');
    this.reportPath = path.join(this.rootPath, 'recovery-report.json');
    ensureDir(this.rootPath);
  }

  registerOperation(operation) {
    const state = readJson(this.operationsPath, { operations: [] });
    const existing = state.operations.find(item => item.operationId === operation.operationId);
    if (existing) return clone(existing);
    const entry = { ...clone(operation), status: operation.status || 'running', createdAt: this.clock(), updatedAt: this.clock() };
    state.operations.push(entry);
    atomicWriteJson(this.operationsPath, state);
    return clone(entry);
  }

  interruptRunningOperations() {
    const state = readJson(this.operationsPath, { operations: [] });
    let changed = 0;
    state.operations.forEach(operation => {
      if (operation.status === 'running') {
        operation.status = 'interrupted';
        operation.updatedAt = this.clock();
        changed += 1;
      }
    });
    atomicWriteJson(this.operationsPath, state);
    return changed;
  }

  audit(options = {}) {
    const issues = [];
    const artifacts = this.artifactStore.list();
    artifacts.forEach(artifact => {
      const validation = this.artifactStore.verify(artifact.artifactVersionId);
      if (!validation.valid) issues.push({ type: 'artifact-invalid', artifactVersionId: artifact.artifactVersionId, message: validation.error });
      this.dependencyGraph.inputsOf(artifact.artifactVersionId).forEach(ref => {
        if (!this.artifactStore.get(ref.artifactVersionId, { verify: false })) issues.push({ type: 'dependency-missing', artifactVersionId: artifact.artifactVersionId, inputVersionId: ref.artifactVersionId });
      });
    });
    const ledger = this.taskLedger?.load();
    if (this.taskLedger) {
      const validation = this.taskLedger.validate(ledger);
      if (!validation.valid) validation.errors.forEach(message => issues.push({ type: 'ledger-invalid', message }));
    }
    const projection = options.projection || null;
    if (projection && projection.artifactCount !== artifacts.length) issues.push({ type: 'projection-mismatch', expected: artifacts.length, actual: projection.artifactCount });
    const report = { schemaVersion: 1, healthy: issues.length === 0, auditedAt: this.clock(), artifactCount: artifacts.length, issues, nextAction: ledger?.nextAction || null };
    atomicWriteJson(this.reportPath, report);
    return clone(report);
  }
}

module.exports = { RecoveryAuditor };
