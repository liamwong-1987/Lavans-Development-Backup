const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const frontendRoot = path.join(__dirname, '..', '..', 'frontend');
const classicSource = fs.readFileSync(path.join(frontendRoot, 'canvas.js'), 'utf8');
const smartSource = fs.readFileSync(path.join(frontendRoot, 'smart-canvas-core', 'smart-canvas-core.js'), 'utf8');
const smartHtml = fs.readFileSync(path.join(frontendRoot, 'smart-canvas-core', 'smart-canvas.html'), 'utf8');

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `缺少源码标记：${start}`);
  assert.notEqual(endIndex, -1, `缺少源码标记：${end}`);
  return source.slice(startIndex, endIndex);
}

function wheelEvent({ctrlKey = false, deltaY = -120, clientX = 320, clientY = 240, blockedSelector = ''} = {}) {
  const state = {prevented: 0, stopped: 0};
  return {
    event: {
      ctrlKey,
      deltaY,
      clientX,
      clientY,
      target: {
        closest(selector) {
          return blockedSelector && selector.includes(blockedSelector) ? {} : null;
        }
      },
      preventDefault() { state.prevented += 1; },
      stopPropagation() { state.stopped += 1; }
    },
    state
  };
}

function worldAt(viewport, rect, clientX, clientY) {
  return {
    x: (clientX - rect.left - viewport.x) / viewport.scale,
    y: (clientY - rect.top - viewport.y) / viewport.scale
  };
}

function assertSamePoint(actual, expected) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `x 锚点漂移：${actual.x} !== ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `y 锚点漂移：${actual.y} !== ${expected.y}`);
}

test('智能画布快捷键面板明确显示 Ctrl+滚轮', () => {
  assert.match(smartHtml, /<span class="shortcut-keys"><kbd>Ctrl<\/kbd><kbd>滚轮<\/kbd><\/span><span data-i18n="smart\.shortcutZoom">/);
});

test('普通画布只用 Ctrl+滚轮缩放，并在节点与 PROMPT 上保持可用', () => {
  const wheel = sourceSection(classicSource, "board.addEventListener('wheel', e => {", "board.addEventListener('dragover'");

  assert.match(wheel, /if\(!canvas \|\| !e\.ctrlKey[\s\S]*?\) return;[\s\S]*?e\.preventDefault\(\);/);
  assert.match(wheel, /#canvasAssetPanel,#workflowTransferModal/);
  assert.match(wheel, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  assert.match(wheel, /viewport\.scale = viewport\.scale \* \(e\.deltaY > 0 \? \.92 : 1\.08\);/);
  assert.match(wheel, /\}, \{passive:false, capture:true\}\);\s*$/);
  assert.doesNotMatch(wheel, /isEditableTarget/);
});

test('智能画布捕获 Ctrl+滚轮且不让内部滚动区或时间轴抢占', () => {
  const wheel = sourceSection(smartSource, "shell.addEventListener('wheel', e => {", 'shell.ondragover');

  assert.match(wheel, /if\(!e\.ctrlKey[\s\S]*?\) return;[\s\S]*?e\.preventDefault\(\);/);
  assert.match(wheel, /\.smart-agent-drawer/);
  assert.match(wheel, /\.prompt-expand-modal/);
  assert.match(wheel, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  assert.match(wheel, /const factor = Math\.exp\(-e\.deltaY \* 0\.001\);/);
  assert.match(wheel, /\}, \{passive:false, capture:true\}\);\s*$/);
  assert.doesNotMatch(wheel, /textarea,input,select|contenteditable|prompt-node-control|prompt-input|minimax-library-list|minimax-ref-track/);
});

test('普通画布生产处理器保留普通滚动，并在 PROMPT 节点上执行 Ctrl 缩放', () => {
  const wheel = sourceSection(classicSource, "board.addEventListener('wheel', e => {", "board.addEventListener('dragover'");
  const rect = {left: 20, top: 30};
  const viewport = {x: 12, y: 8, scale: 1};
  const calls = {apply: 0, links: 0, selection: 0, save: 0};
  let registration;
  const board = {
    addEventListener(type, handler, options) { registration = {type, handler, options}; },
    getBoundingClientRect() { return rect; }
  };
  vm.runInNewContext(wheel, {
    board,
    canvas: {},
    viewport,
    screenToWorld: (x, y) => worldAt(viewport, rect, x, y),
    applyViewport: () => { calls.apply += 1; },
    renderLinks: () => { calls.links += 1; },
    renderSelectionHub: () => { calls.selection += 1; },
    scheduleViewportSave: () => { calls.save += 1; }
  });

  assert.equal(registration.type, 'wheel');
  assert.equal(registration.options.passive, false);
  assert.equal(registration.options.capture, true);

  const plain = wheelEvent();
  registration.handler(plain.event);
  assert.deepEqual(viewport, {x: 12, y: 8, scale: 1});
  assert.deepEqual(plain.state, {prevented: 0, stopped: 0});

  const excluded = wheelEvent({ctrlKey: true, blockedSelector: '#canvasAssetPanel'});
  registration.handler(excluded.event);
  assert.deepEqual(viewport, {x: 12, y: 8, scale: 1});
  assert.deepEqual(excluded.state, {prevented: 0, stopped: 0});

  const prompt = wheelEvent({ctrlKey: true, clientX: 420, clientY: 330});
  const anchor = worldAt(viewport, rect, prompt.event.clientX, prompt.event.clientY);
  registration.handler(prompt.event);
  assert.equal(viewport.scale, 1.08);
  assertSamePoint(worldAt(viewport, rect, prompt.event.clientX, prompt.event.clientY), anchor);
  assert.deepEqual(prompt.state, {prevented: 1, stopped: 1});
  assert.deepEqual(calls, {apply: 1, links: 1, selection: 1, save: 1});
});

test('智能画布生产处理器让 PROMPT 与节点统一执行 Ctrl 缩放', () => {
  const wheel = sourceSection(smartSource, "shell.addEventListener('wheel', e => {", 'shell.ondragover');
  const rect = {left: 35, top: 25};
  const viewport = {x: 10, y: 15, scale: 1};
  const calls = {apply: 0, save: 0};
  let registration;
  const shell = {
    addEventListener(type, handler, options) { registration = {type, handler, options}; },
    getBoundingClientRect() { return rect; }
  };
  vm.runInNewContext(wheel, {
    shell,
    viewport,
    safeScale: value => Math.max(0.1, Math.min(4, value)),
    applyViewport: () => { calls.apply += 1; },
    scheduleSave: () => { calls.save += 1; }
  });

  assert.equal(registration.type, 'wheel');
  assert.equal(registration.options.passive, false);
  assert.equal(registration.options.capture, true);

  const plainPrompt = wheelEvent();
  registration.handler(plainPrompt.event);
  assert.deepEqual(viewport, {x: 10, y: 15, scale: 1});
  assert.deepEqual(plainPrompt.state, {prevented: 0, stopped: 0});

  const drawer = wheelEvent({ctrlKey: true, blockedSelector: '.smart-agent-drawer'});
  registration.handler(drawer.event);
  assert.deepEqual(viewport, {x: 10, y: 15, scale: 1});
  assert.deepEqual(drawer.state, {prevented: 0, stopped: 0});

  const prompt = wheelEvent({ctrlKey: true, deltaY: -120, clientX: 460, clientY: 360});
  const promptAnchor = worldAt(viewport, rect, prompt.event.clientX, prompt.event.clientY);
  registration.handler(prompt.event);
  assert.ok(Math.abs(viewport.scale - Math.exp(0.12)) < 1e-12);
  assertSamePoint(worldAt(viewport, rect, prompt.event.clientX, prompt.event.clientY), promptAnchor);
  assert.deepEqual(prompt.state, {prevented: 1, stopped: 1});

  Object.assign(viewport, {x: 10, y: 15, scale: 1});
  const node = wheelEvent({ctrlKey: true, deltaY: 140, clientX: 280, clientY: 210});
  const nodeAnchor = worldAt(viewport, rect, node.event.clientX, node.event.clientY);
  registration.handler(node.event);
  assert.ok(Math.abs(viewport.scale - Math.exp(-0.14)) < 1e-12);
  assertSamePoint(worldAt(viewport, rect, node.event.clientX, node.event.clientY), nodeAnchor);
  assert.deepEqual(node.state, {prevented: 1, stopped: 1});
  assert.deepEqual(calls, {apply: 2, save: 2});
});
