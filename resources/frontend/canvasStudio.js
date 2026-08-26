const canvasStudioParams = new URLSearchParams(window.location.search);
const canvasStudioCanvasId = canvasStudioParams.get('id') || '';
const canvasStudioProjectId = canvasStudioParams.get('project') || 'default';
const canvasStudioState = {
  active: false,
  viewport: { x: 0, y: 0, scale: 1 },
  nodes: [],
  connections: [],
  selectedId: '',
  selectedIds: [],
  selectedConnectionId: '',
  selectionBox: null,
  clipboard: null,
  undoStack: [],
  redoStack: [],
  historyLimit: 100,
  historySuspended: false,
  textEdit: null,
  drag: null,
  connect: null,
  spacePressed: false,
  saveTimer: null,
  lastSavedAt: '',
  logs: [],
  composer: {
    visible: true,
    left: null,
    top: null
  },
  cascade: {
    active: false,
    stopped: false,
    runId: '',
    targetId: '',
    order: [],
    currentIndex: -1,
    states: {},
    taskIds: {}
  }
};
window.canvasStudioState = canvasStudioState;

function canvasStudioLog(message, level = 'info') {
  const text = String(message || '').trim();
  if (!text) return;
  canvasStudioState.logs = Array.isArray(canvasStudioState.logs) ? canvasStudioState.logs : [];
  canvasStudioState.logs.unshift({ time: Date.now(), level, message: text });
  canvasStudioState.logs = canvasStudioState.logs.slice(0, 80);
  const list = document.getElementById('canvas-smart-log-list');
  if (list && document.getElementById('canvas-smart-log-modal')?.classList.contains('is-open')) renderSmartCanvasLog();
}

function canvasClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
function canvasEditorSnapshot() {
  return {
    viewport: { ...canvasStudioState.viewport },
    nodes: canvasClone(canvasStudioState.nodes),
    connections: canvasClone(canvasStudioState.connections),
    nextId: canvasStudioState.nextId
  };
}
function canvasEditorSnapshotChanged(before, after = canvasEditorSnapshot()) {
  return JSON.stringify(before) !== JSON.stringify(after);
}
function canvasEditorCommit(before, reason = 'edit') {
  if (canvasStudioState.historySuspended || !before) return false;
  const after = canvasEditorSnapshot();
  if (!canvasEditorSnapshotChanged(before, after)) return false;
  canvasStudioState.undoStack.push(before);
  if (canvasStudioState.undoStack.length > canvasStudioState.historyLimit) canvasStudioState.undoStack.shift();
  canvasStudioState.redoStack = [];
  canvasScheduleSave();
  return true;
}
function canvasEditorRestore(snapshot) {
  if (!snapshot) return;
  canvasStudioState.historySuspended = true;
  canvasApplyWorkspace(snapshot);
  canvasStudioState.historySuspended = false;
  canvasNormalizeSelection();
  renderCanvasStudioNodes();
}
function canvasSelectedNodes() {
  const ids = new Set(canvasStudioState.selectedIds || []);
  return canvasStudioState.nodes.filter(node => ids.has(node.id));
}
function canvasNormalizeSelection() {
  const existing = new Set(canvasStudioState.nodes.map(node => node.id));
  canvasStudioState.selectedIds = (canvasStudioState.selectedIds || []).filter(id => existing.has(id));
  canvasStudioState.selectedId = canvasStudioState.selectedIds.includes(canvasStudioState.selectedId)
    ? canvasStudioState.selectedId
    : canvasStudioState.selectedIds[canvasStudioState.selectedIds.length - 1] || '';
}
function canvasSetSelection(ids, additive = false) {
  const next = Array.isArray(ids) ? ids.filter(Boolean) : [];
  canvasStudioState.selectedIds = additive ? [...new Set([...(canvasStudioState.selectedIds || []), ...next])] : [...new Set(next)];
  canvasNormalizeSelection();
  renderCanvasStudioSelection();
  renderCanvasComposer();
}
function renderCanvasStudioSelection() {
  const selected = new Set(canvasStudioState.selectedIds || []);
  document.querySelectorAll('#canvas-studio-world .canvas-node').forEach(nodeEl => {
    const isSelected = selected.has(nodeEl.dataset.nodeId);
    nodeEl.classList.toggle('is-selected', isSelected);
    nodeEl.classList.toggle('is-primary-selected', nodeEl.dataset.nodeId === canvasStudioState.selectedId);
  });
}
function canvasEditorUndo() {
  const previous = canvasStudioState.undoStack.pop();
  if (!previous) return;
  canvasStudioState.redoStack.push(canvasEditorSnapshot());
  canvasEditorRestore(previous);
  canvasScheduleSave();
}
function canvasEditorRedo() {
  const next = canvasStudioState.redoStack.pop();
  if (!next) return;
  canvasStudioState.undoStack.push(canvasEditorSnapshot());
  canvasEditorRestore(next);
  canvasScheduleSave();
}
function canvasEditorBeginTextEdit(id) {
  const node = canvasGetNode(id);
  if (!node || canvasStudioState.textEdit?.id === id) return;
  if (canvasStudioState.textEdit?.timer) clearTimeout(canvasStudioState.textEdit.timer);
  canvasStudioState.textEdit = { id, before: canvasEditorSnapshot(), timer: null };
}
function canvasEditorEndTextEdit(id) {
  const edit = canvasStudioState.textEdit;
  if (!edit || edit.id !== id) return;
  if (edit.timer) clearTimeout(edit.timer);
  canvasStudioState.textEdit = null;
  canvasEditorCommit(edit.before, 'prompt');
}

const canvasModelOptions = {
  image: [{ value: 'gpt-image-2', label: 'GPT Image 2.0' }],
  video: [
    { value: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0 标准版' },
    { value: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast' },
    { value: 'kling-o3', label: '可灵 O3' },
    { value: 'kling-3.0', label: '可灵 3.0' }
  ]
};

const canvasApiSizeMap = {
  square: { '1k': '1024x1024', '2k': '2048x2048', '4k': '4096x4096' },
  portrait: { '1k': '1024x1536', '2k': '1360x2048', '4k': '2352x3520' },
  portrait43: { '1k': '1008x1344', '2k': '1536x2048', '4k': '2448x3264' },
  landscape43: { '1k': '1344x1008', '2k': '2048x1536', '4k': '3264x2448' },
  landscape: { '1k': '1536x1024', '2k': '2048x1360', '4k': '3520x2352' },
  story: { '1k': '720x1280', '2k': '1152x2048', '4k': '2160x3840' },
  wide: { '1k': '1280x720', '2k': '2048x1152', '4k': '3840x2160' },
  ultrawide: { '1k': '1280x544', '2k': '2048x880', '4k': '3840x1648' },
  ultratall: { '1k': '544x1280', '2k': '880x2048', '4k': '1648x3840' }
};
function canvasIsGeneratorNode(nodeOrType) {
  const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType?.type;
  return type === 'generate' || type === 'generator';
}
function canvasPromptValue(node) {
  const prompt = String(node?.prompt || '').trim();
  return prompt || String(node?.text || '').trim();
}
function canvasSetPromptValue(node, value) {
  if (!node) return;
  const text = String(value ?? '');
  node.prompt = text;
  node.text = text;
}
function canvasReadImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const source = String(url || '').trim();
    if (!source || typeof Image === 'undefined') return reject(new Error('图片尺寸读取不可用'));
    const image = new Image();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('图片尺寸读取超时')), 8000);
    image.onload = () => {
      const width = Number(image.naturalWidth || image.width);
      const height = Number(image.naturalHeight || image.height);
      if (width > 0 && height > 0) finish(null, { width, height });
      else finish(new Error('图片尺寸无效'));
    };
    image.onerror = () => finish(new Error('图片尺寸读取失败'));
    image.src = source;
  });
}
function canvasApiImageSize(ratioValue, resolutionValue, customRatioValue = '', customSizeValue = '') {
  const resolution = String(resolutionValue || '1k').toLowerCase();
  if (resolution === 'auto') return 'auto';
  if (resolution === 'custom') return String(customSizeValue || '').trim() || '1024x1024';
  if (ratioValue === 'custom' || ratioValue === 'source') {
    const match = String(customRatioValue || '').match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    if (match) {
      const ratio = Number(match[1]) / Number(match[2]);
      const longSide = ({ '1k': 1536, '2k': 2048, '4k': 3840 })[resolution] || 1536;
      const pixelLimit = ({ '1k': 1572864, '2k': 4194304, '4k': 8294400 })[resolution] || longSide * longSide;
      const width = ratio >= 1 ? longSide : Math.min(longSide * ratio, Math.sqrt(pixelLimit * ratio));
      const height = ratio >= 1 ? Math.min(longSide / ratio, Math.sqrt(pixelLimit / ratio)) : longSide;
      return `${Math.max(64, Math.floor(width / 16) * 16)}x${Math.max(64, Math.floor(height / 16) * 16)}`;
    }
  }
  return canvasApiSizeMap[ratioValue]?.[resolution] || canvasApiSizeMap.square[resolution] || canvasApiSizeMap.square['1k'];
}
async function canvasGeneratorSizeForRun(node, assets = []) {
  let ratio = node.ratio || 'square';
  let customRatio = node.customRatio || '';
  if (ratio === 'source' && !customRatio) {
    const ref = assets[0];
    let width = Number(ref?.width);
    let height = Number(ref?.height);
    if (!(width > 0 && height > 0) && ref?.url) {
      try {
        const dims = await canvasReadImageDimensions(ref.url);
        width = dims.width;
        height = dims.height;
      } catch (_error) {
        width = 0;
        height = 0;
      }
    }
    if (width > 0 && height > 0) {
      const safeWidth = Math.round(width);
      const safeHeight = Math.round(height);
      customRatio = `${safeWidth}:${safeHeight}`;
      node.customRatioWidth = String(safeWidth);
      node.customRatioHeight = String(safeHeight);
      node.customRatio = customRatio;
    } else ratio = 'square';
  }
  return canvasApiImageSize(ratio, node.resolution || '1k', customRatio, node.customSize || '');
}

function canvasNodeId(type) { return `canvas-${type}-${canvasStudioState.nextId++}`; }
function canvasNodeTitle(type) { return ({ image: '图片资产', prompt: '提示词', generate: 'API 生成', generator: 'API 生成', result: '生成结果（兼容）', 'smart-image': 'Image', loop: '循环控制', minimax: 'MiniMax 视频', group: '智能分组', promptGroup: '提示词组', llm: 'LLM', midjourney: 'Midjourney', msgen: 'ModelScope 生成', video: '视频生成', rh: 'RunningHub 生成', comfy: 'ComfyUI 生成', ltxDirector: 'LTX Director', output: 'Output' })[type] || type; }
const canvasClassicNodeTypes = new Set(['llm', 'midjourney', 'msgen', 'video', 'rh', 'comfy', 'ltxDirector', 'output']);
const canvasClassicNodeDefaults = Object.freeze({
  llm: { llmProvider: '', model: '', mode: 'node', systemPrompt: '', chatInput: '', messages: [], outputText: '', llmInputHeight: 110, llmOutputHeight: 150, running: false },
  midjourney: { apiProvider: '', mode: 'imagine', size: '1:1', version: '6.1', speed: 'relax', inputs: [], running: false },
  msgen: { msgenModel: 'zimage', msWidth: 1024, msHeight: 1024, msCustomModel: '', msRatio: 'square', msResolution: '1k', count: 1, fitImage: false, inputs: [], running: false },
  video: { apiProvider: '', model: '', duration: 5, aspectRatio: '16:9', resolution: '', enhancePrompt: false, enableUpsample: false, watermark: false, cameraFixed: false, generateAudio: false, useFrameRoles: false, multimodal: false, tempShLinks: [], inputs: [], running: false },
  rh: { rhMode: 'app', rhPayment: 'plus', webappId: '', workflowId: '', instanceType: '', rhParams: {}, inputs: [], running: false },
  comfy: { mode: 'text', comfyWidth: 1024, comfyHeight: 1024, enhanceStrength: 0.5, enhanceUpscale: false, editUpscale: false, ratio: 'square', resolution: '1k', comfyWorkflow: '', comfyParams: {}, count: 1, inputs: [], running: false },
  ltxDirector: { globalPrompt: '', durationFrames: 121, durationSeconds: 5, frameRate: 24, customWidth: 0, customHeight: 0, timeline: [], inputs: [], running: false },
  output: { images: [], outputHistory: [] }
});
function canvasIsClassicCanvasNode(nodeOrType) { const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType?.type; return canvasClassicNodeTypes.has(type); }
function canvasIsGroupNode(nodeOrType) { const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType?.type; return type === 'group' || type === 'promptGroup'; }
function canvasEscape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function canvasGetNode(id) { return canvasStudioState.nodes.find(node => node.id === id) || null; }
const CANVAS_MEDIA_LANDSCAPE_SIZE = Object.freeze({ width: 360, height: 240 });
const CANVAS_MEDIA_PORTRAIT_SIZE = Object.freeze({ width: 240, height: 360 });
function canvasSingleVisualMedia(node) {
  const items = canvasNodeMediaItems(node);
  if (node?.type !== 'image' || items.length !== 1) return null;
  const item = items[0];
  return ['image', 'video'].includes(canvasMediaKind(item)) ? item : null;
}
function canvasMediaNodeSize(node) {
  const media = canvasSingleVisualMedia(node);
  const width = Number(media?.width || media?.naturalWidth || media?.asset?.width || 0);
  const height = Number(media?.height || media?.naturalHeight || media?.asset?.height || 0);
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const frame = ratio < 1 ? CANVAS_MEDIA_PORTRAIT_SIZE : CANVAS_MEDIA_LANDSCAPE_SIZE;
  const frameRatio = frame.width / frame.height;
  return ratio >= frameRatio
    ? { width: frame.width, height: Math.max(48, Math.round(frame.width / ratio)), ratio }
    : { width: Math.max(48, Math.round(frame.height * ratio)), height: frame.height, ratio };
}
function canvasIsFixedMediaNode(node) {
  return Boolean(canvasSingleVisualMedia(node));
}
function canvasNodeSizeLimits(node) {
  if (canvasIsFixedMediaNode(node)) {
    const size = canvasMediaNodeSize(node);
    return { minWidth: size.width, minHeight: size.height, defaultWidth: size.width, defaultHeight: size.height, fixed: true };
  }
  if (canvasIsGroupNode(node)) return { minWidth: 280, minHeight: 180, defaultWidth: 360, defaultHeight: 240 };
  if (node?.type === 'prompt') return { minWidth: 300, minHeight: 248, defaultWidth: 300, defaultHeight: 248 };
  if (node?.type === 'loop') return { minWidth: 260, minHeight: 220, defaultWidth: 260, defaultHeight: 220 };
  if (node?.type === 'minimax') return { minWidth: 720, minHeight: 520, defaultWidth: 900, defaultHeight: 620 };
  if (node?.type === 'llm') return { minWidth: 380, minHeight: 420, defaultWidth: 420, defaultHeight: 590 };
  if (node?.type === 'midjourney') return { minWidth: 300, minHeight: 300, defaultWidth: 380, defaultHeight: 430 };
  if (node?.type === 'msgen') return { minWidth: 300, minHeight: 300, defaultWidth: 380, defaultHeight: 450 };
  if (node?.type === 'video') return { minWidth: 320, minHeight: 320, defaultWidth: 400, defaultHeight: 470 };
  if (node?.type === 'rh') return { minWidth: 340, minHeight: 300, defaultWidth: 430, defaultHeight: 430 };
  if (node?.type === 'comfy') return { minWidth: 340, minHeight: 320, defaultWidth: 420, defaultHeight: 460 };
  if (node?.type === 'ltxDirector') return { minWidth: 720, minHeight: 520, defaultWidth: 1000, defaultHeight: 800 };
  if (node?.type === 'output') return { minWidth: 360, minHeight: 260, defaultWidth: 460, defaultHeight: 360 };
  return { minWidth: 260, minHeight: 178, defaultWidth: 260, defaultHeight: 178 };
}
function canvasNodeBounds(node) {
  if (!node) return { width: 232, height: 142 };
  const limits = canvasNodeSizeLimits(node);
  if (limits.fixed && !(Number(node.width) > 0 && Number(node.height) > 0)) return { width: limits.defaultWidth, height: limits.defaultHeight };
  return {
    width: Math.max(limits.minWidth, Number(node.width) || limits.defaultWidth),
    height: Math.max(limits.minHeight, Number(node.height) || limits.defaultHeight)
  };
}
function canvasNormalizeNodeSize(node) {
  if (!node) return;
  const bounds = canvasNodeBounds(node);
  node.width = bounds.width;
  node.height = bounds.height;
}
function canvasMinimaxSegmentId() { return `minimax-seg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
function canvasMinimaxTimelineTotal(node) {
  canvasMinimaxEnsureNode(node);
  return Math.max(1, (node.minimaxSegments || []).reduce((total, segment) => Math.max(total, Number(segment.start || 0) + Number(segment.duration || 0)), 0));
}
function canvasMinimaxEnsureNode(node) {
  if (!node || node.type !== 'minimax') return node;
  node.refs = node.refs && typeof node.refs === 'object' ? node.refs : { image: [], video: [], audio: [] };
  node.materials = Array.isArray(node.materials) ? node.materials : [];
  const duration = Math.min(30, Math.max(1, Number(node.duration) || 8));
  node.minimaxSegments = Array.isArray(node.minimaxSegments) && node.minimaxSegments.length ? node.minimaxSegments : [{ id: canvasMinimaxSegmentId(), start: 0, duration, prompt: '', refItems: [], trimIn: 0, trimOut: duration, result: null, results: [] }];
  node.minimaxSegments = node.minimaxSegments.map((segment, index) => {
    const safeDuration = Math.min(30, Math.max(1, Number(segment.duration) || duration));
    return {
      id: segment.id || canvasMinimaxSegmentId(),
      start: Math.max(0, Number(segment.start) || index * duration),
      duration: safeDuration,
      prompt: String(segment.prompt || ''),
      refs: segment.refs && typeof segment.refs === 'object' ? segment.refs : { image: [], video: [], audio: [] },
      refItems: Array.isArray(segment.refItems) ? segment.refItems.slice(0, 5) : [],
      trimIn: Math.max(0, Number(segment.trimIn) || 0),
      trimOut: Math.min(safeDuration, Math.max(0, Number(segment.trimOut) || safeDuration)),
      result: segment.result || null,
      results: Array.isArray(segment.results) ? segment.results : []
    };
  });
  node.selectedSegmentId = node.minimaxSegments.some(segment => segment.id === node.selectedSegmentId) ? node.selectedSegmentId : node.minimaxSegments[0].id;
  node.playhead = Math.min(canvasMinimaxTimelineTotalRaw(node), Math.max(0, Number(node.playhead) || 0));
  node.timelineZoom = Math.min(3, Math.max(.6, Number(node.timelineZoom) || 1));
  node.timelinePlaying = Boolean(node.timelinePlaying);
  node.minimaxMuted = Boolean(node.minimaxMuted);
  node.videoStatus = node.videoStatus || 'reserved';
  return node;
}
function canvasMinimaxTimelineTotalRaw(node) {
  return Math.max(1, (node.minimaxSegments || []).reduce((total, segment) => Math.max(total, Number(segment.start || 0) + Number(segment.duration || 0)), 0));
}
function canvasMinimaxSelectedSegment(node) {
  canvasMinimaxEnsureNode(node);
  return (node.minimaxSegments || []).find(segment => segment.id === node.selectedSegmentId) || node.minimaxSegments?.[0] || null;
}
function canvasGroupForNode(id) {
  return canvasStudioState.nodes.find(node => canvasIsGroupNode(node) && Array.isArray(node.items) && node.items.includes(id)) || null;
}
function canvasGroupMembers(group) {
  if (!group || !canvasIsGroupNode(group)) return [];
  const ids = new Set(Array.isArray(group.items) ? group.items : []);
  return canvasStudioState.nodes.filter(node => !canvasIsGroupNode(node) && ids.has(node.id));
}
function canvasNormalizeGroups() {
  canvasStudioState.nodes.forEach(node => { canvasNormalizeNodeSize(node); if (node.type === 'minimax') canvasMinimaxEnsureNode(node); });
  const existing = new Set(canvasStudioState.nodes.map(node => node.id));
  const assigned = new Set();
  canvasStudioState.nodes.filter(node => canvasIsGroupNode(node)).forEach(group => {
    group.items = [...new Set((Array.isArray(group.items) ? group.items : []).filter(id => existing.has(id) && id !== group.id && !assigned.has(id)))];
    group.items.forEach(id => assigned.add(id));
    group.width = Math.max(280, Number(group.width) || 360);
    group.height = Math.max(180, Number(group.height) || 240);
    group.collapsed = Boolean(group.collapsed);
  });
}
function canvasGroupMemberLabel(node) {
  return node?.title || canvasNodeTitle(node?.type || '节点');
}
function canvasGroupSummary(group) {
  const members = canvasGroupMembers(group);
  const counts = members.reduce((total, node) => {
    if (node.type === 'prompt') total.prompt += 1;
    else if (node.type === 'loop') total.loop += 1;
    else if (node.type === 'image' || node.type === 'smart-image') total.media += 1;
    else total.other += 1;
    return total;
  }, { prompt: 0, loop: 0, media: 0, other: 0 });
  return [counts.prompt ? `${counts.prompt} 提示词` : '', counts.media ? `${counts.media} 图片` : '', counts.loop ? `${counts.loop} 循环` : '', counts.other ? `${counts.other} 节点` : ''].filter(Boolean).join(' · ') || '双击或将已选节点加入分组';
}
function canvasGroupImageRefs(group) {
  return canvasGroupMembers(group)
    .flatMap(node => node.type === 'smart-image' && node.outputUrl ? [{ node, url: node.outputUrl, name: node.title || '生成结果' }] : canvasNodeMediaItems(node).filter(item => canvasMediaKind(item) === 'image').map(item => ({ node, url: item.url, name: item.name || node.title || '图片素材' })))
    .sort((left, right) => left.node.y - right.node.y || left.node.x - right.node.x)
    .slice(0, 9);
}
function canvasGroupThumbnailMarkup(group) {
  const refs = canvasGroupImageRefs(group);
  if (!refs.length) return '<div class="smart-group-empty">暂无图片成员</div>';
  return `<div class="smart-group-thumb-grid">${refs.map((item, index) => `<button type="button" class="smart-group-thumb" data-group-preview-url="${canvasEscape(item.url)}" data-group-preview-name="${canvasEscape(item.name)}"><img src="${canvasEscape(item.url)}" alt="${canvasEscape(item.name)}"><span>${index + 1}</span></button>`).join('')}</div>`;
}
function canvasPromptGroupNodeBody(node) {
  const promptMembers = canvasGroupMembers(node).filter(item => item.type === 'prompt');
  const compactMembers = canvasGroupMembers(node).filter(item => item.type === 'prompt' || item.type === 'loop').slice(0, 4);
  return `<div class="canvas-group-body smart-group-card"><div class="smart-group-summary"><strong>${promptMembers.length ? `包含 ${promptMembers.length} 个提示词` : '提示词组'}</strong><span>${canvasGroupSummary(node)}</span></div>${compactMembers.length ? `<div class="smart-group-compact-members">${compactMembers.map(item => `<span class="smart-group-member-node">${canvasEscape(canvasGroupMemberLabel(item))}</span>`).join('')}</div>` : ''}<div class="canvas-group-actions"><button class="btn bs" onclick="canvasStudioToggleGroup('${node.id}')">${node.collapsed ? '展开组' : '折叠组'}</button><button class="btn bs" onclick="canvasStudioAddSelectedToGroup('${node.id}')">加入选中</button><button class="btn bs" onclick="canvasStudioRemoveSelectedFromGroup('${node.id}')">移出选中</button><button class="btn bs" onclick="canvasAutoLayoutGroupById('${node.id}')">自动排版</button><button class="btn bs" onclick="canvasStudioUngroup('${node.id}')">解组</button></div></div>`;
}
function canvasAutoLayoutGroup(group) {
  if (!group || !canvasIsGroupNode(group)) return;
  const members = canvasGroupMembers(group);
  if (!members.length) return;
  const gap = 24;
  const padding = 24;
  const header = 42;
  const columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  members.forEach((member, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    member.x = group.x + padding + column * (232 + gap);
    member.y = group.y + header + padding + row * (142 + gap);
  });
  canvasRefreshGroupBounds(group, true);
  const membersWidth = columns * 232 + Math.max(0, columns - 1) * gap + padding * 2;
  const rows = Math.ceil(members.length / columns);
  const membersHeight = rows * 142 + Math.max(0, rows - 1) * gap + header + padding * 2;
  group.width = Math.max(280, membersWidth);
  group.height = Math.max(180, membersHeight);
}
function canvasRefreshGroupBounds(group, preservePosition = false) {
  if (!group || !canvasIsGroupNode(group)) return;
  const members = canvasGroupMembers(group);
  if (!members.length) return;
  const padding = 24;
  const header = 42;
  const minX = Math.min(...members.map(node => node.x));
  const minY = Math.min(...members.map(node => node.y));
  const maxX = Math.max(...members.map(node => node.x + canvasNodeBounds(node).width));
  const maxY = Math.max(...members.map(node => node.y + canvasNodeBounds(node).height));
  if (!preservePosition) {
    group.x = minX - padding;
    group.y = minY - header;
  }
  group.width = Math.max(280, maxX - minX + padding * 2);
  group.height = Math.max(180, maxY - minY + header + padding);
}
function canvasRefreshAllGroupBounds() {
  canvasStudioState.nodes.filter(node => canvasIsGroupNode(node)).forEach(group => canvasRefreshGroupBounds(group));
}
function canvasNodeIsHiddenByCollapsedGroup(node) {
  return !canvasIsGroupNode(node) && Boolean(canvasGroupForNode(node?.id)?.collapsed);
}
function canvasPortType(node, port, direction = 'out') {
  if (!node) return '';
  const classic = canvasIsClassicCanvasNode(node);
  const classicImageOut = classic && (node.type === 'midjourney' || node.type === 'msgen' || node.type === 'video' || node.type === 'rh' || node.type === 'comfy' || node.type === 'ltxDirector');
  const classicImageIn = classic && (node.type === 'midjourney' || node.type === 'msgen' || node.type === 'video' || node.type === 'rh' || node.type === 'comfy');
  if (direction === 'out') {
    if (node.type === 'image' || node.type === 'smart-image') return 'asset';
    if (node.type === 'prompt') return 'prompt';
    if (node.type === 'promptGroup') return 'prompt';
    if (canvasIsGeneratorNode(node)) return 'image';
    if (classic && node.type === 'llm') return 'prompt';
    if (classicImageOut) return 'image';
    if (node.type === 'loop' && port === 'out') return 'flow';
    return '';
  }
  if (node.type === 'loop' && port === 'input') return 'flow';
  if (canvasIsGeneratorNode(node) && port === 'loop') return 'flow';
  if (canvasIsGeneratorNode(node) && port === 'image') return 'asset';
  if (canvasIsGeneratorNode(node) && port === 'prompt') return 'prompt';
  if (classic && port === 'prompt' && node.type !== 'output') return 'prompt';
  if (classicImageIn && port === 'asset') return 'asset';
  if (classic && node.type === 'output' && port === 'image') return 'image';
  if ((node.type === 'result' || node.type === 'smart-image') && port === 'image') return 'image';
  return '';
}
function canvasNormalizeConnection(edge, index = 0) {
  const from = String(edge?.from || '');
  const to = String(edge?.to || '');
  if (!from || !to || from === to) return null;
  const source = canvasGetNode(from);
  const target = canvasGetNode(to);
  if (!source || !target) return null;
  const fromPort = String(edge?.fromPort || edge?.sourcePort || 'out');
  const toPort = String(edge?.toPort || edge?.targetPort || (canvasIsGeneratorNode(target) ? (source.type === 'prompt' ? 'prompt' : 'image') : 'image'));
  const type = String(edge?.type || canvasPortType(source, fromPort, 'out'));
  if (!canvasPortAllowed(from, fromPort, to, toPort)) return null;
  return { id: String(edge?.id || `canvas-connection-${index + 1}`), from, fromPort, to, toPort, type };
}
function canvasPortAllowed(from, fromPort, to, toPort) {
  const source = canvasGetNode(from);
  const target = canvasGetNode(to);
  if (!source || !target || source.id === target.id) return false;
  const sourceType = canvasPortType(source, fromPort, 'out');
  const targetType = canvasPortType(target, toPort, 'in');
  return Boolean(sourceType && targetType && sourceType === targetType);
}
function canvasConnectionAllowed(from, to) {
  const source = canvasGetNode(from);
  const target = canvasGetNode(to);
  if (!source || !target) return false;
  if (source.type === 'loop') return canvasIsGeneratorNode(target);
  if (source.type === 'image' || source.type === 'smart-image' || source.type === 'prompt') return canvasIsGeneratorNode(target);
  return canvasIsGeneratorNode(source) && (target.type === 'result' || target.type === 'smart-image');
}
function canvasPortPosition(node, port, direction) {
  const nodeEl = document.querySelector(`#canvas-studio-world .canvas-node[data-node-id="${CSS.escape(node.id)}"]`);
  const portEl = nodeEl?.querySelector(`.canvas-port[data-port-direction="${direction}"][data-port="${port}"]`)
    || (direction === 'out' ? nodeEl?.querySelector('.canvas-port-out') : nodeEl?.querySelector('.canvas-port-in'));
  if (portEl && nodeEl) {
    const nodeRect = nodeEl.getBoundingClientRect();
    const portRect = portEl.getBoundingClientRect();
    const board = document.getElementById('canvas-studio-board');
    const boardRect = board?.getBoundingClientRect();
    if (boardRect) {
      return {
        x: (portRect.left + portRect.width / 2 - boardRect.left - boardRect.width / 2) / canvasStudioState.viewport.scale - canvasStudioState.viewport.x / canvasStudioState.viewport.scale,
        y: (portRect.top + portRect.height / 2 - boardRect.top - boardRect.height / 2) / canvasStudioState.viewport.scale - canvasStudioState.viewport.y / canvasStudioState.viewport.scale
      };
    }
  }
  const width = canvasNodeBounds(node).width;
  const centerY = 89;
  if (direction === 'out') {
    if (node.type === 'loop') return { x: node.x + width, y: node.y + 110 };
    return { x: node.x + width, y: node.y + centerY };
  }
  if (node.type === 'loop' && port === 'input') return { x: node.x, y: node.y + 110 };
  if (canvasIsGeneratorNode(node) && port === 'loop') return { x: node.x, y: node.y + 24 };
  if (canvasIsGeneratorNode(node) && port === 'prompt') return { x: node.x, y: node.y + 70 };
  if (canvasIsGeneratorNode(node) && port === 'image') return { x: node.x, y: node.y + 124 };
  if (node.type === 'result' || node.type === 'smart-image') return { x: node.x, y: node.y + 89 };
  if (canvasIsClassicCanvasNode(node)) {
    if (port === 'prompt') return { x: node.x, y: node.y + 70 };
    if (port === 'asset') return { x: node.x, y: node.y + 124 };
    if (port === 'image') return { x: node.x, y: node.y + 89 };
  }
  return { x: node.x, y: node.y + centerY };
}
function canvasPortLabel(type) { return ({ asset: '图片', prompt: '提示词', image: '结果' })[type] || type; }
function canvasNodePorts(node) {
  if (node?.type === 'group') return '';
  if (node?.type === 'promptGroup') return '<div class="canvas-port canvas-port-out" data-port-direction="out" data-port="out" data-port-type="prompt" title="输出：提示词"></div>';
  if (node?.type === 'loop') return '<div class="canvas-port canvas-port-in canvas-port-in-loop" data-port-direction="in" data-port="input" data-port-type="flow" title="输入：循环工作流"></div><div class="canvas-port canvas-port-out" data-port-direction="out" data-port="out" data-port-type="flow" title="输出：循环工作流"></div>';
  const outputType = canvasPortType(node, 'out', 'out');
  const outputs = outputType ? `<div class="canvas-port canvas-port-out" data-port-direction="out" data-port="out" data-port-type="${outputType}" title="输出：${canvasPortLabel(outputType)}"></div>` : '';
  if (canvasIsClassicCanvasNode(node)) {
    if (node.type === 'output') return '<div class="canvas-port canvas-port-in" data-port-direction="in" data-port="image" data-port-type="image" title="输入：生成结果"></div>';
    const promptIn = '<div class="canvas-port canvas-port-in canvas-port-in-prompt" data-port-direction="in" data-port="prompt" data-port-type="prompt" title="输入：提示词"></div>';
    const assetIn = '<div class="canvas-port canvas-port-in canvas-port-in-image" data-port-direction="in" data-port="asset" data-port-type="asset" title="输入：参考图片"></div>';
    if (node.type === 'llm' || node.type === 'ltxDirector') return `${promptIn}${outputs}`;
    return `${promptIn}${assetIn}${outputs}`;
  }
  if (!canvasIsGeneratorNode(node) && node.type !== 'result' && node.type !== 'smart-image') return `${outputs}`;
  if (canvasIsGeneratorNode(node)) return `<div class="canvas-port canvas-port-in canvas-port-in-loop" data-port-direction="in" data-port="loop" data-port-type="flow" title="输入：循环控制"></div><div class="canvas-port canvas-port-in canvas-port-in-prompt" data-port-direction="in" data-port="prompt" data-port-type="prompt" title="输入：提示词"></div><div class="canvas-port canvas-port-in canvas-port-in-image" data-port-direction="in" data-port="image" data-port-type="asset" title="输入：参考图片"></div>${outputs}`;
  if (node.type === 'result' || node.type === 'smart-image') return `<div class="canvas-port canvas-port-in" data-port-direction="in" data-port="image" data-port-type="image" title="输入：生成结果"></div>${outputs}`;
}
function canvasSetModeLinkActive() {
  document.querySelectorAll('.sidebar-mode-link').forEach(link => link.classList.toggle('active', link.dataset.mode === 'canvas'));
}
function canvasStudioShellUiMarkup() {
  return `<nav class="smart-canvas-rail" id="smart-canvas-rail" aria-label="无限画布工具栏"><button type="button" class="smart-rail-btn" onclick="canvasStudioExit()" title="返回 ${BRAND.name}">‹</button><button type="button" class="smart-rail-btn" data-rail-action="toggle-create" title="创建节点">＋</button><button type="button" class="smart-rail-btn" data-rail-action="toggle-composer" title="显示 Composer">✎</button><button type="button" class="smart-rail-btn" onclick="openSmartCanvasWorkflow()" title="工作流">⌘</button><button type="button" class="smart-rail-btn" onclick="openSmartCanvasLog()" title="日志">□</button><button type="button" class="smart-rail-btn is-active" data-rail-action="toggle-create" title="节点面板">▦</button><div class="smart-rail-spacer"></div><button type="button" class="smart-rail-btn" onclick="canvasStudioResetView()" title="重置视图">☼</button><button type="button" class="smart-rail-btn" onclick="canvasStudioFitView()" title="适配画布">◎</button><button type="button" class="smart-rail-btn" data-rail-action="link-mode" title="连接模式">∞</button><button type="button" class="smart-rail-btn" onclick="openCanvasApiConfig()" title="API 设置">⚙</button><button type="button" class="smart-rail-btn is-green" onclick="canvasStudioSaveNow('manual')" title="保存工作区">↻</button><span class="smart-rail-brand">D X</span></nav><div class="smart-canvas-topbar" id="smart-canvas-topbar"><div class="smart-quick-toolbar collapsed" id="canvas-quick-toolbar"><button type="button" class="smart-topbar-chip smart-quick-toggle" onclick="toggleCanvasQuickToolbar()" title="快捷添加节点">＋ 节点</button><div class="smart-quick-items"><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('image',canvasStudioViewportCenter())">上传</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('prompt',canvasStudioViewportCenter())">提示词</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('loop',canvasStudioViewportCenter())">循环</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('llm',canvasStudioViewportCenter())">LLM</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('generate',canvasStudioViewportCenter())">API生成</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('msgen',canvasStudioViewportCenter())">MS生成</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('video',canvasStudioViewportCenter())">视频</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('minimax',canvasStudioViewportCenter())">MiniMax</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('rh',canvasStudioViewportCenter())">RH</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('comfy',canvasStudioViewportCenter())">ComfyUI</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('ltxDirector',canvasStudioViewportCenter())">LTX</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('output',canvasStudioViewportCenter())">Output</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioAddNode('group',canvasStudioViewportCenter())">分组</button></div></div><button type="button" class="smart-topbar-chip" onclick="canvasStudioFitView()">适配视图</button><button type="button" class="smart-topbar-chip" data-rail-action="toggle-composer">Composer</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioImport()">导入</button><button type="button" class="smart-topbar-chip" onclick="canvasStudioExport()">导出</button><button type="button" class="smart-topbar-chip" onclick="openCanvasApiConfig()">API 设置</button><button type="button" class="smart-topbar-chip" onclick="openSmartCanvasWorkflow()">工作流</button><button type="button" class="smart-topbar-chip" onclick="openSmartCanvasShortcuts()">快捷键</button><button type="button" class="smart-topbar-chip" onclick="openSmartCanvasLog()">日志</button><span class="smart-topbar-status" id="canvas-shell-save-status">新画布</span></div>`;
}
function injectCanvasStudioShellUi() {
  const board = document.getElementById('canvas-studio-board');
  if (!board || document.getElementById('smart-canvas-rail')) return;
  board.insertAdjacentHTML('afterbegin', canvasStudioShellUiMarkup());
  board.querySelectorAll('[data-rail-action="toggle-create"]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const rect = board.getBoundingClientRect();
      canvasStudioOpenCreateMenu({ clientX: rect.left + 220, clientY: rect.top + 96 });
    });
  });
  board.querySelectorAll('[data-rail-action="toggle-composer"]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      canvasStudioShowComposer();
    });
  });
  board.querySelector('[data-rail-action="link-mode"]')?.addEventListener('click', () => toast('拖动节点端口即可连接', 'ok'));
}

function renderCanvasStudio() {
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('workspace-main');
  if (main?.classList.contains('creative-mode-active')) exitCreativeMode();
  sidebar?.setAttribute('data-active-mode', 'canvas');
  document.body?.setAttribute('data-active-mode', 'canvas');
  document.body?.setAttribute('data-active-system', 'canvas');
  document.documentElement?.setAttribute('data-active-system', 'canvas');
  const inspector = document.querySelector('.right-inspector');
  const appShell = document.getElementById('app-shell');
  if (!main || !inspector) return;
  appShell?.classList.remove('canvas-right-inspector-hidden');
  sidebar?.setAttribute('data-active-mode', 'canvas');
  document.body?.setAttribute('data-active-mode', 'canvas');
  document.body?.setAttribute('data-active-system', 'canvas');
  document.documentElement?.setAttribute('data-active-system', 'canvas');
  if (canvasStudioState.active) {
    appShell?.classList.add('canvas-right-inspector-hidden');
    canvasSetModeLinkActive();
    renderCanvasStudioNodes();
    return;
  }
  main.dataset.previousCanvasHtml = main.innerHTML;
  inspector.dataset.previousCanvasHtml = inspector.innerHTML;
  canvasStudioState.active = true;
  const previous = canvasEditorSnapshot();
  canvasStudioState.viewport = { x: 0, y: 0, scale: 1 };
  canvasStudioState.selectedIds = [];
  canvasStudioState.selectedId = '';

  main.classList.add('canvas-studio-active');
  inspector.classList.add('canvas-studio-active');
  appShell?.classList.add('canvas-right-inspector-hidden');
  main.innerHTML = `<section class="canvas-studio lavans-smart-canvas" id="canvas-studio"><div class="smart-canvas-shell canvas-studio-board" id="canvas-studio-board"><div class="smart-canvas-world"><div class="canvas-studio-grid"></div><svg class="smart-canvas-connections canvas-studio-connections" id="canvas-studio-connections" aria-hidden="true"></svg><div class="smart-canvas-node-layer canvas-studio-world-layer" id="canvas-studio-world"></div></div><div class="smart-canvas-composer" id="composer"><div class="smart-composer-card"><div class="smart-composer-head"><span class="smart-composer-drag-handle" title="拖动面板">⋮⋮</span><select id="engineSelect" class="smart-engine-select"><option>API生成</option><option>火山引擎</option><option>MS生成</option><option>ComfyUI生成</option><option>RunningHub</option></select><div class="smart-kind-toggle" id="apiKindToggle"><button class="active" data-kind="image">图片</button><button data-kind="video">视频</button></div><button type="button" class="smart-composer-close" id="composerCloseBtn" title="关闭 Composer">×</button></div><div class="smart-composer-context" id="composerContextStatus">请先创建或选择 API 生成节点</div><div class="smart-input-thumbs" id="inputThumbsRow"></div><div class="smart-prompt-preview" id="inputPromptPreview"></div><div class="smart-prompt-row"><div class="smart-prompt-input" id="promptInput" contenteditable="true" data-placeholder="描述你想生成或编辑的图片..."></div><button class="smart-template-btn" id="composerTemplateBtn" type="button">模板库</button><div class="mention-picker" id="mentionPicker"></div><div class="prompt-resize" id="promptResize"></div></div><div class="smart-dynamic-params" id="dynamicParams"></div><div class="smart-composer-actions"><button class="smart-run-btn smart-cascade-run" id="cascadeRunBtn" type="button">一键运行</button><button class="smart-run-btn" id="runBtn" type="button">运行</button></div></div></div><div class="smart-canvas-selection-box canvas-studio-selection-box" id="canvas-studio-selection-box"></div><div class="canvas-studio-empty" id="canvas-studio-empty"><strong>智能画布</strong><span>双击空白处打开节点菜单，拖拽空白区域框选节点</span></div><div class="smart-create-menu" id="smart-create-menu"><div class="smart-create-grid"><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('image',canvasStudioViewportCenter())"><strong>上传</strong><span>图片、音频、视频都能导入</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('group',canvasStudioViewportCenter())"><strong>分组</strong><span>把提示词、图片、循环收进同一组</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('promptGroup',canvasStudioViewportCenter())"><strong>提示词组</strong><span>把多个提示词收进一组</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('prompt',canvasStudioViewportCenter())"><strong>提示词</strong><span>手写或用 LLM 生成文本</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('loop',canvasStudioViewportCenter())"><strong>循环</strong><span>控制运行轮数、批次和变量</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('minimax',canvasStudioViewportCenter())"><strong>MiniMax</strong><span>时间轴片段生成视频</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('llm',canvasStudioViewportCenter())"><strong>LLM</strong><span>对话式文本生成节点</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('midjourney',canvasStudioViewportCenter())"><strong>Midjourney</strong><span>MJ 文生图（尺寸/版本）</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('msgen',canvasStudioViewportCenter())"><strong>ModelScope 生成</strong><span>魔搭模型文生图</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('video',canvasStudioViewportCenter())"><strong>视频生成</strong><span>比例/时长文生视频</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('rh',canvasStudioViewportCenter())"><strong>RunningHub 生成</strong><span>App/工作流出图</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('comfy',canvasStudioViewportCenter())"><strong>ComfyUI 生成</strong><span>ComfyUI 工作流出图</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('ltxDirector',canvasStudioViewportCenter())"><strong>LTX Director</strong><span>时间线导演式视频</span></button><button class="smart-create-card" type="button" onclick="canvasStudioAddNode('output',canvasStudioViewportCenter())"><strong>Output</strong><span>汇总输出结果</span></button></div></div></div><button class="smart-canvas-back" type="button" onclick="canvasStudioExit()">返回画布列表</button><div class="smart-canvas-title">智能画布</div><button class="smart-arrange-btn" type="button" onclick="canvasStudioFitView()">整理选中</button><button class="smart-workflow-toggle" type="button" onclick="openSmartCanvasWorkflow()">工作流</button><button class="smart-shortcut-toggle" type="button" onclick="openSmartCanvasShortcuts()">快捷键</button><button class="smart-log-toggle" type="button" onclick="openSmartCanvasLog()">日志</button><button class="smart-asset-toggle" type="button" onclick="toggleCanvasAssetLibrary()">资产库</button><aside class="smart-asset-panel" id="smart-asset-panel"><div class="smart-asset-head"><strong>资产库</strong><button type="button" onclick="openCanvasAssetManager()">管理</button><button type="button" onclick="toggleCanvasAssetLibrary(false)">收起</button></div><div class="smart-asset-tabs"><button class="active" data-asset-type="image">图片资产</button><button data-asset-type="workflow">工作流</button></div><select id="canvas-asset-lib-select" onchange="canvasAssetSetLib(this.value)"></select><select id="canvas-asset-cat-select" onchange="canvasAssetSetCat(this.value)"></select><div class="smart-asset-drop" id="canvas-asset-drop">把画布图片拖到这里保存到当前文件夹</div><div class="smart-asset-grid" id="canvas-asset-grid"></div></aside><div class="smart-minimap" id="smart-minimap"><div class="smart-minimap-content"></div><div class="smart-minimap-viewport"></div></div><div class="smart-canvas-modal" id="canvas-smart-workflow-modal" onclick="closeSmartCanvasWorkflow(event)"><div class="smart-canvas-dialog smart-workflow-dialog" onclick="event.stopPropagation()"><div class="smart-canvas-dialog-head"><div><strong>工作流</strong><span>导出选中节点，或追加导入 JSON/ZIP 工作流</span></div><button type="button" onclick="closeSmartCanvasWorkflow()" aria-label="关闭">×</button></div><div class="smart-workflow-actions"><button type="button" class="smart-workflow-action" onclick="canvasStudioExport();closeSmartCanvasWorkflow()"><strong>导出 JSON</strong><span>导出选中节点（未选则全部）</span></button><button type="button" class="smart-workflow-action" onclick="canvasStudioExportZip();closeSmartCanvasWorkflow()"><strong>导出 ZIP（含资源）</strong><span>打包选中节点及引用图片</span></button><button type="button" class="smart-workflow-action" onclick="exportCanvasWorkflowToLibrary();closeSmartCanvasWorkflow()"><strong>导出到库</strong><span>把工作流存到资产库的工作流分组复用</span></button><button type="button" class="smart-workflow-action" onclick="canvasStudioImport();closeSmartCanvasWorkflow()"><strong>导入（追加）</strong><span>把 JSON/ZIP 工作流追加到当前画布</span></button></div></div></div><div class="smart-canvas-modal" id="canvas-smart-log-modal" onclick="closeSmartCanvasLog(event)"><div class="smart-canvas-dialog smart-log-dialog" onclick="event.stopPropagation()"><div class="smart-canvas-dialog-head"><div><strong>生成日志</strong><span>画布运行、保存与错误记录</span></div><button type="button" onclick="closeSmartCanvasLog()" aria-label="关闭">×</button></div><div class="smart-log-toolbar"><button type="button" class="is-active" onclick="renderSmartCanvasLog('all',this)">全部</button><button type="button" onclick="renderSmartCanvasLog('info',this)">信息</button><button type="button" onclick="renderSmartCanvasLog('success',this)">成功</button><button type="button" onclick="renderSmartCanvasLog('error',this)">错误</button><button type="button" class="smart-log-clear" onclick="clearSmartCanvasLog()">清空</button></div><div class="smart-log-list" id="canvas-smart-log-list"></div></div></div><div class="smart-canvas-modal" id="canvas-smart-shortcuts-modal" onclick="closeSmartCanvasShortcuts(event)"><div class="smart-canvas-dialog smart-shortcut-dialog" onclick="event.stopPropagation()"><div class="smart-canvas-dialog-head"><div><strong>快捷键</strong><span>画布编辑器常用操作</span></div><button type="button" onclick="closeSmartCanvasShortcuts()" aria-label="关闭">×</button></div><div class="smart-shortcut-list"><div><kbd>Shift</kbd><span>追加框选节点</span></div><div><kbd>中键 / 空格 + 左键</kbd><span>平移画布</span></div><div><kbd>滚轮</kbd><span>以鼠标位置为中心缩放</span></div><div><kbd>Ctrl / Cmd + Z</kbd><span>撤销</span></div><div><kbd>Ctrl / Cmd + Shift + Z</kbd><span>重做</span></div><div><kbd>Ctrl / Cmd + C</kbd><span>复制选中节点</span></div><div><kbd>Ctrl / Cmd + V</kbd><span>粘贴节点</span></div><div><kbd>Delete / Backspace</kbd><span>删除节点或连线</span></div><div><kbd>双击空白处</kbd><span>新建图片节点</span></div><div><kbd>Esc</kbd><span>取消当前连线</span></div></div></div></div><div class="smart-canvas-modal" id="canvas-prompt-template-modal" onclick="closeCanvasPromptTemplate(event)"><div class="smart-canvas-dialog smart-template-dialog" onclick="event.stopPropagation()"><div class="smart-canvas-dialog-head"><div><strong>提示词模板库</strong><span>选择预设提示词，应用到当前节点</span></div><button type="button" onclick="closeCanvasPromptTemplate()" aria-label="关闭">×</button></div><div class="smart-template-toolbar"><input id="canvas-prompt-template-search" type="text" placeholder="搜索模板…" oninput="canvasPromptTemplateSearchInput()"><select id="canvas-prompt-template-lib" onchange="canvasPromptTemplateSetLib(this.value)"></select></div><div class="smart-template-cats" id="canvas-prompt-template-cats"></div><div class="smart-template-layout"><div class="smart-template-list" id="canvas-prompt-template-list"></div><div class="smart-template-detail" id="canvas-prompt-template-detail"></div></div><div class="smart-template-actions"><button type="button" class="smart-run-btn" onclick="applyCanvasPromptTemplate('positive')">应用正向提示词</button><button type="button" class="smart-run-btn" onclick="applyCanvasPromptTemplate('full')">应用完整模板</button></div></div></div><div class="smart-canvas-modal" id="canvas-image-edit-modal" onclick="closeCanvasImageEditor()"><div class="smart-canvas-dialog image-edit-panel" onclick="event.stopPropagation()"><div class="smart-canvas-dialog-head"><div><strong>编辑图片</strong><span>裁剪或扩展当前图片</span></div><button type="button" onclick="closeCanvasImageEditor()" aria-label="关闭">×</button></div><div class="image-edit-mode"><button type="button" class="active" data-image-edit-mode="crop" onclick="setCanvasImageEditMode('crop')">裁剪</button><button type="button" data-image-edit-mode="outpaint" onclick="setCanvasImageEditMode('outpaint')">扩展</button><button type="button" data-image-edit-mode="mask" onclick="setCanvasImageEditMode('mask')">遮罩</button><button type="button" data-image-edit-mode="brush" onclick="setCanvasImageEditMode('brush')">画笔</button><button type="button" data-image-edit-mode="resize" onclick="setCanvasImageEditMode('resize')">缩放</button><button type="button" data-image-edit-mode="grid" onclick="setCanvasImageEditMode('grid')">宫格</button></div><div id="canvas-image-crop-tools" class="image-edit-tools"><button class="active" type="button" data-crop-ratio="free" onclick="setCanvasCropRatio('free',this)">自由</button><button type="button" data-crop-ratio="1:1" onclick="setCanvasCropRatio('1:1',this)">1:1</button><button type="button" data-crop-ratio="4:3" onclick="setCanvasCropRatio('4:3',this)">4:3</button><button type="button" data-crop-ratio="3:4" onclick="setCanvasCropRatio('3:4',this)">3:4</button><button type="button" data-crop-ratio="16:9" onclick="setCanvasCropRatio('16:9',this)">16:9</button><button type="button" data-crop-ratio="9:16" onclick="setCanvasCropRatio('9:16',this)">9:16</button></div><div id="canvas-image-outpaint-hint" class="image-edit-tools" style="display:none"><span>拖动裁剪框向外扩展，白色区域将被填充</span></div><div id="canvas-image-mask-tools" class="image-edit-tools" style="display:none"><label>笔刷 <input id="canvas-mask-brush-size" type="range" min="4" max="160" value="42"></label><button class="image-edit-btn secondary" type="button" onclick="undoCanvasEditDrawing()">撤销</button><button class="image-edit-btn secondary" type="button" onclick="redoCanvasEditDrawing()">恢复</button><button class="image-edit-btn secondary" type="button" onclick="clearCanvasEditDrawing()">清空</button><span>白色区域为要编辑的遮罩</span></div><div id="canvas-image-brush-tools" class="image-edit-tools" style="display:none"><button class="image-edit-btn primary" type="button" data-canvas-brush-tool="free" onclick="setCanvasBrushTool('free')">自由</button><button class="image-edit-btn secondary" type="button" data-canvas-brush-tool="rect" onclick="setCanvasBrushTool('rect')">矩形</button><button class="image-edit-btn secondary" type="button" data-canvas-brush-tool="ellipse" onclick="setCanvasBrushTool('ellipse')">椭圆</button><label>颜色 <input id="canvas-paint-brush-color" type="color" value="#ff2d55"></label><label>笔刷 <input id="canvas-paint-brush-size" type="range" min="2" max="80" value="14"></label><button class="image-edit-btn secondary" type="button" onclick="undoCanvasEditDrawing()">撤销</button><button class="image-edit-btn secondary" type="button" onclick="redoCanvasEditDrawing()">恢复</button><button class="image-edit-btn secondary" type="button" onclick="clearCanvasEditDrawing()">清空</button></div><div id="canvas-image-resize-tools" class="image-edit-tools" style="display:none"><label>倍数 <input id="canvas-image-resize-scale" type="range" min="0.05" max="1" step="0.05" value="0.5" oninput="canvasResizeScaleChanged()"></label><span id="canvas-image-resize-resolution"></span></div><div id="canvas-image-grid-tools" class="image-edit-tools" style="display:none"><div class="grid-preset-row"><span>预设</span><button class="grid-preset-btn" type="button" onclick="applyCanvasGridPreset(1,2)">1×2</button><button class="grid-preset-btn" type="button" onclick="applyCanvasGridPreset(2,1)">2×1</button><button class="grid-preset-btn" type="button" onclick="applyCanvasGridPreset(2,2)">2×2</button><button class="grid-preset-btn" type="button" onclick="applyCanvasGridPreset(2,3)">2×3</button><button class="grid-preset-btn" type="button" onclick="applyCanvasGridPreset(3,2)">3×2</button><button class="grid-preset-btn" type="button" onclick="applyCanvasGridPreset(3,3)">3×3</button></div><label>横向线 <input id="canvas-grid-h-lines" type="number" min="0" max="20" value="2"></label><label>竖向线 <input id="canvas-grid-v-lines" type="number" min="0" max="20" value="2"></label></div><div class="image-edit-stage"><div class="image-edit-stage-inner"><div id="canvas-crop-canvas" class="crop-canvas"><img id="canvas-crop-image" alt="裁剪源图"><canvas id="canvas-edit-draw-canvas" class="edit-draw-canvas"></canvas><canvas id="canvas-edit-text-canvas" class="edit-text-canvas"></canvas><div id="canvas-crop-box" class="crop-box"><div class="crop-handle" data-crop-handle="nw"></div><div class="crop-handle" data-crop-handle="ne"></div><div class="crop-handle" data-crop-handle="sw"></div><div class="crop-handle" data-crop-handle="se"></div></div></div></div></div><div class="image-edit-actions"><button type="button" class="image-edit-btn primary" id="canvas-image-edit-apply" onclick="applyCanvasImageEdit()">应用裁剪</button></div></div></div><div class="smart-canvas-modal" id="canvas-asset-manager-modal" onclick="closeCanvasAssetManager(event)"><div class="smart-canvas-dialog asset-manager-dialog" onclick="event.stopPropagation()"><div class="smart-canvas-dialog-head"><div><strong>资产库管理</strong><span>管理图片资产和工作流</span></div><button type="button" onclick="closeCanvasAssetManager()" aria-label="关闭">×</button></div><div class="asset-manager-tabs"><button type="button" class="active" data-manager-tab="image" onclick="switchCanvasAssetManagerTab('image',this)">图片资产</button><button type="button" data-manager-tab="workflow" onclick="switchCanvasAssetManagerTab('workflow',this)">工作流</button></div><div class="asset-manager-body" id="canvas-asset-manager-body"></div></div></div><input id="canvas-studio-import" type="file" accept="application/json,.json,.zip,application/zip" hidden><div id="canvas-output-lightbox" class="canvas-output-lightbox" onclick="closeCanvasStudioLightbox()"><div class="canvas-output-lightbox-shell" onclick="event.stopPropagation()"><div class="canvas-output-preview"><div id="canvas-output-compare-container" class="canvas-output-compare"><img id="canvas-output-compare-result" alt="结果图"><div id="canvas-output-compare-original-wrap" class="canvas-output-compare-original-wrap"><img id="canvas-output-compare-original" alt="原图"></div><div id="canvas-output-compare-slider" class="canvas-output-compare-slider"><div class="canvas-output-compare-handle">⟷</div></div></div><img id="canvas-output-lightbox-img" class="canvas-output-single-img" src="" alt="预览"><div class="canvas-output-preview-bar"><div id="canvas-output-resolution" class="canvas-output-resolution">--</div><div class="canvas-output-preview-actions"><button id="canvas-output-download-btn" class="canvas-preview-icon-btn" type="button" title="下载">↓</button><button id="canvas-output-download-all-btn" class="canvas-preview-icon-btn" type="button" title="下载全部" style="display:none">⇩</button><button class="canvas-preview-icon-btn" type="button" title="关闭" onclick="closeCanvasStudioLightbox()">×</button></div></div></div><div id="canvas-output-prompt-panel" class="canvas-output-prompt-panel"><div id="canvas-output-prompt-text" class="canvas-output-prompt-text"></div><div class="canvas-output-prompt-actions"><button id="canvas-output-copy-prompt-btn" class="canvas-preview-text-btn" type="button">复制提示词</button><button id="canvas-output-rerun-btn" class="canvas-preview-text-btn" type="button">重新运行</button></div></div></div></div><div id="canvas-link-create-menu" class="canvas-link-create-menu"></div><div id="canvas-node-input-menu" class="canvas-node-port-menu"></div><div id="canvas-node-output-menu" class="canvas-node-port-menu"></div></div></section>`;
  inspector.innerHTML = '';
  canvasStudioSetupCreateMenu();
  injectCanvasStudioShellUi();
  bindCanvasComposer();
  document.getElementById('canvas-studio-import')?.addEventListener('change', event => canvasStudioImportFile(event.target));
  canvasStudioLog('智能画布已打开', 'info');
  bindCanvasStudioBoard();
  bindCanvasStudioMinimap();
  bindCanvasStudioShortcuts();
  renderCanvasStudioNodes();
  canvasStudioLoadConfig();
  canvasStudioLoadWorkspace();
}

function canvasStudioSetupCreateMenu() {
  const menu = document.getElementById('smart-create-menu');
  const board = document.getElementById('canvas-studio-board');
  if (!menu || !board || menu.dataset.bound === 'true') return;
  menu.dataset.bound = 'true';
  menu.setAttribute('role', 'menu');
  menu.querySelectorAll('[data-create-type]').forEach(card => {
    card.setAttribute('role', 'menuitem');
    card.addEventListener('click', event => {
      event.preventDefault();
      const type = card.dataset.createType || 'image';
      const point = canvasStudioState.createMenuPoint || canvasStudioViewportCenter();
      menu.classList.remove('open');
      canvasStudioState.createMenuPoint = null;
      canvasStudioAddNode(type, point);
    });
  });
  board.addEventListener('pointerdown', event => {
    if (!menu.classList.contains('open')) return;
    if (!event.target.closest('#smart-create-menu')) menu.classList.remove('open');
  }, true);
}
function canvasStudioOpenCreateMenu(event) {
  const menu = document.getElementById('smart-create-menu');
  const board = document.getElementById('canvas-studio-board');
  if (!menu || !board) return;
  const rect = board.getBoundingClientRect();
  const point = canvasStudioPointFromEvent(event);
  canvasStudioState.createMenuPoint = point;
  menu.classList.add('open');
  const width = Math.min(500, Math.max(280, rect.width - 28));
  const height = menu.offsetHeight || 210;
  const left = Math.max(14, Math.min(event.clientX - rect.left - width / 2, rect.width - width - 14));
  const top = Math.max(14, Math.min(event.clientY - rect.top - 18, rect.height - height - 14));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.width = `${width}px`;
}

function canvasStudioViewportCenter() {
  const board = document.getElementById('canvas-studio-board');
  if (!board) return { x: 0, y: 0 };
  return canvasStudioPointFromEvent({ clientX: board.getBoundingClientRect().left + board.clientWidth / 2, clientY: board.getBoundingClientRect().top + board.clientHeight / 2 });
}

function bindCanvasStudioBoard() {
  const board = document.getElementById('canvas-studio-board');
  if (!board || board.dataset.bound === 'true') return;
  board.dataset.bound = 'true';
  let gesture = null;
  const isCanvasBackground = target => target === board || target.classList?.contains('canvas-studio-grid') || target.classList?.contains('canvas-studio-empty') || target.classList?.contains('smart-canvas-world') || target.classList?.contains('smart-canvas-node-layer');
  const clearGesture = event => {
    if (canvasStudioState.connect) {
      canvasCommitConnectionAtPoint(event);
      canvasStudioState.connect = null;
      clearCanvasConnectionPreview();
      renderCanvasStudioConnections();
      updateCanvasStudioCounts();
      return;
    }
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    board.releasePointerCapture?.(event.pointerId);
    board.classList.remove('is-panning', 'is-selecting');
    canvasStudioState.selectionBox = null;
    document.getElementById('canvas-studio-selection-box')?.remove();
    if (current.type === 'pan') canvasEditorCommit(current.before, 'viewport');
  };
  // 中键平移必须在捕获阶段抢先处理：节点及其内部控件会消费 pointerdown，
  // 冒泡阶段无法稳定收到节点上的中键事件。
  board.addEventListener('pointerdown', event => {
    if (event.button !== 1) return;
    const before = canvasEditorSnapshot();
    gesture = { type: 'pan', x: event.clientX, y: event.clientY, originX: canvasStudioState.viewport.x, originY: canvasStudioState.viewport.y, before };
    board.classList.add('is-panning');
    board.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, true);
  board.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && !isCanvasBackground(event.target)) return;
    if (event.button === 1) return;
    const before = canvasEditorSnapshot();
    if (canvasStudioState.spacePressed) {
      gesture = { type: 'pan', x: event.clientX, y: event.clientY, originX: canvasStudioState.viewport.x, originY: canvasStudioState.viewport.y, before };
      board.classList.add('is-panning');
    } else {
      const boardPoint = canvasStudioBoardPointFromEvent(event);
      const point = canvasStudioPointFromEvent(event);
      gesture = { type: 'select', x: point.x, y: point.y, boardX: boardPoint.x, boardY: boardPoint.y, before, additive: event.shiftKey, baseSelection: event.shiftKey ? [...(canvasStudioState.selectedIds || [])] : [] };
      canvasStudioState.selectionBox = { x: point.x, y: point.y, width: 0, height: 0 };
      if (!event.shiftKey) canvasSetSelection([]);
      const box = document.createElement('div');
      box.id = 'canvas-studio-selection-box';
      box.className = 'canvas-studio-selection-box';
      board.appendChild(box);
      board.classList.add('is-selecting');
    }
    board.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  board.addEventListener('pointermove', event => {
    if (canvasStudioState.connect) {
      renderCanvasConnectionPreview(event);
      return;
    }
    if (!gesture) return;
    if (gesture.type === 'pan') {
      canvasStudioState.viewport.x = gesture.originX + event.clientX - gesture.x;
      canvasStudioState.viewport.y = gesture.originY + event.clientY - gesture.y;
      applyCanvasStudioViewport();
      return;
    }
    const point = canvasStudioPointFromEvent(event);
    const boardPoint = canvasStudioBoardPointFromEvent(event);
    const left = Math.min(gesture.x, point.x);
    const top = Math.min(gesture.y, point.y);
    const width = Math.abs(point.x - gesture.x);
    const height = Math.abs(point.y - gesture.y);
    canvasStudioState.selectionBox = { x: left, y: top, width, height };
    const selected = canvasStudioState.nodes.filter(node => {
      const bounds = canvasNodeBounds(node);
      return node.x + bounds.width >= left && node.x <= left + width && node.y + bounds.height >= top && node.y <= top + height;
    }).map(node => node.id);
    canvasSetSelection(gesture.additive ? [...new Set([...gesture.baseSelection, ...selected])] : selected);
    canvasStudioRenderSelectionBox({ x: gesture.boardX, y: gesture.boardY }, boardPoint);
  });
  board.addEventListener('pointerup', clearGesture, true);
  board.addEventListener('pointercancel', clearGesture, true);
  board.addEventListener('dragover', event => {
    if (![...(event.dataTransfer?.types || [])].includes('application/x-canvas-asset')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  board.addEventListener('drop', event => {
    if (![...(event.dataTransfer?.types || [])].includes('application/x-canvas-asset')) return;
    event.preventDefault();
    let asset = null;
    try { asset = JSON.parse(event.dataTransfer.getData('application/x-canvas-asset') || '{}'); } catch (_error) {}
    if (!asset?.url) return;
    const point = canvasStudioPointFromEvent(event);
    const before = canvasEditorSnapshot();
    const kind = asset.kind === 'video' ? 'video' : 'image';
    const node = { id: canvasNodeId('image'), type: 'image', x: point.x, y: point.y, title: kind === 'video' ? '视频资产' : '图片资产', mediaItems: [{ id: canvasNodeId('media'), kind, url: asset.url, name: asset.name || (kind === 'video' ? '资产视频' : '资产图片'), assetId: asset.id || '' }], mediaUrl: asset.url, mediaName: asset.name || '资产', createdAt: Date.now() };
    canvasNormalizeNodeSize(node);
    canvasStudioState.nodes.push(node);
    canvasSetSelection([node.id]);
    canvasEditorCommit(before, 'drop-asset-from-library');
    renderCanvasStudioNodes();
    canvasScheduleSave();
  });
  board.addEventListener('wheel', event => {
    if (event.target.closest('textarea,input,select,[contenteditable="true"]')) return;
    event.preventDefault();
    const before = canvasEditorSnapshot();
    const rect = board.getBoundingClientRect();
    const pointerX = event.clientX - rect.left - rect.width / 2;
    const pointerY = event.clientY - rect.top - rect.height / 2;
    const oldScale = canvasStudioState.viewport.scale;
    const nextScale = Math.min(2.5, Math.max(.35, oldScale * (event.deltaY < 0 ? 1.1 : .9)));
    if (nextScale === oldScale) return;
    const worldX = (pointerX - canvasStudioState.viewport.x) / oldScale;
    const worldY = (pointerY - canvasStudioState.viewport.y) / oldScale;
    canvasStudioState.viewport.scale = nextScale;
    canvasStudioState.viewport.x = pointerX - worldX * nextScale;
    canvasStudioState.viewport.y = pointerY - worldY * nextScale;
    applyCanvasStudioViewport();
    canvasEditorCommit(before, 'zoom');
  }, { passive: false });
  board.addEventListener('dblclick', event => { if (isCanvasBackground(event.target)) canvasStudioOpenCreateMenu(event); });
  const composer = document.getElementById('composer');
  const composerHandle = composer?.querySelector('.smart-composer-drag-handle');
  if (composer && composerHandle && composer.dataset.dragBound !== 'true') {
    composer.dataset.dragBound = 'true';
    composerHandle.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const start = { x: event.clientX, y: event.clientY, left: composer.offsetLeft, top: composer.offsetTop };
      const move = moveEvent => {
        const left = Math.max(12, start.left + moveEvent.clientX - start.x);
        const top = Math.max(12, start.top + moveEvent.clientY - start.y);
        composer.style.left = `${left}px`;
        composer.style.top = `${top}px`;
        composer.style.right = 'auto';
        composer.style.bottom = 'auto';
        canvasStudioState.composer = { ...(canvasStudioState.composer || {}), visible: true, left, top };
      };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
    });
  }
  applyCanvasStudioViewport();
  if (typeof ResizeObserver === 'function' && board.dataset.resizeObserved !== 'true') {
    board.dataset.resizeObserved = 'true';
    const observer = new ResizeObserver(() => {
      applyCanvasStudioViewport();
      renderCanvasStudioConnections();
    });
    observer.observe(board);
  }
}

function canvasStudioPointFromEvent(event) {
  const board = document.getElementById('canvas-studio-board');
  if (!board) return { x: 0, y: 0 };
  const rect = board.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  const originX = board.clientWidth / 2 + canvasStudioState.viewport.x;
  const originY = board.clientHeight / 2 + canvasStudioState.viewport.y;
  return {
    x: (localX - originX) / canvasStudioState.viewport.scale,
    y: (localY - originY) / canvasStudioState.viewport.scale
  };
}
function canvasStudioBoardPointFromEvent(event) {
  const board = document.getElementById('canvas-studio-board');
  if (!board) return { x: 0, y: 0 };
  const rect = board.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function canvasStudioRenderSelectionBox(start, end) {
  const box = document.getElementById('canvas-studio-selection-box');
  if (!box) return;
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
}

function canvasWorkspaceSnapshot() { canvasNormalizeGroups(); return { version: 2, viewport: { ...canvasStudioState.viewport }, nodes: canvasStudioState.nodes.map(node => { const snapshot = { ...node, apiProvider: node.apiProvider || canvasStudioState.canvasConfig?.primaryProviderId || '', mediaUrl: node.asset?.url || '', status: node.status === 'running' ? 'idle' : node.status, outputHistory: Array.isArray(node.outputHistory) ? node.outputHistory.slice(-100) : [], items: canvasIsGroupNode(node) ? [...(node.items || [])] : undefined }; if (node.type === 'prompt') canvasSetPromptValue(snapshot, canvasPromptValue(node)); return snapshot; }), connections: canvasClone(canvasStudioState.connections).map((edge, index) => ({ id: edge.id || `canvas-connection-${index + 1}`, from: edge.from, fromPort: edge.fromPort || 'out', to: edge.to, toPort: edge.toPort || 'image', type: edge.type || '' })), nextId: canvasStudioState.nextId }; }
function canvasSetSaveStatus(value) { const target = document.getElementById('canvas-save-status'); if (target) target.textContent = value; }
function canvasScheduleSave() { if (!canvasStudioState.active) return; clearTimeout(canvasStudioState.saveTimer); canvasSetSaveStatus('待保存'); canvasStudioState.saveTimer = setTimeout(() => canvasStudioSaveNow('auto'), 600); }
async function canvasStudioSaveNow(reason = 'manual') { if (!canvasStudioState.active) return; try { canvasSetSaveStatus('保存中'); const response = await fetch('/api/canvas/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: canvasWorkspaceSnapshot(), reason, canvasId: canvasStudioCanvasId, projectId: canvasStudioProjectId, kind: 'classic' }) }); const data = await response.json().catch(() => ({})); if (!response.ok || !data.success) throw new Error(data.error || '保存失败'); canvasStudioState.lastSavedAt = data.workspace?.savedAt || ''; canvasSetSaveStatus('已保存'); canvasStudioLog(`画布保存完成（${reason}）`, 'success'); canvasStudioLoadHistory(); } catch (error) { canvasSetSaveStatus('保存失败'); canvasStudioLog(`画布保存失败：${error.message || '未知错误'}`, 'error'); } }
function canvasApplyWorkspace(workspace) { const data = workspace || {}; canvasStudioState.viewport = { x: Number(data.viewport?.x) || 0, y: Number(data.viewport?.y) || 0, scale: Math.min(2.5, Math.max(.35, Number(data.viewport?.scale) || 1)) }; canvasStudioState.nodes = Array.isArray(data.nodes) ? data.nodes.map(node => { const normalized = { ...node, apiProvider: node.apiProvider || canvasStudioState.canvasConfig?.primaryProviderId || '', mediaUrl: node.asset?.url || node.mediaUrl || '', status: node.status === 'running' ? 'idle' : node.status || 'idle', error: node.error || '', outputUrl: node.outputUrl || '', ratio: node.ratio || 'square', resolution: String(node.resolution || '1k').toLowerCase(), customRatio: node.customRatio || '', customSize: node.customSize || '', customRatioWidth: node.customRatioWidth || '', customRatioHeight: node.customRatioHeight || '', customWidth: node.customWidth || '', customHeight: node.customHeight || '', inputs: Array.isArray(node.inputs) ? node.inputs : [], items: canvasIsGroupNode(node) ? [...(node.items || [])] : undefined, collapsed: canvasIsGroupNode(node) ? Boolean(node.collapsed) : undefined, width: canvasIsGroupNode(node) ? Math.max(280, Number(node.width) || 360) : undefined, height: canvasIsGroupNode(node) ? Math.max(180, Number(node.height) || 240) : undefined }; if (normalized.type === 'prompt') canvasSetPromptValue(normalized, canvasPromptValue(normalized)); return normalized; }) : []; canvasNormalizeGroups(); canvasStudioState.connections = Array.isArray(data.connections) ? data.connections.map((edge, index) => canvasNormalizeConnection(edge, index)).filter(Boolean) : []; canvasStudioState.nextId = Math.max(1, Number(data.nextId) || canvasStudioState.nodes.length + 1); canvasStudioState.selectedConnectionId = ''; canvasNormalizeSelection(); }
async function canvasStudioLoadConfig() {
  try {
    const data = await api('/api/canvas/config');
    if (data.success && data.config?.imageModel) {
      canvasModelOptions.image = [{ value: data.config.imageModel, label: data.config.imageModel }];
      canvasStudioState.canvasConfig = data.config;
      renderCanvasStudioNodes();
    }
  } catch (_error) {}
}

async function openCanvasApiConfig() {
  let cfg = canvasStudioState.canvasConfig || { baseUrl: '', apiKeyMasked: '', imageModel: 'gpt-image-2' };
  try { const data = await api('/api/canvas/config'); if (data.success) cfg = data.config; } catch (_error) {}
  const overlay = document.createElement('div');
  overlay.id = 'canvas-api-config-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
  overlay.innerHTML = `<div style="background:var(--pn);border:1px solid var(--bd);border-radius:14px;padding:24px 32px;max-width:420px;width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="font-size:16px;font-weight:800;color:var(--tx);margin-bottom:18px">无限画布接口设置</div><label style="display:block;font-size:11px;color:var(--t2);margin-bottom:4px">API Key（${cfg.hasKey ? '已设置' : '未设置'}）</label><input id="canvas-config-key" type="text" placeholder="sk-..." value="${cfg.apiKeyMasked || ''}" onfocus="if(this.value==='${cfg.apiKeyMasked || ''}')this.value=''" style="width:100%;padding:8px 10px;font-size:12px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;font-family:monospace;margin-bottom:14px"><label style="display:block;font-size:11px;color:var(--t2);margin-bottom:4px">画布 API URL</label><input id="canvas-config-url" type="text" placeholder="https://api.openlux.ai/v1" value="${cfg.baseUrl || ''}" style="width:100%;padding:8px 10px;font-size:12px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;font-family:monospace;margin-bottom:14px"><label style="display:block;font-size:11px;color:var(--t2);margin-bottom:4px">画布生图模型</label><select id="canvas-config-image-model" style="width:100%;padding:8px 10px;font-size:12px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;margin-bottom:18px"><option value="gpt-image-2" ${cfg.imageModel === 'gpt-image-2' ? 'selected' : ''}>GPT Image 2.0</option><option value="gemini-3.1-flash-image-preview" ${cfg.imageModel === 'gemini-3.1-flash-image-preview' ? 'selected' : ''}>Gemini Flash</option><option value="gemini-3-pro-image" ${cfg.imageModel === 'gemini-3-pro-image' ? 'selected' : ''}>Gemini Pro</option></select><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn bd" onclick="document.getElementById('canvas-api-config-overlay').remove()">取消</button><button class="btn bp" onclick="saveCanvasApiConfig()">保存</button></div></div>`;
  document.body.appendChild(overlay); overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
}

async function saveCanvasApiConfig() {
  const apiKey = document.getElementById('canvas-config-key')?.value.trim() || '';
  const baseUrl = document.getElementById('canvas-config-url')?.value.trim() || '';
  const imageModel = document.getElementById('canvas-config-image-model')?.value.trim() || '';
  try {
    const data = await api('/api/canvas/config', { apiKey, baseUrl, imageModel });
    if (!data.success) return toast(data.error || '保存失败', 'ng');
    canvasStudioState.canvasConfig = data.config;
    canvasModelOptions.image = [{ value: data.config.imageModel, label: data.config.imageModel }];
    document.getElementById('canvas-api-config-overlay')?.remove();
    renderCanvasStudioNodes();
    toast('无限画布配置已独立保存', 'ok');
  } catch (error) { toast('保存失败: ' + (error.message || ''), 'ng'); }
}

async function canvasStudioLoadWorkspace() { try { const query = canvasStudioCanvasId ? `?canvasId=${encodeURIComponent(canvasStudioCanvasId)}&projectId=${encodeURIComponent(canvasStudioProjectId)}` : ''; const data = await api(`/api/canvas/workspace${query}`); if (!data.success) throw new Error(data.error || '加载失败'); canvasApplyWorkspace(data.workspace); renderCanvasStudioNodes(); canvasSetSaveStatus(data.workspace?.savedAt ? '已加载' : '新画布'); canvasStudioLoadHistory(); canvasStudioLog('画布加载完成', 'success'); } catch (error) { canvasSetSaveStatus('加载失败'); canvasStudioLog(`画布加载失败：${error.message || '未知错误'}`, 'error'); } }
async function canvasStudioLoadHistory() { const list = document.getElementById('canvas-history-list'); if (!list) return; try { const data = await api('/api/canvas/history'); const history = data.history || []; list.innerHTML = history.length ? history.slice(0, 8).map(item => `<div>${new Date(item.savedAt).toLocaleString('zh-CN')} · ${item.nodes} 节点</div>`).join('') : '暂无保存记录'; } catch (_error) { list.textContent = '历史读取失败'; } }
function openSmartCanvasWorkflow() { document.getElementById('canvas-smart-workflow-modal')?.classList.add('is-open'); }
function closeSmartCanvasWorkflow(event) { if (event && event.target !== event.currentTarget) return; document.getElementById('canvas-smart-workflow-modal')?.classList.remove('is-open'); }
function openSmartCanvasLog() {
  const modal = document.getElementById('canvas-smart-log-modal');
  if (!modal) return;
  modal.classList.add('is-open');
  renderSmartCanvasLog();
}
function closeSmartCanvasLog(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('canvas-smart-log-modal')?.classList.remove('is-open');
}
function renderSmartCanvasLog(level = 'all', button = null) {
  const list = document.getElementById('canvas-smart-log-list');
  if (!list) return;
  const logs = (canvasStudioState.logs || []).filter(item => level === 'all' || item.level === level);
  document.querySelectorAll('#canvas-smart-log-modal .smart-log-toolbar button:not(.smart-log-clear)').forEach(item => item.classList.toggle('is-active', item === button || (level === 'all' && !button && item.textContent === '全部')));
  list.innerHTML = logs.length ? logs.map(item => `<div class="smart-log-entry smart-log-${canvasEscape(item.level)}"><time>${new Date(item.time).toLocaleTimeString('zh-CN')}</time><span>${canvasEscape(item.message)}</span></div>`).join('') : '<div class="smart-log-empty">暂无画布日志</div>';
}
function clearSmartCanvasLog() {
  canvasStudioState.logs = [];
  renderSmartCanvasLog();
}
function openSmartCanvasShortcuts() { document.getElementById('canvas-smart-shortcuts-modal')?.classList.add('is-open'); }
function closeSmartCanvasShortcuts(event) { if (event && event.target !== event.currentTarget) return; document.getElementById('canvas-smart-shortcuts-modal')?.classList.remove('is-open'); }

function canvasStudioSelectedWorkflowPayload() {
  const snapshot = canvasWorkspaceSnapshot();
  const selectedIds = new Set(canvasStudioState.selectedIds || []);
  const hasSelection = selectedIds.size > 0;
  const nodes = hasSelection ? snapshot.nodes.filter(node => selectedIds.has(node.id)) : snapshot.nodes;
  const nodeIds = new Set(nodes.map(node => node.id));
  const connections = snapshot.connections.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  return { ...snapshot, nodes, connections };
}
function canvasStudioExport() {
  const payload = canvasStudioSelectedWorkflowPayload();
  if (!payload.nodes.length) { toast('画布为空，无可导出节点', 'ng'); return; }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `lavans-canvas-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  canvasStudioLog(`已导出工作流 JSON（${payload.nodes.length} 节点）`, 'success');
}
async function canvasStudioExportZip() {
  const payload = canvasStudioSelectedWorkflowPayload();
  if (!payload.nodes.length) { toast('画布为空，无可导出节点', 'ng'); return; }
  try {
    const res = await fetch('/api/canvas/workflows/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, include_resources: true, filename: `lavans-canvas-${new Date().toISOString().slice(0, 10)}.zip` }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || '导出工作流失败'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `lavans-canvas-${new Date().toISOString().slice(0, 10)}.zip`;
    link.click();
    URL.revokeObjectURL(url);
    canvasStudioLog(`已导出工作流 ZIP（含资源，${payload.nodes.length} 节点）`, 'success');
  } catch (error) {
    toast(error.message || '导出工作流失败', 'ng');
    canvasStudioLog(`工作流 ZIP 导出失败：${error.message}`, 'error');
  }
}
function canvasStudioImport() { document.getElementById('canvas-studio-import')?.click(); }
function insertCanvasStudioWorkflow(imported) {
  const srcNodes = (imported?.nodes || []).filter(Boolean);
  const srcConnections = (imported?.connections || []).filter(Boolean);
  if (!srcNodes.length) throw new Error('工作流中没有可导入的节点');
  const before = canvasEditorSnapshot();
  const center = canvasStudioViewportCenter();
  const minX = Math.min(...srcNodes.map(node => Number(node.x || 0)));
  const minY = Math.min(...srcNodes.map(node => Number(node.y || 0)));
  const dx = (center?.x || 0) - minX;
  const dy = (center?.y || 0) - minY;
  const idMap = new Map();
  const newNodes = srcNodes.map(node => {
    const copy = JSON.parse(JSON.stringify(node));
    const oldId = copy.id;
    copy.id = canvasNodeId(copy.type || 'node');
    copy.x = Number(copy.x || 0) + dx;
    copy.y = Number(copy.y || 0) + dy;
    copy.status = copy.status === 'running' ? 'idle' : (copy.status || 'idle');
    idMap.set(oldId, copy.id);
    return copy;
  });
  newNodes.forEach(node => {
    if (canvasIsGroupNode(node) && Array.isArray(node.items)) node.items = node.items.map(id => idMap.get(id) || id).filter(id => idMap.has(id) || canvasStudioState.nodes.some(existing => existing.id === id));
  });
  const newConnections = srcConnections.map(edge => ({ ...edge, id: `canvas-connection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, from: idMap.get(edge.from), to: idMap.get(edge.to) })).filter(edge => edge.from && edge.to);
  canvasStudioState.nodes.push(...newNodes);
  canvasStudioState.connections.push(...newConnections);
  canvasNormalizeGroups();
  canvasSetSelection(newNodes.map(node => node.id));
  canvasEditorCommit(before, 'import');
  renderCanvasStudioNodes();
  return newNodes.length;
}
async function canvasStudioImportFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const isZip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip';
    let nodes, connections;
    if (isZip) {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/canvas/workflows/import', { method: 'POST', body: form });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || '导入工作流失败'); }
      const data = await res.json();
      nodes = data.nodes;
      connections = data.connections;
    } else {
      const parsed = JSON.parse(await file.text());
      nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : Array.isArray(parsed?.workflow?.nodes) ? parsed.workflow.nodes : null;
      connections = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed?.workflow?.connections) ? parsed.workflow.connections : [];
      if (!nodes) throw new Error('工作流 JSON 缺少 nodes');
    }
    const count = insertCanvasStudioWorkflow({ nodes, connections });
    await canvasStudioSaveNow('import');
    canvasStudioLog(`已追加导入工作流：${file.name}（${count} 节点）`, 'success');
  } catch (error) {
    canvasSetSaveStatus('导入失败');
    canvasStudioLog(`工作流导入失败：${error.message || '文件格式错误'}`, 'error');
  }
}

// ===== 资产库 =====
let canvasAssetLibrary = null;
let canvasLocalAssets = [];
let canvasActiveAssetLibId = '';
let canvasActiveAssetCatId = '';
let canvasAssetPanelOpen = false;
function canvasAssetLibraries() { return Array.isArray(canvasAssetLibrary?.libraries) ? canvasAssetLibrary.libraries : []; }
function activeCanvasAssetLibrary() { return canvasAssetLibraries().find(lib => lib.id === canvasActiveAssetLibId) || canvasAssetLibraries()[0] || null; }
function canvasAssetCategories() { const lib = activeCanvasAssetLibrary(); return Array.isArray(lib?.categories) ? lib.categories : []; }
function activeCanvasAssetCategory() { return canvasAssetCategories().find(cat => cat.id === canvasActiveAssetCatId) || canvasAssetCategories()[0] || null; }
async function loadCanvasAssetLibrary() {
  try {
    const [data, localData] = await Promise.all([
      api('/api/canvas/assets-library'),
      api('/api/canvas/local-assets').catch(() => ({ items: [] }))
    ]);
    canvasAssetLibrary = data?.library || canvasAssetLibrary || { libraries: [] };
    canvasLocalAssets = Array.isArray(localData?.items) ? localData.items : [];
    const libs = canvasAssetLibraries();
    if (!libs.some(lib => lib.id === canvasActiveAssetLibId)) canvasActiveAssetLibId = libs[0]?.id || '';
    const cats = canvasAssetCategories();
    if (!cats.some(cat => cat.id === canvasActiveAssetCatId)) canvasActiveAssetCatId = cats[0]?.id || '';
    renderCanvasAssetLibrary();
  } catch (_error) {
    canvasStudioLog('资产库加载失败', 'error');
  }
}
function toggleCanvasAssetLibrary(open) {
  canvasAssetPanelOpen = open !== undefined ? !!open : !canvasAssetPanelOpen;
  document.getElementById('smart-asset-panel')?.classList.toggle('is-open', canvasAssetPanelOpen);
  if (canvasAssetPanelOpen) loadCanvasAssetLibrary();
}
function canvasAssetSetLib(libId) { canvasActiveAssetLibId = libId; canvasActiveAssetCatId = ''; renderCanvasAssetLibrary(); }
function canvasAssetSetCat(catId) { canvasActiveAssetCatId = catId; renderCanvasAssetLibrary(); }
function canvasAssetItemKind(item) {
  const url = String(item?.url || '');
  const type = String(item?.type || item?.mime || '').toLowerCase();
  if (type === 'workflow' || /\.(json|zip)$/i.test(url)) return 'workflow';
  if (type.startsWith('video/') || item?.kind === 'video') return 'video';
  return 'image';
}
function canvasAssetCardHtml(item) {
  const kind = canvasAssetItemKind(item);
  const url = String(item.url || '');
  const name = item.name || '资产';
  const thumb = kind === 'workflow' ? '<span class="smart-asset-workflow-icon">⌘</span>' : `<img src="${url}" alt="${canvasEscape(name)}" loading="lazy">`;
  return `<div class="canvas-asset-item" draggable="true" data-asset-id="${canvasEscape(item.id || '')}" data-url="${url}" data-name="${canvasEscape(name)}" data-kind="${kind}">${thumb}<div class="canvas-asset-meta"><span class="canvas-asset-name" title="${canvasEscape(name)}">${canvasEscape(name)}</span></div></div>`;
}
function canvasStudioAddAssetFromUrl(url, name, kind = 'image') {
  const point = canvasStudioViewportCenter();
  const before = canvasEditorSnapshot();
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const label = mediaKind === 'video' ? '视频资产' : '图片资产';
  const fallbackName = mediaKind === 'video' ? '资产视频' : '资产图片';
  const node = { id: canvasNodeId('image'), type: 'image', x: point?.x ?? 0, y: point?.y ?? 0, title: label, mediaItems: [{ id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: mediaKind, url, name: name || fallbackName }], mediaUrl: url, mediaName: name || fallbackName, createdAt: Date.now() };
  canvasNormalizeNodeSize(node);
  canvasStudioState.nodes.push(node);
  canvasSetSelection([node.id]);
  canvasEditorCommit(before, 'add-asset-from-library');
  renderCanvasStudioNodes();
  canvasScheduleSave();
}
function canvasStudioAddImageFromUrl(url, name) { canvasStudioAddAssetFromUrl(url, name, 'image'); }
function renderCanvasAssetLibrary() {
  const libSel = document.getElementById('canvas-asset-lib-select');
  const catSel = document.getElementById('canvas-asset-cat-select');
  const grid = document.getElementById('canvas-asset-grid');
  if (!grid) return;
  if (libSel) libSel.innerHTML = canvasAssetLibraries().map(lib => `<option value="${canvasEscape(lib.id)}" ${lib.id === canvasActiveAssetLibId ? 'selected' : ''}>${canvasEscape(lib.name || '资产库')}</option>`).join('');
  if (catSel) catSel.innerHTML = canvasAssetCategories().map(cat => `<option value="${canvasEscape(cat.id)}" ${cat.id === canvasActiveAssetCatId ? 'selected' : ''}>${canvasEscape((cat.type === 'workflow' ? '工作流 / ' : '') + (cat.name || '默认分组'))}</option>`).join('');
  const cat = activeCanvasAssetCategory();
  const items = Array.isArray(cat?.items) ? cat.items : [];
  grid.innerHTML = items.length ? items.map(item => canvasAssetCardHtml(item)).join('') : '<div class="smart-asset-empty">当前分组还没有资产</div>';
  grid.querySelectorAll('.canvas-asset-item').forEach(card => {
    card.addEventListener('dblclick', () => {
      const kind = card.dataset.kind;
      const url = card.dataset.url;
      const name = card.dataset.name;
      if (!url) return;
      if (kind === 'workflow') toast('工作流资产请用工作流弹窗导入', 'ng');
      else canvasStudioAddAssetFromUrl(url, name, kind);
    });
    card.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', card.dataset.url || '');
      event.dataTransfer.setData('application/x-canvas-asset', JSON.stringify({ id: card.dataset.assetId || '', url: card.dataset.url || '', name: card.dataset.name || '', kind: card.dataset.kind || '' }));
    });
  });
}

// ===== 资产管理器 + 工作流库 =====
async function canvasAssetApi(url, method, body) {
  const options = { method: method || 'POST' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  return response.json().catch(() => ({ success: false, error: `HTTP ${response.status}` }));
}
let canvasAssetManagerTab = 'image';
let canvasManagerSelectedIds = new Set();
function openCanvasAssetManager() {
  loadCanvasAssetLibrary().then(() => {
    canvasAssetManagerTab = 'image';
    canvasManagerSelectedIds = new Set();
    renderCanvasAssetManager();
    document.getElementById('canvas-asset-manager-modal')?.classList.add('is-open');
  });
}
function closeCanvasAssetManager(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('canvas-asset-manager-modal')?.classList.remove('is-open');
}
function switchCanvasAssetManagerTab(tab, btn) {
  canvasAssetManagerTab = tab;
  canvasManagerSelectedIds = new Set();
  document.querySelectorAll('#canvas-asset-manager-modal [data-manager-tab]').forEach(b => b.classList.toggle('active', b === btn));
  renderCanvasAssetManager();
}
function renderCanvasAssetManager() {
  if (canvasAssetManagerTab === 'workflow') renderCanvasWorkflowManager();
  else renderCanvasImageManager();
}
function canvasAssetManagerApplyLibrary(data) {
  if (data?.library) {
    canvasAssetLibrary = data.library;
    const libs = canvasAssetLibraries();
    if (!libs.some(lib => lib.id === canvasActiveAssetLibId)) canvasActiveAssetLibId = libs[0]?.id || '';
    const cats = canvasAssetCategories();
    if (!cats.some(cat => cat.id === canvasActiveAssetCatId)) canvasActiveAssetCatId = cats[0]?.id || '';
    renderCanvasAssetLibrary();
  }
}
async function canvasAssetManagerConfirm(title) {
  return new Promise(resolve => { const v = prompt(title); resolve(v ? String(v).trim() : ''); });
}
function renderCanvasImageManager() {
  const body = document.getElementById('canvas-asset-manager-body');
  if (!body) return;
  const libs = canvasAssetLibraries();
  const lib = activeCanvasAssetLibrary();
  const cats = canvasAssetCategories().filter(c => (c.type || 'image') !== 'workflow');
  if (!cats.some(c => c.id === canvasActiveAssetCatId)) canvasActiveAssetCatId = cats[0]?.id || '';
  const cat = activeCanvasAssetCategory();
  const items = Array.isArray(cat?.items) ? cat.items : [];
  body.innerHTML = `<div class="asset-manager-side"><div class="asset-manager-tools"><button type="button" class="image-edit-btn primary" onclick="canvasAssetManagerNewLib()">新资产库</button><button type="button" class="image-edit-btn" ${!lib ? 'disabled' : ''} onclick="canvasAssetManagerRenameLib()">重命名库</button><button type="button" class="image-edit-btn" ${libs.length <= 1 ? 'disabled' : ''} onclick="canvasAssetManagerDeleteLib()">删除库</button></div><div class="asset-manager-list">${libs.map(l => `<button type="button" class="${l.id === canvasActiveAssetLibId ? 'active' : ''}" onclick="canvasAssetManagerPickLib('${canvasEscape(l.id)}')"><span>${canvasEscape(l.name || '资产库')}</span></button>`).join('')}</div><div class="asset-manager-tools"><button type="button" class="image-edit-btn primary" onclick="canvasAssetManagerNewCat()">新分组</button><button type="button" class="image-edit-btn" ${!cat ? 'disabled' : ''} onclick="canvasAssetManagerRenameCat()">重命名组</button><button type="button" class="image-edit-btn" ${!cat ? 'disabled' : ''} onclick="canvasAssetManagerDeleteCat()">删除组</button></div><div class="asset-manager-list">${cats.map(c => `<button type="button" class="${c.id === canvasActiveAssetCatId ? 'active' : ''}" onclick="canvasAssetManagerPickCat('${canvasEscape(c.id)}')"><span>${canvasEscape(c.name || '分组')}</span><small>${(c.items || []).length}</small></button>`).join('')}</div></div><div class="asset-manager-main"><div class="asset-manager-tools"><button type="button" class="image-edit-btn primary" ${!cat ? 'disabled' : ''} onclick="canvasAssetManagerAddUrl()">添加图片(URL)</button><button type="button" class="image-edit-btn" ${!cat ? 'disabled' : ''} onclick="document.getElementById('canvas-manager-upload').click()">批量上传</button><input id="canvas-manager-upload" type="file" multiple accept="image/*" hidden><button type="button" class="image-edit-btn" ${canvasManagerSelectedIds.size ? '' : 'disabled'} onclick="canvasAssetManagerDeleteSelected()">删除所选 ${canvasManagerSelectedIds.size || ''}</button></div><div class="asset-manager-grid">${items.length ? items.map(item => `<div class="asset-manager-card"><input type="checkbox" data-manager-check="${canvasEscape(item.id)}" ${canvasManagerSelectedIds.has(item.id) ? 'checked' : ''}><img src="${canvasEscape(item.url || '')}" alt="" loading="lazy"><span class="asset-manager-card-name" title="${canvasEscape(item.name || '')}">${canvasEscape(item.name || '资产')}</span><div class="asset-manager-card-actions"><button type="button" onclick="canvasAssetManagerRenameItem('${canvasEscape(item.id)}')">重命名</button><button type="button" onclick="canvasAssetManagerDeleteItem('${canvasEscape(item.id)}')">删除</button></div></div>`).join('') : '<div class="canvas-asset-empty">当前分组为空</div>'}</div></div>`;
  const upload = document.getElementById('canvas-manager-upload');
  upload?.addEventListener('change', async () => {
    if (!upload.files?.length || !cat) return;
    const items = [];
    for (const file of upload.files) {
      const f = await uploadCanvasCroppedBlob(file, file.name);
      if (f) items.push({ url: f.url, name: f.name });
    }
    if (items.length) {
      const data = await api('/api/canvas/assets-library/items/batch', { library_id: lib?.id || '', category_id: cat.id, items });
      canvasAssetManagerApplyLibrary(data);
      canvasManagerSelectedIds = new Set();
      renderCanvasImageManager();
    }
    upload.value = '';
  });
  body.querySelectorAll('[data-manager-check]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) canvasManagerSelectedIds.add(cb.dataset.managerCheck);
    else canvasManagerSelectedIds.delete(cb.dataset.managerCheck);
    renderCanvasImageManager();
  }));
}
function renderCanvasWorkflowManager() {
  const body = document.getElementById('canvas-asset-manager-body');
  if (!body) return;
  const libs = canvasAssetLibraries();
  const cats = canvasAssetCategories().filter(c => (c.type || 'image') === 'workflow');
  if (!cats.some(c => c.id === canvasActiveAssetCatId)) canvasActiveAssetCatId = cats[0]?.id || '';
  const cat = activeCanvasAssetCategory();
  const items = Array.isArray(cat?.items) ? cat.items : [];
  body.innerHTML = `<div class="asset-manager-side"><div class="asset-manager-tools"><button type="button" class="image-edit-btn primary" onclick="canvasAssetManagerNewWorkflowCat()">新工作流分组</button></div><div class="asset-manager-list">${libs.map(l => `<button type="button" class="${l.id === canvasActiveAssetLibId ? 'active' : ''}" onclick="canvasAssetManagerPickLib('${canvasEscape(l.id)}')"><span>${canvasEscape(l.name || '资产库')}</span></button>`).join('')}</div><div class="asset-manager-list">${cats.map(c => `<button type="button" class="${c.id === canvasActiveAssetCatId ? 'active' : ''}" onclick="canvasAssetManagerPickCat('${canvasEscape(c.id)}')"><span>${canvasEscape(c.name || '工作流')}</span><small>${(c.items || []).length}</small></button>`).join('') || '<div class="canvas-asset-empty">暂无工作流分组</div>'}</div></div><div class="asset-manager-main"><div class="asset-manager-tools"><button type="button" class="image-edit-btn" ${!cat ? 'disabled' : ''} onclick="document.getElementById('canvas-manager-wf-upload').click()">上传工作流</button><input id="canvas-manager-wf-upload" type="file" multiple accept=".json,.zip" hidden><button type="button" class="image-edit-btn" ${canvasManagerSelectedIds.size ? '' : 'disabled'} onclick="canvasAssetManagerDeleteSelected()">删除所选 ${canvasManagerSelectedIds.size || ''}</button></div><div class="asset-manager-grid">${items.length ? items.map(item => `<div class="asset-manager-card"><input type="checkbox" data-manager-check="${canvasEscape(item.id)}" ${canvasManagerSelectedIds.has(item.id) ? 'checked' : ''}><div class="asset-manager-card-text"><span>${canvasEscape(/\.json$/i.test(item.url || '') ? 'JSON 工作流' : 'ZIP 工作流包')}</span></div><span class="asset-manager-card-name" title="${canvasEscape(item.name || '')}">${canvasEscape(item.name || '工作流')}</span><div class="asset-manager-card-actions"><button type="button" onclick="canvasAssetManagerRenameItem('${canvasEscape(item.id)}')">重命名</button><button type="button" onclick="canvasAssetManagerDeleteItem('${canvasEscape(item.id)}')">删除</button></div></div>`).join('') : '<div class="canvas-asset-empty">当前分组为空</div>'}</div></div>`;
  const upload = document.getElementById('canvas-manager-wf-upload');
  upload?.addEventListener('change', async () => {
    if (!upload.files?.length || !cat) return;
    const form = new FormData();
    form.append('library_id', canvasActiveAssetLibId || '');
    form.append('category_id', cat.id || '');
    [...upload.files].forEach(file => form.append('files', file));
    const data = await fetch('/api/canvas/assets-library/workflows/upload', { method: 'POST', body: form }).then(r => r.json());
    canvasAssetManagerApplyLibrary(data);
    canvasManagerSelectedIds = new Set();
    renderCanvasWorkflowManager();
    upload.value = '';
  });
  body.querySelectorAll('[data-manager-check]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) canvasManagerSelectedIds.add(cb.dataset.managerCheck);
    else canvasManagerSelectedIds.delete(cb.dataset.managerCheck);
    renderCanvasWorkflowManager();
  }));
}
function canvasAssetManagerPickLib(libId) { canvasActiveAssetLibId = libId; canvasActiveAssetCatId = ''; canvasManagerSelectedIds = new Set(); renderCanvasAssetManager(); }
function canvasAssetManagerPickCat(catId) { canvasActiveAssetCatId = catId; canvasManagerSelectedIds = new Set(); renderCanvasAssetManager(); }
async function canvasAssetManagerNewLib() {
  const name = await canvasAssetManagerConfirm('新资产库名称：');
  if (!name) return;
  const data = await api('/api/canvas/assets-library/libraries', { name });
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerRenameLib() {
  const lib = activeCanvasAssetLibrary();
  if (!lib) return;
  const name = await canvasAssetManagerConfirm('资产库新名称：', lib.name);
  if (!name) return;
  const data = await canvasAssetApi(`/api/canvas/assets-library/libraries/${encodeURIComponent(lib.id)}`, 'PATCH', { name });
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerDeleteLib() {
  const lib = activeCanvasAssetLibrary();
  if (!lib || canvasAssetLibraries().length <= 1) return;
  if (!confirm(`确定删除资产库「${lib.name}」？`)) return;
  const data = await canvasAssetApi(`/api/canvas/assets-library/libraries/${encodeURIComponent(lib.id)}`, 'DELETE');
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerNewCat() {
  const name = await canvasAssetManagerConfirm('新分组名称：');
  if (!name) return;
  const data = await api('/api/canvas/assets-library/categories', { library_id: canvasActiveAssetLibId || '', name, type: 'image' });
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerNewWorkflowCat() {
  const name = await canvasAssetManagerConfirm('新工作流分组名称：');
  if (!name) return;
  const data = await api('/api/canvas/assets-library/categories', { library_id: canvasActiveAssetLibId || '', name, type: 'workflow' });
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerRenameCat() {
  const cat = activeCanvasAssetCategory();
  if (!cat) return;
  const name = await canvasAssetManagerConfirm('分组新名称：', cat.name);
  if (!name) return;
  const data = await canvasAssetApi(`/api/canvas/assets-library/categories/${encodeURIComponent(cat.id)}`, 'PATCH', { name });
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerDeleteCat() {
  const cat = activeCanvasAssetCategory();
  if (!cat) return;
  if (!confirm(`确定删除分组「${cat.name}」？`)) return;
  const data = await canvasAssetApi(`/api/canvas/assets-library/categories/${encodeURIComponent(cat.id)}`, 'DELETE');
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerAddUrl() {
  const cat = activeCanvasAssetCategory();
  if (!cat) return;
  const url = await canvasAssetManagerConfirm('图片 URL：');
  if (!url) return;
  const data = await api('/api/canvas/assets-library/items', { library_id: canvasActiveAssetLibId || '', category_id: cat.id, url });
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerRenameItem(itemId) {
  const name = await canvasAssetManagerConfirm('素材新名称：');
  if (!name) return;
  const data = await canvasAssetApi(`/api/canvas/assets-library/items/${encodeURIComponent(itemId)}`, 'PATCH', { name });
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerDeleteItem(itemId) {
  if (!confirm('确定删除此素材？')) return;
  const data = await canvasAssetApi(`/api/canvas/assets-library/items/${encodeURIComponent(itemId)}`, 'DELETE');
  canvasAssetManagerApplyLibrary(data);
  renderCanvasAssetManager();
}
async function canvasAssetManagerDeleteSelected() {
  if (!canvasManagerSelectedIds.size) return;
  if (!confirm(`确定删除选中的 ${canvasManagerSelectedIds.size} 项？`)) return;
  const data = await api('/api/canvas/assets-library/items/delete', { library_id: canvasActiveAssetLibId || '', ids: [...canvasManagerSelectedIds] });
  canvasAssetManagerApplyLibrary(data);
  canvasManagerSelectedIds = new Set();
  renderCanvasAssetManager();
}
async function exportCanvasWorkflowToLibrary() {
  const payload = canvasWorkspaceSnapshot();
  if (!payload?.nodes?.length) return toast('未选择节点，请先框选要导出的组件', 'wn');
  try {
    const filename = `lavans-workflow-${new Date().toISOString().slice(0, 10)}.json`;
    await loadCanvasAssetLibrary();
    const lib = activeCanvasAssetLibrary() || canvasAssetLibraries()[0];
    const cat = (lib?.categories || []).find(c => (c.type || 'image') === 'workflow');
    if (!lib || !cat) return toast('请先在资产库管理工作流分组', 'ng');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('library_id', lib.id || '');
    form.append('category_id', cat.id || '');
    form.append('files', blob, filename);
    const data = await fetch('/api/canvas/assets-library/workflows/upload', { method: 'POST', body: form }).then(r => r.json());
    canvasAssetManagerApplyLibrary(data);
    toast(`已导出工作流到资产库：${filename.replace(/\.json$/i, '')}`, 'success');
    renderCanvasAssetLibrary();
  } catch (error) { toast(error.message || '导出到库失败', 'ng'); }
}

// ===== 图片编辑器（裁剪 + 扩图）=====
let cropState = null;
let cropDrag = null;
let cropAspectPreset = 'free';
let cropAspectRatio = null;
let imageEditMode = 'crop';
function openCanvasImageEditor(nodeId, mode = 'crop') {
  const node = canvasGetNode(nodeId);
  if (!node?.mediaUrl) return;
  const modal = document.getElementById('canvas-image-edit-modal');
  const img = document.getElementById('canvas-crop-image');
  if (!modal || !img) return;
  cropState = { nodeId, x: 0, y: 0, w: 0, h: 0 };
  cropDrag = null;
  cropAspectPreset = 'free';
  cropAspectRatio = null;
  imageEditMode = 'crop';
  editDrawState = null;
  editDrawUndoStack = [];
  editDrawRedoStack = [];
  brushTool = 'free';
  brushLabelCounter = 1;
  bindCanvasImageEditor();
  bindCanvasEditDrawCanvas();
  syncCanvasCropRatioButtons();
  modal.classList.add('is-open');
  img.onload = () => {
    if (!cropState || cropState.nodeId !== nodeId) return;
    const drawCanvas = canvasEditDrawCanvas();
    if (drawCanvas) {
      drawCanvas.width = img.naturalWidth || 1;
      drawCanvas.height = img.naturalHeight || 1;
      drawCanvas.getContext('2d').clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    }
    resetCanvasCropBox();
    setCanvasImageEditMode(mode);
  };
  img.crossOrigin = 'anonymous';
  img.src = node.mediaUrl;
}
function closeCanvasImageEditor() {
  document.getElementById('canvas-image-edit-modal')?.classList.remove('is-open');
  const img = document.getElementById('canvas-crop-image');
  if (img) { img.onload = null; img.removeAttribute('src'); }
  cropState = null;
  cropDrag = null;
}
function setCanvasImageEditMode(mode) {
  imageEditMode = ['crop', 'outpaint', 'mask', 'brush', 'resize', 'grid'].includes(mode) ? mode : 'crop';
  document.querySelectorAll('#canvas-image-edit-modal [data-image-edit-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.imageEditMode === imageEditMode));
  const cropTools = document.getElementById('canvas-image-crop-tools');
  const outpaintHint = document.getElementById('canvas-image-outpaint-hint');
  const maskTools = document.getElementById('canvas-image-mask-tools');
  const brushTools = document.getElementById('canvas-image-brush-tools');
  const resizeTools = document.getElementById('canvas-image-resize-tools');
  const gridTools = document.getElementById('canvas-image-grid-tools');
  const applyBtn = document.getElementById('canvas-image-edit-apply');
  const drawCanvas = canvasEditDrawCanvas();
  if (cropTools) cropTools.style.display = imageEditMode === 'crop' ? '' : 'none';
  if (outpaintHint) outpaintHint.style.display = imageEditMode === 'outpaint' ? '' : 'none';
  if (maskTools) maskTools.style.display = imageEditMode === 'mask' ? '' : 'none';
  if (brushTools) brushTools.style.display = imageEditMode === 'brush' ? '' : 'none';
  if (resizeTools) resizeTools.style.display = imageEditMode === 'resize' ? '' : 'none';
  if (gridTools) gridTools.style.display = imageEditMode === 'grid' ? '' : 'none';
  if (drawCanvas) drawCanvas.style.display = (imageEditMode === 'mask' || imageEditMode === 'brush') ? '' : 'none';
  const applyLabels = { crop: '应用裁剪', outpaint: '应用扩展', mask: '应用遮罩', brush: '应用画笔', resize: '应用缩放', grid: '应用宫格切分' };
  if (applyBtn) applyBtn.textContent = applyLabels[imageEditMode] || '应用';
  const cropBox = document.getElementById('canvas-crop-box');
  if (cropBox) cropBox.style.display = (imageEditMode === 'crop' || imageEditMode === 'outpaint') ? '' : 'none';
  if (imageEditMode === 'resize') canvasResizeScaleChanged();
  resetCanvasCropBox();
}
function syncCanvasCropRatioButtons() {
  document.querySelectorAll('#canvas-image-crop-tools [data-crop-ratio]').forEach(btn => btn.classList.toggle('active', btn.dataset.cropRatio === cropAspectPreset));
}
function setCanvasCropRatio(preset) {
  cropAspectPreset = preset;
  const ratioMap = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 };
  cropAspectRatio = ratioMap[preset] || null;
  syncCanvasCropRatioButtons();
  if (cropAspectRatio) {
    const { w, h } = canvasCropBounds();
    let bw = w; let bh = h;
    if (w / h > cropAspectRatio) bw = h * cropAspectRatio; else bh = w / cropAspectRatio;
    cropState.x = (w - bw) / 2; cropState.y = (h - bh) / 2; cropState.w = bw; cropState.h = bh;
  } else {
    resetCanvasCropBox();
  }
  renderCanvasCropBox();
}
function canvasCropBounds() {
  const img = document.getElementById('canvas-crop-image');
  return { w: img?.clientWidth || 0, h: img?.clientHeight || 0 };
}
function resetCanvasCropBox() {
  if (!cropState) return;
  const { w, h } = canvasCropBounds();
  cropState.x = 0; cropState.y = 0; cropState.w = w; cropState.h = h;
  renderCanvasCropBox();
}
function clampCanvasCrop() {
  if (!cropState) return;
  const { w, h } = canvasCropBounds();
  cropState.w = Math.max(24, Math.min(cropState.w, w));
  cropState.h = Math.max(24, Math.min(cropState.h, h));
  cropState.x = Math.max(0, Math.min(cropState.x, w - cropState.w));
  cropState.y = Math.max(0, Math.min(cropState.y, h - cropState.h));
}
function clampCanvasOutpaint() {
  if (!cropState) return;
  const { w, h } = canvasCropBounds();
  cropState.w = Math.max(24, Math.min(cropState.w, w * 2));
  cropState.h = Math.max(24, Math.min(cropState.h, h * 2));
  cropState.x = Math.min(Math.max(cropState.x, -(cropState.w - w)), 0);
  cropState.y = Math.min(Math.max(cropState.y, -(cropState.h - h)), 0);
}
function renderCanvasCropBox() {
  const box = document.getElementById('canvas-crop-box');
  if (!box || !cropState) return;
  box.style.left = `${cropState.x}px`;
  box.style.top = `${cropState.y}px`;
  box.style.width = `${cropState.w}px`;
  box.style.height = `${cropState.h}px`;
}
function bindCanvasImageEditor() {
  const box = document.getElementById('canvas-crop-box');
  if (!box || box.dataset.bound === 'true') return;
  box.dataset.bound = 'true';
  const pointFromEvent = event => {
    const rect = document.getElementById('canvas-crop-canvas')?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };
  box.addEventListener('pointerdown', event => {
    if (!cropState || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.target.dataset?.cropHandle || 'move';
    const start = pointFromEvent(event);
    cropDrag = { handle, startX: start.x, startY: start.y, ox: cropState.x, oy: cropState.y, ow: cropState.w, oh: cropState.h };
    box.setPointerCapture(event.pointerId);
  });
  box.addEventListener('pointermove', event => {
    if (!cropDrag || !cropState) return;
    const p = pointFromEvent(event);
    const dx = p.x - cropDrag.startX;
    const dy = p.y - cropDrag.startY;
    const bounds = canvasCropBounds();
    if (cropDrag.handle === 'move') {
      cropState.x = Math.max(0, Math.min(cropDrag.ox + dx, bounds.w - cropState.w));
      cropState.y = Math.max(0, Math.min(cropDrag.oy + dy, bounds.h - cropState.h));
    } else {
      const { ox, oy, ow, oh } = cropDrag;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (cropDrag.handle.includes('e')) nw = Math.max(24, ow + dx);
      if (cropDrag.handle.includes('s')) nh = Math.max(24, oh + dy);
      if (cropDrag.handle.includes('w')) { nw = Math.max(24, ow - dx); nx = ox + (ow - nw); }
      if (cropDrag.handle.includes('n')) { nh = Math.max(24, oh - dy); ny = oy + (oh - nh); }
      if (cropAspectRatio && nw > 24) nh = nw / cropAspectRatio;
      nx = Math.max(0, Math.min(nx, bounds.w - nw));
      ny = Math.max(0, Math.min(ny, bounds.h - nh));
      cropState.x = nx; cropState.y = ny; cropState.w = nw; cropState.h = nh;
      if (imageEditMode === 'outpaint') clampCanvasOutpaint(); else clampCanvasCrop();
    }
    renderCanvasCropBox();
  });
  const endDrag = event => {
    if (!cropDrag) return;
    cropDrag = null;
    if (box.hasPointerCapture?.(event.pointerId)) box.releasePointerCapture(event.pointerId);
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);
}
function bindCanvasEditDrawCanvas() {
  const canvasEl = canvasEditDrawCanvas();
  if (!canvasEl || canvasEl.dataset.bound === 'true') return;
  canvasEl.dataset.bound = 'true';
  canvasEl.addEventListener('pointerdown', canvasBeginEditDraw);
  canvasEl.addEventListener('pointermove', canvasMoveEditDraw);
  canvasEl.addEventListener('pointerup', canvasEndEditDraw);
  canvasEl.addEventListener('pointercancel', canvasEndEditDraw);
}
async function uploadCanvasCroppedBlob(blob, name) {
  const form = new FormData();
  form.append('files', blob, name);
  const res = await fetch('/api/canvas/local-assets/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error('图片上传失败');
  const data = await res.json();
  return Array.isArray(data.files) ? data.files[0] : null;
}
function applyCanvasImageEdit() {
  if (imageEditMode === 'outpaint') return applyCanvasImageOutpaint();
  if (imageEditMode === 'mask') return applyCanvasImageMask();
  if (imageEditMode === 'brush') return applyCanvasImageBrush();
  if (imageEditMode === 'resize') return applyCanvasImageResize();
  if (imageEditMode === 'grid') return applyCanvasImageGridSplit();
  return applyCanvasImageCrop();
}
async function applyCanvasImageCrop() {
  if (!cropState) return;
  const node = canvasGetNode(cropState.nodeId);
  const img = document.getElementById('canvas-crop-image');
  if (!node || !img.naturalWidth || !img.naturalHeight) return;
  const scaleX = img.naturalWidth / (img.clientWidth || 1);
  const scaleY = img.naturalHeight / (img.clientHeight || 1);
  const sx = Math.max(0, Math.round(cropState.x * scaleX));
  const sy = Math.max(0, Math.round(cropState.y * scaleY));
  const sw = Math.max(1, Math.round(cropState.w * scaleX));
  const sh = Math.max(1, Math.round(cropState.h * scaleY));
  const canvasEl = document.createElement('canvas');
  canvasEl.width = sw; canvasEl.height = sh;
  canvasEl.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise(resolve => canvasEl.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const base = (node.mediaName || node.title || 'image').replace(/\.[^.]+$/, '');
  try {
    const file = await uploadCanvasCroppedBlob(blob, `${base}_crop.png`);
    if (file) {
      node.mediaUrl = file.url;
      node.mediaName = file.name || node.mediaName;
      if (Array.isArray(node.mediaItems) && node.mediaItems.length) node.mediaItems[0].url = file.url;
      closeCanvasImageEditor();
      renderCanvasStudioNodes();
      canvasScheduleSave();
    }
  } catch (error) { toast(error.message || '裁剪失败', 'ng'); }
}
async function applyCanvasImageOutpaint() {
  if (!cropState) return;
  const node = canvasGetNode(cropState.nodeId);
  const img = document.getElementById('canvas-crop-image');
  if (!node || !img.naturalWidth || !img.naturalHeight) return;
  clampCanvasOutpaint();
  const scaleX = img.naturalWidth / (img.clientWidth || 1);
  const scaleY = img.naturalHeight / (img.clientHeight || 1);
  const outW = Math.max(img.naturalWidth, Math.round(cropState.w * scaleX));
  const outH = Math.max(img.naturalHeight, Math.round(cropState.h * scaleY));
  const dx = Math.round(cropState.x * scaleX);
  const dy = Math.round(cropState.y * scaleY);
  const canvasEl = document.createElement('canvas');
  canvasEl.width = outW; canvasEl.height = outH;
  const ctx = canvasEl.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, dx, dy, img.naturalWidth, img.naturalHeight);
  const blob = await new Promise(resolve => canvasEl.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const base = (node.mediaName || node.title || 'image').replace(/\.[^.]+$/, '');
  try {
    const file = await uploadCanvasCroppedBlob(blob, `${base}_outpaint.png`);
    if (file) {
      node.mediaUrl = file.url;
      node.mediaName = file.name || node.mediaName;
      if (Array.isArray(node.mediaItems) && node.mediaItems.length) node.mediaItems[0].url = file.url;
      closeCanvasImageEditor();
      renderCanvasStudioNodes();
      canvasScheduleSave();
    }
  } catch (error) { toast(error.message || '扩展失败', 'ng'); }
}

// ===== 图片编辑器：遮罩 / 画笔 / 宫格 / 缩放 =====
let editDrawState = null;
let editDrawUndoStack = [];
let editDrawRedoStack = [];
let brushTool = 'free';
let brushLabelCounter = 1;
function canvasEditDrawCanvas() { return document.getElementById('canvas-edit-draw-canvas'); }
function canvasEditDrawContext() { return canvasEditDrawCanvas()?.getContext('2d') || null; }
function canvasEditBrushSize() {
  const id = imageEditMode === 'mask' ? 'canvas-mask-brush-size' : 'canvas-paint-brush-size';
  return Number(document.getElementById(id)?.value || 20);
}
function canvasBrushColor() { return document.getElementById('canvas-paint-brush-color')?.value || '#ff2d55'; }
function canvasEditDrawPoint(event) {
  const canvasEl = canvasEditDrawCanvas();
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvasEl.width / Math.max(1, rect.width),
    y: (event.clientY - rect.top) * canvasEl.height / Math.max(1, rect.height)
  };
}
function canvasEditDrawSnapshot() { return canvasEditDrawCanvas().toDataURL(); }
function canvasRestoreEditDrawSnapshot(snapshot) {
  const canvasEl = canvasEditDrawCanvas();
  const img = new Image();
  img.onload = () => { const c = canvasEl.getContext('2d'); c.clearRect(0, 0, canvasEl.width, canvasEl.height); c.drawImage(img, 0, 0); };
  img.src = snapshot;
}
function pushCanvasEditDrawHistory() {
  editDrawUndoStack.push(canvasEditDrawSnapshot());
  if (editDrawUndoStack.length > 30) editDrawUndoStack.shift();
  editDrawRedoStack = [];
}
function undoCanvasEditDrawing() {
  if (!editDrawUndoStack.length) return;
  editDrawRedoStack.push(canvasEditDrawSnapshot());
  canvasRestoreEditDrawSnapshot(editDrawUndoStack.pop());
}
function redoCanvasEditDrawing() {
  if (!editDrawRedoStack.length) return;
  editDrawUndoStack.push(canvasEditDrawSnapshot());
  canvasRestoreEditDrawSnapshot(editDrawRedoStack.pop());
}
function clearCanvasEditDrawing() {
  const canvasEl = canvasEditDrawCanvas();
  canvasEl?.getContext('2d')?.clearRect(0, 0, canvasEl.width, canvasEl.height);
}
function setCanvasBrushTool(tool) {
  brushTool = ['free', 'rect', 'ellipse', 'label'].includes(tool) ? tool : 'free';
  document.querySelectorAll('#canvas-image-edit-modal [data-canvas-brush-tool]').forEach(btn => {
    const active = btn.dataset.canvasBrushTool === brushTool;
    btn.classList.toggle('primary', active);
    btn.classList.toggle('secondary', !active);
  });
}
const CANVAS_MASK_BRUSH_ALPHA = 115;
function canvasSetupDrawStyle(ctx) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = canvasEditBrushSize();
  ctx.strokeStyle = imageEditMode === 'mask' ? `rgba(255,255,255,${CANVAS_MASK_BRUSH_ALPHA / 255})` : canvasBrushColor();
  ctx.fillStyle = imageEditMode === 'mask' ? `rgba(255,255,255,${CANVAS_MASK_BRUSH_ALPHA / 255})` : canvasBrushColor();
  ctx.globalCompositeOperation = 'source-over';
}
function canvasDrawBrushShape(ctx, start, end) {
  const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
  canvasSetupDrawStyle(ctx);
  if (brushTool === 'rect') ctx.strokeRect(x, y, w, h);
  else if (brushTool === 'ellipse') { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
}
function canvasCircledNumber(n) { return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n); }
function canvasDrawNumberLabel(point) {
  const canvasEl = canvasEditDrawCanvas();
  const ctx = canvasEl.getContext('2d');
  const size = Math.max(18, canvasEditBrushSize() * 2.2);
  const text = canvasCircledNumber(brushLabelCounter++);
  canvasSetupDrawStyle(ctx);
  ctx.save();
  ctx.font = `900 ${size}px Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(3, size / 8);
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeText(text, point.x, point.y);
  ctx.fillStyle = canvasBrushColor();
  ctx.fillText(text, point.x, point.y);
  ctx.restore();
}
function canvasBeginEditDraw(event) {
  if (imageEditMode !== 'mask' && imageEditMode !== 'brush') return;
  event.preventDefault(); event.stopPropagation();
  const canvasEl = canvasEditDrawCanvas();
  canvasEl.setPointerCapture?.(event.pointerId);
  const ctx = canvasEl.getContext('2d');
  const p = canvasEditDrawPoint(event);
  pushCanvasEditDrawHistory();
  if (imageEditMode === 'brush' && brushTool === 'label') {
    canvasDrawNumberLabel(p);
    editDrawState = null;
    canvasEl.releasePointerCapture?.(event.pointerId);
    return;
  }
  editDrawState = { x: p.x, y: p.y, sx: p.x, sy: p.y, pointerId: event.pointerId, snapshot: (imageEditMode === 'brush' && brushTool !== 'free') ? canvasEditDrawSnapshot() : null };
  canvasSetupDrawStyle(ctx);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + 0.01, p.y + 0.01);
  if (imageEditMode === 'mask' || brushTool === 'free') ctx.stroke();
}
function canvasMoveEditDraw(event) {
  if (!editDrawState || (imageEditMode !== 'mask' && imageEditMode !== 'brush')) return;
  event.preventDefault(); event.stopPropagation();
  const ctx = canvasEditDrawCanvas().getContext('2d');
  const p = canvasEditDrawPoint(event);
  if (imageEditMode === 'brush' && brushTool !== 'free') {
    canvasRestoreEditDrawSnapshot(editDrawState.snapshot);
    canvasDrawBrushShape(ctx, { x: editDrawState.sx, y: editDrawState.sy }, p);
    return;
  }
  canvasSetupDrawStyle(ctx);
  ctx.beginPath();
  ctx.moveTo(editDrawState.x, editDrawState.y);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  editDrawState.x = p.x; editDrawState.y = p.y;
}
function canvasEndEditDraw(event) {
  if (editDrawState && event?.pointerId != null) canvasEditDrawCanvas().releasePointerCapture?.(event.pointerId);
  editDrawState = null;
}
function canvasMaskCanvasFromDrawCanvas() {
  const src = canvasEditDrawCanvas();
  const mask = document.createElement('canvas');
  mask.width = src.width; mask.height = src.height;
  const srcData = src.getContext('2d').getImageData(0, 0, src.width, src.height);
  const ctx = mask.getContext('2d');
  const out = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < srcData.data.length; i += 4) {
    const painted = srcData.data[i + 3] > 8;
    const v = painted ? 255 : 0;
    out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return mask;
}
async function applyCanvasImageMask() {
  if (!cropState) return;
  const node = canvasGetNode(cropState.nodeId);
  if (!node) return;
  const mask = canvasMaskCanvasFromDrawCanvas();
  const blob = await new Promise(resolve => mask.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const base = (node.mediaName || node.title || 'image').replace(/\.[^.]+$/, '');
  try {
    const file = await uploadCanvasCroppedBlob(blob, `${base}_mask.png`);
    if (file) {
      node.mediaUrl = file.url;
      node.mediaName = file.name || node.mediaName;
      if (Array.isArray(node.mediaItems) && node.mediaItems.length) node.mediaItems[0].url = file.url;
      closeCanvasImageEditor();
      renderCanvasStudioNodes();
      canvasScheduleSave();
    }
  } catch (error) { toast(error.message || '遮罩失败', 'ng'); }
}
async function applyCanvasImageBrush() {
  if (!cropState) return;
  const node = canvasGetNode(cropState.nodeId);
  const img = document.getElementById('canvas-crop-image');
  if (!node || !img.naturalWidth || !img.naturalHeight) return;
  const canvasEl = document.createElement('canvas');
  canvasEl.width = img.naturalWidth; canvasEl.height = img.naturalHeight;
  const ctx = canvasEl.getContext('2d');
  ctx.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);
  ctx.drawImage(canvasEditDrawCanvas(), 0, 0);
  const blob = await new Promise(resolve => canvasEl.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const base = (node.mediaName || node.title || 'image').replace(/\.[^.]+$/, '');
  try {
    const file = await uploadCanvasCroppedBlob(blob, `${base}_paint.png`);
    if (file) {
      node.mediaUrl = file.url;
      node.mediaName = file.name || node.mediaName;
      if (Array.isArray(node.mediaItems) && node.mediaItems.length) node.mediaItems[0].url = file.url;
      closeCanvasImageEditor();
      renderCanvasStudioNodes();
      canvasScheduleSave();
    }
  } catch (error) { toast(error.message || '画笔失败', 'ng'); }
}
function canvasGridSplitSettings() {
  const hLines = Math.max(0, Math.min(20, Number(document.getElementById('canvas-grid-h-lines')?.value || 0)));
  const vLines = Math.max(0, Math.min(20, Number(document.getElementById('canvas-grid-v-lines')?.value || 0)));
  return { rows: hLines + 1, cols: vLines + 1, gap: 0 };
}
function canvasGridSplitRects(width, height) {
  const { rows, cols, gap } = canvasGridSplitSettings();
  const halfGap = gap / 2;
  const rects = [];
  for (let row = 0; row < rows; row++) {
    const topLine = row * height / rows;
    const bottomLine = (row + 1) * height / rows;
    const y1 = Math.round(row === 0 ? 0 : topLine + halfGap);
    const y2 = Math.round(row === rows - 1 ? height : bottomLine - halfGap);
    for (let col = 0; col < cols; col++) {
      const leftLine = col * width / cols;
      const rightLine = (col + 1) * width / cols;
      const x1 = Math.round(col === 0 ? 0 : leftLine + halfGap);
      const x2 = Math.round(col === cols - 1 ? width : rightLine - halfGap);
      if (x2 > x1 && y2 > y1) rects.push({ row, col, x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
  }
  return rects;
}
function applyCanvasGridPreset(rows, cols) {
  const h = document.getElementById('canvas-grid-h-lines');
  const v = document.getElementById('canvas-grid-v-lines');
  if (h) h.value = String(Math.max(0, Number(rows || 1) - 1));
  if (v) v.value = String(Math.max(0, Number(cols || 1) - 1));
}
async function applyCanvasImageGridSplit() {
  if (!cropState) return;
  const node = canvasGetNode(cropState.nodeId);
  const img = document.getElementById('canvas-crop-image');
  if (!node || !img.naturalWidth || !img.naturalHeight) return;
  const rects = canvasGridSplitRects(img.naturalWidth, img.naturalHeight);
  if (!rects.length) return;
  const base = (node.mediaName || node.title || 'image').replace(/\.[^.]+$/, '');
  const blobs = [];
  for (const rect of rects) {
    const canvasEl = document.createElement('canvas');
    canvasEl.width = rect.w; canvasEl.height = rect.h;
    canvasEl.getContext('2d').drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const blob = await new Promise(resolve => canvasEl.toBlob(resolve, 'image/png'));
    if (blob) blobs.push({ blob, name: `${base}_r${rect.row + 1}_c${rect.col + 1}.png` });
  }
  if (!blobs.length) return;
  try {
    const files = [];
    for (const b of blobs) {
      const file = await uploadCanvasCroppedBlob(b.blob, b.name);
      if (file) files.push(file);
    }
    if (files.length) {
      node.mediaItems = files.map(f => ({ id: canvasNodeId('media'), kind: 'image', url: f.url, name: f.name, mime: 'image/png' }));
      node.mediaUrl = files[0].url;
      node.mediaName = files[0].name;
      closeCanvasImageEditor();
      renderCanvasStudioNodes();
      canvasScheduleSave();
    }
  } catch (error) { toast(error.message || '宫格切分失败', 'ng'); }
}
function canvasResizeScaleChanged() {
  const scale = Number(document.getElementById('canvas-image-resize-scale')?.value || 0.5);
  const img = document.getElementById('canvas-crop-image');
  const el = document.getElementById('canvas-image-resize-resolution');
  if (el && img?.naturalWidth) el.textContent = `${Math.round(img.naturalWidth * scale)}×${Math.round(img.naturalHeight * scale)}`;
}
async function applyCanvasImageResize() {
  if (!cropState) return;
  const node = canvasGetNode(cropState.nodeId);
  const img = document.getElementById('canvas-crop-image');
  if (!node || !img.naturalWidth || !img.naturalHeight) return;
  const scale = Math.max(0.05, Math.min(1, Number(document.getElementById('canvas-image-resize-scale')?.value || 0.5)));
  const targetW = Math.max(1, Math.round(img.naturalWidth * scale));
  const targetH = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvasEl = document.createElement('canvas');
  canvasEl.width = targetW; canvasEl.height = targetH;
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, targetW, targetH);
  const blob = await new Promise(resolve => canvasEl.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const base = (node.mediaName || node.title || 'image').replace(/\.[^.]+$/, '');
  try {
    const file = await uploadCanvasCroppedBlob(blob, `${base}_resize_${Math.round(scale * 100)}pct.png`);
    if (file) {
      node.mediaUrl = file.url;
      node.mediaName = file.name || node.mediaName;
      if (Array.isArray(node.mediaItems) && node.mediaItems.length) node.mediaItems[0].url = file.url;
      closeCanvasImageEditor();
      renderCanvasStudioNodes();
      canvasScheduleSave();
    }
  } catch (error) { toast(error.message || '缩放失败', 'ng'); }
}

function canvasStudioAddNode(type, point) {
  if (!document.getElementById('canvas-studio-board')) return;
  const before = canvasEditorSnapshot();
  const baseNode = canvasIsGroupNode(type)
    ? { id: canvasNodeId(type), type, x: point?.x ?? 0, y: point?.y ?? 0, title: canvasNodeTitle(type), width: 360, height: 240, items: [], collapsed: false, createdAt: Date.now() }
    : { id: canvasNodeId(type), type, x: point?.x ?? (canvasStudioState.nodes.length % 3) * 286 - 260, y: point?.y ?? Math.floor(canvasStudioState.nodes.length / 3) * 230 - 150, title: canvasNodeTitle(type), prompt: '', text: type === 'prompt' ? '' : undefined, mediaItems: [], mediaUrl: '', mediaName: '', mediaSize: '', asset: null, generationKind: 'image', apiProvider: canvasStudioState.canvasConfig?.primaryProviderId || '', model: canvasStudioState.canvasConfig?.imageModel || canvasModelOptions.image[0]?.value || 'gpt-image-2', ratio: 'square', resolution: '1k', customRatio: '', customSize: '', customRatioWidth: '', customRatioHeight: '', customWidth: '', customHeight: '', inputs: [], loopCount: 3, loopMode: 'serial', loopStart: 1, variablePrompt: '', fixedPrompt: '', minimaxEngine: 'MiniMax H3', duration: 8, aspectRatio: '16:9', videoStatus: 'reserved', status: 'idle', error: '', outputUrl: '' };
  const node = canvasIsClassicCanvasNode(type) ? { ...baseNode, ...(canvasClassicNodeDefaults[type] || {}) } : baseNode;
  canvasNormalizeNodeSize(node);
  canvasStudioState.nodes.push(node);
  canvasSetSelection([node.id]);
  canvasEditorCommit(before, 'add-node');
  renderCanvasStudioNodes();
}

function canvasNodeMediaItems(node) {
  const items = Array.isArray(node?.mediaItems) ? node.mediaItems.filter(item => item?.url) : [];
  return items.length ? items : (node?.mediaUrl ? [{ id: 'legacy-media', kind: 'image', url: node.mediaUrl, name: node.mediaName || '已选择图片', size: node.mediaSize || '', mime: node.asset?.mime || 'image/*', asset: node.asset || null }] : []);
}
function canvasMediaKind(item) { const mime = String(item?.mime || '').toLowerCase(); return item?.kind === 'video' || mime.startsWith('video/') ? 'video' : item?.kind === 'audio' || mime.startsWith('audio/') ? 'audio' : 'image'; }
function canvasMediaSignature(item) { return `${canvasMediaKind(item)}:${String(item?.url || '')}`; }
function canvasMediaLabel(item) { return canvasEscape(item?.name || '未命名素材'); }
function canvasMediaContent(item) {
  const kind = canvasMediaKind(item); const url = canvasEscape(item.previewUrl || item.url); const originalUrl = canvasEscape(item.url); const signature = canvasMediaSignature(item);
  if (kind === 'video') return item.inlineVideoActive ? `<video class="canvas-inline-video" src="${originalUrl}" data-media-signature="${signature}" controls preload="metadata"></video>` : `<div class="canvas-media-video-poster" data-media-signature="${signature}"><video src="${originalUrl}" muted preload="metadata"></video><button type="button" class="canvas-video-play" data-media-signature="${signature}">▶</button><span>视频</span></div>`;
  if (kind === 'audio') return `<div class="canvas-media-audio-card" data-media-signature="${signature}"><span>♫</span><strong>${canvasMediaLabel(item)}</strong><audio src="${originalUrl}" data-media-signature="${signature}" controls preload="metadata"></audio></div>`;
  return `<img src="${url}" data-original-src="${originalUrl}" alt="${canvasMediaLabel(item)}" data-media-signature="${signature}" draggable="false">`;
}
function canvasMediaResolutionLabel(item) { return Number(item?.width) > 0 && Number(item?.height) > 0 ? `${item.width} × ${item.height}` : ''; }
function canvasImageNodeBody(node) {
  const items = canvasNodeMediaItems(node);
  const input = `<input type="file" accept="image/*,video/*,audio/*" multiple onchange="canvasStudioChooseMedia('${node.id}',this)">`;
  if (!items.length) return `<label class="canvas-node-upload canvas-media-node-drop">${input}<strong>导入素材</strong><small>图片、视频、音频都能导入</small></label>`;
  const itemMarkup = (item, index) => `<div class="canvas-media-item" data-media-index="${index}" data-media-signature="${canvasMediaSignature(item)}">${canvasMediaContent(item)}<div class="canvas-media-floating-menu smart-node-floating-menu"><button type="button" data-media-action="preview" title="预览">⌕</button><button type="button" data-media-action="download" title="下载">↓</button>${canvasMediaKind(item) === 'image' ? `<button type="button" onclick="openCanvasImageEditor('${node.id}','crop')" title="编辑图片">✎</button>` : ''}</div><span class="canvas-media-name">${canvasMediaLabel(item)}</span>${item.size ? `<span class="canvas-media-size">${canvasEscape(item.size)}</span>` : ''}${canvasMediaResolutionLabel(item) ? `<span class="image-resolution-badge">${canvasMediaResolutionLabel(item)}</span>` : ''}<button type="button" class="canvas-media-delete" data-media-index="${index}">×</button></div>`;
  return `<div class="canvas-media-node-body"><div class="${items.length > 1 ? 'canvas-media-thumb-grid' : 'canvas-media-single'}">${items.map(itemMarkup).join('')}</div><label class="canvas-media-add">${input}＋ 添加素材</label></div>`;
}

function canvasSmartPromptSegments(node) {
  const text = canvasPromptValue(node);
  const separator = String(node?.promptSeparator || '').trim();
  const pattern = separator ? new RegExp(separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /(?:[。！？!？]|\n+)/g;
  return text.split(pattern).map(item => item.trim()).filter(Boolean).slice(0, 12);
}
function canvasSmartPromptSetSeparator(id, value) {
  const node = canvasGetNode(id);
  if (!node) return;
  const before = canvasEditorSnapshot();
  node.promptSeparator = String(value || '').slice(0, 8);
  canvasEditorCommit(before, 'prompt-separator');
  renderCanvasStudioNodes();
}
function canvasSmartPromptSetPreviewHeight(id, value) {
  const node = canvasGetNode(id);
  if (!node) return;
  node.promptSplitPreviewHeight = Math.min(180, Math.max(48, Number(value) || 80));
  canvasScheduleSave();
}
function canvasSmartPromptUpstream(node) {
  return canvasStudioState.connections.filter(edge => edge.to === node.id).map(edge => canvasGetNode(edge.from)).filter(Boolean);
}
function canvasSmartPromptSplit(id) {
  const node = canvasGetNode(id);
  if (!node) return;
  const segments = canvasSmartPromptSegments(node);
  if (segments.length < 2) return toast('请先输入至少两段提示词', 'ng');
  const before = canvasEditorSnapshot();
  node.segments = segments;
  canvasSetPromptValue(node, segments.join('\n'));
  canvasEditorCommit(before, 'prompt-split');
  renderCanvasStudioNodes();
}
function canvasSmartPromptRewrite(id) {
  const node = canvasGetNode(id);
  if (!node || !canvasPromptValue(node)) return toast('请先填写提示词', 'ng');
  const before = canvasEditorSnapshot();
  canvasSetPromptValue(node, `${canvasPromptValue(node)}，画面清晰、主体突出、细节丰富、构图自然`);
  canvasEditorCommit(before, 'prompt-rewrite');
  renderCanvasStudioNodes();
  canvasStudioLog('已完成提示词结构化改写', 'success');
}
function canvasSmartPromptNodeBody(node) {
  const upstream = canvasSmartPromptUpstream(node);
  const upstreamMarkup = upstream.length ? upstream.map(item => `<span class="prompt-node-pill">${canvasEscape(item.title || canvasNodeTitle(item.type))}</span>`).join('') : '<span class="prompt-node-muted">暂无上游节点</span>';
  const segments = canvasSmartPromptSegments(node);
  const previewHeight = Math.min(180, Math.max(48, Number(node.promptSplitPreviewHeight) || 80));
  const segmentMarkup = `<div class="prompt-node-segments" style="max-height:${previewHeight}px">${segments.length ? segments.map((item, index) => `<span class="prompt-node-segment">${index + 1}. ${canvasEscape(item)}</span>`).join('') : '<span class="prompt-node-muted">输入提示词后在此预览分段</span>'}</div><input class="prompt-split-preview-resize" type="range" min="48" max="180" value="${previewHeight}" oninput="canvasSmartPromptSetPreviewHeight('${node.id}',this.value)">`;
  return `<article class="prompt-node-card"><div class="prompt-node-label">PROMPT</div><textarea class="canvas-node-textarea smart-node-textarea prompt-node-text" placeholder="描述你想生成的内容..." oninput="canvasStudioSetPrompt('${node.id}',this.value)">${canvasEscape(canvasPromptValue(node))}</textarea><div class="prompt-node-split-row"><span>分隔符</span><input class="prompt-node-separator" maxlength="8" value="${canvasEscape(node.promptSeparator || '')}" placeholder="标点/换行" onchange="canvasSmartPromptSetSeparator('${node.id}',this.value)"><button type="button" class="btn bs" onclick="canvasSmartPromptSplit('${node.id}')">拆分</button></div>${segmentMarkup}<div class="prompt-node-upstream-list"><span class="prompt-node-muted">上游输入</span>${upstreamMarkup}</div><div class="prompt-node-tools"><button type="button" class="btn bs" onclick="canvasSmartPromptRewrite('${node.id}')">LLM 改写</button><span class="prompt-node-llm">${BRAND.name} Canvas</span></div><div class="smart-node-hint">支持按指定分隔符预览；提示词可连接 API 生成节点或由 Composer 同步填充</div></article>`;
}
function canvasComposerSelectedNode() {
  return canvasGetNode(canvasStudioState.selectedId) || canvasSelectedNodes()[0] || null;
}
function canvasStudioSyncComposerVisibility() {
  const composer = document.getElementById('composer');
  if (!composer) return;
  const state = canvasStudioState.composer || (canvasStudioState.composer = { visible: true, left: null, top: null });
  composer.classList.toggle('is-hidden', state.visible === false);
  if (Number.isFinite(state.left) && Number.isFinite(state.top)) {
    composer.style.left = `${Math.max(12, state.left)}px`;
    composer.style.top = `${Math.max(12, state.top)}px`;
    composer.style.right = 'auto';
    composer.style.bottom = 'auto';
  }
}
function canvasStudioShowComposer() {
  canvasStudioState.composer = { ...(canvasStudioState.composer || {}), visible: true };
  canvasStudioSyncComposerVisibility();
  renderCanvasComposer();
}
function canvasStudioHideComposer() {
  canvasStudioState.composer = { ...(canvasStudioState.composer || {}), visible: false };
  canvasStudioSyncComposerVisibility();
}
function canvasComposerContext(selected = canvasComposerSelectedNode()) {
  if (!selected) return { status: '请先创建或选择 API 生成节点', canRun: false, kind: 'empty' };
  if (canvasIsGeneratorNode(selected)) {
    const running = selected.status === 'running';
    const imageMode = (selected.generationKind || 'image') === 'image';
    return {
      status: running ? '当前生成节点正在运行' : imageMode ? '已连接 API 生成节点，可运行' : '当前生成节点为视频模式，视频适配器后续接入',
      canRun: !running && imageMode,
      kind: 'generate'
    };
  }
  if (selected.type === 'prompt') return { status: '正在编辑 Prompt 节点；连接到 API 生成节点后运行', canRun: false, kind: 'prompt' };
  if (selected.type === 'image' || selected.type === 'smart-image') return { status: '当前是素材/结果节点，请连接到 API 生成节点后运行', canRun: false, kind: 'asset' };
  if (selected.type === 'loop') return { status: '当前是 Loop 节点，请使用节点内“运行此循环”', canRun: false, kind: 'loop' };
  if (selected.type === 'minimax') return { status: '当前是 MiniMax 时间线，真实视频生成适配器未接入', canRun: false, kind: 'minimax' };
  if (canvasIsClassicCanvasNode(selected)) return { status: '该节点已迁移 UI，真实 API 尚未接入', canRun: false, kind: selected.type };
  return { status: '当前节点不可直接通过 Composer 运行', canRun: false, kind: selected.type || 'node' };
}
function canvasComposerSetPrompt(value) {
  const selected = canvasComposerSelectedNode();
  if (!selected) return toast('请先创建或选择节点', 'ng');
  let promptNode = selected.type === 'prompt' ? selected : canvasStudioInputNodes(selected.id, 'prompt')[0];
  if (!promptNode) {
    canvasStudioAddNode('prompt', { x: selected.x - 330, y: selected.y });
    promptNode = canvasStudioState.nodes.filter(item => item.type === 'prompt').slice(-1)[0];
    if (promptNode) canvasStudioState.connections.push({ id: `canvas-connection-${Date.now()}`, from: promptNode.id, fromPort: 'out', to: selected.id, toPort: 'prompt', type: 'prompt' });
  }
  if (promptNode) { canvasSetPromptValue(promptNode, value); renderCanvasStudioNodes(); canvasScheduleSave(); }
}

// ===== 提示词模板库 =====
let canvasPromptTemplates = [];
let canvasPromptLibraries = [];
let canvasPromptActiveLibId = 'system';
let canvasPromptTemplateCategory = 'all';
let canvasPromptTemplateSelectedId = '';
let canvasPromptTemplateQuery = '';
const canvasPromptCategoryNames = { view: '视角', storyboard: '分镜', character: '角色', product: '产品', lighting: '光影', custom: '我的' };
function activeCanvasPromptLibrary() {
  return canvasPromptLibraries.find(lib => lib.id === canvasPromptActiveLibId) || canvasPromptLibraries[0] || { id: 'system', name: '系统提示词库', categories: [], items: [] };
}
async function loadCanvasPromptTemplates() {
  try {
    const data = await api('/api/canvas/prompt-libraries');
    canvasPromptLibraries = Array.isArray(data?.library?.libraries) ? data.library.libraries : [];
    if (!canvasPromptLibraries.some(lib => lib.id === canvasPromptActiveLibId)) {
      canvasPromptActiveLibId = canvasPromptLibraries.some(lib => lib.id === 'system') ? 'system' : (canvasPromptLibraries[0]?.id || 'system');
    }
  } catch (_error) {
    canvasPromptLibraries = [];
  }
  const lib = activeCanvasPromptLibrary();
  canvasPromptTemplates = Array.isArray(lib?.items) ? lib.items.filter(item => item?.id && item?.positive) : [];
}
async function openCanvasPromptTemplate() {
  canvasPromptTemplateCategory = 'all';
  canvasPromptTemplateSelectedId = '';
  canvasPromptTemplateQuery = '';
  await loadCanvasPromptTemplates();
  const modal = document.getElementById('canvas-prompt-template-modal');
  if (!modal) return;
  const searchEl = document.getElementById('canvas-prompt-template-search');
  if (searchEl) searchEl.value = '';
  renderCanvasPromptTemplateCats();
  renderCanvasPromptTemplateList();
  modal.classList.add('is-open');
}
function closeCanvasPromptTemplate(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('canvas-prompt-template-modal')?.classList.remove('is-open');
}
function canvasPromptTemplateSetLib(libId) {
  canvasPromptActiveLibId = libId;
  canvasPromptTemplateCategory = 'all';
  canvasPromptTemplateSelectedId = '';
  const lib = activeCanvasPromptLibrary();
  canvasPromptTemplates = Array.isArray(lib?.items) ? lib.items.filter(item => item?.id && item?.positive) : [];
  renderCanvasPromptTemplateCats();
  renderCanvasPromptTemplateList();
}
function canvasPromptTemplatePickCat(category) {
  canvasPromptTemplateCategory = category;
  canvasPromptTemplateSelectedId = '';
  renderCanvasPromptTemplateCats();
  renderCanvasPromptTemplateList();
}
function canvasPromptTemplatePick(id) {
  canvasPromptTemplateSelectedId = id;
  renderCanvasPromptTemplateList();
}
function renderCanvasPromptTemplateCats() {
  const el = document.getElementById('canvas-prompt-template-cats');
  const libSel = document.getElementById('canvas-prompt-template-lib');
  if (libSel) {
    libSel.innerHTML = canvasPromptLibraries.map(lib => `<option value="${canvasEscape(lib.id)}" ${lib.id === canvasPromptActiveLibId ? 'selected' : ''}>${canvasEscape(lib.name || '提示词库')}</option>`).join('');
  }
  if (!el) return;
  const lib = activeCanvasPromptLibrary();
  const cats = [{ id: 'all', name: '全部' }, ...(Array.isArray(lib?.categories) ? lib.categories : [])];
  const counts = { all: canvasPromptTemplates.length };
  canvasPromptTemplates.forEach(item => { const c = item.category || 'custom'; counts[c] = (counts[c] || 0) + 1; });
  el.innerHTML = cats.map(cat => `<button type="button" class="${canvasPromptTemplateCategory === cat.id ? 'active' : ''}" onclick="canvasPromptTemplatePickCat('${cat.id}')">${canvasEscape(cat.name)}<small>${counts[cat.id] || 0}</small></button>`).join('');
}
function canvasPromptTemplateVisibleItems() {
  const query = String(canvasPromptTemplateQuery || document.getElementById('canvas-prompt-template-search')?.value || '').trim().toLowerCase();
  return canvasPromptTemplates.filter(item => {
    if (canvasPromptTemplateCategory !== 'all' && item.category !== canvasPromptTemplateCategory) return false;
    if (!query) return true;
    const haystack = [item.name, item.scene, item.positive, item.negative].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}
function canvasPromptTemplateSearchInput() {
  canvasPromptTemplateQuery = document.getElementById('canvas-prompt-template-search')?.value || '';
  canvasPromptTemplateSelectedId = '';
  renderCanvasPromptTemplateList();
}
function renderCanvasPromptTemplateList() {
  const listEl = document.getElementById('canvas-prompt-template-list');
  const detailEl = document.getElementById('canvas-prompt-template-detail');
  if (!listEl || !detailEl) return;
  const items = canvasPromptTemplateVisibleItems();
  if (items.length && !items.some(item => item.id === canvasPromptTemplateSelectedId)) canvasPromptTemplateSelectedId = items[0].id;
  const selected = items.find(item => item.id === canvasPromptTemplateSelectedId) || items[0] || null;
  listEl.innerHTML = items.length ? items.map(item => `<button type="button" class="smart-template-card ${item.id === selected?.id ? 'active' : ''}" onclick="canvasPromptTemplatePick('${item.id}')"><span class="smart-template-name">${canvasEscape(item.name || '未命名')}</span><span class="smart-template-scene">${canvasEscape(item.scene || '')}</span><span class="smart-template-tag">${canvasEscape(canvasPromptCategoryNames[item.category] || item.category || '我的')}</span></button>`).join('') : '<div class="smart-template-empty">无匹配模板</div>';
  renderCanvasPromptTemplateDetail(selected);
}
function renderCanvasPromptTemplateDetail(template) {
  const el = document.getElementById('canvas-prompt-template-detail');
  if (!el) return;
  if (!template) { el.innerHTML = '<div class="smart-template-empty">选择左侧模板查看详情</div>'; return; }
  const params = Object.entries(template.params || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  el.innerHTML = `<div class="smart-template-detail-head"><strong>${canvasEscape(template.name || '未命名')}</strong><span>${canvasEscape(canvasPromptCategoryNames[template.category] || template.category || '')}</span></div><div class="smart-template-section"><label>正向提示词</label><p>${canvasEscape(template.positive || '')}</p></div>${template.negative ? `<div class="smart-template-section"><label>负向提示词</label><p>${canvasEscape(template.negative)}</p></div>` : ''}${params ? `<div class="smart-template-section"><label>参数建议</label><p>${canvasEscape(params)}</p></div>` : ''}`;
}
function applyCanvasPromptTemplate(mode) {
  const template = canvasPromptTemplates.find(item => item.id === canvasPromptTemplateSelectedId);
  if (!template) return toast('请先选择一个模板', 'ng');
  const positive = String(template.positive || '').trim();
  let text = positive;
  if (mode === 'full') {
    const negative = String(template.negative || '').trim();
    const params = Object.entries(template.params || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    text = [positive, negative ? `Negative prompt:\n${negative}` : '', params ? `Params:\n${params}` : ''].filter(Boolean).join('\n\n');
  }
  canvasComposerSetPrompt(text);
  closeCanvasPromptTemplate();
}
function renderCanvasComposer() {
  const selected = canvasComposerSelectedNode();
  const context = canvasComposerContext(selected);
  const input = document.getElementById('promptInput');
  const promptNode = selected?.type === 'prompt' ? selected : selected ? canvasStudioInputNodes(selected.id, 'prompt')[0] : null;
  if (input && document.activeElement !== input) input.textContent = canvasPromptValue(promptNode);
  const preview = document.getElementById('inputPromptPreview');
  const promptText = canvasPromptValue(promptNode);
  if (preview) preview.textContent = promptText ? `已连接提示词：${promptText.slice(0, 80)}` : context.status;
  const status = document.getElementById('composerContextStatus');
  if (status) {
    status.textContent = context.status;
    status.dataset.kind = context.kind;
  }
  const params = document.getElementById('dynamicParams');
  if (params) params.innerHTML = canvasIsGeneratorNode(selected)
    ? '<label class="composer-param">比例<select><option>16:9</option><option>1:1</option><option>9:16</option></select></label><label class="composer-param">分辨率<select><option>1K</option><option>2K</option></select></label>'
    : '<div class="composer-param-note">选择 API 生成节点后显示生成参数</div>';
  const toggle = document.getElementById('apiKindToggle');
  if (toggle) toggle.querySelectorAll('button').forEach(button => button.classList.toggle('active', (selected?.generationKind || 'image') === button.dataset.kind));
  const runBtn = document.getElementById('runBtn');
  if (runBtn) {
    runBtn.disabled = !context.canRun;
    runBtn.classList.toggle('is-disabled', !context.canRun);
    runBtn.title = context.canRun ? '运行当前 API 生成节点' : context.status;
  }
  const cascadeBtn = document.getElementById('cascadeRunBtn');
  if (cascadeBtn) cascadeBtn.disabled = !selected;
  canvasStudioSyncComposerVisibility();
}
function bindCanvasComposer() {
  const composer = document.getElementById('composer');
  if (!composer || composer.dataset.bound === 'true') return;
  composer.dataset.bound = 'true';
  const input = document.getElementById('promptInput');
  input?.addEventListener('input', () => canvasComposerSetPrompt(input.textContent));
  document.getElementById('composerCloseBtn')?.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); canvasStudioHideComposer(); });
  document.getElementById('composerTemplateBtn')?.addEventListener('click', () => openCanvasPromptTemplate());
  document.getElementById('runBtn')?.addEventListener('click', () => { const node = canvasComposerSelectedNode(); const context = canvasComposerContext(node); if (canvasIsGeneratorNode(node) && context.canRun) canvasStudioGenerateAsync(node.id); else toast(context.status, 'ng'); });
  document.getElementById('cascadeRunBtn')?.addEventListener('click', canvasCascadeButtonClick);
  renderCanvasComposer();
}
function canvasNodeBody(node) {
  if (node.type === 'prompt') return canvasSmartPromptNodeBody(node);
  return canvasNodeBodyLegacy(node);
}

function canvasNodeBodyLegacy(node) {
  const cascadeState = canvasCascadeNodeState(node.id);
  const cascadeBadge = cascadeState ? `<div class="canvas-cascade-state canvas-cascade-${cascadeState}">${({ queued: '排队中', running: '运行中', done: '已完成', failed: '失败', stopped: '已停止' })[cascadeState] || cascadeState}</div>` : '';
  if (node.type === 'promptGroup') return canvasPromptGroupNodeBody(node);
  if (node.type === 'group') {
    const members = canvasGroupMembers(node);
    const compactMembers = members.filter(item => item.type === 'prompt' || item.type === 'loop').slice(0, 4);
    return `<div class="canvas-group-body smart-group-card"><div class="smart-group-summary"><strong>${members.length ? `包含 ${members.length} 个节点` : '智能分组'}</strong><span>${canvasGroupSummary(node)}</span></div>${canvasGroupThumbnailMarkup(node)}${compactMembers.length ? `<div class="smart-group-compact-members">${compactMembers.map(item => `<span class="smart-group-member-node">${canvasEscape(canvasGroupMemberLabel(item))}</span>`).join('')}</div>` : ''}<div class="canvas-group-actions"><button class="btn bs" onclick="canvasStudioToggleGroup('${node.id}')">${node.collapsed ? '展开组' : '折叠组'}</button><button class="btn bs" onclick="canvasStudioAddSelectedToGroup('${node.id}')">加入选中</button><button class="btn bs" onclick="canvasStudioRemoveSelectedFromGroup('${node.id}')">移出选中</button><button class="btn bs" onclick="canvasAutoLayoutGroupById('${node.id}')">自动排版</button><button class="btn bs" onclick="canvasStudioUngroup('${node.id}')">解组</button></div></div>`;
  }
  if (node.type === 'image') return canvasImageNodeBody(node);
  if (node.type === 'prompt') return `<div class="smart-node-section"><div class="smart-node-label">PROMPT</div><textarea class="canvas-node-textarea smart-node-textarea" placeholder="输入生成要求" oninput="canvasStudioSetPrompt('${node.id}',this.value)">${canvasEscape(node.prompt)}</textarea><div class="smart-node-hint">可连接到 API 生成节点</div></div>`;
  if (node.type === 'loop') {
    const active = canvasStudioState.cascade?.active && canvasStudioState.cascade?.loopNodeId === node.id;
    const current = active ? Number(canvasStudioState.cascade.currentIndex || 0) : 0;
    const count = Math.min(100, Math.max(1, Number(node.loopCount) || 3));
    const start = Math.max(1, Number(node.loopStart) || 1);
    const roundPills = Array.from({ length: Math.min(count, 12) }, (_, index) => `<span class="loop-smart-round${active && current === start + index ? ' is-active' : ''}">${start + index}</span>`).join('');
    return `<div class="loop-smart-card"><div class="loop-smart-panel"><div class="loop-smart-title"><span>批次循环</span><em>${node.loopMode === 'parallel' ? '并行' : '串行'}</em></div><div class="smart-node-field-row loop-smart-number-row"><label>轮数<input type="number" min="1" max="100" value="${count}" onchange="canvasStudioSetNodeField('${node.id}','loopCount',this.value)"></label><label>起始<input type="number" min="1" value="${start}" onchange="canvasStudioSetNodeField('${node.id}','loopStart',this.value)"></label></div><label class="smart-node-field">运行模式<select onchange="canvasStudioSetNodeField('${node.id}','loopMode',this.value)"><option value="serial" ${node.loopMode === 'serial' ? 'selected' : ''}>串行</option><option value="parallel" ${node.loopMode === 'parallel' ? 'selected' : ''}>并行</option></select></label></div><div class="loop-smart-panel"><div class="loop-smart-label">变量提示词（支持《计数》）</div><textarea class="loop-smart-text" placeholder="例如：第《计数》版，保持主体一致" oninput="canvasStudioSetLoopText('${node.id}','variablePrompt',this.value)">${canvasEscape(node.variablePrompt || '')}</textarea><div class="loop-smart-label">固定补充提示词</div><textarea class="loop-smart-text is-small" placeholder="每轮均附加" oninput="canvasStudioSetLoopText('${node.id}','fixedPrompt',this.value)">${canvasEscape(node.fixedPrompt || '')}</textarea></div><div class="loop-smart-rounds">${roundPills}${count > 12 ? `<span class="loop-smart-more">+${count - 12}</span>` : ''}</div><div class="loop-smart-footer"><span>${active ? `运行至第 ${current}` : `将执行 ${count} 轮`}</span><button class="btn bp smart-loop-run-btn" type="button" onclick="canvasStudioRunCascade('${node.id}')">${active ? '运行中' : '运行此循环'}</button></div></div>`;
  }
  if (node.type === 'minimax') return canvasMinimaxNodeBody(node);
  if (canvasIsClassicCanvasNode(node)) return canvasClassicNodeBody(node);
  if (canvasIsGeneratorNode(node)) {
    const models = canvasModelOptions[node.generationKind] || [];
    const running = node.status === 'running';
    return `<div class="canvas-node-setting"><label>生成类型<select ${running ? 'disabled' : ''} onchange="canvasStudioSetGenerationKind('${node.id}',this.value)"><option value="image" ${node.generationKind === 'image' ? 'selected' : ''}>图片生成</option><option value="video" ${node.generationKind === 'video' ? 'selected' : ''}>视频生成</option></select></label><label>模型<select ${running ? 'disabled' : ''} onchange="canvasStudioSetModel('${node.id}',this.value)">${models.map(item => `<option value="${item.value}" ${node.model === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label><button class="btn bp canvas-generate-btn" ${node.generationKind !== 'image' || running ? 'disabled' : ''} onclick="canvasStudioGenerate('${node.id}')">${running ? '正在生成…' : node.generationKind === 'image' ? '生成图片' : '视频将在后续接入'}</button><div class="canvas-node-pending">${node.error ? canvasEscape(node.error) : running ? '正在调用 ${BRAND.name} 当前图片接口…' : '连接提示词后可生成；图片节点为可选参考输入'}</div></div>`;
  }
  if (node.type === 'smart-image' && node.pending) return `<div class="canvas-node-result-empty canvas-smart-image-pending"><strong>Image</strong><span>正在生成，结果将回写到此节点</span><i></i></div>`;
  if (node.outputUrl) {
    const history = Array.isArray(node.outputHistory) ? node.outputHistory.filter(item => item?.outputUrl).slice(-12) : [];
    const historyMarkup = history.length > 1 ? `<div class="canvas-result-history"><div class="canvas-result-history-title">循环结果（${history.length}）</div><div class="canvas-result-history-grid">${history.map(item => `<button type="button" class="canvas-result-history-item" onclick="openCanvasImagePreview('${canvasEscape(item.outputUrl)}','第 ${Number(item.index) || 0} 轮结果')"><img src="${canvasEscape(item.outputUrl)}" alt="第 ${Number(item.index) || 0} 轮结果"><span>第 ${Number(item.index) || 0} 轮</span></button>`).join('')}</div></div>` : '';
    return `<div class="canvas-node-result"><img src="${node.outputUrl}" alt="画布生成结果" onclick="openCanvasImagePreview('${node.outputUrl}','生成结果')"><a class="btn bs" href="${node.outputUrl}" download>下载图片</a>${historyMarkup}</div>`;
  }
  if (node.error) return `<div class="canvas-node-result-empty is-error"><strong>生成失败</strong><span>${canvasEscape(node.error)}</span></div>`;
  return `<div class="canvas-node-result-empty"><strong>等待结果</strong><span>连接生成节点后显示图片</span></div>`;
}
const canvasClassicNumericFields = new Set(['msWidth', 'msHeight', 'comfyWidth', 'comfyHeight', 'count', 'duration', 'durationFrames', 'durationSeconds', 'frameRate', 'customWidth', 'customHeight', 'enhanceStrength']);
function canvasStudioSetClassicField(id, field, value) {
  const node = canvasGetNode(id);
  if (!node || !canvasIsClassicCanvasNode(node)) return;
  const before = canvasEditorSnapshot();
  if (canvasClassicNumericFields.has(field)) node[field] = Math.max(0, Number(value) || 0);
  else node[field] = value;
  canvasEditorCommit(before, `classic-field-${field}`);
  renderCanvasStudioNodes();
}
function canvasStudioSetClassicText(id, field, value) {
  const node = canvasGetNode(id);
  if (!node || !canvasIsClassicCanvasNode(node)) return;
  canvasEditorBeginTextEdit(id);
  node[field] = String(value ?? '');
  const edit = canvasStudioState.textEdit;
  if (edit) {
    clearTimeout(edit.timer);
    edit.timer = setTimeout(() => canvasEditorEndTextEdit(id), 700);
  }
}
function canvasClassicFieldSelect(id, field, value, options, emptyLabel = '') {
  const empty = emptyLabel ? `<option value="" ${!value ? 'selected' : ''}>${emptyLabel}</option>` : '';
  return `<select onchange="canvasStudioSetClassicField('${id}','${field}',this.value)">${empty}${options.map(item => `<option value="${item}" ${value === item ? 'selected' : ''}>${item}</option>`).join('')}</select>`;
}
function canvasClassicNodeBody(node) {
  if (node.type === 'llm') return canvasClassicLlmBody(node);
  if (node.type === 'midjourney') return canvasClassicMidjourneyBody(node);
  if (node.type === 'msgen') return canvasClassicMsgenBody(node);
  if (node.type === 'video') return canvasClassicVideoBody(node);
  if (node.type === 'rh') return canvasClassicRhBody(node);
  if (node.type === 'comfy') return canvasClassicComfyBody(node);
  if (node.type === 'ltxDirector') return canvasClassicLtxDirectorBody(node);
  if (node.type === 'output') return canvasClassicOutputBody(node);
  return `<div class="canvas-node-result-empty"><strong>${canvasEscape(canvasNodeTitle(node.type))}</strong><span>真实 API 尚未接入</span></div>`;
}
function canvasClassicLlmBody(node) {
  const id = node.id;
  const models = ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'gemini-2.0-flash'];
  return `<div class="smart-node-section"><div class="smart-node-label">LLM · 文本生成</div><label class="smart-node-field">模型${canvasClassicFieldSelect(id, 'model', node.model, models, '未选择')}</label><label class="smart-node-field">系统提示词<textarea class="smart-node-textarea" placeholder="设定角色与规则" oninput="canvasStudioSetClassicText('${id}','systemPrompt',this.value)">${canvasEscape(node.systemPrompt || '')}</textarea></label><label class="smart-node-field">对话输入<textarea class="smart-node-textarea" placeholder="输入要发送给 LLM 的内容" oninput="canvasStudioSetClassicText('${id}','chatInput',this.value)">${canvasEscape(node.chatInput || '')}</textarea></label><label class="smart-node-field">输出<textarea class="smart-node-textarea" readonly placeholder="LLM 回复将显示在这里">${canvasEscape(node.outputText || '')}</textarea></label><div class="smart-node-hint">真实 LLM 适配器未接入，运行仅显示占位状态</div></div>`;
}
function canvasClassicMidjourneyBody(node) {
  const id = node.id;
  return `<div class="smart-node-section"><div class="smart-node-label">MIDJOURNEY · 文生图</div><div class="smart-node-field-row"><label>尺寸${canvasClassicFieldSelect(id, 'size', node.size, ['1:1', '4:3', '3:4', '16:9', '9:16'])}</label><label>版本${canvasClassicFieldSelect(id, 'version', node.version, ['6.1', '6.0', '5.2', 'niji 6'])}</label></div><label class="smart-node-field">模式${canvasClassicFieldSelect(id, 'mode', node.mode, ['imagine', 'blend', 'describe'])}</label><label class="smart-node-field">速度${canvasClassicFieldSelect(id, 'speed', node.speed, ['relax', 'fast', 'turbo'])}</label><div class="smart-node-hint">真实 Midjourney 适配器未接入，运行仅显示占位状态</div></div>`;
}
function canvasClassicMsgenBody(node) {
  const id = node.id;
  return `<div class="smart-node-section"><div class="smart-node-label">MODELSCOPE · 生成</div><label class="smart-node-field">模型${canvasClassicFieldSelect(id, 'msgenModel', node.msgenModel, ['zimage', 'flux-dev', 'kolors'])}</label><div class="smart-node-field-row"><label>宽<input type="number" min="64" value="${Number(node.msWidth) || 1024}" onchange="canvasStudioSetClassicField('${id}','msWidth',this.value)"></label><label>高<input type="number" min="64" value="${Number(node.msHeight) || 1024}" onchange="canvasStudioSetClassicField('${id}','msHeight',this.value)"></label></div><div class="smart-node-field-row"><label>比例${canvasClassicFieldSelect(id, 'msRatio', node.msRatio, ['square', 'portrait', 'landscape', 'wide'])}</label><label>分辨率${canvasClassicFieldSelect(id, 'msResolution', node.msResolution, ['1k', '2k', '4k'])}</label></div><label class="smart-node-field">数量<input type="number" min="1" max="4" value="${Number(node.count) || 1}" onchange="canvasStudioSetClassicField('${id}','count',this.value)"></label><div class="smart-node-hint">真实 ModelScope 适配器未接入，运行仅显示占位状态</div></div>`;
}
function canvasClassicVideoBody(node) {
  const id = node.id;
  const models = canvasModelOptions.video || [];
  return `<div class="smart-node-section"><div class="smart-node-label">VIDEO · 视频生成</div><label class="smart-node-field">模型<select onchange="canvasStudioSetClassicField('${id}','model',this.value)"><option value="" ${!node.model ? 'selected' : ''}>未选择</option>${models.map(item => `<option value="${item.value}" ${node.model === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label><div class="smart-node-field-row"><label>比例${canvasClassicFieldSelect(id, 'aspectRatio', node.aspectRatio, ['16:9', '9:16', '1:1'])}</label><label>时长(秒)<input type="number" min="1" max="30" value="${Number(node.duration) || 5}" onchange="canvasStudioSetClassicField('${id}','duration',this.value)"></label></div><label class="smart-node-field">分辨率<select onchange="canvasStudioSetClassicField('${id}','resolution',this.value)"><option value="" ${!node.resolution ? 'selected' : ''}>自动</option><option value="720p" ${node.resolution === '720p' ? 'selected' : ''}>720p</option><option value="1080p" ${node.resolution === '1080p' ? 'selected' : ''}>1080p</option></select></label><div class="smart-node-hint">真实视频生成适配器未接入，运行仅显示占位状态</div></div>`;
}
function canvasClassicRhBody(node) {
  const id = node.id;
  const workflowMode = node.rhMode === 'workflow';
  const idField = workflowMode ? 'workflowId' : 'webappId';
  const idValue = workflowMode ? (node.workflowId || '') : (node.webappId || '');
  return `<div class="smart-node-section"><div class="smart-node-label">RUNNINGHUB · 生成</div><label class="smart-node-field">模式${canvasClassicFieldSelect(id, 'rhMode', node.rhMode, ['app', 'workflow'])}</label><label class="smart-node-field">${workflowMode ? 'Workflow ID' : 'App ID'}<input type="text" value="${canvasEscape(idValue)}" onchange="canvasStudioSetClassicField('${id}','${idField}',this.value)"></label><label class="smart-node-field">套餐${canvasClassicFieldSelect(id, 'rhPayment', node.rhPayment, ['plus', 'free'])}</label><div class="smart-node-hint">真实 RunningHub 适配器未接入，运行仅显示占位状态</div></div>`;
}
function canvasClassicComfyBody(node) {
  const id = node.id;
  return `<div class="smart-node-section"><div class="smart-node-label">COMFYUI · 生成</div><div class="smart-node-field-row"><label>宽<input type="number" min="64" value="${Number(node.comfyWidth) || 1024}" onchange="canvasStudioSetClassicField('${id}','comfyWidth',this.value)"></label><label>高<input type="number" min="64" value="${Number(node.comfyHeight) || 1024}" onchange="canvasStudioSetClassicField('${id}','comfyHeight',this.value)"></label></div><div class="smart-node-field-row"><label>比例${canvasClassicFieldSelect(id, 'ratio', node.ratio, ['square', 'portrait', 'landscape', 'wide'])}</label><label>分辨率${canvasClassicFieldSelect(id, 'resolution', node.resolution, ['1k', '2k', '4k'])}</label></div><label class="smart-node-field">工作流 JSON<textarea class="smart-node-textarea" placeholder="粘贴 ComfyUI 工作流（未接入运行）" oninput="canvasStudioSetClassicText('${id}','comfyWorkflow',this.value)">${canvasEscape(node.comfyWorkflow || '')}</textarea></label><div class="smart-node-hint">真实 ComfyUI 适配器未接入，运行仅显示占位状态</div></div>`;
}
function canvasClassicLtxDirectorBody(node) {
  const id = node.id;
  const timeline = Array.isArray(node.timeline) ? node.timeline : [];
  const timelineMarkup = timeline.length ? timeline.map((segment, index) => `<span class="prompt-node-pill">${index + 1}. ${canvasEscape(segment?.prompt || `镜头 ${index + 1}`)}</span>`).join('') : '<span class="prompt-node-muted">时间线为空，添加镜头后在此预览</span>';
  return `<div class="smart-node-section"><div class="smart-node-label">LTX DIRECTOR · 时间线</div><label class="smart-node-field">全局提示词<textarea class="smart-node-textarea" placeholder="描述整条影片的风格与主题" oninput="canvasStudioSetClassicText('${id}','globalPrompt',this.value)">${canvasEscape(node.globalPrompt || '')}</textarea></label><div class="smart-node-field-row"><label>时长(秒)<input type="number" min="1" max="60" value="${Number(node.durationSeconds) || 5}" onchange="canvasStudioSetClassicField('${id}','durationSeconds',this.value)"></label><label>帧率<input type="number" min="1" max="60" value="${Number(node.frameRate) || 24}" onchange="canvasStudioSetClassicField('${id}','frameRate',this.value)"></label></div><label class="smart-node-field">总帧数<input type="number" min="1" max="1440" value="${Number(node.durationFrames) || 121}" onchange="canvasStudioSetClassicField('${id}','durationFrames',this.value)"></label><label class="smart-node-field">时间线占位<div class="prompt-node-segments">${timelineMarkup}</div></label><div class="smart-node-hint">真实 LTX Director 适配器未接入，运行仅显示占位状态</div></div>`;
}
function canvasClassicOutputBody(node) {
  const images = Array.isArray(node.images) ? node.images : [];
  const history = Array.isArray(node.outputHistory) ? node.outputHistory : [];
  const items = [...images, ...history].slice(0, 12);
  const listMarkup = items.length ? `<div class="prompt-node-segments">${items.map((item, index) => `<span class="prompt-node-pill">${index + 1}. ${canvasEscape(item?.name || item?.outputUrl || item?.url || '输出')}</span>`).join('')}</div>` : '<div class="canvas-node-result-empty"><strong>等待输出</strong><span>上游生成结果将汇总到这里</span></div>';
  return `<div class="smart-node-section"><div class="smart-node-label">OUTPUT · 输出汇总</div>${listMarkup}<div class="smart-node-hint">真实 Output 适配器未接入，运行仅显示占位状态</div></div>`;
}
function openCanvasImagePreview(url, title = '图片预览') {
  if (!url) return;
  const node = canvasStudioState.nodes.find(n => (n.mediaItems || []).some(m => m.url === url) || n.mediaUrl === url || n.outputUrl === url);
  const originalUrl = node?.mediaUrl || '';
  const prompt = node?.prompt || node?.text || '';
  openCanvasStudioLightbox(url, originalUrl, node?.id || '', prompt);
}

function canvasStudioSetLoopText(id, field, value) {
  const node = canvasGetNode(id);
  if (!node || !['variablePrompt', 'fixedPrompt'].includes(field)) return;
  canvasEditorBeginTextEdit(id);
  node[field] = String(value || '');
  const edit = canvasStudioState.textEdit;
  if (edit) {
    clearTimeout(edit.timer);
    edit.timer = setTimeout(() => canvasEditorEndTextEdit(id), 700);
  }
}
function canvasStudioSetNodeField(id, field, value) {
  const node = canvasGetNode(id);
  if (!node || !['loopCount', 'loopStart', 'loopMode', 'minimaxEngine', 'duration', 'aspectRatio', 'variablePrompt', 'fixedPrompt'].includes(field)) return;
  const before = canvasEditorSnapshot();
  if (field === 'loopCount') node[field] = Math.min(100, Math.max(1, Number(value) || 1));
  else if (field === 'loopStart') node[field] = Math.max(1, Number(value) || 1);
  else if (field === 'duration') { node[field] = Math.min(30, Math.max(1, Number(value) || 1)); if (node.type === 'minimax') canvasMinimaxEnsureNode(node); }
  else node[field] = String(value || '');
  canvasEditorCommit(before, `node-field-${field}`);
  renderCanvasStudioNodes();
}

function canvasNodeRenderSignature(node) {
  const group = canvasIsGroupNode(node) ? canvasGroupMembers(node).map(member => ({ id: member.id, title: member.title, mediaUrl: member.mediaUrl, outputUrl: member.outputUrl })) : null;
  return JSON.stringify({ node, group, selected: (canvasStudioState.selectedIds || []).includes(node.id), cascade: canvasCascadeNodeState(node.id) || '' });
}
function canvasStudioToggleNodeCollapsed(id) {
  const node = canvasGetNode(id);
  if (!node) return;
  const before = canvasEditorSnapshot();
  node.nodeCollapsed = !node.nodeCollapsed;
  canvasEditorCommit(before, 'node-collapse');
  renderCanvasStudioNodes();
}
function canvasNodeMarkup(node) {
  const bounds = canvasNodeBounds(node);
  const hasMedia = node.type === 'image' && canvasNodeMediaItems(node).length > 0;
  const className = `canvas-node image-node canvas-node-${node.type}${hasMedia ? ' canvas-media-node canvas-media-node-has-content' : node.type === 'image' ? ' canvas-media-node canvas-media-node-empty' : ''}${canvasIsGroupNode(node) ? ' canvas-node-group smart-group-node' : ''}${node.collapsed ? ' is-collapsed' : ''}${node.nodeCollapsed ? ' is-node-collapsed' : ''}`;
  const style = `left:${node.x}px;top:${node.y}px;width:${bounds.width}px;height:${bounds.height}px`;
  const cascade = canvasCascadeNodeState(node.id);
  const actions = `<div class="canvas-node-floating-actions floating-node-actions"><button type="button" class="smart-node-floating-menu" data-node-action="collapse" title="${node.nodeCollapsed ? '展开节点' : '收起节点'}" aria-label="${node.nodeCollapsed ? '展开节点' : '收起节点'}">${node.nodeCollapsed ? '↗' : '−'}</button><button type="button" class="smart-node-floating-menu" data-node-action="delete" title="删除节点" aria-label="删除节点">×</button></div>`;
  return `<div class="${className}" data-node-id="${node.id}" data-node-type="${node.type}" data-node-width="${bounds.width}" data-node-height="${bounds.height}" style="${style}">${actions}<div class="canvas-node-head"><span class="canvas-node-title">${canvasEscape(node.title)}</span></div><div class="canvas-node-body">${canvasNodeBody(node)}${cascade ? `<div class="canvas-cascade-state canvas-cascade-${cascade}">${({ queued: '排队中', running: '运行中', done: '已完成', failed: '失败', stopped: '已停止' })[cascade] || cascade}</div>` : ''}</div><span class="canvas-node-resize-handle node-resize-handle" title="调整节点尺寸" aria-label="调整节点尺寸"></span>${canvasNodePorts(node)}</div>`;
}
function canvasCreateNodeElement(node, signature) {
  const template = document.createElement('template');
  template.innerHTML = canvasNodeMarkup(node);
  const element = template.content.firstElementChild;
  element.dataset.renderSignature = signature;
  bindCanvasNode(element);
  bindCanvasMediaEvents(element, node.id);
  if (node.type === 'minimax') bindCanvasMinimaxEvents(element, node.id);
  return element;
}
function renderCanvasStudioNodes() {
  const world = document.getElementById('canvas-studio-world');
  const empty = document.getElementById('canvas-studio-empty');
  if (!world) return;
  canvasNormalizeGroups();
  empty?.classList.toggle('is-hidden', canvasStudioState.nodes.filter(node => !canvasIsGroupNode(node)).length > 0);
  const groups = canvasStudioState.nodes.filter(node => canvasIsGroupNode(node));
  const regular = canvasStudioState.nodes.filter(node => !canvasIsGroupNode(node));
  const ordered = [...groups, ...regular].filter(node => !canvasNodeIsHiddenByCollapsedGroup(node));
  const expectedIds = new Set(ordered.map(node => node.id));
  world.querySelectorAll('.canvas-node[data-node-id]').forEach(element => {
    if (!expectedIds.has(element.dataset.nodeId)) element.remove();
  });
  ordered.forEach(node => {
    const signature = canvasNodeRenderSignature(node);
    const selector = `.canvas-node[data-node-id="${CSS.escape(node.id)}"]`;
    const current = world.querySelector(selector);
    if (!current) {
      world.appendChild(canvasCreateNodeElement(node, signature));
      return;
    }
    if (current.dataset.renderSignature !== signature) {
      const mediaStates = captureCanvasMediaPlaybackStates(current);
      const fresh = canvasCreateNodeElement(node, signature);
      transplantCanvasMediaElements(current, fresh);
      current.replaceWith(fresh);
      restoreCanvasMediaPlaybackStates(fresh, mediaStates);
      return;
    }
    current.style.left = `${node.x}px`;
    current.style.top = `${node.y}px`;
  });
  ordered.forEach(node => {
    const element = world.querySelector(`.canvas-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (element) world.appendChild(element);
  });
  updateCanvasStudioCounts();
  renderCanvasStudioConnections();
  applyCanvasStudioViewport();
  renderCanvasStudioSelection();
  renderCanvasStudioMinimap();
}

function bindCanvasNode(nodeEl) {
  const id = nodeEl.dataset.nodeId;
  let drag = null;
  let resize = null;
  nodeEl.querySelectorAll('[data-group-preview-url]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openCanvasImagePreview(button.dataset.groupPreviewUrl, button.dataset.groupPreviewName || '分组图片');
  }));
  nodeEl.querySelectorAll('[data-node-action]').forEach(action => {
    action.addEventListener('pointerdown', event => event.stopPropagation());
    action.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (action.dataset.nodeAction === 'delete') canvasStudioRemoveNode(id);
      if (action.dataset.nodeAction === 'collapse') canvasStudioToggleNodeCollapsed(id);
    });
  });
  const resizeHandle = nodeEl.querySelector('.canvas-node-resize-handle');
  resizeHandle?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const node = canvasGetNode(id);
    if (!node) return;
    canvasNormalizeNodeSize(node);
    canvasSetSelection([id]);
    resize = { x: event.clientX, y: event.clientY, before: canvasEditorSnapshot(), width: node.width, height: node.height };
    resizeHandle.setPointerCapture(event.pointerId);
    nodeEl.classList.add('is-resizing');
  });
  resizeHandle?.addEventListener('pointermove', event => {
    if (!resize) return;
    const node = canvasGetNode(id);
    if (!node) return;
    const limits = canvasNodeSizeLimits(node);
    if (limits.fixed) {
      const ratio = Math.max(0.01, resize.width / Math.max(1, resize.height));
      const dx = (event.clientX - resize.x) / canvasStudioState.viewport.scale;
      const dy = (event.clientY - resize.y) / canvasStudioState.viewport.scale;
      const scaleDelta = Math.abs(dx) >= Math.abs(dy) ? dx / Math.max(1, resize.width) : dy / Math.max(1, resize.height);
      node.width = Math.max(48, Math.round(resize.width * (1 + scaleDelta)));
      node.height = Math.max(48, Math.round(node.width / ratio));
    } else {
      node.width = Math.max(limits.minWidth, Math.round(resize.width + (event.clientX - resize.x) / canvasStudioState.viewport.scale));
      node.height = Math.max(limits.minHeight, Math.round(resize.height + (event.clientY - resize.y) / canvasStudioState.viewport.scale));
    }
    nodeEl.style.width = `${node.width}px`;
    nodeEl.style.height = `${node.height}px`;
    nodeEl.dataset.nodeWidth = String(node.width);
    nodeEl.dataset.nodeHeight = String(node.height);
    renderCanvasStudioConnections();
    renderCanvasStudioMinimap();
  });
  const finishResize = event => {
    if (!resize) return;
    const current = resize;
    resize = null;
    nodeEl.classList.remove('is-resizing');
    resizeHandle?.releasePointerCapture?.(event.pointerId);
    canvasEditorCommit(current.before, 'resize');
    renderCanvasStudioNodes();
  };
  resizeHandle?.addEventListener('pointerup', finishResize);
  resizeHandle?.addEventListener('pointercancel', finishResize);
  nodeEl.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button,.canvas-port,input,textarea,select,label,video,audio,.canvas-media-item,.canvas-node-resize-handle')) return;
    const node = canvasGetNode(id);
    if (!node) return;
    if (event.shiftKey) {
      const ids = new Set(canvasStudioState.selectedIds || []);
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      canvasSetSelection([...ids]);
    renderCanvasComposer();
    } else if (!(canvasStudioState.selectedIds || []).includes(id)) {
      canvasSetSelection([id]);
    } else {
      canvasStudioState.selectedId = id;
      renderCanvasStudioSelection();
    }
    const selected = canvasSelectedNodes();
    if (!selected.some(item => item.id === id)) return;
    const before = canvasEditorSnapshot();
    const movingIds = new Set(selected.flatMap(item => canvasIsGroupNode(item) ? [item.id, ...canvasGroupMembers(item).map(member => member.id)] : [item.id]));
    drag = { x: event.clientX, y: event.clientY, before, positions: [...movingIds].map(nodeId => { const item = canvasGetNode(nodeId); return { id: nodeId, x: item.x, y: item.y }; }) };
    nodeEl.setPointerCapture(event.pointerId);
    document.getElementById('canvas-studio-world')?.querySelectorAll('.canvas-node').forEach(item => item.classList.toggle('is-dragging', movingIds.has(item.dataset.nodeId)));
  });
  nodeEl.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = (event.clientX - drag.x) / canvasStudioState.viewport.scale;
    const dy = (event.clientY - drag.y) / canvasStudioState.viewport.scale;
    drag.positions.forEach(position => { const node = canvasGetNode(position.id); if (node) { node.x = position.x + dx; node.y = position.y + dy; const el = document.querySelector(`#canvas-studio-world .canvas-node[data-node-id="${CSS.escape(position.id)}"]`); if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; } } });
    canvasStudioState.nodes.filter(item => canvasIsGroupNode(item) && !canvasStudioState.selectedIds.includes(item.id)).forEach(group => { canvasRefreshGroupBounds(group, true); });
    renderCanvasStudioConnections();
  });
  const finishDrag = event => { if (!drag) return; const current = drag; drag = null; nodeEl.classList.remove('is-dragging'); document.getElementById('canvas-studio-world')?.querySelectorAll('.canvas-node').forEach(item => item.classList.remove('is-dragging')); nodeEl.releasePointerCapture?.(event.pointerId); canvasEditorCommit(current.before, 'drag'); renderCanvasStudioNodes(); };
  nodeEl.addEventListener('pointerup', finishDrag);
  nodeEl.addEventListener('pointercancel', finishDrag);
  nodeEl.querySelectorAll('.canvas-port').forEach(port => bindCanvasPort(port, id));
  nodeEl.addEventListener('contextmenu', event => {
    event.preventDefault();
    const node = canvasGetNode(id);
    if (!node) return;
    closeCanvasNodePortMenu();
    if (canvasIsGeneratorNode(node)) {
      openCanvasGeneratorNodeMenu(id, event.clientX, event.clientY);
    } else if (node.type === 'prompt' || node.type === 'image' || node.type === 'smart-image' || node.type === 'llm') {
      openCanvasLinkCreateMenu(id, 'out', event.clientX, event.clientY);
    }
  });
}
function bindCanvasPort(portEl, nodeId) {
  portEl.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    const direction = portEl.dataset.portDirection;
    if (direction !== 'out' || canvasStudioState.connect) return;
    canvasStudioState.connect = { from: nodeId, fromPort: portEl.dataset.port || 'out', type: portEl.dataset.portType || '', pointerId: event.pointerId, x: event.clientX, y: event.clientY, before: canvasEditorSnapshot() };
    portEl.classList.add('is-connecting');
    document.getElementById('canvas-studio-board')?.classList.add('is-connecting');
    document.getElementById('canvas-studio-board')?.setPointerCapture?.(event.pointerId);
    renderCanvasConnectionPreview(event);
  });
  portEl.addEventListener('pointermove', event => {
    if (canvasStudioState.connect?.from === nodeId) renderCanvasConnectionPreview(event);
  });
  portEl.addEventListener('pointerup', event => {
    event.preventDefault();
    event.stopPropagation();
    if (canvasStudioState.connect?.from !== nodeId) return;
    canvasCommitConnectionAtPoint(event);
    canvasStudioState.connect = null;
    clearCanvasConnectionPreview();
    renderCanvasStudioConnections();
    updateCanvasStudioCounts();
  }, true);
}

function canvasMediaItemFromFile(file) {
  const mime = String(file?.type || '').toLowerCase();
  const kind = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
  return { id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, url: URL.createObjectURL(file), name: file.name || '未命名素材', size: `${Math.max(1, Math.round(file.size / 1024))} KB`, mime, asset: null, inlineVideoActive: false };
}
function canvasSyncLegacyImageFields(node) {
  const items = canvasNodeMediaItems(node);
  const images = items.filter(item => canvasMediaKind(item) === 'image');
  const primary = images[0] || items[0] || null;
  node.mediaUrl = primary?.url || ''; node.mediaName = primary?.name || ''; node.mediaSize = primary?.size || ''; node.asset = images[0]?.asset || null;
}
async function canvasStudioChooseMedia(id, input) {
  const files = Array.from(input.files || []).slice(0, 10); input.value = '';
  const node = canvasGetNode(id); if (!files.length || !node || node.type !== 'image') return;
  const before = canvasEditorSnapshot(); node.mediaItems = canvasNodeMediaItems(node); const additions = files.map(canvasMediaItemFromFile);
  node.mediaItems.push(...additions); node.error = ''; canvasSyncLegacyImageFields(node); canvasEditorCommit(before, 'add-media'); renderCanvasStudioNodes();
  for (let index = 0; index < additions.length; index += 1) {
    const item = additions[index]; const form = new FormData(); form.append('files', files[index]);
    try {
      const response = await fetch('/api/canvas/assets', { method: 'POST', body: form }); const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.assets?.[0]) throw new Error(data.error || '上传失败');
      const saved = data.assets[0]; if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url); item.asset = saved; item.url = saved.url; item.mime = saved.mime; item.kind = canvasMediaKind(item);
      canvasStudioLog(`素材已上传：${item.name}`, 'success');
    } catch (error) { node.error = error.message || '素材上传失败'; canvasStudioLog(`素材上传失败：${item.name}`, 'error'); }
  }
  canvasSyncLegacyImageFields(node); renderCanvasStudioNodes(); canvasScheduleSave();
}
async function canvasStudioChooseImage(id, input) { return canvasStudioChooseMedia(id, input); }
function canvasStudioRemoveMedia(id, index) {
  const node = canvasGetNode(id); if (!node || node.type !== 'image') return; const items = canvasNodeMediaItems(node); const item = items[index];
  if (item?.url?.startsWith('blob:')) URL.revokeObjectURL(item.url); const before = canvasEditorSnapshot(); items.splice(index, 1); node.mediaItems = items; canvasSyncLegacyImageFields(node); canvasEditorCommit(before, 'remove-media'); renderCanvasStudioNodes(); canvasScheduleSave();
}
function captureCanvasMediaPlaybackState(media) { return { time: Number(media.currentTime || 0), paused: Boolean(media.paused), rate: Number(media.playbackRate || 1), muted: Boolean(media.muted), volume: Number(media.volume ?? 1) }; }
function restoreCanvasMediaPlaybackState(media, state) { if (!media || !state) return; const apply = () => { try { media.currentTime = state.time; media.playbackRate = state.rate; media.muted = state.muted; media.volume = state.volume; if (!state.paused) media.play?.().catch(() => {}); } catch (_error) {} }; if (media.readyState >= 1) apply(); else media.addEventListener('loadedmetadata', apply, { once: true }); }
function captureCanvasMediaPlaybackStates(root) { const states = new Map(); root?.querySelectorAll('video[data-media-signature],audio[data-media-signature]').forEach(media => states.set(media.dataset.mediaSignature, captureCanvasMediaPlaybackState(media))); return states; }
function restoreCanvasMediaPlaybackStates(root, states) { root?.querySelectorAll('video[data-media-signature],audio[data-media-signature]').forEach(media => restoreCanvasMediaPlaybackState(media, states?.get(media.dataset.mediaSignature))); }
function transplantCanvasMediaElements(oldNode, freshNode) { oldNode?.querySelectorAll('video[data-media-signature],audio[data-media-signature]').forEach(oldMedia => { const signature = oldMedia.dataset.mediaSignature; const newMedia = freshNode.querySelector(`[data-media-signature="${CSS.escape(signature)}"]`); if (newMedia && newMedia.tagName === oldMedia.tagName) { const state = captureCanvasMediaPlaybackState(oldMedia); newMedia.replaceWith(oldMedia); restoreCanvasMediaPlaybackState(oldMedia, state); } }); }
function canvasDownloadMedia(item) {
  if (!item?.url) return;
  const link = document.createElement('a');
  link.href = item.url;
  link.download = item.name || 'canvas-media';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
function canvasMinimaxMediaLibrary(node) {
  return canvasStudioState.nodes
    .filter(item => item.type === 'image' || item.type === 'smart-image')
    .flatMap(item => canvasNodeMediaItems(item).map(media => ({ ...media, sourceNodeId: item.id, sourceTitle: item.title || canvasNodeTitle(item.type) })))
    .filter(item => item.url)
    .slice(0, 24);
}
function canvasMinimaxMediaThumb(item) {
  const kind = canvasMediaKind(item);
  const url = canvasEscape(item.previewUrl || item.url);
  if (kind === 'video') return `<video src="${url}" muted preload="metadata"></video>`;
  if (kind === 'audio') return `<div class="minimax-audio-chip">♫</div>`;
  return `<img src="${url}" alt="${canvasMediaLabel(item)}">`;
}
function canvasMinimaxPreviewContent(segment) {
  const result = segment?.result || segment?.refItems?.[0] || null;
  if (!result) return '<div class="minimax-preview-empty">选择素材或片段后在此预览</div>';
  const kind = canvasMediaKind(result);
  const url = canvasEscape(result.url || '');
  if (kind === 'video') return `<video src="${url}" controls preload="metadata"></video>`;
  if (kind === 'audio') return `<div class="minimax-preview-audio"><strong>${canvasMediaLabel(result)}</strong><audio src="${url}" controls preload="metadata"></audio></div>`;
  return `<img src="${url}" alt="${canvasMediaLabel(result)}">`;
}
function canvasMinimaxNodeBody(node) {
  canvasMinimaxEnsureNode(node);
  const total = canvasMinimaxTimelineTotal(node);
  const selected = canvasMinimaxSelectedSegment(node);
  const library = canvasMinimaxMediaLibrary(node);
  const playheadPct = Math.min(100, Math.max(0, (Number(node.playhead) || 0) / total * 100));
  const segments = (node.minimaxSegments || []).map(segment => {
    const left = Math.max(0, Number(segment.start || 0) / total * 100);
    const width = Math.max(6, Number(segment.duration || 1) / total * 100);
    return `<button type="button" class="minimax-segment${segment.id === node.selectedSegmentId ? ' is-selected' : ''}" data-minimax-segment="${segment.id}" style="left:${left}%;width:${width}%"><strong>${canvasEscape(segment.prompt || '片段')}</strong><span>${Number(segment.duration || 0)}s</span></button>`;
  }).join('');
  const refs = selected?.refItems?.length ? selected.refItems.map((item, index) => `<span class="minimax-ref-clip"><em>${canvasMediaKind(item)}</em>${canvasEscape(item.name || `参考 ${index + 1}`)}<button type="button" data-minimax-remove-ref="${index}">×</button></span>`).join('') : '<span class="minimax-empty-ref">当前片段暂无参考素材</span>';
  const materialButtons = library.length ? library.map((item, index) => `<button type="button" class="minimax-material" data-minimax-material="${index}">${canvasMinimaxMediaThumb(item)}<span>${canvasEscape(item.name || item.sourceTitle || '素材')}</span></button>`).join('') : '<div class="minimax-library-empty">从图片节点或 Smart Image 输出导入素材后可选择</div>';
  return `<div class="minimax-workbench"><section class="minimax-preview"><div class="minimax-preview-head"><strong>MiniMax 时间线</strong><span>${canvasEscape(node.videoStatus === 'reserved' ? '视频适配器已保留' : node.videoStatus || 'idle')}</span></div><div class="minimax-preview-stage">${canvasMinimaxPreviewContent(selected)}</div></section><section class="minimax-editor"><div class="minimax-topbar"><label>引擎<select onchange="canvasStudioSetNodeField('${node.id}','minimaxEngine',this.value)"><option ${node.minimaxEngine === 'MiniMax H3' ? 'selected' : ''}>MiniMax H3</option><option ${node.minimaxEngine === 'MiniMax' ? 'selected' : ''}>MiniMax</option></select></label><label>比例<select onchange="canvasStudioSetNodeField('${node.id}','aspectRatio',this.value)"><option ${node.aspectRatio === '16:9' ? 'selected' : ''}>16:9</option><option ${node.aspectRatio === '9:16' ? 'selected' : ''}>9:16</option><option ${node.aspectRatio === '1:1' ? 'selected' : ''}>1:1</option></select></label><button type="button" class="btn bs" data-minimax-add-segment="1">添加片段</button><button type="button" class="btn bs" data-minimax-delete-segment="1">删除片段</button></div><div class="minimax-timeline" data-minimax-scrub-track="1"><div class="minimax-ruler"><span>0s</span><span>${total}s</span></div><div class="minimax-track">${segments}<i class="minimax-playhead" data-minimax-playhead="1" style="left:${playheadPct}%"></i></div></div><div class="minimax-segment-editor"><label>片段提示词<textarea data-minimax-prompt="1" placeholder="描述当前片段...">${canvasEscape(selected?.prompt || '')}</textarea></label><div class="minimax-segment-fields"><label>开始<input type="number" min="0" max="120" value="${Number(selected?.start || 0)}" data-minimax-field="start"></label><label>时长<input type="number" min="1" max="30" value="${Number(selected?.duration || node.duration || 8)}" data-minimax-field="duration"></label><label>Trim In<input type="number" min="0" max="30" value="${Number(selected?.trimIn || 0)}" data-minimax-field="trimIn"></label><label>Trim Out<input type="number" min="0" max="30" value="${Number(selected?.trimOut || selected?.duration || 8)}" data-minimax-field="trimOut"></label></div><div class="minimax-ref-lane">${refs}</div></div><div class="minimax-library"><div class="minimax-library-head"><span>可用素材</span><small>点击加入当前片段参考</small></div><div class="minimax-library-grid">${materialButtons}</div></div><div class="smart-node-hint">本阶段仅迁入时间线与本地预览 UI，不启动外部视频生成服务</div></section></div>`;
}
function bindCanvasMediaEvents(nodeEl, id) {
  nodeEl.querySelectorAll('.canvas-media-delete').forEach(button => button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); canvasStudioRemoveMedia(id, Number(button.dataset.mediaIndex)); }));
  nodeEl.querySelectorAll('.canvas-video-play').forEach(button => button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); const node = canvasGetNode(id); const item = canvasNodeMediaItems(node).find(media => canvasMediaSignature(media) === button.dataset.mediaSignature); if (item) { item.inlineVideoActive = true; renderCanvasStudioNodes(); } }));
  nodeEl.querySelectorAll('.canvas-media-floating-menu button').forEach(button => button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    const node = canvasGetNode(id); const item = canvasNodeMediaItems(node)[Number(button.closest('.canvas-media-item')?.dataset.mediaIndex)];
    if (!item) return;
    if (button.dataset.mediaAction === 'preview') openCanvasImagePreview(item.url, item.name || '素材预览');
    if (button.dataset.mediaAction === 'download') canvasDownloadMedia(item);
  }));
  nodeEl.querySelectorAll('.canvas-media-item img').forEach(image => {
    image.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); openCanvasImagePreview(image.dataset.originalSrc || image.src, image.alt || '素材预览'); });
    image.addEventListener('load', () => {
      const node = canvasGetNode(id); const item = canvasNodeMediaItems(node).find(media => canvasMediaSignature(media) === image.dataset.mediaSignature);
      if (!item || (item.width === image.naturalWidth && item.height === image.naturalHeight)) return;
      item.width = image.naturalWidth; item.height = image.naturalHeight;
      const badge = image.closest('.canvas-media-item')?.querySelector('.image-resolution-badge');
      if (badge) badge.textContent = canvasMediaResolutionLabel(item);
      else if (image.naturalWidth && image.naturalHeight) image.closest('.canvas-media-item')?.insertAdjacentHTML('beforeend', `<span class="image-resolution-badge">${canvasMediaResolutionLabel(item)}</span>`);
      canvasScheduleSave();
    });
  });
}

function canvasMinimaxCommit(id, mutator, reason = 'minimax') {
  const node = canvasGetNode(id);
  if (!node || node.type !== 'minimax') return;
  canvasMinimaxEnsureNode(node);
  const before = canvasEditorSnapshot();
  mutator(node);
  canvasMinimaxEnsureNode(node);
  canvasEditorCommit(before, reason);
  renderCanvasStudioNodes();
}
function canvasMinimaxSetSegmentPrompt(id, value) {
  const node = canvasGetNode(id);
  if (!node || node.type !== 'minimax') return;
  canvasMinimaxEnsureNode(node);
  const segment = canvasMinimaxSelectedSegment(node);
  if (!segment) return;
  canvasEditorBeginTextEdit(id);
  segment.prompt = String(value || '');
  const edit = canvasStudioState.textEdit;
  if (edit) {
    clearTimeout(edit.timer);
    edit.timer = setTimeout(() => canvasEditorEndTextEdit(id), 700);
  }
}
function bindCanvasMinimaxEvents(nodeEl, id) {
  nodeEl.querySelectorAll('[data-minimax-segment]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    canvasMinimaxCommit(id, node => { node.selectedSegmentId = button.dataset.minimaxSegment; node.playhead = canvasMinimaxSelectedSegment(node)?.start || 0; }, 'minimax-select-segment');
  }));
  nodeEl.querySelector('[data-minimax-add-segment]')?.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    canvasMinimaxCommit(id, node => { const total = canvasMinimaxTimelineTotal(node); const duration = Math.min(30, Math.max(1, Number(node.duration) || 6)); const segment = { id: canvasMinimaxSegmentId(), start: total, duration, prompt: '', refItems: [], trimIn: 0, trimOut: duration, result: null, results: [] }; node.minimaxSegments.push(segment); node.selectedSegmentId = segment.id; node.playhead = segment.start; }, 'minimax-add-segment');
  });
  nodeEl.querySelector('[data-minimax-delete-segment]')?.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    canvasMinimaxCommit(id, node => { if ((node.minimaxSegments || []).length <= 1) return; node.minimaxSegments = node.minimaxSegments.filter(segment => segment.id !== node.selectedSegmentId); node.selectedSegmentId = node.minimaxSegments[0]?.id || ''; }, 'minimax-delete-segment');
  });
  nodeEl.querySelectorAll('[data-minimax-field]').forEach(input => input.addEventListener('change', event => {
    event.stopPropagation(); const field = input.dataset.minimaxField;
    canvasMinimaxCommit(id, node => { const segment = canvasMinimaxSelectedSegment(node); if (!segment) return; const value = Number(input.value) || 0; if (field === 'start') segment.start = Math.max(0, value); if (field === 'duration') segment.duration = Math.min(30, Math.max(1, value)); if (field === 'trimIn') segment.trimIn = Math.max(0, value); if (field === 'trimOut') segment.trimOut = Math.min(segment.duration || 30, Math.max(0, value)); }, `minimax-${field}`);
  }));
  nodeEl.querySelector('[data-minimax-prompt]')?.addEventListener('input', event => { event.stopPropagation(); canvasMinimaxSetSegmentPrompt(id, event.target.value); });
  nodeEl.querySelectorAll('[data-minimax-material]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    canvasMinimaxCommit(id, node => { const material = canvasMinimaxMediaLibrary(node)[Number(button.dataset.minimaxMaterial)]; const segment = canvasMinimaxSelectedSegment(node); if (!material || !segment) return; const key = canvasMediaSignature(material); if (!segment.refItems.some(item => canvasMediaSignature(item) === key)) segment.refItems = [...segment.refItems, material].slice(-5); segment.result = segment.result || material; }, 'minimax-add-ref');
  }));
  nodeEl.querySelectorAll('[data-minimax-remove-ref]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    canvasMinimaxCommit(id, node => { const segment = canvasMinimaxSelectedSegment(node); if (!segment) return; segment.refItems.splice(Number(button.dataset.minimaxRemoveRef), 1); segment.result = segment.refItems[0] || null; }, 'minimax-remove-ref');
  }));
  nodeEl.querySelector('[data-minimax-scrub-track]')?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const track = event.currentTarget.querySelector('.minimax-track');
    const rect = track?.getBoundingClientRect();
    if (!rect) return;
    const pct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    canvasMinimaxCommit(id, node => { node.playhead = Math.round(canvasMinimaxTimelineTotal(node) * pct * 10) / 10; }, 'minimax-scrub');
  });
}
function canvasStudioSetPrompt(id, value) { const node = canvasGetNode(id); if (!node) return; canvasEditorBeginTextEdit(id); canvasSetPromptValue(node, value); const edit = canvasStudioState.textEdit; if (edit) { clearTimeout(edit.timer); edit.timer = setTimeout(() => { canvasEditorEndTextEdit(id); renderCanvasComposer(); }, 700); } renderCanvasComposer(); }
function canvasStudioSetGenerationKind(id, value) { const node = canvasGetNode(id); if (!node) return; const before = canvasEditorSnapshot(); node.generationKind = value; node.model = canvasModelOptions[value]?.[0]?.value || ''; node.error = ''; canvasEditorCommit(before, 'generation-kind'); renderCanvasStudioNodes(); }
function canvasStudioSetModel(id, value) { const node = canvasGetNode(id); if (!node) return; const before = canvasEditorSnapshot(); node.model = value; canvasEditorCommit(before, 'model'); }
function canvasStudioInputNodes(id, type) { return canvasStudioState.connections.filter(edge => edge.to === id && (!edge.toPort || (type === 'prompt' ? edge.toPort === 'prompt' : type === 'image' ? edge.toPort === 'image' : true))).map(edge => canvasGetNode(edge.from)).filter(node => type === 'image' ? (node?.type === 'image' || node?.type === 'smart-image') : node?.type === type); }
function canvasStudioResultNodes(id) { return canvasStudioState.connections.filter(edge => edge.from === id && (!edge.toPort || edge.toPort === 'image')).map(edge => canvasGetNode(edge.to)).filter(node => node?.type === 'result'); }
function canvasSmartOutputNodes(id) { return canvasStudioState.connections.filter(edge => edge.from === id && edge.toPort === 'image').map(edge => canvasGetNode(edge.to)).filter(node => node?.type === 'smart-image'); }
function canvasCreatePendingSmartImage(source, prompt, loopIndex) {
  const output = { id: canvasNodeId('smart-image'), type: 'smart-image', title: 'Image', x: source.x + 310, y: source.y + canvasSmartOutputNodes(source.id).length * 210, mediaItems: [], mediaUrl: '', mediaName: '', mediaSize: '', asset: null, outputUrl: '', outputHistory: [], pending: 1, status: 'running', error: '', sourceNodeId: source.id, taskId: '', loopIndex: loopIndex ?? null, generationMeta: { model: source.model || '', prompt: String(prompt || '').slice(0, 12000), createdAt: new Date().toISOString() } };
  canvasStudioState.nodes.push(output);
  canvasStudioState.connections.push({ id: `canvas-connection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, from: source.id, fromPort: 'out', to: output.id, toPort: 'image', type: 'image' });
  return output;
}
function canvasFinalizeSmartImage(output, task) {
  const outputUrl = task?.outputUrl || '';
  output.status = 'completed'; output.pending = 0; output.taskId = ''; output.error = ''; output.outputUrl = outputUrl;
  output.asset = outputUrl ? { url: outputUrl, mime: 'image/png', canvasOutputName: outputUrl.split('/').pop() } : null;
  output.mediaItems = outputUrl ? [{ id: `output-${Date.now()}`, kind: 'image', url: outputUrl, name: '生成图片', size: '', mime: 'image/png', asset: output.asset }] : [];
  output.mediaUrl = outputUrl; output.mediaName = '生成图片'; output.outputHistory = [...(output.outputHistory || []), { index: output.loopIndex ?? 0, outputUrl, createdAt: task?.createdAt || new Date().toISOString() }].slice(-100);
}
function canvasFailSmartImage(output, error, cancelled) { output.pending = 0; output.taskId = ''; output.status = cancelled ? 'idle' : 'failed'; output.error = cancelled ? '' : String(error || '画布异步生成失败'); }
async function canvasStudioGenerate(id, options = {}) {
  return canvasStudioGenerateAsync(id, options);
}

async function canvasStudioGenerateAsync(id, options = {}) {
  const node = canvasGetNode(id);
  if (!node || node.generationKind !== 'image' || (node.status === 'running' && !options.allowConcurrent)) return false;
  const prompt = canvasStudioInputNodes(id, 'prompt').map(item => canvasPromptValue(item)).filter(Boolean).join('\n\n');
  const assets = canvasStudioInputNodes(id, 'image').map(item => item.asset).filter(Boolean);
  const results = canvasStudioResultNodes(id);
  if (!prompt) { node.error = '请连接并填写提示词节点'; renderCanvasStudioNodes(); return false; }
  node.status = 'running'; node.error = '';
  const output = canvasCreatePendingSmartImage(node, prompt, options.loopIndex);
  canvasStudioLog(`已创建 Pending 输出${options.loopIndex != null ? `（第 ${options.loopIndex} 轮）` : ''}：${node.model || '默认模型'}`, 'info');
  results.forEach(result => { result.error = ''; if (options.loopIndex == null) result.outputUrl = ''; });
  renderCanvasStudioNodes();
  let taskId = '';
  try {
    const created = await api('/api/canvas/tasks', { type: 'generator', providerId: node.apiProvider || canvasStudioState.canvasConfig?.primaryProviderId || '', prompt, model: node.model, size: await canvasGeneratorSizeForRun(node, assets), assets, loopIndex: options.loopIndex, loopRunId: options.cascadeRunId || '', canvasId: canvasStudioCanvasId, projectId: canvasStudioProjectId, canvasKind: 'classic', nodeId: node.id });
    if (!created.success || !created.task?.id) throw new Error(created.error || '画布异步任务创建失败');
    taskId = created.task.id;
    output.taskId = taskId;
    renderCanvasStudioNodes();
    if (options.cascadeRunId && canvasStudioState.cascade.runId === options.cascadeRunId) canvasStudioState.cascade.taskIds[id] = taskId;
    while (true) {
      if (canvasStudioState.cascade.stopped && options.cascadeRunId) {
        await canvasStudioCancelTask(taskId);
        throw new Error('画布任务已取消');
      }
      const data = await api(`/api/canvas/tasks/${encodeURIComponent(taskId)}`);
      if (!data.success || !data.task) throw new Error(data.error || '画布任务状态读取失败');
      if (data.task.status === 'queued' || data.task.status === 'running') { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
      if (data.task.status !== 'completed' || !data.task.outputUrl) throw new Error(data.task.error || '画布异步生成失败');
      node.status = 'completed';
      canvasFinalizeSmartImage(output, data.task);
      results.forEach(result => {
        result.outputUrl = data.task.outputUrl;
        result.error = '';
        result.loopIndex = options.loopIndex ?? null;
        result.outputHistory = Array.isArray(result.outputHistory) ? result.outputHistory : [];
        if (options.loopIndex != null) {
          result.outputHistory.push({ index: options.loopIndex, outputUrl: data.task.outputUrl, createdAt: new Date().toISOString() });
          result.outputHistory = result.outputHistory.slice(-100);
        }
      });
      canvasStudioLog('画布异步生成完成，Pending 输出已回写为 Image 节点', 'success');
      return true;
    }
  } catch (error) {
    node.status = error.message === '画布任务已取消' ? 'idle' : 'failed';
    node.error = error.message || '画布异步生成失败';
    canvasFailSmartImage(output, node.error, node.status === 'idle');
    canvasStudioLog(`画布异步生成${node.status === 'idle' ? '已取消' : '失败'}：${node.error}`, node.status === 'idle' ? 'info' : 'error');
    results.forEach(result => { if (node.status !== 'idle') result.error = node.error; });
    return false;
  } finally {
    if (options.cascadeRunId && canvasStudioState.cascade.runId === options.cascadeRunId) {
      delete canvasStudioState.cascade.taskIds[id];
      canvasStudioState.cascade.states[id] = node.status === 'completed' ? 'done' : node.status === 'idle' ? 'stopped' : 'failed';
    }
    renderCanvasStudioNodes(); canvasScheduleSave();
  }
}
async function canvasStudioCancelTask(taskId) {
  if (!taskId) return false;
  try { const data = await api(`/api/canvas/tasks/${encodeURIComponent(taskId)}/cancel`, {}, 'POST'); return Boolean(data.success); } catch (_error) { return false; }
}
function canvasCascadeNodeState(id) {
  return canvasStudioState.cascade?.states?.[id] || '';
}
function canvasCascadeGraphNodes(targetId = '') {
  const nodeIds = new Set();
  const visit = id => {
    if (!id || nodeIds.has(id)) return;
    const node = canvasGetNode(id);
    if (!node || canvasIsGroupNode(node)) return;
    nodeIds.add(id);
    canvasStudioState.connections.filter(edge => edge.to === id).forEach(edge => visit(edge.from));
  };
  if (targetId) visit(targetId);
  if (!nodeIds.size) canvasStudioState.nodes.filter(node => canvasIsGeneratorNode(node)).forEach(node => visit(node.id));
  return nodeIds;
}
function canvasCascadeLoopForTarget(targetId = '') {
  const graph = canvasCascadeGraphNodes(targetId);
  const loops = canvasStudioState.nodes.filter(node => node.type === 'loop' && graph.has(node.id));
  const node = loops[loops.length - 1];
  if (!node) return null;
  return { node, count: Math.min(100, Math.max(1, Number(node.loopCount) || 1)), start: Math.max(1, Number(node.loopStart) || 1), mode: node.loopMode === 'parallel' ? 'parallel' : 'serial' };
}
function canvasCascadeRoundIndexes(loop) {
  if (!loop) return [0];
  return Array.from({ length: loop.count }, (_, index) => loop.start + index);
}
function canvasStudioRunLoopRound(loop, order, roundIndex, runId) {
  const context = { index: roundIndex, total: loop.start + loop.count - 1, nodeId: loop.node.id, runId };
  canvasStudioState.cascade.context = context;
  return (async () => {
    for (const id of order) {
      const node = canvasGetNode(id);
      if (!node || node.type === 'loop') continue;
      if (canvasStudioState.cascade.stopped) return false;
      canvasStudioState.cascade.currentIndex = context.index;
      canvasStudioState.cascade.states[id] = 'running';
      node.loopIndex = context.index;
      node.error = '';
      renderCanvasStudioNodes();
      if (canvasIsGeneratorNode(node)) {
        const ok = await canvasStudioGenerateAsync(id, { cascadeRunId: runId, loopIndex: context.index, allowConcurrent: loop?.mode === 'parallel' });
        if (!ok) return false;
      } else {
        canvasStudioState.cascade.states[id] = 'done';
        renderCanvasStudioNodes();
      }
    }
    return true;
  })();
}
function canvasComputeCascadeOrder(targetId = '') {
  const nodeIds = canvasCascadeGraphNodes(targetId);
  const order = [];
  const visiting = new Set();
  const visited = new Set();
  let cycle = false;
  const visit = id => {
    if (visited.has(id)) return;
    if (visiting.has(id)) { cycle = true; return; }
    visiting.add(id);
    canvasStudioState.connections.filter(edge => edge.to === id && nodeIds.has(edge.from)).forEach(edge => visit(edge.from));
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  nodeIds.forEach(id => visit(id));
  if (cycle) throw new Error('检测到循环依赖，请先拆分闭环后再运行');
  return order;
}
function canvasCascadeButtonClick() {
  if (canvasStudioState.cascade?.active) canvasStudioStopCascade();
  else canvasStudioRunCascade(canvasStudioState.selectedId);
}
async function canvasStudioStopCascade() {
  if (!canvasStudioState.cascade?.active) return;
  canvasStudioState.cascade.stopped = true;
  const taskIds = Object.values(canvasStudioState.cascade.taskIds || {});
  await Promise.all(taskIds.map(taskId => canvasStudioCancelTask(taskId)));
  canvasStudioLog('已请求停止级联运行；正在取消画布任务并停止后续节点', 'info');
  updateCanvasCascadeUi();
}
function updateCanvasCascadeUi() {
  const button = document.querySelector('.smart-cascade-run');
  if (!button) return;
  const active = Boolean(canvasStudioState.cascade?.active);
  button.textContent = active ? '停止运行' : '一键运行';
  button.classList.toggle('is-running', active);
  button.setAttribute('aria-label', active ? '停止级联运行' : '运行当前工作流');
}
async function canvasStudioRunCascade(targetId = '') {
  if (canvasStudioState.cascade?.active) return;
  const selectedNode = canvasGetNode(targetId);
  const cascadeTargetId = selectedNode && (canvasIsGeneratorNode(selectedNode) || ['result', 'smart-image'].includes(selectedNode.type))
    ? selectedNode.id
    : canvasStudioState.nodes.find(node => canvasIsGeneratorNode(node))?.id || '';
  let order;
  try { order = canvasComputeCascadeOrder(cascadeTargetId); } catch (error) { canvasStudioLog(error.message, 'error'); toast(error.message, 'ng'); return; }
  const loop = canvasCascadeLoopForTarget(cascadeTargetId);
  const loopRounds = canvasCascadeRoundIndexes(loop);
  const loopNodeId = loop?.node?.id || '';
  const orderWithoutLoop = order.filter(id => id !== loopNodeId);
  const executable = orderWithoutLoop.filter(id => ['prompt', 'image', 'smart-image', 'generate', 'generator', 'result'].includes(canvasGetNode(id)?.type));
  const unsupported = order.find(id => id !== loopNodeId && !['prompt', 'image', 'smart-image', 'generate', 'generator', 'result'].includes(canvasGetNode(id)?.type));
  if (unsupported) {
    const node = canvasGetNode(unsupported);
    const message = `${node?.title || node?.type || '节点'}当前仅保留适配入口，尚未接入级联执行`;
    canvasStudioLog(message, 'error');
    toast(message, 'ng');
    return;
  }
  const generators = executable.filter(id => canvasIsGeneratorNode(canvasGetNode(id)));
  if (!generators.length) { toast('请先创建并连接 API 生成节点', 'ng'); return; }
  const runId = `canvas-cascade-${Date.now()}`;
  canvasStudioState.cascade = { active: true, stopped: false, runId, targetId: cascadeTargetId, loopNodeId, order: executable, currentIndex: -1, roundIndexes: loopRounds, loopMode: loop?.mode || 'serial', states: Object.fromEntries(executable.map(id => [id, 'queued'])), taskIds: {} };
  canvasStudioLog(`级联运行开始：${generators.length} 个生成节点`, 'info');
  updateCanvasCascadeUi();
  renderCanvasStudioNodes();
  let failed = false;
  const runRound = roundIndex => canvasStudioRunLoopRound(loop, executable, roundIndex, runId);
  if (loop && loop.mode === 'parallel' && loopRounds.length > 1) {
    const limit = Math.min(6, loopRounds.length);
    let nextRound = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (nextRound < loopRounds.length && !canvasStudioState.cascade.stopped) {
        const index = nextRound++;
        const ok = await runRound(loopRounds[index]);
        if (!ok) { failed = true; break; }
      }
    });
    await Promise.all(workers);
  } else {
    for (let index = 0; index < loopRounds.length; index += 1) {
      if (canvasStudioState.cascade.stopped) break;
      const ok = await runRound(loopRounds[index]);
      if (!ok) { failed = true; break; }
    }
  }
  const stopped = canvasStudioState.cascade.stopped;
  if (stopped) {
    canvasStudioLog('级联运行已停止', 'info');
    Object.keys(canvasStudioState.cascade.states).forEach(id => { if (canvasStudioState.cascade.states[id] === 'queued') canvasStudioState.cascade.states[id] = 'stopped'; });
  } else if (failed) {
    canvasStudioLog('级联运行失败，已停止后续节点', 'error');
  } else {
    canvasStudioLog('级联运行完成', 'success');
  }
  canvasStudioState.cascade.active = false;
  canvasStudioState.cascade.currentIndex = -1;
  updateCanvasCascadeUi();
  renderCanvasStudioNodes();
  canvasScheduleSave();
}
function canvasStudioCopy() { const nodes = canvasSelectedNodes(); if (!nodes.length) return; const ids = new Set(nodes.map(node => node.id)); canvasStudioState.clipboard = { nodes: canvasClone(nodes), connections: canvasStudioState.connections.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => ({ ...edge })) }; }
function canvasStudioPaste() { const clip = canvasStudioState.clipboard; if (!clip?.nodes?.length) return; const before = canvasEditorSnapshot(); const idMap = new Map(); const offset = 36; const nodes = clip.nodes.map(node => { const id = canvasNodeId(node.type); idMap.set(node.id, id); return { ...canvasClone(node), id, x: node.x + offset, y: node.y + offset, status: node.status === 'running' ? 'idle' : node.status }; }); canvasStudioState.nodes.push(...nodes); canvasStudioState.connections.push(...clip.connections.map(edge => ({ ...edge, id: `canvas-connection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, from: idMap.get(edge.from), to: idMap.get(edge.to) })).filter(edge => edge.from && edge.to)); canvasSetSelection(nodes.map(node => node.id)); canvasEditorCommit(before, 'paste'); renderCanvasStudioNodes(); }
function canvasStudioDeleteSelected() { const ids = new Set(canvasStudioState.selectedIds || []); if (!ids.size && !canvasStudioState.selectedConnectionId) return; const before = canvasEditorSnapshot(); if (canvasStudioState.selectedConnectionId) { canvasStudioState.connections = canvasStudioState.connections.filter(edge => edge.id !== canvasStudioState.selectedConnectionId); canvasStudioState.selectedConnectionId = ''; } if (ids.size) { const deletedGroups = canvasStudioState.nodes.filter(node => ids.has(node.id) && canvasIsGroupNode(node)); const deletedMemberIds = new Set(deletedGroups.flatMap(group => group.items || [])); canvasStudioState.nodes.filter(node => ids.has(node.id) || deletedMemberIds.has(node.id)).forEach(node => { if (node.mediaUrl?.startsWith('blob:')) URL.revokeObjectURL(node.mediaUrl); }); canvasStudioState.nodes = canvasStudioState.nodes.filter(node => !ids.has(node.id) && !deletedMemberIds.has(node.id)); canvasStudioState.nodes.filter(node => canvasIsGroupNode(node)).forEach(group => { group.items = (group.items || []).filter(id => !ids.has(id) && !deletedMemberIds.has(id)); }); canvasStudioState.connections = canvasStudioState.connections.filter(edge => !ids.has(edge.from) && !ids.has(edge.to) && !deletedMemberIds.has(edge.from) && !deletedMemberIds.has(edge.to)); } canvasSetSelection([]); canvasEditorCommit(before, 'delete'); renderCanvasStudioNodes(); }
function canvasStudioGroupSelected() {
  const selected = canvasSelectedNodes().filter(node => !canvasIsGroupNode(node));
  if (selected.length < 1) return toast('请先框选至少一个节点', 'ng');
  const alreadyGrouped = selected.filter(node => canvasGroupForNode(node.id));
  if (alreadyGrouped.length) return toast('已有节点属于其他分组，请先移出或解组', 'ng');
  const before = canvasEditorSnapshot();
  const group = { id: canvasNodeId('group'), type: 'group', x: 0, y: 0, title: '智能分组', width: 360, height: 240, items: selected.map(node => node.id), collapsed: false, createdAt: Date.now() };
  canvasStudioState.nodes.push(group);
  canvasRefreshGroupBounds(group);
  canvasSetSelection([group.id]);
  canvasEditorCommit(before, 'group');
  renderCanvasStudioNodes();
}
function canvasStudioAddSelectedToGroup(groupId) {
  const group = canvasGetNode(groupId);
  if (!group || !canvasIsGroupNode(group)) return;
  const candidates = canvasSelectedNodes().filter(node => (group.type === 'promptGroup' ? node.type === 'prompt' : !canvasIsGroupNode(node)) && node.id !== groupId && !canvasGroupForNode(node.id));
  if (!candidates.length) return toast('请先选择未分组的节点', 'ng');
  const before = canvasEditorSnapshot();
  group.items = [...new Set([...(group.items || []), ...candidates.map(node => node.id)])];
  canvasRefreshGroupBounds(group);
  canvasSetSelection([group.id]);
  canvasEditorCommit(before, 'group-add-members');
  renderCanvasStudioNodes();
}
function canvasStudioRemoveSelectedFromGroup(groupId) {
  const group = canvasGetNode(groupId);
  if (!group || !canvasIsGroupNode(group)) return;
  const selected = new Set(canvasStudioState.selectedIds || []);
  const removed = (group.items || []).filter(id => selected.has(id));
  if (!removed.length) return toast('请先选择该组内需要移出的节点', 'ng');
  const before = canvasEditorSnapshot();
  group.items = (group.items || []).filter(id => !selected.has(id));
  canvasRefreshGroupBounds(group);
  canvasSetSelection(removed);
  canvasEditorCommit(before, 'group-remove-members');
  renderCanvasStudioNodes();
}
function canvasAutoLayoutGroupById(groupId) {
  const group = canvasGetNode(groupId);
  if (!group || !canvasIsGroupNode(group)) return;
  const before = canvasEditorSnapshot();
  canvasAutoLayoutGroup(group);
  canvasSetSelection([group.id]);
  canvasEditorCommit(before, 'group-auto-layout');
  renderCanvasStudioNodes();
}
function canvasStudioUngroup(groupId) {
  const group = canvasGetNode(groupId);
  if (!group || !canvasIsGroupNode(group)) return;
  const memberIds = canvasGroupMembers(group).map(node => node.id);
  const before = canvasEditorSnapshot();
  canvasStudioState.nodes = canvasStudioState.nodes.filter(node => node.id !== groupId);
  canvasStudioState.connections = canvasStudioState.connections.filter(edge => edge.from !== groupId && edge.to !== groupId);
  canvasSetSelection(memberIds);
  canvasEditorCommit(before, 'ungroup');
  renderCanvasStudioNodes();
}
function canvasStudioUngroupSelected() {
  const groups = canvasSelectedNodes().filter(node => canvasIsGroupNode(node));
  if (!groups.length) return toast('请先选择分组', 'ng');
  groups.forEach(group => canvasStudioUngroup(group.id));
}
function canvasStudioAddGroupFromSelection(groupId) { canvasStudioAddSelectedToGroup(groupId); }
function canvasStudioToggleGroup(groupId) {
  const group = canvasGetNode(groupId);
  if (!group || !canvasIsGroupNode(group)) return;
  const before = canvasEditorSnapshot();
  group.collapsed = !group.collapsed;
  canvasEditorCommit(before, 'group-toggle');
  renderCanvasStudioNodes();
}
function canvasStudioRemoveNode(id) {
  const node = canvasGetNode(id);
  if (canvasIsGroupNode(node)) return canvasStudioUngroup(id);
  canvasSetSelection([id]);
  canvasStudioDeleteSelected();
}
function updateCanvasStudioCounts() { const nodes = document.getElementById('canvas-node-count'); const connections = document.getElementById('canvas-connection-count'); if (nodes) nodes.textContent = canvasStudioState.nodes.length; if (connections) connections.textContent = canvasStudioState.connections.length; }
function renderCanvasStudioConnections() {
  const svg = document.getElementById('canvas-studio-connections');
  const world = document.getElementById('canvas-studio-world');
  if (!svg || !world) return;
  svg.setAttribute('viewBox', '-3000 -2000 6000 4000');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = canvasStudioState.connections.map(edge => {
    const source = canvasGetNode(edge.from);
    const target = canvasGetNode(edge.to);
    if (!source || !target) return '';
    const a = canvasPortPosition(source, edge.fromPort || 'out', 'out');
    const b = canvasPortPosition(target, edge.toPort || 'image', 'in');
    const curve = Math.max(48, Math.abs(b.x - a.x) * .45);
    const selected = edge.id === canvasStudioState.selectedConnectionId ? ' is-selected' : '';
    const edgeState = canvasCascadeNodeState(edge.to) || canvasCascadeNodeState(edge.from);
    const cascadeClass = edgeState === 'running' ? ' conn-cascade-active' : edgeState === 'done' ? ' conn-cascade-done' : edgeState === 'failed' ? ' conn-cascade-failed' : '';
    return `<path class="canvas-connection${selected}${cascadeClass}" data-connection-id="${canvasEscape(edge.id)}" d="M ${a.x} ${a.y} C ${a.x + curve} ${a.y}, ${b.x - curve} ${b.y}, ${b.x} ${b.y}"/>`;
  }).join('');
  svg.querySelectorAll('.canvas-connection').forEach(path => {
    path.addEventListener('pointerdown', event => {
      event.stopPropagation();
      canvasStudioState.selectedConnectionId = path.dataset.connectionId || '';
      canvasSetSelection([]);
      renderCanvasStudioConnections();
    });
  });
}
function renderCanvasConnectionPreview(event) {
  const svg = document.getElementById('canvas-studio-connections');
  const connection = canvasStudioState.connect;
  if (!svg || !connection) return;
  const source = canvasGetNode(connection.from);
  if (!source) return;
  const a = canvasPortPosition(source, connection.fromPort, 'out');
  const point = canvasStudioPointFromEvent(event);
  const curve = Math.max(48, Math.abs(point.x - a.x) * .45);
  let preview = svg.querySelector('#canvas-connection-preview');
  if (!preview) {
    preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    preview.id = 'canvas-connection-preview';
    preview.classList.add('canvas-connection-preview');
    svg.appendChild(preview);
  }
  preview.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + curve} ${a.y}, ${point.x - curve} ${point.y}, ${point.x} ${point.y}`);
}
function clearCanvasConnectionPreview() {
  document.getElementById('canvas-connection-preview')?.remove();
  document.querySelectorAll('.canvas-port.is-connecting').forEach(item => item.classList.remove('is-connecting'));
  document.getElementById('canvas-studio-board')?.classList.remove('is-connecting');
}
function canvasCommitConnectionAtPoint(event) {
  const connection = canvasStudioState.connect;
  if (!connection) return false;
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const targetPort = element?.closest?.('.canvas-port[data-port-direction="in"]');
  const targetNodeId = targetPort?.closest('.canvas-node')?.dataset.nodeId || '';
  const targetPortName = targetPort?.dataset.port || '';
  if (!targetNodeId || !targetPortName) { toast('请将连线拖到有效的输入端口', 'ng'); return false; }
  if (targetNodeId === connection.from) { toast('不能连接节点自身', 'ng'); return false; }
  if (!canvasPortAllowed(connection.from, connection.fromPort, targetNodeId, targetPortName)) { toast('该端口类型不支持连接', 'ng'); return false; }
  const duplicate = canvasStudioState.connections.some(edge => edge.from === connection.from && edge.fromPort === connection.fromPort && edge.to === targetNodeId && edge.toPort === targetPortName);
  if (duplicate) { toast('该连接已经存在', 'ng'); return false; }
  const edge = { id: `canvas-connection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, from: connection.from, fromPort: connection.fromPort, to: targetNodeId, toPort: targetPortName, type: connection.type };
  canvasStudioState.connections.push(edge);
  canvasStudioState.selectedConnectionId = edge.id;
  canvasEditorCommit(connection.before, 'connect');
  toast('连接已创建', 'ok');
  return true;
}
function renderCanvasStudioMinimap() {
  const stage = document.getElementById('canvas-minimap-stage');
  const board = document.getElementById('canvas-studio-board');
  if (!stage || !board) return;
  const nodes = canvasStudioState.nodes;
  if (!nodes.length) {
    stage.innerHTML = '<span class="canvas-minimap-empty">暂无节点</span>';
    return;
  }
  const minX = Math.min(...nodes.map(node => node.x));
  const minY = Math.min(...nodes.map(node => node.y));
  const maxX = Math.max(...nodes.map(node => node.x + canvasNodeBounds(node).width));
  const maxY = Math.max(...nodes.map(node => node.y + canvasNodeBounds(node).height));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const stageWidth = stage.clientWidth || 158;
  const stageHeight = stage.clientHeight || 104;
  const scale = Math.min((stageWidth - 8) / width, (stageHeight - 8) / height);
  const offsetX = (stageWidth - width * scale) / 2;
  const offsetY = (stageHeight - height * scale) / 2;
  const hidden = new Set(canvasStudioState.nodes.filter(node => canvasNodeIsHiddenByCollapsedGroup(node)).map(node => node.id));
  const nodeMarkup = nodes.filter(node => !hidden.has(node.id)).map(node => {
    const bounds = canvasNodeBounds(node);
    return `<span class="canvas-minimap-node ${canvasIsGroupNode(node) ? 'is-group' : ''} ${canvasStudioState.selectedIds.includes(node.id) ? 'is-selected' : ''}" style="left:${offsetX + (node.x - minX) * scale}px;top:${offsetY + (node.y - minY) * scale}px;width:${Math.max(7, bounds.width * scale)}px;height:${Math.max(5, bounds.height * scale)}px"></span>`;
  }).join('');
  const view = canvasStudioState.viewport;
  const visibleWorldWidth = board.clientWidth / Math.max(.01, view.scale);
  const visibleWorldHeight = board.clientHeight / Math.max(.01, view.scale);
  const viewLeft = (-board.clientWidth / 2 - view.x) / view.scale;
  const viewTop = (-board.clientHeight / 2 - view.y) / view.scale;
  const viewportMarkup = `<span class="canvas-minimap-viewport" style="left:${offsetX + (viewLeft - minX) * scale}px;top:${offsetY + (viewTop - minY) * scale}px;width:${Math.max(12, visibleWorldWidth * scale)}px;height:${Math.max(9, visibleWorldHeight * scale)}px"></span>`;
  stage.dataset.minX = String(minX);
  stage.dataset.minY = String(minY);
  stage.dataset.mmScale = String(scale);
  stage.dataset.offsetX = String(offsetX);
  stage.dataset.offsetY = String(offsetY);
  stage.innerHTML = `${nodeMarkup}${viewportMarkup}`;
}
function bindCanvasStudioMinimap() {
  const stage = document.getElementById('canvas-minimap-stage');
  const board = document.getElementById('canvas-studio-board');
  if (!stage || !board || stage.dataset.bound === 'true') return;
  stage.dataset.bound = 'true';
  stage.addEventListener('pointerdown', event => {
    const scale = Number(stage.dataset.mmScale) || 0;
    if (!scale) return;
    const rect = stage.getBoundingClientRect();
    const minX = Number(stage.dataset.minX) || 0;
    const minY = Number(stage.dataset.minY) || 0;
    const offsetX = Number(stage.dataset.offsetX) || 0;
    const offsetY = Number(stage.dataset.offsetY) || 0;
    const worldX = minX + (event.clientX - rect.left - offsetX) / scale;
    const worldY = minY + (event.clientY - rect.top - offsetY) / scale;
    const before = canvasEditorSnapshot();
    canvasStudioState.viewport.x = -worldX * canvasStudioState.viewport.scale;
    canvasStudioState.viewport.y = -worldY * canvasStudioState.viewport.scale;
    applyCanvasStudioViewport();
    canvasEditorCommit(before, 'minimap-pan');
  });
}
function applyCanvasStudioViewport() { const board = document.getElementById('canvas-studio-board'); const world = document.querySelector('#canvas-studio-board .smart-canvas-world'); const svg = document.getElementById('canvas-studio-connections'); if (!world || !board) return; const view = canvasStudioState.viewport; const originX = board.clientWidth / 2 + view.x; const originY = board.clientHeight / 2 + view.y; world.style.transform = `translate(${originX}px, ${originY}px) scale(${view.scale})`; const grid = world.querySelector('.canvas-studio-grid'); if (grid) { grid.style.backgroundPosition = `${originX}px ${originY}px`; grid.style.backgroundSize = `${22 * view.scale}px ${22 * view.scale}px`; } requestAnimationFrame(() => { if (canvasStudioState.active) { renderCanvasStudioConnections(); renderCanvasStudioMinimap(); } }); }
function canvasStudioFitView() { const board = document.getElementById('canvas-studio-board'); if (!board || !canvasStudioState.nodes.length) return; const minX = Math.min(...canvasStudioState.nodes.map(node => node.x)); const minY = Math.min(...canvasStudioState.nodes.map(node => node.y)); const maxX = Math.max(...canvasStudioState.nodes.map(node => node.x + 232)); const maxY = Math.max(...canvasStudioState.nodes.map(node => node.y + 142)); const width = Math.max(320, maxX - minX + 120); const height = Math.max(240, maxY - minY + 120); canvasStudioState.viewport.scale = Math.min(2.2, Math.max(.35, Math.min(board.clientWidth / width, board.clientHeight / height))); canvasStudioState.viewport.x = -(minX + maxX) * canvasStudioState.viewport.scale / 2; canvasStudioState.viewport.y = -(minY + maxY) * canvasStudioState.viewport.scale / 2; applyCanvasStudioViewport(); canvasScheduleSave(); }
function canvasStudioResetView() { const before = canvasEditorSnapshot(); canvasStudioState.viewport = { x: 0, y: 0, scale: 1 }; applyCanvasStudioViewport(); canvasEditorCommit(before, 'reset-view'); }
function bindCanvasStudioShortcuts() {
  if (document.body.dataset.canvasShortcutsBound === 'true') return;
  document.body.dataset.canvasShortcutsBound = 'true';
  // 捕获阶段优先处理撤销/重做：外层页面也注册了 Ctrl+Z，冒泡阶段会被其提前截获。
  // 只接管普通画布激活且焦点不在可编辑控件中的 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y。
  document.addEventListener('keydown', event => {
    if (!canvasStudioState.active) return;
    const target = event.target;
    const editing = target.matches?.('input,textarea,select,[contenteditable="true"]');
    const key = event.key.toLowerCase();
    if (!editing && (event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.shiftKey ? canvasEditorRedo() : canvasEditorUndo();
    } else if (!editing && (event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      event.stopImmediatePropagation();
      canvasEditorRedo();
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (!canvasStudioState.active) return;
    if (event.key === 'Escape' && canvasStudioState.connect) { canvasStudioState.connect = null; clearCanvasConnectionPreview(); renderCanvasStudioConnections(); return; }
    const target = event.target;
    const editing = target.matches?.('input,textarea,select,[contenteditable="true"]');
    if (event.code === 'Space' && !editing) { event.preventDefault(); canvasStudioState.spacePressed = true; return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !editing) { event.preventDefault(); canvasStudioCopy(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && !editing) { event.preventDefault(); canvasStudioPaste(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !editing) { event.preventDefault(); canvasStudioDeleteSelected(); }
  });
  document.addEventListener('keyup', event => {
    if (event.code === 'Space') canvasStudioState.spacePressed = false;
  });
}

function canvasStudioExit() {
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('workspace-main');
  const inspector = document.querySelector('.right-inspector');
  const appShell = document.getElementById('app-shell');
  if (main?.dataset.previousCanvasHtml) { main.innerHTML = main.dataset.previousCanvasHtml; delete main.dataset.previousCanvasHtml; }
  if (inspector?.dataset.previousCanvasHtml) { inspector.innerHTML = inspector.dataset.previousCanvasHtml; delete inspector.dataset.previousCanvasHtml; }
  main?.classList.remove('canvas-studio-active');
  inspector?.classList.remove('canvas-studio-active');
  appShell?.classList.remove('canvas-right-inspector-hidden');
  canvasStudioState.active = false;
  canvasStudioState.connect = null;
  canvasStudioState.spacePressed = false;
  sidebar?.setAttribute('data-active-mode', 'recolor');
  document.body?.setAttribute('data-active-mode', 'recolor');
  // 退出画布时确保侧栏恢复（防止画布模式 CSS 隐藏后残留）
  if (typeof setLeftSidebarCollapsed === 'function') setLeftSidebarCollapsed(false);
  document.querySelectorAll('.sidebar-mode-link').forEach(link => link.classList.toggle('active', link.dataset.mode === 'recolor'));
  updateScanButton?.();
  updateBottomBar?.(window.__currentBatch || null);
  fetchLogs?.();
  renderFilterBar?.();
}

// ===== 输出灯箱（对比滑块 + 提示词面板 + 下载/重跑）=====
function openCanvasStudioLightbox(url, originalUrl, nodeId, prompt) {
  const lb = document.getElementById('canvas-output-lightbox');
  if (!lb || !url) return;
  const img = document.getElementById('canvas-output-lightbox-img');
  const resultImg = document.getElementById('canvas-output-compare-result');
  const originalImg = document.getElementById('canvas-output-compare-original');
  const container = document.getElementById('canvas-output-compare-container');
  const slider = document.getElementById('canvas-output-compare-slider');
  const originalWrap = document.getElementById('canvas-output-compare-original-wrap');
  const resolution = document.getElementById('canvas-output-resolution');
  const promptPanel = document.getElementById('canvas-output-prompt-panel');
  const promptText = document.getElementById('canvas-output-prompt-text');
  const downloadBtn = document.getElementById('canvas-output-download-btn');
  const copyBtn = document.getElementById('canvas-output-copy-prompt-btn');
  const rerunBtn = document.getElementById('canvas-output-rerun-btn');
  if (img) { img.src = url; img.onload = () => { if (resolution) resolution.textContent = `${img.naturalWidth} x ${img.naturalHeight}`; }; }
  if (resultImg) resultImg.src = url;
  const hasCompare = originalUrl && originalUrl !== url;
  if (container) container.style.display = hasCompare ? 'block' : 'none';
  if (originalImg && hasCompare) originalImg.src = originalUrl;
  if (slider && hasCompare) { slider.style.left = '50%'; if (originalWrap) originalWrap.style.clipPath = 'inset(0 50% 0 0)'; }
  if (promptPanel) { promptPanel.classList.toggle('open', !!prompt); if (promptText) promptText.textContent = prompt || ''; }
  if (copyBtn) copyBtn.onclick = () => { if (prompt) navigator.clipboard.writeText(prompt).then(() => toast('已复制提示词')).catch(() => {}); };
  if (rerunBtn && nodeId) rerunBtn.onclick = () => { closeCanvasStudioLightbox(); canvasStudioGenerate(nodeId); };
  if (downloadBtn) downloadBtn.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = (nodeId || 'output') + '.png'; a.click(); };
  lb.classList.add('is-open');
  bindCanvasStudioCompareSlider();
}
function closeCanvasStudioLightbox() {
  const lb = document.getElementById('canvas-output-lightbox');
  if (lb) lb.classList.remove('is-open');
  const img = document.getElementById('canvas-output-lightbox-img');
  if (img) img.src = '';
}
function bindCanvasStudioCompareSlider() {
  const slider = document.getElementById('canvas-output-compare-slider');
  const container = document.getElementById('canvas-output-compare-container');
  const originalWrap = document.getElementById('canvas-output-compare-original-wrap');
  if (!slider || !container) return;
  let dragging = false;
  const update = (clientX) => {
    const rect = container.getBoundingClientRect();
    if (!rect.width) return;
    const percent = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    slider.style.left = `${percent}%`;
    if (originalWrap) originalWrap.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
  };
  slider.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', e => { if (dragging) update(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; });
  container.addEventListener('dblclick', () => {
    const c = container;
    const s = document.getElementById('canvas-output-lightbox-img');
    const r = document.getElementById('canvas-output-compare-result');
    const o = document.getElementById('canvas-output-compare-original');
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
    if (s) s.style.display = c.style.display === 'none' ? 'block' : 'none';
    if (r) r.style.display = c.style.display === 'none' ? 'none' : 'block';
    if (o) o.style.display = c.style.display === 'none' ? 'none' : 'block';
  });
}

// ===== 节点右键菜单 =====
function openCanvasLinkCreateMenu(originId, originKind, clientX, clientY) {
  const node = canvasGetNode(originId);
  if (!node) return;
  const menu = document.getElementById('canvas-link-create-menu');
  if (!menu) return;
  const options = [];
  if (node.type === 'prompt' || node.type === 'llm') options.push({ type: 'prompt', label: '提示词' }, { type: 'llm', label: 'LLM' });
  if (canvasIsGeneratorNode(node)) options.push({ type: 'prompt', label: '提示词' }, { type: 'image', label: '图片' }, { type: 'loop', label: '循环' }, { type: 'group', label: '分组' }, { type: 'llm', label: 'LLM' });
  if (node.type === 'image' || node.type === 'smart-image') options.push({ type: 'prompt', label: '提示词' }, { type: 'loop', label: '循环' });
  if (!options.length) return false;
  menu.innerHTML = options.map(o => `<button class="canvas-menu-btn" onclick="canvasLinkCreateNode('${o.type}','${originId}','${originKind}',${clientX},${clientY})">${o.label}</button>`).join('');
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.classList.add('open');
  return true;
}
function canvasLinkCreateNode(type, originId, originKind, clientX, clientY) {
  const origin = canvasGetNode(originId);
  if (!origin) return;
  const point = canvasStudioViewportCenter();
  canvasStudioAddNode(type, { x: origin.x + 300, y: origin.y });
  const newNode = canvasStudioState.nodes[canvasStudioState.nodes.length - 1];
  if (newNode && originKind === 'out') {
    canvasStudioState.connections.push({ id: `canvas-connection-${Date.now()}`, from: originId, fromPort: 'out', to: newNode.id, toPort: 'prompt', type: 'prompt' });
  } else if (newNode && originKind === 'in') {
    canvasStudioState.connections.push({ id: `canvas-connection-${Date.now()}`, from: newNode.id, fromPort: 'out', to: originId, toPort: 'prompt', type: 'prompt' });
  }
  closeCanvasNodePortMenu();
  renderCanvasStudioNodes();
  canvasScheduleSave();
}
function openCanvasGeneratorNodeMenu(nodeId, clientX, clientY) {
  const node = canvasGetNode(nodeId);
  if (!node || !canvasIsGeneratorNode(node)) return false;
  const inputMenu = document.getElementById('canvas-node-input-menu');
  const outputMenu = document.getElementById('canvas-node-output-menu');
  if (!inputMenu || !outputMenu) return false;
  const inputs = [{ type: 'prompt', label: '提示词' }, { type: 'image', label: '图片' }, { type: 'loop', label: '循环' }, { type: 'llm', label: 'LLM' }];
  const outputs = [{ type: 'output', label: 'Output' }, { type: 'prompt', label: '提示词' }, { type: 'image', label: '图片' }];
  const btnHtml = (opts, kind) => opts.map(o => `<button class="canvas-menu-btn" onclick="canvasLinkCreateNode('${o.type}','${nodeId}','${kind}',${clientX},${clientY})">${o.label}</button>`).join('');
  inputMenu.innerHTML = `<div class="canvas-menu-section-title">添加输入</div>${btnHtml(inputs, 'in')}`;
  outputMenu.innerHTML = `<div class="canvas-menu-section-title">添加输出</div>${btnHtml(outputs, 'out')}`;
  inputMenu.style.left = `${Math.max(10, clientX - 160)}px`;
  inputMenu.style.top = `${clientY}px`;
  outputMenu.style.left = `${Math.min(window.innerWidth - 160, clientX + 20)}px`;
  outputMenu.style.top = `${clientY}px`;
  inputMenu.classList.add('open');
  outputMenu.classList.add('open');
  return true;
}
function closeCanvasNodePortMenu() {
  document.getElementById('canvas-link-create-menu')?.classList.remove('open');
  document.getElementById('canvas-node-input-menu')?.classList.remove('open');
  document.getElementById('canvas-node-output-menu')?.classList.remove('open');
}
document.addEventListener('click', () => closeCanvasNodePortMenu());

// ===== 快捷节点工具栏 =====
function toggleCanvasQuickToolbar() {
  const toolbar = document.getElementById('canvas-quick-toolbar');
  if (!toolbar) return;
  toolbar.classList.toggle('collapsed');
}