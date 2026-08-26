const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

// 素材库管理（asset-manager）辅助接口：画布资产 / 共享文件夹 / 存储设置 / 存储文件 / 分类提示词 / AI 上传。
// 路径与源端 main.py 保持一致（/api/canvas-assets、/api/shared-folders、/api/storage-settings、/api/storage-files、/api/asset-classification-prompt、/api/ai/upload），前端 asset-manager.js 原样调用。
module.exports = function assetManagerRoutes() {
  const router = express.Router();
  const publicError = (res, statusCode, message) => res.status(statusCode).json({ success: false, error: message });
  const backendRoot = path.resolve(__dirname, '..');
  const projectRoot = path.resolve(__dirname, '..', '..');
  const uploadRoot = path.join(backendRoot, 'uploads', 'canvas');
  const outputRoot = path.join(backendRoot, 'output', 'canvas');
  const canvasesRoot = path.join(outputRoot, 'canvases');
  const libraryRoot = path.join(outputRoot, 'library');
  const localAssetRoot = path.join(uploadRoot, 'local-library');
  const dataRoot = libraryRoot;
  [uploadRoot, outputRoot, canvasesRoot, libraryRoot, localAssetRoot, dataRoot].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

  const storageSettingsPath = path.join(dataRoot, 'storage_settings.json');
  const sharedFoldersPath = path.join(dataRoot, 'shared_folders.json');
  const classificationPromptPath = path.join(dataRoot, 'asset_classification_prompt.txt');
  const assetLibraryPath = path.join(libraryRoot, 'asset-library.json');

  const readJson = (filePath, fallback) => { try { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback; } catch (_error) { return fallback; } };
  const writeJson = (filePath, value) => { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); };
  const text = (value, limit = 12000) => String(value || '').trim().slice(0, limit);
  const safeName = value => String(value || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 160) || 'file';

  const DEFAULT_STORAGE_DIRS = { upload: uploadRoot, generated: outputRoot, local: localAssetRoot };
  const STORAGE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
  const SHARED_MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.mp4', '.webm', '.mov', '.m4v', '.mkv', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

  const ASSET_CLASSIFICATION_PROMPT_DEFAULT = '请识别这张图片，输出严格 JSON，不要 Markdown，不要解释。结构为 {"summary":"一句话描述","categories":{"environment":[],"scene":[],"space":[],"subject":[],"model":[],"people":[],"style":[],"lighting":[],"color":[],"composition":[],"mood":[],"use_case":[],"objects":[],"materials":[],"quality":[]},"tags":[]}。每个数组最多8项，tags最多20项，不确定就省略。';

  const uploadAny = multer({
    storage: multer.memoryStorage(),
    limits: { files: 100, fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, done) => done(null, true)
  });

  // ===== 1. 存储设置 =====
  function loadStorageSettings() {
    const raw = readJson(storageSettingsPath, {});
    const dirs = {};
    for (const [key, fallback] of Object.entries(DEFAULT_STORAGE_DIRS)) {
      const configured = String(raw?.[key] || '').trim();
      dirs[key] = configured ? path.resolve(configured) : path.resolve(fallback);
    }
    return { dirs };
  }
  router.get('/api/storage-settings', (_req, res) => {
    const settings = loadStorageSettings();
    const defaults = {};
    for (const [key, value] of Object.entries(DEFAULT_STORAGE_DIRS)) defaults[key] = path.resolve(value);
    res.json({ dirs: settings.dirs, defaults });
  });
  router.patch('/api/storage-settings', (req, res) => {
    const dirs = {};
    for (const [key, fallback] of Object.entries(DEFAULT_STORAGE_DIRS)) {
      const configured = String((req.body || {})[key] || '').trim();
      dirs[key] = configured ? path.resolve(configured) : path.resolve(fallback);
      fs.mkdirSync(dirs[key], { recursive: true });
    }
    writeJson(storageSettingsPath, dirs);
    res.json({ dirs });
  });

  // ===== 2. 分类提示词 =====
  function loadClassificationPrompt() {
    try {
      if (fs.existsSync(classificationPromptPath)) {
        const stored = fs.readFileSync(classificationPromptPath, 'utf8').trim();
        if (stored) return stored;
      }
    } catch (_error) {}
    return ASSET_CLASSIFICATION_PROMPT_DEFAULT;
  }
  router.get('/api/asset-classification-prompt', (_req, res) => {
    const current = loadClassificationPrompt();
    res.json({ prompt: current, default_prompt: ASSET_CLASSIFICATION_PROMPT_DEFAULT, custom: current.trim() !== ASSET_CLASSIFICATION_PROMPT_DEFAULT.trim() });
  });
  router.patch('/api/asset-classification-prompt', (req, res) => {
    const prompt = text((req.body || {}).prompt, 20000) || '';
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(classificationPromptPath, prompt, 'utf8');
    res.json({ prompt, custom: true });
  });

  // ===== 3. 存储文件 =====
  function storageKindDir(kind) {
    const key = String(kind || '').trim().toLowerCase();
    if (key === 'upload') return uploadRoot;
    if (key === 'generated') return outputRoot;
    if (key === 'local') return localAssetRoot;
    return null;
  }
  function storageFilePath(kind, rel) {
    const root = storageKindDir(kind);
    if (!root) return null;
    const relPath = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relPath || relPath === '.' || relPath === '..' || relPath.startsWith('../') || path.isAbsolute(relPath)) return null;
    const absolute = path.resolve(root, relPath);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
    return fs.existsSync(absolute) ? absolute : null;
  }
  function storageFileItem(kind, root, absolute) {
    const rel = path.relative(root, absolute).replace(/\\/g, '/');
    try { const stat = fs.statSync(absolute); return { id: `${kind}:${rel}`, kind, rel, name: path.basename(absolute), folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), url: `/api/storage-files/${kind}/${rel.split('/').map(encodeURIComponent).join('/')}`, size: stat.size, created_at: Math.floor(stat.mtimeMs / 1000) }; } catch (_error) { return null; }
  }
  router.get('/api/storage-files', (req, res) => {
    const kind = String(req.query.kind || 'generated').trim().toLowerCase();
    const root = storageKindDir(kind);
    if (!root) return publicError(res, 404, '未知存储目录');
    fs.mkdirSync(root, { recursive: true });
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.max(20, Math.min(200, Number(req.query.limit) || 80));
    const items = [];
    const walk = current => {
      try {
        fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(entry => {
          if (entry.name.startsWith('.')) return;
          const absolute = path.join(current, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else if (STORAGE_IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) { const item = storageFileItem(kind, root, absolute); if (item) items.push(item); }
        });
      } catch (_error) {}
    };
    walk(root);
    items.sort((a, b) => b.created_at - a.created_at);
    const total = items.length;
    const pageItems = items.slice(offset, offset + limit);
    res.json({ kind, root, items: pageItems, total, offset, limit, has_more: offset + pageItems.length < total });
  });
  router.get('/api/storage-files/:kind/*', (req, res) => {
    const absolute = storageFilePath(req.params.kind, req.params[0] || '');
    if (!absolute || !fs.statSync(absolute).isFile()) return publicError(res, 404, '文件不存在');
    res.sendFile(absolute);
  });
  router.post('/api/storage-files/delete', (req, res) => {
    const kind = String((req.body || {}).kind || '').trim();
    const rels = (Array.isArray((req.body || {}).items) ? (req.body || {}).items : []).map(item => String(item || '').trim()).filter(Boolean);
    if (!rels.length) return publicError(res, 400, '请选择要删除的文件');
    let removed = 0;
    rels.forEach(rel => {
      const absolute = storageFilePath(kind, rel);
      if (!absolute || !fs.existsSync(absolute)) return;
      try { fs.unlinkSync(absolute); } catch (_error) { /* safe-delete 回收站失败时可能已删除，下面按真实文件状态判定 */ }
      if (!fs.existsSync(absolute)) removed += 1;
    });
    res.json({ removed });
  });

  // ===== 4. 画布资产 =====
  function canvasRecord(data) {
    return { id: data?.id, title: data?.title || '未命名画布', kind: data?.kind || 'classic', owner: String(data?.owner || '').slice(0, 40), pinned: Boolean(data?.pinned), project: String(data?.project || '').trim() || 'default', created_at: Number(data?.created_at) || 0, updated_at: Number(data?.updated_at) || 0, deleted_at: Number(data?.deleted_at) || 0, node_count: Array.isArray(data?.nodes) ? data.nodes.length : 0 };
  }
  function canvasAssetUrlValue(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of ['url', 'path', 'src', 'uri', 'output', 'output_url', 'outputUrl', 'video', 'video_url', 'videoUrl']) { const t = String(value[key] || '').trim(); if (t) return t; }
    }
    return '';
  }
  function canvasAssetDownloadableUrl(url) {
    const t = String(url || '').trim();
    return /^(\/canvas-assets\/|\/canvas-output\/|https?:\/\/)/i.test(t) ? t : '';
  }
  function canvasAssetKind(value, url) {
    let explicit = '';
    if (value && typeof value === 'object' && !Array.isArray(value)) explicit = String(value.kind || value.mediaKind || value.type || '').toLowerCase();
    if (explicit.includes('video')) return 'video';
    if (explicit.includes('audio')) return 'audio';
    if (explicit.includes('text')) return 'text';
    if (explicit.includes('workflow')) return 'workflow';
    const ext = path.extname(String(url || '').split('?')[0]).toLowerCase();
    if (['.mp4', '.webm', '.mov', '.m4v', '.mkv'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)) return 'audio';
    return 'image';
  }
  function canvasAssetName(value, url, fallback) {
    if (value && typeof value === 'object' && !Array.isArray(value)) { for (const key of ['name', 'filename', 'file', 'title']) { const n = String(value[key] || '').trim(); if (n) return safeName(n); } }
    return safeName(path.basename(String(url || '').split('?')[0]) || fallback);
  }
  function* iterCanvasAssetValues(value, nodePath = '') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const url = canvasAssetDownloadableUrl(canvasAssetUrlValue(value));
      if (url) yield [nodePath, value, url];
      for (const [key, child] of Object.entries(value)) {
        if (['run', 'runs', 'settings', 'params', 'metadata', 'meta', 'prompt', 'text', 'caption', 'logs'].includes(key)) continue;
        yield* iterCanvasAssetValues(child, nodePath ? `${nodePath}.${key}` : key);
      }
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) yield* iterCanvasAssetValues(value[index], `${nodePath}[${index}]`);
    } else if (typeof value === 'string') {
      const url = canvasAssetDownloadableUrl(value);
      if (url) yield [nodePath, value, url];
    }
  }
  function extractCanvasAssets(canvas) {
    const record = canvasRecord(canvas);
    const canvasId = String(record.id || '');
    const items = []; const seen = new Set();
    const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
    nodes.forEach((node, nodeIndex) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const nodeId = String(node.id || `node_${nodeIndex}`);
      const nodeTitle = String(node.title || node.name || node.label || node.type || '节点').slice(0, 120);
      for (const [fieldPath, raw, url] of iterCanvasAssetValues(node)) {
        if (seen.has(url)) continue;
        seen.add(url);
        const kind = canvasAssetKind(raw, url);
        if (!['image', 'video', 'audio', 'text'].includes(kind)) continue;
        const fallback = `${record.title || 'canvas'}-${items.length + 1}`;
        items.push({ id: crypto.createHash('sha1').update(`${canvasId}:${url}`).digest('hex').slice(0, 24), url, name: canvasAssetName(raw, url, fallback), kind, canvas_id: canvasId, canvas_title: record.title || '未命名画布', canvas_kind: record.kind || 'classic', canvas_owner: record.owner || '', canvas_updated_at: record.updated_at || 0, node_id: nodeId, node_title: nodeTitle, node_type: String(node.type || ''), source_path: fieldPath, created_at: node.created_at || record.updated_at || record.created_at || 0 });
      }
    });
    return items;
  }
  function canvasAssetsIndex() {
    const canvases = []; const items = [];
    const canvasCounts = { all: 0, smart: 0, classic: 0 };
    const itemCounts = { all: 0, smart: 0, classic: 0 };
    try {
      fs.readdirSync(canvasesRoot).forEach(filename => {
        if (!filename.endsWith('.json')) return;
        let canvas; try { canvas = readJson(path.join(canvasesRoot, filename), null); } catch (_error) { return; }
        if (!canvas || canvas.deleted_at) return;
        const record = canvasRecord(canvas);
        const canvasItems = extractCanvasAssets(canvas);
        record.asset_count = canvasItems.length;
        canvases.push(record);
        items.push(...canvasItems);
        const kind = record.kind || 'classic';
        canvasCounts.all += 1; canvasCounts[kind] = (canvasCounts[kind] || 0) + 1;
        itemCounts.all += canvasItems.length; itemCounts[kind] = (itemCounts[kind] || 0) + canvasItems.length;
      });
    } catch (_error) {}
    canvases.sort((a, b) => (a.pinned === b.pinned ? (b.updated_at || b.created_at) - (a.updated_at || a.created_at) : a.pinned ? -1 : 1));
    items.sort((a, b) => (b.canvas_updated_at || b.created_at) - (a.canvas_updated_at || a.created_at));
    const categories = [
      { id: 'all', name: '全部画布', count: itemCounts.all || 0, canvas_count: canvasCounts.all || 0 },
      { id: 'smart', name: '智能画布', count: itemCounts.smart || 0, canvas_count: canvasCounts.smart || 0 },
      { id: 'classic', name: '普通画布', count: itemCounts.classic || 0, canvas_count: canvasCounts.classic || 0 }
    ];
    return { categories, canvases, items };
  }
  router.get('/api/canvas-assets', (_req, res) => res.json(canvasAssetsIndex()));
  router.post('/api/canvas-assets/check', (req, res) => {
    const exists = {};
    (Array.isArray((req.body || {}).urls) ? (req.body || {}).urls : []).slice(0, 3000).forEach(url => {
      const t = String(url || '').trim();
      if (!t) return;
      exists[t] = /^(\/canvas-assets\/|\/canvas-output\/)/.test(t) ? Boolean(fileForCanvasUrl(t)) : true;
    });
    res.json({ exists });
  });
  function fileForCanvasUrl(url) {
    const value = String(url || '').split('?')[0];
    const root = value.startsWith('/canvas-assets/') ? uploadRoot : value.startsWith('/canvas-output/') ? outputRoot : null;
    if (!root) return null;
    const filePath = path.resolve(root, path.basename(value));
    return filePath.startsWith(root + path.sep) && fs.existsSync(filePath) ? filePath : null;
  }
  router.post('/api/canvas-assets/download', (req, res) => {
    const rawItems = Array.isArray((req.body || {}).items) ? (req.body || {}).items : (Array.isArray((req.body || {}).urls) ? (req.body || {}).urls.map(url => ({ url })) : []);
    const usedNames = new Set(); let count = 0;
    res.attachment((req.body || {}).filename || 'canvas-output-images.zip');
    res.type('application/zip');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', error => { if (!res.headersSent) publicError(res, 500, error.message || '打包失败'); else res.destroy(error); });
    archive.pipe(res);
    rawItems.slice(0, 1000).forEach(raw => {
      const entry = typeof raw === 'object' && raw !== null ? raw : { url: String(raw || '') };
      const t = String(entry.url || '').trim();
      if (!t) return;
      const source = fileForCanvasUrl(t);
      if (!source) return;
      let base = safeName(entry.name || path.basename(source)) || `image-${count + 1}.png`;
      let archiveName = base; let suffix = 2;
      while (usedNames.has(archiveName)) { const parsed = path.parse(base); archiveName = `${parsed.name}-${suffix++}${parsed.ext}`; }
      usedNames.add(archiveName);
      archive.file(source, { name: archiveName });
      count += 1;
    });
    if (count <= 0) { archive.abort(); return publicError(res, 404, '没有可下载的本地图片'); }
    archive.finalize();
  });

  // ===== 5. 共享文件夹 =====
  function sharedFoldersLoad() { const data = readJson(sharedFoldersPath, {}); const folders = Array.isArray(data?.folders) ? data.folders.filter(item => item && typeof item === 'object') : []; return { folders }; }
  function sharedFoldersSave(data) { writeJson(sharedFoldersPath, data); }
  function sharedFolderById(folderId) { return sharedFoldersLoad().folders.find(entry => entry.id === folderId) || null; }
  function sharedFolderAbs(entry) { return path.normalize(path.join(projectRoot, String((entry || {}).rel || ''))); }
  function sharedResolveRegister(input) {
    const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) { const error = new Error('请提供文件夹路径'); error.statusCode = 400; throw error; }
    const candidate = path.isAbsolute(raw) ? raw : path.join(projectRoot, raw);
    const absPath = path.normalize(path.resolve(candidate));
    const base = path.normalize(path.resolve(projectRoot));
    if (absPath !== base && !absPath.startsWith(base + path.sep)) { const error = new Error('只允许登记项目目录内的文件夹'); error.statusCode = 400; throw error; }
    if (absPath === base) { const error = new Error('不能直接登记项目根目录，请选择子文件夹'); error.statusCode = 400; throw error; }
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) { const error = new Error('文件夹不存在'); error.statusCode = 400; throw error; }
    return { absPath, rel: path.relative(base, absPath) };
  }
  function sharedChildAbs(folderAbs, rel) {
    const relPath = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const absPath = path.normalize(path.join(folderAbs, relPath));
    const base = path.normalize(path.resolve(folderAbs));
    if (absPath !== base && !absPath.startsWith(base + path.sep)) { const error = new Error('非法路径'); error.statusCode = 400; throw error; }
    return absPath;
  }
  function scanSharedTree(folderId, folderAbs, relPrefix = '', display = '', counter = { n: 0 }) {
    const node = { id: `${folderId}:${relPrefix || '__root__'}`, name: display || path.basename(folderAbs) || folderAbs, path: relPrefix, items: [], children: [] };
    let entries = [];
    try { entries = fs.readdirSync(folderAbs, { withFileTypes: true }).sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1)); } catch (_error) { return node; }
    for (const ent of entries) {
      if (counter.n >= 8000) break;
      if (ent.name.startsWith('.') || ent.name.startsWith('._')) continue;
      const childRel = `${relPrefix}/${ent.name}`.replace(/^\/+/, '');
      if (ent.isDirectory()) { const child = scanSharedTree(folderId, path.join(folderAbs, ent.name), childRel, ent.name, counter); if (child.items.length || child.children.length) node.children.push(child); }
      else if (ent.isFile()) { const ext = path.extname(ent.name).toLowerCase(); if (!SHARED_MEDIA_EXTS.has(ext)) continue; counter.n += 1; let size = 0, mtime = 0; try { const st = fs.statSync(path.join(folderAbs, ent.name)); size = st.size; mtime = Math.floor(st.mtimeMs); } catch (_error) {} node.items.push({ id: `${folderId}:${childRel}`, name: ent.name, path: childRel, kind: ['.mp4', '.webm', '.mov', '.m4v', '.mkv'].includes(ext) ? 'video' : ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext) ? 'audio' : 'image', size, mtime }); }
    }
    return node;
  }
  router.get('/api/shared-folders', (_req, res) => {
    const folders = sharedFoldersLoad().folders.map(entry => { const absPath = sharedFolderAbs(entry); return { id: entry.id, name: entry.name || path.basename(absPath) || absPath, rel: entry.rel || '', path: absPath, exists: fs.existsSync(absPath) && fs.statSync(absPath).isDirectory(), created_at: entry.created_at }; });
    res.json({ folders });
  });
  router.post('/api/shared-folders', (req, res) => {
    try {
      const { absPath, rel } = sharedResolveRegister((req.body || {}).path);
      const name = safeName((req.body || {}).name || path.basename(absPath)) || '共享文件夹';
      const data = sharedFoldersLoad();
      const existing = data.folders.find(entry => path.normalize(sharedFolderAbs(entry)) === path.normalize(absPath));
      if (existing) { existing.name = name; sharedFoldersSave(data); return res.json({ folder: { ...existing, path: absPath, exists: true } }); }
      const entry = { id: `shared_${crypto.randomBytes(6).toString('hex')}`, name, rel, created_at: Date.now() };
      data.folders.push(entry);
      sharedFoldersSave(data);
      res.json({ folder: { ...entry, path: absPath, exists: true } });
    } catch (error) { publicError(res, error.statusCode || 400, error.message || '登记共享文件夹失败'); }
  });
  router.delete('/api/shared-folders/:folderId', (req, res) => {
    const data = sharedFoldersLoad();
    const before = data.folders.length;
    data.folders = data.folders.filter(entry => entry.id !== req.params.folderId);
    if (data.folders.length === before) return publicError(res, 404, '共享文件夹不存在');
    sharedFoldersSave(data);
    res.json({ ok: true });
  });
  router.get('/api/shared-folders/:folderId/tree', (req, res) => {
    const entry = sharedFolderById(req.params.folderId);
    if (!entry) return publicError(res, 404, '共享文件夹不存在');
    const absPath = sharedFolderAbs(entry);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) return publicError(res, 404, '文件夹已不存在');
    const tree = scanSharedTree(req.params.folderId, absPath, '', entry.name || path.basename(absPath));
    res.json({ folder: { id: req.params.folderId, name: entry.name, path: absPath }, tree });
  });
  router.get('/api/shared-folders/:folderId/file', (req, res) => {
    const entry = sharedFolderById(req.params.folderId);
    if (!entry) return publicError(res, 404, '共享文件夹不存在');
    const absPath = sharedChildAbs(sharedFolderAbs(entry), String(req.query.path || ''));
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return publicError(res, 404, '文件不存在');
    if (!SHARED_MEDIA_EXTS.has(path.extname(absPath).toLowerCase())) return publicError(res, 400, '不支持的文件类型');
    res.sendFile(absPath);
  });
  router.post('/api/shared-folders/import', (req, res) => {
    const entry = sharedFolderById((req.body || {}).folder_id);
    if (!entry) return publicError(res, 404, '共享文件夹不存在');
    const folderAbs = sharedFolderAbs(entry);
    const store = readJson(assetLibraryPath, { active_library_id: 'default', libraries: [] });
    const library = (store.libraries || []).find(lib => lib.id === (req.body?.library_id || store.active_library_id)) || (store.libraries || [])[0] || null;
    const categoryId = String(req.body?.category_id || '');
    const category = library?.categories?.find(item => item.id === categoryId) || library?.categories?.find(item => item.type === 'image') || null;
    if (!library) return publicError(res, 404, '资产库不存在');
    if (!category) return publicError(res, 404, '分类不存在');
    if (category.type !== 'image') return publicError(res, 400, '该分类暂不支持添加媒体');
    const added = [];
    (Array.isArray(req.body?.paths) ? req.body.paths : []).slice(0, 200).forEach(rel => {
      let absPath; try { absPath = sharedChildAbs(folderAbs, rel); } catch (_error) { return; }
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return;
      const ext = path.extname(absPath).toLowerCase();
      if (!SHARED_MEDIA_EXTS.has(ext)) return;
      const savedName = `shared_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      fs.copyFileSync(absPath, path.join(uploadRoot, savedName));
      const item = { id: `asset_${crypto.randomBytes(7).toString('hex')}`, name: safeName(path.basename(absPath)), url: `/canvas-assets/${encodeURIComponent(savedName)}`, kind: ['.mp4', '.webm', '.mov', '.m4v', '.mkv'].includes(ext) ? 'video' : ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext) ? 'audio' : 'image', size: fs.statSync(absPath).size, created_at: Date.now() };
      category.items = category.items || [];
      category.items.unshift(item);
      added.push(item);
    });
    if (added.length) writeJson(assetLibraryPath, store);
    res.json({ library: store, items: added });
  });

  // ===== 6. AI 上传 =====
  router.post('/api/ai/upload', (req, res) => uploadAny.array('files', 100)(req, res, error => {
    if (error) return publicError(res, 400, error.message);
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    const videoExts = new Set(['.mp4', '.webm', '.mov', '.m4v', '.flv']);
    const audioExts = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
    const uploaded = [];
    (req.files || []).forEach(file => {
      const content = file.buffer;
      if (!content || !content.length) return;
      let ext = path.extname(file.originalname || '').toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      let kind = 'file';
      if (ext in imageExts || mime.startsWith('image/')) { kind = 'image'; if (!imageExts.has(ext)) ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : '.png'; }
      else if (videoExts.has(ext) || mime.startsWith('video/')) { kind = 'video'; if (!videoExts.has(ext)) ext = mime.includes('webm') ? '.webm' : mime.includes('quicktime') ? '.mov' : '.mp4'; }
      else if (audioExts.has(ext) || mime.startsWith('audio/')) { kind = 'audio'; if (!audioExts.has(ext)) ext = mime.includes('wav') ? '.wav' : mime.includes('ogg') ? '.ogg' : mime.includes('mp4') ? '.m4a' : '.mp3'; }
      else if (mime.startsWith('text/') || mime.startsWith('application/')) kind = 'file';
      const filename = `ai_ref_${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`;
      fs.writeFileSync(path.join(uploadRoot, filename), content);
      uploaded.push({ url: `/canvas-assets/${encodeURIComponent(filename)}`, name: file.originalname || filename, kind, mime: file.mimetype });
    });
    res.json({ files: uploaded });
  }));

  // ===== 7. 媒体缩略图代理 / 附件下载 =====
  const mediaPreviewRoot = path.join(backendRoot, 'output', 'media_previews');
  const IMAGE_PREVIEW_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
  const VIDEO_PREVIEW_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);

  // GET /api/media-preview?url=<url>&w=<width>
  // 对齐源端 main.py 7097：把本地画布图片缩放到指定宽度输出 webp，避免前端直接解码大原图。
  router.get('/api/media-preview', async (req, res) => {
    try {
      const url = String(req.query.url || '').trim();
      if (!url) return publicError(res, 400, '缺少 url 参数');
      const filePath = fileForCanvasUrl(url);
      if (!filePath) return publicError(res, 404, '媒体文件不存在');
      const ext = path.extname(filePath).toLowerCase();
      if (VIDEO_PREVIEW_EXTS.has(ext)) return publicError(res, 415, '视频缩略图尚未接入');
      if (!IMAGE_PREVIEW_EXTS.has(ext)) return publicError(res, 415, '不支持的媒体类型');
      const width = Math.max(64, Math.min(2048, Math.round(Number(req.query.w) || 512)));
      const stat = fs.statSync(filePath);
      const cacheName = `${crypto.createHash('sha1').update(`${url}|${stat.size}|${stat.mtimeMs}|${width}`).digest('hex').slice(0, 24)}.webp`;
      const cachePath = path.join(mediaPreviewRoot, cacheName);
      if (fs.existsSync(cachePath)) return res.sendFile(cachePath);
      fs.mkdirSync(mediaPreviewRoot, { recursive: true });
      await sharp(filePath).resize({ width }).webp({ quality: 82 }).toFile(cachePath);
      res.sendFile(cachePath);
    } catch (_error) {
      publicError(res, 415, '缩略图生成失败');
    }
  });

  // GET /api/download-output?url=<url>&name=<filename>
  // 对齐源端 main.py 11698：本地画布文件直接附件下载，远程 http(s) 走流式代理。
  function attachmentDisposition(filename) {
    const ascii = String(filename || 'download').replace(/["\\\r\n]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  function proxyRemoteDownload(url, name, res) {
    let target;
    try { target = new URL(url); } catch (_error) { return publicError(res, 400, '无效的远程地址'); }
    const client = target.protocol === 'https:' ? https : http;
    const request = client.get(target, { timeout: 30000 }, upstream => {
      const status = upstream.statusCode || 0;
      if (status >= 300 && status < 400 && upstream.headers.location) {
        upstream.resume();
        let redirect;
        try { redirect = new URL(upstream.headers.location, target).toString(); } catch (_error) { redirect = ''; }
        if (!redirect || !/^https?:\/\//i.test(redirect)) return publicError(res, 502, '远程文件重定向异常');
        return proxyRemoteDownload(redirect, name, res);
      }
      if (status < 200 || status >= 300) { upstream.resume(); return publicError(res, 502, '远程文件下载失败'); }
      const filename = safeName(name || path.basename(target.pathname) || 'download');
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Content-Disposition', attachmentDisposition(filename));
      upstream.on('error', () => { if (!res.headersSent) publicError(res, 502, '远程文件下载失败'); else res.destroy(); });
      upstream.pipe(res);
    });
    request.on('timeout', () => request.destroy(new Error('远程文件下载超时')));
    request.on('error', () => { if (!res.headersSent) publicError(res, 502, '远程文件下载失败'); else res.destroy(); });
  }
  router.get('/api/download-output', (req, res) => {
    const url = String(req.query.url || '').trim();
    const name = String(req.query.name || '').trim();
    if (!url) return publicError(res, 400, '缺少 url 参数');
    const filePath = fileForCanvasUrl(url);
    if (filePath) return res.download(filePath, safeName(name || path.basename(filePath)));
    if (/^https?:\/\//i.test(url)) return proxyRemoteDownload(url, name, res);
    return publicError(res, 400, '找不到可下载的文件');
  });

  return router;
};
