const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '..', '..', 'frontend');
const html = fs.readFileSync(path.join(frontend, 'recolor.html'), 'utf8');
const css = fs.readFileSync(path.join(frontend, 'lanvas-recolor-v3.css'), 'utf8');
const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const shellCss = fs.readFileSync(path.join(frontend, 'lanvas-shell-v3.css'), 'utf8');
const tokensCss = fs.readFileSync(path.join(frontend, 'lanvas-tokens.css'), 'utf8');
const backend = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(backend, 'server.js'), 'utf8');

function hexRgb(value) {
  const hex = String(value || '').replace('#', '');
  return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
}

function relativeLuminance(value) {
  return hexRgb(value).map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(foreground, background) {
  const [bright, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

test('inner recolor document opts out of legacy studio scaling and loads the scoped V3 layer', () => {
  assert.match(html, /data-studio-scale="off"/);
  assert.match(html, /data-lanvas-page="recolor"/);
  assert.match(html, /lanvas-recolor-v3\.css/);
  assert.match(css, /body\[data-lanvas-page="recolor"\]/);
  assert.match(css, /transform:\s*none\s*!important/);
});

test('all eight approved rail shortcuts retain real behavior bindings', () => {
  const bindings = [
    'togglePromptPanel()',
    'openRecolorHistory()',
    'toggleUploadCompact()',
    'focusTaskSearch()',
    "setTaskFilterFromRail('running')",
    "setTaskFilterFromRail('failed')",
    'openLatestGeneratedPreview()',
    'toggleRightSidebar()',
  ];
  for (const binding of bindings) assert.ok(html.includes(binding), binding);
  assert.equal((html.match(/class="sidebar-link/g) || []).length, 8);
  assert.match(html, /class="sidebar-link[^"]*\bactive\b[^"]*" id="rail-upload"/);
  assert.match(html, /class="sidebar-link[^"]*\bactive\b[^"]*\brail-inspector\b[^"]*" id="rail-inspector"/);
});

test('V3 desktop geometry preserves the approved three-column workbench', () => {
  assert.match(css, /--recolor-rail:\s*64px/);
  assert.match(css, /--recolor-inspector:\s*356px/);
  assert.match(css, /grid-template-columns:\s*var\(--recolor-rail\)\s+minmax\(0,\s*1fr\)\s+var\(--recolor-inspector\)/);
  assert.match(css, /@media\s*\(max-width:\s*1280px\)/);
});

test('recolor shares the responsive 100 percent shell instead of owning a private scale branch', () => {
  assert.match(index, /setAttribute\('data-active-page', id\)/);
  assert.doesNotMatch(index, /syncRecolorStageScale|--lanvas-recolor-stage-scale/);
  assert.doesNotMatch(shellCss, /data-active-page="recolor"/);
  assert.match(shellCss, /body\[data-lanvas-page="shell"\]\s*\{[\s\S]*?width:\s*100%[\s\S]*?height:\s*100vh/);
  assert.doesNotMatch(shellCss, /body\[data-lanvas-page="shell"\]\s*\{[\s\S]*?width:\s*1920px[\s\S]*?height:\s*1080px/);
  assert.doesNotMatch(shellCss, /translate\(-50%,\s*-50%\)\s*scale\(var\(--studio-ui-scale/);
  assert.match(shellCss, /body\[data-lanvas-page="shell"\] \.app-shell\s*\{[\s\S]*?height:\s*calc\(100vh\s*-\s*48px\)\s*!important/);
});

test('homepage typography, task controls, preview and logs retain master dimensions', () => {
  assert.match(css, /body\[data-lanvas-page="recolor"\]\s*\{[\s\S]*?font-size:\s*13px[\s\S]*?line-height:\s*normal/);
  assert.match(css, /\.uc-title\s*\{[\s\S]*?font-size:\s*15px[\s\S]*?line-height:\s*normal/);
  assert.match(css, /\.task-table-head\s*\{[\s\S]*?font-size:\s*11px/);
  assert.match(css, /\.task-template-group\s*\{[\s\S]*?height:\s*30px[\s\S]*?font-size:\s*11px/);
  assert.match(css, /\.task-row-btn\s*\{[\s\S]*?width:\s*32px\s*!important[\s\S]*?min-width:\s*32px\s*!important[\s\S]*?max-width:\s*32px\s*!important[\s\S]*?height:\s*32px\s*!important/);
  assert.match(css, /\.compare-stage\s*\{[\s\S]*?height:\s*auto;[\s\S]*?aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(css, /\.log-entry\s*\{[\s\S]*?grid-template-columns:\s*50px\s+7px\s+minmax\(0,\s*1fr\)[\s\S]*?padding:\s*5px 0/);
});

test('approved main regions and functional bottom actions remain connected', () => {
  for (const id of ['batch-overview', 'upload-compact', 'task-table-panel', 'bottom-actions', 'right-inspector']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /onclick="handleBottomRun\(\)"[^>]+id="ba-run"/);
  assert.match(html, /onclick="openRecolorExportModal\(\)"[^>]+id="ba-export"/);
  assert.match(html, /onclick="softReset\(\)"[^>]+id="ba-soft-reset"/);
  assert.match(html, /onclick="openRecolorConcurrency\(\)"[^>]+id="ba-concurrency"/);
});

test('the two large upload cards keep click, drag-drop, paste-compatible file inputs', () => {
  assert.match(html, /id="tpl-input"[^>]+multiple/);
  assert.match(html, /id="clr-input"[^>]+multiple/);
  for (const binding of [
    "document.getElementById('tpl-input').click()",
    "clearUpload('template')",
    "document.getElementById('clr-input').click()",
    "clearUpload('color')",
    "document.getElementById('clr-crop-input').click()",
  ]) assert.ok(html.includes(binding), binding);
  assert.match(app, /function setupDropZones\(\)/);
  assert.match(app, /addEventListener\('drop'/);
  assert.match(app, /document\.addEventListener\('paste'/);
  assert.match(css, /\.uc-card\s*\{[\s\S]*?min-height:\s*118px/);
  assert.match(css, /\.uc-card\s*\{[\s\S]*?max-width:\s*none\s*!important/);
  assert.match(css, /\.uz input\[type="file"\][\s\S]*?inset:\s*0\s*!important/);
  assert.match(css, /\.uc-card \.uz\s*\{[\s\S]*?position:\s*static\s*!important/);
  assert.match(css, /#workspace-main:has\(#upload-compact\.is-collapsed\)/);
});

test('homepage parity uses local Phosphor duotone icons and the approved right-panel chevrons', () => {
  assert.match(css, /Phosphor-Duotone\.woff2/);
  assert.match(html, /ph-duotone ph-columns/);
  assert.match(html, /ph-duotone ph-caret-double-right/);
  assert.match(html, /ph-duotone ph-caret-double-left/);
  assert.match(html, /ph-duotone ph-images/);
  assert.match(html, /ph-duotone ph-palette/);
  assert.match(html, /ph-duotone ph-caret-right/);
  assert.match(html, /ph-duotone ph-arrows-left-right/);
  assert.match(css, /\.inspector-collapse-btn\s*\{[\s\S]*?border:\s*0\s*!important/);
  assert.match(css, /\.inspector-collapse-btn\s*\{[\s\S]*?width:\s*28px\s*!important/);
});

test('batch cost is one clickable two-line summary using the existing cost modal', () => {
  assert.match(html, /<button class="cost-note batch-cost clickable" id="cost-note"[^>]+onclick="openCostModal\(\)"/);
  assert.match(html, /<span class="batch-cost-copy"><strong>¥0\.00 · 0 次 API 调用<\/strong><span>查看任务执行汇总<\/span><\/span>/);
  assert.match(app, /<strong>' \+ calcCost\(batch\) \+ ' · ' \+ \(totals\.apiAttempts\|\|0\) \+ ' 次 API 调用<\/strong>/);
  assert.doesNotMatch(app, /费用: .*次API/);
  assert.match(css, /\.batch-cost-copy strong\s*\{[\s\S]*?font-size:\s*13px/);
  assert.match(css, /\.batch-cost-copy > span\s*\{[\s\S]*?font-size:\s*10px/);
});

test('both upload cards keep one material when the paste target changes', () => {
  assert.match(html, /class="uc-card drop is-target" id="uc-tpl"/);
  assert.match(html, /class="uc-card drop" id="uc-clr"/);
  assert.match(css, /#upload-compact \.uc-card\s*\{[\s\S]*?background:\s*rgba\(239,\s*229,\s*250,\s*\.48\)\s*!important/);
  assert.doesNotMatch(css, /#upload-compact \.uc-card\.is-target\s*\{/);
  assert.doesNotMatch(css, /\.uc-card:not\(\.is-target\) \.uc-icon/);
  assert.doesNotMatch(css, /参考色卡保持中性/);
  assert.match(app, /let uploadPasteTarget = 'template'/);
  assert.match(app, /setUploadPasteTarget\(type\)/);
  assert.match(app, /const type = uploadPasteTarget/);
  assert.match(app, /type === 'color'\) chooseReferenceUploadMode\(\[file\]/);
  assert.match(app, /else addFiles\(type, \[file\]\)/);
});

test('dark upload cards stay neutral while the concurrency control remains purple', () => {
  assert.match(css, /html\.studio-theme-dark body\[data-lanvas-page="recolor"\] #upload-compact \.uc-card\s*\{[\s\S]*?border-color:\s*var\(--lanvas-line, #30353c\)\s*!important;[\s\S]*?background:\s*var\(--lanvas-surface, #111315\)\s*!important;/);
  assert.match(css, /#ba-concurrency\s*\{[\s\S]*?color:\s*#fff;[\s\S]*?background:\s*linear-gradient\(112deg, #35105a 0%, #5e22a3 54%, #7c45a4 100%\)/);
});

test('all dark recolor scenes share the approved soft material and whole-shell scrim contract', () => {
  assert.match(css, /html\.studio-theme-dark body\[data-lanvas-page="recolor"\]\s*\{[\s\S]*?--lanvas-brand-strong:\s*#c994e7;[\s\S]*?--lanvas-brand-soft:\s*#171a1d;[\s\S]*?--lanvas-line-subtle:\s*#282d33;[\s\S]*?--lanvas-line-strong:\s*#3a4149;[\s\S]*?--recolor-overlay-bg:\s*rgba\(0,\s*0,\s*0,\s*\.69\);/);
  assert.ok(contrastRatio('#c994e7', '#171a1d') >= 4.5, 'dark purple copy must remain readable on the near-black gray material');
  for (const selector of ['recolor-workbench-overlay', 'prompt-modal-overlay', 'img-viewer-overlay', 'cost-modal-overlay']) {
    assert.match(css, new RegExp('\\.' + selector + '[\\s\\S]*?background:\\s*var\\(--recolor-overlay-bg'));
  }
  assert.match(app, /postMessage\(\{ type:'recolor-modal-state', open:Boolean\(open\) \}/);
  assert.match(index, /data\?\.type === 'recolor-modal-state'[\s\S]*?recolor-modal-open/);
  assert.match(shellCss, /\.recolor-modal-open[\s\S]*?background:\s*rgba\(0,\s*0,\s*0,\s*\.69\)[\s\S]*?backdrop-filter:\s*blur\(5px\)/);
});

test('dark prompt lock and next-batch price use readable accent text on near-black gray material', () => {
  assert.match(css, /\.prompt-locked-banner\s*\{[\s\S]*?color:\s*var\(--lanvas-brand-strong,[^)]+\)[\s\S]*?background:\s*var\(--lanvas-brand-soft,[^)]+\)/);
  assert.match(css, /\.billing-rate\.next small\s*\{[\s\S]*?color:\s*var\(--lanvas-brand-strong,[^)]+\)[\s\S]*?background:\s*var\(--lanvas-brand-soft,[^)]+\)/);
  assert.doesNotMatch(css, /--lanvas-brand-strong:\s*#713493;[\s\S]{0,220}--lanvas-brand-soft:\s*#2c2034;/);
});

test('three-image comparison keeps the confirmed effect-image frame and existing task behavior', () => {
  assert.match(app, /class="img-viewer-panel compare-modal"/);
  assert.match(app, /class="img-viewer-header modal-top"/);
  assert.match(app, /class="rv-row tri-grid"/);
  assert.equal((app.match(/class="rv-slot tri-card(?: result)?"/g) || []).length, 3);
  for (const label of ['模板图', '生成图', '参考色图', '下载生成图', '重做']) assert.ok(app.includes(label), label);
  assert.match(css, /\.img-viewer-panel\.compare-modal\s*\{[\s\S]*?width:\s*min\(1500px,[\s\S]*?height:\s*min\(840px,[\s\S]*?padding:\s*18px/);
  assert.match(css, /\.rv-row\.tri-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)[\s\S]*?gap:\s*12px/);
  assert.match(css, /\.rv-slot\.tri-card\s*\{[\s\S]*?grid-template-rows:\s*38px\s+minmax\(0,\s*1fr\)/);
  assert.match(app, /addEventListener\('wheel'/);
  assert.match(app, /ArrowLeft/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /retrySingleTask\(/);
});

test('every task exposes a session-targeted manual HEX editor backed by the existing local-only metadata route', () => {
  assert.match(app, /function openTaskReferenceColorManager\(button\)/);
  assert.match(app, /data-reference-session=/);
  assert.match(app, /data-reference-name=/);
  assert.match(app, /openReferenceColorManager\(\{[\s\S]*?sessionId:[\s\S]*?colorName:[\s\S]*?single:true/);
  assert.match(app, /async function openReferenceColorManager\(options\s*=\s*\{\}\)/);
  assert.match(app, /options\.sessionId/);
  assert.match(app, /options\.colorName/);
  assert.match(app, /未找到同批参考色元数据/);
  assert.match(app, /\/api\/recolor\/reference-colors\/metadata/);
  assert.match(app, /本地吸色只服务列表、筛选、历史与导出命名，不进入提示词、生成 API 或 QC/);
  assert.match(app, /data-reference-index=/);
  assert.match(app, /function showReferenceColorCard\(container, index\)/);
  assert.match(app, /function stepReferenceColorCard\(button, delta\)/);
  assert.match(app, /\.reference-color-card:not\(\[hidden\]\)/);
  assert.match(css, /\.recolor-workbench-modal\.scene-palette\s*\{[^}]*height:\s*min\(649px/);
  assert.match(css, /\.reference-color-card\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('dark paused empty history clear and rebind materials no longer leak light surfaces', () => {
  assert.match(css, /studio-theme-dark[\s\S]*?\.recolor-pause-banner\s*\{[\s\S]*?border-color:\s*#8b7448;[\s\S]*?background:\s*#1e1d19;/);
  assert.match(css, /studio-theme-dark[\s\S]*?\.task-table-empty\s*\{[\s\S]*?border-color:\s*#372846;[\s\S]*?background:\s*#131417;/);
  assert.match(css, /studio-theme-dark[\s\S]*?\.history-delete-one\s*\{[\s\S]*?color:\s*#ed7b83;[\s\S]*?background:\s*var\(--lanvas-surface-subtle, #171a1d\)/);
  assert.match(css, /studio-theme-dark[\s\S]*?\.recolor-confirm-modal\.danger \.recolor-confirm-mark\s*\{[\s\S]*?background:\s*#2b171a;/);
  assert.match(css, /studio-theme-dark[\s\S]*?\.rebind-bind-card\.next\s*\{[\s\S]*?background:\s*#171a1d;/);
  assert.match(css, /studio-theme-dark[\s\S]*?\.rebind-section-head em\s*\{[\s\S]*?color:\s*#e5b354;[\s\S]*?background:\s*#2b2415;/);
  assert.doesNotMatch(css, /\.rebind-bind-card\.next\s*\{[\s\S]*?color-mix\(in srgb, #efe5fa/);
});

test('approved dark scene geometry copy and safe focus are connected to the existing dialogs', () => {
  assert.match(css, /\.cost-modal\s*\{[\s\S]*?width:\s*min\(520px/);
  assert.match(css, /\.recolor-confirm-modal\.scene-redo\s*\{\s*width:\s*min\(808px/);
  assert.match(css, /\.recolor-confirm-modal\.scene-clear\s*\{[\s\S]*?width:\s*min\(808px/);
  assert.match(css, /\.recolor-confirm-modal\.scene-clear \.recolor-confirm-mark\s*\{\s*display:\s*none;/);
  assert.match(app, /title:'彻底清空一键复色数据'/);
  assert.match(app, /confirmText:'确认彻底清空'/);
  assert.match(app, /<b>运行中的远端任务<\/b><br>/);
  assert.match(app, /facts:\[\{ label:'预计费用'[\s\S]*?\{ label:'结果替换'/);
  assert.match(app, /function focusRecolorModal\(container\)/);
  assert.match(app, /var target = container\?\.querySelector\('\[data-safe-focus\]'\);\s*if \(!target\) target = container\?\.querySelector\('button:not\(\[disabled\]\)/);
  assert.match(app, /notifyRecolorModalState\(true\);[\s\S]*?focusRecolorModal\(overlay\)/);
  assert.match(html, /class="cost-modal" role="dialog" aria-modal="true"/);
  assert.match(app, /class="img-viewer-panel compare-modal" role="dialog" aria-modal="true"/);
});

test('all formal recolor dialogs map their real panel center to the complete software window center', () => {
  assert.match(app, /function centerRecolorModalInHost\(container\)/);
  assert.match(app, /window\.parent\.document\.getElementById\('frame-recolor'\)/);
  assert.match(app, /var hostRect = window\.parent\.document\.documentElement\.getBoundingClientRect\(\)/);
  assert.match(app, /var panelCenterX = frameRect\.left \+ \(panelRect\.left \+ panelRect\.width \/ 2\) \* scaleX;/);
  assert.match(app, /var panelCenterY = frameRect\.top \+ \(panelRect\.top \+ panelRect\.height \/ 2\) \* scaleY;/);
  assert.match(app, /hostRect\.left \+ hostRect\.width \/ 2 - panelCenterX/);
  assert.match(app, /hostRect\.top \+ hostRect\.height \/ 2 - panelCenterY/);
  assert.doesNotMatch(app, /window\.parent\.innerWidth \/ 2 - \(frameRect\.left \+ frameRect\.width \/ 2\)/);
  assert.match(app, /var minX = 24 - panelRect\.left;[\s\S]*?var maxY = window\.innerHeight - 24 - panelRect\.bottom;/);
  assert.match(app, /window\.addEventListener\('resize',[\s\S]*?refreshRecolorModalHostCenters/);
  for (const selector of [
    '.recolor-workbench-overlay > .recolor-workbench-modal',
    '.recolor-confirm-overlay > .recolor-confirm-modal',
    '.recolor-confirm-overlay > .generation-confirm-modal',
    '.prompt-modal-overlay > .prompt-modal-panel',
    '.img-viewer-overlay > .img-viewer-panel',
    '.cost-modal-overlay > .cost-modal'
  ]) assert.ok(css.includes(selector), selector);
  assert.match(css, /transform:\s*translate\(var\(--recolor-modal-shift-x, 0px\),\s*var\(--recolor-modal-shift-y, 0px\)\)/);
});

test('export default scene shows live counts without exposing internal upload ids', () => {
  assert.match(app, /options\.total\+' 张可导出'/);
  assert.match(app, /\(options\.uploads \|\| \[\]\)\.length\+' 个批次'/);
  assert.match(app, /id="recolor-export-submit"[\s\S]*?导出 '\+options\.total\+' 张结果/);
  assert.match(app, /displayValue = key === 'uploadBatchId' \? '第 '/);
  assert.match(app, /<strong>第 '\+\(index \+ 1\)\+' 个上传批次<\/strong>/);
});

test('paused, empty and model rebind production UI keep the approved safety gates', () => {
  assert.match(html, /id="recolor-pause-banner"/);
  assert.match(app, /title\.textContent = '已由你暂停'/);
  assert.match(app, /正在确认远端结果，队列已暂停/);
  assert.match(app, /原模型不可用，队列已暂停/);
  assert.match(app, /rebindRequired = batch\.pauseReason === 'model_unavailable' && !batch\.lastModelRebind/);
  assert.match(app, /已安全改绑 ' \+ updated \+ ' 项，队列继续保持暂停/);
  assert.match(app, /task\.modelSnapshot \|\| task\.model/);
  assert.match(css, /data-recolor-pause-visible="true"[\s\S]*?grid-template-rows:\s*78px 64px 118px minmax\(0, 1fr\) 58px/);
  assert.match(css, /\.task-table-empty\s*\{[\s\S]*?background:\s*rgba\(239, 229, 250, \.46\)/);
  assert.match(css, /\.recolor-workbench-modal\.scene-rebind/);
});

test('task log filters and title icon use the approved master labels and material', () => {
  assert.match(app, /all:\s*'全部',\s*info:\s*'信息',\s*success:\s*'完成',\s*warning:\s*'警告',\s*error:\s*'错误'/);
  assert.doesNotMatch(app, /info:\s*'INFO',\s*success:\s*'SUCCESS'/);
  assert.match(css, /\.log-filter-btn\s*\{[\s\S]*?background:\s*transparent\s*!important[\s\S]*?font:\s*500 10px\/1 var\(--lanvas-font-ui, sans-serif\)\s*!important/);
  assert.match(css, /\.log-filter-btn\.active\s*\{[\s\S]*?background:\s*linear-gradient\(135deg, #381548 0%, #64277f 64%, #9d5cba 100%\)\s*!important/);
  assert.match(css, /\.log-panel \.inspector-header > \.ph-file-text\s*\{[\s\S]*?color:\s*var\(--lanvas-text-2, #625b6a\)/);
});

test('dynamic task, log and run controls keep the same duotone icon language', () => {
  assert.match(app, /ph-duotone ph-arrow-clockwise/);
  assert.match(app, /ph-duotone ph-trash/);
  assert.match(app, /runIcon\.classList\.add\('ph-pause'\)/);
  assert.match(app, /runIcon\.classList\.add\('ph-play'\)/);
  assert.match(app, /ph-duotone ph-arrow-right/);
  assert.match(app, /ph-duotone ph-magnifying-glass/);
  assert.match(app, /ph-duotone ph-arrows-left-right/);
});

test('dark theme uses the approved G near-black material', () => {
  for (const token of [
    '--lanvas-canvas: #060708',
    '--lanvas-shell: #0b0c0e',
    '--lanvas-surface-1: #111315',
    '--lanvas-surface-2: #171a1d',
    '--lanvas-surface-3: #1e2226',
    '--lanvas-border-subtle: #282d33',
    '--lanvas-border: #3a4149'
  ]) assert.match(tokensCss, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(css, /--lanvas-canvas:\s*#060708/);
  assert.match(css, /--lanvas-surface:\s*#111315/);
  assert.match(css, /--lanvas-surface-subtle:\s*#171a1d/);
  assert.match(css, /--lanvas-line:\s*#30353c/);
});

test('task toolbar keeps the four approved quick filters only', () => {
  const block = app.match(/const FILTER_OPTIONS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'FILTER_OPTIONS');
  assert.deepEqual(
    [...block[1].matchAll(/key:\s*'([^']+)',\s*label:\s*'([^']+)'/g)].map(match => match.slice(1)),
    [['all', '全部'], ['done', '已生成'], ['running', '生成中'], ['failed', '失败']]
  );
});

test('selected rail shortcuts use a one-shot sweep while the primary action stays periodic', () => {
  assert.match(css, /animation:\s*recolor-rail-shine\s+\.72s\s+ease-out\s+1/);
  assert.doesNotMatch(css, /recolor-rail-shine[^;]*infinite/);
  assert.match(css, /animation:\s*recolor-primary-sweep\s+3\.4s\s+ease-in-out\s+infinite/);
});

test('task list follows the approved seven-column master and fixed thumbnail rhythm', () => {
  for (const label of ['编号', '模板图', '生成图', '任务', '状态', '操作']) {
    assert.match(html, new RegExp(`<div class="tth-col[^"]*">${label}<\\/div>`), label);
  }
  assert.match(css, /grid-template-columns:\s*44px\s+152px\s+24px\s+152px\s+minmax\(180px,\s*1fr\)\s+150px\s+78px\s*!important/);
  assert.match(css, /\.task-row\s*\{[\s\S]*?height:\s*103px\s*!important/);
  assert.match(css, /\.task-thumb\s*\{[\s\S]*?width:\s*136px\s*!important[\s\S]*?height:\s*78px\s*!important/);
});

test('dynamic and scan tasks use stable template groups without losing task operations', () => {
  assert.match(app, /function recolorTaskSegments\(items\)/);
  assert.ok((app.match(/recolorTaskSegments\(/g) || []).length >= 3);
  assert.match(app, /class="task-template-group(?:\s+group)?"/);
  assert.match(app, /class="task-number(?:\s+number)?"/);
  assert.match(app, /retrySingleTask\(/);
  assert.match(app, /clearSingleTask\(/);
  assert.match(css, /\.task-template-group\s*\{[\s\S]*?position:\s*sticky[\s\S]*?height:\s*30px/);
});

test('task status stays truthful and running uses indeterminate light rather than percentages', () => {
  for (const label of ['等待生成', '生成中', '已生成', '生成失败']) assert.ok(app.includes(label), label);
  assert.match(app, /function recolorTaskStatusView\(item\)/);
  assert.doesNotMatch(app, /正在调用模型/);
  assert.match(app, /status === 'running'\) return \{ key:'running', label:'生成中', detail:'', full:'生成中' \}/);
  assert.match(app, /ph-duotone ph-spinner-gap task-running-icon/);
  assert.doesNotMatch(app, /gaStatus\.textContent = '生成中 ' \+ totals\.done/);
  assert.match(css, /\.task-running-icon\s*\{[\s\S]*?font-size:\s*16px[\s\S]*?animation:\s*recolor-running-spin/);
  assert.match(css, /\.task-running-shine\s*\{[\s\S]*?width:\s*104px\s*!important/);
  assert.match(css, /\.task-running-shine::after[\s\S]*?animation:\s*recolor-running-shine/);
  assert.doesNotMatch(app, /task-running-shine[^\n]*%/);
});

test('existing tasks backfill referenceHex from same-session metadata and never fake missing colors', () => {
  assert.match(app, /const referenceMetadataBySession = new Map\(\)/);
  assert.match(app, /function backfillBatchReferenceMetadata\(batch\)/);
  assert.match(app, /task\.uploadBatchId \|\| task\.sessionId/);
  assert.match(app, /task\.colorRef \|\| task\.colorName \|\| task\.colorNameWithoutExt/);
  assert.match(app, /task\.referenceHex = metadata\.hex/);
  assert.match(app, /await hydrateBatchReferenceMetadata\(result\.batch\)/);
  assert.match(app, /const colorHex = normalizedReferenceHex\(task\.referenceHex\)/);
  assert.doesNotMatch(app, /const colorHex = task\.colorHex \|\| task\.referenceHex/);
  assert.match(app, /const colorHexCopy = colorHex \|\| '未设置色号'/);
  assert.match(app, /task-color-swatch is-unset/);
  assert.match(css, /\.task-color-swatch\.is-unset\s*\{[\s\S]*?linear-gradient/);
});

test('automatic HEX remains local metadata and never enters generation API, prompts, or QC', () => {
  const localOnlyFiles = ['apiClient.js', 'promptComposer.js', 'qcEngine.js'];
  for (const file of localOnlyFiles) {
    const source = fs.readFileSync(path.join(backend, file), 'utf8');
    assert.doesNotMatch(source, /referenceHex|referenceColorLabel/, file);
  }
  assert.match(app, /本地吸色只服务列表、筛选、历史与导出命名，不进入提示词、生成 API 或 QC/);
  assert.doesNotMatch(app, /colorOverrides\s*:/);
  assert.doesNotMatch(server, /req\.body\.colorOverrides|resolveTargetColor/);
  assert.match(server, /本地 HEX 只用于展示与导出命名，不进入生成或 QC/);
  assert.match(app, /normalizedReferenceHex\(item\.referenceHex\) \|\| getReferenceColorHex\(colorName\)/);
  assert.match(app, /normalizedReferenceHex\(task\.referenceHex\) \|\| getReferenceColorHex/);
});
