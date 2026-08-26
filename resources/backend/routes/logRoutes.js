// logRoutes.js — 日志读取与用户确认后的定向清空接口
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILES = ['task-runner.log', 'runtime-error.log'];
const MAX_LINES = 200;

function parseLogLine(line, source) {
  // 提取时间
  const timeMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*)\]/);
  const time = timeMatch ? timeMatch[1].slice(11, 19) : '';

  // 解析等级
  let level = 'info';
  if (source === 'runtime') {
    level = 'error';
  } else if (/error|failed|uncaught|unhandled|crash|\u5d29\u6e83/i.test(line)) {
    level = 'error';
  } else if (/warn|warning/i.test(line)) {
    level = 'warning';
  } else if (/completed|task_completed|success|\u5168\u90e8\u5b8c\u6210/i.test(line)) {
    level = 'success';
  }

  // 提取 message（去掉时间前缀）
  let message = line;
  if (timeMatch) {
    message = line.slice(timeMatch[0].length).trim();
  }

  return { time, level, source, message, raw: line.trimEnd() };
}

function readLogFile(filename) {
  const filePath = path.join(LOG_DIR, filename);
  // 路径穿越保护
  if (!filePath.startsWith(LOG_DIR)) return [];
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    // 取最近 200 行
    const recent = lines.slice(-MAX_LINES);
    const source = filename === 'runtime-error.log' ? 'runtime' : 'task-runner';
    return recent.map(line => parseLogLine(line, source));
  } catch (e) {
    return [];
  }
}

module.exports = function() {
  const express = require('express');
  const router = express.Router();

  router.get('/api/logs/recent', (req, res) => {
    try {
      const allLogs = [];
      const files = {};
      for (const file of LOG_FILES) {
        const entries = readLogFile(file);
        allLogs.push(...entries);
        const key = file === 'task-runner.log' ? 'taskRunnerExists' : 'runtimeErrorExists';
        const exists = fs.existsSync(path.join(LOG_DIR, file));
        files[key] = exists;
      }
      // 按时间排序（原始顺序保留，不做二次排序）
      // 限制总行数
      const logs = allLogs.slice(0, MAX_LINES);
      res.json({ ok: true, logs, files });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message, logs: [] });
    }
  });

  router.post('/api/logs/clear', (req, res) => {
    try {
      for (const file of LOG_FILES) {
        const filePath = path.join(LOG_DIR, file);
        if (!filePath.startsWith(LOG_DIR)) continue;
        if (fs.existsSync(filePath)) fs.truncateSync(filePath, 0);
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
};
