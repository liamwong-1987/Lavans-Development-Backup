const onlineState = { references: [], presets: {}, history: [], prompt: '', modelProviderMap: {} };

function onlineEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function onlineRefsUrl(file) {
  if (!file) return '';
  if (!file.__previewUrl) file.__previewUrl = URL.createObjectURL(file);
  return file.__previewUrl;
}

function onlineSetStatus(message, type = '') {
  const target = document.getElementById('online-status');
  if (!target) return;
  target.textContent = message || '';
  target.dataset.type = type;
}

function onlineRenderReferences() {
  const list = document.getElementById('online-reference-list');
  const count = document.getElementById('online-reference-count');
  if (!list || !count) return;
  count.textContent = `${onlineState.references.length} / 10 张`;
  list.innerHTML = onlineState.references.map((file, index) => `<div class="online-reference-item"><img src="${onlineRefsUrl(file)}" alt="图${index + 1}"><span>图${index + 1}</span><button type="button" onclick="onlineRemoveReference(${index})" aria-label="移除图${index + 1}">×</button></div>`).join('');
}

function onlineAddReferences(fileList) {
  const files = Array.from(fileList || []).filter(file => file.type.startsWith('image/'));
  const remaining = 10 - onlineState.references.length;
  if (files.length > remaining) onlineSetStatus('最多支持 10 张参考图', 'warning');
  onlineState.references.push(...files.slice(0, Math.max(0, remaining)));
  onlineRenderReferences();
}

function onlineRemoveReference(index) {
  const file = onlineState.references[index];
  if (file?.__previewUrl) URL.revokeObjectURL(file.__previewUrl);
  onlineState.references.splice(index, 1);
  onlineRenderReferences();
}

function onlineRenderMentions(textarea) {
  const menu = document.getElementById('online-mention-menu');
  if (!menu) return;
  const before = textarea.value.slice(0, textarea.selectionStart);
  if (!/@(?:图\d*)?$/.test(before)) { menu.hidden = true; return; }
  menu.hidden = false;
  menu.innerHTML = onlineState.references.length
    ? onlineState.references.map((_file, index) => `<button type="button" onclick="onlineInsertMention(${index + 1})"><span>@图${index + 1}</span><small>${onlineEscape(onlineState.references[index].name)}</small></button>`).join('')
    : '<div class="online-empty-text">请先上传参考图</div>';
}

function onlineInsertMention(index) {
  const textarea = document.getElementById('online-prompt');
  if (!textarea) return;
  const start = textarea.selectionStart;
  const before = textarea.value.slice(0, start).replace(/@(?:图\d*)?$/, '');
  const after = textarea.value.slice(start);
  textarea.value = `${before}@图${index} ${after}`;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = before.length + String(index).length + 3;
  onlineState.prompt = textarea.value;
  document.getElementById('online-mention-menu').hidden = true;
}

function onlinePopulateModels() {
  const select = document.getElementById('online-model');
  if (!select) return;
  const models = onlineState.modelOptions || ['gpt-image-2', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image'];
  select.innerHTML = models.map(model => {
    const providerId = onlineState.modelProviderMap[model] || '';
    return `<option value="${onlineEscape(model)}"${providerId ? ` data-provider-id="${onlineEscape(providerId)}"` : ''}>${onlineEscape(model)}</option>`;
  }).join('');
}

function onlineUpdateResolutionOptions() {
  const aspect = document.getElementById('online-aspect')?.value || '16:9';
  const select = document.getElementById('online-resolution');
  if (!select) return;
  const entries = Object.entries(onlineState.presets || {}).filter(([key]) => key.startsWith(`${aspect}-`));
  select.innerHTML = entries.map(([key, item]) => `<option value="${onlineEscape(key)}">${onlineEscape(item.label)}</option>`).join('');
  if (!entries.length) select.innerHTML = '<option value="16:9-1K">横屏 1K</option>';
}

async function onlineLoadOptions() {
  // 分辨率预设改为前端内置（画布 API 无 presets 接口），对齐大神 SIZE_OPTIONS
  const PRESETS = {
    '16:9': [{ key: '16:9-1K', label: '横屏 1K' }, { key: '16:9-2K', label: '横屏 2K' }, { key: '16:9-4K', label: '横屏 4K' }],
    '9:16': [{ key: '9:16-1K', label: '竖屏 1K' }, { key: '9:16-2K', label: '竖屏 2K' }, { key: '9:16-4K', label: '竖屏 4K' }],
    '1:1': [{ key: '1:1-1K', label: '正方形 1K' }, { key: '1:1-2K', label: '正方形 2K' }, { key: '1:1-4K', label: '正方形 4K' }]
  };
  onlineState.presets = PRESETS;
  onlineUpdateResolutionOptions();
}

async function onlineLoadConfig() {
  try {
    const response = await fetch('/api/canvas/providers');
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '画布 API 配置读取失败');
    const providers = result.providers || [];
    const imageModels = [];
    const modelProviderMap = {};
    for (const p of providers) {
      if (p.enabled === false) continue;
      const pid = String(p.id || '').trim();
      for (const m of (p.image_models || [])) {
        if (!m) continue;
        imageModels.push(m);
        modelProviderMap[m] = pid;
      }
    }
    onlineState.modelProviderMap = modelProviderMap;
    onlineState.modelOptions = [...new Set(imageModels)].filter(Boolean);
    if (!onlineState.modelOptions.length) onlineState.modelOptions = ['gpt-image-2'];
    onlinePopulateModels();
  } catch (error) {
    onlineSetStatus(error.message || '画布 API 配置读取失败', 'error');
  }
}

async function onlineOpenConfig() {
  // 接口设置统一跳转到画布 API 设置页（唯一），不再弹窗改创作接口
  window.location.href = '/canvas-api-settings.html';
}

function onlineShowResult(item) {
  const target = document.getElementById('online-result');
  if (!target || !item) return;
  const src = `${item.outputUrl}?t=${Date.now()}`;
  target.className = 'online-result-content';
  target.innerHTML = `<img class="online-result-image" src="${onlineEscape(src)}" alt="在线生图结果" onclick="onlineOpenLightbox('${onlineEscape(item.outputUrl)}','${onlineEscape(item.prompt || '在线生图结果')}')"><div class="online-result-meta"><span>${onlineEscape(item.resolution || '')} · ${onlineEscape(`${item.width || 0} × ${item.height || 0}`)}</span><a class="btn bs" href="${onlineEscape(item.outputUrl)}" download>下载图片</a></div>`;
}

async function onlineGenerate() {
  const button = document.getElementById('online-generate-btn');
  const prompt = document.getElementById('online-prompt')?.value.trim() || '';
  if (!prompt) { onlineSetStatus('请输入创作提示词', 'warning'); return; }
  if (button) { button.disabled = true; button.classList.add('is-loading'); button.textContent = '生成中…'; }
  onlineSetStatus('正在生成，请稍候……');
  try {
    // 参考图先上传到画布资产，拿 url 传给画布生成接口
    const assets = [];
    if (onlineState.references.length) {
      const upForm = new FormData();
      onlineState.references.forEach(file => upForm.append('files', file, file.name));
      const up = await fetch('/api/ai/upload', { method: 'POST', body: upForm }).then(r => r.json());
      (up.files || []).forEach(f => assets.push({ url: f.url }));
    }
    const model = document.getElementById('online-model')?.value || '';
    const modelSelect = document.getElementById('online-model');
    const providerId = modelSelect?.selectedOptions?.[0]?.dataset.providerId || onlineState.modelProviderMap[model] || '';
    const response = await fetch('/api/canvas/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, model, providerId, assets }) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '在线生图失败');
    const out = result.result || {};
    onlineShowResult({ outputUrl: out.outputUrl, prompt, width: 0, height: 0, resolution: '' });
    onlineSetStatus('生成完成', 'success');
    await onlineLoadHistory();
  } catch (error) {
    onlineSetStatus(error.message || '在线生图失败', 'error');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('is-loading'); button.textContent = '生成图片'; }
  }
}

async function onlineLoadHistory() {
  const list = document.getElementById('online-history-list');
  const count = document.getElementById('online-history-count');
  if (!list) return;
  try {
    const response = await fetch('/api/canvas/image-history');
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '历史记录读取失败');
    onlineState.history = result.history || [];
    if (count) count.textContent = `${onlineState.history.length} 条`;
    if (!onlineState.history.length) { list.innerHTML = '<div class="online-empty-text">暂无在线生图记录</div>'; return; }
    list.innerHTML = onlineState.history.map(item => `<div class="online-history-item" id="history-${onlineEscape(item.id)}" data-history-ts="${onlineEscape(item.id)}" onclick="onlineShowHistory('${onlineEscape(item.id)}')"><img src="${onlineEscape(item.outputUrl)}" alt="历史结果"><div class="online-history-item-info"><strong>${onlineEscape((item.prompt || '在线生图').slice(0, 36))}</strong><span>${onlineEscape(item.model || '')}</span><small>${onlineEscape(new Date(item.createdAt).toLocaleString('zh-CN'))}</small></div></div>`).join('');
    window.HistoryBulkManager?.attach({ container: '#online-history-list', onChanged: () => onlineLoadHistory() })?.refresh();
  } catch (error) {
    list.innerHTML = `<div class="online-empty-text">${onlineEscape(error.message || '历史记录读取失败')}</div>`;
  }
}

function onlineShowHistory(id) {
  const item = onlineState.history.find(entry => entry.id === id);
  if (item) onlineShowResult(item);
}

function onlineOpenLightbox(url, caption) {
  const lightbox = document.getElementById('online-lightbox');
  const image = document.getElementById('online-lightbox-image');
  const text = document.getElementById('online-lightbox-caption');
  if (!lightbox || !image) return;
  image.src = url;
  text.textContent = caption || '';
  lightbox.hidden = false;
}

function onlineCloseLightbox() {
  const lightbox = document.getElementById('online-lightbox');
  if (lightbox) lightbox.hidden = true;
}

window.addEventListener('load', async () => {
  try {
    const storedTheme = localStorage.getItem('lavans-theme');
    if (storedTheme === 'light' || storedTheme === 'dark') document.documentElement.dataset.theme = storedTheme;
  } catch (_error) {}
  document.getElementById('online-reference-input')?.addEventListener('change', event => onlineAddReferences(event.target.files));
  const zone = document.getElementById('online-upload-zone');
  ['dragenter', 'dragover'].forEach(type => zone?.addEventListener(type, event => { event.preventDefault(); zone.classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach(type => zone?.addEventListener(type, event => { event.preventDefault(); zone.classList.remove('is-dragging'); }));
  zone?.addEventListener('drop', event => onlineAddReferences(event.dataTransfer.files));
  const prompt = document.getElementById('online-prompt');
  prompt?.addEventListener('input', event => { onlineState.prompt = event.target.value; onlineRenderMentions(event.target); });
  prompt?.addEventListener('click', event => onlineRenderMentions(event.target));
  prompt?.addEventListener('keydown', event => { if (event.key === 'Escape') document.getElementById('online-mention-menu').hidden = true; });
  document.getElementById('online-aspect')?.addEventListener('change', onlineUpdateResolutionOptions);
  document.getElementById('online-generate-btn')?.addEventListener('click', onlineGenerate);
  document.getElementById('online-config-btn')?.addEventListener('click', onlineOpenConfig);
  document.getElementById('online-refresh-history')?.addEventListener('click', onlineLoadHistory);
  document.getElementById('online-lightbox-close')?.addEventListener('click', onlineCloseLightbox);
  document.getElementById('online-lightbox')?.addEventListener('click', event => { if (event.target.id === 'online-lightbox') onlineCloseLightbox(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') onlineCloseLightbox(); });
  await Promise.all([onlineLoadConfig(), onlineLoadOptions(), onlineLoadHistory()]);
});
