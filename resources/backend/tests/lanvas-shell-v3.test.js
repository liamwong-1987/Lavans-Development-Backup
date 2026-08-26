const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '..', '..', 'frontend');
const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(frontend, 'lanvas-shell-v3.css'), 'utf8');
const theme = fs.readFileSync(path.join(frontend, 'smart-canvas-core', 'theme.js'), 'utf8');

test('approved shell stylesheet and local icon font are wired after the token and component layers', () => {
  const tokensIndex = html.indexOf('/lanvas-tokens.css');
  const componentsIndex = html.indexOf('/lanvas-components.css');
  const shellIndex = html.indexOf('/lanvas-shell-v3.css');
  assert.ok(tokensIndex >= 0);
  assert.ok(componentsIndex > tokensIndex);
  assert.ok(shellIndex > componentsIndex);
  assert.equal(html.indexOf('/lanvas-unified.css'), -1);
  assert.match(html, /<body[^>]*data-lanvas-page="shell"/);
  assert.ok(fs.existsSync(path.join(frontend, 'assets', 'Phosphor-Duotone.woff2')));
  assert.match(css, /font-family:\s*"Phosphor-Duotone"/);
  assert.match(css, /url\("\/assets\/Phosphor-Duotone\.woff2"\)/);
});

test('global navigation keeps every approved route and the angle-control icon', () => {
  const expected = [
    '文生图', '细节增强', '图片编辑', '角度控制', '在线生图', 'GPT 对话',
    '无限画布', '素材库', '一键复色', 'API 设置', '更多设置', '深浅模式',
    '语言', '工作流设置', '项目主页'
  ];
  let cursor = 0;
  for (const label of expected) {
    const next = html.indexOf(`>${label}<`, cursor);
    assert.ok(next >= cursor, `missing or reordered navigation label: ${label}`);
    cursor = next + label.length;
  }
  assert.match(html, /ph-crosshair-simple[^>]*><\/i><span class="nav-text">角度控制/);
  assert.match(html, /href="https:\/\/github\.com\/hero8152\/Infinite-Canvas"/);
  assert.match(html, /改自大雄画布，致敬原作/);
});

test('logo retains the original pin, hover-expand, memory and accessibility behavior', () => {
  assert.match(html, /id="sidebarLogoToggle"[^>]*onclick="toggleSidebarPinned\(event\)"[^>]*aria-pressed="false"/);
  assert.match(html, /function setSidebarPinned\(pinned, options = \{\}\)/);
  assert.match(html, /function toggleSidebarPinned\(event\)/);
  assert.match(html, /sidebar\.classList\.toggle\('is-pinned', pinned\)/);
  assert.match(html, /localStorage\.setItem\(SIDEBAR_PINNED_KEY, pinned \? '1' : '0'\)/);
  assert.match(html, /const savedPinned = localStorage\.getItem\(SIDEBAR_PINNED_KEY\)/);
  assert.match(css, /\.sidebar:hover,[\s\S]*\.sidebar\.is-pinned\s*\{[\s\S]*width:\s*212px/);
  assert.match(css, /:has\(\.sidebar:hover\) \.shell-brand/);
  assert.match(css, /:has\(\.sidebar\.is-pinned\) \.shell-brand/);
});

test('local and settings groups keep independent folds and remembered state', () => {
  assert.match(html, /id="local-nav-toggle"[^>]*onclick="toggleLocalNav\(\)"[^>]*aria-expanded="true"/);
  assert.match(html, /id="settings-fold-toggle"[^>]*onclick="toggleSidebarSettings\(\)"[^>]*aria-expanded="true"/);
  assert.match(html, /studio_local_nav_collapsed/);
  assert.match(html, /studio_sidebar_settings_collapsed/);
  assert.match(html, /function setLocalNavCollapsed\(collapsed, options = \{\}\)/);
  assert.match(html, /function setSidebarSettingsCollapsed\(collapsed, options = \{\}\)/);
  assert.match(html, /\.nav-fold-group\.is-collapsed/);
  assert.match(html, /\.settings-fold-group\.is-collapsed/);
});

test('expanded shell follows the approved 212 px hierarchy and theme materials', () => {
  assert.match(css, /\.sidebar:hover,[\s\S]*?width:\s*212px/);
  assert.match(css, /font-size:\s*16px !important/);
  assert.match(css, /font-size:\s*22px/);
  assert.match(css, /height:\s*42px !important/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /font-size:\s*11px/);
  assert.match(css, /width:\s*3px/);
  assert.match(css, /linear-gradient\(112deg, #35105a 0%, #5e22a3 54%, #7c45a4 100%\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('dark outer shell and global sidebar use the approved near-black shell material', () => {
  const darkTokens = html.match(/html\.studio-theme-dark\s*\{([\s\S]*?)\n\}/);
  assert.ok(darkTokens, 'dark shell tokens');
  assert.match(darkTokens[1], /--bg:\s*#0b0c0e;/i);
  assert.match(darkTokens[1], /--sidebar-bg:\s*#0b0c0e;/i);
  assert.match(css, /html\.studio-theme-dark body\[data-lanvas-page="shell"\] \.app-shell\s*\{[^}]*background:\s*var\(--lanvas-shell\)\s*!important;?[^}]*\}/);
});

test('recolor dialog scrim covers the complete parent shell without covering the active stage dialog', () => {
  assert.match(css, /recolor-modal-open \.app-shell::after[\s\S]*?background:\s*rgba\(0, 0, 0, \.69\);/);
  assert.match(css, /recolor-modal-open \.app-shell::after\s*\{\s*z-index:\s*60;/);
  assert.match(css, /recolor-modal-open \.stage iframe\.active\s*\{\s*z-index:\s*61;/);
  assert.doesNotMatch(css, /recolor-modal-open \.stage\s*\{[\s\S]*?z-index:\s*61;/);
  assert.match(css, /recolor-modal-open \.window-titlebar::after\s*\{\s*z-index:\s*1000;/);
  assert.doesNotMatch(css, /recolor-modal-open :is\(\.window-titlebar, \.sidebar\)::after/);
});

test('responsive shell fills the viewport while every embedded page stays at 100 percent density', () => {
  assert.match(theme, /function isScaleHost\(\)/);
  assert.doesNotMatch(theme, /function globalViewportScale\(\)/);
  assert.match(theme, /if\(isScaleHost\(\)\) return 1;/);
  assert.match(theme, /if\(isScaleHost\(\)\) return;/);
  assert.match(theme, /const frameMode = isScaleHost\(\) \? '100' : mode;/);
  assert.match(theme, /const frameScale = isScaleHost\(\) \? 1 : appliedScale\(\);/);
  assert.match(theme, /if\(event\.data\?\.type === 'studio-ui-scale'\)\s*\{[\s\S]*?applyScale\(event\.data\.mode\);/);
  assert.doesNotMatch(theme, /if\(event\.data\?\.type === 'studio-ui-scale'\)\s*\{[\s\S]*?setScaleMode\(event\.data\.mode, false\);/);
  assert.match(html, /const mode = document\.body\.classList\.contains\('studio-scale-host'\) \? '100'/);
  assert.match(html, /const scale = document\.body\.classList\.contains\('studio-scale-host'\) \? 1/);

  const routeIds = html.match(/const PAGE_IDS = \[([^\]]+)\]/)?.[1]?.match(/'[^']+'/g) || [];
  assert.equal(routeIds.length, 11, 'all eleven iframe routes remain under the same shell');
  assert.doesNotMatch(html, /syncRecolorStageScale|--lanvas-recolor-stage-scale/);
  assert.doesNotMatch(css, /data-active-page="recolor"/);
  assert.match(css, /body\[data-lanvas-page="shell"\]\s*\{[\s\S]*?width:\s*100%[\s\S]*?height:\s*100vh/);
  assert.doesNotMatch(css, /body\[data-lanvas-page="shell"\]\s*\{[\s\S]*?width:\s*1920px[\s\S]*?height:\s*1080px/);
  assert.doesNotMatch(css, /translate\(-50%,\s*-50%\)\s*scale\(var\(--studio-ui-scale/);
});

test('responsive shell uses the physical viewport without a fixed logical stage', () => {
  assert.match(css, /body\[data-lanvas-page="shell"\] \.app-shell\s*\{[^}]*height:\s*calc\(100vh\s*-\s*48px\)\s*!important/);
  assert.doesNotMatch(css, /body\[data-lanvas-page="shell"\] \.app-shell\s*\{[^}]*height:\s*1032px\s*!important/);
  assert.match(css, /body\[data-lanvas-page="shell"\] \.sidebar\s*\{[\s\S]*?height:\s*100%\s*!important[\s\S]*?max-height:\s*100%\s*!important/);
});
