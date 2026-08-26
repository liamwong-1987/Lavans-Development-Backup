// 临时验证脚本：抽取并运行真实 arrange 函数，验证三模式放置逻辑（不修改源码）
const fs = require('fs');
const path = require('path');

function extractFunction(src, name) {
  const idx = src.indexOf('function ' + name + '(');
  if (idx < 0) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', idx);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(idx, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function makeRunner(fnSrc, extraGlobals) {
  const factory = new Function(
    'globals',
    `with(globals){ return (${fnSrc}); }`
  );
  return factory(extraGlobals);
}

function rects(nodes) {
  return nodes.map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
}

function noOverlap(nodes, gap) {
  const rs = rects(nodes);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
      const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
      if (overlapX && overlapY) {
        return { ok: false, a, b, msg: `overlap between ${a.id} and ${b.id}` };
      }
    }
  }
  return { ok: true };
}

let passCount = 0, failCount = 0;
function assert(cond, label, extra) {
  if (cond) { passCount++; console.log('  PASS: ' + label); }
  else { failCount++; console.log('  FAIL: ' + label + (extra ? ' | ' + JSON.stringify(extra) : '')); }
}

// ============ 1. canvas.js: arrangeSelectedNodes ============
(function () {
  console.log('\n=== canvas.js arrangeSelectedNodes ===');
  const src = fs.readFileSync(path.join(__dirname, 'canvas.js'), 'utf8');
  const fnSrc = extractFunction(src, 'arrangeSelectedNodes');

  const pad = 18, gap = 4;
  const box = { x: 0, y: 0, w: 600, h: 400 };
  const sizes = [
    { w: 200, h: 100 },
    { w: 150, h: 120 },
    { w: 180, h: 90 },
    { w: 120, h: 80 },
    { w: 260, h: 140 },
  ];

  function runMode(mode) {
    const undoLog = [];
    const renderLog = [];
    const globals = {
      viewport: { scale: 1 },
      board: { clientWidth: 1200, clientHeight: 800 },
      pushUndo: () => { undoLog.push(rects(selNodes).map(r => ({ x: r.x, y: r.y }))); },
      render: () => { renderLog.push(1); },
      scheduleSave: () => {},
    };
    const selNodes = sizes.map((s, i) => ({ id: 'n' + i, x: i * 500, y: i * 300, w: s.w, h: s.h }));
    const before = rects(selNodes).map(r => ({ w: r.w, h: r.h, x: r.x, y: r.y }));
    const fn = makeRunner(fnSrc, globals);
    const ret = fn(mode, selNodes, box);
    return { selNodes, before, undoLog, renderLog, ret, globals };
  }

  // grid
  {
    const { selNodes, before, undoLog, renderLog, ret } = runMode('grid');
    console.log('  [grid] return=' + ret + ' render=' + renderLog.length + ' undo=' + undoLog.length);
    // 列数计算：aspect = sqrt(1200/800)=1.2247; N=5; sqrt(5*1.2247)=sqrt(6.12)=2.47 -> round=2; cols=2 rows=3
    const ov = noOverlap(selNodes, gap);
    assert(ov.ok, 'grid no-overlap', ov.msg);
    // 左对齐顶对齐：每个节点 x 应等于 originX + colX[该列]，即不存在居中偏移
    const originX = box.x + pad, originY = box.y + pad;
    const byCol = [[], []];
    selNodes.forEach((n, i) => byCol[i % 2].push(n));
    const colW = [Math.max(...sizes.filter((_, i) => i % 2 === 0).map(s => s.w)), Math.max(...sizes.filter((_, i) => i % 2 === 1).map(s => s.w))];
    assert(selNodes[0].x === originX && selNodes[0].y === originY, 'grid first node at (originX, originY)', rects(selNodes)[0]);
    // 同列左对齐（x 相同）
    assert(byCol[0].every(n => n.x === byCol[0][0].x), 'grid col0 left-aligned (x equal)', byCol[0].map(n => n.x));
    assert(byCol[1].every(n => n.x === byCol[1][0].x), 'grid col1 left-aligned (x equal)', byCol[1].map(n => n.x));
    // 同行顶对齐（y 相同）：行 r 的 y = originY + rowY[r]
    const rows = {};
    selNodes.forEach((n, i) => { const r = Math.floor(i / 2); (rows[r] = rows[r] || []).push(n); });
    Object.keys(rows).forEach(r => assert(rows[r].every(n => n.y === rows[r][0].y), 'grid row' + r + ' top-aligned (y equal)', rows[r].map(n => n.y)));
    // 尺寸不变
    assert(selNodes.every((n, i) => n.w === before[i].w && n.h === before[i].h), 'grid w/h unchanged');
    // 撤销在改动前调用
    assert(undoLog.length === 1 && JSON.stringify(undoLog[0]) !== JSON.stringify(rects(selNodes).map(r => ({ x: r.x, y: r.y }))), 'grid pushUndo called (snapshot != final)');
  }

  // horizontal
  {
    const { selNodes, before, undoLog, ret } = runMode('horizontal');
    console.log('  [horizontal] return=' + ret);
    const ov = noOverlap(selNodes, gap);
    assert(ov.ok, 'horizontal no-overlap', ov.msg);
    const originY = box.y + pad;
    assert(selNodes.every(n => n.y === originY), 'horizontal all y fixed = originY (top-align)', rects(selNodes).map(r => r.y));
    // x 严格递增
    const xs = selNodes.map(n => n.x);
    assert(xs.every((x, i) => i === 0 || x > xs[i - 1]), 'horizontal x strictly increasing', xs);
    // x 间距 = 前一节点宽 + gap
    assert(selNodes.every((n, i) => i === 0 || n.x === selNodes[i - 1].x + selNodes[i - 1].w + gap), 'horizontal x = prev.x + prev.w + gap');
    assert(selNodes.every((n, i) => n.w === before[i].w && n.h === before[i].h), 'horizontal w/h unchanged');
    assert(undoLog.length === 1, 'horizontal pushUndo called');
  }

  // vertical
  {
    const { selNodes, before, undoLog, ret } = runMode('vertical');
    console.log('  [vertical] return=' + ret);
    const ov = noOverlap(selNodes, gap);
    assert(ov.ok, 'vertical no-overlap', ov.msg);
    const originX = box.x + pad;
    assert(selNodes.every(n => n.x === originX), 'vertical all x fixed = originX (left-align)', rects(selNodes).map(r => r.x));
    const ys = selNodes.map(n => n.y);
    assert(ys.every((y, i) => i === 0 || y > ys[i - 1]), 'vertical y strictly increasing', ys);
    assert(selNodes.every((n, i) => i === 0 || n.y === selNodes[i - 1].y + selNodes[i - 1].h + gap), 'vertical y = prev.y + prev.h + gap');
    assert(selNodes.every((n, i) => n.w === before[i].w && n.h === before[i].h), 'vertical w/h unchanged');
    assert(undoLog.length === 1, 'vertical pushUndo called');
  }
})();

// ============ 2. smart-canvas-core.js: arrangeSelectedSmartNodesByMode ============
(function () {
  console.log('\n=== smart-canvas-core.js arrangeSelectedSmartNodesByMode ===');
  const src = fs.readFileSync(path.join(__dirname, 'smart-canvas-core', 'smart-canvas-core.js'), 'utf8');
  const fnSrc = extractFunction(src, 'arrangeSelectedSmartNodesByMode');

  const pad = 18, gap = 4;
  const box = { x: 100, y: 200 };
  // 节点实际渲染尺寸（nodeRect 返回）
  const nodeSizes = [
    { w: 380, h: 430 },
    { w: 260, h: 180 },
    { w: 460, h: 360 },
    { w: 340, h: 168 },
    { w: 420, h: 460 },
  ];

  function runMode(mode) {
    const selNodes = nodeSizes.map((s, i) => ({ id: 's' + i, x: 0, y: 0, w: 0, h: 0, __w: s.w, __h: s.h }));
    const undoLog = [];
    const globals = {
      canvas: { id: 'test' },
      nodes: selNodes,
      selectedNodeIds: () => selNodes.map(n => n.id),
      isSmartGroupNode: (n) => false,
      nodeRect: (n) => ({ x: n.x, y: n.y, width: n.__w, height: n.__h }),
      viewport: { scale: 1 },
      shell: { clientWidth: 1200, clientHeight: 800 },
      pushUndo: () => { undoLog.push(1); },
      render: () => {},
      scheduleSave: () => {},
      toast: (m) => { globals._toast = m; },
    };
    const before = selNodes.map(n => ({ x: n.x, y: n.y, w: n.__w, h: n.__h }));
    const fn = makeRunner(fnSrc, globals);
    const ret = fn(mode);
    return { selNodes, before, undoLog, ret, globals };
  }

  // grid
  {
    const { selNodes, before, undoLog, ret, globals } = runMode('grid');
    console.log('  [grid] return=' + ret + ' toast=' + globals._toast);
    // no-overlap 用实际 w/h
    const rs = selNodes.map(n => ({ id: n.id, x: n.x, y: n.y, w: n.__w, h: n.__h }));
    let ok = true, msg = '';
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) { ok = false; msg = `${a.id}~${b.id}`; }
    }
    assert(ok, 'smart grid no-overlap', msg);
    // 智能函数内部自算 box(取 nodeRect 的 min x/y,此处均为 0),故起点 = 0 + pad = 18
    const originX = pad, originY = pad;
    assert(selNodes[0].x === originX && selNodes[0].y === originY, 'smart grid first node at origin', { x: selNodes[0].x, y: selNodes[0].y });
    // 左对齐顶对齐（无居中）：节点 x = originX + colX[c]，y = originY + rowY[r]
    // 同列 x 相同
    const cols = 2; // aspect=sqrt(1.5)=1.2247; sqrt(5*1.2247)=2.47->2
    const byCol = [[], []];
    selNodes.forEach((n, i) => byCol[i % cols].push(n));
    assert(byCol[0].every(n => n.x === byCol[0][0].x) && byCol[1].every(n => n.x === byCol[1][0].x), 'smart grid columns left-aligned', [byCol[0].map(n=>n.x), byCol[1].map(n=>n.x)]);
    assert(selNodes.every(n => n.__w > 0 && n.__h > 0), 'smart grid node size intact (w/h not zeroed)');
    assert(undoLog.length === 1, 'smart grid pushUndo called');
    assert(globals._toast === '已按宫格排序', 'smart grid toast correct', globals._toast);
  }

  // horizontal
  {
    const { selNodes, undoLog, ret, globals } = runMode('horizontal');
    console.log('  [horizontal] return=' + ret + ' toast=' + globals._toast);
    const originY = pad;
    assert(selNodes.every(n => n.y === originY), 'smart horizontal all y fixed (top-align)', selNodes.map(n => n.y));
    assert(selNodes.every((n, i) => i === 0 || n.x === selNodes[i - 1].x + selNodes[i - 1].__w + gap), 'smart horizontal x = prev.x + prev.w + gap');
    assert(globals._toast === '已按水平排序', 'smart horizontal toast correct', globals._toast);
    assert(undoLog.length === 1, 'smart horizontal pushUndo called');
  }

  // vertical
  {
    const { selNodes, undoLog, ret, globals } = runMode('vertical');
    console.log('  [vertical] return=' + ret + ' toast=' + globals._toast);
    const originX = pad;
    assert(selNodes.every(n => n.x === originX), 'smart vertical all x fixed (left-align)', selNodes.map(n => n.x));
    assert(selNodes.every((n, i) => i === 0 || n.y === selNodes[i - 1].y + selNodes[i - 1].__h + gap), 'smart vertical y = prev.y + prev.h + gap');
    assert(globals._toast === '已按垂直排序', 'smart vertical toast correct', globals._toast);
    assert(undoLog.length === 1, 'smart vertical pushUndo called');
  }
})();

console.log('\n==== RESULT: PASS=' + passCount + ' FAIL=' + failCount + ' ====');
process.exit(failCount === 0 ? 0 : 1);
