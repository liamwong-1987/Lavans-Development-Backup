/**
 * storage.js — 持久化存储模块
 *
 * 优先 IndexedDB（大文件）+ localStorage（元数据/降级）
 * Web Crypto API AES-GCM 加密
 * 跨会话自动恢复
 */
const PersistentStore = (() => {
  const DB_NAME = 'recolor_store';
  const DB_VERSION = 2;
  const META_KEY = 'recolor_meta';

  let db = null;
  let cryptoKey = null;
  let useIndexedDB = true;

  // ============ 加密 ============
  const ENC_ALGO = { name: 'AES-GCM', length: 256 };
  const IV_LENGTH = 12;

  async function getCryptoKey() {
    if (cryptoKey) return cryptoKey;

    // 尝试从 localStorage 恢复
    const stored = localStorage.getItem('recolor_enc_key');
    if (stored) {
      try {
        const jwk = JSON.parse(stored);
        cryptoKey = await crypto.subtle.importKey('jwk', jwk, ENC_ALGO, false, ['encrypt', 'decrypt']);
        return cryptoKey;
      } catch (e) {}
    }

    // 生成新密钥
    cryptoKey = await crypto.subtle.generateKey(ENC_ALGO, true, ['encrypt', 'decrypt']);
    const jwk = await crypto.subtle.exportKey('jwk', cryptoKey);
    localStorage.setItem('recolor_enc_key', JSON.stringify(jwk));
    return cryptoKey;
  }

  async function encrypt(data) {
    const key = await getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, data
    );
    // 返回 iv + encrypted
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    return combined;
  }

  async function decrypt(combined) {
    const key = await getCryptoKey();
    const iv = combined.slice(0, IV_LENGTH);
    const data = combined.slice(IV_LENGTH);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  }

  // ============ IndexedDB ============
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('files')) {
          d.createObjectStore('files', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('state')) {
          d.createObjectStore('state', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => {
        console.warn('IndexedDB不可用，降级到localStorage');
        useIndexedDB = false;
        resolve(null);
      };
    });
  }

  function idbPut(storeName, data) {
    return new Promise((resolve, reject) => {
      if (!db || !useIndexedDB) return resolve(null);
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put(data);
        tx.oncomplete = () => resolve(true);
        tx.onerror = (e) => { reject(e); };
      } catch (e) { reject(e); }
    });
  }

  function idbGet(storeName, key) {
    return new Promise((resolve, reject) => {
      if (!db || !useIndexedDB) return resolve(null);
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => { reject(e); };
      } catch (e) { reject(e); }
    });
  }

  function idbClear(storeName) {
    return new Promise((resolve, reject) => {
      if (!db || !useIndexedDB) return resolve(null);
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = (e) => { reject(e); };
      } catch (e) { reject(e); }
    });
  }

  // ============ 存储文件 ============
  async function saveFile(type, fileName, fileBuffer) {
    const id = `${type}_${fileName}`;
    if (useIndexedDB) {
      try {
        const encrypted = await encrypt(fileBuffer);
        await idbPut('files', { id, type, name: fileName, data: encrypted, size: fileBuffer.byteLength, time: Date.now() });
        return;
      } catch (e) {
        // 尝试估算容量
        if (e.name === 'QuotaExceededError' || e.message?.includes('quota')) {
          console.warn('存储空间不足，文件将不持久化');
        }
      }
    }
    // 降级到 localStorage（仅小文件 < 10KB）
    if (fileBuffer.byteLength < 10240) {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(fileBuffer)));
      localStorage.setItem(`recolor_file_${id}`, b64);
    }
  }

  async function loadFile(type, fileName) {
    const id = `${type}_${fileName}`;
    if (useIndexedDB) {
      try {
        const record = await idbGet('files', id);
        if (record?.data) {
          const decrypted = await decrypt(record.data);
          return new Blob([decrypted], { type: 'image/jpeg' });
        }
      } catch (e) {}
    }
    // 降级
    const b64 = localStorage.getItem(`recolor_file_${id}`);
    if (b64) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: 'image/jpeg' });
    }
    return null;
  }

  async function listFiles(type) {
    const files = [];
    if (useIndexedDB) {
      try {
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const req = store.getAll();
        await new Promise((resolve, reject) => {
          req.onsuccess = () => { files.push(...req.result.filter(r => r.type === type)); resolve(); };
          req.onerror = reject;
        });
      } catch (e) {}
    }
    // 降级：扫描 localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`recolor_file_${type}_`)) {
        files.push({ name: key.replace(`recolor_file_${type}_`, '') });
      }
    }
    return files;
  }

  // ============ 存储状态/元数据 ============
  async function saveState(state) {
    const data = { ...state, savedAt: new Date().toISOString() };
    if (useIndexedDB) {
      await idbPut('state', { key: META_KEY, data });
    }
    // 同时存localStorage作为备份
    localStorage.setItem(META_KEY, JSON.stringify(data));
  }

  async function loadState() {
    // 优先从IndexedDB读
    if (useIndexedDB) {
      try {
        const record = await idbGet('state', META_KEY);
        if (record?.data) return record.data;
      } catch (e) {}
    }
    // 降级
    try {
      const stored = localStorage.getItem(META_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  }

  // ============ 清除 ============
  async function clearAll() {
    if (useIndexedDB) {
      await idbClear('files');
      await idbClear('state');
    }
    // 清除localStorage中相关项
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('recolor_')) toRemove.push(key);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  }

  // ============ 存储空间检查 ============
  async function getStorageInfo() {
    if (!useIndexedDB) return { available: 'localStorage only', used: 'N/A' };
    try {
      const estimate = await navigator.storage?.estimate();
      if (estimate) {
        return {
          used: (estimate.usage / 1024 / 1024).toFixed(1) + ' MB',
          quota: (estimate.quota / 1024 / 1024).toFixed(1) + ' MB',
          percent: ((estimate.usage / estimate.quota) * 100).toFixed(1) + '%'
        };
      }
    } catch (e) {}
    return { available: '正常' };
  }

  // ============ 初始化 ============
  async function init() {
    await openDB();
    console.log('[Store] 初始化完成, IndexedDB:', useIndexedDB);
    const info = await getStorageInfo();
    console.log('[Store] 存储信息:', info);
  }

  return { init, saveFile, loadFile, listFiles, saveState, loadState, clearAll, getStorageInfo, isReady: () => useIndexedDB || true };
})();
