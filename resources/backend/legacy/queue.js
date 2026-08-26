/**
 * queue.js — 任务队列（并发控制 + 重试 + 降速 + 去重）
 */
const api = require('./api');
const fs = require('fs');
const path = require('path');

const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '3');
const RETRY_MAX = parseInt(process.env.RETRY_MAX || '3');

class TaskQueue {
  constructor() {
    this.pending = [];
    this.running = [];
    this.success = [];
    this.failed = [];
    this.totalCost = 0;
    this.totalAttempts = 0;
    this.totalErrors = 0;
    this.active = false;
    this.cancelled = false;
    this.seen = new Set();
    this._concurrency = MAX_CONCURRENCY;
  }

  /** 添加任务（自动去重） */
  add(task) {
    const key = `${task.templateName}_${task.colorName}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    task.id = task.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    task.retries = 0;
    task.status = 'pending';
    this.pending.push(task);
    return true;
  }

  addAll(tasks) {
    let n = 0;
    for (const t of tasks) { if (this.add(t)) n++; }
    return n;
  }

  /** 启动处理 */
  async start(onProgress) {
    if (this.active) return;
    this.active = true;
    this.cancelled = false;

    const workers = [];
    const concurrency = this._concurrency;
    for (let i = 0; i < concurrency; i++) {
      workers.push(this._worker(i, onProgress));
    }
    await Promise.all(workers);
    this.active = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /** 单个 worker */
  async _worker(id, onProgress) {
    while (this.pending.length > 0 && !this.cancelled) {
      this._checkSlowdown();

      const task = this.pending.shift();
      task.status = 'running';
      this.running.push(task);
      this._notify(onProgress);

      try {
        const result = await api.generateImage(task);
        this.running = this.running.filter(t => t.id !== task.id);
        this.totalAttempts++;

        if (result.success) {
          task.status = 'success';
          task.cost = result.cost || 0;
          task.elapsed = result.elapsed || 0;
          this.totalCost += task.cost;
          this.success.push(task);

          // 保存图片到输出目录
          if (result.imageBase64 && task.outputPath) {
            const dir = path.dirname(task.outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(task.outputPath, Buffer.from(result.imageBase64, 'base64'));
          }
        } else {
          task.retries++;
          if (task.retries < RETRY_MAX && !this.cancelled) {
            task.status = 'pending';
            this.pending.push(task);
          } else {
            task.status = 'failed';
            task.error = result.error || '未知错误';
            this.totalErrors++;
            this.failed.push(task);
          }
        }
      } catch (e) {
        this.running = this.running.filter(t => t.id !== task.id);
        this.totalAttempts++;
        task.retries++;
        if (task.retries < RETRY_MAX && !this.cancelled) {
          task.status = 'pending';
          this.pending.push(task);
        } else {
          task.status = 'failed';
          task.error = e.message;
          this.totalErrors++;
          this.failed.push(task);
        }
      }

      this._notify(onProgress);
      await this._sleep(500);
    }
  }

  /** 降速检查 */
  _checkSlowdown() {
    if (this.totalAttempts === 0) return;
    const rate = (this.totalErrors / this.totalAttempts) * 100;
    if (rate > 20 && this._concurrency > 1) {
      this._concurrency = 1;
      console.log(`[QUEUE] 降速: 错误率${rate.toFixed(1)}%, 并发→1`);
    }
  }

  _notify(cb) {
    if (cb) {
      const done = this.success.length + this.failed.length;
      const total = done + this.pending.length + this.running.length;
      cb({
        pending: this.pending.length, running: this.running.length,
        success: this.success.length, failed: this.failed.length,
        total, done, totalCost: this.totalCost,
        progress: total > 0 ? Math.round(done / total * 100) : 0,
        currentTask: this.running[0] || null
      });
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  status() {
    const done = this.success.length + this.failed.length;
    const total = done + this.pending.length + this.running.length;
    return {
      active: this.active, pending: this.pending.length, running: this.running.length,
      success: this.success.length, failed: this.failed.length,
      total, done, totalCost: this.totalCost,
      progress: total > 0 ? Math.round(done / total * 100) : 0,
      currentTask: this.running[0] || null
    };
  }
}

// 全局单例
let instance = null;

function getQueue() {
  if (!instance) instance = new TaskQueue();
  return instance;
}

module.exports = { getQueue, TaskQueue };
