const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const frontend = path.join(__dirname, '..', '..', 'frontend');
const html = fs.readFileSync(path.join(frontend, 'recolor.html'), 'utf8');
const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(frontend, 'lanvas-pages.css'), 'utf8');
const tokens = fs.readFileSync(path.join(frontend, 'lanvas-tokens.css'), 'utf8');

test('内层窄栏保留八个真实操作入口', () => {
  const rail = html.match(/<nav class="sidebar[^"]*"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.equal((rail.match(/class="sidebar-link/g) || []).length, 8);
  for (const label of ['提示词设置', '历史结果', '展开或收起上传区', '搜索任务', '只看生成中', '只看失败', '查看最新生成结果', '右侧检查栏开关']) {
    assert.match(rail, new RegExp(`aria-label="${label}"`));
  }
});

test('正式操作不再调用浏览器默认确认框或提示框', () => {
  assert.doesNotMatch(app, /\b(?:confirm|alert)\s*\(/);
  assert.match(app, /askRecolorConfirmation/);
  assert.match(css, /\.recolor-confirm-modal/);
});

test('历史、导出、提示词和三图检查使用正式界面', () => {
  for (const marker of ['openRecolorHistory', 'confirmRecolorHistoryDelete', 'openRecolorExportModal', 'promptProfileEffectiveMessage', 'applyRowPreviewZoom']) {
    assert.match(app, new RegExp(marker));
  }
  for (const marker of ['.history-grid', '.export-modal-layout', '.prompt-price-row', '#rv-row img']) {
    assert.match(css, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('并发与运行中关闭规则已进入正式入口', () => {
  assert.match(app, /recolorConcurrency\s*=\s*8/);
  assert.match(app, /Math\.min\(8,\s*Math\.max\(3/);
  assert.match(app, /缩小到后台继续/);
  assert.match(app, /暂停并退出/);
});

test('深浅主题共用结构并保留不同材质强度', () => {
  assert.match(tokens, /html\[data-theme="dark"\]/);
  assert.match(css, /--lanvas-action-gradient/);
  assert.match(css, /data-lanvas-page="recolor"/);
  assert.match(css, /prefers-reduced-motion/);
});
