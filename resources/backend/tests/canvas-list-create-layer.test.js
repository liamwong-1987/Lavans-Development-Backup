const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.resolve(__dirname, '../../frontend/canvas-list.css'), 'utf8');

test('new-canvas card stacking context stays above the empty-state action', () => {
  const worldRule = css.match(/\.ws-board-world\s*\{([^}]*)\}/);
  assert.ok(worldRule, 'missing .ws-board-world rule');
  assert.match(worldRule[1], /z-index\s*:\s*1\s*;/);
});
