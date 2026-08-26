const creativeState = {
  references: [],
  history: [],
  prompt: '',
  preset: '16:9-1K',
  presets: {}
};

function creativeEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderCreativeMode() {
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('workspace-main');
  const inspector = document.querySelector('.right-inspector');
  if (main?.classList.contains('creative-mode-active')) {
    document.querySelectorAll('.sidebar-mode-link').forEach(link => link.classList.toggle('active', link.dataset.mode === 'creative'));
    return;
  }
  sidebar?.setAttribute('data-active-mode', 'creative');
  document.body?.setAttribute('data-active-mode', 'creative');
  document.body?.setAttribute('data-active-system', 'creative');
  document.documentElement?.setAttribute('data-active-system', 'creative');
  if (!main || !inspector) return;
  sidebar?.setAttribute('data-active-mode', 'creative');
  document.body?.setAttribute('data-active-mode', 'creative');
  main.classList.add('creative-mode-active');
  main.dataset.previousCreativeHtml = main.innerHTML;
  main.innerHTML = `
    <section class="creative-workspace" id="creative-workspace">
      <header class="creative-header"><div><h1>创作生成</h1><p>参考图和提示词生成单张图片</p></div><span id="creative-ref-count">0 / 10 张参考图</span></header>
      <section class="creative-card creative-reference-card"><div class="creative-card-head"><h2>参考图</h2><span>可选，最多 10 张</span></div><label class="creative-upload-zone" id="creative-upload-zone"><input id="creative-reference-input" type="file" accept=".jpg,.jpeg,.png,.webp,.bmp,.gif" multiple><span class="creative-upload-icon">＋</span><strong>点击、拖放或批量选择图片</strong><small>不上传参考图也可以直接文生图</small></label><div class="creative-reference-list" id="creative-reference-list"></div></section>
      <section class="creative-card"><div class="creative-card-head"><h2>提示词</h2><span>输入 @ 可引用已上传图片</span></div><div class="creative-prompt-wrap"><textarea id="creative-prompt" placeholder="描述你要生成的画面，例如：将 @图1 放入 @图2 的场景中央……"></textarea><div class="creative-mention-menu" id="creative-mention-menu" hidden></div><div class="creative-prompt-references" id="creative-prompt-references"></div></div></section>
      <section class="creative-settings"><label>画面比例<select id="creative-aspect"><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option><option value="1:1">正方形 1:1</option></select></label><label>输出分辨率<select id="creative-resolution"></select></label><button class="btn bs creative-config-btn" id="creative-config-btn" onclick="openCreativeApiConfig()">创作接口设置</button><button class="btn bp creative-generate-btn" id="creative-generate-btn" onclick="generateCreativeImage()">生成图片</button></section><div class="creative-status" id="creative-status"></div>
    </section>`;
  inspector.classList.add('creative-mode-active');
  inspector.dataset.previousCreativeHtml = inspector.innerHTML;
  inspector.innerHTML = `<div class="inspector-card creative-preview-panel"><div class="inspector-header">生成预览</div><div class="creative-preview-body" id="creative-preview-body"><div class="creative-preview-empty">生成结果会显示在这里</div></div></div><div class="inspector-card creative-history-panel"><div class="inspector-header">创作历史 <button class="creative-history-refresh" onclick="loadCreativeHistory()">刷新</button></div><div id="creative-history-list" class="creative-history-list"><div class="creative-preview-empty">正在读取历史记录</div></div></div>`;
  window.HistoryBulkManager?.attach({ container: '#creative-history-list', onChanged: () => loadCreativeHistory() });
  bindCreativeEvents();
  loadCreativeOptions();
  document.getElementById('creative-aspect')?.addEventListener('change', updateCreativeResolutionOptions);
  loadCreativeHistory();
}

function bindCreativeEvents() {
  const input = document.getElementById('creative-reference-input');
  const zone = document.getElementById('creative-upload-zone');
  input?.addEventListener('change', event => addCreativeReferences(event.target.files));
  ['dragenter', 'dragover'].forEach(type => zone?.addEventListener(type, event => { event.preventDefault(); zone.classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach(type => zone?.addEventListener(type, event => { event.preventDefault(); zone.classList.remove('is-dragging'); }));
  zone?.addEventListener('drop', event => addCreativeReferences(event.dataTransfer.files));
  const prompt = document.getElementById('creative-prompt');
  prompt?.addEventListener('input', event => { creativeState.prompt = event.target.value; showCreativeMentions(event.target); renderPromptReferenceThumbnails(); });
  prompt?.addEventListener('click', event => renderPromptReferenceThumbnails());
  prompt?.addEventListener('keydown', event => { if (event.key === 'Escape') closeCreativeMentions(); });
}

function addCreativeReferences(fileList) {
  const files = Array.from(fileList || []).filter(file => file.type.startsWith('image/'));
  const remaining = 10 - creativeState.references.length;
  if (files.length > remaining) toast('最多支持 10 张参考图', 'wn');
  creativeState.references.push(...files.slice(0, remaining));
  renderCreativeReferences();
}

function renderCreativeReferences() {
  const list = document.getElementById('creative-reference-list');
  const count = document.getElementById('creative-ref-count');
  if (!list || !count) return;
  count.textContent = `${creativeState.references.length} / 10 张参考图`;
  list.innerHTML = creativeState.references.map((file, index) => {
    const url = URL.createObjectURL(file);
    return `<div class="creative-reference-item"><button class="creative-thumb-button" onclick="openCreativeImagePreview('${url}','图${index + 1}')" title="放大查看图${index + 1}"><img src="${url}" alt="图${index + 1}"><span>图${index + 1}</span></button><button class="creative-reference-remove" onclick="removeCreativeReference(${index})" title="移除图${index + 1}">×</button></div>`;
  }).join('');
  renderPromptReferenceThumbnails();
}

function renderPromptReferenceThumbnails() {
  const target = document.getElementById('creative-prompt-references');
  const prompt = document.getElementById('creative-prompt')?.value || '';
  if (!target) return;
  const indexes = [...prompt.matchAll(/@图(\d+)/g)].map(match => Number(match[1])).filter((index, position, arr) => index >= 1 && index <= creativeState.references.length && arr.indexOf(index) === position);
  target.innerHTML = indexes.map(index => {
    const file = creativeState.references[index - 1];
    const url = URL.createObjectURL(file);
    return `<button class="creative-prompt-reference" onclick="openCreativeImagePreview('${url}','@图${index}')" title="放大查看 @图${index}"><img src="${url}" alt="@图${index}"><span>@图${index}</span><i class="creative-magnifier" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.5"></circle><path d="m15 15 4 4"></path></svg></i></button>`;
  }).join('');
}

function openCreativeImagePreview(url, title) {
  let modal = document.getElementById('creative-image-preview');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'creative-image-preview';
    modal.className = 'creative-image-preview';
    modal.onclick = event => { if (event.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="creative-image-preview-panel"><button onclick="document.getElementById('creative-image-preview').remove()" title="关闭">×</button><img src="${url}" alt="${creativeEsc(title)}"><div>${creativeEsc(title)}</div></div>`;
}

function removeCreativeReference(index) {
  creativeState.references.splice(index, 1);
  renderCreativeReferences();
}

function updateCreativeResolutionOptions() {
  const aspect = document.getElementById('creative-aspect')?.value || '16:9';
  const select = document.getElementById('creative-resolution');
  if (!select) return;
  const entries = Object.entries(creativeState.presets).filter(([key]) => key.startsWith(`${aspect}-`));
  const current = select.value;
  select.innerHTML = entries.map(([key, item]) => `<option value="${key}">${creativeEsc(item.label)}</option>`).join('');
  if (entries.some(([key]) => key === current)) select.value = current;
}

function showCreativeMentions(textarea) {
  const menu = document.getElementById('creative-mention-menu');
  if (!menu) return;
  const before = textarea.value.slice(0, textarea.selectionStart);
  if (!/@(?:图\d*)?$/.test(before)) return closeCreativeMentions();
  menu.hidden = false;
  menu.innerHTML = creativeState.references.length ? creativeState.references.map((_file, index) => `<button onclick="insertCreativeMention(${index + 1})">@图${index + 1}<small>${creativeEsc(creativeState.references[index].name)}</small></button>`).join('') : '<div>请先上传参考图</div>';
}


function closeCreativeMentions() { const menu = document.getElementById('creative-mention-menu'); if (menu) menu.hidden = true; }
function insertCreativeMention(index) {
  const textarea = document.getElementById('creative-prompt');
  if (!textarea) return;
  const start = textarea.selectionStart;
  const before = textarea.value.slice(0, start).replace(/@(?:图\d*)?$/, '');
  const after = textarea.value.slice(start);
  textarea.value = `${before}@图${index} ${after}`;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = before.length + 4;
  creativeState.prompt = textarea.value;
  closeCreativeMentions();
}

async function loadCreativeOptions() {
  try {
    const result = await api('/api/creative/options');
    if (result.success) creativeState.presets = result.presets || {};
    updateCreativeResolutionOptions();
  } catch (error) { console.warn('创作设置读取失败:', error); }
}

async function openCreativeApiConfig() {
  let cfg = { baseUrl: '', apiKeyMasked: '', imageModel: 'gpt-image-2' };
  try { const result = await api('/api/creative/config'); if (result.success) cfg = result.config || cfg; } catch (_error) {}
  const overlay = document.createElement('div');
  overlay.id = 'creative-api-config-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
  overlay.innerHTML = `<div style="background:var(--pn);border:1px solid var(--bd);border-radius:14px;padding:24px 32px;max-width:420px;width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="font-size:16px;font-weight:800;color:var(--tx);margin-bottom:18px">创作生成接口设置</div><label style="display:block;font-size:11px;color:var(--t2);margin-bottom:4px">API Key（${cfg.hasKey ? '已设置' : '未设置'}）</label><input id="creative-config-key" type="text" placeholder="sk-..." value="${cfg.apiKeyMasked || ''}" onfocus="if(this.value==='${cfg.apiKeyMasked || ''}')this.value=''" style="width:100%;padding:8px 10px;font-size:12px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;font-family:monospace;margin-bottom:14px"><label style="display:block;font-size:11px;color:var(--t2);margin-bottom:4px">创作 API URL</label><input id="creative-config-url" type="text" placeholder="https://api.openlux.ai/v1" value="${cfg.baseUrl || ''}" style="width:100%;padding:8px 10px;font-size:12px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;font-family:monospace;margin-bottom:14px"><label style="display:block;font-size:11px;color:var(--t2);margin-bottom:4px">创作生图模型</label><select id="creative-config-image-model" style="width:100%;padding:8px 10px;font-size:12px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;margin-bottom:18px"><option value="gpt-image-2" ${cfg.imageModel === 'gpt-image-2' ? 'selected' : ''}>GPT Image 2.0</option><option value="gemini-3.1-flash-image-preview" ${cfg.imageModel === 'gemini-3.1-flash-image-preview' ? 'selected' : ''}>Gemini Flash</option><option value="gemini-3-pro-image" ${cfg.imageModel === 'gemini-3-pro-image' ? 'selected' : ''}>Gemini Pro</option></select><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn bd" onclick="document.getElementById('creative-api-config-overlay').remove()">取消</button><button class="btn bp" onclick="saveCreativeApiConfig()">保存</button></div></div>`;
  document.body.appendChild(overlay); overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
}

async function saveCreativeApiConfig() {
  const apiKey = document.getElementById('creative-config-key')?.value.trim() || '';
  const baseUrl = document.getElementById('creative-config-url')?.value.trim() || '';
  const imageModel = document.getElementById('creative-config-image-model')?.value.trim() || '';
  try { const result = await api('/api/creative/config', { apiKey, baseUrl, imageModel }); if (!result.success) return toast(result.error || '保存失败', 'ng'); toast('创作生成配置已独立保存', 'ok'); document.getElementById('creative-api-config-overlay')?.remove(); } catch (error) { toast('保存失败: ' + (error.message || ''), 'ng'); }
}

function creativePresetValue() {
  const selected = document.getElementById('creative-resolution')?.value;
  if (selected && creativeState.presets[selected]) return selected;
  const aspect = document.getElementById('creative-aspect')?.value || '16:9';
  return `${aspect}-1K`;
}

async function generateCreativeImage() {
  const button = document.getElementById('creative-generate-btn');
  const prompt = document.getElementById('creative-prompt')?.value.trim() || '';
  if (!prompt) return toast('请输入创作提示词', 'wn');
  if (button) { button.disabled = true; button.textContent = '生成中'; }
  const status = document.getElementById('creative-status');
  if (status) status.textContent = '正在生成，请稍候……';
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('preset', creativePresetValue());
  creativeState.references.forEach(file => form.append('references', file, file.name));
  try {
    const response = await fetch('/api/creative/generate', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '创作生成失败');
    const item = result.item;
    document.getElementById('creative-preview-body').innerHTML = `<img class="creative-result-image" src="${item.outputUrl}?t=${Date.now()}" alt="生成结果"><div class="creative-result-meta">${creativeEsc(item.resolution)} · ${item.width} × ${item.height}<a class="btn bs" href="${item.outputUrl}" download>下载图片</a></div>`;
    if (status) status.textContent = `生成完成：${item.width} × ${item.height}`;
    await loadCreativeHistory();
  } catch (error) {
    if (status) status.textContent = error.message;
    toast(error.message, 'ng');
  } finally { if (button) { button.disabled = false; button.textContent = '生成图片'; } }
}

async function loadCreativeHistory() {
  const list = document.getElementById('creative-history-list');
  if (!list) return;
  try {
    const result = await api('/api/creative/history');
    if (!result.success || !result.history.length) { list.innerHTML = '<div class="creative-preview-empty">暂无创作记录</div>'; return; }
    list.innerHTML = result.history.map(item => `<div class="creative-history-item" id="history-${creativeEsc(item.historyTimestamp || item.id)}" data-history-ts="${creativeEsc(item.historyTimestamp || item.id)}" onclick="showCreativeHistory('${creativeEsc(item.id)}')"><img src="${creativeEsc(item.outputUrl)}" alt="历史结果"><div><strong>${creativeEsc(item.resolution || '创作结果')}</strong><span>${item.width} × ${item.height}</span><small>${new Date(item.createdAt).toLocaleString('zh-CN')}</small></div></div>`).join('');
    window.__creativeHistory = result.history;
    window.HistoryBulkManager?.attach({ container: '#creative-history-list', onChanged: () => loadCreativeHistory() })?.refresh();
  } catch (error) { list.innerHTML = '<div class="creative-preview-empty">历史记录读取失败</div>'; }
}

function showCreativeHistory(id) {
  const item = (window.__creativeHistory || []).find(entry => entry.id === id);
  if (!item) return;
  document.getElementById('creative-preview-body').innerHTML = `<img class="creative-result-image" src="${item.outputUrl}" alt="历史结果"><div class="creative-result-meta">${creativeEsc(item.resolution)} · ${item.width} × ${item.height}<a class="btn bs" href="${item.outputUrl}" download>下载图片</a></div>`;
}

function switchToRecolorMode() {
  document.getElementById('sidebar')?.setAttribute('data-active-mode', 'recolor');
  document.body?.setAttribute('data-active-mode', 'recolor');
  document.body?.setAttribute('data-active-system', 'recolor');
  document.documentElement?.setAttribute('data-active-system', 'recolor');
  document.querySelectorAll('.sidebar-mode-link').forEach(link => link.classList.toggle('active', link.dataset.mode === 'recolor'));
}

function exitCreativeMode() {
  const main = document.getElementById('workspace-main');
  const inspector = document.querySelector('.right-inspector');
  if (main?.dataset.previousCreativeHtml) { main.innerHTML = main.dataset.previousCreativeHtml; delete main.dataset.previousCreativeHtml; }
  if (inspector?.dataset.previousCreativeHtml) { inspector.innerHTML = inspector.dataset.previousCreativeHtml; delete inspector.dataset.previousCreativeHtml; }
  main?.classList.remove('creative-mode-active');
  inspector?.classList.remove('creative-mode-active');
  updateScanButton();
  updateBottomBar(window.__currentBatch || null);
  fetchLogs();
  renderFilterBar();
  document.getElementById('sidebar')?.setAttribute('data-active-mode', 'recolor');
  document.body?.setAttribute('data-active-mode', 'recolor');
}
