let step = 1;
let scanData = null;
let valData = null;
let batchId = null;
let genDone = false;
let pollTimer = null;
let scanPairs = null; // 扫描预览任务数据（不消耗API）
let taskFilter = 'all'; // 任务状态筛选
let taskSearchQuery = ''; // 任务搜索关键词
let extraPrompt = ''; // 附加提示词
let promptProfiles = [];
let selectedPromptProfileId = 'bedding';
const CLOTHING_PROMPT = '在不改变原始构图、光照、材质结构与细节的前提下，将参考图1中的衣服颜色精准映射为参考图2的衣服颜色风格，使其呈现一致的综合色调与真实摄影级换色效果。要求只改变衣服的底色，衣服上的图案与文字，以及衣服细节如领口、袖子、版型、材质等必须保持一致。';
const EXTRA_PROMPT_DEFAULT = `Precisely recolor only the bedding product (duvet cover, pillowcase, sheet set) to match the provided reference color image. STRICTLY preserve: original composition, camera angle, background scene, lighting direction and intensity, fabric weave texture, natural wrinkles and folds, cast shadows, product silhouette and shape, and ALL non-bedding elements (room, furniture, props, packaging). CRITICAL: match the reference color's hue, saturation, and brightness exactly — do not shift toward any other tone. For satin/sateen fabrics: retain the characteristic glossy sheen and light reflection pattern. For matte cotton/linen: retain the soft diffuse surface texture. Do NOT add new objects, remove existing objects, alter room decor, modify props, change packaging layout, or shift image perspective. Output must maintain realistic professional e-commerce product photography quality suitable for marketplace listing.`;
const filesStore = { template: [], color: [] };
let logLevelFilter = 'all'; // 日志等级筛选
let logPinned = false; // 日志是否固定
let pinnedTaskId = null; // 固定的任务ID
let pinnedLogIndex = -1; // 固定的日志条目索引
let latestLogs = []; // 缓存最近拉取的日志
let lastTaskStatusMap = {}; // 记录上次渲染时的任务状态（用于检测状态变化）
let userSelectedTaskId = null; // 用户手动选中的任务 ID
let autoSelectSuppressed = false; // 用户手动选任务后，不再自动选中无关任务
let taskSort = 'default'; // 任务排序方式
const DEFAULT_COL_WIDTHS = { select:36, thumb:120, name:140, status:64, progress:110, color:70, actions:130 }; // px
let wbModalType = null; // 当前弹窗类型
let wbModalPage = 1; // 弹窗分页页码
let wbModalPageSize = 20; // 弹窗每页数量
let wbModalColorFilter = 'all'; // 弹窗颜色筛选
let userApiPriceFen = 0; // 用户手动设置的API单价（分），0=使用默认
let userDiscountRate = 0;  // 折扣率（0-100），0=无折扣
let userTaxRate = 0;       // 税率（0-100），0=不含税
let currentTheme = 'dark';
// === 打通画布 Provider:复色生成的 Provider/模型/尺寸/质量/数量选择（默认走 APIMART，质量默认 LOW）===
let recolorProviderId = 'apimart'; // 默认 APIMART
let recolorModel = ''; // 默认空 = 使用 Provider 第一个模型
let recolorSize = '1024x1024'; // 默认 1:1
let recolorQuality = 'low'; // 默认 LOW
let recolorQuantity = 0; // 默认 0 = 全部配对
let recolorConcurrency = 8; // 默认同时生成 8 张，可在 3～8 之间调整
let recolorProviders = []; // 画布 Provider 列表缓存
let referenceCropState = null; // 同批参考色裁剪窗口状态（归一化坐标）
let pendingReferenceCropPlan = null; // 裁剪确认后、实际上传前的本地计划
let pendingReferenceUploadFiles = []; // 拖放/粘贴参考色时等待用户选择上传方式
let uploadPasteTarget = 'template'; // 记忆最后点击、聚焦或拖入的上传卡
let pendingModelRebindState = null; // 模型不可用暂停时的只读预览与一次性确认状态
let recolorModalReturnFocus = null; // 浮层关闭后恢复到正式入口

function applyActiveSystemShell() {
  const params = new URLSearchParams(window.location.search);
  const system = params.get('system') === 'canvas' || params.get('mode') === 'canvas'
    ? 'canvas'
    : (params.get('system') === 'creative' || params.get('mode') === 'creative' ? 'creative' : 'recolor');
  document.body?.setAttribute('data-active-system', system);
  document.documentElement?.setAttribute('data-active-system', system);
  document.getElementById('sidebar')?.setAttribute('data-active-mode', system);
  return system;
}

function updateWindowMaximizeState(maximized) {
  const button = document.getElementById('window-maximize');
  if (!button) return;
  const label = maximized ? '还原窗口' : '最大化';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = maximized
    ? '<span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="8" width="10" height="10"></rect><path d="M9 8V5h10v10h-4"></path></svg></span>'
    : '<span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10"></rect></svg></span>';
}

function windowMinimize() {
  window.lavansWindow?.minimize?.();
}

function windowToggleMaximize() {
  window.lavansWindow?.toggleMaximize?.();
}

function hasActiveRecolorWork() {
  var batch = window.__currentBatch;
  if (!batch?.active || !Array.isArray(batch.tasks)) return false;
  return batch.tasks.some(function(task) {
    var state = task.executionStatus || task.status;
    return state === 'running' || state === 'pending' || state === 'queued';
  });
}

function windowClose() {
  if (!hasActiveRecolorWork()) return window.lavansWindow?.close?.();
  openRecolorOverlay(
    '任务仍在生成',
    '<div class="window-close-choice"><span class="recolor-confirm-mark" aria-hidden="true">Ⅱ</span><div><strong>生成任务可以继续在后台运行</strong><p>缩小窗口不会中断任务。若选择暂停并退出，已经提交给 API 的任务仍可能完成并产生费用。</p></div></div>',
    '<button class="btn bs" data-safe-focus onclick="closeRecolorOverlay()">取消</button><button class="btn bs" onclick="minimizeRecolorToBackground()">缩小到后台继续</button><button class="btn bd" onclick="pauseRecolorAndCloseWindow()">暂停并退出</button>'
  );
}

function minimizeRecolorToBackground() {
  closeRecolorOverlay();
  window.lavansWindow?.minimize?.();
}

async function pauseRecolorAndCloseWindow() {
  var currentBatchId = window.__currentBatch?.batchId || batchId;
  var button = document.activeElement;
  if (button instanceof HTMLButtonElement) { button.disabled = true; button.textContent = '暂停中…'; }
  if (currentBatchId) {
    try { await api(`/api/batches/${encodeURIComponent(currentBatchId)}/pause`, {}); } catch (error) {}
  }
  closeRecolorOverlay();
  window.lavansWindow?.close?.();
}

async function initWindowControls() {
  if (!window.lavansWindow) return;
  try { updateWindowMaximizeState(await window.lavansWindow.isMaximized()); } catch (error) {}
  window.lavansWindow.onWindowState?.(state => updateWindowMaximizeState(Boolean(state?.maximized)));
}

// ===== TaskStore 统一数据代理层 =====
// 只读出口，不替代 scanPairs / batch.tasks，不破坏现有渲染逻辑
const taskStore = {
  version: 'v7-store',

  // 获取当前全部任务（scan preview + batch 合并）
  getAllTasks() {
    const batch = window.__currentBatch;
    if (batch && batch.tasks) {
      return batch.tasks.filter(t => !t.hiddenInTaskList && t.executionStatus !== 'deleted');
    }
    // 无 batch 时返回 scan preview
    return (scanPairs || []).map((p, i) => ({
      id: p.id || ('scan-' + i),
      templateNameWithoutExt: p.templateNameWithoutExt,
      colorNameWithoutExt: p.colorNameWithoutExt,
      template: p.templateName,
      colorRef: p.colorName,
      executionStatus: 'pending',
      isScanPreview: true,
      _pair: p
    }));
  },

  // 按 id 查找单个任务
  getTaskById(taskId) {
    if (!taskId) return null;
    const batch = window.__currentBatch;
    if (batch && batch.tasks) {
      return batch.tasks.find(t => t.id === taskId) || null;
    }
    const pair = (scanPairs || []).find(p => p.id === taskId);
    if (pair) return { id: pair.id, templateNameWithoutExt: pair.templateNameWithoutExt, colorNameWithoutExt: pair.colorNameWithoutExt, executionStatus: 'pending', isScanPreview: true, _pair: pair };
    return null;
  },

  // 获取当前选中任务
  getSelectedTask() {
    if (!selectedTaskId) return null;
    return this.getTaskById(selectedTaskId);
  },

  // 统计信息
  getStats() {
    const batch = window.__currentBatch;
    if (batch && batch.totals) return { ...batch.totals, hasCompleted: batch.totals.success > 0, hasFailed: batch.totals.failed > 0, hasPending: (batch.totals.pending || 0) > 0 };
    const pairs = scanPairs || [];
    return { total: pairs.length, pending: pairs.length, success: 0, failed: 0, running: 0, done: 0, hasCompleted: false, hasFailed: false, hasPending: pairs.length > 0 };
  },

  // 获取 BatchId
  getBatchId() {
    const batch = window.__currentBatch;
    return batch ? batch.batchId : (batchId || null);
  },

  // 判断是否为 scan preview 模式
  isScanPreview() {
    return !window.__currentBatch || !window.__currentBatch.tasks;
  }
};

const $ = id => document.getElementById(id);
const IMG_RE = /\.(jpg|jpeg|png|webp|bmp)$/i;
// ===== STEP 1: 任务状态标准化 =====
const STATUS_COMPLETED = 'completed', STATUS_FAILED = 'failed', STATUS_CANCELLED = 'cancelled', STATUS_PENDING = 'pending', STATUS_RUNNING = 'running';
function nstatus(task) {
  const s = normalizeTaskStatus(task);
  if (['done','success','completed','finished'].indexOf(s) >= 0) return STATUS_COMPLETED;
  if (['failed','error'].indexOf(s) >= 0) return STATUS_FAILED;
  if (['cancelled','canceled','interrupted','stopped'].indexOf(s) >= 0) return STATUS_CANCELLED;
  if (['running','generating','processing'].indexOf(s) >= 0) return STATUS_RUNNING;
  return STATUS_PENDING;
}
// ===== STEP 2: 统一过滤入口 =====
function filterTasks(batch, fn) {
  return (batch?.tasks || []).filter(fn);
}
const money = fen => `¥${(Number(fen || 0) / 100).toFixed(2)}`;
// ===== 金额计算引擎 =====
// 公式链：单价(分) → 小计 → 折扣后 → 税额 → 含税总价
// 无循环依赖：每条链单向计算
const calcPrice = (batch) => {
  const attempts = batch.totals?.apiAttempts || batch.totals?.done || 0;
  const firstLockedTask = (batch.tasks || []).find(task => Number(task.lockedUnitPriceFen || task.costPerCallFen) > 0);
  const lockedUnitFen = Number(batch.lockedUnitPriceFen || batch.executionSnapshot?.costPerCallFen || firstLockedTask?.lockedUnitPriceFen || firstLockedTask?.costPerCallFen || 0);
  const unitFen = lockedUnitFen || (userApiPriceFen > 0 ? userApiPriceFen : 0);
  const nextUnitFen = userApiPriceFen > 0 ? userApiPriceFen : 0;
  const defaultTotal = batch.totals?.costFen || 0;
  // 小计 Subtotal = 单价 × API调用次数
  const subtotalFen = defaultTotal > 0 ? defaultTotal : (unitFen > 0 ? unitFen * attempts : 0);
  // 折扣后 Discounted = Subtotal × (1 - 折扣率/100)
  const discountRate = userDiscountRate || 0;
  const discountedFen = Math.round(subtotalFen * (1 - discountRate / 100));
  // 税额 Tax = Discounted × (税率/100)
  const taxRate = userTaxRate || 0;
  const taxFen = Math.round(discountedFen * (taxRate / 100));
  // 含税总价 Grand Total = Discounted + Tax
  const grandFen = discountedFen + taxFen;
  return {
    unitFen, nextUnitFen, lockedUnitFen, attempts,
    subtotalFen, discountedFen, taxFen, grandFen,
    discountRate, taxRate,
    // 快捷格式化
    subtotal: money(subtotalFen),
    discounted: money(discountedFen),
    tax: money(taxFen),
    grand: money(grandFen),
  };
};
// 旧兼容别名
const calcCost = (batch) => calcPrice(batch).grand;
const fileSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const formatTime = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function recolorTaskShortId(item) {
  const preferred = String(item?.displayId || item?.shortId || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (preferred) return preferred.slice(-4).padStart(4, '0');
  const cleaned = String(item?.id || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return cleaned ? cleaned.slice(-4).padStart(4, '0') : '—';
}

function recolorTaskClock(item) {
  const value = item?.startedAt || item?.createdAt || item?.queuedAt;
  if (!value) return '待开始';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '待开始';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const referenceMetadataBySession = new Map();

function normalizedReferenceHex(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toUpperCase() : '';
}

function cacheReferenceMetadata(sessionId, references) {
  const index = new Map();
  for (const reference of references || []) {
    const hex = normalizedReferenceHex(reference?.referenceHex);
    if (!hex || !reference?.name) continue;
    const metadata = { hex, label:String(reference.referenceColorLabel || '').slice(0, 80) };
    index.set(String(reference.name), metadata);
    const shortName = String(reference.name).replace(/\.[^.]+$/, '');
    if (shortName && !index.has(shortName)) index.set(shortName, metadata);
  }
  referenceMetadataBySession.set(String(sessionId || ''), index);
}

function backfillBatchReferenceMetadata(batch) {
  for (const task of batch?.tasks || []) {
    const currentHex = normalizedReferenceHex(task.referenceHex);
    if (currentHex) {
      task.referenceHex = currentHex;
      continue;
    }
    const sessionId = String(task.uploadBatchId || task.sessionId || '');
    const colorName = String(task.colorRef || task.colorName || task.colorNameWithoutExt || '');
    const metadata = referenceMetadataBySession.get(sessionId)?.get(colorName)
      || referenceMetadataBySession.get(sessionId)?.get(colorName.replace(/\.[^.]+$/, ''));
    if (!metadata?.hex) continue;
    task.referenceHex = metadata.hex;
    if (!task.referenceColorLabel && metadata.label) task.referenceColorLabel = metadata.label;
  }
  return batch;
}

async function hydrateBatchReferenceMetadata(batch) {
  const sessionIds = new Set((batch?.tasks || [])
    .filter(task => !normalizedReferenceHex(task.referenceHex))
    .map(task => task.uploadBatchId || task.sessionId || '')
    .filter(Boolean));
  for (const sessionId of sessionIds) {
    if (referenceMetadataBySession.has(String(sessionId))) continue;
    try {
      const result = await api('/api/recolor/reference-colors?sessionId=' + encodeURIComponent(sessionId));
      if (result?.success) cacheReferenceMetadata(result.sessionId || sessionId, result.references || []);
    } catch (error) {
      console.warn('[referenceHex] 同批参考色元数据读取失败:', error);
    }
  }
  return backfillBatchReferenceMetadata(batch);
}

function recolorTaskSegments(items) {
  return (items || []).reduce(function(groups, item) {
    const templateName = item.template || item.templateName || item.templateNameWithoutExt || '未命名模板';
    const uploadBatchId = item.uploadBatchId || item.sessionId || item.uploadSessionId || '';
    const key = `${uploadBatchId}\u0000${templateName}`;
    const previous = groups[groups.length - 1];
    if (!previous || previous.key !== key) groups.push({ key, templateName, items: [item] });
    else previous.items.push(item);
    return groups;
  }, []);
}

function recolorTaskStatusView(item) {
  const status = normalizeTaskStatus(item || {});
  const error = String(item?.error || item?.errorMessage || '').replace(/\s+/g, ' ').trim();
  if (status === 'running') return { key:'running', label:'生成中', detail:'', full:'生成中' };
  if (status === 'completed') return { key:'completed', label:'已生成', detail:'已生成最新结果', full:'已生成最新结果' };
  if (status === 'failed' || status === 'error') return { key:'failed', label:'生成失败', detail:(error || '生成未完成').slice(0, 22), full:error || '生成未完成' };
  if (status === 'cancelled') return { key:'failed', label:'生成失败', detail:'任务已取消', full:'任务已取消' };
  if (status === 'interrupted') return { key:'failed', label:'生成失败', detail:'任务已中断', full:'任务已中断' };
  return { key:'pending', label:'等待生成', detail:'等待进入队列', full:'等待进入队列' };
}

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

let deleteUndoNotice = null;
function showDeleteUndo(result, fallbackBatchId) {
  if (!result?.token) return toast(`已删除 ${result?.count || 0} 项`, 'ok');
  deleteUndoNotice?.remove();
  const el = document.createElement('div');
  el.className = 'toast wn';
  const message = result.remoteMayContinue
    ? `已移除 ${result.count} 项；远端任务可能仍会执行并计费。`
    : `已移除 ${result.count} 项。`;
  const label = document.createElement('span');
  label.textContent = message;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = '撤销（5秒）';
  undo.style.cssText = 'margin-left:12px;border:0;background:transparent;color:inherit;font-weight:700;cursor:pointer;text-decoration:underline';
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    try {
      const restored = await api('/api/recolor/history/undo', { token: result.token });
      if (!restored.success) throw new Error(restored.error || '撤销失败');
      el.remove();
      deleteUndoNotice = null;
      for (const restoredBatchId of restored.batchIds || [fallbackBatchId]) {
        if (restoredBatchId && restoredBatchId === window.__currentBatch?.batchId) await refreshAndRender(restoredBatchId);
      }
      await refreshRecolorHistoryIfOpen();
      toast(`已恢复 ${restored.count || 0} 项`, 'ok');
    } catch (error) {
      undo.disabled = false;
      toast(error.message || '撤销时间已结束', 'ng');
    }
  });
  el.append(label, undo);
  document.body.appendChild(el);
  deleteUndoNotice = el;
  setTimeout(() => {
    if (deleteUndoNotice === el) deleteUndoNotice = null;
    el.remove();
  }, 5200);
}

function clearRecolorBrowserStorage() {
  const localKeys = new Set([
    'taskSort', 'taskTableColumnWidths',
    'userApiPriceFen', 'userDiscountRate', 'userTaxRate'
  ]);
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith('recolor_') || localKeys.has(key)) localStorage.removeItem(key);
    }
  } catch (error) {}
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith('recolor_')) sessionStorage.removeItem(key);
    }
  } catch (error) {}
}

function setStatus(css, text) {
  $('dot').className = `dot ${css}`;
  $('stxt').textContent = text;
}

function applyTheme(theme) {
  currentTheme = theme === 'light' ? 'light' : 'dark';
  try { localStorage.setItem('lavans-theme', currentTheme); } catch (error) {}
  document.documentElement.dataset.theme = currentTheme;
  // 同步大神侧栏（studio-sidebar）主题类，避免侧栏与主界面深浅色不一致
  const dark = currentTheme === 'dark';
  document.documentElement.classList.toggle('theme-dark', dark);
  document.documentElement.classList.toggle('studio-theme-dark', dark);
  if (document.body) {
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('studio-theme-dark', dark);
  }
  const icon = document.getElementById('theme-toggle-icon');
  const label = document.getElementById('theme-toggle-label');
  const button = document.getElementById('theme-toggle');
  if (icon) icon.innerHTML = currentTheme === 'light'
    ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"></path></svg>';
  if (label) label.textContent = currentTheme === 'light' ? '浅色' : '深色';
  if (button) {
    const nextLabel = currentTheme === 'light' ? '切换深色模式' : '切换浅色模式';
    button.title = nextLabel;
    button.setAttribute('aria-label', nextLabel);
  }
  // 同步大神侧栏「黑夜模式」pill 的图标与文案
  const sideMoon = document.getElementById('icon-moon');
  const sideSun = document.getElementById('icon-sun');
  const sideLabel = document.querySelector('#theme-toggle-btn .side-pill-text');
  if (sideMoon) sideMoon.style.display = dark ? 'none' : 'block';
  if (sideSun) sideSun.style.display = dark ? 'block' : 'none';
  if (sideLabel) sideLabel.textContent = dark ? '白天模式' : '黑夜模式';
}

function getStoredThemePreference() {
  try {
    const value = localStorage.getItem('lavans-theme');
    return value === 'light' || value === 'dark' ? value : null;
  } catch (error) { return null; }
}

async function loadThemePreference() {
  const localTheme = getStoredThemePreference();
  if (localTheme) applyTheme(localTheme);
  try {
    const result = await api('/api/config');
    if (!localTheme && result.success && (result.config?.theme === 'light' || result.config?.theme === 'dark')) {
      applyTheme(result.config.theme);
    }
  } catch (error) {
    console.warn('主题偏好加载失败:', error);
    if (!localTheme) applyTheme('dark');
  }
}

function toggleTheme() {
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  api('/api/config', { theme: nextTheme }).then(result => {
    if (!result.success) toast(result.error || '主题已切换，但配置保存失败', 'wn');
  }).catch(() => {
    toast('主题已切换，本机偏好已保留，但配置保存失败', 'wn');
  });
}

// 监听主壳广播的主题切换（iframe 场景），复色用自己的 data-theme 体系响应
window.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'studio-theme' && (data.theme === 'dark' || data.theme === 'light')) {
    applyTheme(data.theme);
  }
});

async function api(url, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({ success: false, error: `HTTP ${response.status}` }));
  if (!response.ok && !data.error) data.error = `HTTP ${response.status}`;
  return data;
}

function go(target) {
  step = target;
  // 更新旧步骤导航（兼容）
  document.querySelectorAll('.step').forEach(el => {
    el.classList.remove('ac', 'dn');
    if (+el.dataset.s === target) el.classList.add('ac');
    else if (+el.dataset.s < target) el.classList.add('dn');
  });
  // 更新快捷导航高亮（兼容）
  document.querySelectorAll('.quick-nav a').forEach(a => a.classList.remove('act'));
  const activeLink = document.querySelector(`.quick-nav a[data-s="${target}"]`);
  if (activeLink) activeLink.classList.add('act');
  // 更新左侧导航栏高亮
  document.querySelectorAll('.sidebar-link').forEach(a => a.classList.remove('active'));
  const sidebarLink = document.querySelector(`.sidebar-link[data-s="${target}"]`);
  if (sidebarLink) sidebarLink.classList.add('active');
  document.querySelectorAll('.sidebar-mode-link').forEach(link => link.classList.toggle('active', link.dataset.mode === 'recolor'));
  if (target === 4) loadOut();
  persistStateOnly();
}

// 快捷导航点击
function navTo(target) {
  go(target);
}

// 回到顶部按钮显隐
function updateBackTop() {
  const btn = document.getElementById('btn-back-top');
  if (!btn) return;
  btn.classList.toggle('show', window.scrollY > 400);
}

async function persistStateOnly() {
  if (!window.PersistentStore) return;
  await PersistentStore.saveState({
    templateNames: filesStore.template.map(file => file.name),
    colorNames: filesStore.color.map(file => file.name),
    scanData,
    valData,
    batchId,
    genDone,
    step,
    extraPrompt
  });
}

async function persistAll() {
  await persistStateOnly();
  if (!window.PersistentStore) return;
  for (const type of ['template', 'color']) {
    for (const file of filesStore[type]) {
      try {
        await PersistentStore.saveFile(type, file.name, await file.arrayBuffer());
      } catch (error) {
        console.warn('图片持久化失败:', file.name, error);
      }
    }
  }
}

async function restoreBrowserState() {
  if (!window.PersistentStore) return false;
  try {
    const state = await PersistentStore.loadState();
    const tplRecords = await PersistentStore.listFiles('template');
    const colorRecords = await PersistentStore.listFiles('color');
    for (const { name } of tplRecords) {
      const blob = await PersistentStore.loadFile('template', name);
      if (blob) {
        var file = new File([blob], name, { type: blob.type || 'image/jpeg' });
        var normalized = normalizeUploadFile(file, name);
        if (normalized) filesStore.template.push(normalized);
      }
    }
    for (const { name } of colorRecords) {
      const blob = await PersistentStore.loadFile('color', name);
      if (blob) {
        var file = new File([blob], name, { type: blob.type || 'image/jpeg' });
        var normalized = normalizeUploadFile(file, name);
        if (normalized) filesStore.color.push(normalized);
      }
    }
    scanData = state?.scanData || null;
    valData = state?.valData || null;
    batchId = state?.batchId || null;
    genDone = Boolean(state?.genDone);
    extraPrompt = state?.extraPrompt || '';
    if (extraPrompt && document.getElementById('extra-prompt-input')) {
      document.getElementById('extra-prompt-input').value = extraPrompt;
    }
    renderUploadUI('template');
    renderUploadUI('color');
    if (scanData?.pairs) showPairs();
    if (valData) {
      showValResult(valData);
      const btnTogen = $('btn-togen');
      if (btnTogen) btnTogen.disabled = false;
    }
    go(state?.step || 1);
    return filesStore.template.length > 0 || filesStore.color.length > 0;
  } catch (error) {
    console.warn('浏览器状态恢复失败:', error);
    return false;
  }
}

async function restoreLatestBatch() {
  try {
    const result = await api('/api/batches/latest');
    const batch = result.batch;
    if (!batch) return false;
    batchId = batch.batchId;
    genDone = !batch.active && ['completed', 'cancelled'].includes(batch.status);
    await hydrateBatchReferenceMetadata(batch);
    renderBatch(batch);

    // 有活跃/中断批次 → 自动跳到生成面板并显示进度
    if (batch.active || batch.status === 'paused' || batch.status === 'cancelling') {
      go(3);
      startPolling();
    }
    // 如果有未完成批次，显示继续按钮
    if (batch.status === 'paused' && batch.tasks.some(t => ['pending','interrupted'].includes(t.executionStatus))) {
      $('btn-restore').style.display = 'block';
    }
    await persistStateOnly();
    return true;
  } catch {
    return false;
  }
}

// 手动点击继续上次任务
async function restoreAndGo() {
  const result = await api('/api/batches/latest');
  const batch = result.batch;
  if (!batch) { toast('没有未完成的任务', 'wn'); return; }
  batchId = batch.batchId;
  await hydrateBatchReferenceMetadata(batch);
  renderBatch(batch);
  go(3);
  $('btn-restore').style.display = 'none';
  if (batch.status === 'paused' && batch.tasks.some(t => ['pending','interrupted'].includes(t.executionStatus))) {
    await resumeBatch();
  } else {
    startPolling();
  }
}

async function clearAllStorage() {
  if (!await confirmRecolorReset()) return;
  const result = await api('/api/reset-all', {});
  if (!result.success) {
    const failed = Array.isArray(result.failedFiles) && result.failedFiles.length
      ? '\n\n失败文件：\n' + result.failedFiles.slice(0, 8).map(f => `${f.path || '未知路径'}：${f.reason || '未知原因'}`).join('\n')
      : '';
    toast((result.error || '清除失败') + failed, 'ng');
    return;
  }
  filesStore.template = [];
  filesStore.color = [];
  scanPairs = null;
  scanData = null;
  valData = null;
  batchId = null;
  genDone = false;
  window.__currentBatch = null;
  await window.PersistentStore?.clearAll();
  clearRecolorBrowserStorage();
  toast(result.message || '已彻底清空缓存', 'ok');
  location.reload();
}

function handleFilePick(input, type) {
  const files = [...(input.files || [])].filter(file => IMG_RE.test(file.name));
  input.value = '';
  if (!files.length) return toast('请选择图片文件', 'wn');
  addFiles(type, files);
}

function handleReferenceCropPick(input) {
  const files = [...(input.files || [])].filter(file => IMG_RE.test(file.name));
  input.value = '';
  if (!files.length) return toast('请选择参考色图片', 'wn');
  openPendingReferenceCrop(files);
}

function chooseReferenceUploadMode(files, sourceLabel = '拖入') {
  var selectedFiles = [...(files || [])].filter(file => IMG_RE.test(file.name));
  if (!selectedFiles.length) return toast('没有可用的参考色图片', 'wn');
  var count = selectedFiles.length;
  var body = '<div class="reference-upload-choice">'
    +'<button type="button" onclick="commitReferenceUploadMode(\'direct\')"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M12 3v13"></path><path d="m7 8 5-5 5 5"></path><path d="M5 20h14"></path></svg></span><strong>直接添加</strong><small>保持原图，立即加入上传区并自动建立任务</small></button>'
    +'<button type="button" class="recommended" onclick="commitReferenceUploadMode(\'crop\')"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M7 3v14a2 2 0 0 0 2 2h12"></path><path d="M3 7h14a2 2 0 0 1 2 2v12"></path></svg></span><strong>裁剪后添加</strong><small>先设置一次裁剪框，确认批量预览后才上传</small></button>'
    +'</div>';
  openRecolorOverlay('选择参考色添加方式', body, '<button class="btn bs" data-safe-focus onclick="cancelReferenceUploadMode()">取消</button>', {
    scene:'crop', subtitle:sourceLabel+' '+count+' 张参考色图片', badge:count+' 张', modalClass:'reference-upload-choice-modal'
  });
  // openRecolorOverlay 会先清理上一层弹窗；必须在它完成后再保存本次文件，
  // 才能保证拖放/粘贴后两个选项都拿得到真实文件。
  pendingReferenceUploadFiles = selectedFiles;
}

function cancelReferenceUploadMode() {
  pendingReferenceUploadFiles = [];
  closeRecolorOverlay();
}

function commitReferenceUploadMode(mode) {
  var files = pendingReferenceUploadFiles.slice();
  pendingReferenceUploadFiles = [];
  closeRecolorOverlay();
  if (!files.length) return;
  if (mode === 'crop') openPendingReferenceCrop(files);
  else addFiles('color', files);
}

function addFiles(type, incoming, options = {}) {
  const byName = new Map(filesStore[type].map(function(file, index) { return [file.name, index]; }));
  let added = 0;
  let refreshed = 0;

  incoming.forEach(function(file) {
    const idx = byName.get(file.name);
    if (idx !== undefined) {
      // 同名图片允许再次选择：刷新当前上传区文件内容，避免旧 File/旧扫描状态阻断追加任务
      filesStore[type][idx] = file;
      refreshed++;
    } else {
      filesStore[type].push(file);
      byName.set(file.name, filesStore[type].length - 1);
      added++;
    }
  });

  // 上传文件变化后，扫描/校验缓存必须失效，用户可重新扫描生成新任务
  scanPairs = null;
  scanData = null;
  valData = null;
  genDone = false;

  renderUploadUI(type);
  persistAll();
  const parts = [];
  if (added) parts.push(`新增 ${added} 张`);
  if (refreshed) parts.push(`刷新 ${refreshed} 张同名图片`);
  if (!options.silent) toast(parts.length ? parts.join('，') : '图片已刷新');
  if (!options.deferScan) scheduleAutomaticScan();
}

// 用户无需再找“扫描配对”入口：两类素材齐备后，稍作停顿便自动建立本次任务。
// 这里只创建本地任务，不会调用生成模型，也不会产生费用。
let automaticScanTimer = null;
function scheduleAutomaticScan() {
  if (!filesStore.template.length || !filesStore.color.length) return;
  if (automaticScanTimer) clearTimeout(automaticScanTimer);
  automaticScanTimer = setTimeout(function() {
    automaticScanTimer = null;
    if (!scanPairs?.length && filesStore.template.length && filesStore.color.length) {
      var plan = pendingReferenceCropPlan;
      doScan(plan ? { colorFiles: plan.files, referenceCrop: plan.crop, pendingPlan: plan } : {});
    }
  }, 520);
}

function removeFile(type, index) {
  filesStore[type].splice(index, 1);
  renderUploadUI(type);
  persistAll();
}

async function clearUpload(type) {
  filesStore[type] = [];
  await api('/api/upload-clear', { type });
  // 清空扫描预览（上传已变更，需重新扫描）
  scanPairs = null;
  scanData = null;
  // 注意：不清理任务列表！任务列表独立于上传组件，生成中的任务不受影响
  renderUploadUI(type);
  await persistAll();
}

function renderUploadUI(type) {
  const files = filesStore[type];
  const template = type === 'template';
  const countText = $(template ? 'tpl-count-text' : 'clr-count-text');
  const stateText = $(template ? 'tpl-state-text' : 'clr-state-text');
  const clearBtn = $(template ? 'tpl-clear-btn' : 'clr-clear-btn');
  const manageBtn = template ? null : $('clr-manage-btn');
  const cropBtn = template ? null : $('clr-crop-btn');
  const zone = $(template ? 'tuz' : 'cuz');
  if (countText) countText.textContent = `${files.length} 张`;
  if (stateText) {
    if (!files.length) stateText.textContent = '等待添加';
    else if (template) stateText.textContent = '已创建任务';
    else stateText.textContent = `共 ${filesStore.template.length * files.length} 个组合`;
  }
  if (clearBtn) clearBtn.style.display = files.length ? 'inline-block' : 'none';
  if (manageBtn) manageBtn.style.display = 'none';
  if (cropBtn) cropBtn.style.display = 'inline-flex';
  if (zone) zone.classList.toggle('has-files', files.length > 0);

  // 上传预览缩略图
  const card = $(template ? 'uc-tpl' : 'uc-clr');
  card.classList.toggle('has-files', files.length > 0);
  let strip = card.querySelector('.upload-preview-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'upload-preview-strip';
    card.appendChild(strip);
  }
  if (files.length > 0) {
    strip.innerHTML = files.map(f => {
      const url = URL.createObjectURL(f);
      return `<div class="up-thumb" title="${escapeHtml(f.name)}" onclick="openImagePreview('${url}','${escapeHtml(f.name)}','${escapeHtml(f.name)}')">
        <img src="${url}" alt="${escapeHtml(f.name)}">
        <span class="up-thumb-name">${escapeHtml(f.name.length>12?f.name.slice(0,12)+'…':f.name)}</span>
        <button class="up-thumb-del" onclick="event.stopPropagation();removeUploadFile('${type}',${filesStore[type].indexOf(f)});return false">×</button>
      </div>`;
    }).join('');
  } else {
    strip.innerHTML = '';
  }
  updateScanButton();
}

function removeUploadFile(type, index) {
  const files = filesStore[type];
  if (index < 0 || index >= files.length) return;
  files.splice(index, 1);
  renderUploadUI(type);
}

function updateScanButton() {
  const ready = filesStore.template.length > 0 && filesStore.color.length > 0;
  $('btn-scan').disabled = !ready;
  $('btn-scan').textContent = ready
    ? `扫描配对（${filesStore.template.length} 模板 × ${filesStore.color.length} 参考色）`
    : '扫描配对（需先上传）';
}

// ===== 上传文件规范化（IndexedDB 恢复安全兜底） =====
function normalizeUploadFile(item, fallbackName) {
  if (!item) return null;
  if (item instanceof File && item.size > 0) return item;
  if ((item instanceof Blob || item instanceof File) && item.size > 0) {
    var name = item.name || fallbackName || 'upload.png';
    // 确保有扩展名
    if (!name.includes('.')) name += '.png';
    return new File([item], name, {
      type: item.type || 'image/png',
      lastModified: Date.now()
    });
  }
  return null;
}

async function uploadToServer(type, options = {}) {
  const form = new FormData();
  const sourceFiles = Array.isArray(options.files) ? options.files : filesStore[type];
  sourceFiles.forEach(function(file) {
    var normalized = normalizeUploadFile(file, type === 'template' ? 'template.png' : 'color.png');
    if (normalized) form.append('files', normalized);
  });
  const params = new URLSearchParams({ type });
  if (options.append) params.set('append', '1');
  if (options.sessionId) params.set('sessionId', options.sessionId);
  const response = await fetch(`/api/upload?${params.toString()}`, { method: 'POST', body: form });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || '上传失败');
  if (data.count !== sourceFiles.length) throw new Error(`服务器仅收到 ${data.count} 张图片`);
  return data;
}

async function doScan(options = {}) {
  if (!filesStore.template.length || !filesStore.color.length) return toast('请先上传模板和颜色图', 'wn');
  // 停止旧批次的轮询，重置状态（准备新任务）
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  batchId = null;
  genDone = false;
  $('btn-scan').disabled = true;
  setStatus('bs', '上传并扫描中');
  try {
    var appendUpload = isActiveAppendBatch(window.__currentBatch);
    var uploadSessionId = null;
    var upTpl = await uploadToServer('template', { append: appendUpload });
    uploadSessionId = upTpl?.sessionId || null;
    await uploadToServer('color', { append: appendUpload, sessionId: uploadSessionId, files: options.colorFiles });
    if (options.referenceCrop && uploadSessionId) {
      var cropResult = await api('/api/recolor/reference-crop/apply', {
        sessionId: uploadSessionId,
        crop: normalizedReferenceCrop(options.referenceCrop),
        confirmAspectWarnings: true
      });
      if (!cropResult.success) throw new Error(cropResult.error || '批量裁剪失败');
    }
    scanData = await api('/api/scan' + (uploadSessionId ? ('?sessionId=' + encodeURIComponent(uploadSessionId)) : ''));
    if (!scanData.success) throw new Error(scanData.error || '扫描失败');

    // 本次扫描只代表本次上传批次；旧任务已经保存在权威任务列表中
    var freshPairs = Array.isArray(scanData?.pairs) ? scanData.pairs : [];
    if (uploadSessionId && freshPairs.length) {
      freshPairs = freshPairs.map(function(pair) {
        return Object.assign({}, pair, { sessionId: pair.sessionId || uploadSessionId });
      });
      scanData.pairs = freshPairs;
      scanData.sessionId = uploadSessionId;
    }
    scanData.pairs = freshPairs;
    scanData.totalPairs = freshPairs.length;

    showPairs();
    // 本地吸色只服务列表、筛选、历史与导出命名，不进入提示词、生成 API 或 QC。
    valData = { passed: scanData.totalPairs, warned: 0, pairs: scanData.pairs, colorMap: scanData.colorMap || {} };
    const btnTogen = $('btn-togen');
    if (btnTogen) btnTogen.disabled = false;
    // 将扫描结果渲染为待生成任务行（不消耗API）
    scanPairs = freshPairs;
    renderScanPreviewFromScan(scanData);
    syncFinalBottomBar(window.__currentBatch);
    await persistAll();
    go(2);
    setStatus('ok', '准备就绪');
    toast(`扫描完成，共 ${scanData.totalPairs} 对（可直接点击开始生成）`);
    if (options.pendingPlan && pendingReferenceCropPlan === options.pendingPlan) pendingReferenceCropPlan = null;
    return true;
  } catch (error) {
    toast(error.message, 'ng');
    setStatus('er', '上传失败');
    return false;
  } finally {
    updateScanButton();
  }
}

function showPairs() {
  if (!scanData?.pairs?.length) {
    $('pairs-box').innerHTML = '';
    return;
  }
  $('pairs-box').innerHTML = `
    <div class="hb"><strong>✅ ${scanData.totalPairs} 对</strong>（${scanData.templates.count}模板 × ${scanData.colors.count}颜色）</div>
    <div class="pg">${scanData.pairs.slice(0, 100).map((pair, index) =>
      `<div class="pair"><strong>#${index + 1}</strong><br>${escapeHtml(pair.templateName)}<br>↓<br>${escapeHtml(pair.colorName)}</div>`
    ).join('')}</div>`;
}

// ===== 扫描结果渲染为待生成任务行（不消耗API） =====
function renderScanPreviewFromScan(data) {
  const pairs = data?.pairs;
  const taskList = $('task-list');
  const emptyState = $('task-table-empty');
  const countEl = $('ttb-count');

  if (!pairs || !pairs.length) {
    // 无配对：显示空状态
    if (taskList) taskList.innerHTML = '';
    if (emptyState) { emptyState.classList.remove('hidden'); }
    if (countEl) countEl.textContent = '无任务';
    scanPairs = null;
    return;
  }

  scanPairs = pairs; // 缓存供 selectTask 使用

  // 应用状态筛选（scan preview 只在 all / pending 时显示）
  if (taskFilter !== 'all' && taskFilter !== 'pending') {
    if (taskList) taskList.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    let emptyText = `0 项（筛选: ${taskFilter === 'running' ? '运行中' : taskFilter === 'done' ? '已完成' : '失败'}）`;
    if (taskSearchQuery) emptyText = `没有找到包含"${escapeHtml(taskSearchQuery)}"的任务`;
    if (countEl) countEl.textContent = emptyText;
    return;
  }

  // 应用搜索过滤
  const visiblePairs = filterBySearch(pairs, true);
  if (!visiblePairs.length) {
    if (taskList) taskList.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    if (countEl) countEl.textContent = taskSearchQuery ? `没有找到包含"${escapeHtml(taskSearchQuery)}"的任务` : '0 项待生成';
    updateRailAvailability([]);
    return;
  }

  // 有配对：渲染待生成任务行
  if (emptyState) emptyState.classList.add('hidden');
  if (countEl) countEl.textContent = `${visiblePairs.length} 项待生成${taskSearchQuery ? '（已搜索）' : ''}`;

  taskList.innerHTML = recolorTaskSegments(visiblePairs).map(function(group) {
    const rows = group.items.map(function(pair) {
      const tplEncoded = encodeURIComponent(pair.templateName);
      const clrEncoded = encodeURIComponent(pair.colorName);
      const sessionId = pair.sessionId || scanData?.sessionId || '';
      const uploadBase = sessionId ? `/uploads/sessions/${encodeURIComponent(sessionId)}` : '/uploads';
      const tplUrl = `${uploadBase}/templates/${tplEncoded}`;
      const clrUrl = `${uploadBase}/colors/${clrEncoded}`;
      const colorName = escapeHtml(pair.referenceColorLabel || pair.colorNameWithoutExt || pair.colorName || '—');
      const colorHex = normalizedReferenceHex(pair.referenceHex);
      const swatchClass = colorHex ? 'task-color-swatch' : 'task-color-swatch is-unset';
      const swatchStyle = colorHex ? ` style="--task-color:${colorHex}"` : '';
      const colorHexCopy = colorHex || '未设置色号';
      const shortId = recolorTaskShortId(pair);
      const colorMarkup = taskReferenceColorMarkup(sessionId, pair.colorName || '', pair.referenceColorLabel || pair.colorNameWithoutExt || pair.colorName || '—', colorHex);

      return `
      <div class="task-row row scan-pending" onclick="selectTask('scan-preview','${pair.id}')" data-batch="scan-preview" data-task="${pair.id}" data-short-id="${shortId}" data-tpl="${escapeHtml(pair.templateName || '')}" data-clr="${escapeHtml(pair.colorName || '')}" data-out="" data-reference-url="${clrUrl}">
        <div class="task-number number" title="任务编号 ${shortId}">${shortId}</div>
        <div class="task-col task-col-thumb"><div class="task-thumb"><img src="${tplUrl}" onerror="handleThumbError(this,1)" onload="handleThumbLoad(this)" alt="模板图" loading="lazy" title="点击查看三图对比" onclick="event.stopPropagation();openImageRowPreview(this)"></div></div>
        <span class="task-row-arrow arrow" aria-hidden="true"><i class="ph-duotone ph-arrow-right"></i></span>
        <div class="task-col task-col-thumb"><div class="task-thumb task-thumb-empty"><span>等待生成</span></div></div>
        <div class="task-col task-col-name task-info"><span class="tn">${colorMarkup}</span><span class="ts">待开始 · ${colorHexCopy}<span>等待选择模型</span></span></div>
        <div class="task-col task-col-status"><span class="status-pill status pending waiting">等待生成</span><span class="status-copy">等待进入队列</span></div>
        <div class="task-col task-col-actions row-actions" onclick="event.stopPropagation()"><button class="task-row-btn action icon-only" onclick="viewScanPair('${pair.id}')" title="查看任务详情" aria-label="查看任务详情"><span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></span></button></div>
      </div>`;
    }).join('');
    return `<div class="task-template-group group" data-group-key="${escapeHtml(group.key)}"><strong>${escapeHtml(group.templateName)}</strong><span>· ${group.items.length} 种颜色</span></div>${rows}`;
  }).join('');
  updateRailAvailability(visiblePairs.map(function(pair) { return { ...pair, executionStatus:'pending' }; }));
}

// 查看扫描预览对
function viewScanPair(pairId) {
  selectTask('scan-preview', pairId);
}

async function runAI() {
  if (!scanData?.pairs?.length) return toast('请先扫描配对', 'wn');
  const btnAi = $('btn-ai');
  if (btnAi) btnAi.disabled = true;
  setStatus('bs', '检查中');
  try {
    const checked = await api('/api/validate', {});
    if (!checked.success) throw new Error(checked.error || '检查失败');
    valData = await api('/api/validate-status');
    showValResult(valData);
    const btnTogen = $('btn-togen');
    if (btnTogen) btnTogen.disabled = false;
    const btnGen = $('btn-gen');
    if (btnGen) btnGen.disabled = false;
    await persistAll();
    setStatus('ok', '检查完成');
    toast(`${valData.passed} 对通过检查`);
  } catch (error) {
    toast(error.message, 'ng');
  } finally {
    const btnAi2 = $('btn-ai');
    if (btnAi2) btnAi2.disabled = false;
  }
}

async function doValidateAndGoGenerate() {
  await runAI();
  if (valData?.passed) go(3);
}

function showValResult(result) {
  // 吸色功能已永久禁用 — 仅显示配对确认结果
  const valBox = $('val-box');
  if (!valBox) return;
  valBox.innerHTML = `
    <div class="hb"><strong>${result.warned ? '⚠️' : '✅'} 通过 ${result.passed} 对，警告 ${result.warned || 0} 对</strong></div>
    <div class="pg">${(result.pairs || []).map(pair =>
      `<div class="pair">${escapeHtml(pair.templateName)}<br>↓<br>${escapeHtml(pair.colorName)}
      ${pair.warning ? `<div class="task-error">${escapeHtml(pair.warning)}</div>` : ''}</div>`
    ).join('')}</div>`;
}

// 重新应用已保存的颜色选择状态
function reapplySelections() {
  for (const [name, override] of Object.entries(userColorOverrides)) {
    const id = 'cands-' + name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
    const container = document.getElementById(id);
    if (!container) continue;
    const cands = container.querySelectorAll('.color-cand');
    for (const cand of cands) {
      if (cand.dataset.hex === override.hex) {
        cand.style.borderColor = 'var(--bf)';
      }
    }
  }
}

// 候选色点击切换（每个颜色参考图独立选择）
let userColorOverrides = {};

// 右侧检查栏只把已经由系统吸取/用户确认过的颜色显示为色块。
// 没有可靠 HEX 时仍保留参考图来源，不伪造颜色值。
function getReferenceColorHex(colorName) {
  const rawName = String(colorName || '');
  const shortName = rawName.replace(/\.[^.]+$/, '');
  const candidates = [rawName, shortName].filter(Boolean);
  for (const name of candidates) {
    const hex = userColorOverrides?.[name]?.hex || valData?.colorMap?.[name]?.primary?.hex;
    if (/^#[0-9a-f]{6}$/i.test(String(hex || ''))) return String(hex).toUpperCase();
  }
  return '';
}
function selectColorCandidate(el) {
  const name = el.dataset.colorName;
  // 只重置当前颜色参考图下的候选色边框，不影响其他颜色图的选择
  const id = 'cands-' + name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
  const container = document.getElementById(id);
  if (container) {
    container.querySelectorAll('.color-cand').forEach(e => e.style.borderColor = 'var(--bd)');
  }
  el.style.borderColor = 'var(--bf)';
  userColorOverrides[name] = {
    hex: el.dataset.hex,
    rgb: el.dataset.rgb.split(',').map(Number),
    lab: el.dataset.lab.split(',').map(Number)
  };
  console.log('选中颜色:', name, userColorOverrides[name]);
}

// 取消自定义颜色，恢复AI候选色
function clearColorOverride(name) {
  delete userColorOverrides[name];
  if (valData) showValResult(valData);
  toast(`${name} 已恢复AI吸色`);
}

// ==================== 自定义颜色选择器 ====================

const colorHistory = [];

function hexToRgb(hex) {
  hex = hex.replace('#','');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const n = parseInt(hex, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

let activePickerColorName = null;

function showColorPicker(colorName) {
  activePickerColorName = colorName;
  const cur = userColorOverrides[colorName];
  const hex = cur?.hex || (valData?.colorMap?.[colorName]?.primary?.hex) || '#ff6600';
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(...rgb);
  const imgUrl = `/uploads/colors/${encodeURIComponent(colorName)}`;

  const pickerHTML = `
    <div class="cp-overlay" id="cp-overlay" onclick="closeColorPicker(event)">
      <div class="cp-panel cp-wide" onclick="event.stopPropagation()">
        <div class="cp-header">
          <span>自定义取色 · ${escapeHtml(colorName)}</span>
          <button class="pv-close" onclick="closeColorPicker()" title="关闭">关闭</button>
        </div>
        <div class="cp-body cp-two-col">
          <div class="cp-img-col">
            <div class="cp-img-wrap" id="cp-img-wrap">
              <img src="${imgUrl}" id="cp-ref-img" crossorigin="anonymous" onload="initImgPicker()" onerror="this.style.display='none'" style="max-width:100%;max-height:100%;cursor:crosshair;user-select:none">
              <div class="cp-zoom-hint">点击取色 | 滚轮缩放</div>
            </div>
            <div class="cp-zoom-ctrl">
              <button onclick="zoomImg(0.8)">−</button>
              <span id="cp-zoom-level">100%</span>
              <button onclick="zoomImg(1.25)">+</button>
              <button onclick="resetImgZoom()">⟲</button>
            </div>
          </div>
          <div class="cp-tools-col">
            <div class="cp-preview" id="cp-preview" style="background:${hex}"></div>
            <div class="cp-tools">
              <button class="btn bp" id="cp-eyedropper" onclick="pickColorEyeDropper()" title="从屏幕吸色">💉 吸管取色</button>
              <span id="cp-eye-status" style="font-size:10px;color:var(--t3);margin-left:6px"></span>
            </div>
            <div class="cp-inputs">
              <label>HEX <input type="text" id="cp-hex" value="${hex}" oninput="onHexChange()" maxlength="7" style="width:80px;font-family:monospace"></label>
              <label>R <input type="number" id="cp-r" value="${rgb[0]}" min="0" max="255" oninput="onRgbChange()" style="width:55px"></label>
              <label>G <input type="number" id="cp-g" value="${rgb[1]}" min="0" max="255" oninput="onRgbChange()" style="width:55px"></label>
              <label>B <input type="number" id="cp-b" value="${rgb[2]}" min="0" max="255" oninput="onRgbChange()" style="width:55px"></label>
            </div>
            <div class="cp-inputs">
              <label>H <input type="number" id="cp-h" value="${hsl[0]}" min="0" max="360" oninput="onHslChange()" style="width:55px"></label>
              <label>S <input type="number" id="cp-s" value="${hsl[1]}" min="0" max="100" oninput="onHslChange()" style="width:55px"></label>
              <label>L <input type="number" id="cp-l" value="${hsl[2]}" min="0" max="100" oninput="onHslChange()" style="width:55px"></label>
            </div>
            ${colorHistory.length > 0 ? `<div class="cp-history">
              <div style="font-size:10px;color:var(--t3);margin-bottom:4px">历史颜色</div>
              ${colorHistory.slice(-10).map((h, i) => `<span class="cp-hist-dot" style="background:${h}" onclick="applyHistoryColor('${h}')" title="${h}"></span>`).join('')}
            </div>` : ''}
            <div class="cp-actions">
              <button class="btn bs" onclick="closeColorPicker()">取消</button>
              <button class="btn bp" onclick="applyCustomColor()">✅ 应用此颜色</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const existing = document.getElementById('cp-overlay');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', pickerHTML);
  initImgPickerEvents();
}

let cpZoom = 1;
function initImgPicker() {
  cpZoom = 1;
  updateZoomDisplay();
}
function initImgPickerEvents() {
  const wrap = document.getElementById('cp-img-wrap');
  const img = document.getElementById('cp-ref-img');
  if (!wrap || !img) return;
  wrap.addEventListener('click', e => {
    if (e.button !== 0) return;
    const rect = img.getBoundingClientRect();
    const x = (e.clientX - rect.left) / cpZoom;
    const y = (e.clientY - rect.top) / cpZoom;
    pickColorFromImg(img, x, y);
  });
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    zoomImg(delta);
  }, { passive: false });
}
function pickColorFromImg(img, x, y) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  try {
    ctx.drawImage(img, 0, 0);
    const pixel = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    const hex = rgbToHex(pixel[0], pixel[1], pixel[2]);
    updateColorPicker(hex);
    const status = document.getElementById('cp-eye-status');
    if (status) status.textContent = `已取色: ${hex}`;
  } catch (e) {
    toast('无法读取图片像素（跨域限制），请使用吸管工具', 'wn');
  }
}
function zoomImg(factor) {
  cpZoom = Math.max(0.5, Math.min(5, cpZoom * factor));
  const img = document.getElementById('cp-ref-img');
  if (img) img.style.transform = `scale(${cpZoom})`;
  updateZoomDisplay();
}
function resetImgZoom() {
  cpZoom = 1;
  const img = document.getElementById('cp-ref-img');
  if (img) img.style.transform = 'scale(1)';
  updateZoomDisplay();
}
function updateZoomDisplay() {
  const el = document.getElementById('cp-zoom-level');
  if (el) el.textContent = Math.round(cpZoom * 100) + '%';
}

function updateColorPicker(hex) {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(...rgb);
  const preview = document.getElementById('cp-preview');
  const inpHex = document.getElementById('cp-hex');
  const inpR = document.getElementById('cp-r'), inpG = document.getElementById('cp-g'), inpB = document.getElementById('cp-b');
  const inpH = document.getElementById('cp-h'), inpS = document.getElementById('cp-s'), inpL = document.getElementById('cp-l');
  if (preview) preview.style.background = hex;
  if (inpHex) inpHex.value = hex;
  if (inpR) inpR.value = rgb[0];
  if (inpG) inpG.value = rgb[1];
  if (inpB) inpB.value = rgb[2];
  if (inpH) inpH.value = hsl[0];
  if (inpS) inpS.value = hsl[1];
  if (inpL) inpL.value = hsl[2];
}

function onHexChange() {
  const v = document.getElementById('cp-hex').value;
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
  updateColorPicker(v);
}

function onRgbChange() {
  const r = +document.getElementById('cp-r').value || 0;
  const g = +document.getElementById('cp-g').value || 0;
  const b = +document.getElementById('cp-b').value || 0;
  updateColorPicker(rgbToHex(r, g, b));
}

function onHslChange() {
  const h = (+document.getElementById('cp-h').value / 360) || 0;
  const s = (+document.getElementById('cp-s').value / 100) || 0;
  const l = (+document.getElementById('cp-l').value / 100) || 0;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h * 12) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  updateColorPicker(rgbToHex(f(0), f(8), f(4)));
}

async function pickColorEyeDropper() {
  const statusEl = document.getElementById('cp-eye-status');
  if (!window.EyeDropper) {
    if (statusEl) statusEl.textContent = '⚠ 浏览器不支持吸管API';
    toast('当前浏览器不支持 EyeDropper API，请使用 Chrome/Edge 最新版', 'wn');
    return;
  }
  if (statusEl) statusEl.textContent = '点击屏幕任意位置取色…';
  try {
    const dropper = new EyeDropper();
    const result = await dropper.open();
    const hex = result.sRGBHex;
    updateColorPicker(hex);
    if (statusEl) statusEl.textContent = `已取色: ${hex}`;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (statusEl) statusEl.textContent = '已取消';
    } else {
      if (statusEl) statusEl.textContent = '取色失败';
    }
  }
}

function applyHistoryColor(hex) {
  updateColorPicker(hex);
}

function applyCustomColor() {
  const hex = document.getElementById('cp-hex').value;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return toast('请输入有效的 HEX 颜色值', 'wn');
  const rgb = hexToRgb(hex);
  userColorOverrides[activePickerColorName] = {
    hex, rgb,
    lab: [50, rgb[0] / 255 * 90 - 45, rgb[2] / 255 * 90 - 45]
  };
  if (!colorHistory.includes(hex)) {
    colorHistory.unshift(hex);
    if (colorHistory.length > 20) colorHistory.length = 20;
  }
  // 重新渲染候选区，显示自定义色
  if (valData) showValResult(valData);
  closeColorPicker();
  toast(`${activePickerColorName} → ${hex}`);
}

function closeColorPicker(e) {
  if (e && e.target !== document.getElementById('cp-overlay')) return;
  document.getElementById('cp-overlay')?.remove();
  activePickerColorName = null;
}

// 单独刷新某个颜色的吸色
async function reExtractColor(colorName) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const result = await api('/api/color/re-extract', { colorName });
    if (result.success && result.color?.success) {
      if (!valData) valData = {};
      valData.colorMap = valData.colorMap || {};
      valData.colorMap[colorName] = result.color;
      showValResult(valData);
      toast(`${colorName} 吸色刷新完成`);
    } else {
      toast(result.color?.reason || '吸色失败，请检查颜色图', 'wn');
    }
  } catch (e) {
    toast('刷新失败: ' + e.message, 'ng');
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

// 提示词预设
const PROMPT_PRESETS = {
  creative: '将图1的床品颜色改成图2的床品颜色，颜色与纹理参照图2。图中所有英文文字（如"Silver Gray"）必须改为与图2床品颜色对应的正确英文颜色名称（如改为Orange/Tiffany Blue等，文字颜色不变）。只改颜色名称文字，不改其他文字内容。礼盒、丝带、背景、灯光等物品完全保持原样，不增删任何物品。保持原始摄影光照和背景结构，保留真实材质（金属、宝石、布料）的反光特性。电商级产品图质量，光线自然，超真实感。',
  recolor: '只改图1的床品颜色为图2的床品颜色，禁止修改图中任何文字（内容、字体、颜色一概不动）。必须保持原摄影光照、阴影、布料纹理与细节完全不变，不新增任何元素，不改变结构。8K，超真实感，细节丰富。'
};

function switchPrompt() {
  const sel = document.getElementById('prompt-preset');
  const ta = document.getElementById('user-prompt');
  if (sel && ta) {
    ta.value = PROMPT_PRESETS[sel.value] || PROMPT_PRESETS.recolor;
  }
}

// === 判断旧批次是否有可恢复任务 ===
function hasRecoverableTasks(batch) {
  var tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
  if (!tasks.length) return false;

  return tasks.some(function(t) {
    var s = String(t.executionStatus || t.status || '').toLowerCase();
    if (!s) return false;
    if (['completed', 'done', 'success'].indexOf(s) >= 0) return false;
    return ['pending', 'queued', 'running', 'processing', 'error', 'failed', 'cancelled', 'canceled', 'stopped', 'paused'].indexOf(s) >= 0;
  });
}

// === 同步批次状态：从后端拉取真实状态，清理前端幽灵状态 ===
async function syncBatchState() {
  try {
    const latest = await api('/api/batches/latest');
    const b = latest.batch;
    if (!b) return { canGenerate: true };
    await hydrateBatchReferenceMetadata(b);

    // 已完成或已取消 → 可以创建新批次
    if (b.status === 'completed' || b.status === 'cancelled') {
      console.log('[syncBatchState] Old batch is finished, allowing new generation');
      return { canGenerate: true, oldBatch: b };
    }

    // 正在运行 → 不能创建新批次
    if (b.active && b.status === 'running') {
      return { canGenerate: false, activeBatch: b, reason: 'running' };
    }

    // 暂停/取消中 → 只有确实有可恢复任务时才阻断新生成
    if (b.status === 'paused' || b.status === 'pausing' || b.status === 'cancelling') {
      if (hasRecoverableTasks(b)) {
        return { canGenerate: false, activeBatch: b, reason: b.status };
      }
      return { canGenerate: true, oldBatch: b };
    }

    return { canGenerate: true };
  } catch (e) {
    return { canGenerate: true };  // 网络错误时允许尝试
  }
}

async function startGen(continueOnly = false, options = {}) {
  var appendRunning = options.appendRunning || false;
  var pairsOverride = options.pairsOverride || null;

  // === STEP 12: 追加模式 — 向运行中批次追加新任务 ===
  if (appendRunning) {
    var batch = window.__currentBatch;
    if (!batch || !batch.batchId) return toast('没有运行中的批次', 'ng');
    batchId = batch.batchId;

    if (!pairsOverride || !pairsOverride.length) return toast('没有可追加的新任务', 'wn');

    const prompt = getActiveGenerationPrompt();
    if (!prompt) return toast('请选择类型或输入提示词', 'wn');

    const btnGA = $('bt-generate-all');
    var statusEl = $('bt-generate-status');
    setStatus('bs', '正在追加任务');

    try {
      // 先激活后端文件检查缓存；追加模式必须带扫描会话，避免检查到旧公共上传目录
      const appendSessionId = pairsOverride?.[0]?.sessionId || scanData?.sessionId || '';
      const validated = await api('/api/validate', appendSessionId ? { sessionId: appendSessionId } : {});
      if (!validated?.success) throw new Error(validated?.error || '文件检查失败');

      const result = await api('/api/generate-v2', {
        prompt,
        extraPrompt,
        costPerCallFen: userApiPriceFen || 0,
        pairs: pairsOverride,
        batchId: batchId || '',
        providerId: recolorProviderId,
        model: recolorModel,
        quality: recolorQuality,
        concurrency: recolorConcurrency,
        size: recolorSize,
        quantity: recolorQuantity,
      });

      if (!result.success) throw new Error(result.error || '追加失败');

      console.log('[PAUSE-APPEND-FIX] append success batchId=' + result.batchId);

      // 确认返回的 batchId
      batchId = result.batchId;
      const submittedSessionIds = new Set(pairsOverride.map(pair => pair.sessionId || pair.uploadSessionId || '').filter(Boolean));
      scanPairs = (scanPairs || []).filter(pair => !submittedSessionIds.has(pair.sessionId || pair.uploadSessionId || ''));
      if (scanData && Array.isArray(scanData.pairs)) {
        scanData.pairs = scanData.pairs.filter(pair => !submittedSessionIds.has(pair.sessionId || pair.uploadSessionId || ''));
        scanData.totalPairs = scanData.pairs.length;
      }
      const remainsPaused = ['paused', 'pausing'].includes(String(batch.status || '').toLowerCase())
        || batch.userPauseRequested || batch.systemPauseRequested;
      toast(remainsPaused
        ? '已加入 ' + pairsOverride.length + ' 个新任务，队列保持暂停'
        : '已加入 ' + pairsOverride.length + ' 个新任务到当前运行队列', 'ok');

      // 刷新一次数据，让 UI 感知新任务
      const fresh = await api('/api/batches/' + encodeURIComponent(batchId));
      if (fresh?.success && fresh.batch) {
        await hydrateBatchReferenceMetadata(fresh.batch);
        fresh.batch._taskPage = pageTracker[batchId] || 1;
        updateBatch(fresh.batch);
      }

      // 恢复按钮状态（运行批次仍由原轮询接续；暂停批次只入队）
      if (btnGA) btnGA.disabled = false;
      if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = remainsPaused ? '已暂停' : '生成中'; }
    } catch (error) {
      toast('追加失败: ' + (error.message || '未知错误'), 'ng');
      if (btnGA) btnGA.disabled = false;
      if (statusEl) statusEl.style.display = 'none';
      setStatus('er', '追加失败');
    }
    return;
  }

  // === 以下为原有逻辑（非追加模式）===
  const syncResult = await syncBatchState();
  if (!syncResult.canGenerate) {
    if (syncResult.reason === 'running') {
      toast('检测到正在执行的批次，已恢复进度', 'wn');
      batchId = syncResult.activeBatch.batchId;
      renderBatch(syncResult.activeBatch);
      go(3);
      startPolling();
    } else if (syncResult.reason === 'paused' || syncResult.reason === 'pausing' || syncResult.reason === 'cancelling') {
      batchId = syncResult.activeBatch.batchId;
      renderBatch(syncResult.activeBatch);
      go(3);
      await resumeBatch();
      startPolling();
      toast('已恢复未完成任务', 'ok');
    }
    return;
  }

  // 无条件自动重新扫描（确保数据最新）
  if (!scanData?.pairs?.length) {
    try {
      scanData = await api('/api/scan');
      if (scanData?.success) showPairs();
    } catch (e) { return toast('扫描失败，请点"扫描配对"按钮重试', 'ng'); }
  }
  if (!scanData?.pairs?.length) return toast('未找到可配对的文件，请先上传模板和参考图', 'wn');

  // 自动补全 valData
  valData = { passed: scanData.totalPairs, warned: 0, pairs: scanData.pairs, colorMap: {} };
  const prompt = getActiveGenerationPrompt();
  if (!prompt) return toast('请选择类型或输入提示词', 'wn');

  const btnGen = $('btn-gen');
  if (btnGen) btnGen.disabled = true;
  setStatus('bs', '正在创建批次');
  try {
    // 先激活后端文件检查缓存，避免 generate-v2 报"请先完成文件检查"
    const validated = await api('/api/validate', {});
    if (!validated?.success) throw new Error(validated?.error || '文件检查失败，请重新扫描配对');
    // 重置自动选中状态（新批次开始）
    lastTaskStatusMap = {};
    userSelectedTaskId = null;
    autoSelectSuppressed = false;
    var sendPairs = Array.isArray(scanData?.pairs) ? scanData.pairs : [];
    // 兜底：sendPairs为空但scanPairs有数据时，从scanPairs补充
    if ((!sendPairs || sendPairs.length === 0) && scanPairs && scanPairs.length > 0) {
      sendPairs = scanPairs;
    }
    if (!sendPairs || sendPairs.length === 0) {
      return toast('没有可生成任务，请重新扫描配对', 'wn');
    }
    const targetBatchId = isActiveAppendBatch(window.__currentBatch) ? window.__currentBatch.batchId : '';
    const result = await api('/api/generate-v2', {
      prompt,
  extraPrompt,
  costPerCallFen: userApiPriceFen || 0,
  pairs: sendPairs,
  batchId: targetBatchId,
  providerId: recolorProviderId,
  model: recolorModel,
  quality: recolorQuality,
  concurrency: recolorConcurrency,
  size: recolorSize,
  quantity: recolorQuantity,
});
    if (!result.success) throw new Error(result.error || '启动失败');
    batchId = result.batchId;
    genDone = false;
    await persistStateOnly();
    startPolling(true);
  } catch (error) {
    toast(error.message, 'ng');
    if (btnGen) btnGen.disabled = false;
    setStatus('er', '启动失败');
  }
}

let pageTracker = {}; // batchId -> page number

function startPolling(immediate = false) {
  if (pollTimer) clearInterval(pollTimer);
  startLogAutoRefresh();
  let pollVersion = 0;
  const poll = async () => {
    if (!batchId) return;
    const ver = ++pollVersion;
    const result = await api(`/api/batches/${encodeURIComponent(batchId)}`);
    if (!result.success || !result.batch) return;
    // 版本守卫：防止旧请求覆盖新数据
    if (ver !== pollVersion) return;
    // STEP2: 防空tasks
    if (!result.batch.tasks) result.batch.tasks = [];
    await hydrateBatchReferenceMetadata(result.batch);
    result.batch._taskPage = pageTracker[batchId] || 1;
    // polling 只更新数据，不渲染UI
    updateBatch(result.batch);
    if (!result.batch.active && ['completed', 'cancelled'].includes(result.batch.status)) {
      clearInterval(pollTimer);
      pollTimer = null;
      genDone = true;
      stopLogAutoRefresh();
      await persistStateOnly();
      loadOut();
      // 全部完成或有失败时弹出汇总
      if (result.batch.status === 'completed') showCompletionSummary(result.batch);
      // 解锁一键生图
      isBatchRunning = false;
      const gaBtn2 = $('bt-generate-all');
      if (gaBtn2) gaBtn2.disabled = false;
    }
  };
  if (immediate) poll();
  pollTimer = setInterval(poll, 1500);
}

function statusText(status) {
  return ({
    pending: '等待', running: '生成中', success: '成功', failed: '失败',
    cancelled: '已取消', interrupted: '被中断', completed: '完成',
    paused: '已暂停', cancelling: '停止中', error: '错误',
    passed: '通过', review_required: '待检查'
  })[status] || status;
}

// ===== 任务状态标准化与判断函数（STEP 4 队列安全） =====
function normalizeTaskStatus(task) {
  var es = (task.executionStatus || task.status || task.qualityStatus || '').toLowerCase().trim();
  // 映射别名
  var alias = {
    'done': 'completed', 'success': 'completed', 'finished': 'completed',
    'canceled': 'cancelled', 'stopped': 'cancelled',
    'generating': 'running', 'processing': 'running',
    'queued': 'pending', 'scan-pending': 'pending',
    'fail': 'failed', 'err': 'error'
  };
  return alias[es] || es;
}

function isCompletedTask(task) {
  return ['completed', 'done', 'success', 'finished'].indexOf(task.executionStatus || task.status || '') >= 0;
}

function isRetryableTask(task) {
  var es = (task.executionStatus || task.status || '').toLowerCase().trim();
  return ['cancelled', 'canceled', 'interrupted', 'failed', 'error', 'stopped'].indexOf(es) >= 0;
}

function isRunningTask(task) {
  var es = (task.executionStatus || task.status || '').toLowerCase().trim();
  return ['running', 'generating', 'processing'].indexOf(es) >= 0;
}

function hasUnfinishedTasks(batch) {
  var tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
  return tasks.some(function(t) {
    if (t.hiddenInTaskList) return false;
    var st = normalizeTaskStatus(t);
    return ['pending', 'running', 'paused', 'interrupted', 'failed', 'error', 'cancelled'].indexOf(st) >= 0;
  });
}

function isActiveAppendBatch(batch) {
  if (!batch || !batch.batchId) return false;
  var status = String(batch.status || '').toLowerCase();
  if (status === 'completed' || status === 'cancelled') return false;
  return Boolean(batch.active || ['running', 'paused', 'pausing', 'cancelling'].indexOf(status) >= 0 || hasUnfinishedTasks(batch));
}

// 获取本次上传批次中尚未提交的配对；相同素材允许创建独立任务
function getAppendablePendingPairs() {
  var batch = window.__currentBatch;
  if (!isActiveAppendBatch(batch)) return null;
  if (Array.isArray(scanPairs) && scanPairs.length) return scanPairs.slice();
  return Array.isArray(scanData?.pairs) ? scanData.pairs.slice() : [];
}

// ===== 统一图片URL解析 =====
function resolveTaskImageUrls(batch, task) {
  var batchId = batch.batchId || '';

  // 智能文件名提取：确保带扩展名，防止 templateNameWithoutExt 导致 URL 404
  function pickWithExt(primary, withoutExt, fallbackPath) {
    // 优先用带扩展名的字段
    if (primary && primary.indexOf('.') !== -1) return primary;
    // 如果有无扩展名字段，尝试从完整路径推断扩展名
    if (withoutExt) {
      var ext = '';
      if (primary && primary.indexOf('.') !== -1) { ext = primary.slice(primary.lastIndexOf('.')); }
      else if (fallbackPath && fallbackPath.indexOf('.') !== -1) { ext = fallbackPath.slice(fallbackPath.lastIndexOf('.')); }
      if (ext && ext.length <= 6) return withoutExt + ext;
      return withoutExt; // 无法推断，使用原值
    }
    return primary || '';
  }

  var tplRaw = pickWithExt(
    task.template || task.templateName || '',
    task.templateNameWithoutExt || task.template || task.templateName || '',
    task.templatePath || ''
  );
  var refRaw = pickWithExt(
    task.colorRef || task.colorName || task.reference || '',
    task.colorNameWithoutExt || task.colorRef || task.colorName || task.reference || '',
    task.colorPath || task.reference || ''
  );
  // 生成图路径来源优先级
  var outRaw = task.output || task.outputPath || task.outputUrl || task.resultUrl || '';

  var hasTemplateName = !!tplRaw;
  var hasReferenceName = !!refRaw;
  var hasResult = !!outRaw;

  // URL拼接（只encode文件名片段，不encode整个路径）
  var templateUrl = '';
  var referenceUrl = '';
  var resultUrl = '';

  if (hasTemplateName) {
    templateUrl = '/output/' + encodeURIComponent(batchId) + '/inputs/templates/' + encodeURIComponent(tplRaw);
  }
  if (hasReferenceName) {
    referenceUrl = '/output/' + encodeURIComponent(batchId) + '/inputs/colors/' + encodeURIComponent(refRaw);
  }
  if (hasResult) {
    // 如果已经是/output/开头或http开头，直接使用
    if (outRaw.indexOf('/output/') === 0 || outRaw.indexOf('http') === 0) {
      resultUrl = outRaw;
    } else {
      resultUrl = '/output/' + encodeURIComponent(batchId) + '/' + outRaw.split('/').map(encodeURIComponent).join('/');
    }
  }

  var tplUrlSafe = templateUrl ? templateUrl.replace(/'/g, '\\\'') : '';
  var refUrlSafe = referenceUrl ? referenceUrl.replace(/'/g, '\\\'') : '';
  var outUrlSafe = resultUrl ? resultUrl.replace(/'/g, '\\\'') : '';

  return {
    templateUrl: tplUrlSafe,
    referenceUrl: refUrlSafe,
    resultUrl: outUrlSafe,
    templateLabel: escapeHtml(tplRaw),
    referenceLabel: escapeHtml(refRaw),
    resultLabel: escapeHtml(outRaw),
    hasTemplateName: hasTemplateName,
    hasReferenceName: hasReferenceName,
    hasResult: hasResult
  };
}

// ===== STEP 14: 缩略图加载重试机制 · 防止大图加载偶发失败永久 fallback =====
function handleThumbError(img, maxRetries) {
  maxRetries = maxRetries || 1;
  var count = parseInt(img.getAttribute('data-retry-count')) || 0;
  if (count < maxRetries) {
    img.setAttribute('data-retry-count', (count + 1).toString());
    var origUrl = img.getAttribute('data-orig-src') || img.src;
    if (!img.getAttribute('data-orig-src')) img.setAttribute('data-orig-src', origUrl);
    var sep = origUrl.indexOf('?') === -1 ? '?' : '&';
    setTimeout(function() {
      img.src = origUrl + sep + '_rt=' + Date.now();
    }, 600 + count * 400);
  } else {
    img.style.display = 'none';
    var fb = img.nextElementSibling;
    if (fb) fb.style.display = 'block';
  }
}
function handleThumbLoad(img) {
  img.style.display = '';
  img.setAttribute('data-retry-count', '0');
  img.removeAttribute('data-orig-src');
  var fb = img.nextElementSibling;
  if (fb) fb.style.display = 'none';
}
// ===== END STEP 14 =====

function renderBatch(batch) {
  if (!batch || !batch.tasks) { batch = { tasks: [], totals: {}, status: 'empty' }; }
  updateBatch(batch);
}

// ===== 唯一写入入口（强制触发渲染） =====
function updateBatch(batch) {
  backfillBatchReferenceMetadata(batch);
  window.__currentBatch = structuredClone ? structuredClone(batch) : JSON.parse(JSON.stringify(batch));
  // 强制立即渲染
  renderUI();
}

function pauseSubmittedCount(batch) {
  return (batch?.tasks || []).filter(function(task) {
    return ['submitting', 'submitted', 'unknown', 'cancelled_after_submit'].includes(String(task.generationSubmissionState || '').toLowerCase())
      || ['awaiting_remote', 'remote_unknown', 'resolving_remote'].includes(String(task.runtimeStatus || '').toLowerCase());
  }).length;
}

function renderPauseBanner(batch) {
  const banner = $('recolor-pause-banner');
  if (!banner) return;
  const paused = Boolean(batch?.userPauseRequested || batch?.systemPauseRequested)
    || ['paused', 'pausing'].includes(String(batch?.status || '').toLowerCase());
  banner.hidden = !paused;
  document.body.dataset.recolorPauseVisible = paused ? 'true' : 'false';
  if (!paused) {
    delete document.body.dataset.recolorPauseReason;
    return;
  }

  const title = $('recolor-pause-title');
  const detail = $('recolor-pause-detail');
  const checkState = $('recolor-pause-check-state');
  const checkButton = $('recolor-pause-check');
  const rebindButton = $('recolor-pause-rebind');
  const submitted = pauseSubmittedCount(batch);
  const reason = batch.pauseReason || (batch.userPauseRequested ? 'user' : 'paused');
  document.body.dataset.recolorPauseReason = reason;
  checkButton.hidden = true;
  rebindButton.hidden = true;
  checkState.textContent = '';

  if (reason === 'global_api_error') {
    title.textContent = '服务暂时不可用，队列已暂停';
    detail.textContent = '系统只执行无图片生成检测；已提交的 ' + submitted + ' 项任务会继续等待远端结果。';
    checkState.textContent = Number(batch.healthCheckConsecutive || 0) > 0
      ? '最近检测已通过 ' + Number(batch.healthCheckConsecutive || 0) + '/2 次'
      : (batch.lastHealthCheckError ? '最近检测未通过' : '等待无费用检测');
    checkButton.hidden = false;
  } else if (reason === 'remote_unknown') {
    title.textContent = '正在确认远端结果，队列已暂停';
    detail.textContent = '有 ' + submitted + ' 项请求的远端结果尚未确认，系统不会自动重复提交或重复扣费。';
    checkState.textContent = '可使用底部“继续生成”安全查询远端状态';
  } else if (reason === 'model_unavailable') {
    title.textContent = '原模型不可用，队列已暂停';
    detail.textContent = '系统不会自动替换模型；只有你确认后，才会改变尚未提交的任务。';
    checkState.textContent = batch.lastModelRebind
      ? '已安全切换 ' + Number(batch.lastModelRebind.updatedCount || 0) + ' 项，队列仍保持暂停'
      : '已提交、已计费和历史结果全部保持原样';
    rebindButton.hidden = !batch.unavailableBinding || Boolean(batch.lastModelRebind);
  } else {
    title.textContent = '已由你暂停';
    detail.textContent = '新任务和重做只会加入队尾；已提交的 ' + submitted + ' 项任务会继续等待结果。';
    checkState.textContent = '点击底部“继续生成”后才会恢复领取新任务';
  }
}

async function refreshCurrentRecolorBatch() {
  const id = window.__currentBatch?.batchId || batchId;
  if (!id) return null;
  const fresh = await api('/api/batches/' + encodeURIComponent(id));
  if (fresh?.success && fresh.batch) updateBatch(fresh.batch);
  return fresh?.batch || null;
}

async function checkRecolorPauseNow() {
  const batch = window.__currentBatch;
  const button = $('recolor-pause-check');
  if (!batch?.batchId || batch.pauseReason !== 'global_api_error') return;
  if (button) { button.disabled = true; button.textContent = '检测中…'; }
  try {
    const result = await api('/api/batches/' + encodeURIComponent(batch.batchId) + '/resume', {});
    await refreshCurrentRecolorBatch();
    toast(result?.success ? '检测通过，队列已安全恢复。' : (result?.error || '系统仍未恢复。'), result?.success ? 'ok' : 'wn');
    if (result?.success) startPolling(true);
  } catch (error) {
    toast('检测失败：' + (error.message || '请稍后重试'), 'ng');
  } finally {
    if (button) { button.disabled = false; button.textContent = '立即检测'; }
  }
}

function rebindProviderLabel(providerId) {
  const provider = (pendingModelRebindState?.providers || recolorProviders || []).find(item => item.id === providerId);
  return provider?.name || providerId || '未设置 Provider';
}

function rebindTargetModels(providerId) {
  const state = pendingModelRebindState;
  const provider = (state?.providers || []).find(item => item.id === providerId);
  return (provider?.image_models || []).filter(model => providerId !== state?.from?.providerId || model !== state?.from?.model);
}

function resetRebindPricingChoice() {
  document.querySelectorAll('input[name="rebind-pricing-mode"]').forEach(input => { input.checked = false; });
  const input = $('rebind-new-estimate');
  if (input) { input.disabled = true; input.value = ''; }
  if (pendingModelRebindState) pendingModelRebindState.requestId = null;
  syncRebindPricing();
}

function rebindProviderChanged() {
  const providerSelect = $('rebind-target-provider');
  const modelSelect = $('rebind-target-model');
  if (!providerSelect || !modelSelect) return;
  const models = rebindTargetModels(providerSelect.value);
  modelSelect.innerHTML = models.map(model => '<option value="'+escapeHtml(model)+'">'+escapeHtml(model)+'</option>').join('');
  modelSelect.disabled = !models.length;
  resetRebindPricingChoice();
  refreshPendingModelRebindPreview();
}

function rebindModelChanged() {
  resetRebindPricingChoice();
  refreshPendingModelRebindPreview();
}

function rebindPricingModeChanged() {
  const replace = document.querySelector('input[name="rebind-pricing-mode"]:checked')?.value === 'replace-estimate';
  const input = $('rebind-new-estimate');
  if (input) {
    input.disabled = !replace;
    if (replace) input.focus();
  }
  syncRebindPricing();
}

function rebindEstimateFen() {
  const value = String($('rebind-new-estimate')?.value || '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const fen = Math.round(Number(value) * 100);
  return Number.isSafeInteger(fen) && fen >= 0 ? fen : null;
}

function syncRebindPricing() {
  const state = pendingModelRebindState;
  const mode = document.querySelector('input[name="rebind-pricing-mode"]:checked')?.value || '';
  const validPricing = mode === 'keep-current-estimate' || (mode === 'replace-estimate' && rebindEstimateFen() !== null);
  const confirm = $('rebind-confirm');
  if (confirm) confirm.disabled = !state?.preview || !validPricing || state.submitting === true;
  document.querySelectorAll('.rebind-pricing-choice').forEach(card => {
    card.classList.toggle('selected', card.querySelector('input')?.checked === true);
  });
  return validPricing ? (mode === 'replace-estimate'
    ? { mode, targetCostPerCallFen: rebindEstimateFen() }
    : { mode }) : null;
}

function renderRebindProtectedCounts(preview) {
  const labels = {
    claimed: 'Runner 已领取', already_charged: '已有调用或费用', already_submitted: '已提交', runtime_active: '远端处理中',
    not_pending: '非等待状态', binding_mismatch: '其他模型', deleted: '已删除'
  };
  const entries = Object.entries(preview?.protectedCounts || {}).filter(entry => Number(entry[1]) > 0);
  return entries.length ? entries.map(entry => (labels[entry[0]] || '受保护任务') + ' ' + entry[1] + ' 项').join(' · ') : '没有需要保持原样的任务';
}

async function refreshPendingModelRebindPreview() {
  const state = pendingModelRebindState;
  const providerId = $('rebind-target-provider')?.value || '';
  const model = $('rebind-target-model')?.value || '';
  if (!state || !providerId || !model) return;
  const sequence = ++state.previewSequence;
  state.preview = null;
  state.requestId = null;
  const status = $('rebind-preview-status');
  if (status) { status.className = 'rebind-preview-status loading'; status.textContent = '正在核对任务资格…'; }
  if ($('rebind-confirm')) $('rebind-confirm').disabled = true;
  const query = new URLSearchParams({
    fromProviderId: state.from.providerId,
    fromModel: state.from.model,
    toProviderId: providerId,
    toModel: model
  });
  let result;
  try {
    result = await api('/api/batches/' + encodeURIComponent(state.batchId) + '/pending-model-rebind/preview?' + query.toString());
  } catch (error) {
    result = { success: false, error: '无法连接本机任务服务，请稍后重试。' };
  }
  if (!pendingModelRebindState || sequence !== state.previewSequence) return;
  if (!result?.success || !result.preview) {
    if (status) { status.className = 'rebind-preview-status error'; status.textContent = result?.error || '无法预览改绑范围'; }
    return;
  }
  state.preview = result.preview;
  state.to = { providerId, model };
  $('rebind-eligible-count').textContent = Number(result.preview.eligibleCount || 0) + ' 项';
  $('rebind-protected-count').textContent = Number(result.preview.protectedCount || 0) + ' 项';
  $('rebind-protected-detail').textContent = renderRebindProtectedCounts(result.preview);
  const estimates = result.preview.pricing?.currentEstimatesFen || [];
  $('rebind-current-estimate').textContent = estimates.length
    ? estimates.map(fen => '¥' + (Number(fen || 0) / 100).toFixed(2) + '/次').join('、')
    : '当前任务未记录估算单价';
  if (status) { status.className = 'rebind-preview-status ready'; status.textContent = '资格已按最新队列重新核对；确认后仍保持暂停'; }
  if ($('rebind-confirm')) $('rebind-confirm').textContent = '确认切换 ' + Number(result.preview.eligibleCount || 0) + ' 项任务';
  syncRebindPricing();
}

async function openPendingModelRebind() {
  const batch = window.__currentBatch;
  if (!batch?.batchId || batch.pauseReason !== 'model_unavailable' || !batch.unavailableBinding) {
    return toast('当前没有可处理的模型不可用暂停。', 'wn');
  }
  const trigger = $('recolor-pause-rebind');
  if (trigger) { trigger.disabled = true; trigger.textContent = '正在核对…'; }
  let providers = [];
  try {
    const config = await api('/api/config');
    providers = (config?.api_providers || []).filter(provider => provider.enabled !== false && provider.has_key && Array.isArray(provider.image_models) && provider.image_models.length);
  } catch (error) {
    toast('无法读取候选模型，队列继续保持暂停。', 'ng');
  } finally {
    if (trigger) { trigger.disabled = false; trigger.textContent = '改绑待生成任务'; }
  }
  const from = { providerId: String(batch.unavailableBinding.providerId || ''), model: String(batch.unavailableBinding.model || '') };
  providers = providers.filter(provider => provider.image_models.some(model => provider.id !== from.providerId || model !== from.model));
  if (!providers.length) return toast('没有已配置的候选生图模型，请先在 API 设置中配置。', 'wn');
  recolorProviders = providers;
  const preferred = providers.find(provider => provider.id === recolorProviderId) || providers[0];
  const firstModel = preferred.image_models.find(model => preferred.id !== from.providerId || model !== from.model);
  const providerOptions = providers.map(provider => '<option value="'+escapeHtml(provider.id)+'" '+(provider.id === preferred.id ? 'selected' : '')+'>'+escapeHtml(provider.name || provider.id)+'</option>').join('');
  const modelOptions = preferred.image_models.filter(model => preferred.id !== from.providerId || model !== from.model)
    .map(model => '<option value="'+escapeHtml(model)+'">'+escapeHtml(model)+'</option>').join('');
  const body = '<div class="rebind-v2">'
    +'<div class="rebind-intro-note"><span aria-hidden="true">!</span><p>系统不会自动替换模型。只有你确认后，才会改变尚未提交任务的生成模型。</p></div>'
    +'<div class="rebind-model-flow">'
      +'<article class="rebind-bind-card old"><div class="rebind-bind-head"><span class="rebind-card-kicker">原任务模型</span><span class="rebind-bind-status">不可恢复</span></div><strong class="rebind-model-name">'+escapeHtml(from.model)+'</strong><p>'+escapeHtml(rebindProviderLabel(from.providerId))+' · 模型当前不可用，整批任务保持暂停。</p></article>'
      +'<span class="rebind-flow-arrow" aria-hidden="true">→</span>'
      +'<article class="rebind-bind-card next"><div class="rebind-bind-head"><span class="rebind-card-kicker">可替换模型</span><span class="rebind-bind-status">已配置</span></div><select id="rebind-target-model" class="rebind-model-select" onchange="rebindModelChanged()" aria-label="可替换模型">'+modelOptions+'</select><select id="rebind-target-provider" class="rebind-provider-select" onchange="rebindProviderChanged()" aria-label="候选 Provider">'+providerOptions+'</select><p>只应用到尚未提交的任务，不改动历史结果。</p></article>'
    +'</div>'
    +'<div class="rebind-impact-grid"><article><span>确认后切换</span><strong id="rebind-eligible-count">核对中</strong><small>仅零调用、零费用、未领取、未提交的等待任务</small></article><article><span>保持原样</span><strong id="rebind-protected-count">核对中</strong><small id="rebind-protected-detail">正在读取受保护原因</small></article></div>'
    +'<section class="rebind-pricing"><div class="rebind-section-head"><div><strong>费用估算处理</strong><span id="rebind-current-estimate">正在读取当前估算</span></div><em>必须明确选择</em></div>'
      +'<label class="rebind-pricing-choice"><input type="radio" name="rebind-pricing-mode" value="keep-current-estimate" onchange="rebindPricingModeChanged()"><span><b>沿用原估算</b><small>只用于本地费用预估，不代表新模型实际价格相同</small></span></label>'
      +'<label class="rebind-pricing-choice"><input type="radio" name="rebind-pricing-mode" value="replace-estimate" onchange="rebindPricingModeChanged()"><span><b>填写新的估算单价</b><small>人民币／次，仅改变尚未提交任务的本地估算</small></span><span class="rebind-price-input">¥<input id="rebind-new-estimate" type="number" min="0" step="0.01" inputmode="decimal" disabled oninput="syncRebindPricing()" aria-label="新的估算单价"></span></label>'
    +'</section>'
    +'<div id="rebind-preview-status" class="rebind-preview-status loading">正在核对任务资格…</div>'
    +'<div class="rebind-safety-note"><span aria-hidden="true">i</span><p>不改变 FIFO、提示词、素材、尺寸、质量、调用次数、实际费用或历史结果。确认切换后队列仍保持暂停。</p></div>'
    +'</div>';
  const footer = '<button id="rebind-keep-paused" class="btn bs" data-safe-focus onclick="closeRecolorOverlay()">继续保持暂停</button><button id="rebind-confirm" class="btn lanvas-primary" disabled onclick="confirmPendingModelRebind()">确认切换</button>';
  const overlay = openRecolorOverlay('原模型不可用', body, footer, {
    scene: 'rebind', subtitle: '只修改符合安全资格的任务级模型快照', modalClass: 'rebind-modal'
  });
  pendingModelRebindState = { batchId: batch.batchId, from, to: { providerId: preferred.id, model: firstModel }, providers, preview: null, previewSequence: 0, requestId: null, submitting: false };
  overlay.querySelector('#rebind-keep-paused')?.focus();
  await refreshPendingModelRebindPreview();
}

async function confirmPendingModelRebind() {
  const state = pendingModelRebindState;
  const pricing = syncRebindPricing();
  if (!state?.preview || !pricing || state.submitting) return;
  state.submitting = true;
  state.requestId = state.requestId || (globalThis.crypto?.randomUUID?.() || ('rebind-' + Date.now() + '-' + Math.random().toString(16).slice(2)));
  const button = $('rebind-confirm');
  if (button) { button.disabled = true; button.textContent = '安全切换中…'; }
  let result;
  try {
    result = await api('/api/batches/' + encodeURIComponent(state.batchId) + '/pending-model-rebind', {
      requestId: state.requestId,
      previewToken: state.preview.previewToken,
      from: state.from,
      to: state.to,
      pricing
    });
  } catch (error) {
    result = { success: false, error: '本机任务服务未返回结果；可用同一请求安全重试。' };
  }
  state.submitting = false;
  if (!result?.success) {
    if (button) button.textContent = '确认切换 ' + Number(state.preview?.eligibleCount || 0) + ' 项任务';
    if (['REBIND_PREVIEW_STALE', 'REBIND_NO_ELIGIBLE_TASKS'].includes(result?.code)) await refreshPendingModelRebindPreview();
    else syncRebindPricing();
    return toast(result?.error || '模型改绑失败，队列仍保持暂停。', 'ng');
  }
  const updated = Number(result.updatedCount || 0);
  closeRecolorOverlay();
  if (result.batch) updateBatch(result.batch);
  toast('已安全改绑 ' + updated + ' 项，队列继续保持暂停。', 'ok');
}

function renderTaskEmptyState(emptyState, filtered) {
  if (!emptyState) return;
  const icon = emptyState.querySelector('.task-table-empty-icon');
  const title = emptyState.querySelector('.task-table-empty-title');
  const hint = emptyState.querySelector('.task-table-empty-hint');
  if (icon) icon.className = 'task-table-empty-icon ph-duotone ' + (filtered ? 'ph-magnifying-glass' : 'ph-upload-simple');
  if (title) title.textContent = filtered ? '没有匹配的任务' : '先添加模板图和参考色';
  if (hint) hint.innerHTML = filtered
    ? '<a href="#" onclick="setTaskSearch(\'\');setTaskFilter(\'all\');return false">清空搜索 / 查看全部</a>'
    : '请使用上方两张上传卡；支持点击、拖放和粘贴 JPG / PNG / WEBP，两类素材齐备后自动建立任务。';
}

// ===== 唯一UI渲染入口（STEP 2 + STEP 4） =====
function renderUI() {
  console.log('[renderUI triggered]', window.__currentBatch?.batchId || 'empty');
  const batch = window.__currentBatch || { tasks: [], totals: {}, status: 'empty' };
  var isPausedScene = Boolean(batch.userPauseRequested || batch.systemPauseRequested) || ['paused','pausing'].includes(String(batch.status || '').toLowerCase());
  var recolorSceneState = isPausedScene ? 'paused' : batch.active ? 'running' : batch.status === 'completed' ? 'completed' : ((batch.tasks || []).length ? 'ready' : 'empty');
  document.body.dataset.recolorState = recolorSceneState;
  // STEP 4: 状态与UI强一致校验
  if (!Array.isArray(batch.tasks)) batch.tasks = [];
  const totals = batch.totals || {};
  const baseTasks = (batch.tasks || []).filter(t => t.executionStatus !== 'deleted' && !t.hiddenInTaskList);
  const filteredTasks = applyTaskSort(filterBySearch(filterByStatus(baseTasks, false), false), false);
  const realTasks = (taskFilter === 'done' || taskFilter === 'all')
    ? filteredTasks
    : filteredTasks.filter(t => t.executionStatus !== 'completed');

  // 任务列表连续滚动。保留全部任务，由列表容器负责滚动，不再拆成传统分页。
  const pageTasks = realTasks;
  // 批次概览区
  const bo = $('batch-overview');
  if (bo) bo.style.display = 'flex';
  const ptb = $('perf-topbar');
  if (ptb) ptb.style.display = totals.total > 0 ? 'block' : 'none';
  $('bo-pairs').textContent = totals.total;
  $('bo-done').textContent = totals.success;
  $('bo-running').textContent = totals.running;
  $('bo-failed').textContent = totals.failed;

  ['bo-done','bo-running','bo-failed'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.closest('.bo-stat')) {
      const card = el.closest('.bo-stat');
      const map = { 'bo-done': 'done', 'bo-running': 'running', 'bo-failed': 'failed' };
      card.onclick = () => setTaskFilter(map[id]);
      card.style.cursor = 'pointer';
      card.title = '点击筛选' + (card.querySelector('.bo-stat-l')?.textContent||'') + '任务';
    }
  });

  const boProgress = $('bo-progress');
  if (boProgress) boProgress.style.display = 'none';
  renderPauseBanner(batch);

  // 更新一键生图进度状态
  const gaStatus = $('bt-generate-status');
  const gaBtn = $('bt-generate-all');
  if (isBatchRunning) {
    if (batch.active) {
      if (gaStatus) { gaStatus.style.display = 'inline'; gaStatus.textContent = '生成中'; }
      // STEP 12: running 状态下按钮可用 → "加入当前队列"
      if (gaBtn) { gaBtn.disabled = false; gaBtn.textContent = '加入当前队列'; gaBtn.title = '将新扫描任务追加到当前运行队列'; }
    } else if (batch.status === 'completed' || batch.status === 'cancelled') {
      // 批处理完成，解锁
      isBatchRunning = false;
      const doneCount = totals.success || 0;
      const failedCount = totals.failed || 0;
      if (gaStatus) { gaStatus.style.display = 'inline'; gaStatus.textContent = '✅ 完成 ' + doneCount + '/' + totals.total + (failedCount > 0 ? ' （失败' + failedCount + '）' : ''); }
      if (gaBtn) { gaBtn.disabled = false; gaBtn.textContent = '一键生图'; gaBtn.title = '一键启动全部未完成任务生成'; }
    } else if (batch.status === 'paused') {
      if (gaStatus) { gaStatus.style.display = 'inline'; gaStatus.textContent = '暂停 ' + totals.done + '/' + totals.total; }
      if (gaBtn) { gaBtn.disabled = false; gaBtn.textContent = '一键生图'; }
    }
  } else {
    // 非 running 状态恢复按钮文案
    if (gaBtn) { gaBtn.textContent = '一键生图'; gaBtn.title = '一键启动全部未完成任务生成'; }
  }

  const costNote = $('cost-note');
  if (costNote) {
    costNote.style.display = 'block';
    costNote.innerHTML = '<i class="ph-duotone ph-receipt" aria-hidden="true"></i><span class="batch-cost-copy"><strong>' + calcCost(batch) + ' · ' + (totals.apiAttempts||0) + ' 次 API 调用</strong><span>查看任务执行汇总</span></span><i class="ph-duotone ph-caret-right open" aria-hidden="true"></i>';
    console.log('[COST-RESET] render cost=' + totals.costFen + ' apiCalls=' + (totals.apiAttempts||0));
  }

  // ===== 任务列表：完全清空再渲染 =====
  const taskList = $('task-list');
  const emptyState = $('task-table-empty');
  const countEl = $('ttb-count');

  // 强制清空DOM
  taskList.innerHTML = '';

  if (realTasks.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    if (taskSearchQuery || taskFilter !== 'all') {
      if (countEl) countEl.textContent = '没有匹配的任务';
      renderTaskEmptyState(emptyState, true);
    } else {
      if (countEl) countEl.textContent = '0 项任务';
      renderTaskEmptyState(emptyState, false);
    }
  } else {
    if (emptyState) emptyState.classList.add('hidden');
    if (countEl) countEl.textContent = realTasks.length + ' 项任务';

    taskList.innerHTML = recolorTaskSegments(pageTasks).map(function(group) {
      const rows = group.items.map(function(task) {
        const rawStatus = task.executionStatus || task.status || 'pending';
        const normalizedStatus = normalizeTaskStatus(task);
        const statusView = recolorTaskStatusView(task);
        const canRedo = !['pending','running','interrupted'].includes(normalizedStatus);
        const redoTitle = normalizedStatus === 'completed'
          ? '重新生成该任务结果'
          : normalizedStatus === 'failed' || normalizedStatus === 'error'
            ? '修复失败任务并重新生成'
            : '重新生成此任务';
        const urls = resolveTaskImageUrls(batch, task);
        const isClickableStatus = ['error','failed','interrupted','cancelled','canceled','stopped'].includes(rawStatus);
        const statusClickAttr = isClickableStatus
          ? ' onclick="event.stopPropagation();focusTaskErrorLog(window.__currentBatch?.tasks?.find(t=>t.id===\''+task.id+'\'),event)" style="cursor:pointer" title="点击查看错误日志"'
          : '';
        const tplThumb = urls.hasTemplateName ? ' src="'+urls.templateUrl+'"' : '';
        const outThumb = urls.hasResult ? ' src="'+urls.resultUrl+'"' : '';
        const colorName = escapeHtml(task.referenceColorLabel || task.colorNameWithoutExt || task.colorRef || '—');
        const colorHex = normalizedReferenceHex(task.referenceHex);
        const swatchClass = colorHex ? 'task-color-swatch' : 'task-color-swatch is-unset';
        const swatchStyle = colorHex ? ' style="--task-color:'+colorHex+'"' : '';
        const colorHexCopy = colorHex || '未设置色号';
        const shortId = recolorTaskShortId(task);
        const referenceSessionId = task.uploadBatchId || task.sessionId || '';
        const referenceColorName = task.colorRef || task.colorName || task.colorNameWithoutExt || '';
        const colorMarkup = taskReferenceColorMarkup(referenceSessionId, referenceColorName, task.referenceColorLabel || task.colorNameWithoutExt || task.colorRef || '—', colorHex);
        const modelName = escapeHtml(task.modelSnapshot || task.model || batch.modelSnapshot || batch.model || '模型待定');
        const placeholder = statusView.key === 'running'
          ? '生成中'
          : statusView.key === 'failed'
            ? '生成失败'
            : '等待生成';

        let tplCell = '<div class="task-col task-col-thumb">';
        if (urls.hasTemplateName) {
          tplCell += '<div class="task-thumb"><img'+tplThumb+' loading="lazy" onerror="handleThumbError(this,1)" onload="handleThumbLoad(this)" alt="模板图" title="'+escapeHtml(urls.templateLabel || '点击查看三图对比')+'" onclick="event.stopPropagation();openImageRowPreview(this)"><span class="task-thumb-label task-thumb-missing" style="display:none">模板图缺失</span></div>';
        } else {
          tplCell += '<div class="task-thumb task-thumb-empty"><span>模板图缺失</span></div>';
        }
        tplCell += '</div>';

        let outCell = '<div class="task-col task-col-thumb">';
        if (urls.hasResult) {
          outCell += '<div class="task-thumb"><img'+outThumb+' loading="lazy" onerror="handleThumbError(this,1)" onload="handleThumbLoad(this)" alt="生成图" title="点击查看三图对比" onclick="event.stopPropagation();openImageRowPreview(this)"><span class="task-thumb-label task-thumb-missing" style="display:none">生成图缺失</span></div>';
        } else {
          outCell += '<div class="task-thumb task-thumb-empty '+statusView.key+'"><span>'+placeholder+'</span></div>';
        }
        outCell += '</div>';

        return '<div class="task-row row '+statusView.key+' '+normalizedStatus+'" onclick="selectTask(\''+batch.batchId+'\',\''+task.id+'\')" data-batch="'+batch.batchId+'" data-task="'+task.id+'" data-short-id="'+shortId+'" data-tpl="'+escapeHtml(task.template||task.templateNameWithoutExt||'')+'" data-clr="'+escapeHtml(task.colorRef||task.colorNameWithoutExt||'')+'" data-out="'+(urls.hasResult?escapeHtml(task.output||''):'')+'" data-reference-url="'+escapeHtml(urls.referenceUrl || '')+'">'
          +'<div class="task-number number" title="任务编号 '+shortId+'">'+shortId+'</div>'
          +tplCell
          +'<span class="task-row-arrow arrow" aria-hidden="true"><i class="ph-duotone ph-arrow-right"></i></span>'
          +outCell
          +'<div class="task-col task-col-name task-info"><span class="tn">'+colorMarkup+'</span><span class="ts">'+recolorTaskClock(task)+' · '+colorHexCopy+' · <span>'+modelName+'</span></span></div>'
          +'<div class="task-col task-col-status"><span class="status-pill status '+statusView.key+'"'+statusClickAttr+'>'+(statusView.key==='running'?'<i class="ph-duotone ph-spinner-gap task-running-icon" aria-hidden="true"></i>':'')+statusView.label+'</span>'+(statusView.detail?'<span class="status-copy" title="'+escapeHtml(statusView.full)+'">'+escapeHtml(statusView.detail)+'</span>':'')+(statusView.key==='running'?'<span class="task-running-shine activity" aria-label="生成中，无确定进度"></span>':'')+'</div>'
          +'<div class="task-col task-col-actions row-actions" onclick="event.stopPropagation()">'+(canRedo?'<button class="task-row-btn action retry icon-only" onclick="retrySingleTask(\''+batch.batchId+'\',\''+task.id+'\')" title="'+redoTitle+'" aria-label="重做"><i class="ph-duotone ph-arrow-clockwise" aria-hidden="true"></i></button>':'')+'<button class="task-row-btn action red del icon-only" onclick="clearSingleTask(\''+batch.batchId+'\',\''+task.id+'\')" title="删除任务" aria-label="删除任务"><i class="ph-duotone ph-trash" aria-hidden="true"></i></button></div>'
          +'</div>';
      }).join('');
      return '<div class="task-template-group group" data-group-key="'+escapeHtml(group.key)+'"><strong>'+escapeHtml(group.templateName)+'</strong><span>· '+group.items.length+' 种颜色</span></div>'+rows;
    }).join('');
    pageTasks.forEach(function(task) {
      const exportedCurrentVersion = Boolean(task.exportedAt)
        && Number(task.exportedResultVersion || 0) === Number(task.resultVersion || 0);
      if (!exportedCurrentVersion) return;
      const row = taskList.querySelector('.task-row[data-task="' + CSS.escape(task.id) + '"]');
      const meta = row?.querySelector('.task-col-name .ts');
      if (!meta) return;
      const mark = document.createElement('span');
      mark.className = 'task-exported-mark';
      mark.textContent = '已导出';
      mark.title = '最近导出：' + formatTime(task.exportedAt);
      meta.appendChild(mark);
    });
  }

  updateBottomBar(batch);
  $('sg1').textContent = totals.running;
  $('sg2').textContent = totals.success;
  $('sg3').textContent = totals.failed;
  setStatus(batch.active ? 'bs' : batch.status === 'completed' ? 'ok' : 'er', batch.active ? '生成中' : statusText(batch.status));
  // 窄栏是全局快捷入口，不应被当前筛选结果反向置灰。
  updateRailAvailability(baseTasks);
  autoSelectLatestCompleted(batch);
}

// ===== 底部操作栏更新 =====
function keepSoftResetVisible() {
  const btn = $('ba-soft-reset');
  if (btn) btn.style.display = 'inline-flex';
}

function closeTaskCleanupMenu() {
  const dropdown = $('task-cleanup-dropdown');
  const trigger = $('task-cleanup-trigger');
  if (dropdown) {
    dropdown.hidden = true;
    dropdown.style.removeProperty('left');
    dropdown.style.removeProperty('top');
    dropdown.style.removeProperty('bottom');
  }
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function positionTaskCleanupMenu() {
  const dropdown = $('task-cleanup-dropdown');
  const trigger = $('task-cleanup-trigger');
  if (!dropdown || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - dropdown.offsetWidth - 8))}px`;
  dropdown.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
  dropdown.style.top = 'auto';
}

function toggleTaskCleanupMenu(event) {
  event?.stopPropagation();
  const dropdown = $('task-cleanup-dropdown');
  const trigger = $('task-cleanup-trigger');
  if (!dropdown || !trigger || trigger.disabled) return;
  const willOpen = dropdown.hidden;
  dropdown.hidden = !willOpen;
  trigger.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) requestAnimationFrame(positionTaskCleanupMenu);
}

document.addEventListener('click', event => {
  if (!event.target.closest('#task-cleanup-menu')) closeTaskCleanupMenu();
});
window.addEventListener('resize', () => {
  const dropdown = $('task-cleanup-dropdown');
  if (dropdown && !dropdown.hidden) positionTaskCleanupMenu();
});

function updateBottomBar(batch) {
  const baGen = $('ba-gen');
  const baContinue = $('ba-continue');
  const baCancel = $('ba-cancel');
  const baRetry = $('ba-retry');
  const baRetryCancel = $('ba-retry-cancel');
  const baZip = $('ba-zip');
  const baColorDl = $('ba-color-dl');
  const baOutputs = $('ba-outputs');
  const cleanupMenu = $('task-cleanup-menu');
  const cleanupTrigger = $('task-cleanup-trigger');
  const baClrDone = $('ba-clear-done');
  const baClrFail = $('ba-clear-fail');
  const baClrCancel = $('ba-clear-cancel');
  const baClrAll = $('ba-clear-all');
  const baSoftReset = $('ba-soft-reset');

  if (!batch) {
    document.querySelectorAll('.clr-btn').forEach(b => b.style.display = 'none');
    closeTaskCleanupMenu();
    if (baGen) baGen.style.display = 'inline-flex';
    if (baContinue) baContinue.style.display = 'none';
    if (baCancel) baCancel.style.display = 'none';
    if (baRetry) baRetry.style.display = 'none';
    if (baRetryCancel) baRetryCancel.style.display = 'none';
    if (baZip) baZip.style.display = 'none';
    if (baColorDl) baColorDl.style.display = 'none';
    if (baSoftReset) baSoftReset.style.display = 'inline-flex';
    syncFinalBottomBar(batch);
    return;
  }

  const totals = batch.totals;
  const hasFailed = batch.tasks.some(t => ['failed','error'].includes(t.executionStatus));
  const hasCompleted = totals.success > 0;
  const hasPending = totals.pending > 0 || hasFailed;
  const hasCancelled = batch.tasks.some(t => ['cancelled'].includes(t.executionStatus)); // retryCancelled 只处理 cancelled
  const hasInterruptedOrCancelled = batch.tasks.some(t => ['cancelled','interrupted'].includes(t.executionStatus)); // 清理按钮用
  const hasAnyTasks = batch.tasks.length > 0;

  if (baGen) baGen.style.display = batch.active ? 'none' : 'inline-flex';
  if (baContinue) baContinue.style.display = (!batch.active && hasCompleted && hasPending) ? 'inline-flex' : 'none';
  if (baCancel) baCancel.style.display = batch.active ? 'inline-flex' : 'none';
  if (baRetry) baRetry.style.display = (!batch.active && hasFailed) ? 'inline-flex' : 'none';
  if (baRetryCancel) baRetryCancel.style.display = (!batch.active && hasCancelled) ? 'inline-flex' : 'none';
  if (baZip) baZip.style.display = hasCompleted ? 'inline-flex' : 'none';
  if (baColorDl) baColorDl.style.display = 'none';
  if (baOutputs) baOutputs.style.display = 'none';
  const showCleanupMenu = hasAnyTasks;
  if (cleanupMenu) cleanupMenu.style.display = showCleanupMenu ? 'inline-flex' : 'none';
  if (!showCleanupMenu) closeTaskCleanupMenu();
  if (cleanupTrigger) cleanupTrigger.disabled = !showCleanupMenu;
  if (baClrDone) baClrDone.disabled = !hasCompleted;
  if (baClrFail) baClrFail.disabled = !hasFailed;
  if (baClrCancel) baClrCancel.disabled = !hasInterruptedOrCancelled;
  if (baClrAll) baClrAll.disabled = !hasAnyTasks;
  if (baSoftReset) { baSoftReset.style.display = 'inline-flex'; }
  keepSoftResetVisible();
  syncFinalBottomBar(batch);
}

// 阶段 F：固定底栏只保留一个会随状态变化的运行按钮、导出与彻底清空。
// 旧按钮仍由上面的兼容分支维护，但不会在正式界面出现。
function syncFinalBottomBar(batch) {
  var run = $('ba-run');
  var label = $('ba-run-label');
  var hint = $('bottom-run-state');
  var exportBtn = $('ba-export');
  if (!run || !label || !hint || !exportBtn) return;
  var runIcon = run.querySelector('.ph-duotone');
  var tasks = batch && Array.isArray(batch.tasks) ? batch.tasks : [];
  var totals = batch?.totals || {};
  var hasPending = tasks.some(function(task) { return ['pending','queued','waiting','failed','error','interrupted','cancelled'].includes(task.executionStatus || task.status); }) || Boolean(scanPairs?.length);
  var hasCompleted = Number(totals.success || totals.completed || 0) > 0 || tasks.some(function(task) { return (task.executionStatus || task.status) === 'completed'; });
  exportBtn.disabled = !hasCompleted;
  if (batch?.active) {
    run.disabled = false;
    run.dataset.action = 'pause';
    label.textContent = '暂停生成';
    if (runIcon) { runIcon.classList.remove('ph-play', 'ph-arrow-clockwise'); runIcon.classList.add('ph-pause'); }
    hint.textContent = '已提交的任务会继续完成；不会再启动新任务';
  } else if (batch?.batchId && hasPending && !scanPairs?.length) {
    var rebindRequired = batch.pauseReason === 'model_unavailable' && !batch.lastModelRebind;
    run.disabled = rebindRequired;
    run.dataset.action = 'resume';
    label.textContent = '继续生成';
    if (runIcon) { runIcon.classList.remove('ph-play', 'ph-pause'); runIcon.classList.add('ph-arrow-clockwise'); }
    if (rebindRequired) hint.textContent = '请先在暂停提示中确认待生成任务使用的新模型';
    else if (batch.pauseReason === 'model_unavailable') hint.textContent = '模型已安全切换；只有再次点击后才恢复领取任务';
    else if (batch.pauseReason === 'global_api_error') hint.textContent = '系统恢复检测未通过时不会启动新任务';
    else if (batch.pauseReason === 'remote_unknown') hint.textContent = '先查询远端结果；未确认前不会重复提交';
    else hint.textContent = '点击后才会恢复领取队尾任务';
  } else {
    run.disabled = !hasPending;
    run.dataset.action = 'start';
    label.textContent = '开始生成';
    if (runIcon) { runIcon.classList.remove('ph-pause', 'ph-arrow-clockwise'); runIcon.classList.add('ph-play'); }
    hint.textContent = hasPending ? '新任务将按当前并发设置进入队列' : '上传模板图和参考色后将自动建立任务';
  }
  document.querySelectorAll('.legacy-bottom-action, #ba-retry, #ba-retry-cancel, #ba-zip, #ba-color-dl, #ba-outputs, #task-cleanup-menu, #ba-batch-clear').forEach(function(node) {
    if (node) node.style.display = 'none';
  });
}

function handleBottomRun() {
  var action = $('ba-run')?.dataset.action || 'start';
  if (action === 'pause') return cancelGen();
  if (action === 'resume') return continueGen();
  return handleStartGen();
}

function openRecolorConcurrency() {
  var current = Number(window.__currentBatch?.concurrency || recolorConcurrency || 8);
  var body = '<p class="modal-note">默认同时生成 8 张。可设置 3～8；运行中调低会自然回落，调高会立即补足空闲位置，不打断已提交任务。</p><div class="concurrency-picker"><button type="button" onclick="stepRecolorConcurrency(-1)" aria-label="减少并发">−</button><div><strong id="recolor-concurrency-value">'+current+'</strong><span>同时生成</span></div><button type="button" onclick="stepRecolorConcurrency(1)" aria-label="增加并发">＋</button></div><input id="recolor-concurrency-input" type="range" min="3" max="8" step="1" value="'+current+'" oninput="syncRecolorConcurrencyPreview(this.value)"><div class="concurrency-scale"><span>3 · 更稳</span><span>8 · 更快</span></div>';
  var overlay = openRecolorOverlay('并发设置', body, '<button class="btn bs" data-safe-focus onclick="closeRecolorOverlay()">取消</button><button class="btn lanvas-primary" onclick="saveRecolorConcurrency()">保存设置</button>');
  overlay.querySelector('.recolor-workbench-modal')?.classList.add('recolor-concurrency-modal');
}

function syncRecolorConcurrencyPreview(value) {
  var safe = Math.min(8, Math.max(3, Number(value) || 8));
  var input = document.getElementById('recolor-concurrency-input');
  var output = document.getElementById('recolor-concurrency-value');
  if (input) input.value = safe;
  if (output) output.textContent = safe;
}

function stepRecolorConcurrency(delta) {
  syncRecolorConcurrencyPreview(Number(document.getElementById('recolor-concurrency-input')?.value || recolorConcurrency) + delta);
}

async function saveRecolorConcurrency() {
  var next = Math.min(8, Math.max(3, Number(document.getElementById('recolor-concurrency-input')?.value) || 8));
  recolorConcurrency = next;
  try { localStorage.setItem('recolor_concurrency', String(next)); } catch (error) {}
  var activeBatchId = window.__currentBatch?.batchId;
  if (activeBatchId) {
    var result = await api('/api/batches/'+encodeURIComponent(activeBatchId)+'/concurrency', { concurrency:next });
    if (!result.success) return toast(result.error || '并发设置保存失败', 'ng');
    if (window.__currentBatch) window.__currentBatch.concurrency = next;
  }
  var button = document.getElementById('ba-concurrency');
  if (button) button.title = '并发设置：'+next;
  closeRecolorOverlay();
  toast('并发数已设为 '+next, 'ok');
}

const RECOLOR_MODAL_PANEL_SELECTOR = [
  ':scope > .recolor-workbench-modal',
  ':scope > .recolor-confirm-modal',
  ':scope > .generation-confirm-modal',
  ':scope > .prompt-modal-panel',
  ':scope > .img-viewer-panel',
  ':scope > .cost-modal'
].join(',');

function centerRecolorModalInHost(container) {
  if (!container) return;
  container.style.setProperty('--recolor-modal-shift-x', '0px');
  container.style.setProperty('--recolor-modal-shift-y', '0px');
  try {
    if (window.parent === window) return;
    var frame = window.parent.document.getElementById('frame-recolor');
    if (!frame || frame.contentWindow !== window) return;
    var frameRect = frame.getBoundingClientRect();
    var panel = container.querySelector(RECOLOR_MODAL_PANEL_SELECTOR);
    if (!panel || !frameRect.width || !frameRect.height || !window.innerWidth || !window.innerHeight) return;
    var panelRect = panel.getBoundingClientRect();
    var hostRect = window.parent.document.documentElement.getBoundingClientRect();
    var scaleX = frameRect.width / window.innerWidth;
    var scaleY = frameRect.height / window.innerHeight;
    var panelCenterX = frameRect.left + (panelRect.left + panelRect.width / 2) * scaleX;
    var panelCenterY = frameRect.top + (panelRect.top + panelRect.height / 2) * scaleY;
    var desiredX = (hostRect.left + hostRect.width / 2 - panelCenterX) / scaleX;
    var desiredY = (hostRect.top + hostRect.height / 2 - panelCenterY) / scaleY;
    var minX = 24 - panelRect.left;
    var maxX = window.innerWidth - 24 - panelRect.right;
    var minY = 24 - panelRect.top;
    var maxY = window.innerHeight - 24 - panelRect.bottom;
    var shiftX = minX <= maxX ? Math.max(minX, Math.min(maxX, desiredX)) : 0;
    var shiftY = minY <= maxY ? Math.max(minY, Math.min(maxY, desiredY)) : 0;
    container.style.setProperty('--recolor-modal-shift-x', shiftX.toFixed(2) + 'px');
    container.style.setProperty('--recolor-modal-shift-y', shiftY.toFixed(2) + 'px');
    container.dataset.hostCentered = 'true';
  } catch (error) {}
}

function refreshRecolorModalHostCenters() {
  document.querySelectorAll('.recolor-workbench-overlay,.recolor-confirm-overlay,.prompt-modal-overlay,.img-viewer-overlay,.cost-modal-overlay').forEach(function(container) {
    if (window.getComputedStyle(container).display !== 'none') centerRecolorModalInHost(container);
  });
}

window.addEventListener('resize', function() { requestAnimationFrame(refreshRecolorModalHostCenters); });

function notifyRecolorModalState(open) {
  if (open) refreshRecolorModalHostCenters();
  try { window.parent?.postMessage({ type:'recolor-modal-state', open:Boolean(open) }, location.origin); } catch (error) {}
}

function focusRecolorModal(container) {
  requestAnimationFrame(function() {
    var target = container?.querySelector('[data-safe-focus]');
    if (!target) target = container?.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
    target?.focus?.();
  });
}

function closeRecolorOverlay() {
  var returnFocus = recolorModalReturnFocus;
  endReferenceCropDrag();
  (referenceCropState?.localUrls || []).forEach(function(url) { try { URL.revokeObjectURL(url); } catch (error) {} });
  referenceCropState = null;
  pendingReferenceUploadFiles = [];
  pendingModelRebindState = null;
  document.getElementById('recolor-workbench-overlay')?.remove();
  recolorModalReturnFocus = null;
  notifyRecolorModalState(false);
  requestAnimationFrame(function() { returnFocus?.focus?.(); });
}

function trapRecolorFocus(event, container) {
  if (event.key !== 'Tab' || !container) return;
  var focusable = [...container.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  var first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function recolorSceneIconMarkup(scene) {
  var paths = {
    export: '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 19h14"></path>',
    crop: '<path d="M7 3v14a2 2 0 0 0 2 2h12"></path><path d="M3 7h14a2 2 0 0 1 2 2v12"></path>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18h1.2a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a6 6 0 0 0 0-12z"></path><circle cx="7.5" cy="10" r=".9"></circle><circle cx="9" cy="6.5" r=".9"></circle><circle cx="13" cy="6" r=".9"></circle>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path><path d="M12 7v5l3 2"></path>',
    prompt: '<path d="M5 5h14v14H5z"></path><path d="M8 9h8M8 13h6"></path>',
    concurrency: '<path d="M5 7h14M5 17h14"></path><circle cx="9" cy="7" r="2"></circle><circle cx="15" cy="17" r="2"></circle>',
    default: '<path d="M12 3 4 7v10l8 4 8-4V7z"></path><path d="m4 7 8 4 8-4M12 11v10"></path>'
  };
  var safe = paths[scene] ? scene : 'default';
  return '<span class="recolor-modal-icon scene-'+safe+'" aria-hidden="true"><span class="ui-icon"><svg viewBox="0 0 24 24">'+paths[safe]+'</svg></span></span>';
}

function openRecolorOverlay(title, content, footer, options = {}) {
  var opener = document.activeElement;
  closeRecolorOverlay();
  recolorModalReturnFocus = opener instanceof HTMLElement ? opener : null;
  var overlay = document.createElement('div');
  overlay.id = 'recolor-workbench-overlay';
  var scene = String(options.scene || 'default').replace(/[^a-z0-9-]/gi, '');
  overlay.className = 'recolor-workbench-overlay scene-'+scene;
  overlay.onclick = function(event) { if (event.target === overlay) closeRecolorOverlay(); };
  var subtitle = options.subtitle ? '<span class="recolor-modal-subtitle">'+escapeHtml(options.subtitle)+'</span>' : '';
  var badge = options.badge ? '<span class="recolor-modal-badge">'+escapeHtml(options.badge)+'</span>' : '';
  overlay.innerHTML = '<section class="recolor-workbench-modal scene-'+scene+' '+escapeHtml(options.modalClass || '')+'" role="dialog" aria-modal="true" aria-label="'+escapeHtml(title)+'"><header class="recolor-modal-head"><div class="recolor-modal-title"><h2>'+escapeHtml(title)+'</h2>'+subtitle+'</div>'+badge+'<button class="recolor-modal-close" onclick="closeRecolorOverlay()" aria-label="关闭"><span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg></span></button></header><div class="recolor-workbench-modal-body">'+content+'</div><footer class="recolor-modal-foot">'+footer+'</footer></section>';
  overlay.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') return closeRecolorOverlay();
    trapRecolorFocus(event, overlay);
  });
  document.body.appendChild(overlay);
  notifyRecolorModalState(true);
  focusRecolorModal(overlay);
  return overlay;
}

function askRecolorConfirmation(options = {}) {
  document.getElementById('recolor-confirm-overlay')?.remove();
  return new Promise(function(resolve) {
    var returnFocus = document.activeElement;
    var overlay = document.createElement('div');
    overlay.id = 'recolor-confirm-overlay';
    overlay.className = 'recolor-confirm-overlay';
    var tone = options.danger ? 'danger' : 'brand';
    var scene = String(options.scene || (options.danger ? 'danger' : 'confirm')).replace(/[^a-z0-9-]/gi, '');
    var facts = (options.facts || []).map(function(item) {
      return '<div class="recolor-confirm-fact"><span>'+escapeHtml(item.label || '')+'</span><strong>'+escapeHtml(item.value || '')+'</strong></div>';
    }).join('');
    overlay.className = 'recolor-confirm-overlay scene-'+scene;
    overlay.innerHTML = '<section class="recolor-confirm-modal '+tone+' scene-'+scene+'" role="alertdialog" aria-modal="true" aria-label="'+escapeHtml(options.title || '请确认')+'">'
      +'<header><span class="recolor-confirm-mark" aria-hidden="true">'+(options.danger ? '!' : '✦')+'</span><div><h2>'+escapeHtml(options.title || '请确认')+'</h2><p>'+escapeHtml(options.subtitle || '')+'</p></div><button type="button" class="recolor-confirm-close" data-confirm-cancel aria-label="关闭"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg></span></button></header>'
      +'<div class="recolor-confirm-body">'
      +(options.visualHtml || '')
      +(facts ? '<div class="recolor-confirm-facts">'+facts+'</div>' : '')
      +(options.message ? '<div class="recolor-confirm-message">'+escapeHtml(options.message)+'</div>' : '')
      +'</div>'
      +'<footer><button type="button" class="btn bs" data-confirm-cancel data-safe-focus>'+(escapeHtml(options.cancelText || '取消'))+'</button><button type="button" class="btn '+(options.danger ? 'bd' : 'lanvas-primary')+'" data-confirm-ok>'+(escapeHtml(options.confirmText || '确认'))+'</button></footer></section>';
    var finish = function(value) {
      overlay.remove();
      notifyRecolorModalState(false);
      requestAnimationFrame(function() { returnFocus?.focus?.(); });
      resolve(value);
    };
    overlay.querySelectorAll('[data-confirm-cancel]').forEach(function(button) { button.onclick = function() { finish(false); }; });
    overlay.querySelector('[data-confirm-ok]').onclick = function() { finish(true); };
    overlay.onclick = function(event) { if (event.target === overlay) finish(false); };
    overlay.onkeydown = function(event) {
      if (event.key === 'Escape') return finish(false);
      if (event.key !== 'Tab') return;
      var controls = [...overlay.querySelectorAll('button:not([disabled])')];
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.body.appendChild(overlay);
    notifyRecolorModalState(true);
    focusRecolorModal(overlay);
  });
}

function clampCropNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedReferenceCrop(crop) {
  var source = crop || {};
  var x = clampCropNumber(Number(source.x) || 0, 0, 1);
  var y = clampCropNumber(Number(source.y) || 0, 0, 1);
  var width = clampCropNumber(Number(source.width) || 1, .02, 1 - x);
  var height = clampCropNumber(Number(source.height) || 1, .02, 1 - y);
  return { x: x, y: y, width: width, height: height };
}

function referenceCropImageUrl(sessionId, name) {
  return '/uploads/sessions/' + encodeURIComponent(sessionId) + '/colors/' + encodeURIComponent(name);
}

function activeReferenceCropImageUrl(reference) {
  if (reference?.localUrl) return reference.localUrl;
  return referenceCropImageUrl(referenceCropState?.sessionId || '', reference?.name || '');
}

function referenceCropEditorBody(references, initialUrl) {
  var fileButtons = references.map(function(reference, index) {
    return '<button type="button" class="reference-crop-file'+(index===0?' active':'')+'" data-crop-index="'+index+'" onclick="selectReferenceCropSource('+index+')"><img src="'+activeReferenceCropImageUrl(reference)+'" alt=""><span><b>'+escapeHtml(reference.name.replace(/\.[^.]+$/, ''))+'</b><small>'+(index===0?'当前编辑':'将应用相同位置')+'</small></span></button>';
  }).join('');
  return '<div class="reference-crop-toolbar"><p class="modal-note reference-crop-note"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M6 3v15a3 3 0 0 0 3 3h12"></path><path d="M3 6h15a3 3 0 0 1 3 3v12"></path></svg></span>只裁剪参考色图片；拖动裁剪框或八个控制点调整范围，同批图片复用相同比例。</p><span class="reference-crop-ratio-label">裁剪比例</span><button class="reference-crop-ratio active" type="button" onclick="setReferenceCropRatio(\'free\',this)">自由</button><button class="reference-crop-ratio" type="button" onclick="setReferenceCropRatio(\'1:1\',this)">1:1</button><button class="reference-crop-ratio" type="button" onclick="setReferenceCropRatio(\'4:5\',this)">4:5</button><button class="reference-crop-ratio" type="button" onclick="setReferenceCropRatio(\'original\',this)">原图</button></div>'
    +'<div class="reference-crop-layout"><div class="reference-crop-workspace"><div class="reference-crop-source-meta"><strong id="reference-crop-source-name">'+escapeHtml(references[0].name)+'</strong><span>拖动裁剪区域，所选范围会按比例同步到本批参考图</span></div>'
    +'<div class="reference-crop-stage"><div class="reference-crop-surface" id="reference-crop-surface"><img id="reference-crop-image" src="'+initialUrl+'" alt="裁剪参考图" draggable="false" onload="initializeReferenceCropImage(this)"><div class="reference-crop-selection" id="reference-crop-selection" tabindex="0" role="application" aria-label="裁剪范围，可拖动并使用方向键移动" onpointerdown="startReferenceCropDrag(event,\'move\')" onkeydown="nudgeReferenceCrop(event)"><span class="reference-crop-grid grid-v one"></span><span class="reference-crop-grid grid-v two"></span><span class="reference-crop-grid grid-h one"></span><span class="reference-crop-grid grid-h two"></span>'
    +['nw','n','ne','e','se','s','sw','w'].map(function(handle) { return '<button type="button" class="reference-crop-handle '+handle+'" aria-label="调整裁剪范围" onpointerdown="startReferenceCropDrag(event,\''+handle+'\')"></button>'; }).join('')
    +'<span class="reference-crop-size" id="reference-crop-size">读取图片尺寸…</span></div></div></div><p class="reference-crop-help">拖动框移动范围，拖动八个控制点调整大小；方向键微调，Shift＋方向键快速移动。</p></div>'
    +'<aside class="reference-crop-side"><section><div class="reference-crop-side-title"><div><strong>本批参考色 · '+references.length+' 张</strong><small>第一张设置范围，批量预览后再添加</small></div><span>同批 '+references.length+' 张</span></div><div class="reference-crop-files">'+fileButtons+'</div></section>'
    +'<section class="reference-crop-preview-panel"><div class="reference-crop-side-title"><strong>批量裁剪预览</strong><span>确认前检查</span></div><div class="reference-crop-preview" id="reference-crop-preview"><span>点击“预览裁剪”查看整批结果</span></div></section>'
    +'<section class="reference-crop-warning" id="reference-crop-warning" hidden></section></aside></div>';
}

function openPendingReferenceCrop(files) {
  var references = files.map(function(file) { return { name:file.name, file:file, localUrl:URL.createObjectURL(file) }; });
  if (!references.length) return;
  var localUrls = references.map(function(reference) { return reference.localUrl; });
  var state = { mode:'pending', sessionId:null, references:references, selectedIndex:0, crop:normalizedReferenceCrop({ x:.08, y:.08, width:.84, height:.84 }), ratioMode:'free', drag:null, naturalWidth:0, naturalHeight:0, localUrls:localUrls };
  var body = referenceCropEditorBody(references, references[0].localUrl);
  var footer = '<button class="btn bs" type="button" onclick="setReferenceCropFullImage()">重置裁剪</button><span class="reference-crop-footer-spacer"></span><button class="btn bs" type="button" onclick="closeRecolorOverlay()">取消</button><button class="btn bs" type="button" onclick="previewReferenceCrop()">预览裁剪</button><button class="btn lanvas-primary" id="reference-crop-apply" type="button" onclick="applyReferenceCrop(false)">确认裁剪并添加</button>';
  openRecolorOverlay('裁剪后添加参考色', body, footer, { scene:'crop', subtitle:'确认前图片只保留在本机，不上传、不创建任务', badge:references.length+' 张', modalClass:'reference-crop-modal' });
  referenceCropState = state;
  updateReferenceCropBox();
}

async function ensureReferenceCropSession() {
  if (scanData?.sessionId) return scanData.sessionId;
  if (!filesStore.color.length) return null;
  if (!filesStore.template.length) {
    toast('请先加入至少一张模板图，系统会建立本次上传批次后再进入裁剪', 'wn');
    return null;
  }
  if (automaticScanTimer) {
    clearTimeout(automaticScanTimer);
    automaticScanTimer = null;
  }
  await doScan();
  return scanData?.sessionId || null;
}

async function openReferenceCrop() {
  var sessionId = await ensureReferenceCropSession();
  if (!sessionId) return;
  var result = await api('/api/recolor/reference-colors?sessionId=' + encodeURIComponent(sessionId));
  if (!result.success) return toast(result.error || '读取参考色失败', 'ng');
  var references = result.references || [];
  if (!references.length) return toast('当前上传批次没有可裁剪的参考色', 'wn');
  var firstCrop = references.find(function(item) { return item.cropApplied && item.crop; })?.crop;
  var crop = normalizedReferenceCrop(firstCrop || { x: .08, y: .08, width: .84, height: .84 });
  var fileButtons = references.map(function(reference, index) {
    return '<button type="button" class="reference-crop-file'+(index===0?' active':'')+'" data-crop-index="'+index+'" onclick="selectReferenceCropSource('+index+')"><img src="'+referenceCropImageUrl(sessionId, reference.name)+'" alt=""><span><b>'+escapeHtml(reference.name.replace(/\.[^.]+$/, ''))+'</b><small>'+(index===0?'当前编辑':(reference.cropApplied?'已裁剪':'将应用相同位置'))+'</small></span></button>';
  }).join('');
  var body = '<div class="reference-crop-toolbar"><p class="modal-note reference-crop-note"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M6 3v15a3 3 0 0 0 3 3h12"></path><path d="M3 6h15a3 3 0 0 1 3 3v12"></path></svg></span>只裁剪参考色图片；拖动裁剪框或八个控制点调整范围，同批图片复用相同比例。</p><span class="reference-crop-ratio-label">裁剪比例</span><button class="reference-crop-ratio active" type="button" onclick="setReferenceCropRatio(\'free\',this)">自由</button><button class="reference-crop-ratio" type="button" onclick="setReferenceCropRatio(\'1:1\',this)">1:1</button><button class="reference-crop-ratio" type="button" onclick="setReferenceCropRatio(\'4:5\',this)">4:5</button><button class="reference-crop-ratio" type="button" onclick="setReferenceCropRatio(\'original\',this)">原图</button></div>'
    +'<div class="reference-crop-layout">'
    +'<div class="reference-crop-workspace"><div class="reference-crop-source-meta"><strong id="reference-crop-source-name">'+escapeHtml(references[0].name)+'</strong><span>拖动裁剪区域，所选范围会按比例同步到本批参考图</span></div>'
    +'<div class="reference-crop-stage"><div class="reference-crop-surface" id="reference-crop-surface"><img id="reference-crop-image" src="'+referenceCropImageUrl(sessionId, references[0].name)+'" alt="裁剪参考图" draggable="false" onload="initializeReferenceCropImage(this)"><div class="reference-crop-selection" id="reference-crop-selection" tabindex="0" role="application" aria-label="裁剪范围，可拖动并使用方向键移动" onpointerdown="startReferenceCropDrag(event,\'move\')" onkeydown="nudgeReferenceCrop(event)"><span class="reference-crop-grid grid-v one"></span><span class="reference-crop-grid grid-v two"></span><span class="reference-crop-grid grid-h one"></span><span class="reference-crop-grid grid-h two"></span>'
    +['nw','n','ne','e','se','s','sw','w'].map(function(handle) { return '<button type="button" class="reference-crop-handle '+handle+'" aria-label="调整裁剪范围" onpointerdown="startReferenceCropDrag(event,\''+handle+'\')"></button>'; }).join('')
    +'<span class="reference-crop-size" id="reference-crop-size">读取图片尺寸…</span></div></div></div><p class="reference-crop-help">拖动框移动范围，拖动八个控制点调整大小；方向键微调，Shift＋方向键快速移动。</p></div>'
    +'<aside class="reference-crop-side"><section><div class="reference-crop-side-title"><div><strong>本批参考色 · '+references.length+' 张</strong><small>第一张设置范围，批量预览后再添加</small></div><span>同批 '+references.length+' 张</span></div><div class="reference-crop-files">'+fileButtons+'</div></section>'
    +'<section class="reference-crop-preview-panel"><div class="reference-crop-side-title"><strong>裁剪预览</strong><span>当前图片</span></div><div class="reference-crop-preview" id="reference-crop-preview"><span>点击“预览裁剪”查看真实结果</span></div></section>'
    +'<section class="reference-crop-warning" id="reference-crop-warning" hidden></section></aside></div>';
  var hasAppliedCrop = references.some(function(reference) { return reference.cropApplied; });
  var footer = '<button class="btn bs" type="button" onclick="setReferenceCropFullImage()">重置裁剪</button>'
    +(hasAppliedCrop?'<button class="btn bs" type="button" onclick="requestReferenceCropRestore()">恢复原图</button>':'')
    +'<span class="reference-crop-footer-spacer"></span><button class="btn bs" type="button" onclick="closeRecolorOverlay()">取消</button><button class="btn bs" type="button" onclick="previewReferenceCrop()">预览裁剪</button><button class="btn lanvas-primary" id="reference-crop-apply" type="button" onclick="applyReferenceCrop(false)">确认裁剪并预览</button>';
  var overlay = openRecolorOverlay('裁剪后添加参考色', body, footer, {
    scene:'crop',
    subtitle:'在第一张参考图上确定范围，同一比例应用到本批全部图片',
    badge:references.length+' 张',
    modalClass:'reference-crop-modal'
  });
  referenceCropState = { sessionId: sessionId, references: references, selectedIndex: 0, crop: crop, ratioMode: 'free', drag: null, naturalWidth: 0, naturalHeight: 0 };
  updateReferenceCropBox();
}

function initializeReferenceCropImage(image) {
  if (!referenceCropState) return;
  referenceCropState.naturalWidth = image.naturalWidth || 1;
  referenceCropState.naturalHeight = image.naturalHeight || 1;
  var surface = $('reference-crop-surface');
  if (surface) {
    var ratio = referenceCropState.naturalWidth / referenceCropState.naturalHeight;
    surface.style.aspectRatio = referenceCropState.naturalWidth + ' / ' + referenceCropState.naturalHeight;
    surface.style.width = 'min(100%, calc(56vh * ' + ratio + '))';
  }
  updateReferenceCropBox();
}

function referenceCropNormalizedRatio(mode) {
  if (!referenceCropState || mode === 'free') return null;
  var imageRatio = (referenceCropState.naturalWidth || 1) / (referenceCropState.naturalHeight || 1);
  var outputRatio = mode === '1:1' ? 1 : mode === '4:5' ? .8 : imageRatio;
  return outputRatio / imageRatio;
}

function fitReferenceCropToRatio(crop, mode) {
  var normalizedRatio = referenceCropNormalizedRatio(mode);
  if (!normalizedRatio) return normalizedReferenceCrop(crop);
  var source = normalizedReferenceCrop(crop);
  var centerX = source.x + source.width / 2;
  var centerY = source.y + source.height / 2;
  var width = source.width;
  var height = source.height;
  if (width / height > normalizedRatio) width = height * normalizedRatio;
  else height = width / normalizedRatio;
  width = Math.min(width, 1);
  height = Math.min(height, 1);
  var x = clampCropNumber(centerX - width / 2, 0, 1 - width);
  var y = clampCropNumber(centerY - height / 2, 0, 1 - height);
  return normalizedReferenceCrop({ x: x, y: y, width: width, height: height });
}

function setReferenceCropRatio(mode, button) {
  if (!referenceCropState) return;
  referenceCropState.ratioMode = mode;
  document.querySelectorAll('.reference-crop-ratio').forEach(function(item) { item.classList.toggle('active', item === button); });
  if (mode !== 'free') referenceCropState.crop = fitReferenceCropToRatio(referenceCropState.crop, mode);
  updateReferenceCropBox();
}

function selectReferenceCropSource(index) {
  if (!referenceCropState || !referenceCropState.references[index]) return;
  referenceCropState.selectedIndex = index;
  var reference = referenceCropState.references[index];
  document.querySelectorAll('.reference-crop-file').forEach(function(button) { button.classList.toggle('active', Number(button.dataset.cropIndex) === index); });
  var name = $('reference-crop-source-name');
  if (name) name.textContent = reference.name;
  var image = $('reference-crop-image');
  if (image) image.src = activeReferenceCropImageUrl(reference);
  var preview = $('reference-crop-preview');
  if (preview) preview.innerHTML = '<span>点击“预览裁剪”查看这张图片的真实结果</span>';
}

function updateReferenceCropBox() {
  if (!referenceCropState) return;
  referenceCropState.crop = normalizedReferenceCrop(referenceCropState.crop);
  var crop = referenceCropState.crop;
  var selection = $('reference-crop-selection');
  if (selection) {
    selection.style.left = (crop.x * 100) + '%';
    selection.style.top = (crop.y * 100) + '%';
    selection.style.width = (crop.width * 100) + '%';
    selection.style.height = (crop.height * 100) + '%';
  }
  var size = $('reference-crop-size');
  if (size) {
    var pixelWidth = Math.max(1, Math.round((referenceCropState.naturalWidth || 1) * crop.width));
    var pixelHeight = Math.max(1, Math.round((referenceCropState.naturalHeight || 1) * crop.height));
    size.textContent = pixelWidth + ' × ' + pixelHeight + ' px · 起点 ' + Math.round(crop.x * 100) + '%, ' + Math.round(crop.y * 100) + '%';
  }
}

function startReferenceCropDrag(event, handle) {
  if (!referenceCropState || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  var surface = $('reference-crop-surface');
  if (!surface) return;
  referenceCropState.drag = { pointerId: event.pointerId, handle: handle, startX: event.clientX, startY: event.clientY, rect: surface.getBoundingClientRect(), crop: Object.assign({}, referenceCropState.crop) };
  window.addEventListener('pointermove', moveReferenceCropDrag);
  window.addEventListener('pointerup', endReferenceCropDrag);
  window.addEventListener('pointercancel', endReferenceCropDrag);
}

function moveReferenceCropDrag(event) {
  var drag = referenceCropState?.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  var dx = (event.clientX - drag.startX) / Math.max(1, drag.rect.width);
  var dy = (event.clientY - drag.startY) / Math.max(1, drag.rect.height);
  var start = drag.crop;
  var left = start.x, right = start.x + start.width, top = start.y, bottom = start.y + start.height;
  if (drag.handle === 'move') {
    left = clampCropNumber(start.x + dx, 0, 1 - start.width);
    top = clampCropNumber(start.y + dy, 0, 1 - start.height);
    right = left + start.width;
    bottom = top + start.height;
  } else {
    if (drag.handle.includes('w')) left = clampCropNumber(start.x + dx, 0, right - .02);
    if (drag.handle.includes('e')) right = clampCropNumber(start.x + start.width + dx, left + .02, 1);
    if (drag.handle.includes('n')) top = clampCropNumber(start.y + dy, 0, bottom - .02);
    if (drag.handle.includes('s')) bottom = clampCropNumber(start.y + start.height + dy, top + .02, 1);
  }
  referenceCropState.crop = { x: left, y: top, width: right - left, height: bottom - top };
  if (drag.handle !== 'move' && referenceCropState.ratioMode !== 'free') {
    referenceCropState.crop = fitReferenceCropToRatio(referenceCropState.crop, referenceCropState.ratioMode);
  }
  updateReferenceCropBox();
}

function endReferenceCropDrag() {
  if (referenceCropState) referenceCropState.drag = null;
  window.removeEventListener('pointermove', moveReferenceCropDrag);
  window.removeEventListener('pointerup', endReferenceCropDrag);
  window.removeEventListener('pointercancel', endReferenceCropDrag);
}

function nudgeReferenceCrop(event) {
  if (!referenceCropState || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  var stepSize = event.shiftKey ? .05 : .01;
  var crop = referenceCropState.crop;
  if (event.key === 'ArrowLeft') crop.x = clampCropNumber(crop.x - stepSize, 0, 1 - crop.width);
  if (event.key === 'ArrowRight') crop.x = clampCropNumber(crop.x + stepSize, 0, 1 - crop.width);
  if (event.key === 'ArrowUp') crop.y = clampCropNumber(crop.y - stepSize, 0, 1 - crop.height);
  if (event.key === 'ArrowDown') crop.y = clampCropNumber(crop.y + stepSize, 0, 1 - crop.height);
  updateReferenceCropBox();
}

function setReferenceCropFullImage() {
  if (!referenceCropState) return;
  referenceCropState.crop = { x: 0, y: 0, width: 1, height: 1 };
  referenceCropState.ratioMode = 'free';
  document.querySelectorAll('.reference-crop-ratio').forEach(function(item) { item.classList.toggle('active', item.textContent.trim() === '自由'); });
  updateReferenceCropBox();
  var preview = $('reference-crop-preview');
  if (preview) preview.innerHTML = '<span>已选择完整图片，可预览后再应用</span>';
}

async function previewReferenceCrop() {
  if (!referenceCropState) return;
  var reference = referenceCropState.references[referenceCropState.selectedIndex];
  var preview = $('reference-crop-preview');
  if (preview) preview.innerHTML = '<span class="reference-crop-loading">正在生成本地预览…</span>';
  if (referenceCropState.mode === 'pending') {
    try {
      var previews = await Promise.all(referenceCropState.references.map(function(item) { return createLocalReferenceCropPreview(item, referenceCropState.crop); }));
      if (preview) preview.innerHTML = '<div class="reference-crop-preview-grid">'+previews.map(function(item) { return '<figure><img src="'+item.dataUrl+'" alt="'+escapeHtml(item.name)+'"><figcaption>'+escapeHtml(item.name)+'</figcaption></figure>'; }).join('')+'</div>';
    } catch (error) {
      if (preview) preview.innerHTML = '<span class="reference-crop-error">'+escapeHtml(error.message || '本地预览失败')+'</span>';
    }
    return;
  }
  var result = await api('/api/recolor/reference-crop/preview', { sessionId: referenceCropState.sessionId, colorName: reference.name, crop: referenceCropState.crop });
  if (!result.success) {
    if (preview) preview.innerHTML = '<span class="reference-crop-error">'+escapeHtml(result.error || '预览失败')+'</span>';
    return;
  }
  referenceCropState.crop = normalizedReferenceCrop(result.crop);
  updateReferenceCropBox();
  if (preview) preview.innerHTML = '<img src="'+result.previewDataUrl+'" alt="裁剪预览"><small>'+escapeHtml(reference.name)+'</small>';
}

function loadReferenceCropImage(reference) {
  return new Promise(function(resolve, reject) {
    var image = new Image();
    image.onload = function() { resolve(image); };
    image.onerror = function() { reject(new Error('无法读取 '+reference.name)); };
    image.src = activeReferenceCropImageUrl(reference);
  });
}

async function createLocalReferenceCropPreview(reference, crop) {
  var image = await loadReferenceCropImage(reference);
  var normalized = normalizedReferenceCrop(crop);
  var sx = Math.round(image.naturalWidth * normalized.x);
  var sy = Math.round(image.naturalHeight * normalized.y);
  var sw = Math.max(1, Math.round(image.naturalWidth * normalized.width));
  var sh = Math.max(1, Math.round(image.naturalHeight * normalized.height));
  var scale = Math.min(1, 520 / Math.max(sw, sh));
  var canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { name:reference.name, dataUrl:canvas.toDataURL('image/jpeg', .9), width:image.naturalWidth, height:image.naturalHeight };
}

async function inspectPendingReferenceCropRatios(references) {
  var images = await Promise.all(references.map(async function(reference) {
    var image = await loadReferenceCropImage(reference);
    return { name:reference.name, width:image.naturalWidth, height:image.naturalHeight, ratio:image.naturalWidth / Math.max(1, image.naturalHeight) };
  }));
  var base = images[0]?.ratio || 1;
  return images.filter(function(item) { return Math.abs(item.ratio - base) / base > .03; });
}

function showReferenceCropWarning(title, message, warnings, actionHtml) {
  var panel = $('reference-crop-warning');
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = '<strong>'+escapeHtml(title)+'</strong><p>'+escapeHtml(message)+'</p>'+(warnings?.length?'<ul>'+warnings.map(function(item) { return '<li>'+escapeHtml(item.name)+' · '+item.width+'×'+item.height+'</li>'; }).join('')+'</ul>':'')+(actionHtml || '');
}

async function applyReferenceCrop(confirmAspectWarnings) {
  if (!referenceCropState) return;
  var button = $('reference-crop-apply');
  if (button) { button.disabled = true; button.textContent = '正在应用…'; }
  if (referenceCropState.mode === 'pending') {
    var pendingState = referenceCropState;
    try {
      var warnings = await inspectPendingReferenceCropRatios(pendingState.references);
      if (warnings.length && confirmAspectWarnings !== true) {
        showReferenceCropWarning('发现不同比例的图片', '以下图片会沿用同一相对裁剪范围，请先检查批量预览，再确认是否继续。', warnings, '<button class="btn lanvas-primary reference-crop-confirm" type="button" onclick="applyReferenceCrop(true)">确认仍然应用</button>');
        if (button) { button.disabled = false; button.textContent = '确认裁剪并添加'; }
        return;
      }
      var files = pendingState.references.map(function(reference) { return reference.file; });
      var crop = normalizedReferenceCrop(pendingState.crop);
      pendingReferenceCropPlan = { files:files, crop:crop };
      closeRecolorOverlay();
      addFiles('color', files, { deferScan:true, silent:true });
      if (!filesStore.template.length) {
        toast('参考色裁剪已确认；添加模板图后会自动上传并建立任务', 'ok');
        return;
      }
      var plan = pendingReferenceCropPlan;
      var success = await doScan({ colorFiles:files, referenceCrop:crop, pendingPlan:plan });
      if (success) toast('裁剪图已加入本批任务，原始参考图仍保留', 'ok');
    } catch (error) {
      toast(error.message || '裁剪添加失败', 'ng');
      if (button) { button.disabled = false; button.textContent = '重新添加'; }
    }
    return;
  }
  var result = await api('/api/recolor/reference-crop/apply', { sessionId: referenceCropState.sessionId, crop: referenceCropState.crop, confirmAspectWarnings: confirmAspectWarnings === true });
  if (!result.success && result.requiresConfirmation) {
    showReferenceCropWarning('发现不同比例的图片', '这些图片会使用相同的相对位置裁剪，但最终像素尺寸不同。请确认是否仍应用到整批。', result.warnings || [], '<button class="btn lanvas-primary reference-crop-confirm" type="button" onclick="applyReferenceCrop(true)">确认仍然应用</button>');
    if (button) { button.disabled = false; button.textContent = '确认裁剪并预览'; }
    return;
  }
  if (!result.success) {
    toast(result.error || '裁剪失败', 'ng');
    if (button) { button.disabled = false; button.textContent = '重新应用'; }
    return;
  }
  var sessionId = referenceCropState.sessionId;
  var count = result.count || referenceCropState.references.length;
  await refreshPairsAfterReferenceCrop(sessionId);
  closeRecolorOverlay();
  toast('已把同一裁剪比例应用到本批 '+count+' 张参考色图，原图仍保留', 'ok');
}

function requestReferenceCropRestore() {
  showReferenceCropWarning('恢复本批原图', '恢复后会删除本批裁剪副本，原始参考图不会被删除。已创建的任务仍保持创建时使用的图片。', [], '<button class="btn bd reference-crop-confirm" type="button" onclick="confirmReferenceCropRestore()">确认恢复原图</button>');
}

async function confirmReferenceCropRestore() {
  if (!referenceCropState) return;
  var sessionId = referenceCropState.sessionId;
  var result = await api('/api/recolor/reference-crop/clear', { sessionId: sessionId });
  if (!result.success) return toast(result.error || '恢复原图失败', 'ng');
  await refreshPairsAfterReferenceCrop(sessionId);
  closeRecolorOverlay();
  toast('本批参考色已恢复为原图', 'ok');
}

async function refreshPairsAfterReferenceCrop(sessionId) {
  var currentTasks = window.__currentBatch?.tasks || [];
  var alreadyBound = currentTasks.some(function(task) { return task.uploadBatchId === sessionId || task.sessionId === sessionId; });
  if (alreadyBound || scanData?.sessionId !== sessionId) return;
  var fresh = await api('/api/scan?sessionId=' + encodeURIComponent(sessionId));
  if (!fresh.success) return;
  scanData = fresh;
  scanPairs = Array.isArray(fresh.pairs) ? fresh.pairs : [];
  valData = { passed: fresh.totalPairs || scanPairs.length, warned: 0, pairs: scanPairs, colorMap: {} };
  renderScanPreviewFromScan(fresh);
  await persistAll();
}

// 参考色管理只保存本地 HEX/名称元数据，不修改图片，也不进入提示词或生成 API。
async function openReferenceColorManager(options = {}) {
  var requestedSessionId = String(options.sessionId || scanData?.sessionId || '').trim();
  var requestedColorName = String(options.colorName || '').trim();
  var query = requestedSessionId ? '?sessionId=' + encodeURIComponent(requestedSessionId) : '';
  var result = await api('/api/recolor/reference-colors' + query);
  if (!result.success) return toast(result.error || '读取参考色失败', 'ng');
  var references = result.references || [];
  if (requestedColorName) {
    var requestedStem = requestedColorName.replace(/\.[^.]+$/, '').toLowerCase();
    references = references.filter(function(reference) {
      var name = String(reference.name || '');
      return name.toLowerCase() === requestedColorName.toLowerCase()
        || name.replace(/\.[^.]+$/, '').toLowerCase() === requestedStem;
    });
  }
  if (!references.length) {
    var emptyCopy = requestedColorName
      ? '未找到同批参考色元数据。该任务不会伪装成已设置色号，请检查原上传批次后再试。'
      : '请先上传参考色图片。上传完成后，系统会在本机免费提取候选颜色。';
    openRecolorOverlay(requestedColorName ? '修改参考色色号' : '选择参考色', '<div class="modal-empty">'+escapeHtml(emptyCopy)+'</div>', '<button class="btn bs" onclick="closeRecolorOverlay()">关闭</button>', { scene:'palette', subtitle:'本机免费取色，仅用于显示、筛选与导出命名' });
    return;
  }
  var sessionId = result.sessionId || requestedSessionId;
  var cards = references.map(function(reference, index) {
    var fallbackHex = reference.referenceHex || reference.primary?.hex || reference.candidates?.[0]?.hex || '#808080';
    var hex = /^#[0-9a-f]{6}$/i.test(String(fallbackHex)) ? String(fallbackHex).toUpperCase() : '#808080';
    var label = reference.referenceColorLabel || '';
    var imageUrl = '/uploads/sessions/' + encodeURIComponent(sessionId) + '/colors/' + encodeURIComponent(reference.name);
    var candidates = (reference.candidates || []).filter(function(candidate) { return /^#[0-9a-f]{6}$/i.test(String(candidate.hex || '')); });
    if (!candidates.some(function(candidate) { return String(candidate.hex).toUpperCase() === hex; })) candidates.unshift({ hex: hex, ratio: null });
    return '<article class="reference-color-card" data-color-name="'+escapeHtml(reference.name)+'" data-reference-index="'+index+'"'+(index ? ' hidden' : '')+'>'
      +'<div class="reference-color-source"><img src="'+imageUrl+'" alt="'+escapeHtml(reference.name)+'"><div><strong>'+escapeHtml(reference.name.replace(/\.[^.]+$/, ''))+'</strong><span>'+(reference.cropApplied?'已使用裁剪图':'使用原始参考图')+'</span></div></div>'
      +'<div class="reference-candidates"><div class="reference-candidates-head"><span class="reference-field-title">本机提取的候选颜色</span>'
      +'<div class="reference-card-pager" aria-label="切换参考图"><button type="button" class="reference-pager-btn" onclick="stepReferenceColorCard(this,-1)" aria-label="上一张参考图"'+(index===0?' disabled':'')+'>‹</button><span>'+(index+1)+' / '+references.length+'</span><button type="button" class="reference-pager-btn" onclick="stepReferenceColorCard(this,1)" aria-label="下一张参考图"'+(index===references.length-1?' disabled':'')+'>›</button></div></div><div class="reference-candidate-list">'
      +candidates.map(function(candidate) { var candidateHex = String(candidate.hex).toUpperCase(); var ratio = Number.isFinite(candidate.ratio) ? Math.round(candidate.ratio * 100) + '%' : '当前'; return '<button type="button" class="reference-candidate'+(candidateHex===hex?' selected':'')+'" data-hex="'+candidateHex+'" onclick="chooseReferenceHex(this)" title="选择 '+candidateHex+'"><i style="background:'+candidateHex+'"></i><span>'+candidateHex+'</span><small>'+ratio+'</small></button>'; }).join('')
      +'</div></div>'
      +'<div class="reference-edit"><label><span>手动色号</span><span class="reference-hex-control"><input type="color" value="'+hex+'" oninput="syncReferenceColorInput(this)"><input class="reference-hex-input" value="'+hex+'" maxlength="7" oninput="syncReferenceHexText(this)"></span></label>'
      +'<label><span>颜色名称（可选）</span><input class="reference-label-input" value="'+escapeHtml(label)+'" maxlength="80" placeholder="例如：森林绿"></label></div>'
      +'<button class="btn lanvas-primary reference-save" type="button" data-session-id="'+escapeHtml(sessionId)+'" onclick="saveReferenceColorMetadata(this)">保存此参考色</button>'
      +'</article>';
  }).join('');
  var body = '<p class="modal-note">取色在本机完成，不消耗 API。候选色和手动色号只用于色块、筛选、历史与导出命名，不会写入提示词，也不会发送给生成模型。</p><div class="reference-color-grid">'+cards+'</div>';
  openRecolorOverlay(options.single ? '修改参考色色号' : '选择参考色', body, '<button class="btn bs" data-safe-focus onclick="closeRecolorOverlay()">完成</button>', { scene:'palette', subtitle:'选择候选颜色，或手动输入准确色号', badge:references.length+' 张参考图', modalClass:'reference-color-modal' });
}

function showReferenceColorCard(container, index) {
  var cards = Array.from(container?.querySelectorAll('.reference-color-card') || []);
  if (!cards.length) return;
  var safeIndex = Math.min(cards.length - 1, Math.max(0, Number(index) || 0));
  cards.forEach(function(card, cardIndex) { card.hidden = cardIndex !== safeIndex; });
  cards[safeIndex].querySelector('.reference-pager-btn:not([disabled])')?.focus?.();
}

function stepReferenceColorCard(button, delta) {
  var modal = button?.closest('.reference-color-modal');
  var current = modal?.querySelector('.reference-color-card:not([hidden])');
  if (!modal || !current) return;
  showReferenceColorCard(modal, Number(current.dataset.referenceIndex || 0) + Number(delta || 0));
}

function openTaskReferenceColorManager(button) {
  var sessionId = String(button?.dataset.referenceSession || '').trim();
  var colorName = String(button?.dataset.referenceName || '').trim();
  if (!sessionId || !colorName) return toast('未找到同批参考色元数据', 'wn');
  openReferenceColorManager({ sessionId:sessionId, colorName:colorName, single:true });
}

function taskReferenceColorMarkup(sessionId, colorName, label, colorHex) {
  var swatchClass = colorHex ? 'task-color-swatch' : 'task-color-swatch is-unset';
  var swatchStyle = colorHex ? ' style="--task-color:'+colorHex+'"' : '';
  var colorHexCopy = colorHex || '未设置色号';
  var safeLabel = escapeHtml(label || '—');
  if (!sessionId || !colorName) return '<span class="task-color-readonly"><i class="'+swatchClass+'"'+swatchStyle+' title="'+colorHexCopy+'"></i>'+safeLabel+'</span>';
  return '<button type="button" class="task-color-edit" data-reference-session="'+escapeHtml(sessionId)+'" data-reference-name="'+escapeHtml(colorName)+'" onclick="event.stopPropagation();openTaskReferenceColorManager(this)" title="手动修改 '+colorHexCopy+'" aria-label="修改 '+safeLabel+' 的色号"><i class="'+swatchClass+'"'+swatchStyle+' aria-hidden="true"></i><span>'+safeLabel+'</span><span class="ui-icon task-color-edit-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z"></path><path d="m13.5 7 3.5 3.5"></path></svg></span></button>';
}

function chooseReferenceHex(button) {
  var card = button.closest('.reference-color-card');
  if (!card) return;
  card.querySelectorAll('.reference-candidate').forEach(function(item) { item.classList.toggle('selected', item === button); });
  var hex = String(button.dataset.hex || '').toUpperCase();
  card.querySelector('input[type="color"]').value = hex;
  card.querySelector('.reference-hex-input').value = hex;
}

function syncReferenceColorInput(input) {
  var card = input.closest('.reference-color-card');
  if (!card) return;
  var hex = String(input.value || '').toUpperCase();
  card.querySelector('.reference-hex-input').value = hex;
  card.querySelectorAll('.reference-candidate').forEach(function(item) { item.classList.toggle('selected', item.dataset.hex === hex); });
}

function syncReferenceHexText(input) {
  var card = input.closest('.reference-color-card');
  if (!card) return;
  var hex = String(input.value || '').trim().toUpperCase();
  input.classList.toggle('invalid', !/^#[0-9A-F]{6}$/.test(hex));
  if (/^#[0-9A-F]{6}$/.test(hex)) {
    card.querySelector('input[type="color"]').value = hex;
    card.querySelectorAll('.reference-candidate').forEach(function(item) { item.classList.toggle('selected', item.dataset.hex === hex); });
  }
}

async function saveReferenceColorMetadata(button) {
  var card = button.closest('.reference-color-card');
  if (!card) return;
  var colorName = card.dataset.colorName;
  var hexInput = card.querySelector('.reference-hex-input');
  var hex = String(hexInput.value || '').trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(hex)) {
    hexInput.classList.add('invalid');
    hexInput.focus();
    return toast('请输入 # 加 6 位数字或字母的色号', 'wn');
  }
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    var result = await api('/api/recolor/reference-colors/metadata', {
      sessionId: button.dataset.sessionId,
      colorName: colorName,
      hex: hex,
      label: card.querySelector('.reference-label-input').value.trim()
    });
    if (!result.success) throw new Error(result.error || '保存色号失败');
    cacheReferenceMetadata(result.sessionId || button.dataset.sessionId, [{ name:colorName, referenceHex:hex, referenceColorLabel:result.metadata?.label || '' }]);
    userColorOverrides[colorName] = { hex: hex };
    if (scanData?.pairs) scanData.pairs.forEach(function(pair) {
      if (pair.colorName === colorName) {
        pair.referenceHex = hex;
        pair.referenceColorLabel = result.metadata?.label || '';
      }
    });
    var savedSessionId = result.sessionId || button.dataset.sessionId;
    (window.__currentBatch?.tasks || []).forEach(function(task) {
      var taskSessionId = task.uploadBatchId || task.sessionId || '';
      var taskColorName = task.colorRef || task.colorName || task.colorNameWithoutExt || '';
      var sameName = String(taskColorName).toLowerCase() === String(colorName).toLowerCase()
        || String(taskColorName).replace(/\.[^.]+$/, '').toLowerCase() === String(colorName).replace(/\.[^.]+$/, '').toLowerCase();
      if (taskSessionId === savedSessionId && sameName) {
        task.referenceHex = hex;
        task.referenceColorLabel = result.metadata?.label || task.referenceColorLabel || '';
      }
    });
    var currentBatchId = window.__currentBatch?.batchId || batchId;
    if (currentBatchId) await refreshAndRender(currentBatchId); else renderScanPreviewFromScan(scanData);
    toast('色号已保存，任务列表与导出名称已更新', 'ok');
    button.textContent = '已保存';
  } catch (error) {
    toast('保存色号失败：' + error.message, 'ng');
    button.textContent = '保存此参考色';
  } finally {
    button.disabled = false;
  }
}

async function openRecolorExportModal() {
  var options = await api('/api/recolor/export/options');
  if (!options.success) return toast(options.error || '读取导出选项失败', 'ng');
  (options.colorOptions || []).forEach(function(item) {
    if (!item?.name || !/^#[0-9a-f]{6}$/i.test(String(item.hex || ''))) return;
    userColorOverrides[item.name] = Object.assign({}, userColorOverrides[item.name] || {}, { hex: String(item.hex).toUpperCase() });
  });
  var choice = function(values, key, label, helper) {
    if (!values.length) return '';
    return '<fieldset class="export-choice" data-export-panel="'+key+'"><legend><span class="export-choice-mark" aria-hidden="true"></span><span><strong>'+label+'</strong><small>'+helper+'</small></span><b>可多选</b></legend><div>'+values.map(function(value, index) {
      var hex = key === 'color' ? (getReferenceColorHex(value) || '') : '';
      var swatch = key === 'color' ? '<i class="export-filter-swatch" style="background:'+(hex || 'linear-gradient(135deg,#ede7f3,#7b4a94)')+'"></i>' : '';
      var displayValue = key === 'uploadBatchId' ? '第 '+(index + 1)+' 个上传批次' : value;
      return '<label><input type="checkbox" name="'+key+'" value="'+escapeHtml(value)+'" onchange="updateRecolorExportSummary()">'+swatch+'<span>'+escapeHtml(displayValue)+'</span>'+(hex?'<small>'+escapeHtml(hex.toUpperCase())+'</small>':'')+'</label>';
    }).join('')+'</div></fieldset>';
  };
  var tabs = [
    ['all','全部结果',options.total+' 张可导出','<path d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z"></path>'],
    ['uploadBatchId','上传批次',(options.uploads || []).length+' 个批次','<path d="M4 7h16v12H4z"></path><path d="m8 7 2-3h4l2 3"></path>'],
    ['color','参考色',(options.colors || []).length+' 种颜色','<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a6 6 0 0 0 0-12z"></path>'],
    ['template','模板图',(options.templates || []).length+' 张模板','<path d="M4 5h16v14H4z"></path><path d="m4 15 4-4 4 4 3-3 5 5"></path>'],
    ['unexported','仅未导出','按下载标识筛选','<path d="M5 12 10 17 19 7"></path>']
  ].map(function(item, index) {
    return '<button type="button" class="export-tab '+(index===0?'active':'')+'" data-export-mode="'+item[0]+'" onclick="setRecolorExportMode(\''+item[0]+'\',this)"><span class="tab-icon"><span class="ui-icon"><svg viewBox="0 0 24 24">'+item[3]+'</svg></span></span><span class="tab-copy"><b>'+item[1]+'</b><small>'+item[2]+'</small></span></button>';
  }).join('');
  var uploadPreview = (options.uploads || []).slice(0, 2).map(function(value, index) {
    return '<div class="export-row export-preview-row"><span class="export-row-mark">'+(index + 1)+'</span><strong>第 '+(index + 1)+' 个上传批次</strong><span class="meta">上传批次</span></div>';
  }).join('');
  var colorPreview = (options.colors || []).slice(0, 2).map(function(value) {
    var hex = getReferenceColorHex(value);
    var swatchStyle = hex ? 'background:'+escapeHtml(hex) : 'background:repeating-linear-gradient(135deg,#f1eef4 0 6px,#ded8e4 6px 12px)';
    return '<div class="export-row export-preview-row"><span class="color-dot" style="'+swatchStyle+'"></span><strong class="color-label">'+(hex?escapeHtml(hex.toUpperCase())+' · ':'待识别 · ')+escapeHtml(value)+'</strong><span class="meta">参考色</span></div>';
  }).join('');
  var body = '<div class="export-v2"><div class="export-tabs">'+tabs+'</div><div class="export-modal-layout"><div class="export-modal-filters">'
    +'<section class="export-all-card active" data-export-panel="all"><div class="note"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M4 5h16"></path><path d="m7 10 5 5 5-5"></path><path d="M12 5v10"></path><path d="M5 19h14"></path></svg></span>同类条件取并集，不同类别取交集；主任务列表的筛选不会影响这里。</div><div class="export-all-overview">'+(uploadPreview || '<div class="export-row export-preview-row"><span class="export-row-mark">全</span><strong>当前全部最新结果</strong><span class="meta">'+options.total+' 张</span></div>')+colorPreview+'</div></section>'
    +choice(options.uploads || [], 'uploadBatchId', '按上传批次', '追加上传的每一批都可单独下载')
    +choice(options.colors || [], 'color', '按参考色', '色块、名称与 HEX 同时显示')
    +choice(options.templates || [], 'template', '按模板图', '每张模板的全部颜色结果')
    +'<label class="export-only" data-export-panel="unexported"><input id="export-only-unexported" type="checkbox" onchange="updateRecolorExportSummary()"><span class="export-only-check">✓</span><span><strong>只导出未下载结果</strong><small>已经带“已下载”标识的图片不会再次进入压缩包</small></span></label>'
    +'</div><aside class="export-summary-card"><h3>本次导出</h3><div class="export-summary-total"><div><strong id="export-summary-count">'+options.total+'</strong><span> 张</span></div><small>最新成功结果</small></div><p id="export-summary-copy">全部最新结果</p><div class="export-summary-line"><span>压缩包</span><b>日期＋模板图名</b></div><div class="export-summary-line"><span>包内文件</span><b>模板＋参考色＋时间＋4位码</b></div><div class="export-summary-line"><span>下载标识</span><b>完成后自动写入</b></div><p class="note export-summary-note">生成中的新结果不会临时加入本次压缩包。</p></aside></div></div>';
  openRecolorOverlay('导出结果', body, '<button class="btn bs" data-safe-focus onclick="closeRecolorOverlay()">取消</button><button class="btn lanvas-primary" id="recolor-export-submit" data-export-total="'+options.total+'" onclick="submitRecolorExport()"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 19h14"></path></svg></span><span>导出 '+options.total+' 张结果</span></button>', { scene:'export', subtitle:'按全部、上传批次、参考色、模板图或下载状态选择', badge:'ZIP', modalClass:'recolor-export-modal' });
  updateRecolorExportSummary();
}

function setRecolorExportMode(mode, button) {
  var overlay = document.getElementById('recolor-workbench-overlay');
  if (!overlay) return;
  overlay.querySelectorAll('.export-tab').forEach(function(tab) { tab.classList.toggle('active', tab === button); });
  overlay.querySelectorAll('[data-export-panel]').forEach(function(panel) { panel.classList.toggle('active', panel.dataset.exportPanel === mode); });
  overlay.querySelectorAll('.export-choice input').forEach(function(input) { input.checked = false; });
  var only = overlay.querySelector('#export-only-unexported');
  if (only) only.checked = mode === 'unexported';
  updateRecolorExportSummary();
}

function updateRecolorExportSummary() {
  var overlay = document.getElementById('recolor-workbench-overlay');
  if (!overlay) return;
  var selected = overlay.querySelectorAll('.export-choice input:checked').length;
  var only = overlay.querySelector('#export-only-unexported')?.checked;
  var mode = overlay.querySelector('.export-tab.active')?.dataset.exportMode || 'all';
  var labels = { all:'全部最新结果', uploadBatchId:'所选上传批次', color:'所选参考色', template:'所选模板图', unexported:'全部未下载结果' };
  var copy = document.getElementById('export-summary-copy');
  if (copy) copy.textContent = selected ? labels[mode]+' · 已选择 '+selected+' 项' : (only?'全部未下载结果':labels[mode]);
  var submit = document.getElementById('recolor-export-submit');
  if (submit) submit.querySelector('span:last-child').textContent = selected || only || mode !== 'all' ? '导出所选结果' : '导出 '+submit.dataset.exportTotal+' 张结果';
}

function submitRecolorExport() {
  var overlay = document.getElementById('recolor-workbench-overlay');
  if (!overlay) return;
  var params = new URLSearchParams();
  ['uploadBatchId','color','template'].forEach(function(key) { overlay.querySelectorAll('input[name="'+key+'"]:checked').forEach(function(input) { params.append(key, input.value); }); });
  if (overlay.querySelector('#export-only-unexported')?.checked) params.set('onlyUnexported', '1');
  triggerRecolorDownload('/api/recolor/export?' + params.toString());
  closeRecolorOverlay();
  toast('正在打包导出；下载完成后结果会标记为已下载。', 'ok');
}

var recolorHistoryState = { items: [], selected: new Set(), selectionMode: false, query: '', uploadBatchId: 'all', filterMode: 'all' };

function triggerRecolorDownload(url) {
  var anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(function() { anchor.remove(); }, 1000);
}

function recolorHistoryVisibleItems() {
  var query = recolorHistoryState.query.trim().toLowerCase();
  var now = new Date();
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  var visible = recolorHistoryState.items.filter(function(item) {
    if (recolorHistoryState.uploadBatchId !== 'all' && item.uploadBatchId !== recolorHistoryState.uploadBatchId) return false;
    var stamp = item.generatedAt ? new Date(item.generatedAt).getTime() : 0;
    if (recolorHistoryState.filterMode === 'today' && stamp < todayStart) return false;
    if (recolorHistoryState.filterMode === 'week' && stamp < weekStart) return false;
    if (!query) return true;
    return [item.templateName, item.colorName, item.batchId, item.uploadBatchId].some(function(value) { return String(value || '').toLowerCase().includes(query); });
  });
  if (recolorHistoryState.filterMode === 'color') visible.sort(function(a, b) { return String(a.colorName || '').localeCompare(String(b.colorName || ''), 'zh-CN'); });
  return visible;
}

function recolorHistoryBatchLabel(item) {
  var date = item.generatedAt ? new Date(item.generatedAt) : null;
  var time = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '时间未知';
  return time + ' · 上传批次 ' + String(item.uploadBatchId || item.batchId || '').slice(-8);
}

function recolorHistoryDayLabel(item) {
  var date = item?.generatedAt ? new Date(item.generatedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return '日期未知';
  var now = new Date();
  var sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return (sameDay ? '今天 · ' : '') + date.toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric' });
}

function updateRecolorHistoryFooter() {
  var label = document.getElementById('history-foot-label');
  if (label) label.textContent = '已选择 '+recolorHistoryState.selected.size+' 张 · 删除后提供 5 秒撤销';
  var download = document.getElementById('history-download-selected');
  var remove = document.getElementById('history-delete-selected');
  if (download) download.disabled = recolorHistoryState.selected.size === 0;
  if (remove) remove.disabled = recolorHistoryState.selected.size === 0;
}

function renderRecolorHistory() {
  var host = document.getElementById('recolor-history-content');
  if (!host) return;
  var items = recolorHistoryVisibleItems();
  var uploadBatches = [...new Set(recolorHistoryState.items.map(function(item) { return item.uploadBatchId || item.batchId || ''; }).filter(Boolean))];
  var selectedCount = recolorHistoryState.selected.size;
  var grouped = new Map();
  items.forEach(function(item) { var key = item.uploadBatchId || item.batchId || '未分批'; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(item); });
  var groups = [...grouped.entries()].map(function(entry) {
    var id = entry[0], batchItems = entry[1], sample = batchItems[0];
    var cards = batchItems.map(function(item) {
      var colorName = item.colorName || '参考色';
      var hex = normalizedReferenceHex(item.referenceHex) || getReferenceColorHex(colorName) || '';
      var swatchStyle = hex ? 'background:'+hex : (item.colorUrl ? 'background-image:url(&quot;'+escapeHtml(item.colorUrl)+'&quot;)' : '');
      var checked = recolorHistoryState.selected.has(item.id);
      return '<article class="history-card '+(checked?'selected ':'')+(recolorHistoryState.selectionMode?'selection-active':'')+'" data-history-id="'+escapeHtml(item.id)+'">'
        +'<label class="history-select"><input type="checkbox" '+(checked?'checked':'')+' onchange="toggleRecolorHistorySelection(this.closest(\'.history-card\').dataset.historyId,this.checked)"><span aria-hidden="true">✓</span><span class="sr-only">选择结果</span></label>'
        +'<button type="button" class="history-image" onclick="openRecolorHistoryPreview(this.closest(\'.history-card\').dataset.historyId)" title="进入三图对比"><img src="'+escapeHtml(item.resultUrl || '')+'" alt="'+escapeHtml(colorName)+'复色结果"><span>三图对比</span></button>'
        +'<div class="history-card-copy"><strong>'+escapeHtml((item.templateName || '模板图')+'－'+colorName)+'</strong><span>'+escapeHtml((formatTime(item.generatedAt) || '时间未知')+' · '+recolorTaskShortId({ id:item.taskId || item.id }))+'</span></div>'
        +'<div class="history-card-meta">'+(item.exportedAt?'<span class="history-exported" title="最近导出：'+escapeHtml(formatTime(item.exportedAt))+'">已下载</span>':'<span>未下载</span>')+'</div>'
        +'<button type="button" class="history-delete-one" onclick="deleteRecolorHistoryItem(this.closest(\'.history-card\').dataset.historyId)" aria-label="删除这张结果" title="删除">×</button></article>';
    }).join('');
    var batchTime = sample?.generatedAt ? new Date(sample.generatedAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : '时间未知';
    return '<section class="history-batch"><header><div><strong>'+escapeHtml(recolorHistoryDayLabel(sample))+'</strong><span>批次 '+escapeHtml(batchTime)+' · '+batchItems.length+' 张结果</span></div></header><div class="history-grid">'+cards+'</div></section>';
  }).join('');
  host.innerHTML = '<div class="history-toolbar"><label class="history-search"><input value="'+escapeHtml(recolorHistoryState.query)+'" oninput="setRecolorHistoryQuery(this.value)" placeholder="搜索模板名或参考色"><span>⌕</span></label>'
    +'<button type="button" class="history-chip '+(recolorHistoryState.filterMode==='all'?'active':'')+'" onclick="setRecolorHistoryFilter(\'all\')">全部</button>'
    +'<button type="button" class="history-chip '+(recolorHistoryState.filterMode==='today'?'active':'')+'" onclick="setRecolorHistoryFilter(\'today\')">今天</button>'
    +'<button type="button" class="history-chip '+(recolorHistoryState.filterMode==='week'?'active':'')+'" onclick="setRecolorHistoryFilter(\'week\')">最近 7 天</button>'
    +'<button type="button" class="history-chip '+(recolorHistoryState.filterMode==='color'?'active':'')+'" onclick="setRecolorHistoryFilter(\'color\')">按参考色</button>'
    +'<button type="button" class="history-chip '+(recolorHistoryState.selectionMode?'active':'')+'" onclick="toggleRecolorHistorySelectionMode()">'+(recolorHistoryState.selectionMode?'退出多选':'□ 多选')+'</button>'
    +(recolorHistoryState.selectionMode?'<button type="button" class="history-chip" onclick="selectAllRecolorHistory()">全选</button>':'')+'</div>'
    +'<div class="history-content">'+(groups || '<div class="modal-empty"><div class="modal-empty-mark">◫</div><strong>暂无符合条件的复色结果</strong><span>生成完成的图片会长期保留在这里。</span></div>')+'</div>';
  updateRecolorHistoryFooter();
}

async function openRecolorHistory() {
  var result = await api('/api/recolor/history');
  if (!result.success) return toast(result.error || '读取历史结果失败', 'ng');
  recolorHistoryState = { items: result.items || [], selected: new Set(), selectionMode: false, query: '', uploadBatchId: 'all', filterMode: 'all' };
  openRecolorOverlay('历史结果', '<div id="recolor-history-content"></div>', '<span id="history-foot-label">已选择 0 张 · 删除后提供 5 秒撤销</span><div class="history-foot-actions"><button class="btn bs" id="history-download-selected" disabled onclick="downloadRecolorHistorySelected()">下载已选</button><button class="btn bs" id="history-delete-selected" disabled onclick="confirmRecolorHistoryDelete(\'selected\')">删除已选</button><button class="btn lanvas-primary" '+(recolorHistoryState.items.length?'':'disabled')+' onclick="downloadRecolorHistoryBatch()">下载本批次</button></div>', { scene:'history', subtitle:'仅保存一键复色生成图', modalClass:'recolor-history-modal' });
  renderRecolorHistory();
}

async function refreshRecolorHistoryIfOpen() {
  if (!document.getElementById('recolor-history-content')) return;
  var result = await api('/api/recolor/history');
  if (!result.success) return;
  recolorHistoryState.items = result.items || [];
  var valid = new Set(recolorHistoryState.items.map(function(item) { return item.id; }));
  recolorHistoryState.selected = new Set([...recolorHistoryState.selected].filter(function(id) { return valid.has(id); }));
  renderRecolorHistory();
}

function setRecolorHistoryQuery(value) { recolorHistoryState.query = value || ''; renderRecolorHistory(); document.querySelector('.history-search input')?.focus(); }
function setRecolorHistoryBatch(value) { recolorHistoryState.uploadBatchId = value || 'all'; recolorHistoryState.selected.clear(); renderRecolorHistory(); }
function setRecolorHistoryFilter(value) { recolorHistoryState.filterMode = value || 'all'; recolorHistoryState.selected.clear(); renderRecolorHistory(); }
function toggleRecolorHistorySelectionMode() { recolorHistoryState.selectionMode = !recolorHistoryState.selectionMode; if (!recolorHistoryState.selectionMode) recolorHistoryState.selected.clear(); renderRecolorHistory(); }
function toggleRecolorHistorySelection(id, checked) { if (checked) recolorHistoryState.selected.add(id); else recolorHistoryState.selected.delete(id); renderRecolorHistory(); }
function selectAllRecolorHistory() { recolorHistoryVisibleItems().forEach(function(item) { recolorHistoryState.selected.add(item.id); }); renderRecolorHistory(); }

function downloadRecolorHistorySelected() {
  var items = recolorHistoryState.items.filter(function(item) { return recolorHistoryState.selected.has(item.id); });
  if (!items.length) return;
  var params = new URLSearchParams();
  items.forEach(function(item) { params.append('taskId', item.taskId); });
  triggerRecolorDownload('/api/recolor/export?' + params.toString());
  toast('正在打包已选结果，当前页面会保持打开。', 'ok');
  setTimeout(refreshRecolorHistoryIfOpen, 1500);
}

function downloadRecolorHistoryBatch() {
  var first = recolorHistoryVisibleItems()[0];
  if (!first) return;
  var params = new URLSearchParams();
  if (first.uploadBatchId) params.set('uploadBatchId', first.uploadBatchId);
  triggerRecolorDownload('/api/recolor/export?' + params.toString());
  toast('正在打包当前上传批次，当前页面会保持打开。', 'ok');
  setTimeout(refreshRecolorHistoryIfOpen, 1500);
}

function openRecolorHistoryPreview(itemId) {
  var visible = recolorHistoryVisibleItems();
  __rvRows = visible.map(function(item) {
    var row = document.createElement('article');
    row.className = 'task-row';
    row.dataset.batch = item.batchId || '';
    row.dataset.task = item.taskId || '';
    row.dataset.tpl = item.templateName || '';
    row.dataset.clr = item.colorName || '';
    row.dataset.referenceUrl = item.colorUrl || '';
    row.innerHTML = '<span class="task-thumb"><img src="'+escapeHtml(item.templateUrl || '')+'" alt="模板图"></span><span class="task-thumb"><img src="'+escapeHtml(item.resultUrl || '')+'" alt="生成图"></span>';
    return row;
  });
  __rvIndex = visible.findIndex(function(item) { return item.id === itemId; });
  if (__rvIndex < 0) return;
  loadRowPreview(__rvIndex);
  var modal = document.getElementById('img-viewer-modal');
  if (!modal) return;
  document.getElementById('rv-wrapper').style.display = 'flex';
  document.getElementById('img-viewer-image').style.display = 'none';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

async function refreshHistoryAffectedBatches(result) {
  if (result?.batchIds?.includes(window.__currentBatch?.batchId)) await refreshAndRender(window.__currentBatch.batchId);
  await refreshRecolorHistoryIfOpen();
}

async function deleteRecolorHistoryItem(itemId) {
  var result = await api('/api/recolor/history/delete', { itemIds: [itemId] });
  if (!result.success) return toast(result.error || '删除失败', 'ng');
  showDeleteUndo(result);
  await refreshHistoryAffectedBatches(result);
}

async function confirmRecolorHistoryDelete(mode, value) {
  var itemIds = mode === 'selected' ? [...recolorHistoryState.selected] : [];
  var count = mode === 'all' ? recolorHistoryState.items.length : mode === 'batch' ? recolorHistoryState.items.filter(function(item) { return (item.uploadBatchId || item.batchId) === value; }).length : itemIds.length;
  if (!count) return;
  var ok = await askRecolorConfirmation({ danger:true, title:mode === 'all' ? '删除全部历史结果' : mode === 'batch' ? '删除这个上传批次' : '删除已选结果', subtitle:'这些结果会立即从历史图库和当前任务列表隐藏', facts:[{label:'本次删除',value:count+' 张结果'},{label:'撤销时间',value:'5 秒'}], message:'超过撤销时间后，生成图与对应任务记录将正式删除；模板图和参考色素材按引用关系保留。', confirmText:'确认删除' });
  if (!ok) return;
  var payload = mode === 'all' ? { all:true } : mode === 'batch' ? { uploadBatchId:value } : { itemIds:itemIds };
  var result = await api('/api/recolor/history/delete', payload);
  if (!result.success) return toast(result.error || '删除失败', 'ng');
  recolorHistoryState.selected.clear();
  showDeleteUndo(result);
  await refreshHistoryAffectedBatches(result);
}

function deleteAllRecolorHistory() { return confirmRecolorHistoryDelete('all'); }

function toggleUploadCompact() {
  var panel = $('upload-compact');
  if (!panel) return;
  panel.classList.toggle('is-collapsed');
  var collapsed = panel.classList.contains('is-collapsed');
  var railButton = $('rail-upload');
  if (railButton) {
    railButton.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
    railButton.classList.toggle('active', !collapsed);
  }
  toast(collapsed ? '上传区已收起' : '上传区已展开', 'ok');
}

function focusTaskSearch() {
  var input = document.querySelector('.task-search-input');
  if (!input) return toast('当前没有可搜索的任务', 'wn');
  input.focus();
  input.select();
}

function setTaskFilterFromRail(filter) {
  if (typeof setTaskFilter !== 'function') return;
  setTaskFilter(filter);
}

function openLatestGeneratedPreview() {
  var batch = window.__currentBatch;
  var latest = (batch?.tasks || []).filter(function(task) { return (task.executionStatus || task.status) === 'completed' && task.output; }).at(-1);
  if (!latest) return toast('暂无已生成结果', 'wn');
  var row = document.querySelector('.task-row[data-task="' + CSS.escape(latest.id) + '"]');
  if (row) {
    selectTask(batch.batchId, latest.id);
    openImageRowPreview(row);
  }
}

function updateRailAvailability(tasks) {
  const visible = (Array.isArray(tasks) ? tasks : []).filter(function(task) { return !task.hiddenInTaskList; });
  const setDisabled = function(id, disabled) {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = Boolean(disabled);
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  };
  setDisabled('rail-search', visible.length === 0);
  setDisabled('rail-running', !visible.some(function(task) { return normalizeTaskStatus(task) === 'running'; }));
  setDisabled('rail-failed', !visible.some(function(task) { return ['failed','error'].includes(normalizeTaskStatus(task)); }));
  setDisabled('rail-latest', !visible.some(function(task) { return normalizeTaskStatus(task) === 'completed' && task.output; }));
}

// ===== 底部按钮功能 =====
// ===== 一键批处理：防重复锁 =====
let isBatchRunning = false;

// ===== 一键生图：仅生成未完成任务，已完成的自动跳过 =====
// STEP 12: running 状态下支持追加新任务到当前队列
async function generateAllPending() {
  const batch = window.__currentBatch;
  const batchActive = batch && batch.active;
  const batchId = batch && (batch.batchId || batch.id);
  const status = String(batch?.status || '').toLowerCase();
  const canUseCurrentBatch = isActiveAppendBatch(batch);
  const appendPairs = canUseCurrentBatch ? getAppendablePendingPairs() : null;

  console.log('[PAUSE-APPEND-FIX] generateAllPending batchId=' + batchId + ' status=' + status + ' active=' + batchActive + ' appendPairs=' + (appendPairs ? appendPairs.length : 0));

  // === 分支: 只有真正活跃/可恢复批次才允许追加到现有 batch ===
  const canAppendToExistingBatch =
    canUseCurrentBatch &&
    batchId &&
    appendPairs &&
    appendPairs.length > 0 &&
    ['running', 'processing', 'paused', 'pausing', 'cancelling'].includes(status);

  if (canAppendToExistingBatch) {
    if (!batch || !isBatchRunning) {
      isBatchRunning = true;
    }
    // 已确认规则：运行中新增任务自动追加到统一队列末尾；暂停时只入队，恢复后执行。

    var btnGA = $('bt-generate-all');
    var statusEl = $('bt-generate-status');
    if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '追加中…'; }

    try {
      await startGen(true, { appendRunning: true, pairsOverride: appendPairs, batchId: batchId });
    } catch (e) {
      toast('追加失败: ' + (e.message || '未知错误'), 'ng');
      if (statusEl) statusEl.style.display = 'none';
    }
    return;
  }

  // === 分支 2: batch 未运行 → 原有逻辑 ===
  if (isBatchRunning) return toast('批处理正在运行中，请等待完成', 'wn');

  // STEP 4: 非活跃历史 batch 不再阻断新扫描任务；优先使用本次扫描结果
  const pendingTasks = canUseCurrentBatch && batch && batch.tasks
    ? batch.tasks.filter(function(t) { return !t.hiddenInTaskList && !isCompletedTask(t); })
    : (Array.isArray(scanPairs) && scanPairs.length ? scanPairs : (Array.isArray(scanData?.pairs) ? scanData.pairs : []));

  if (pendingTasks.length === 0) {
    toast('没有可生成任务，请先上传素材并扫描配对', 'wn');
    return;
  }

  const existingTotal = canUseCurrentBatch && batch?.tasks ? batch.tasks.filter(t => !t.hiddenInTaskList).length : pendingTasks.length;
  // 确认
  const confirmed = await askRecolorConfirmation({ title:'确认开始生成', subtitle:'任务会按当前设置加入统一队列', facts:[{label:'等待生成',value:pendingTasks.length+' 项'},{label:'已完成并跳过',value:Math.max(0, existingTotal-pendingTasks.length)+' 项'},{label:'预计调用',value:pendingTasks.length+' 次 API'}], message:'网络结果无法确认时系统会立即暂停，不会擅自重复提交。', confirmText:'确认并开始' });
  if (!confirmed) return;

  // 锁定
  isBatchRunning = true;
  var btnGA = $('bt-generate-all');
  var statusEl = $('bt-generate-status');
  if (btnGA) btnGA.disabled = true;
  if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '准备中…'; }

  // 如果 scanData 不可用，只有活跃批次才允许用内部批次数据兜底；历史 completed/cancelled 不可污染新任务
  if (!scanData?.pairs?.length && canUseCurrentBatch && batch?.tasks?.length) {
    // 从当前 batch.tasks 重建 scanPairs 结构
    const uniquePairs = [];
    const seen = new Set();
    batch.tasks.forEach(t => {
      if (t.hiddenInTaskList) return;
      const key = `${t.templateNameWithoutExt||t.template}::${t.colorNameWithoutExt||t.colorRef}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniquePairs.push({
          template: t.template||'',
          templateName: t.template||'',
          templateNameWithoutExt: t.templateNameWithoutExt||t.template||'',
          templatePath: t.templatePath||'',
          colorRef: t.colorRef||'',
          colorName: t.colorRef||'',
          colorNameWithoutExt: t.colorNameWithoutExt||t.colorRef||'',
          colorPath: t.colorPath||''
        });
      }
    });
    scanData = { success: true, totalPairs: uniquePairs.length, pairs: uniquePairs };
    scanPairs = uniquePairs;
  }

  try {
    // 继续入口只恢复权威队列，不在后端按素材组合去重
    await startGen(true);
  } catch (e) {
    toast('启动失败: ' + (e.message||'未知错误'), 'ng');
    isBatchRunning = false;
    if (btnGA) btnGA.disabled = false;
    if (statusEl) statusEl.style.display = 'none';
  }
}

// ===== 生成设置对话框（复色打通画布 Provider：选 Provider / 模型 / 尺寸 / 质量 / 数量）=====
let genDialogPairCount = 0; // 本次弹窗配对数，用于数量「全部」语义判断

function buildRecolorModelOptions(providerId) {
  const p = (recolorProviders || []).find(x => x.id === providerId);
  const models = p && Array.isArray(p.image_models) ? p.image_models : [];
  if (!models.length) return `<option value="">默认模型</option>`;
  return models.map(m => `<option value="${m}" ${recolorModel === m ? 'selected' : ''}>${m}</option>`).join('');
}

function genProviderChanged() {
  const pSel = document.getElementById('gen-dlg-provider');
  const mSel = document.getElementById('gen-dlg-model');
  if (!mSel) return;
  const prev = mSel.value;
  mSel.innerHTML = buildRecolorModelOptions(pSel ? pSel.value : '');
  // 切换 Provider 后：若原模型在新 Provider 中仍存在则保留，否则回落到第一个
  if (prev && Array.from(mSel.options).some(o => o.value === prev)) mSel.value = prev;
}

async function openGenerateDialog(pairCount) {
  genDialogPairCount = pairCount;
  let providers = [];
  try { const r = await api('/api/config'); if (r.success) providers = r.api_providers || []; } catch(e) {}
  recolorProviders = providers;

  // 仅展示「已配置 key 且有生图模型」的 Provider；若都未配置则全部列出便于排查
  const usable = providers.filter(p => p.has_key && Array.isArray(p.image_models) && p.image_models.length);
  const list = usable.length ? usable : providers;

  const providerOptions = list.length
    ? list.map(p => `<option value="${p.id}" ${recolorProviderId === p.id ? 'selected' : ''}>${p.name || p.id}${p.has_key ? '' : '（未配置）'}</option>`).join('')
    : `<option value="">无可用 Provider</option>`;

  const modelOptions = buildRecolorModelOptions(recolorProviderId);

  const sizeOptions = [
    ['1024x1024', '1:1 · 1024x1024'],
    ['1536x1536', '1:1 · 1536x1536'],
    ['2048x2048', '1:1 · 2048x2048']
  ].map(s => `<option value="${s[0]}" ${recolorSize === s[0] ? 'selected' : ''}>${s[1]}</option>`).join('');

  const qualityOptions = [
    ['low', 'LOW（默认，快）'],
    ['medium', 'MEDIUM（均衡）'],
    ['high', 'HIGH（高质量）']
  ].map(q => `<option value="${q[0]}" ${recolorQuality === q[0] ? 'selected' : ''}>${q[1]}</option>`).join('');

  var boundTasks = (window.__currentBatch?.tasks || []).filter(function(task) {
    return !task.hiddenInTaskList && task.executionStatus !== 'deleted';
  });
  var modelCounts = new Map();
  boundTasks.forEach(function(task) {
    var modelName = task.modelSnapshot || task.model || task.modelName || window.__currentBatch?.modelSnapshot || recolorModel || '系统默认模型';
    modelCounts.set(modelName, (modelCounts.get(modelName) || 0) + 1);
  });
  if (!modelCounts.size) modelCounts.set(recolorModel || '系统默认模型', pairCount);
  var modelCards = [...modelCounts.entries()].map(function(entry) {
    var percent = pairCount ? Math.round(entry[1] / pairCount * 100) : 100;
    return '<div class="model-card"><span class="model-mark"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"></path><path d="m4 15 4-4 4 4 3-3 5 5"></path></svg></span></span><div><b>'+escapeHtml(entry[0])+'</b><small>'+entry[1]+' 项任务 · '+percent+'%</small></div></div>';
  }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'gen-config-overlay';
  overlay.className = 'recolor-confirm-overlay generation-confirm-overlay scene-start';
  overlay.innerHTML = `
    <section class="generation-confirm-modal start-v3" role="dialog" aria-modal="true" aria-label="确认开始生成">
      <header class="scene-modal-head"><h2>确认开始生成</h2><button type="button" class="scene-modal-close" data-safe-focus onclick="cancelGenDialog()" aria-label="关闭"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg></span></button></header>
      <div class="generation-confirm-body balanced">
        <div class="metric-cards"><div class="metric-card"><span>等待生成</span><b>${pairCount} 项</b></div><div class="metric-card"><span>当前并发</span><b>${recolorConcurrency} 项</b></div><div class="metric-card"><span>预计调用</span><b>${pairCount} 次</b></div></div>
        <div class="model-summary-head"><b>本次任务使用 ${modelCounts.size} 个模型</b><span>模型已在任务创建时绑定</span></div>
        <div class="model-cards">${modelCards}</div>
        <div class="scene-note"><span class="ui-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg></span>每项任务预计调用一次；网络结果无法确认时整批暂停，不会擅自重复提交。</div>
        <div class="generation-preserved-settings" hidden>
          <select id="gen-dlg-provider" onchange="genProviderChanged()">${providerOptions}</select>
          <select id="gen-dlg-model">${modelOptions}</select>
          <select id="gen-dlg-size">${sizeOptions}</select>
          <select id="gen-dlg-quality">${qualityOptions}</select>
          <input id="gen-dlg-quantity" type="number" value="${recolorQuantity > 0 ? recolorQuantity : pairCount}">
          <input id="gen-dlg-concurrency" type="number" value="${recolorConcurrency}">
        </div>
      </div>
      <footer class="scene-modal-foot"><button class="btn bs" onclick="cancelGenDialog()">取消</button><button class="btn lanvas-primary" onclick="confirmGenDialog()">确认并开始</button></footer>
    </section>`;
  document.body.appendChild(overlay);
  centerRecolorModalInHost(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') return cancelGenDialog();
    if (event.key !== 'Tab') return;
    var focusable = [...overlay.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

function confirmGenDialog() {
  const pSel = document.getElementById('gen-dlg-provider');
  const mSel = document.getElementById('gen-dlg-model');
  const sSel = document.getElementById('gen-dlg-size');
  const qSel = document.getElementById('gen-dlg-quality');
  const nInp = document.getElementById('gen-dlg-quantity');
  const cInp = document.getElementById('gen-dlg-concurrency');
  if (pSel) recolorProviderId = pSel.value;
  if (mSel) recolorModel = mSel.value;
  if (sSel) recolorSize = sSel.value;
  if (qSel) recolorQuality = qSel.value;
  if (nInp) {
    const rawQty = parseInt(nInp.value, 10) || 0;
    // 0/空、或 >= 本次配对数，都视为「全部」，存 0，避免下次弹窗被上次的配对数污染
    recolorQuantity = (rawQty > 0 && rawQty < genDialogPairCount) ? rawQty : 0;
  }
  if (recolorQuantity < 0) recolorQuantity = 0;
  if (cInp) recolorConcurrency = Math.min(8, Math.max(3, parseInt(cInp.value, 10) || 8));
  try {
    localStorage.setItem('recolor_provider', recolorProviderId);
    localStorage.setItem('recolor_model', recolorModel);
    localStorage.setItem('recolor_size', recolorSize);
    localStorage.setItem('recolor_quality', recolorQuality);
    localStorage.setItem('recolor_quantity', String(recolorQuantity));
    localStorage.setItem('recolor_concurrency', String(recolorConcurrency));
  } catch (e) {}
  const overlay = document.getElementById('gen-config-overlay');
  if (overlay) overlay.remove();
  const genCtl = $('gen-ctl');
  if (genCtl) genCtl.style.display = 'none';
  startGen();
}

function cancelGenDialog() {
  const overlay = document.getElementById('gen-config-overlay');
  if (overlay) overlay.remove();
}

async function handleStartGen() {
  // 获取本次将生成的真实任务数量（来自 /api/scan，不受筛选搜索影响）
  let pairCount = scanPairs ? scanPairs.length : 0;
  if (!pairCount && scanData?.totalPairs) pairCount = scanData.totalPairs;
  // 如果没有缓存数据，实时调用 /api/scan
  if (!pairCount) {
    try {
      const fresh = await api('/api/scan');
      if (fresh?.success && fresh.pairs?.length) {
        pairCount = fresh.pairs.length;
        scanData = fresh;
        scanPairs = fresh.pairs;
      }
    } catch (e) {}
  }

  if (!pairCount) {
    toast('没有可生成任务，请先上传素材并扫描配对。', 'wn');
    return;
  }

  // 弹出生成设置对话框（选 Provider / 模型 / 尺寸 / 质量 / 数量）
  await openGenerateDialog(pairCount);
}

// 手动继续：只恢复当前队列，不复制任务、不重置失败任务
async function continueGen() {
  var curBatch = window.__currentBatch;
  if (!curBatch?.batchId) return toast('没有可继续的任务。', 'wn');
  try {
    var result = await api('/api/batches/' + encodeURIComponent(curBatch.batchId) + '/resume', {});
    if (!result?.success) throw new Error(result?.error || '恢复失败');
    genDone = false;
    batchId = curBatch.batchId;
    go(3);
    startPolling(true);
    toast('已继续生成，等待任务将按原顺序执行。', 'ok');
  } catch (error) {
    toast('继续生成失败：' + (error.message || '请稍后重试'), 'ng');
  }
}

async function viewOutputs() {
  // 使用工作台弹窗显示输出，任务列表不会被覆盖，关闭弹窗后回到原界面
  openWorkbenchModal('outputs');
}

function backToTaskList() {
  const batch = window.__currentBatch;
  if (batch) {
    renderBatch(batch);
  } else {
    $('task-list').innerHTML = '';
    const emptyState = $('task-table-empty');
    if (emptyState) emptyState.classList.remove('hidden');
    $('ttb-count').textContent = '无任务';
  }
}

// ===== 防重入锁（STEP 3） =====
const executing = new Set();
function safeAction(key, fn) {
  if (executing.has(key)) return;
  executing.add(key);
  return Promise.resolve(fn()).finally(() => executing.delete(key));
}

// ===== 清除功能（统一入口 + 单写入点 updateBatch） =====
async function clearCompleted() {
  // 使用父作用域的filterTasks（IIFE闭包）
  var batch = window.__currentBatch;
  if (!batch || !batch.tasks?.length) return toast('没有可清理的任务', 'wn');
  var targetTasks = batch.tasks.filter(function(t){ return !t.hiddenInTaskList && nstatus(t) === STATUS_COMPLETED; });
  var runningTasks = batch.tasks.filter(function(t){ return !t.hiddenInTaskList && nstatus(t) === STATUS_RUNNING; });
  if (runningTasks.length > 0) return toast('存在 ' + runningTasks.length + ' 个运行中任务，请先暂停或等待完成后操作。', 'wn');
  if (!targetTasks.length) return toast('没有已完成任务可以清除。', 'wn');
  if (!await askRecolorConfirmation({ danger:true, title:'清除已完成任务', subtitle:'仅处理当前任务列表', facts:[{label:'任务数量',value:targetTasks.length+' 条'}], message:'此旧维护入口不会删除图片文件。', confirmText:'确认清除' })) return;
  safeAction('clearCompleted', async function() {
    await api('/api/batches/' + encodeURIComponent(batch.batchId) + '/clear-all-success', {});
    var clone = structuredClone(batch);
    clone.tasks = (clone.tasks || []).filter(function(t) { return nstatus(t) !== STATUS_COMPLETED; });
    selectedTaskIds = [];
    updateBatch(clone);
  });
}

async function clearFailed() {
  var batch = window.__currentBatch;
  if (!batch || !batch.tasks?.length) return toast('没有可清理的任务', 'wn');
  var targetTasks = batch.tasks.filter(function(t){ return !t.hiddenInTaskList && nstatus(t) === STATUS_FAILED; });
  var runningTasks = batch.tasks.filter(function(t){ return !t.hiddenInTaskList && nstatus(t) === STATUS_RUNNING; });
  if (runningTasks.length > 0) return toast('存在 ' + runningTasks.length + ' 个运行中任务，请先暂停或等待完成后操作。', 'wn');
  if (!targetTasks.length) return toast('没有失败任务可以清除。', 'wn');
  if (!await askRecolorConfirmation({ danger:true, title:'清除失败任务', subtitle:'仅处理当前任务列表', facts:[{label:'任务数量',value:targetTasks.length+' 条'}], message:'此旧维护入口不会删除图片文件。', confirmText:'确认清除' })) return;
  safeAction('clearFailed', async function() {
    await api('/api/batches/' + encodeURIComponent(batch.batchId) + '/clear-all-failed', {});
    var clone = structuredClone(batch);
    clone.tasks = (clone.tasks || []).filter(function(t) { return nstatus(t) !== STATUS_FAILED; });
    selectedTaskIds = [];
    updateBatch(clone);
  });
}

async function clearCancelled() {
  var batch = window.__currentBatch;
  if (!batch || !batch.tasks?.length) return toast('没有可清理的任务', 'wn');
  var targetTasks = batch.tasks.filter(function(t){ return !t.hiddenInTaskList && nstatus(t) === STATUS_CANCELLED; });
  var runningTasks = batch.tasks.filter(function(t){ return !t.hiddenInTaskList && nstatus(t) === STATUS_RUNNING; });
  if (runningTasks.length > 0) return toast('存在 ' + runningTasks.length + ' 个运行中任务，请先暂停或等待完成后操作。', 'wn');
  if (!targetTasks.length) return toast('没有已取消任务可以清除。', 'wn');
  if (!await askRecolorConfirmation({ danger:true, title:'清除已取消任务', subtitle:'仅处理当前任务列表', facts:[{label:'任务数量',value:targetTasks.length+' 条'}], message:'此旧维护入口不会删除图片文件。', confirmText:'确认清除' })) return;
  safeAction('clearCancelled', async function() {
    await api('/api/batches/' + encodeURIComponent(batch.batchId) + '/clear-all-cancelled', {});
    var clone = structuredClone(batch);
    clone.tasks = (clone.tasks || []).filter(function(t) { return nstatus(t) !== STATUS_CANCELLED; });
    selectedTaskIds = [];
    updateBatch(clone);
  });
}
// ===== 费用统计归零 =====
function resetCostStats(source) {
  console.log('[COST-RESET] resetCostStats called by=' + source);
  var batch = window.__currentBatch;
  if (batch) {
    console.log('[COST-RESET] before clear cost=' + (batch.totals?.costFen || 0) + ' apiCalls=' + (batch.totals?.apiAttempts || 0));
    if (batch.totals) {
      batch.totals.costFen = 0;
      batch.totals.apiAttempts = 0;
      batch.totals.done = 0;
      batch.totals.completed = 0;
      batch.totals.success = 0;
      batch.totals.failed = 0;
      batch.totals.cancelled = 0;
      batch.totals.interrupted = 0;
      batch.totals.pending = 0;
      batch.totals.running = 0;
      batch.totals.total = 0;
    }
    // 强制更新 cost-note UI
    var costNote = $('cost-note');
    if (costNote) {
      costNote.innerHTML = '<i class="ph-duotone ph-receipt" aria-hidden="true"></i><span class="batch-cost-copy"><strong>¥0.00 · 0 次 API 调用</strong><span>查看任务执行汇总</span></span><i class="ph-duotone ph-caret-right open" aria-hidden="true"></i>';
      costNote.style.display = 'block';
    }
    console.log('[COST-RESET] after clear cost=' + (batch.totals?.costFen || 0) + ' apiCalls=' + (batch.totals?.apiAttempts || 0));
  }
  // 持久化
  persistStateOnly().catch(function(e) { console.error('[COST-RESET] persist failed:', e); });
}
// ===== 清空全部 =====
async function clearAllTasks() {
  // 使用父作用域的filterTasks（IIFE闭包）
  var batch = window.__currentBatch;
  if (!batch || !batch.tasks?.length) return toast('没有可清理的任务', 'wn');
  var visibleCount = batch.tasks.filter(function(t){ return !t.hiddenInTaskList; }).length;
  if (!await askRecolorConfirmation({ danger:true, title:'清空全部任务记录', subtitle:'这个旧维护操作不可恢复', facts:[{label:'任务数量',value:visibleCount+' 条'}], message:'不会删除生成图片文件，但任务记录会被清空。', confirmText:'确认清空' })) return;
  safeAction('clearAll', async function() {
    await api('/api/batches/' + encodeURIComponent(batch.batchId) + '/clear-all', {});
    var clone = structuredClone(batch);
    clone.tasks = [];
    clone.totals = { total: 0, pending: 0, running: 0, completed: 0, success: 0, failed: 0, cancelled: 0, interrupted: 0, done: 0, costFen: 0, apiAttempts: 0 };
    selectedTaskIds = [];
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    scanData = null;
    scanPairs = [];
    valData = { passed: 0, warned: 0, pairs: [] };
    // STEP 18: 同步清空持久化缓存，防止刷新后旧 scan pairs 恢复
    await persistStateOnly();
    updateBatch(clone);
    resetCostStats('clearAllTasks');
    toast('任务列表与配对缓存已清空', 'ok');
  });
}

// ========== 任务选中 + 对比面板 ==========

// 直接拉取批次并渲染（绕过轮询，保证删除后立即刷新）
async function refreshAndRender(targetBatchId) {
  try {
    const result = await api(`/api/batches/${encodeURIComponent(targetBatchId || batchId)}`);
    if (result.success && result.batch) {
      await hydrateBatchReferenceMetadata(result.batch);
      updateBatch(result.batch);
      result.batch._taskPage = pageTracker[result.batch.batchId] || 1;
      renderBatch(result.batch);
    } else {
      console.warn('[refreshAndRender] API returned unexpected:', result);
    }
  } catch (e) { console.error('[refreshAndRender] fetch failed:', e); }
}

let selectedBatchId = null;
let selectedTaskId = null;
let comparePosition = 50;

function setComparePosition(value) {
  comparePosition = Math.max(0, Math.min(100, Number(value) || 0));
  const stage = document.getElementById('compare-stage');
  const slider = document.getElementById('compare-slider');
  if (stage) stage.style.setProperty('--compare-position', comparePosition + '%');
  if (slider) slider.setAttribute('aria-valuenow', String(Math.round(comparePosition)));
}

function setCompareResultAvailable(available) {
  const stage = document.getElementById('compare-stage');
  if (stage) stage.classList.toggle('has-result', Boolean(available));
}

function setCompareMissing(side, text) {
  const el = document.getElementById(side === 'before' ? 'compare-missing-before' : 'compare-missing-after');
  if (!el) return;
  el.hidden = !text;
  el.innerHTML = text ? '<span aria-hidden="true">◇</span><p>' + escapeHtml(text) + '</p>' : '';
}

function initCompareSlider() {
  const stage = document.getElementById('compare-stage');
  const slider = document.getElementById('compare-slider');
  if (!stage || !slider || slider.dataset.ready === 'true') return;
  slider.dataset.ready = 'true';
  const move = function(event) {
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    setComparePosition((event.clientX - rect.left) / rect.width * 100);
  };
  slider.addEventListener('pointerdown', function(event) {
    event.preventDefault();
    slider.setPointerCapture?.(event.pointerId);
    move(event);
  });
  slider.addEventListener('pointermove', function(event) {
    if (slider.hasPointerCapture?.(event.pointerId)) move(event);
  });
  slider.addEventListener('keydown', function(event) {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return setComparePosition(0);
    if (event.key === 'End') return setComparePosition(100);
    setComparePosition(comparePosition + (event.key === 'ArrowLeft' ? -2 : 2));
  });
  setComparePosition(comparePosition);
}

function selectTask(bid, tid, fromAuto = false) {
  selectedBatchId = bid;
  selectedTaskId = tid;

  // 追踪用户手动选择（自动选中不计入）
  if (!fromAuto) {
    userSelectedTaskId = tid;
    autoSelectSuppressed = false;
  }

  // 高亮选中行
  document.querySelectorAll('.task-row').forEach(r => r.classList.remove('selected'));
  const row = document.querySelector(`.task-row[data-batch="${bid}"][data-task="${tid}"]`);
  if (row) row.classList.add('selected');

  // ===== 扫描预览任务 =====
  if (bid === 'scan-preview') {
    const pair = (scanPairs || []).find(p => p.id === tid);
    if (!pair) { showCompareEmpty(); return; }

    const tplEncoded = encodeURIComponent(pair.templateName);
    const tplUrl = `/uploads/templates/${tplEncoded}`;
    const tplShort = escapeHtml(pair.templateNameWithoutExt || pair.templateName || '—');
    const clrShort = escapeHtml(pair.colorNameWithoutExt || pair.colorName || '—');

    // 切换显示
    const empty = document.getElementById('compare-empty');
    const content = document.getElementById('compare-content');
    if (empty) empty.style.display = 'none';
    if (content) content.style.display = 'flex';

    // 左侧显示模板图 — 不销毁 img 元素
    const beforeImg = document.getElementById('compare-before-img');
    const beforeMeta = document.getElementById('compare-before-meta');
    if (beforeImg) {
      beforeImg.src = tplUrl;
      beforeImg.style.display = '';
      beforeImg.title = '点击放大';
      beforeImg.style.cursor = 'zoom-in';
      beforeImg.onclick = function() { openImagePreview(tplUrl, '模版原图', pair.templateName || ''); };
      beforeImg.onerror = function() { beforeImg.src = ''; beforeImg.style.display = 'none'; };
    }
    setCompareMissing('before', '');
    if (beforeMeta) {
      beforeMeta.innerHTML = `<div><strong>${tplShort}</strong></div><div style="font-size:10px;color:var(--t3)">模版原图</div>`;
    }

    // 右侧显示"结果未生成"
    const afterImg = document.getElementById('compare-after-img');
    const afterMeta = document.getElementById('compare-after-meta');
    if (afterImg) { afterImg.src = ''; afterImg.style.display = 'none'; }
    setCompareMissing('after', '结果未生成');
    setCompareResultAvailable(false);
    if (afterMeta) {
      afterMeta.innerHTML = `<div style="color:var(--t3);font-size:11px">${clrShort}</div><div style="font-size:10px;color:var(--t3)">等待生成</div>`;
    }

    // 参考色摘要与详情：扫描预览也沿用正式任务的右栏结构
    const refRow = document.getElementById('compare-ref-row');
    const refSwatch = document.getElementById('compare-ref-swatch');
    const refName = document.getElementById('compare-ref-name');
    const refMeta = document.getElementById('compare-ref-meta');
    const refModel = document.getElementById('compare-ref-model');
    const refTaskId = document.getElementById('compare-ref-task-id');
    const retryWrap = document.getElementById('compare-retry');
    const colorEncoded = encodeURIComponent(pair.colorName || '');
    const refUrl = pair.colorName ? `/uploads/colors/${colorEncoded}` : '';
    if (refRow) refRow.style.display = 'flex';
    const refColorName = pair.colorNameWithoutExt || pair.colorName || '参考色缺失';
    const refHex = normalizedReferenceHex(pair.referenceHex) || getReferenceColorHex(pair.colorName || refColorName);
    if (refName) refName.textContent = `参考色：${refColorName}`;
    if (refMeta) refMeta.textContent = refUrl ? (refHex ? `${refHex}，来源：参考图` : '来源：参考图') : '未找到参考图';
    if (refModel) refModel.textContent = pair.model || recolorModel || '待绑定模型';
    if (refTaskId) refTaskId.textContent = recolorTaskShortId(pair);
    if (refSwatch) {
      refSwatch.style.backgroundImage = !refHex && refUrl ? `url("${String(refUrl).replace(/"/g, '%22')}")` : 'none';
      refSwatch.style.backgroundColor = refHex || '';
      refSwatch.classList.toggle('missing', !refUrl && !refHex);
    }
    if (retryWrap) retryWrap.style.display = 'none';

    // 详情
    const detail = document.getElementById('compare-detail');
    if (detail) {
      detail.innerHTML = [
        `<span class="compare-stat"><span>状态</span><b>待生成</b></span>`,
        `<span class="compare-stat"><span>质量</span><b>—</b></span>`,
        `<span class="compare-stat"><span>色差</span><b>—</b></span>`,
        `<span class="compare-stat"><span>费用</span><b>—</b></span>`
      ].join('');
    }
    return;
  }

  // ===== 真实 batch task =====
  const batch = window.__currentBatch;

  // 查找任务数据
  const task = batch?.tasks?.find(t => t.id === tid);
  if (!task) {
    showCompareEmpty();
    return;
  }

  var urls = resolveTaskImageUrls(batch, task);
  var tplUrl = urls.templateUrl;
  var outUrl = urls.resultUrl;
  var refUrl = urls.referenceUrl;

  // 切换显示
  const empty = document.getElementById('compare-empty');
  const content = document.getElementById('compare-content');
  if (empty) empty.style.display = 'none';
  if (content) content.style.display = 'flex';

  // 更新原图（模板图）— 先清空再设置
  const beforeImg = document.getElementById('compare-before-img');
  const beforeMeta = document.getElementById('compare-before-meta');
  if (beforeImg) {
    beforeImg.src = ''; // 先清空防止串图
    beforeImg.onerror = null;
    beforeImg.onclick = null;
    beforeImg.style.display = 'none';
    if (tplUrl) {
      beforeImg.src = tplUrl;
      beforeImg.style.display = '';
      beforeImg.title = '点击放大';
      beforeImg.style.cursor = 'zoom-in';
      beforeImg.onclick = function() { openImagePreview(tplUrl, '模板图', task.template || task.templateNameWithoutExt || ''); };
      beforeImg.onerror = function() {
        beforeImg.src = '';
        beforeImg.style.display = 'none';
        showCompareImgMissing('before', '模板缺失');
      };
    } else {
      showCompareImgMissing('before', '无模板图');
    }
  }
  // 移除旧空状态
  setCompareMissing('before', '');
  if (beforeMeta) {
    beforeMeta.innerHTML = tplUrl
      ? `<div><strong>${escapeHtml(task.templateNameWithoutExt || task.template || '—')}</strong></div><div style="font-size:10px;color:var(--t3)">模板原图</div>`
      : `<div class="preview-missing">📐 模板缺失</div>`;
  }

  // 更新结果（生成图）— 先清空再设置
  const afterImg = document.getElementById('compare-after-img');
  const afterMeta = document.getElementById('compare-after-meta');
  if (afterImg) {
    afterImg.src = ''; // 先清空防止串图
    afterImg.onerror = null;
    afterImg.onclick = null;
    afterImg.style.display = 'none';
    if (outUrl) {
      afterImg.src = outUrl;
      afterImg.style.display = '';
      afterImg.title = '点击放大';
      afterImg.style.cursor = 'zoom-in';
      afterImg.onclick = function() { openImagePreview(outUrl, '生成图', task.output || ''); };
      afterImg.onerror = function() {
        afterImg.src = '';
        afterImg.style.display = 'none';
        showCompareImgMissing('after', '结果缺失');
      };
      // 移除旧空状态
      setCompareMissing('after', '');
      setCompareResultAvailable(true);
      if (afterMeta) {
        afterMeta.innerHTML = `<div><strong>${escapeHtml(task.colorNameWithoutExt || task.colorRef || '—')}</strong></div><div style="font-size:10px;color:var(--t3)">改色输出</div>`;
      }
    } else {
      setCompareMissing('after', '结果未生成');
      setCompareResultAvailable(false);
      if (afterMeta) afterMeta.innerHTML = '<div style="color:var(--t3);font-size:11px">等待生成…</div>';
    }
    // 重做按钮显隐：已完成/成功且有结果时显示
    const retryWrap = document.getElementById('compare-retry');
    const retryBtn = document.getElementById('compare-retry-btn');
    const retryStatus = document.getElementById('compare-retry-status');
    if (retryWrap) {
      const es = task.executionStatus || task.status || '';
      const canRetry = (es === 'completed' || es === 'success' || es === 'done') && outUrl;
      retryWrap.style.display = canRetry ? 'flex' : 'none';
      if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '重做'; }
      if (retryStatus) retryStatus.style.display = 'none';
    }
  }

  // 更新详情（含参考色信息）
  const detail = document.getElementById('compare-detail');
  const refRow = document.getElementById('compare-ref-row');
  const refSwatch = document.getElementById('compare-ref-swatch');
  const refName = document.getElementById('compare-ref-name');
  const refMeta = document.getElementById('compare-ref-meta');
  const refModel = document.getElementById('compare-ref-model');
  const refTaskId = document.getElementById('compare-ref-task-id');
  if (refRow) refRow.style.display = 'flex';
  const refColorName = task.colorNameWithoutExt || task.colorRef || '参考色缺失';
  const refHex = normalizedReferenceHex(task.referenceHex) || getReferenceColorHex(task.colorRef || task.colorName || refColorName);
  if (refName) refName.textContent = `参考色：${refColorName}`;
  if (refMeta) refMeta.textContent = refUrl ? (refHex ? `${refHex}，来源：参考图` : '来源：参考图') : '未找到参考图';
  if (refModel) refModel.textContent = task.modelSnapshot || task.model || task.modelName || window.__currentBatch?.modelSnapshot || '系统默认';
  if (refTaskId) refTaskId.textContent = recolorTaskShortId(task);
  if (refSwatch) {
    refSwatch.style.backgroundImage = !refHex && refUrl ? `url("${String(refUrl).replace(/"/g, '%22')}")` : 'none';
    refSwatch.style.backgroundColor = refHex || '';
    refSwatch.classList.toggle('missing', !refUrl && !refHex);
  }
  if (detail) {
    const es = task.executionStatus || task.status || '—';
    const qs = task.qualityStatus || '—';
    detail.innerHTML = [
      `<span class="compare-stat"><span>状态</span><b>${statusText(es)}</b></span>`,
      `<span class="compare-stat"><span>质量</span><b>${statusText(qs)}</b></span>`,
      `<span class="compare-stat"><span>色差</span><b>${task.deltaE != null ? task.deltaE.toFixed(2) : '—'}</b></span>`,
      `<span class="compare-stat"><span>费用</span><b>${money(task.costFen)}</b></span>`
    ].join('');
  }
}

// 辅助函数：在右侧预览中显示图片缺失状态
function showCompareImgMissing(side, text) {
  setCompareMissing(side, text);
  if (side === 'after') setCompareResultAvailable(false);
}

function showCompareEmpty() {
  const empty = document.getElementById('compare-empty');
  const content = document.getElementById('compare-content');
  if (empty) empty.style.display = 'block';
  if (content) content.style.display = 'none';
}

// 翻页切换
function batchTaskPage(batchId, page) {
  pageTracker[batchId] = page;
  // 重新拉取批次数据
  fetch(`/api/batches/${encodeURIComponent(batchId)}`).then(r => r.json()).then(res => {
    if (res.success && res.batch) {
      res.batch._taskPage = page;
      renderBatch(res.batch);
    }
  }).catch(e => console.warn('翻页失败', e));
}

// 单项重试（skipConfirm=true 用于批量重试跳过确认，skipStart=true 不自动启动runner）
async function retrySingleTask(batchId, taskId, skipConfirm, skipStart) {
  if (!skipConfirm) {
    var task = window.__currentBatch?.tasks?.find(function(item) { return item.id === taskId; });
    var lockedPrice = Number(task?.lockedUnitPriceFen || task?.costPerCallFen || window.__currentBatch?.lockedUnitPriceFen || userApiPriceFen || 0);
    var redoUrls = resolveTaskImageUrls(window.__currentBatch || { batchId:batchId }, task || {});
    var redoColor = task?.colorNameWithoutExt || task?.colorRef || '参考色';
    var redoHex = normalizedReferenceHex(task?.referenceHex) || getReferenceColorHex(task?.colorRef || task?.colorName || '') || '#7B4A94';
    var redoModel = task?.modelSnapshot || task?.model || window.__currentBatch?.modelSnapshot || '任务创建时绑定模型';
    var redoCode = recolorTaskShortId(task || { id:taskId });
    var redoVisual = '<div class="redo-grid"><div class="redo-preview">'+(redoUrls.resultUrl?'<img src="'+escapeHtml(redoUrls.resultUrl)+'" alt="当前生成结果">':'<span>暂无旧结果</span>')+'<em>当前最新结果</em></div><div class="redo-info"><div class="redo-task-name"><i style="background:'+escapeHtml(redoHex)+'"></i><div><strong>'+escapeHtml(task?.templateNameWithoutExt || '当前模板')+'</strong><span>'+escapeHtml(redoColor)+'</span></div></div><div class="redo-line"><span>使用模型</span><strong>'+escapeHtml(redoModel)+'</strong></div><div class="redo-line"><span>任务识别码</span><strong>'+escapeHtml(redoCode)+'</strong></div></div></div>';
    var confirmed = await askRecolorConfirmation({ scene:'redo', title:'确认重新生成', subtitle:'点击后立即生成或进入当前队列，无需等待上一张完成', visualHtml:redoVisual, facts:[{ label:'预计费用', value:'1 次 API 调用 · '+(lockedPrice ? money(lockedPrice) : '系统默认') },{ label:'结果替换', value:'成功后替换旧图' }], message:'旧图会保留到新图保存成功。网络结果无法确认时系统会暂停，不会自动再次提交。', confirmText:'确认重做' });
    if (!confirmed) return false;
  }
  try {
    const result = await api(`/api/batches/${encodeURIComponent(batchId)}/retry-task`, { taskId, skipStart: false });
    if (!result.success) { toast(result.error || '重试失败', 'ng'); return false; }
    toast('已开始重新生成');
    await refreshAndRender(batchId);
    startPolling(true);
  } catch (e) { toast('重试失败: ' + (e.message || ''), 'ng'); }
  return true;
}

// ===== 对比面板重做按钮 =====
async function clickCompareRetry() {
  if (!selectedBatchId || !selectedTaskId) { toast('未选中任务', 'wn'); return; }
  const retryBtn = document.getElementById('compare-retry-btn');
  const retryStatus = document.getElementById('compare-retry-status');
  if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = '重做中…'; }
  if (retryStatus) { retryStatus.style.display = 'inline'; retryStatus.textContent = '排队中…'; }
  try {
    const ok = await retrySingleTask(selectedBatchId, selectedTaskId, false, false);
    if (!ok) {
      if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '重做'; }
      if (retryStatus) retryStatus.style.display = 'none';
    }
    // 成功后 selectTask 会被 refreshAndRender → renderUI → autoSelectLatestCompleted 触发，自动重置按钮状态
  } catch (e) {
    if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '重试'; }
    if (retryStatus) { retryStatus.textContent = '失败，请重试'; }
    toast('重做失败: ' + (e.message || ''), 'ng');
  }
}

// 单项清除
async function clearSingleTask(batchId, taskId) {
  var task = window.__currentBatch?.tasks?.find(function(item) { return item.id === taskId; });
  var confirmed = await askRecolorConfirmation({
    danger:true,
    scene:'delete',
    title:'删除这项复色任务',
    subtitle:'删除后会立即从列表隐藏，并提供 5 秒撤销',
    facts:[
      {label:'模板图',value:task?.templateNameWithoutExt || task?.template || '当前模板'},
      {label:'参考色',value:task?.colorNameWithoutExt || task?.colorRef || '当前参考色'},
      {label:'正在生成',value:['running','submitting','submitted'].includes(task?.executionStatus || task?.generationSubmissionState) ? '远端可能仍会完成并计费' : '否'}
    ],
    message:'删除只影响这一项任务；其它任务、上传素材和历史结果不受影响。',
    confirmText:'确认删除'
  });
  if (!confirmed) return false;
  try {
    const result = await api(`/api/batches/${encodeURIComponent(batchId)}/clear-task`, { taskId });
    if (!result.success) return toast(result.error || '清除失败', 'ng');
    showDeleteUndo(result, batchId);
    // 直接拉取最新批次并渲染，不依赖轮询
    await refreshAndRender(batchId);
  } catch (e) { toast('清除失败', 'ng'); }
  return true;
}

// ===== 清空全部 =====
async function clearAllSuccess(batchId) {
  if (!await askRecolorConfirmation({ danger:true, title:'删除所有已生成任务', subtitle:'任务与历史结果会同步隐藏', facts:[{label:'撤销时间',value:'5 秒'}], message:'超过撤销时间后，对应最新生成图将正式删除。', confirmText:'确认删除' })) return;
  try {
    const result = await api(`/api/batches/${encodeURIComponent(batchId)}/clear-all-success`, {});
    showDeleteUndo(result, batchId);
    selectedTaskIds = [];
    await refreshAndRender(batchId);
  } catch (e) { toast('清除失败', 'ng'); }
}

// 删除所有已停止任务（不影响文件）
async function clearAllCancelled(batchId) {
  if (!await askRecolorConfirmation({ danger:true, title:'删除所有已停止任务', subtitle:'任务会立即从列表隐藏', facts:[{label:'撤销时间',value:'5 秒'}], message:'超过撤销时间后任务记录将正式删除。', confirmText:'确认删除' })) return;
  try {
    const result = await api(`/api/batches/${encodeURIComponent(batchId)}/clear-all-cancelled`, {});
    showDeleteUndo(result, batchId);
    selectedTaskIds = [];
    await refreshAndRender(batchId);
  } catch (e) { toast('删除失败', 'ng'); }
}

async function cancelGen() {
  if (!batchId) return;
  const btnCancel = $('btn-cancel');
  const baCancel = $('ba-cancel');
  const btnCancelText = btnCancel?.textContent || '暂停生成';
  const baCancelText = baCancel?.textContent || '暂停生成';
  if (btnCancel) { btnCancel.disabled = true; btnCancel.textContent = '暂停中…'; }
  if (baCancel) { baCancel.disabled = true; baCancel.textContent = '暂停中…'; }
  try {
    const result = await api('/api/cancel', { batchId });
    toast(result.success ? '已请求暂停；已提交的任务会完成，队列不会再领取新任务。' : result.error, result.success ? 'ok' : 'ng');
    if (result.success) {
      genDone = false;
      await persistStateOnly();
      await refreshAndRender(batchId);
      startPolling(true);
    }
  } catch (e) {
    toast('暂停失败: ' + e.message, 'ng');
  } finally {
    if (btnCancel) { btnCancel.disabled = false; btnCancel.textContent = btnCancelText; }
    if (baCancel) { baCancel.disabled = false; baCancel.textContent = baCancelText; }
  }
}

async function resumeBatch() {
  if (!batchId) return;
  const result = await api(`/api/batches/${encodeURIComponent(batchId)}/resume`, {});
  if (!result.success) return toast(result.error || '继续失败', 'ng');
  toast('已继续生成，等待任务将按原顺序执行。');
  startPolling(true);
}

async function loadOut() {
  const outBox = $('out-box');
  const btnDownload = $('btn-download');
  try {
    const result = await api('/api/outputs');
    const outputs = result.outputs || [];
    if (!outputs.length) {
      if (outBox) outBox.innerHTML = '<div class="empty">📭 暂无结果</div>';
      if (btnDownload) btnDownload.style.display = 'none';
      return;
    }

    if (outBox) outBox.innerHTML = outputs.map(batch => {
      const files = batch.files || [];
      const colors = [...new Set(files.map(f => f.colorRef).filter(Boolean))];
      const colorFilterId = `cf-${batch.batch.replace(/[^a-zA-Z0-9]/g,'_')}`;

      return `
      <section class="batch-card">
        <div class="batch-head">
          <div>
            <strong>${escapeHtml(batch.batch)}</strong>
            <div class="batch-summary">${formatTime(batch.createdAt)} · 成功 ${batch.totals.success} · 失败 ${batch.totals.failed} · 费用 ${calcCost(batch)}</div>
          </div>
          <div class="btns">
            <button class="btn bs" onclick="downloadBatch('${batch.batch}')">下载 ZIP</button>
            ${batch.status === 'running' ? '<button class="btn bd" disabled style="opacity:0.4;cursor:not-allowed">任务进行中</button>' : `<button class="btn bd" onclick="deleteBatch('${batch.batch}')">删除</button>`}
          </div>
        </div>
        ${colors.length > 1 ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
          <span style="font-size:10px;color:var(--t3)">颜色</span>
          <button class="btn bs" style="padding:2px 8px;font-size:9px" onclick="filterResults('${colorFilterId}','all')">全部</button>
          ${colors.map(c => {
            const cname = c.replace('.jpg','').replace('.png','');
            return `<div style="display:flex;align-items:center;gap:1px">
              <button class="btn bs" style="padding:2px 8px;font-size:9px;border-radius:12px 0 0 12px" onclick="filterResults('${colorFilterId}','${escapeHtml(c)}')">${cname}</button>
              <button class="btn bp" style="padding:2px 6px;font-size:9px;border-radius:0 12px 12px 0" onclick="downloadUrl('/api/download-zip?batch=${encodeURIComponent(batch.batch)}&color=${encodeURIComponent(c)}')" title="下载 ${escapeHtml(cname)} 全部">下载</button>
            </div>`;
          }).join('')}
        </div>` : files.length > 3 ? `<div style="font-size:10px;color:var(--t3);margin-bottom:6px">${files.length}项</div>` : ''}
        <div class="og out-scroll" id="${colorFilterId}">${files.map(file => {
          const url = `/output/${encodeURIComponent(batch.batch)}/${file.relativePath.split('/').map(encodeURIComponent).join('/')}`;
          const info = `${escapeHtml(file.template)} → ${escapeHtml(file.colorRef)}`;
          const qs = file.qualityStatus || 'unknown';
          const roundCount = file.correctionRounds != null ? Number(file.correctionRounds) + 1 : 1;
          const taskId = file.template + file.colorRef;
          const roundNav = roundCount > 1 ? `<div class="round-nav">
            <span>轮:</span>${[...Array(roundCount)].map((_,i) => `<button class="${i===roundCount-1?'active':''}" onclick="switchRound(event,'${taskId}',${i+1})">${i+1}</button>`).join('')}
          </div>` : '';
          return `<div class="oc" data-color="${escapeHtml(file.colorRef)}" data-round="1" data-max-round="${roundCount}">
            <div class="th"><img src="${url}" loading="lazy" onclick="previewImage('${url}','${info}')"></div>
            <div class="if">
              <div class="nm">${info}</div>
              <div class="sz">${statusText(file.executionStatus||'completed')} · ${money(file.costFen)} · ΔE ${file.deltaE ?? '—'}</div>
            </div>
            ${roundNav}
          </div>`;
        }).join('')}</div>
      </section>`}).join('');
    if (btnDownload) {
      btnDownload.style.display = 'inline-flex';
      btnDownload.dataset.batch = outputs[0].batch;
    }
  } catch (error) {
    toast('结果加载失败', 'ng');
  }
}

// 轮次切换
function switchRound(event, taskKey, round) {
  event.stopPropagation();
  const card = event.target.closest('.oc');
  if (!card) return;
  card.dataset.round = round;
  const btns = card.querySelectorAll('.round-nav button');
  btns.forEach(b => b.classList.toggle('active', b.textContent === String(round)));
}

// 颜色筛选
function filterResults(containerId, color) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = container.querySelectorAll('.oc');
  items.forEach(item => {
    item.style.display = (color === 'all' || item.dataset.color === color) ? '' : 'none';
  });
}

// 按颜色下载 ZIP
function downloadByColor(batchId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const visible = [...container.querySelectorAll('.oc')].filter(el => el.style.display !== 'none');
  const colors = [...new Set(visible.map(el => el.dataset.color).filter(Boolean))];
  if (colors.length !== 1) {
    toast('请先筛选为单一颜色后再下载', 'wn');
    return;
  }
  const color = colors[0];
  downloadUrl(`/api/download-zip?batch=${encodeURIComponent(batchId)}&color=${encodeURIComponent(color)}`);
}

async function deleteBatch(id) {
  if (!await askRecolorConfirmation({ danger:true, title:'删除整个批次', subtitle:'此旧维护操作不可恢复', facts:[{label:'批次',value:id}], message:'将删除该批次的文件和记录。', confirmText:'确认删除' })) return;
  // 如果该批次正在运行，先停止
  try { await api('/api/cancel', { batchId: id }); } catch (e) {}
  const result = await api('/api/delete-batch', { batch: id });
  if (!result.success) return toast(result.error || '删除失败', 'ng');
  if (batchId === id) {
    batchId = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  toast('已删除');
  loadOut();
}

// 清除所有结果/所有批次
async function clearAllOutputs() {
  if (!await askRecolorConfirmation({ danger:true, title:'清除所有生成结果', subtitle:'此旧维护操作不可恢复', facts:[{label:'范围',value:'全部已完成批次'}], message:'所有已完成批次和图片都会被删除。', confirmText:'确认清除' })) return;
  try {
    const result = await api('/api/clear-all-outputs', {});
    toast(`已清除 ${result.cleared || 0} 个批次`);
    batchId = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    loadOut();
  } catch (e) { toast('清除失败: ' + e.message, 'ng'); }
}

function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 100);
}

function downloadBatch(id) {
  downloadUrl(`/api/download-zip?batch=${encodeURIComponent(id)}`);
}

function downloadZip() {
  if (!batchId) return toast('没有可下载的批次', 'wn');
  toast('正在打包下载…');
  downloadUrl(`/api/batches/${encodeURIComponent(batchId)}/download-results`);
}

function downloadByColor() {
  if (!batchId) return toast('没有可下载的批次', 'wn');
  toast('正在打包下载…');
  downloadUrl(`/api/batches/${encodeURIComponent(batchId)}/download-results-by-color`);
}

function downloadOutput(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.split('/').pop() || 'output.jpg';
  a.click();
}

// ==================== 图片预览弹窗 ====================

function previewImage(src, info) {
  const modal = $('preview-modal');
  const img = $('preview-img');
  const dl = $('preview-download');
  const inf = $('preview-info');
  img.src = src;
  dl.href = src;
  dl.download = src.split('/').pop() || 'image.jpg';
  inf.textContent = info || '';
  modal.style.display = 'flex';
  modal.classList.remove('hiding');
  document.body.style.overflow = 'hidden';
}

function closePreview() {
  const modal = $('preview-modal');
  modal.classList.add('hiding');
  setTimeout(() => {
    modal.style.display = 'none';
    modal.classList.remove('hiding');
    document.body.style.overflow = '';
  }, 200);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('preview-modal').style.display === 'flex') {
    closePreview();
  }
});

function setUploadPasteTarget(type) {
  uploadPasteTarget = type === 'color' ? 'color' : 'template';
  const templateCard = $('uc-tpl');
  const colorCard = $('uc-clr');
  templateCard?.classList.toggle('is-target', uploadPasteTarget === 'template');
  colorCard?.classList.toggle('is-target', uploadPasteTarget === 'color');
  templateCard?.setAttribute('aria-label', '模板图上传卡' + (uploadPasteTarget === 'template' ? '，当前粘贴目标' : ''));
  colorCard?.setAttribute('aria-label', '参考色上传卡' + (uploadPasteTarget === 'color' ? '，当前粘贴目标' : ''));
}

(function setupDropZones() {
  ['tuz', 'cuz'].forEach(id => {
    const element = $(id);
    const card = element.closest('.uc-card') || element;
    const type = id === 'tuz' ? 'template' : 'color';
    card.addEventListener('pointerdown', () => setUploadPasteTarget(type));
    card.addEventListener('focusin', () => setUploadPasteTarget(type));
    card.addEventListener('dragover', event => {
      event.preventDefault();
      setUploadPasteTarget(type);
      card.classList.add('dragover');
    });
    card.addEventListener('dragleave', () => card.classList.remove('dragover'));
    card.addEventListener('drop', event => {
      event.preventDefault();
      card.classList.remove('dragover');
      setUploadPasteTarget(type);
      const files = [...event.dataTransfer.files].filter(file => IMG_RE.test(file.name));
      if (type === 'color') chooseReferenceUploadMode(files, '已拖入');
      else addFiles(type, files);
    });
  });
  setUploadPasteTarget(uploadPasteTarget);
})();

// ===== 真实日志接入 =====
let logRefreshTimer = null;

const LOG_LEVEL_ICON = {
  info: '🔵', success: '🟢', warning: '🟠', error: '🔴'
};
const LOG_LEVEL_LABEL = {
  all: '全部', info: '信息', success: '完成', warning: '警告', error: '错误'
};

async function fetchLogs() {
  const logBody = document.getElementById('log-body');
  const logHeader = document.querySelector('#log-panel .inspector-header');
  if (!logBody) return;

  try {
    const resp = await fetch('/api/logs/recent');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '接口返回异常');

    latestLogs = data.logs || [];
    renderLogs();
  } catch (error) {
    latestLogs = [];
    logBody.innerHTML = `<div class="log-empty">
      <span style="font-size:22px">⚠</span>
      <p>日志读取失败</p>
      <p style="font-size:10px;color:var(--t3)">${escapeHtml(error.message || '请检查后端服务')}</p>
    </div>`;
  }

  // 注入刷新按钮 + 筛选（不修改 HTML）
  if (logHeader) {
    if (!document.getElementById('log-clear-btn')) {
      const clearBtn = document.createElement('button');
      clearBtn.id = 'log-clear-btn';
      clearBtn.innerHTML = '<i class="ph-duotone ph-trash" aria-hidden="true"></i>';
      clearBtn.setAttribute('aria-label', '清空任务日志');
      clearBtn.title = '清空系统日志';
      clearBtn.className = 'log-header-action';
      clearBtn.style.marginLeft = 'auto';
      clearBtn.onclick = clearLogs;
      logHeader.appendChild(clearBtn);
    }
    if (!document.getElementById('log-refresh-btn')) {
      const btn = document.createElement('button');
      btn.id = 'log-refresh-btn';
      btn.innerHTML = '<i class="ph-duotone ph-arrow-clockwise" aria-hidden="true"></i>';
      btn.setAttribute('aria-label', '刷新任务日志');
      btn.title = '刷新日志';
      btn.className = 'log-header-action';
      btn.onclick = function(e) { e.preventDefault(); fetchLogs(); };
      logHeader.appendChild(btn);
    }
    // 日志等级筛选栏
    if (!document.getElementById('log-filter-bar')) {
      const bar = document.createElement('div');
      bar.id = 'log-filter-bar';
      bar.className = 'log-filter-bar';
      bar.innerHTML = ['all','info','success','warning','error'].map(lv =>
        `<button class="log-filter-btn ${logLevelFilter===lv?'active':''} log-filter-${lv}" onclick="setLogFilter('${lv}')">${LOG_LEVEL_LABEL[lv] || '全部'}</button>`
      ).join('');
      logHeader.parentElement.insertBefore(bar, logHeader.nextSibling);
    }
  }
}

async function clearLogs(event) {
  if (event) event.preventDefault();
  if (!await askRecolorConfirmation({ danger:true, title:'清空任务日志', subtitle:'只清除一键复色日志', facts:[{label:'不受影响',value:'任务、素材和生成结果'}], confirmText:'确认清空' })) return;
  try {
    const resp = await fetch('/api/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || '清空失败');
    latestLogs = [];
    renderLogs();
    toast('日志已清空', 'ok');
  } catch (error) {
    toast('日志清空失败：' + (error.message || '请稍后重试'), 'ng');
  }
}

function setLogFilter(level) {
  logLevelFilter = level;
  // 更新按钮状态
  document.querySelectorAll('.log-filter-btn').forEach(b => {
    b.classList.toggle('active', b.classList.contains('log-filter-' + level));
  });
  renderLogs();
}

function formatTaskLogMessage(message) {
  var raw = String(message || '');
  var match = raw.match(/task:\s*(.*?)\s+stage:\s*([^\s]+)/i);
  if (!match) return raw;

  var task = match[1].replace(/^\d+\./, '').trim();
  var stage = match[2].trim();
  var infoMatch = raw.match(/\sinfo:\s*(.*)$/i);
  var info = infoMatch ? infoMatch[1].trim() : '';
  var errorMatch = info.match(/(?:^|\s)err=(.*)$/i);
  var errorText = errorMatch ? errorMatch[1].trim() : '';
  var prefix = task ? '任务 ' + task : '任务';

  if (stage === 'task_start') return prefix + ' 开始生成';
  if (stage === 'generation_submitted') return prefix + ' 已提交生成';
  if (stage === 'output_atomic_write_start') return prefix + ' 正在保存结果';
  if (stage === 'output_write_done') return prefix + ' 结果已保存';
  if (stage === 'task_completed') return prefix + ' 生成完成';
  if (stage === 'task_failed') return prefix + ' 生成失败' + (errorText ? '：' + errorText : '');
  if (stage === 'task_remote_unknown_guard') return prefix + ' 状态待确认，队列已暂停';
  return prefix + ' · ' + stage;
}

function renderLogs() {
  var logBody = document.getElementById('log-body');
  if (!logBody) return;

  var logs = logLevelFilter === 'all'
    ? latestLogs
    : latestLogs.filter(function(l) { return l.level === logLevelFilter; });

  if (!latestLogs.length) {
    logBody.innerHTML = '<div class="log-empty"><p>暂无日志</p><p style="font-size:10px;color:var(--t3)">生成任务后显示运行记录</p></div>';
  } else if (!logs.length) {
    var label = LOG_LEVEL_LABEL[logLevelFilter] || logLevelFilter.toUpperCase();
    logBody.innerHTML = '<div class="log-empty"><p>暂无 ' + label + ' 日志</p></div>';
  } else {
    logBody.innerHTML = logs.map(function(l) {
      var label = LOG_LEVEL_LABEL[l.level] || l.level.toUpperCase();
      var rawMessage = String(l.message || '');
      var displayMessage = formatTaskLogMessage(rawMessage);
      return '<div class="log-entry" title="' + escapeHtml(rawMessage) + '"><span class="log-time">' + escapeHtml(l.time || '--:--:--') + '</span><span class="log-level log-lv-' + l.level + '">' + label + '</span><span class="log-source">[' + escapeHtml(l.source || '') + ']</span><span>' + escapeHtml(displayMessage) + '</span></div>';
    }).join('');
  }

  // 固定模式：不自动滚动到底部，恢复高亮和横幅
  if (logPinned && pinnedTaskId) {
    // 恢复 pin banner
    var banner = document.getElementById('log-pin-banner');
    if (!banner) showPinBanner();
    // 恢复高亮
    var entries = document.querySelectorAll('.log-entry');
    if (pinnedLogIndex >= 0 && pinnedLogIndex < entries.length) {
      entries[pinnedLogIndex].classList.add('focused-task-log');
    }
  } else {
    // 普通模式：自动滚动到底部
    logBody.scrollTop = logBody.scrollHeight;
  }
}

// ===== 任务排序 =====
function setTaskSort(sortKey) {
  taskSort = sortKey;
  try { localStorage.setItem('taskSort', sortKey); } catch(e) {}
  // 重渲染
  const batch = window.__currentBatch;
  if (batch) { batch._taskPage = 1; renderBatch(batch); }
}
function applyTaskSort(tasks, isScan) {
  // 默认排序：按 order 字段升序（scan preview 任务无 order 字段时保持原位）
  if (taskSort === 'default') {
    return [...tasks].sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || ((a.order != null ? 0 : 1) - (b.order != null ? 0 : 1)));
  }
  const arr = [...tasks];
  const cmp = (a, b, getter) => {
    const va = getter(a), vb = getter(b);
    if (va === vb) return 0;
    if (va == null || va === '' || va === '—') return 1;
    if (vb == null || vb === '' || vb === '—') return -1;
    return typeof va === 'string' ? va.localeCompare(vb, undefined, {numeric:true}) : va - vb;
  };
  const statusOrder = {error:0,failed:1,running:2,processing:3,active:3,pending:4,queued:5,waiting:5,completed:6,done:6,success:6,interrupted:7,cancelled:7};
  const getStatus = t => statusOrder[(t.executionStatus||t.status||'').toLowerCase()] ?? 99;
  const getDE = t => t.deltaE || null;
  const getTime = t => t.elapsedMs || null;
  const getTpl = t => (t.templateNameWithoutExt || t.template || t.templateName || '').toLowerCase();
  const getClr = t => (t.colorNameWithoutExt || t.colorRef || t.colorName || '').toLowerCase();

  const asc = !taskSort.endsWith('-desc');
  const key = taskSort.replace('-desc','').replace('-asc','');
  let fn;
  switch(key) {
    case 'name': fn = t => getTpl(t); break;
    case 'color': fn = t => getClr(t); break;
    case 'status': fn = t => getStatus(t); break;
    case 'de': fn = t => getDE(t); break;
    case 'time': fn = t => getTime(t); break;
    default: return arr;
  }
  arr.sort((a,b) => { const r = cmp(a,b,fn); return asc ? r : -r; });
  return arr;
}

// ===== 列宽拖拽 =====
function loadColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem('taskTableColumnWidths') || '{}');
    for (const [k,v] of Object.entries(saved)) {
      if (DEFAULT_COL_WIDTHS[k] != null && typeof v === 'number') DEFAULT_COL_WIDTHS[k] = v;
    }
  } catch(e) {}
}
function saveColumnWidths() { try { localStorage.setItem('taskTableColumnWidths', JSON.stringify(DEFAULT_COL_WIDTHS)); } catch(e) {} }
function resetColumnWidths() {
  const def = { select:36, thumb:120, name:140, status:64, progress:110, color:70, actions:130 };
  Object.assign(DEFAULT_COL_WIDTHS, def);
  try { localStorage.removeItem('taskTableColumnWidths'); } catch(e) {}
  updateColCSS();
  toast('已恢复默认列宽');
}
function updateColCSS() {
  const w = DEFAULT_COL_WIDTHS;
  const root = document.documentElement.style;
  root.setProperty('--col-select', w.select+'px');
  root.setProperty('--col-thumb', w.thumb+'px');
  root.setProperty('--col-name', w.name+'px');
  root.setProperty('--col-status', w.status+'px');
  root.setProperty('--col-progress', w.progress+'px');
  root.setProperty('--col-color', w.color+'px');
  root.setProperty('--col-actions', w.actions+'px');
}
function initTableColumnResize() {
  const head = document.querySelector('.task-table-head');
  if (!head || head.dataset.resizeReady) return;
  head.dataset.resizeReady = '1';
  const MIN = { select:28, thumb:96, name:80, status:48, progress:60, color:48, actions:100 };
  const MAX = 420;
  let dragging = null, startX = 0, startW = 0;

  head.addEventListener('mousedown', e => {
    const col = e.target.closest('.tth-col');
    if (!col) return;
    const rect = col.getBoundingClientRect();
    if (e.clientX < rect.right - 6) return;
    e.preventDefault();
    const colClass = [...col.classList].find(c=>c.startsWith('tth-')&&c!=='tth-col');
    if (!colClass) return;
    const key = colClass === 'tth-cb' ? 'select' : colClass === 'tth-name' ? 'name' :
      colClass === 'tth-thumb' ? 'thumb' : colClass === 'tth-color' ? 'color' :
      colClass === 'tth-status' ? 'status' : colClass === 'tth-progress' ? 'progress' :
      colClass === 'tth-actions' ? 'actions' : null;
    if (!key) return;
    dragging = key; startX = e.clientX; startW = DEFAULT_COL_WIDTHS[key] || 100;
    col.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    let w = Math.max(MIN[dragging]||40, Math.min(MAX, startW + delta));
    DEFAULT_COL_WIDTHS[dragging] = Math.round(w);
    updateColCSS();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    document.querySelectorAll('.tth-col.resizing').forEach(c=>c.classList.remove('resizing'));
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveColumnWidths();
    dragging = null;
  });
}

// ===== 错误日志定位 =====
function focusTaskErrorLog(task, event) {
  if (event) event.stopPropagation();
  var tplName = (task.templateNameWithoutExt || task.template || '').toLowerCase();
  var clrName = (task.colorNameWithoutExt || task.colorRef || '').toLowerCase();
  var taskId = (task.id || '').toLowerCase();

  // 切换到 ERROR 筛选（方便看到错误日志）
  logLevelFilter = 'error';
  document.querySelectorAll('.log-filter-btn').forEach(function(b) { b.classList.toggle('active', b.classList.contains('log-filter-error')); });
  renderLogs();

  // 查找匹配日志
  setTimeout(function() {
    var entries = document.querySelectorAll('.log-entry');
    var target = null;
    var bestScore = 0;

    for (var i = 0; i < entries.length; i++) {
      var text = entries[i].textContent.toLowerCase();
      var score = 0;
      // 优先级1: taskId 精确匹配
      if (taskId && text.indexOf(taskId) >= 0) score = 100;
      // 优先级2: 模板名+颜色名
      else if (tplName && clrName && text.indexOf(tplName) >= 0 && text.indexOf(clrName) >= 0) score = 50;
      // 优先级3: 模板名
      else if (tplName && text.indexOf(tplName) >= 0) score = 30;
      // 优先级4: 错误信息
      else if (task.error && text.indexOf(task.error.toLowerCase().slice(0, 20)) >= 0) score = 20;
      // 优先级5: 颜色名
      else if (clrName && text.indexOf(clrName) >= 0) score = 10;

      if (score > bestScore) { bestScore = score; target = entries[i]; pinnedLogIndex = i; }
    }

    if (target) {
      // 设置固定状态
      logPinned = true;
      pinnedTaskId = task.id;
      target.classList.add('focused-task-log');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showPinBanner();
    } else {
      // 找不到日志
      unpinTaskLog();
      toast('未找到该任务的对应日志', 'wn');
    }
  }, 150);
}

function unpinTaskLog() {
  logPinned = false;
  pinnedTaskId = null;
  pinnedLogIndex = -1;
  // 移除所有高亮
  document.querySelectorAll('.log-entry.focused-task-log').forEach(function(el) { el.classList.remove('focused-task-log'); });
  // 移除固定横幅
  var banner = document.getElementById('log-pin-banner');
  if (banner) banner.remove();
}

function showPinBanner() {
  var logBody = document.getElementById('log-body');
  if (!logBody) return;
  var existing = document.getElementById('log-pin-banner');
  if (existing) existing.remove();
  var banner = document.createElement('div');
  banner.id = 'log-pin-banner';
  banner.className = 'log-pin-banner';
  banner.innerHTML = '📌 已固定：任务 ' + escapeHtml(pinnedTaskId || '').slice(0, 20)
    + ' <button onclick="unpinTaskLog();renderLogs()" style="margin-left:8px;background:var(--cd);border:1px solid var(--bd);color:var(--tx);border-radius:3px;padding:1px 8px;cursor:pointer;font-size:10px">取消固定</button>';
  if (logBody.firstChild) {
    logBody.insertBefore(banner, logBody.firstChild);
  } else {
    logBody.appendChild(banner);
  }
}

function startLogAutoRefresh() {
  if (logRefreshTimer) return;
  logRefreshTimer = setInterval(fetchLogs, 5000);
}

function stopLogAutoRefresh() {
  if (logRefreshTimer) { clearInterval(logRefreshTimer); logRefreshTimer = null; }
}

// ===== 任务状态筛选 =====
const FILTER_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'done', label: '已生成' },
  { key: 'running', label: '生成中' },
  { key: 'failed', label: '失败' }
];

function setTaskFilter(key) {
  taskFilter = key;
  renderFilterBar();
  // 重新渲染任务列表
  const batch = window.__currentBatch;
  if (batch) {
    batch._taskPage = 1;
    renderBatch(batch);
  } else if (scanPairs && scanPairs.length) {
    renderScanPreviewFromScan(scanData || { pairs: scanPairs });
  }
}

function renderFilterBar() {
  const headerBar = document.querySelector('.task-table-header-bar');
  if (!headerBar) return;

  // 移除已有筛选栏
  const existing = headerBar.querySelector('.task-filter-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.className = 'task-filter-bar';

  // 搜索框
  const searchHtml = `<div class="task-search-wrap search">
    <input type="text" class="task-search-input" placeholder="搜索模板名 / 颜色名 / 状态"
      value="${escapeHtml(taskSearchQuery)}"
      oninput="setTaskSearch(this.value)"
    ><span class="task-search-icon" aria-hidden="true"><i class="ph-duotone ph-magnifying-glass"></i></span>
  </div>`;

  // 筛选按钮
  const btnsHtml = FILTER_OPTIONS.map(f =>
    `<button class="filter-btn filter ${taskFilter === f.key ? 'active' : ''}" onclick="setTaskFilter('${f.key}')">${f.label}</button>`
  ).join('');

  // 排序下拉（仅保留颜色、时间、文件名）
  const sortOpts = [
    {v:'default',t:'▸ 默认排序'},
    {v:'name-asc',t:'▲ 文件名升序'},{v:'name-desc',t:'▼ 文件名降序'},
    {v:'color-asc',t:'▲ 颜色升序'},{v:'color-desc',t:'▼ 颜色降序'},
    {v:'time-asc',t:'▲ 耗时升序'},{v:'time-desc',t:'▼ 耗时降序'}
  ];
  const sortHtml = `<div class="task-sort-wrap sort">
    <select class="task-sort-select" onchange="setTaskSort(this.value)">
      ${sortOpts.map(o => `<option value="${o.v}" ${taskSort===o.v?'selected':''}>${o.t}</option>`).join('')}
    </select>
  </div>`;

  // 列宽恢复按钮
  const resetColsHtml = `<button class="ttb-reset-cols" onclick="resetColumnWidths()" title="恢复默认列宽"><i class="ph-duotone ph-arrows-left-right" aria-hidden="true"></i></button>`;

  bar.innerHTML = searchHtml + sortHtml + `<div class="task-filter-btns filters">${btnsHtml}</div>` + resetColsHtml;
  headerBar.appendChild(bar);
}

function setTaskSearch(query) {
  taskSearchQuery = query.trim();
  // 重新渲染任务列表（不重建搜索框，避免输入光标跳动）
  const batch = window.__currentBatch;
  if (batch) {
    batch._taskPage = 1;
    renderBatch(batch);
  } else if (scanPairs && scanPairs.length) {
    renderScanPreviewFromScan(scanData || { pairs: scanPairs });
  }
}

function taskMatchesSearch(task, isScan) {
  if (!taskSearchQuery) return true;
  var q = taskSearchQuery.toLowerCase();
  if (isScan) {
    // 扫描预览任务：模板名、颜色名、状态文字"待生成"
    var tpl = (task.templateName || task.templateNameWithoutExt || '').toLowerCase();
    var clr = (task.colorName || task.colorNameWithoutExt || '').toLowerCase();
    if (tpl.indexOf(q) >= 0 || clr.indexOf(q) >= 0 || '待生成'.indexOf(q) >= 0) return true;
  } else {
    // 真实 batch 任务：匹配 模板名/颜色名/状态标签/任务ID/输出文件名/错误信息
    var tpl = (task.template || task.templateName || task.templateNameWithoutExt || '').toLowerCase();
    var clr = (task.colorRef || task.colorName || task.colorNameWithoutExt || '').toLowerCase();
    var out = (task.output || task.outputPath || '').toLowerCase();
    var err = (task.error || task.errorMessage || '').toLowerCase();
    var tid = (task.id || '').toLowerCase();
    var ns = normalizeTaskStatus(task);
    var statusLabels = { pending:'待生成', running:'生成中', completed:'已完成', done:'已完成', success:'已完成', finished:'已完成', failed:'失败', error:'失败', cancelled:'已取消', canceled:'已取消', stopped:'已取消', interrupted:'已中断' };
    var label = statusLabels[ns] || ns;
    // 检查所有字段
    if (tpl.indexOf(q) >= 0) return true;
    if (clr.indexOf(q) >= 0) return true;
    if (out.indexOf(q) >= 0) return true;
    if (err.indexOf(q) >= 0) return true;
    if (tid.indexOf(q) >= 0) return true;
    if (label.indexOf(q) >= 0) return true;
  }
  return false;
}

function filterBySearch(tasks, isScan) {
  if (!taskSearchQuery) return tasks;
  return tasks.filter(t => taskMatchesSearch(t, isScan));
}

function filterByStatus(tasksOrPairs, isScan) {
  if (taskFilter === 'all') return tasksOrPairs;
  return tasksOrPairs.filter(function(t) {
    if (isScan) return taskFilter === 'pending';
    var ns = normalizeTaskStatus(t);
    switch (taskFilter) {
      case 'pending': return ['pending','queued','scan-pending'].indexOf(ns) >= 0;
      case 'running': return ['running','generating','processing'].indexOf(ns) >= 0;
      case 'done': return ['completed','done','success','finished'].indexOf(ns) >= 0;
      case 'failed': return ['failed','error'].indexOf(ns) >= 0;
      case 'cancelled': return ['cancelled','canceled','stopped'].indexOf(ns) >= 0;
      case 'interrupted': return ['interrupted'].indexOf(ns) >= 0;
      default: return true;
    }
  });
}

function toggleSidebarLayoutMenu(event) {
  event?.stopPropagation();
  const menu = document.getElementById('sidebar-layout-menu');
  const trigger = document.getElementById('layout-menu-trigger');
  if (!menu) return;
  menu.hidden = !menu.hidden;
  trigger?.setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) updateSidebarLayoutMenu();
}

function closeSidebarLayoutMenu() {
  const menu = document.getElementById('sidebar-layout-menu');
  const trigger = document.getElementById('layout-menu-trigger');
  if (!menu) return;
  menu.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
}

function getSidebarLayoutState() {
  return {
    leftCollapsed: document.getElementById('app-shell')?.classList.contains('left-sidebar-collapsed') || false,
    rightCollapsed: document.getElementById('app-shell')?.classList.contains('right-sidebar-collapsed') || false
  };
}

function saveSidebarLayoutState() {
  try { localStorage.setItem('lavans.sidebarLayout', JSON.stringify(getSidebarLayoutState())); } catch (_error) {}
}

function updateSidebarLayoutMenu() {
  const state = getSidebarLayoutState();
  const left = document.getElementById('layout-left-toggle');
  const right = document.getElementById('layout-right-toggle');
  if (left) left.querySelector('span').textContent = state.leftCollapsed ? '展开左侧边栏' : '收起左侧边栏';
  if (right) right.querySelector('span').textContent = state.rightCollapsed ? '展开右侧边栏' : '收起右侧边栏';
}

function setLeftSidebarCollapsed(collapsed) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  shell.classList.toggle('left-sidebar-collapsed', Boolean(collapsed));
  document.body?.classList.toggle('left-sidebar-collapsed', Boolean(collapsed));
  saveSidebarLayoutState();
  updateSidebarLayoutMenu();
}

function setRightSidebarCollapsed(collapsed) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  shell.classList.toggle('right-sidebar-collapsed', Boolean(collapsed));
  document.body?.classList.toggle('right-sidebar-collapsed', Boolean(collapsed));
  const railButton = document.getElementById('rail-inspector');
  if (railButton) {
    railButton.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
    railButton.classList.toggle('active', !collapsed);
  }
  saveSidebarLayoutState();
  updateSidebarLayoutMenu();
}

function restoreLeftSidebar() {
  // 已禁用：复色左侧栏始终显示，不再支持展开
  return;
}

function restoreRightSidebar() {
  setRightSidebarCollapsed(false);
}

function toggleLeftSidebar() {
  // 已禁用：复色左侧栏不再支持折叠/展开，始终显示
  return;
}

function toggleRightSidebar() {
  const state = getSidebarLayoutState();
  setRightSidebarCollapsed(!state.rightCollapsed);
}

function restoreBothSidebars() {
  setLeftSidebarCollapsed(false);
  setRightSidebarCollapsed(false);
  closeSidebarLayoutMenu();
}

function restoreSidebarLayoutState() {
  let state = {};
  try { state = JSON.parse(localStorage.getItem('lavans.sidebarLayout') || '{}'); } catch (_error) {}
  // 复色左侧栏始终显示（已禁用折叠），忽略 localStorage 里的 leftCollapsed
  setLeftSidebarCollapsed(false);
  setRightSidebarCollapsed(Boolean(state.rightCollapsed));
}

function initSidebarLayoutControls() {
  document.addEventListener('click', event => {
    if (!event.target.closest('.layout-menu-wrap')) closeSidebarLayoutMenu();
  });
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || !event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'r') { event.preventDefault(); toggleRightSidebar(); }
    if (key === 'b') { event.preventDefault(); restoreBothSidebars(); }
  });
  restoreSidebarLayoutState();
}

window.addEventListener('load', async () => {
  applyActiveSystemShell();
  initSidebarLayoutControls();
  setStatus('bs', '恢复数据中');
  await initWindowControls();
  await PersistentStore.init();
  await restoreBrowserState();
  const hasBatch = await restoreLatestBatch();
  updateScanButton();
  // 恢复自定义单价
  try { userApiPriceFen = parseInt(localStorage.getItem('userApiPriceFen'), 10) || 0; } catch(e) {}
  try { userDiscountRate = parseInt(localStorage.getItem('userDiscountRate'), 10) || 0; } catch(e) {}
  try { userTaxRate = parseInt(localStorage.getItem('userTaxRate'), 10) || 0; } catch(e) {}
  // 恢复复色生成参数（Provider/模型/尺寸/质量/数量）
  try { recolorProviderId = localStorage.getItem('recolor_provider') || recolorProviderId; } catch(e) {}
  try { recolorModel = localStorage.getItem('recolor_model') || ''; } catch(e) {}
  try { const s = localStorage.getItem('recolor_size'); if (s && ['1024x1024','1536x1536','2048x2048'].includes(s)) recolorSize = s; } catch(e) {}
  try { const q = localStorage.getItem('recolor_quality'); if (q && ['low','medium','high'].includes(q)) recolorQuality = q; } catch(e) {}
  try { recolorQuantity = parseInt(localStorage.getItem('recolor_quantity'), 10) || 0; } catch(e) {}
  try { recolorConcurrency = Math.min(8, Math.max(3, parseInt(localStorage.getItem('recolor_concurrency'), 10) || 8)); } catch(e) {}
  if (!hasBatch) setStatus('ok', '就绪');
  const info = await PersistentStore.getStorageInfo();
  if (info.quota) $('store-info').textContent = `浏览器存储 ${info.used} / ${info.quota}`;
  // 加载真实日志与筛选栏
  fetchLogs();
  renderFilterBar();
  await loadThemePreference();
  await loadPromptProfiles();
  initPromptPanel();
  initImageViewer();
  initCompareSlider();
  updateRailAvailability(window.__currentBatch?.tasks || []);
  const initialSystem = new URLSearchParams(window.location.search).get('system');
  const initialMode = new URLSearchParams(window.location.search).get('mode');
  if (initialSystem === 'canvas' || new URLSearchParams(window.location.search).get('mode') === 'canvas') renderCanvasStudio();
  if (initialMode === 'recolor' || initialSystem === 'recolor') {
    // 明确回到一键复色：退出可能残留的 creative/canvas 模式，确保复色工作区正确渲染
    const recolorMain = document.getElementById('workspace-main');
    if (recolorMain && recolorMain.classList.contains('creative-mode-active') && typeof exitCreativeMode === 'function') exitCreativeMode();
    if (recolorMain && recolorMain.classList.contains('canvas-studio-active') && typeof canvasStudioExit === 'function') canvasStudioExit();
    if (typeof switchToRecolorMode === 'function') switchToRecolorMode();
  }
  if (window.location.hash === '#settings') setTimeout(() => openApiConfig(), 0);
  // 恢复列宽和排序
  loadColumnWidths();
  updateColCSS();
  try { taskSort = localStorage.getItem('taskSort') || 'default'; } catch(e) {}
  // 初始化列宽拖拽
  keepSoftResetVisible();
  setTimeout(initTableColumnResize, 500);
});

// 回到顶部按钮滚动监听
window.addEventListener('scroll', updateBackTop, { passive: true });
updateBackTop();

// ===== 粘贴上传支持 =====
document.addEventListener('paste', function(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const type = uploadPasteTarget;
      if (type === 'color') chooseReferenceUploadMode([file], '已粘贴');
      else addFiles(type, [file]);
      break;
    }
  }
});

window.addEventListener('beforeunload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

// ===== 提示词设置面板 =====
function defaultPromptProfiles() {
  return [
    { id: 'bedding', name: '床品', prompt: PROMPT_PRESETS.recolor, builtIn: true },
    { id: 'clothing', name: '衣服', prompt: CLOTHING_PROMPT, builtIn: true }
  ];
}
async function loadPromptProfiles() {
  try {
    const result = await api('/api/config');
    if (result.success && Array.isArray(result.config?.promptProfiles)) {
      promptProfiles = result.config.promptProfiles;
      selectedPromptProfileId = result.config.selectedPromptProfileId || 'bedding';
    }
  } catch (error) { console.warn('提示词类型加载失败:', error); }
  if (!promptProfiles.length) promptProfiles = defaultPromptProfiles();
  applySelectedPromptProfile();
}
function getSelectedPromptProfile() {
  return promptProfiles.find(item => item.id === selectedPromptProfileId) || promptProfiles[0] || null;
}
function getActiveGenerationPrompt() {
  return getSelectedPromptProfile()?.prompt || document.getElementById('user-prompt')?.value.trim() || '';
}
function updatePromptProfileStatus(message, type = 'ok') {
  const status = document.getElementById('prompt-profile-status');
  if (!status) return;
  status.textContent = message;
  status.className = `prompt-profile-status ${type}`;
}
function updateHomePromptTypeBadge() {
  const profile = getSelectedPromptProfile();
  const label = profile?.name || '未选择';
  const profileId = profile?.id || '';
  const targets = [
    ['home-prompt-type-badge', 'home-prompt-type-name'],
    ['empty-prompt-watermark', 'empty-prompt-type-name']
  ];
  targets.forEach(([badgeId, nameId]) => {
    const badge = document.getElementById(badgeId);
    const name = document.getElementById(nameId);
    if (!badge || !name) return;
    name.textContent = label;
    badge.dataset.profileId = profileId;
    badge.title = `当前提示词类型：${label}。点击切换类型`;
  });
}
function applySelectedPromptProfile() {
  const profile = getSelectedPromptProfile();
  const input = document.getElementById('user-prompt');
  if (profile && input) input.value = profile.prompt;
  const activeLabel = document.getElementById('prompt-active-label');
  if (activeLabel) activeLabel.textContent = profile ? '当前生效：'+profile.name : '新建提示词类型';
  updateHomePromptTypeBadge();
  if (profile) updatePromptProfileStatus(promptProfileEffectiveMessage(profile.name), 'ok');
}
function promptProfileEffectiveMessage(name) {
  return window.__currentBatch?.active
    ? `已保存“${name}”；当前批次保持锁定，下一批生效`
    : `已启用“${name}”，下一次生成生效`;
}
function renderPromptProfileOptions() {
  return promptProfiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selectedPromptProfileId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
}
function renderPromptProfileItems() {
  var icons = { bedding:'▱', clothing:'◇' };
  return promptProfiles.map(function(item) {
    return '<button type="button" class="prompt-profile-item '+(item.id === selectedPromptProfileId ? 'active' : '')+'" onclick="selectPromptProfile(\''+escapeHtml(item.id).replace(/'/g,'&#39;')+'\')"><span class="prompt-profile-item-icon">'+(icons[item.id] || '✦')+'</span><span>'+escapeHtml(item.name)+'</span>'+(item.id === selectedPromptProfileId?'<small>当前</small>':'')+'</button>';
  }).join('');
}
function selectPromptProfile(profileId) {
  const profile = promptProfiles.find(item => item.id === profileId);
  if (!profile) return;
  selectedPromptProfileId = profile.id;
  document.getElementById('prompt-profile-name').value = profile.name;
  document.getElementById('prompt-profile-text').value = profile.prompt;
  var mainCount = document.getElementById('prompt-main-count');
  if (mainCount) mainCount.textContent = profile.prompt.length+' / 4000';
  var nameCount = document.getElementById('prompt-name-count');
  if (nameCount) nameCount.textContent = profile.name.length+' / 40';
  document.getElementById('delete-prompt-profile').style.display = profile.builtIn ? 'none' : 'inline-flex';
  var items = document.getElementById('prompt-profile-items');
  if (items) items.innerHTML = renderPromptProfileItems();
  applySelectedPromptProfile();
  updatePromptProfileStatus(promptProfileEffectiveMessage(profile.name), 'ok');
  savePromptProfiles(false).then(saved => {
    if (saved) updatePromptProfileStatus(promptProfileEffectiveMessage(profile.name)+'，选择已保存', 'ok');
    else updatePromptProfileStatus(promptProfileEffectiveMessage(profile.name)+'；保存失败请稍后重试', 'wn');
  });
}
function startNewPromptProfile() {
  selectedPromptProfileId = '';
  var select = document.getElementById('prompt-profile-select');
  if (select) select.value = '';
  var items = document.getElementById('prompt-profile-items');
  if (items) items.innerHTML = renderPromptProfileItems();
  document.getElementById('prompt-profile-name').value = '';
  document.getElementById('prompt-profile-text').value = '';
  document.getElementById('delete-prompt-profile').style.display = 'none';
  document.getElementById('prompt-profile-name').focus();
}
async function savePromptProfiles(showMessage = true) {
  const result = await api('/api/config', { promptProfiles, selectedPromptProfileId });
  if (!result.success) { if (showMessage) toast(result.error || '提示词类型保存失败', 'ng'); return false; }
  promptProfiles = result.config.promptProfiles || promptProfiles;
  selectedPromptProfileId = result.config.selectedPromptProfileId || selectedPromptProfileId;
  applySelectedPromptProfile();
  if (showMessage) toast('提示词类型已保存，后续可直接选择', 'ok');
  return true;
}
async function savePromptProfileFromForm() {
  const name = (document.getElementById('prompt-profile-name').value || '').trim();
  const prompt = (document.getElementById('prompt-profile-text').value || '').trim();
  if (!name) return toast('请输入类型名称', 'wn');
  if (!prompt) return toast('请输入该类型的提示词', 'wn');
  if (promptProfiles.some(item => item.name === name && item.id !== selectedPromptProfileId)) return toast('类型名称已存在，请换一个名称', 'wn');
  let profile = promptProfiles.find(item => item.id === selectedPromptProfileId);
  if (profile) { profile.name = name.slice(0, 40); profile.prompt = prompt.slice(0, 4000); }
  else { profile = { id: 'custom_' + Date.now().toString(36), name: name.slice(0, 40), prompt: prompt.slice(0, 4000), builtIn: false }; promptProfiles.push(profile); selectedPromptProfileId = profile.id; }
  if (await savePromptProfiles()) refreshPromptProfileForm();
}
async function deletePromptProfile() {
  const profile = getSelectedPromptProfile();
  if (!profile || profile.builtIn) return;
  if (!await askRecolorConfirmation({ danger:true, title:'删除提示词类型', subtitle:'内置类型不会被删除', facts:[{label:'类型名称',value:profile.name}], message:'删除后会自动切回“床品”类型。', confirmText:'确认删除' })) return;
  promptProfiles = promptProfiles.filter(item => item.id !== profile.id);
  selectedPromptProfileId = 'bedding';
  if (await savePromptProfiles()) refreshPromptProfileForm();
}
function refreshPromptProfileForm() {
  const select = document.getElementById('prompt-profile-select');
  const profile = getSelectedPromptProfile();
  if (!profile) return;
  if (select) { select.innerHTML = renderPromptProfileOptions(); select.value = profile.id; }
  var items = document.getElementById('prompt-profile-items');
  if (items) items.innerHTML = renderPromptProfileItems();
  document.getElementById('prompt-profile-name').value = profile.name;
  document.getElementById('prompt-profile-text').value = profile.prompt;
  var mainCount = document.getElementById('prompt-main-count');
  if (mainCount) mainCount.textContent = profile.prompt.length+' / 4000';
  var nameCount = document.getElementById('prompt-name-count');
  if (nameCount) nameCount.textContent = profile.name.length+' / 40';
  document.getElementById('delete-prompt-profile').style.display = profile.builtIn ? 'none' : 'inline-flex';
}
function initPromptPanel() {
  // 注入提示词设置按钮到底部操作栏
  const bottomBar = document.getElementById('bottom-actions');
  if (bottomBar && !document.getElementById('ba-prompt')) {
    const btn = document.createElement('button');
    btn.id = 'ba-prompt';
    btn.className = 'btn bs ba-btn icon-only';
    btn.style.cssText = 'order:-1';
    btn.innerHTML = '<span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.3h-3v-.08A1.7 1.7 0 0 0 10.66 18.66a1.7 1.7 0 0 0-1.88.34l-.06.06L6.6 16.94l.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.04h-.08v-3h.08A1.7 1.7 0 0 0 7 9.92a1.7 1.7 0 0 0-.34-1.88L6.6 7.98 8.72 5.86l.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.7 4.7v-.08h3v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19.4 9.92a1.7 1.7 0 0 0 1.56 1.04h.08v3h-.08A1.7 1.7 0 0 0 19.4 15z"></path></svg></span><span class="sr-only">提示词设置</span>';
    btn.title = '提示词设置';
    btn.setAttribute('aria-label', '提示词设置');
    btn.onclick = togglePromptPanel;
    bottomBar.insertBefore(btn, bottomBar.firstChild);
  }

  // 注入模态面板（如果还没有）
  if (!document.getElementById('prompt-modal')) {
    const modal = document.createElement('div');
    modal.id = 'prompt-modal';
    modal.className = 'prompt-modal-overlay';
    modal.style.display = 'none';
    modal.onclick = function(e) { if (e.target === modal) togglePromptPanel(); };
    modal.innerHTML = `
      <div class="prompt-modal-panel" role="dialog" aria-modal="true" aria-label="提示词设置" onclick="event.stopPropagation()">
        <header class="prompt-modal-header">
          <div class="prompt-modal-heading"><span class="prompt-modal-icon"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"></path><path d="M8 9h8M8 13h6"></path></svg></span></span><div><strong>提示词设置</strong><span id="prompt-active-label">当前生效：${escapeHtml(getSelectedPromptProfile()?.name || '未选择')}</span></div></div>
          <button class="prompt-modal-close" data-safe-focus onclick="togglePromptPanel()" title="关闭"><span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg></span></button>
        </header>
        <div class="prompt-modal-body">
          <aside class="prompt-profile-sidebar">
            <button type="button" class="prompt-profile-new" onclick="startNewPromptProfile()"><span>＋</span>新建类型</button>
            <div class="prompt-profile-caption">提示词类型</div>
            <div id="prompt-profile-items" class="prompt-profile-items">${renderPromptProfileItems()}</div>
          </aside>
          <main class="prompt-editor">
            <div class="prompt-locked-banner"><span class="ui-icon"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg></span><span>当前批次会继续使用已经锁定的内容；本次修改从下一批任务生效</span></div>
            <div id="prompt-profile-status" class="prompt-profile-status">选择类型后，将在下一次新建任务时生效</div>
            <label class="prompt-field"><span><strong>类型名称</strong><small id="prompt-name-count">最多 40 字</small></span><input id="prompt-profile-name" class="prompt-profile-control" maxlength="40" value="${escapeHtml(getSelectedPromptProfile()?.name || '')}" placeholder="例如：鞋子、窗帘、箱包" oninput="document.getElementById('prompt-name-count').textContent=this.value.length+' / 40'"></label>
            <label class="prompt-field"><span><strong>该类型的主提示词</strong><small id="prompt-main-count">${(getSelectedPromptProfile()?.prompt || '').length} / 4000</small></span><textarea id="prompt-profile-text" class="prompt-textarea prompt-profile-main" maxlength="4000" placeholder="填写该类型完整的改色提示词" oninput="document.getElementById('prompt-main-count').textContent=this.value.length+' / 4000'">${escapeHtml(getSelectedPromptProfile()?.prompt || '')}</textarea><em>主提示词长期保存；开始生成时与本批次附加要求一起锁定。</em></label>
            <label class="prompt-field"><span><strong>本批次附加要求（可选）</strong><small id="prompt-char-count">${extraPrompt.length} / 2000</small></span><textarea id="extra-prompt-input" class="prompt-textarea prompt-extra" maxlength="2000" placeholder="填写本次生成的额外要求；留空则只使用上面的类型主提示词。" oninput="extraPrompt=this.value;document.getElementById('prompt-char-count').textContent=this.value.length+' / 2000';persistStateOnly()">${escapeHtml(extraPrompt)}</textarea><em>整批结束后自动清空；运行中追加任务继续使用本批已经锁定的内容。</em></label>
          </main>
        </div>
        <footer class="prompt-modal-footer">
          <label class="prompt-price-editor"><span class="prompt-price-icon">¥</span><span><strong>下一批单价</strong><small id="prompt-price-hint">${userApiPriceFen ? '下一批按 '+money(userApiPriceFen)+' / 次锁定' : '使用系统默认价格'}</small></span><b>¥</b><input id="user-price-input" type="number" min="0" max="9999" step="0.01" value="${userApiPriceFen ? (userApiPriceFen/100).toFixed(2) : ''}" placeholder="默认" onchange="saveUserPriceFromYuan(this.value)"><em>/ 次</em></label>
          <button type="button" class="prompt-price-reset" onclick="restoreSystemUnitPrice()">使用系统默认</button>
          <span class="prompt-footer-spacer"></span>
          <button class="btn bd" id="delete-prompt-profile" onclick="deletePromptProfile()" style="display:${getSelectedPromptProfile()?.builtIn ? 'none' : 'inline-flex'}">删除类型</button>
          <button class="btn bs" onclick="restoreDefaultPrompt()">恢复床品要求</button>
          <button class="btn bs" onclick="clearExtraPrompt()">清空附加要求</button>
          <button class="btn lanvas-primary" onclick="savePromptProfileFromForm()">保存并设为当前</button>
        </footer>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') { event.preventDefault(); togglePromptPanel(); return; }
      trapRecolorFocus(event, modal.querySelector('.prompt-modal-panel'));
    });
  }
}

function togglePromptPanel() {
  const modal = document.getElementById('prompt-modal');
  if (!modal) return;
  const isOpen = modal.style.display !== 'none';
  if (isOpen) {
    modal.style.display = 'none';
    notifyRecolorModalState(false);
    var returnFocus = recolorModalReturnFocus;
    recolorModalReturnFocus = null;
    requestAnimationFrame(function() { returnFocus?.focus?.(); });
  } else {
    recolorModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    refreshPromptProfileForm();
    const activeProfile = getSelectedPromptProfile();
    if (activeProfile) updatePromptProfileStatus(promptProfileEffectiveMessage(activeProfile.name), 'ok');
    // 同步当前 extraPrompt 到输入框
    const input = document.getElementById('extra-prompt-input');
    if (input) {
      input.value = extraPrompt;
      document.getElementById('prompt-char-count').textContent = `${extraPrompt.length} / 2000`;
    }
    modal.style.display = 'flex';
    notifyRecolorModalState(true);
    focusRecolorModal(modal);
  }
}

function clearExtraPrompt() {
  extraPrompt = '';
  const input = document.getElementById('extra-prompt-input');
  if (input) input.value = '';
  document.getElementById('prompt-char-count').textContent = '0 / 2000';
  persistStateOnly();
}

function restoreDefaultPrompt() {
  extraPrompt = EXTRA_PROMPT_DEFAULT;
  const input = document.getElementById('extra-prompt-input');
  if (input) input.value = extraPrompt;
  document.getElementById('prompt-char-count').textContent = `${extraPrompt.length} / 2000`;
  persistStateOnly();
}

function saveUserPriceFromYuan(value) {
  var text = String(value ?? '').trim();
  var yuan = text === '' ? 0 : Number(text);
  if (!Number.isFinite(yuan) || yuan < 0 || yuan > 9999) return toast('请输入有效的元/次单价', 'wn');
  userApiPriceFen = Math.round(yuan * 100);
  try { localStorage.setItem('userApiPriceFen', String(userApiPriceFen)); } catch (error) {}
  var hint = document.getElementById('prompt-price-hint');
  if (hint) hint.textContent = userApiPriceFen ? '下一批按 '+money(userApiPriceFen)+' / 次锁定' : '下一批使用系统默认价格';
  updateBatch(window.__currentBatch || { tasks:[], totals:{}, status:'empty' });
}

function restoreSystemUnitPrice() {
  userApiPriceFen = 0;
  try { localStorage.removeItem('userApiPriceFen'); } catch (error) {}
  var input = document.getElementById('user-price-input');
  if (input) input.value = '';
  saveUserPriceFromYuan('');
  toast('已恢复系统默认单价', 'ok');
}

// ===== 图片放大预览 =====
function initImageViewer() {
  if (document.getElementById('img-viewer-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'img-viewer-modal';
  modal.className = 'img-viewer-overlay';
  modal.style.display = 'none'; // 默认关闭
  modal.onclick = closeImagePreview;
  modal.innerHTML = `
    <div class="img-viewer-panel compare-modal" role="dialog" aria-modal="true" aria-label="图片对比" onclick="event.stopPropagation()">
      <div class="img-viewer-header modal-top">
        <div class="img-viewer-heading"><span class="img-viewer-title" id="img-viewer-title">三图对比</span><span class="img-viewer-filename" id="img-viewer-filename"></span></div>
        <div class="img-viewer-tools"><span class="img-viewer-zoom">滚轮缩放 · 左右方向键切换</span>
        <button class="img-viewer-close" data-safe-focus onclick="closeImagePreview()" title="关闭" aria-label="关闭"><span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg></span></button>
        </div>
      </div>
      <div class="img-viewer-body" id="img-viewer-body">
        <img id="img-viewer-image" alt="预览" style="display:none" />
        <div id="rv-wrapper" class="rv-wrapper" style="display:none">
          <div id="rv-container" class="rv-container">
            <button id="rv-prev" class="img-viewer-nav prev" onclick="navigateRowPreview(-1)" title="上一个任务"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"></path></svg></span></button>
            <div id="rv-row" class="rv-row tri-grid">
              <figure class="rv-slot tri-card"><figcaption><strong>模板图</strong></figcaption><div class="rv-image-stage"><img id="rv-tpl" src="" alt="模板图" /></div></figure>
              <figure class="rv-slot tri-card result"><figcaption><strong>生成图</strong></figcaption><div class="rv-image-stage"><img id="rv-out" src="" alt="生成图" /></div></figure>
              <figure class="rv-slot tri-card"><figcaption><strong>参考色图</strong></figcaption><div class="rv-image-stage"><img id="rv-ref" src="" alt="参考色图" /></div></figure>
            </div>
            <button id="rv-next" class="img-viewer-nav next" onclick="navigateRowPreview(1)" title="下一个任务"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"></path></svg></span></button>
          </div>
          <footer class="rv-footer compare-actions"><button id="rv-download-btn" class="btn bs" type="button" onclick="event.stopPropagation();downloadCurrentRowPreview()"><span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path></svg></span>下载生成图</button><div id="rv-retry" class="rv-retry" style="display:none"><span id="rv-retry-status" style="display:none">排队中…</span><button id="rv-retry-btn" class="btn lanvas-primary" onclick="event.stopPropagation();clickRvRetry()"><i class="ph-duotone ph-arrow-clockwise" aria-hidden="true"></i>重做</button></div></footer>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  var zoomContainer = modal.querySelector('#rv-container');
  if (zoomContainer) zoomContainer.addEventListener('wheel', function(event) {
    if (document.getElementById('rv-wrapper')?.style.display === 'none') return;
    event.preventDefault();
    __rvZoom = Math.max(1, Math.min(4, __rvZoom + (event.deltaY < 0 ? .2 : -.2)));
    applyRowPreviewZoom();
  }, { passive:false });

  // ESC 关闭 / 左右箭头切换
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeImagePreview(); return; }
    if (e.key === 'ArrowLeft' && document.getElementById('rv-prev')?.style.visibility !== 'hidden') navigateRowPreview(-1);
    if (e.key === 'ArrowRight' && document.getElementById('rv-next')?.style.visibility !== 'hidden') navigateRowPreview(1);
  });
}

function openImagePreview(src, title, filename) {
  // 严格校验：拒绝空值、空字符串、特殊协议
  if (!src || typeof src !== 'string' || !src.trim() || src.startsWith('about:') || src.startsWith('data:,')) return;
  const modal = document.getElementById('img-viewer-modal');
  if (!modal) return;
  modal.querySelector('.img-viewer-panel')?.classList.add('single-image');
  // 单图模式：隐藏行预览容器，显示单图
  const rv = document.getElementById('rv-wrapper');
  const img = document.getElementById('img-viewer-image');
  if (rv) rv.style.display = 'none';
  if (img) { img.style.display = 'block'; img.src = src; }
  document.getElementById('img-viewer-title').textContent = title || '预览';
  document.getElementById('img-viewer-filename').textContent = filename || '';
  recolorModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  notifyRecolorModalState(true);
  focusRecolorModal(modal);
}

// ===== 三图并排行预览 + 左右切换 =====
let __rvIndex = -1;
let __rvRows = [];
let __rvZoom = 1;

function applyRowPreviewZoom() {
  ['rv-tpl','rv-out','rv-ref'].forEach(function(id) {
    var image = document.getElementById(id);
    if (image) image.style.transform = 'scale('+__rvZoom+')';
  });
  var filename = document.getElementById('img-viewer-filename');
  if (filename && __rvZoom > 1) filename.textContent = '滚轮缩放 · '+Math.round(__rvZoom * 100)+'%';
}

function openImageRowPreview(el) {
  if (!el) return;
  const row = el.closest('.task-row');
  if (!row) return;
  __rvRows = Array.from(document.querySelectorAll('.task-row')).filter(function(r) {
    return r.dataset.task && r.dataset.batch && r.querySelectorAll('.task-thumb img').length >= 1;
  });
  __rvIndex = __rvRows.indexOf(row);
  if (__rvIndex < 0) __rvIndex = 0;
  loadRowPreview(__rvIndex);
  const modal = document.getElementById('img-viewer-modal');
  if (!modal) return;
  modal.querySelector('.img-viewer-panel')?.classList.remove('single-image');
  // 行预览模式：显示行容器，隐藏单图
  const rv = document.getElementById('rv-wrapper');
  const img = document.getElementById('img-viewer-image');
  if (rv) rv.style.display = 'grid';
  if (img) img.style.display = 'none';
  recolorModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  notifyRecolorModalState(true);
  focusRecolorModal(modal);
}

function loadRowPreview(index) {
  __rvZoom = 1;
  applyRowPreviewZoom();
  if (index < 0 || index >= __rvRows.length) return;
  var row = __rvRows[index];
  var imgs = row.querySelectorAll('.task-thumb img');
  var getSrc = function(i) {
    if (!imgs[i]) return '';
    var s = imgs[i].src || '';
    return s && !s.startsWith('data:,') ? s : '';
  };
  // 正式任务列表只显示模板图与生成图；全屏三图直接读任务数据，
  // 不再依赖旧的“隐藏参考图列”的 DOM 顺序。
  document.getElementById('rv-tpl').src = getSrc(0);
  document.getElementById('rv-out').src = getSrc(1);
  document.getElementById('rv-ref').src = row.dataset.referenceUrl || '';
  var tplName = row.dataset.tpl || '';
  var clrName = row.dataset.clr || '';
  var shortId = row.dataset.shortId || '';
  document.getElementById('img-viewer-title').textContent = '三图对比';
  document.getElementById('img-viewer-filename').textContent = [tplName, clrName, shortId].filter(Boolean).join(' · ');
  var prev = document.getElementById('rv-prev');
  var next = document.getElementById('rv-next');
  if (prev) prev.style.visibility = index <= 0 ? 'hidden' : 'visible';
  if (next) next.style.visibility = index >= __rvRows.length - 1 ? 'hidden' : 'visible';
  // 灯箱重做按钮：已完成/成功且有结果时显示
  var retryWrap = document.getElementById('rv-retry');
  var retryBtn = document.getElementById('rv-retry-btn');
  var retryStatus = document.getElementById('rv-retry-status');
  var downloadBtn = document.getElementById('rv-download-btn');
  if (downloadBtn) downloadBtn.disabled = !getSrc(1);
  if (retryWrap) {
    var tid = row.dataset.task || '';
    var task = (window.__currentBatch?.tasks || []).find(function(t){ return t.id === tid; });
    var canRetry = !!task && isCompletedTask(task) && !!getSrc(1);
    retryWrap.style.display = canRetry ? 'flex' : 'none';
    if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '重做'; }
    if (retryStatus) retryStatus.style.display = 'none';
  }
}

function navigateRowPreview(step) {
  var newIdx = __rvIndex + step;
  if (newIdx < 0 || newIdx >= __rvRows.length) return;
  __rvIndex = newIdx;
  loadRowPreview(__rvIndex);
}

// ===== 灯箱重做按钮 =====
async function clickRvRetry(){
  if (__rvIndex < 0 || __rvIndex >= __rvRows.length) return;
  var row = __rvRows[__rvIndex];
  var bid = row.dataset.batch || '';
  var tid = row.dataset.task || '';
  if (!bid || !tid) { toast('无法获取任务信息', 'wn'); return; }
  var retryBtn = document.getElementById('rv-retry-btn');
  var retryStatus = document.getElementById('rv-retry-status');
  if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = '重做中…'; }
  if (retryStatus) { retryStatus.style.display = 'inline'; retryStatus.textContent = '排队中…'; }
  try {
    var ok = await retrySingleTask(bid, tid, false, false);
    if (!ok) {
      if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '重做'; }
      if (retryStatus) retryStatus.style.display = 'none';
      return;
    }
    // retrySingleTask 内部已 refreshAndRender 重建任务行，旧 __rvRows 已失效，需重新扫描并定位到同一任务
    var targetTid = tid;
    __rvRows = Array.from(document.querySelectorAll('.task-row')).filter(function(r) {
      return r.dataset.task && r.dataset.batch && r.querySelectorAll('.task-thumb img').length >= 1;
    });
    var newIdx = __rvRows.findIndex(function(r) { return (r.dataset.task || '') === targetTid; });
    if (newIdx >= 0) __rvIndex = newIdx;
    else if (__rvIndex >= __rvRows.length) __rvIndex = __rvRows.length - 1;
    if (__rvIndex >= 0) loadRowPreview(__rvIndex);
  } catch (e) {
    if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '重试'; }
    if (retryStatus) { retryStatus.textContent = '失败，请重试'; }
    toast('重做失败: ' + (e.message || ''), 'ng');
  }
}

function closeImagePreview() {
  var modal = document.getElementById('img-viewer-modal');
  if (!modal) return;
  if (modal.style.display === 'none') return;
  modal.style.display = 'none';
  // 清空单图
  var img = document.getElementById('img-viewer-image');
  if (img) img.src = '';
  // 清空行预览三图
  var tpl = document.getElementById('rv-tpl');
  var ref = document.getElementById('rv-ref');
  var out = document.getElementById('rv-out');
  if (tpl) tpl.src = '';
  if (ref) ref.src = '';
  if (out) out.src = '';
  // 隐藏灯箱重做按钮 + 行预览容器
  var rvRetry = document.getElementById('rv-retry');
  if (rvRetry) rvRetry.style.display = 'none';
  var rvWrapper = document.getElementById('rv-wrapper');
  if (rvWrapper) rvWrapper.style.display = 'none';
  __rvIndex = -1;
  __rvRows = [];
  document.body.style.overflow = '';
  notifyRecolorModalState(false);
  var returnFocus = recolorModalReturnFocus;
  recolorModalReturnFocus = null;
  requestAnimationFrame(function() { returnFocus?.focus?.(); });
}

function downloadCurrentRowPreview() {
  if (__rvIndex < 0 || __rvIndex >= __rvRows.length) return;
  var row = __rvRows[__rvIndex];
  var url = document.getElementById('rv-out')?.src || '';
  if (!url || url.startsWith('data:,')) return toast('生成图尚不可下载', 'wn');
  var filename = row.dataset.out || [row.dataset.tpl, row.dataset.clr].filter(Boolean).join('-') + '.jpg';
  downloadOutput(url, filename);
}

// ===== 复制功能 =====
async function copyText(text, label) {
  if (!text) { toast('无可复制内容', 'wn'); return; }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    toast(`已复制${label ? '：' + label : ''}`);
  } catch (e) {
    toast('复制失败，请手动复制', 'ng');
  }
}

function copyFromRow(el, type) {
  if (!el) return;
  const row = el.closest('.task-row');
  if (!row) return;
  const tpl = row.dataset.tpl || '';
  const clr = row.dataset.clr || '';
  const out = row.dataset.out || '';
  if (type === 'tpl') copyText(tpl, '模板名');
  else if (type === 'clr') copyText(clr, '颜色名');
  else if (type === 'out') { if (out) copyText(out, '结果路径'); else toast('结果未生成', 'wn'); }
}

// ===== 任务完成后自动选中最新结果 =====
function autoSelectLatestCompleted(batch) {
  if (!batch?.tasks?.length) return;
  const tasks = batch.tasks;

  // 对比新旧状态，找出刚刚变成 completed 的任务
  const justCompleted = [];
  const newStatusMap = {};
  for (const task of tasks) {
    const newStatus = task.executionStatus || task.status || '';
    newStatusMap[task.id] = newStatus;
    const oldStatus = lastTaskStatusMap[task.id] || '';
    if (isDoneStatus(newStatus) && !isDoneStatus(oldStatus)) {
      justCompleted.push(task);
    }
  }
  // 保存新状态供下次对比
  lastTaskStatusMap = newStatusMap;

  if (!justCompleted.length) return;

  // 按 order / completedAt 排序，取最新完成的任务
  justCompleted.sort((a, b) => {
    const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0;
    const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
    return tb - ta || (b.order || 0) - (a.order || 0);
  });
  const latest = justCompleted[0];

  // 判断是否允许自动选中
  // 情况1: 用户未手动选择任何任务 → 自动选中
  if (!userSelectedTaskId) {
    selectTask(batch.batchId, latest.id, true);
    return;
  }

  // 情况2: 用户当前选中的任务恰好刚完成 → 更新选中（刷新结果图）
  if (userSelectedTaskId === latest.id) {
    selectTask(batch.batchId, latest.id, true);
    return;
  }

  // 情况3: 用户手动选了其他任务 → 不自动跳走（首次运行batch时允许一次）
  if (!autoSelectSuppressed && selectedBatchId === batch.batchId) {
    selectTask(batch.batchId, latest.id, true);
    autoSelectSuppressed = true;
  }
}

function isDoneStatus(status) {
  const s = (status || '').toLowerCase();
  return ['completed', 'done', 'success'].includes(s);
}

// ===== 创作者工作台功能弹窗 =====
function openWorkbenchModal(type) {
  wbModalType = type; wbModalPage = 1; wbModalPageSize = 20;
  let overlay = document.getElementById('wb-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'wb-modal-overlay';
    overlay.className = 'wb-modal-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) closeWorkbenchModal(); };
    overlay.innerHTML = `
      <div class="wb-modal-panel" onclick="event.stopPropagation()">
        <div class="wb-modal-header">
          <span class="wb-modal-title" id="wb-modal-title"></span>
          <button class="wb-modal-close" onclick="closeWorkbenchModal()" title="关闭"><span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg></span></button>
        </div>
        <div class="wb-modal-body" id="wb-modal-body"></div>
        <div class="wb-modal-footer" id="wb-modal-footer"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  const escHandler = function(e) { if (e.key === 'Escape') { closeWorkbenchModal(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
  renderWorkbench(type);
}
function closeWorkbenchModal() {
  const overlay = document.getElementById('wb-modal-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  wbModalType = null;
}

// ===== 彻底清空一键复色 =====
function confirmRecolorReset() {
  var batch = window.__currentBatch;
  var running = (batch?.tasks || []).filter(function(task) { return ['running','submitting','submitted'].includes(task.executionStatus || task.generationSubmissionState); }).length;
  var clearVisual = '<div class="clear-v2">'
    +'<div class="danger-hero"><div class="danger-icon" aria-hidden="true"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4L12 3Z"></path><path d="M12 9v5M12 17h.01"></path></svg></span></div><div><b>清空后无法恢复</b><p>只清除一键复色自己的素材、任务与结果，不影响画布、全局 API 设置或全局主题。</p></div></div>'
    +'<div class="clear-columns"><section class="scope-card"><h3>将被彻底清除</h3><div class="scope-tags">'
    +['上传素材','参考色裁剪资料','任务与队列','生成图','历史结果','导出标记','缓存','临时文件','日志'].map(function(label){ return '<span class="scope-tag">'+label+'</span>'; }).join('')
    +'</div></section><section class="scope-card safe"><h3>不会受到影响</h3><div class="scope-safe"><span>✓ 画布内容</span><span>✓ 全局 API 设置</span><span>✓ 全局主题</span></div></section></div>'
    +'<div class="remote-risk"><b>运行中的远端任务</b><br>'+(running ? '当前有 '+running+' 项任务已提交到远端。系统会停止本地队列并尝试取消；服务商不支持取消时，本次调用仍可能产生费用，迟到结果会被丢弃。' : '当前没有运行中的远端任务。清空后可重新上传相同模板图和参考色，不会发生旧缓存误判。')+'</div>'
    +'</div>';
  return askRecolorConfirmation({
    danger:true,
    scene:'clear',
    title:'彻底清空一键复色数据',
    subtitle:'请确认本次清除范围',
    visualHtml:clearVisual,
    cancelText:'取消',
    confirmText:'确认彻底清空'
  });
}

async function softReset() {
  if (window.__softResetInProgress) return;
  if (!await confirmRecolorReset()) return;
  const resetButton = $('ba-soft-reset');
  window.__softResetInProgress = true;
  if (resetButton) {
    resetButton.disabled = true;
    resetButton.dataset.previousText = resetButton.textContent;
    resetButton.textContent = '清理中...';
  }
  try {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const result = await api('/api/reset-all', {});
    if (!result || result.success !== true) throw new Error(result?.error || '缓存清理失败');
    window.__currentBatch = null;
    updateBatch({ tasks: [], totals: {}, status: 'empty', batchId: null });
    resetCostStats('softReset');
    selectedTaskIds = [];
    scanData = null;
    scanPairs = [];
    valData = { passed: 0, warned: 0, pairs: [] };
    batchId = null;
    genDone = false;
    pageTracker = {};
    filesStore.template = [];
    filesStore.color = [];
    // 只清复色浏览器数据，保留全局主题、画布状态和 API 设置。
    try { await window.PersistentStore?.clearAll(); } catch (storageError) { console.warn('持久化缓存清理失败:', storageError); }
    clearRecolorBrowserStorage();
    go(1);
    toast(result.message || '缓存已清空，软件保持运行', 'ok');
    // 只刷新当前页面状态，不关闭 Electron 窗口或后端进程。
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    window.__softResetInProgress = false;
    if (resetButton) {
      resetButton.disabled = false;
      resetButton.textContent = resetButton.dataset.previousText || '彻底清空缓存';
    }
    toast('清空失败: ' + (e.message || ''), 'ng');
  }
}

// ===== API 配置弹窗 =====
async function openApiConfig() {
  let cfg = { baseUrl: '', apiKeyMasked: '' };
  let providers = [];
  try { const r = await api('/api/config'); if (r.success) { cfg = r.config; providers = r.api_providers || []; } } catch(e) {}

  // 画布 Provider 只读展示区（与复色自身 API 配置分离，仅用于查看画布已接入的平台）
  const providerRows = providers.length
    ? providers.map(p => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--bd);font-size:11px">
        <span style="flex:1;color:var(--tx);font-weight:600">${p.name || p.id}</span>
        <span style="color:var(--t2);font-size:10px">${p.image_models?.length || 0} 生图模型</span>
        <span style="color:${p.has_key ? 'var(--ok,#16a34a)' : 'var(--t3,#64748b)'};font-size:10px">${p.has_key ? '● 已配置' : '○ 未配置'}</span>
      </div>`).join('')
    : `<div style="font-size:11px;color:var(--t2);padding:6px 8px">画布尚未配置 Provider，可到「API 设置」页添加。</div>`;

  const overlay = document.createElement('div');
  overlay.id = 'api-config-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
  overlay.innerHTML = `
    <div style="background:var(--pn);border:1px solid var(--bd);border-radius:14px;padding:24px 32px;max-width:460px;width:90vw;max-height:88vh;overflow-y:auto;box-shadow:none">
      <div style="font-size:16px;font-weight:800;color:var(--tx);margin-bottom:18px">接口设置</div>
      <div style="margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;color:var(--tx);margin-bottom:6px">画布 Provider（只读，来自「API 设置」页）</div>
        <div style="border:1px solid var(--bd);border-radius:8px;overflow:hidden">${providerRows}</div>
        <div style="font-size:10px;color:var(--t2);margin-top:6px;line-height:1.45">复色已打通画布 Provider，生成时通过侧栏选择 Provider / 模型 / 尺寸 / 质量 / 数量。如需修改 Provider/Key，请到画布「API 设置」页。</div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn bp" onclick="document.getElementById('api-config-overlay').remove()">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function openCostModal() {
  const batch = window.__currentBatch;
  if (!batch) return;
  const tasks = (batch.tasks||[]).filter(t => !t.hiddenInTaskList && t.executionStatus !== 'deleted');
  const completed = tasks.filter(t => ['completed','done','success'].includes(t.executionStatus));
  const failed = tasks.filter(t => ['failed','error'].includes(t.executionStatus));
  const interrupted = tasks.filter(t => t.executionStatus === 'interrupted');
  const totalInterrupts = tasks.reduce((s, t) => s + (t.interruptCount || 0), 0);
  const elapsedSec = batch.finishedAt && batch.startedAt ? Math.round((new Date(batch.finishedAt)-new Date(batch.startedAt))/1000) : null;
  const avgSec = completed.length ? Math.round(completed.reduce((s,t)=>(t.elapsedMs||0)+s,0)/completed.length/1000) : null;
  const fmtHMS = s => s==null?'—':`${Math.floor(s/3600).toString().padStart(2,'0')}:${Math.floor(s%3600/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
  const totals = batch.totals||{};
  const body = document.getElementById('cost-modal-body');
  const cp = calcPrice(batch);
  var rows = [
    {l:'总任务数',v:tasks.length},
    {l:'已完成',v:completed.length},
    {l:'失败 / 中断',v:failed.length+' / '+interrupted.length},
    {l:'累计中断次数',v:totalInterrupts},
    {l:'总耗时 / 平均单任务',v:fmtHMS(elapsedSec)+' / '+fmtHMS(avgSec)},
    {l:'API 实际调用次数',v:cp.attempts+' 次'},
    {l:'当前批次单价 / 小计',v:(cp.unitFen > 0 ? money(cp.unitFen)+' / ' : '系统默认 / ')+cp.subtotal},
    ...(cp.discountRate > 0 ? [{l:'折扣 ('+cp.discountRate+'%)',v:cp.discounted}] : []),
    ...(cp.taxRate > 0 ? [{l:'税额 ('+cp.taxRate+'%)',v:cp.tax}] : []),
    {l:'总费用',v:cp.grand,total:true},
    {l:'开始时间',v:batch.startedAt?new Date(batch.startedAt).toLocaleString():'—'},
    {l:'结束时间',v:batch.finishedAt?new Date(batch.finishedAt).toLocaleString():(batch.active?'生成中':'—')}
  ];
  body.innerHTML = '<div class="billing-lock"><div class="billing-rate"><span>当前批次单价</span><strong>'+(cp.unitFen > 0 ? money(cp.unitFen)+' / 次' : '系统默认')+'</strong><small>'+(cp.lockedUnitFen?'已锁定':'批次开始时锁定')+'</small></div><span class="billing-arrow"><span class="ui-icon"><svg viewBox="0 0 24 24"><path d="M5 12h14M14 7l5 5-5 5"></path></svg></span></span><div class="billing-rate next"><span>下一批单价</span><strong>'+(cp.nextUnitFen ? money(cp.nextUnitFen)+' / 次' : '系统默认')+'</strong><small>可在提示词设置中修改</small></div></div>'
    +'<div class="cost-summary-grid">'+rows.map(function(row){ return '<div class="cm-row '+(row.total?'total':'')+'"><span>'+row.l+'</span><strong class="cm-val">'+row.v+'</strong></div>'; }).join('')+'</div>'
    +'<div class="cost-summary-note"><span class="ui-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg></span><span>当前批次按开始时锁定的单价统计，不会被后续改价影响；新的手动单价从下一批生效。</span></div><div class="cost-summary-footer"><button type="button" class="btn bs" onclick="closeCostModal()">关闭</button></div>';
  var live = document.getElementById('cost-modal-live');
  if (live) { live.textContent = batch.active ? '生成中' : batch.status === 'paused' ? '已暂停' : '批次汇总'; live.dataset.state = batch.active ? 'running' : batch.status || 'idle'; }
  var modal = document.getElementById('cost-modal');
  recolorModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.style.display='flex';
  notifyRecolorModalState(true);
  focusRecolorModal(modal);
}
function closeCostModal(e) {
  var modal = document.getElementById('cost-modal');
  if (e && e.target !== modal) return;
  if (!modal || modal.style.display === 'none') return;
  modal.style.display='none';
  notifyRecolorModalState(false);
  var returnFocus = recolorModalReturnFocus;
  recolorModalReturnFocus = null;
  requestAnimationFrame(function() { returnFocus?.focus?.(); });
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeCostModal();});

function wbPageNav(total) {
  const tp = Math.max(1, Math.ceil(total / wbModalPageSize));
  if (wbModalPage > tp) wbModalPage = tp;
  const cur = wbModalPage;
  return '<div class="wb-pagination"><select onchange="wbModalPageSize=+this.value;wbModalPage=1;renderWorkbench(wbModalType)" value="' + wbModalPageSize + '"><option value="10" '+(wbModalPageSize===10?'selected':'')+'>10条/页</option><option value="20" '+(wbModalPageSize===20?'selected':'')+'>20条/页</option><option value="50" '+(wbModalPageSize===50?'selected':'')+'>50条/页</option></select><button onclick="wbModalPage=1;renderWorkbench(wbModalType)" '+(cur===1?'disabled':'')+'>«</button><button onclick="wbModalPage--;renderWorkbench(wbModalType)" '+(cur===1?'disabled':'')+'>‹</button><span class="current">'+cur+' / '+tp+'</span><button onclick="wbModalPage++;renderWorkbench(wbModalType)" '+(cur===tp?'disabled':'')+'>›</button><button onclick="wbModalPage='+tp+';renderWorkbench(wbModalType)" '+(cur===tp?'disabled':'')+'>»</button></div>';
}
function renderWorkbench(type) {
  var title = document.getElementById('wb-modal-title');
  var body = document.getElementById('wb-modal-body');
  var footer = document.getElementById('wb-modal-footer');
  if (!body) return;
  var T = { upload:'上传素材', match:'智能配对', generate:'批量生成状态', outputs:'结果输出', logs:'日志中心' };
  if (title) title.textContent = T[type] || '工作台';
  var html = ''; var foot = '';
  if (type === 'upload') {
    var tc = filesStore.template.length, cc = filesStore.color.length;
    html = '<div class="wb-section"><div class="wb-section-title">当前素材状态</div><div class="wb-stat-row"><div class="wb-stat ok"><span class="wb-stat-v">'+tc+'</span><span class="wb-stat-l">模板图</span></div><div class="wb-stat"><span class="wb-stat-v">'+cc+'</span><span class="wb-stat-l">参考色</span></div><div class="wb-stat wn"><span class="wb-stat-v">'+(tc>0&&cc>0?tc*cc:'无')+'</span><span class="wb-stat-l">可配对数</span></div></div><div style="margin-top:10px;font-size:11px;color:var(--t3)">提示：上传请用主界面上传区域</div></div>';
    if (tc>0) html+='<div class="wb-section"><div class="wb-section-title">模板图列表</div><div class="wb-file-list">'+filesStore.template.map(function(f){return '<div class="wb-file-item">📐 '+escapeHtml(f.name)+'</div>';}).join('')+'</div></div>';
    if (cc>0) html+='<div class="wb-section"><div class="wb-section-title">参考色列表</div><div class="wb-file-list">'+filesStore.color.map(function(f){return '<div class="wb-file-item">'+escapeHtml(f.name)+'</div>';}).join('')+'</div></div>';
  } else if (type === 'match') {
    var pairs = scanPairs || [];
    html = '<div class="wb-section"><div class="wb-section-title">配对概览</div><div class="wb-stat-row"><div class="wb-stat ok"><span class="wb-stat-v">'+pairs.length+'</span><span class="wb-stat-l">配对总数</span></div></div></div>';
    if (pairs.length > 0) {
      var start = (wbModalPage-1)*wbModalPageSize, pageItems = pairs.slice(start, start+wbModalPageSize);
      html += '<div class="wb-section"><div class="wb-section-title">配对列表</div>'+wbPageNav(pairs.length)+'<div style="overflow-x:auto">'+pageItems.map(function(p,i){return '<div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid rgba(99,102,241,.05);font-size:11px"><span style="color:var(--t3);min-width:30px">#'+(start+i+1)+'</span><span style="color:var(--tx);flex:1">'+escapeHtml(p.templateNameWithoutExt||p.templateName||'—')+'</span><span style="color:var(--t2)">→</span><span style="color:var(--tx);flex:1">'+escapeHtml(p.colorNameWithoutExt||p.colorName||'—')+'</span><span class="status-pill scan-pending" style="font-size:9px">待生成</span></div>';}).join('')+'</div></div>';
    } else { html += '<div class="wb-empty">暂无配对数据</div>'; }
  } else if (type === 'generate') {
    var batch = window.__currentBatch;
    if (!batch) { html = '<div class="wb-empty">暂无批量生成任务</div>'; }
    else {
      var totals = batch.totals, progress = totals.total ? Math.round(totals.done/totals.total*100) : 0;
      var tasks = (batch.tasks||[]).filter(function(t){return t.executionStatus!=='deleted'&&!t.hiddenInTaskList;});

      // 颜色筛选
      var colorNames = [...new Set(tasks.map(function(t){return t.colorNameWithoutExt||t.colorRef||'—';}))];
      var filteredTasks = wbModalColorFilter === 'all' ? tasks : tasks.filter(function(t){return (t.colorNameWithoutExt||t.colorRef) === wbModalColorFilter;});
      var start = (wbModalPage-1)*wbModalPageSize, pageTasks = filteredTasks.slice(start, start+wbModalPageSize);

      var costHtml = calcCost(batch) + ' · ' + (totals.apiAttempts||0) + '次';
      html = '<div class="wb-section"><div class="wb-section-title">批次 '+escapeHtml((batch.batchId||'').slice(0,30))+'</div><div class="wb-stat-row"><div class="wb-stat"><span class="wb-stat-v">'+totals.total+'</span><span class="wb-stat-l">总任务</span></div><div class="wb-stat ok"><span class="wb-stat-v">'+totals.success+'</span><span class="wb-stat-l">已完成</span></div><div class="wb-stat"><span class="wb-stat-v">'+totals.running+'</span><span class="wb-stat-l">运行中</span></div><div class="wb-stat ng"><span class="wb-stat-v">'+totals.failed+'</span><span class="wb-stat-l">失败</span></div><div class="wb-stat wn"><span class="wb-stat-v">'+(totals.pending||0)+'</span><span class="wb-stat-l">待生成</span></div><div class="wb-stat"><span class="wb-stat-v">'+(costHtml||'—')+'</span><span class="wb-stat-l">费用</span></div></div>'+(batch.active?'<div style="margin-top:10px"><div class="task-progress-bar" style="height:6px"><div class="task-progress-fill" style="width:'+progress+'%"></div></div><span style="font-size:10px;color:var(--t3)">'+progress+'%</span></div>':'')+'</div>';

      // 颜色筛选条
      html += '<div style="display:flex;flex-wrap:wrap;gap:5px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)"><button class="cf-chip'+(wbModalColorFilter==='all'?' active':'')+'" onclick="wbModalColorFilter=\'all\';wbModalPage=1;renderWorkbench(\'generate\')">全部 ('+tasks.length+')</button>';
      colorNames.forEach(function(c){
        html += '<button class="cf-chip'+(wbModalColorFilter===c?' active':'')+'" onclick="wbModalColorFilter=\''+escapeHtml(c).replace(/'/g,"\\'")+'\';wbModalPage=1;renderWorkbench(\'generate\')">'+escapeHtml(c)+'</button>';
      });
      html += '</div>';

      foot = (batch.active ? '<button class="btn bd" onclick="cancelGen();closeWorkbenchModal()">取消</button>' : '<button class="btn bp" onclick="handleStartGen();closeWorkbenchModal()">开始生成</button>')+'<button class="btn bs" onclick="downloadZip();closeWorkbenchModal()">下载全部</button><button class="btn bs" onclick="downloadByColor();closeWorkbenchModal()">按颜色下载</button>';
    }
  } else if (type === 'outputs') {
    var batch = window.__currentBatch;
    var completed = (batch?.tasks||[]).filter(function(t){return ['completed','done','success'].includes((t.executionStatus||'').toLowerCase())&&t.output;});
    html = '<div class="wb-section"><div class="wb-section-title">输出概览</div><div class="wb-stat-row"><div class="wb-stat ok"><span class="wb-stat-v">'+completed.length+'</span><span class="wb-stat-l">可下载结果</span></div>'+(batch?'<div class="wb-stat"><span class="wb-stat-v">'+escapeHtml((batch.batchId||'').slice(0,20))+'</span><span class="wb-stat-l">当前批次</span></div>':'')+'</div></div>';
    if (completed.length > 0) {
      var start = (wbModalPage-1)*wbModalPageSize, pageItems = completed.slice(start, start+wbModalPageSize);
      html += '<div class="wb-section"><div class="wb-section-title">输出文件</div>'+wbPageNav(completed.length)+pageItems.map(function(t){return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(99,102,241,.05);font-size:11px"><span style="color:var(--tx);flex:1">'+escapeHtml(t.output||'')+'</span><span style="color:var(--t3);font-size:10px">'+escapeHtml(t.templateNameWithoutExt||'—')+' → '+escapeHtml(t.colorNameWithoutExt||'—')+'</span></div>';}).join('');
      foot = '<button class="btn bp" onclick="downloadZip();closeWorkbenchModal()">下载全部结果</button><button class="btn bs" onclick="downloadByColor();closeWorkbenchModal()">按颜色下载</button>';
      foot = '<button class="btn bp" onclick="downloadZip();closeWorkbenchModal()">下载全部结果</button><button class="btn bs" onclick="downloadByColor();closeWorkbenchModal()">按颜色下载</button>';
    } else { html += '<div class="wb-empty">暂无可下载结果</div>'; }
  } else if (type === 'logs') {
    var logs = latestLogs || [];
    var filtered = logLevelFilter === 'all' ? logs : logs.filter(function(l){return l.level===logLevelFilter;});
    var start = (wbModalPage-1)*wbModalPageSize, pageLogs = filtered.slice(start, start+wbModalPageSize);
    html = '<div class="wb-section"><div class="wb-section-title">日志筛选</div><div style="display:flex;gap:4px;margin-bottom:8px">'+['all','info','success','warning','error'].map(function(lv){return '<button class="log-filter-btn '+(logLevelFilter===lv?'active':'')+' log-filter-'+lv+'" onclick="logLevelFilter=\''+lv+'\';renderLogs();renderWorkbench(\'logs\')">'+(LOG_LEVEL_LABEL[lv]||'全部')+'</button>';}).join('')+'<button class="log-filter-btn" onclick="fetchLogs();setTimeout(function(){renderWorkbench(\'logs\')},200)" style="margin-left:auto">刷新</button></div></div>';
    html += '<div class="wb-section"><div class="wb-section-title">日志记录（'+filtered.length+' 条）</div>'+wbPageNav(filtered.length)+(pageLogs.length ? pageLogs.map(function(l){return '<div class="log-entry"><span class="log-time">'+escapeHtml(l.time||'--:--:--')+'</span><span class="log-level log-lv-'+l.level+'">'+(LOG_LEVEL_LABEL[l.level]||l.level.toUpperCase())+'</span><span class="log-source">['+escapeHtml(l.source||'')+']</span><span>'+escapeHtml(l.message||'')+'</span></div>';}).join('') : '<div class="wb-empty">暂无日志</div>')+'</div>';
  }
  body.innerHTML = html || '<div class="wb-empty">功能开发中</div>';
  if (footer) footer.innerHTML = foot;
}

// ===== 多选状态 =====
let selectedTaskIds = [];

function toggleTaskSelect(taskId, checked) {
  if (checked) {
    if (!selectedTaskIds.includes(taskId)) selectedTaskIds.push(taskId);
  } else {
    selectedTaskIds = selectedTaskIds.filter(id => id !== taskId);
  }
  updateSelectedCount();
}

// ===== 全选 / 批量移除 =====
function toggleSelectAll(checkbox) {
  const rows = document.querySelectorAll('.task-row .task-col-cb input[type="checkbox"]');
  const checked = checkbox.checked;
  rows.forEach(cb => {
    cb.checked = checked;
    const taskId = cb.closest('.task-row')?.dataset?.task;
    if (taskId) {
      if (checked) { if (!selectedTaskIds.includes(taskId)) selectedTaskIds.push(taskId); }
      else { selectedTaskIds = []; }
    }
  });
  updateSelectedCount();
}
function updateSelectedCount() {
  const count = selectedTaskIds.length;
  const el = document.getElementById('selected-count');
  if (el) el.textContent = count;
  // 工具栏始终显示（因为有永久可见按钮）
  const bar = document.getElementById('batch-toolbar');
  const label = document.getElementById('selected-count-label');
  if (bar) bar.style.display = 'flex';
  // 半选状态
  const master = document.querySelector('.tth-cb input[type="checkbox"]');
  const total = document.querySelectorAll('.task-row .task-col-cb input[type="checkbox"]').length;
  if (master) master.indeterminate = count > 0 && count < total;
  if (master) master.checked = count > 0 && count === total;
  // 批量操作按钮可见性：永久按钮（下载、继续生成）始终显示
  const alwaysBtns = ['bt-dl', 'bt-continue'];
  const countBtns = ['bt-retry', 'bt-clear'];
  alwaysBtns.forEach(id => { const b = document.getElementById(id); if (b) b.style.display = 'inline-flex'; });
  countBtns.forEach(id => { const b = document.getElementById(id); if (b) b.style.display = count > 0 ? 'inline-flex' : 'none'; });
  if (label) label.style.display = count > 0 ? 'inline' : 'none';
}
async function batchClearSelected() {
  const batch = window.__currentBatch;
  if (!batch || !batch.tasks?.length) return toast('没有可清理的任务', 'wn');
  const checked = document.querySelectorAll('.task-row .task-col-cb input[type="checkbox"]:checked');
  if (!checked.length) return toast('没有选中任务', 'wn');
  if (!await askRecolorConfirmation({ danger:true, title:'删除已选任务', subtitle:'任务会立即隐藏', facts:[{label:'任务数量',value:checked.length+' 项'},{label:'撤销时间',value:'5 秒'}], confirmText:'确认删除' })) return;
  const ids = new Set();
  for (const cb of checked) {
    const row = cb.closest('.task-row');
    if (row?.dataset?.task) ids.add(row.dataset.task);
  }
  safeAction('batchClear', async () => {
    const result = await api('/api/recolor/history/delete', {
      batchId: batch.batchId,
      taskIds: [...ids]
    });
    const clone = structuredClone(batch);
    clone.tasks = filterTasks(clone, t => !ids.has(t.id));
    selectedTaskIds = [];
    updateBatch(clone);
    showDeleteUndo(result, batch.batchId);
  });
}

// 批量重试选中任务（批量重置 + 统一启 runner）
async function batchRetrySelected() {
  const checked = document.querySelectorAll('.task-row .task-col-cb input[type="checkbox"]:checked');
  if (!checked.length) return toast('没有选中任务', 'wn');
  if (!await askRecolorConfirmation({ title:'批量重新生成', subtitle:'每项任务都会产生一次新的 API 调用', facts:[{label:'任务数量',value:checked.length+' 项'},{label:'预计调用',value:checked.length+' 次 API'}], message:'每项旧图都会保留到新结果保存成功后再替换。', confirmText:'确认重做' })) return;
  await batchRetryFromCheckboxes(checked);
}

// 批量重试失败任务
async function retryFailed() {
  if (!window.__currentBatch) return toast('没有可重试的任务', 'wn');
  const batch = window.__currentBatch;
  const failedTasks = batch.tasks.filter(t => ['failed','error'].includes(t.executionStatus));
  if (!failedTasks.length) return toast('没有失败的任务', 'wn');
  if (!await askRecolorConfirmation({ title:'重试失败任务', subtitle:'失败任务将按原顺序加入队列', facts:[{label:'任务数量',value:failedTasks.length+' 项'},{label:'预计调用',value:failedTasks.length+' 次 API'}], confirmText:'确认重试' })) return;
  await retryTasksByIds(batch.batchId, failedTasks.map(t => t.id));
}

// 批量重试已取消任务
async function retryCancelled() {
  if (!window.__currentBatch) return toast('没有可重试的任务', 'wn');
  const batch = window.__currentBatch;
  const cancelledTasks = batch.tasks.filter(t => ['cancelled'].includes(t.executionStatus));
  if (!cancelledTasks.length) return toast('没有已取消的任务', 'wn');
  if (!await askRecolorConfirmation({ title:'重新生成已取消任务', subtitle:'任务将按原顺序加入队列', facts:[{label:'任务数量',value:cancelledTasks.length+' 项'},{label:'预计调用',value:cancelledTasks.length+' 次 API'}], confirmText:'确认生成' })) return;
  await retryTasksByIds(batch.batchId, cancelledTasks.map(t => t.id));
}

// 从 checkbox 列表批量重试（一次请求原子操作）
async function batchRetryFromCheckboxes(checked) {
  const batch = window.__currentBatch;
  if (!batch) return toast('没有活动批次', 'wn');
  const taskIds = [];
  for (const cb of checked) {
    const taskId = cb.closest('.task-row')?.dataset?.task;
    if (taskId) taskIds.push(taskId);
  }
  if (!taskIds.length) return toast('重试失败', 'ng');
  const result = await api(`/api/batches/${encodeURIComponent(batch.batchId)}/retry-batch`, { taskIds });
  if (!result.success) return toast(result.error || '重试失败', 'ng');
  await refreshAndRender(batch.batchId);
  startPolling(true);
  toast(`已开始重新生成 ${result.count} 个任务`);
}

// 按 ID 列表批量重试
async function retryTasksByIds(batchId, taskIds) {
  const result = await api(`/api/batches/${encodeURIComponent(batchId)}/retry-batch`, { taskIds });
  if (!result.success) return toast(result.error || '重试失败', 'ng');
  await refreshAndRender(batchId);
  startPolling(true);
  toast(`已开始重新生成 ${result.count} 个任务`);
}

// 批量下载任务结果（未勾选时下载全部已完成）
async function batchDownloadSelected() {
  const batch = window.__currentBatch;
  if (!batch) return toast('没有活动批次', 'wn');
  const checked = document.querySelectorAll('.task-row .task-col-cb input[type="checkbox"]:checked');
  let ids = [];
  if (checked.length > 0) {
    checked.forEach(cb => {
      const taskId = cb.closest('.task-row')?.dataset?.task;
      if (taskId) ids.push(taskId);
    });
  } else {
    // 未勾选：下载全部已完成且有输出的任务
    const completedTasks = (batch.tasks||[]).filter(t =>
      ['completed','done','success'].includes(t.executionStatus) && t.output && !t.hiddenInTaskList
    );
    ids = completedTasks.map(t => t.id);
    if (!ids.length) return toast('没有已完成的任务可下载', 'wn');
  }
  if (!ids.length) return toast('无可下载任务', 'wn');
  toast('正在打包…');
  const qs = ids.map(id => `ids[]=${encodeURIComponent(id)}`).join('&');
  downloadUrl(`/api/batches/${encodeURIComponent(batch.batchId)}/download-selected?${qs}`);
}

// ===== 生成完成汇总弹窗 =====
function showCompletionSummary(batch) {
  const totals = batch.totals;
  const startTime = batch.startedAt ? new Date(batch.startedAt) : (batch.createdAt ? new Date(batch.createdAt) : null);
  const endTime = new Date();
  const elapsedSec = startTime ? Math.round((endTime - startTime) / 1000) : 0;
  const elapsedStr = elapsedSec >= 3600
    ? `${Math.floor(elapsedSec/3600)}时${Math.floor(elapsedSec%3600/60)}分`
    : elapsedSec >= 60 ? `${Math.floor(elapsedSec/60)}分${elapsedSec%60}秒` : `${elapsedSec}秒`;
  const costYuan = typeof totals.costFen === 'number' ? (totals.costFen / 100).toFixed(2) : '—';
  const fmtTime = (ts) => { if (!ts) return '—'; const d = new Date(ts); return d.toLocaleString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'}); };

  const html = `
<div id="completion-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)">
  <div style="background:var(--pn);border:1px solid var(--bd);border-radius:14px;padding:28px 36px;max-width:420px;width:90vw;box-shadow:none;text-align:center">
    <div style="font-size:36px;margin-bottom:10px">✅</div>
    <div style="font-size:18px;font-weight:800;color:var(--tx);margin-bottom:6px">生成完成</div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:18px">${escapeHtml((batch.batchId||'').slice(0,24))}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left;font-size:12px;margin-bottom:20px">
      <div style="color:var(--t2)">⏱ 用时</div><div style="color:var(--tx);text-align:right">${elapsedStr}</div>
      <div style="color:var(--t2)">成功 / 失败</div><div style="color:var(--tx);text-align:right"><span style="color:var(--gn)">${totals.success}</span> / <span style="color:${totals.failed>0?'var(--re)':'var(--t2)'}">${totals.failed}</span></div>
      <div style="color:var(--t2)">💰 费用</div><div style="color:var(--tx);text-align:right">¥${costYuan}</div>
      <div style="color:var(--t2)">🔢 API 调用</div><div style="color:var(--tx);text-align:right">${totals.apiAttempts || totals.done} 次</div>
      <div style="color:var(--t2)">🕐 开始</div><div style="color:var(--t3);text-align:right;font-size:11px">${fmtTime(batch.startedAt || batch.createdAt)}</div>
      <div style="color:var(--t2)">🕑 结束</div><div style="color:var(--t3);text-align:right;font-size:11px">${fmtTime(endTime.toISOString())}</div>
    </div>
    <button onclick="document.getElementById('completion-overlay').remove()" style="padding:8px 32px;font-size:13px;font-weight:600;background:var(--bl);color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit">确认</button>
  </div>
</div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
