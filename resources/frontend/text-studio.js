const textState = { presets: {}, history: [], modelOptions: [], currentItem: null };

function textEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function textSetStatus(message, type = '') {
  const target = document.getElementById('text-status');
  if (!target) return;
  target.textContent = message || '';
  target.dataset.type = type;
}

function textUpdatePromptCount() {
  const input = document.getElementById('text-prompt');
  const count = document.getElementById('text-prompt-count');
  if (input && count) count.textContent = `${input.value.length} / 4000`;
}

function textPopulateModels() {
  const select = document.getElementById('text-model');
  if (!select) return;
  const models = textState.modelOptions.length ? textState.modelOptions : ['当前接口模型'];
  select.innerHTML = models.map(model => `<option value="${textEscape(model)}">${textEscape(model)}</option>`).join('');
}

function textUpdateResolutionOptions() {
  const aspect = document.getElementById('text-aspect')?.value || '16:9';
  const select = document.getElementById('text-resolution');
  if (!select) return;
  const entries = Object.entries(textState.presets || {}).filter(([key]) => key.startsWith(`${aspect}-`));
  select.innerHTML = entries.map(([key, item]) => `<option value="${textEscape(key)}">${textEscape(item.label)}</option>`).join('');
  if (!entries.length) select.innerHTML = '<option value="16:9-1K">横屏 1K</option>';
}

async function textLoadOptions() {
  // 分辨率预设改为前端内置（画布 API 无 presets 接口），对齐大神 SIZE_OPTIONS
  const PRESETS = {
    '16:9': [{ key: '16:9-1K', label: '横屏 1K' }, { key: '16:9-2K', label: '横屏 2K' }, { key: '16:9-4K', label: '横屏 4K' }],
    '9:16': [{ key: '9:16-1K', label: '竖屏 1K' }, { key: '9:16-2K', label: '竖屏 2K' }, { key: '9:16-4K', label: '竖屏 4K' }],
    '1:1': [{ key: '1:1-1K', label: '正方形 1K' }, { key: '1:1-2K', label: '正方形 2K' }, { key: '1:1-4K', label: '正方形 4K' }]
  };
  textState.presets = PRESETS;
  textUpdateResolutionOptions();
}

async function textLoadConfig() {
  try {
    const response = await fetch('/api/canvas/providers');
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '画布 API 配置读取失败');
    const providers = result.providers || [];
    const imageModels = providers.filter(p => p.enabled !== false).flatMap(p => p.image_models || []);
    textState.modelOptions = [...new Set(imageModels)].filter(Boolean);
    if (!textState.modelOptions.length) textState.modelOptions = ['gpt-image-2'];
    textPopulateModels();
  } catch (error) {
    textSetStatus(error.message || '画布 API 配置读取失败', 'error');
  }
}

async function textOpenConfig() {
  // 接口设置统一跳转到画布 API 设置页（唯一），不再弹窗改创作接口
  window.location.href = '/canvas-api-settings.html';
}

function textShowResult(item) {
  const target = document.getElementById('text-result');
  if (!target || !item?.outputUrl) return;
  textState.currentItem = item;
  const src = `${item.outputUrl}?t=${Date.now()}`;
  target.className = 'text-result-content';
  target.innerHTML = `<img class="text-result-image" src="${textEscape(src)}" alt="文生图结果" onclick="textOpenLightbox('${textEscape(item.outputUrl)}','${textEscape(item.prompt || '文生图结果')}')"><div class="text-result-meta"><span>${textEscape(item.resolution || '')} · ${textEscape(`${item.width || 0} × ${item.height || 0}`)}</span><a class="btn bs" href="${textEscape(item.outputUrl)}" download>下载图片</a></div>`;
}

async function textGenerate() {
  const button = document.getElementById('text-generate-btn');
  const prompt = document.getElementById('text-prompt')?.value.trim() || '';
  if (!prompt) { textSetStatus('请输入创作提示词', 'warning'); document.getElementById('text-prompt')?.focus(); return; }
  if (button) { button.disabled = true; button.classList.add('is-loading'); button.textContent = '生成中...'; }
  textSetStatus('正在生成，请稍候……');
  try {
    const model = document.getElementById('text-model')?.value || '';
    const response = await fetch('/api/canvas/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, model, assets: [] }) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '文生图失败');
    const out = result.result || {};
    textShowResult({ outputUrl: out.outputUrl, prompt, width: 0, height: 0, resolution: '' });
    textSetStatus('生成完成', 'success');
    await textLoadHistory();
  } catch (error) {
    textSetStatus(error.message || '文生图失败', 'error');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('is-loading'); button.textContent = '生成图片'; }
  }
}

async function textLoadHistory() {
  const list = document.getElementById('text-history-list');
  const count = document.getElementById('text-history-count');
  if (!list) return;
  try {
    const response = await fetch('/api/canvas/image-history');
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '历史记录读取失败');
    textState.history = result.history || [];
    if (count) count.textContent = `${textState.history.length} 条`;
    if (!textState.history.length) { list.innerHTML = '<div class="text-empty-text">暂无文生图记录</div>'; return; }
    list.innerHTML = textState.history.map(item => `<div class="text-history-item" id="history-${textEscape(item.id)}" data-history-ts="${textEscape(item.id)}" onclick="textShowHistory('${textEscape(item.id)}')"><img src="${textEscape(item.outputUrl)}" alt="历史结果"><div class="text-history-item-info"><strong>${textEscape(item.prompt || '文生图结果').slice(0, 36)}</strong><span>${textEscape(item.model || '')}</span><small>${textEscape(new Date(item.createdAt).toLocaleString('zh-CN'))}</small></div></div>`).join('');
    window.HistoryBulkManager?.attach({ container: '#text-history-list', onChanged: () => textLoadHistory() })?.refresh();
  } catch (error) {
    list.innerHTML = `<div class="text-empty-text">${textEscape(error.message || '历史记录读取失败')}</div>`;
  }
}

function textShowHistory(id) {
  const item = textState.history.find(entry => entry.id === id);
  if (item) textShowResult(item);
}

function textOpenLightbox(url, caption) {
  const lightbox = document.getElementById('text-lightbox');
  const image = document.getElementById('text-lightbox-image');
  const text = document.getElementById('text-lightbox-caption');
  if (!lightbox || !image) return;
  image.src = url;
  if (text) text.textContent = caption || '';
  lightbox.hidden = false;
}

function textCloseLightbox() {
  const lightbox = document.getElementById('text-lightbox');
  if (lightbox) lightbox.hidden = true;
}

async function textCopyPrompt() {
  const value = document.getElementById('text-prompt')?.value || '';
  if (!value) { textSetStatus('当前没有可复制的提示词', 'warning'); return; }
  try { await navigator.clipboard.writeText(value); textSetStatus('提示词已复制', 'success'); }
  catch (_error) { textSetStatus('复制失败，请手动选择提示词', 'error'); }
}

window.addEventListener('load', async () => {
  try {
    const storedTheme = localStorage.getItem('lavans-theme');
    if (storedTheme === 'light' || storedTheme === 'dark') document.documentElement.dataset.theme = storedTheme;
  } catch (_error) {}
  const prompt = document.getElementById('text-prompt');
  prompt?.addEventListener('input', textUpdatePromptCount);
  document.getElementById('text-aspect')?.addEventListener('change', textUpdateResolutionOptions);
  document.getElementById('text-generate-btn')?.addEventListener('click', textGenerate);
  document.getElementById('text-config-btn')?.addEventListener('click', textOpenConfig);
  document.getElementById('text-refresh-history')?.addEventListener('click', textLoadHistory);
  document.getElementById('text-clear-prompt')?.addEventListener('click', () => { if (prompt) prompt.value = ''; textUpdatePromptCount(); textSetStatus('提示词已清空'); });
  document.getElementById('text-copy-prompt')?.addEventListener('click', textCopyPrompt);
  document.getElementById('text-lightbox-close')?.addEventListener('click', textCloseLightbox);
  document.getElementById('text-lightbox')?.addEventListener('click', event => { if (event.target.id === 'text-lightbox') textCloseLightbox(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') textCloseLightbox(); });
  textUpdatePromptCount();
  await Promise.all([textLoadConfig(), textLoadOptions(), textLoadHistory()]);
});
