/* Lavans Canvas Adapter
 * Keeps Smart Canvas core independent from Lavans business services.
 * This file is a boundary contract only; it does not alter the reference core.
 */
(function attachLavansCanvasAdapter(global) {
  const API = '/api/canvas';

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error || payload.message || `Canvas request failed: ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  const adapter = {
    name: 'lavans-canvas-adapter',
    version: '1.0.0',
    capabilities: {
      config: true,
      workspace: true,
      history: true,
      assets: true,
      generation: true,
      taskPolling: true,
      taskCancel: true,
      providers: [],
      reservedProviders: ['comfyui', 'runninghub', 'codex-cli', 'agent-cli', 'gemini-cli', 'jimeng-cli', 'midjourney', 'modelscope'],
      collaboration: false,
      cloudSync: false
    },

    fetch(path, options = {}) {
      return fetch(`${API}${String(path || '')}`, {
        credentials: 'same-origin',
        ...options
      });
    },

    getConfig() {
      return request('/config');
    },

    saveConfig(config) {
      return request('/config', { method: 'POST', body: JSON.stringify(config || {}) });
    },

    getWorkspace(canvasId = '', projectId = '') {
      const query = new URLSearchParams();
      if (canvasId) query.set('canvasId', canvasId);
      if (projectId) query.set('projectId', projectId);
      return request(`/workspace${query.toString() ? `?${query.toString()}` : ''}`);
    },

    saveWorkspace(workspace, reason = 'smart-canvas', canvasId = '', projectId = '', kind = 'smart') {
      const value = workspace || {};
      return request('/workspace', { method: 'PUT', body: JSON.stringify({ workspace: value, reason, canvasId, projectId, kind, base_updated_at: Number(value.updated_at || 0) }) });
    },

    getHistory() {
      return request('/history');
    },

    getAssetLibrary() {
      return request('/assets-library');
    },

    createAssetCategory(payload) {
      return request('/assets-library/categories', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    renameAssetCategory(categoryId, payload) {
      return request(`/assets-library/categories/${encodeURIComponent(categoryId)}`, { method: 'PATCH', body: JSON.stringify(payload || {}) });
    },

    deleteAssetCategory(categoryId) {
      return request(`/assets-library/categories/${encodeURIComponent(categoryId)}`, { method: 'DELETE' });
    },

    addAssetLibraryItem(payload) {
      return request('/assets-library/items', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    renameAssetLibraryItem(itemId, payload) {
      return request(`/assets-library/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: JSON.stringify(payload || {}) });
    },

    deleteAssetLibraryItem(itemId) {
      return request(`/assets-library/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
    },

    getLocalAssets() {
      return request('/local-assets');
    },

    uploadLocalAssets(formData) {
      return request('/local-assets/upload', { method: 'POST', body: formData });
    },

    importLocalAssetUrls(payload) {
      return request('/local-assets/import-urls', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    createLocalAssetFolder(payload) {
      return request('/local-assets/folders', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    renameLocalAssetFolder(payload) {
      return request('/local-assets/folders', { method: 'PATCH', body: JSON.stringify(payload || {}) });
    },

    renameLocalAssetItem(payload) {
      return request('/local-assets/items', { method: 'PATCH', body: JSON.stringify(payload || {}) });
    },

    deleteLocalAssets(payload) {
      return request('/local-assets/delete', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    moveLocalAssets(payload) {
      return request('/local-assets/move', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    generateLocalAssetCaption(payload) {
      return request('/local-assets/caption', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    classifyLocalAssets(payload) {
      return request('/local-assets/classify', { method: 'POST', body: JSON.stringify(payload || {}) });
    },

    saveLocalAssetCaption(payload) {
      return request('/local-assets/caption', { method: 'PATCH', body: JSON.stringify(payload || {}) });
    },

    uploadAsset(formData) {
      return request('/assets', { method: 'POST', body: formData });
    },

    createTask(task) {
      return request('/tasks', { method: 'POST', body: JSON.stringify(task || {}) });
    },

    generate(task) {
      return this.createTask(task);
    },

    uploadFiles(files) {
      const formData = new FormData();
      [...(files || [])].forEach(file => formData.append('files', file, file.name || 'media'));
      return this.uploadAsset(formData);
    },

    getTask(taskId) {
      return request(`/tasks/${encodeURIComponent(taskId)}`);
    },

    cancelTask(taskId) {
      return request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '{}' });
    },

    isReservedProvider(providerId) {
      return this.capabilities.reservedProviders.includes(String(providerId || '').toLowerCase());
    }
  };

  global.LavansCanvasAdapter = Object.freeze(adapter);
})(window);
