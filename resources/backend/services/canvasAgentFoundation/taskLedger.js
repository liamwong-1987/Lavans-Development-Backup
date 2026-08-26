const fs = require('fs');
const path = require('path');
const { atomicWriteJson, clone, ensureDir, readJson } = require('./atomicJsonStore');

const TASK_STATUSES = new Set(['pending', 'in-progress', 'blocked', 'tested', 'awaiting-user', 'accepted']);

class TaskLedger {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.clock = options.clock || (() => Date.now());
    ensureDir(path.dirname(this.filePath));
  }

  exists() { return fs.existsSync(this.filePath); }

  load() { return readJson(this.filePath, null); }

  validate(ledger) {
    const errors = [];
    if (!ledger || typeof ledger !== 'object') return { valid: false, errors: ['账本必须是对象'] };
    if (Number(ledger.schemaVersion) !== 1) errors.push('schemaVersion 必须为 1');
    if (!Array.isArray(ledger.phases) || ledger.phases.length !== 10) errors.push('账本必须包含 10 个阶段');
    const taskIds = new Set();
    (ledger.phases || []).forEach(phase => {
      (phase.tasks || []).forEach(task => {
        if (!task.id || taskIds.has(task.id)) errors.push(`Task ID 重复或缺失：${task.id || ''}`);
        taskIds.add(task.id);
        if (!TASK_STATUSES.has(task.status)) errors.push(`Task 状态不合法：${task.id}`);
      });
    });
    if (ledger.nextAction !== null) {
      if (!ledger.nextAction || !taskIds.has(ledger.nextAction.taskId)) errors.push('nextAction 必须精确指向一个已存在的 Task');
      const target = (ledger.phases || []).flatMap(phase => phase.tasks || []).find(task => task.id === ledger.nextAction?.taskId);
      if (target && ['accepted'].includes(target.status)) errors.push('nextAction 不能指向已验收 Task');
    }
    return { valid: errors.length === 0, errors };
  }

  save(ledger) {
    const candidate = clone(ledger);
    candidate.updatedAt = this.clock();
    const validation = this.validate(candidate);
    if (!validation.valid) throw new Error(`账本校验失败：${validation.errors.join('；')}`);
    atomicWriteJson(this.filePath, candidate);
    return clone(candidate);
  }

  updateTask(taskId, patch = {}, evidence = null) {
    const ledger = this.load();
    if (!ledger) throw new Error('执行账本不存在');
    const task = ledger.phases.flatMap(phase => phase.tasks || []).find(item => item.id === taskId);
    if (!task) throw new Error('Task 不存在');
    if (patch.status && !TASK_STATUSES.has(patch.status)) throw new Error('Task 状态不合法');
    Object.assign(task, clone(patch));
    task.updatedAt = this.clock();
    if (evidence) {
      task.evidence ||= [];
      task.evidence.push({ ...clone(evidence), recordedAt: this.clock() });
    }
    return this.save(ledger);
  }
}

module.exports = { TASK_STATUSES, TaskLedger };
