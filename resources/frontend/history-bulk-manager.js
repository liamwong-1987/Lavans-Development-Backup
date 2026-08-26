(function () {
  'use strict';

  const STYLE_ID = 'lavans-history-bulk-manager-style';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .hbm-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:8px 0 10px; }
      .hbm-toolbar .hbm-spacer { flex:1; }
      .hbm-count { color:var(--t2, #94a3b8); font-size:12px; white-space:nowrap; }
      .hbm-btn { min-height:30px; padding:5px 10px; border:1px solid var(--bd, #334155); border-radius:7px; background:var(--pn, #172033); color:var(--tx, #e5edf9); cursor:pointer; font:inherit; font-size:12px; }
      .hbm-btn:hover { border-color:var(--bl, #4f8cff); }
      .hbm-btn:disabled { opacity:.48; cursor:not-allowed; }
      .hbm-btn.hbm-danger { color:#fff; background:#b91c1c; border-color:#dc2626; }
      .hbm-hide { display:none !important; }
      body.history-bulk-selecting [data-history-ts] { position:relative; cursor:pointer !important; }
      body.history-bulk-selecting [data-history-ts]::after { content:''; position:absolute; left:8px; top:8px; width:18px; height:18px; border:2px solid #fff; border-radius:50%; background:rgba(15,23,42,.52); box-shadow:0 1px 5px rgba(0,0,0,.45); pointer-events:none; z-index:4; }
      body.history-bulk-selecting [data-history-ts].hbm-selected::after { content:'✓'; display:grid; place-items:center; background:#2563eb; border-color:#93c5fd; color:#fff; font-weight:800; font-size:13px; }
      body.history-bulk-selecting [data-history-ts].hbm-selected { outline:2px solid #60a5fa; outline-offset:-2px; }
    `;
    document.head.appendChild(style);
  }

  function attach(options) {
    const opts = options || {};
    const container = document.querySelector(opts.container);
    if (!container || container.dataset.hbmAttached === '1') return container && container._hbm;
    injectStyles();
    container.dataset.hbmAttached = '1';
    let selecting = false;

    const toolbar = document.createElement('div');
    toolbar.className = 'hbm-toolbar';
    const manage = document.createElement('button');
    manage.type = 'button'; manage.className = 'hbm-btn'; manage.textContent = '管理历史';
    const spacer = document.createElement('span'); spacer.className = 'hbm-spacer';
    const count = document.createElement('span'); count.className = 'hbm-count hbm-hide';
    const selectAll = document.createElement('button');
    selectAll.type = 'button'; selectAll.className = 'hbm-btn hbm-hide';
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'hbm-btn hbm-danger hbm-hide';
    const exit = document.createElement('button');
    exit.type = 'button'; exit.className = 'hbm-btn hbm-hide'; exit.textContent = '退出管理';
    toolbar.append(manage, spacer, count, selectAll, remove, exit);
    container.parentNode.insertBefore(toolbar, container);

    const cards = () => Array.from(container.querySelectorAll('[data-history-ts]'));
    const selected = () => cards().filter(card => card.classList.contains('hbm-selected'));
    function refresh() {
      const all = cards(); const picked = selected(); const allSelected = all.length > 0 && all.length === picked.length;
      count.textContent = `已选 ${picked.length} 项`;
      selectAll.textContent = allSelected ? '取消全选' : '全选';
      remove.textContent = picked.length ? `删除选中（${picked.length}）` : '删除选中';
      remove.disabled = picked.length === 0;
    }
    function enter() {
      selecting = true; document.body.classList.add('history-bulk-selecting');
      manage.classList.add('hbm-hide'); [count, selectAll, remove, exit].forEach(node => node.classList.remove('hbm-hide')); refresh();
    }
    function leave() {
      selecting = false; document.body.classList.remove('history-bulk-selecting'); cards().forEach(card => card.classList.remove('hbm-selected'));
      manage.classList.remove('hbm-hide'); [count, selectAll, remove, exit].forEach(node => node.classList.add('hbm-hide')); refresh();
    }
    async function deleteSelected() {
      const picked = selected();
      if (!picked.length || !window.confirm(`确认删除选中的 ${picked.length} 条历史记录？对应的本地输出文件也会被删除。`)) return;
      remove.disabled = true; remove.textContent = '正在删除…';
      const results = await Promise.allSettled(picked.map(card => fetch('/api/canvas/image-history/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.dataset.historyTs })
      }).then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.success) throw new Error(body.error || '删除失败');
        card.remove();
      })));
      const failed = results.filter(result => result.status === 'rejected').length;
      if (failed) window.alert(`${failed} / ${picked.length} 条记录删除失败；未成功的记录已保留。`);
      if (!cards().length) leave(); else refresh();
      if (typeof opts.onChanged === 'function') opts.onChanged({ deleted: picked.length - failed, failed });
    }

    manage.addEventListener('click', enter);
    exit.addEventListener('click', leave);
    selectAll.addEventListener('click', () => { const all = cards(); const select = !all.length || selected().length !== all.length; all.forEach(card => card.classList.toggle('hbm-selected', select)); refresh(); });
    remove.addEventListener('click', deleteSelected);
    container.addEventListener('click', event => {
      if (!selecting) return;
      const card = event.target.closest('[data-history-ts]');
      if (!card || !container.contains(card)) return;
      event.preventDefault(); event.stopPropagation(); card.classList.toggle('hbm-selected'); refresh();
    }, true);
    const api = { enter, exit: leave, refresh, isSelecting: () => selecting };
    container._hbm = api;
    return api;
  }

  window.HistoryBulkManager = { attach };
})();
