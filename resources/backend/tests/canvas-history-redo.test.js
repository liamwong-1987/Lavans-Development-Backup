const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'canvas.js'), 'utf8');

function sourceSection(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `缺少源码标记：${start}`);
  assert.notEqual(endIndex, -1, `缺少源码标记：${end}`);
  return source.slice(startIndex, endIndex);
}

test('经典画布支持撤销后的通用重做', () => {
  assert.match(source, /let undoStack = \[\];\s*let redoStack = \[\];/);

  const pushUndo = sourceSection('function pushUndo(){', 'function performUndo(){');
  assert.match(pushUndo, /undoStack\.push\(canvasHistorySnapshot\(\)\);/);
  assert.match(pushUndo, /redoStack\.length = 0;/);

  const performUndo = sourceSection('function performUndo(){', 'function performRedo(){');
  assert.match(performUndo, /redoStack\.push\(canvasHistorySnapshot\(\)\);/);
  assert.match(performUndo, /const state = undoStack\.pop\(\);/);

  const performRedo = sourceSection('function performRedo(){', 'function cloneNode(');
  assert.match(performRedo, /undoStack\.push\(canvasHistorySnapshot\(\)\);/);
  assert.match(performRedo, /const state = redoStack\.pop\(\);/);

  assert.match(source, /e\.shiftKey\s*\?\s*performRedo\(\)\s*:\s*performUndo\(\)/);
  assert.match(source, /key === 'y'[\s\S]*?performRedo\(\)/);
});
