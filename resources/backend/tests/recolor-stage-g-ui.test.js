const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const frontend = path.join(__dirname, '..', '..', 'frontend');
const html = fs.readFileSync(path.join(frontend, 'recolor.html'), 'utf8');
const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(frontend, 'lanvas-pages.css'), 'utf8');
const tokens = fs.readFileSync(path.join(frontend, 'lanvas-tokens.css'), 'utf8');

test('右侧检查栏使用可拖动且可键盘操作的双图对比', () => {
  assert.match(html, /id="compare-stage"/);
  assert.match(html, /id="compare-slider"[^>]+role="slider"/);
  assert.match(html, /class="compare-stage-label before">模板图/);
  assert.match(html, /class="compare-stage-label after">生成图/);
  assert.match(app, /pointermove/);
  assert.match(app, /ArrowLeft/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /aria-valuenow/);
  assert.match(css, /--compare-position/);
});

test('八个左窄栏操作随任务状态真实启用或置灰', () => {
  for (const id of ['rail-search', 'rail-running', 'rail-failed', 'rail-latest']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function updateRailAvailability/);
  assert.match(app, /updateRailAvailability\(baseTasks\)/);
  assert.match(app, /aria-disabled/);
  assert.match(css, /\.sidebar-link:disabled/);
});

test('当前结果版本导出后在任务行显示明确标识', () => {
  assert.match(app, /exportedResultVersion/);
  assert.match(app, /task-exported-mark/);
  assert.match(app, />?已导出/);
  assert.match(css, /\.task-exported-mark/);
});

test('深浅主题的主操作共用紫色渐变流光语义', () => {
  assert.match(tokens, /--lanvas-action-gradient/);
  assert.match(css, /var\(--lanvas-action-gradient\)/);
  assert.match(css, /prefers-reduced-motion/);
});
