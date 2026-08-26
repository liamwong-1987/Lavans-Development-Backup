(function () {
  'use strict';

  const PAGE_BY_FILE = Object.freeze({
    'index.html': 'shell',
    'recolor.html': 'recolor',
    'text-studio.html': 'text-studio',
    'enhance.html': 'enhance',
    'klein.html': 'klein',
    'angle.html': 'angle',
    'online-studio.html': 'online-studio',
    'gpt-chat.html': 'gpt-chat',
    'canvas-list.html': 'canvas-list',
    'canvas.html': 'canvas',
    'asset-manager.html': 'asset-manager',
    'canvas-api-settings.html': 'api-settings',
    'comfyui-settings.html': 'comfyui-settings',
    'smart-canvas.html': 'smart-canvas'
  });

  function inferPageId() {
    const pathname = String(window.location.pathname || '/').replace(/\\/g, '/');
    if (pathname === '/' || pathname === '') return 'shell';
    const fileName = pathname.split('/').filter(Boolean).pop() || 'index.html';
    return PAGE_BY_FILE[fileName] || fileName.replace(/\.html?$/i, '') || 'unknown';
  }

  function installPageIdentity() {
    const pageId = inferPageId();
    document.documentElement.dataset.lanvasUi = 'true';
    document.body.dataset.lanvasPage = pageId;
    document.body.classList.add('lanvas-ui');
    return pageId;
  }

  const ICONS = {
    '本地功能': '<path class="phosphor-tone" d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5V18H3z"/><path d="M3 9.5A2.5 2.5 0 0 1 5.5 7H19a2 2 0 0 1 2 2v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    '文生图': '<rect class="phosphor-tone" x="3" y="4" width="18" height="16" rx="3"/><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
    '细节增强': '<path class="phosphor-tone" d="m13 2-9 12h7l-1 8 10-13h-7z"/><path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
    '图片编辑': '<path class="phosphor-tone" d="m15 5 4 4-10 10H5v-4z"/><path d="m14 6 4 4M5 19h4L20 8a2.8 2.8 0 0 0-4-4L5 15z"/>',
    '角度控制': '<path class="phosphor-tone" d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
    '在线生图': '<circle class="phosphor-tone" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"/>',
    'GPT 对话': '<path class="phosphor-tone" d="M4 5h16v12H8l-4 4z"/><path d="M4 5h16v12H8l-4 4z"/><path d="M8 9h8M8 13h5"/>',
    '无限画布': '<rect class="phosphor-tone" x="3" y="3" width="7" height="7" rx="1.5"/><rect class="phosphor-tone" x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    '素材库': '<path class="phosphor-tone" d="M5 4h13v16H5z"/><path d="M5 4h13v16H5zM8 4v16M11 8h4M11 12h4"/>',
    '一键复色': '<circle class="phosphor-tone" cx="9" cy="15" r="6"/><circle class="phosphor-tone" cx="15" cy="9" r="6"/><circle cx="9" cy="15" r="6"/><circle cx="15" cy="9" r="6"/><path d="M12 12h.01"/>',
    'API 设置': '<path class="phosphor-tone" d="M8 7h8v10H8z"/><path d="M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/>',
    '更多设置': '<circle class="phosphor-tone" cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.8-1.9.9-1.9-2.1-2.1-1.9.9-1.9-.8-.7-2h-3l-.7 2-1.9.8L5 3.9 2.9 6l.9 1.9L3 9.8l-2 .7v3l2 .7.8 1.9-.9 1.9 2.1 2.1 1.9-.9 1.9.8.7 2h3l.7-2 1.9-.8 1.9.9 2.1-2.1-.9-1.9.8-1.9z"/>',
    '语言': '<path class="phosphor-tone" d="M4 5h9v9H4z"/><path d="M4 5h9M8.5 3v2M6 8h5M5 13c3-1 5-4 6-7M8 8c1 3 3 5 5 6M14 10l4 11M21 21l-4-11M15.5 17h4"/>',
    '工作流设置': '<circle class="phosphor-tone" cx="6" cy="6" r="3"/><circle class="phosphor-tone" cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h4a3 3 0 0 1 3 3v6M15 12l3 3 3-3"/>',
    '项目主页': '<path class="phosphor-tone" d="m3 11 9-8 9 8v10H3z"/><path d="m3 11 9-8 9 8v10H3zM9 21v-6h6v6"/>'
  };

  function normalizeLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }


  function replaceGlobalNavIcons() {
    document.querySelectorAll('.nav-item, .side-pill, .nav-fold-toggle').forEach((item) => {
      const labelNode = item.querySelector('.nav-text, .side-pill-text');
      const label = normalizeLabel(labelNode ? labelNode.textContent : item.title);
      const markup = ICONS[label];
      if (!markup) return;
      const oldIcon = item.querySelector('svg:not(.settings-fold-chevron)');
      if (!oldIcon) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', 'phosphor-icon');
      svg.innerHTML = markup;
      oldIcon.replaceWith(svg);
    });
  }

  function installAttribution() {
    const actions = document.querySelector('.side-actions');
    if (!actions || actions.querySelector('.lanvas-attribution')) return;
    const placeholder = Array.from(actions.querySelectorAll('.side-pill')).find((node) => normalizeLabel(node.title) === 'Lavans' || normalizeLabel(node.textContent) === 'Lavans');
    const link = document.createElement('a');
    link.className = 'lanvas-attribution';
    link.href = 'https://github.com/hero8152/Infinite-Canvas';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Infinite Canvas by hero8152';
    link.innerHTML = '<span>改自大雄画布，致敬原作</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.55 9.55 0 0 1 12 6.84c.85 0 1.71.11 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>';
    if (placeholder) placeholder.replaceWith(link); else actions.appendChild(link);
  }

  function classifyPrimaryActions(root) {
    const exact = new Set([
      '一键生成', '检查设置并生成', '确认设置并开始生成', '开始执行',
      '进入可视执行工作台', '本地生成', '开始重制', '生成新角度',
      '一键生图', '继续生成'
    ]);
    root.querySelectorAll('button, [role="button"]').forEach((button) => {
      const label = normalizeLabel(button.textContent || button.getAttribute('aria-label') || button.title);
      if (exact.has(label)) button.classList.add('lanvas-primary');
    });
  }

  function installPageComponents(pageId, root = document) {
    const selectorsByPage = {
      'text-studio': ['.text-generate-btn'],
      'enhance': ['.glass-btn'],
      'klein': ['.glass-btn'],
      'angle': ['.glass-btn'],
      'online-studio': ['.online-generate-btn', '.glass-btn'],
      'gpt-chat': ['.rail-new', '.system-prompt-actions .primary'],
      'canvas-list': ['.ws-primary-btn'],
      'asset-manager': [
        '.asset-btn.primary', '.asset-icon-btn.primary',
        '.head-inline-edit button.primary', '.tree-inline-edit button.primary'
      ]
    };
    (selectorsByPage[pageId] || []).forEach((selector) => {
      if (root instanceof Element && root.matches(selector)) root.classList.add('lanvas-primary');
      root.querySelectorAll?.(selector).forEach((node) => node.classList.add('lanvas-primary'));
    });
  }

  function applyUnifiedTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    const dark = next === 'dark';
    document.documentElement.classList.toggle('studio-theme-dark', dark);
    document.documentElement.classList.toggle('theme-dark', dark);
    if (document.body) {
      document.body.classList.toggle('studio-theme-dark', dark);
      document.body.classList.toggle('theme-dark', dark);
    }
    try {
      localStorage.setItem('studio_theme', next);
      localStorage.setItem('canvas_theme', next);
    } catch (_) {}
    document.querySelectorAll('.stage iframe, iframe.active').forEach((frame) => {
      try { frame.contentWindow?.postMessage({ type: 'studio-theme', theme: next }, '*'); } catch (_) {}
    });
    window.dispatchEvent(new CustomEvent('studio-theme-change', { detail: { theme: next } }));
  }

  function installThemeBridge() {
    const button = document.getElementById('theme-toggle-btn');
    if (!button || button.dataset.lanvasThemeBound === 'true') return;
    button.dataset.lanvasThemeBound = 'true';
    button.removeAttribute('onclick');
    button.addEventListener('click', () => {
      let current = 'light';
      try {
        current = window.StudioTheme?.get?.()
          || localStorage.getItem('studio_theme')
          || localStorage.getItem('canvas_theme')
          || (document.documentElement.classList.contains('studio-theme-dark') ? 'dark' : 'light');
      } catch (_) {
        current = document.documentElement.classList.contains('studio-theme-dark') ? 'dark' : 'light';
      }
      const next = current === 'dark' ? 'light' : 'dark';
      if (window.StudioTheme?.set) window.StudioTheme.set(next);
      applyUnifiedTheme(next);
    });
  }

  function boot() {
    const pageId = installPageIdentity();
    if (pageId === 'shell') {
      replaceGlobalNavIcons();
      installAttribution();
      installThemeBridge();
    }
    installPageComponents(pageId);
    classifyPrimaryActions(document);
    const observer = new MutationObserver((entries) => {
      entries.forEach((entry) => entry.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        installPageComponents(pageId, node);
        classifyPrimaryActions(node.matches('button,[role="button"]') ? node.parentElement || node : node);
      }));
    });
    if (document.body instanceof Node) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    window.dispatchEvent(new CustomEvent('lanvas-ui-ready', { detail: { pageId } }));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
