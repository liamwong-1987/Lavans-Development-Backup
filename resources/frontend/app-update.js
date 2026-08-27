(function () {
  const state = { currentVersion: '', available: null, checking: false, applying: false };
  const byId = id => document.getElementById(id);

  async function responseJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  function setBusy(busy, message = '') {
    state.checking = busy && !state.applying;
    const button = byId('app-update-button');
    const confirm = byId('app-update-confirm');
    const cancel = byId('app-update-cancel');
    const close = byId('app-update-close');
    if (button) button.disabled = busy;
    if (confirm) confirm.disabled = busy;
    if (cancel) cancel.disabled = state.applying;
    if (close) close.disabled = state.applying;
    if (message) byId('app-update-status').textContent = message;
  }

  function updateVersionLabel(version) {
    state.currentVersion = version || state.currentVersion;
    const label = byId('app-update-label');
    const button = byId('app-update-button');
    if (label) label.textContent = state.currentVersion ? `版本 v${state.currentVersion}` : '版本 --';
    if (button) button.title = state.available?.updateAvailable
      ? `发现 Lavans ${state.available.latestVersion}`
      : `当前版本 ${state.currentVersion || '--'}，点击检查更新`;
  }

  function renderDialog(result) {
    const available = Boolean(result?.updateAvailable);
    const dialog = byId('app-update-dialog');
    const notes = byId('app-update-notes');
    const confirm = byId('app-update-confirm');
    byId('app-update-title').textContent = available ? (result.title || `Lavans ${result.latestVersion}`) : '已经是最新版本';
    byId('app-update-summary').textContent = available
      ? `当前版本 v${result.currentVersion}，可更新到 v${result.latestVersion}。程序会先校验并备份，失败时自动恢复。`
      : `当前版本 v${result?.currentVersion || state.currentVersion || '--'}，暂时没有更高版本。`;
    notes.replaceChildren();
    for (const item of Array.isArray(result?.notes) ? result.notes : []) {
      const row = document.createElement('li');
      row.textContent = item;
      notes.appendChild(row);
    }
    notes.hidden = notes.childElementCount === 0;
    confirm.hidden = !available;
    byId('app-update-status').textContent = available ? '更新前不会修改任何文件。' : '';
    if (!dialog.open) dialog.showModal();
  }

  async function loadStatus() {
    try {
      const result = await responseJson('/api/app-update/status');
      updateVersionLabel(result.currentVersion);
    } catch (_error) {
      updateVersionLabel('');
    }
  }

  async function checkUpdate(options = {}) {
    if (state.checking || state.applying) return null;
    setBusy(true, options.silent ? '' : '正在检查 Lavans GitHub…');
    try {
      const result = await responseJson('/api/app-update/check');
      state.available = result;
      updateVersionLabel(result.currentVersion);
      byId('app-update-dot').hidden = !result.updateAvailable;
      if (!options.silent) renderDialog(result);
      return result;
    } catch (error) {
      if (!options.silent) {
        renderDialog({ updateAvailable: false, currentVersion: state.currentVersion });
        byId('app-update-title').textContent = '暂时无法检查更新';
        byId('app-update-summary').textContent = error.message || '网络不可用，请稍后重试。';
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    if (state.applying) return;
    const dialog = byId('app-update-dialog');
    if (dialog?.open) dialog.close();
  }

  async function applyUpdate() {
    const candidate = state.available;
    if (state.applying || !candidate?.updateAvailable) return;
    state.applying = true;
    setBusy(true, '正在下载、校验并备份，请勿关闭 Lavans…');
    try {
      const result = await responseJson('/api/app-update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitSha: candidate.commitSha, version: candidate.latestVersion })
      });
      byId('app-update-status').textContent = `已安全更新到 v${result.version}，正在重新启动…`;
      byId('app-update-confirm').hidden = true;
      const restarted = await window.lavansUpdater?.restart?.();
      if (!restarted) {
        state.applying = false;
        setBusy(false, '更新已完成，请手动关闭并重新打开 Lavans。');
      }
    } catch (error) {
      state.applying = false;
      setBusy(false, `更新未完成：${error.message || '未知错误'}`);
    }
  }

  function initialize() {
    byId('app-update-button')?.addEventListener('click', async () => {
      if (state.available?.updateAvailable) renderDialog(state.available);
      else await checkUpdate();
    });
    byId('app-update-close')?.addEventListener('click', closeDialog);
    byId('app-update-cancel')?.addEventListener('click', closeDialog);
    byId('app-update-confirm')?.addEventListener('click', applyUpdate);
    byId('app-update-dialog')?.addEventListener('cancel', event => {
      if (state.applying) event.preventDefault();
    });
    void loadStatus().then(() => setTimeout(() => { void checkUpdate({ silent: true }); }, 1200));
  }

  document.addEventListener('DOMContentLoaded', initialize, { once: true });
})();
