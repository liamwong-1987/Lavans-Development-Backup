/**
 * fileStore.js — 文件管理（扫描、配对、CSV导出、multer上传）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const multer = require('multer');
const { isImage } = require('./validator');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const LOG_DIR = path.join(__dirname, '..', 'logs');

// 确保目录存在
[UPLOAD_DIR, OUTPUT_DIR, LOG_DIR,
  path.join(UPLOAD_DIR, 'templates'),
  path.join(UPLOAD_DIR, 'colors'),
  path.join(UPLOAD_DIR, 'sessions')
].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let activeUploadSessionId = null;

function createUploadSessionId() {
  return 'upload_' + new Date().toISOString().replace(/[:.]/g, '-') + '_' + Math.random().toString(36).slice(2, 6);
}

function safeSessionId(value) {
  return typeof value === 'string' && /^upload_[A-Za-z0-9_-]+$/.test(value);
}

function getUploadRoot(sessionId) {
  if (!sessionId) return UPLOAD_DIR;
  if (!safeSessionId(sessionId)) throw new Error('无效上传会话ID');
  const dir = path.join(UPLOAD_DIR, 'sessions', sessionId);
  const root = path.resolve(UPLOAD_DIR, 'sessions') + path.sep;
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(root)) throw new Error('上传会话路径越界');
  return resolved;
}

function getUploadPublicPath(filePath, sessionId) {
  const root = getUploadRoot(sessionId || null);
  const resolvedRoot = path.resolve(root) + path.sep;
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot)) return null;
  const relative = path.relative(root, resolvedFile).replace(/\\/g, '/');
  return sessionId ? `/uploads/sessions/${encodeURIComponent(sessionId)}/${relative.split('/').map(encodeURIComponent).join('/')}` : `/uploads/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

function ensureUploadDirs(root) {
  [path.join(root, 'templates'), path.join(root, 'colors')].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// multer 配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.query.type === 'color' ? 'colors' : 'templates';
    // 每次模板上传都是一个新的上传批次；同一请求的后续文件和随后的参考色上传复用该批次。
    // 这样初次上传和运行中追加都拥有稳定 uploadBatchId，而不依赖“是否追加”的旧分支。
    let sessionId = req.uploadSessionId || req.query.sessionId || null;
    if (!sessionId) {
      if (type === 'templates' || !activeUploadSessionId) activeUploadSessionId = createUploadSessionId();
      sessionId = activeUploadSessionId;
    }
    activeUploadSessionId = sessionId;
    req.uploadSessionId = sessionId;
    const root = getUploadRoot(sessionId);
    ensureUploadDirs(root);
    cb(null, path.join(root, type));
  },
  filename: (req, file, cb) => {
    // 安全处理文件名（保留中文、去路径）
    let name = file.originalname;
    // 如果看起来像是latin1编码的中文，尝试修复
    try {
      const decoded = Buffer.from(name, 'latin1').toString('utf8');
      if (decoded.includes('�') === false && /[\u4e00-\u9fff]/.test(decoded)) {
        name = decoded;
      }
    } catch (e) {}
    // 防路径穿越
    name = path.basename(name);
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, isImage(file.originalname));
  }
});

/** 扫描目录 */
function scanDir(dirPath) {
  if (!fs.existsSync(dirPath)) return { files: [], count: 0 };
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && isImage(e.name) && !e.name.includes('_mask'))
    .map(e => {
      const fp = path.join(dirPath, e.name);
      return {
        name: e.name,
        nameWithoutExt: path.parse(e.name).name,
        ext: path.extname(e.name).toLowerCase(),
        path: fp,
        size: fs.statSync(fp).size
      };
    })
    .sort((a, b) => {
      const nA = parseInt(a.nameWithoutExt), nB = parseInt(b.nameWithoutExt);
      if (!isNaN(nA) && !isNaN(nB)) return nA - nB;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  return { files, count: files.length };
}

/** 获取模版和颜色列表 */
function getFileLists(sessionId) {
  const root = getUploadRoot(sessionId || activeUploadSessionId);
  ensureUploadDirs(root);
  return {
    templates: scanDir(path.join(root, 'templates')),
    colors: scanDir(path.join(root, 'colors')),
    sessionId: sessionId || activeUploadSessionId || null
  };
}

function getActiveUploadSessionId() {
  return activeUploadSessionId;
}

function clearActiveUploadSession() {
  activeUploadSessionId = null;
}

function nativeRemovePath(targetPath) {
  if (process.platform === 'win32') {
    // Electron 的 process.execPath 指向 Lavans.exe，不是 Node，不能用它启动删除子进程。
    // 用 PowerShell 直接调用 .NET 原生删除，避免触发 Electron 生命周期或安全删除回收站 shim。
    const escaped = targetPath.replace(/'/g, "''");
    const script = [
      '$ErrorActionPreference = "Stop"',
      "$p = '" + escaped + "'",
      'if (Test-Path -LiteralPath $p -PathType Leaf) {',
      '  [System.IO.File]::SetAttributes($p, [System.IO.FileAttributes]::Normal)',
      '  [System.IO.File]::Delete($p)',
      '} elseif (Test-Path -LiteralPath $p -PathType Container) {',
      '  Get-ChildItem -LiteralPath $p -Force -Recurse | ForEach-Object {',
      '    if ($_.PSIsContainer) { $_.Attributes = [System.IO.FileAttributes]::Directory }',
      '    else { $_.Attributes = [System.IO.FileAttributes]::Normal }',
      '  }',
      '  [System.IO.Directory]::Delete($p, $true)',
      '}',
      'if (Test-Path -LiteralPath $p) { throw "残留" }'
    ].join('\n');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: '' }
    });
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function removePathWithRetry(targetPath, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (!fs.existsSync(targetPath)) return true;
      try { fs.chmodSync(targetPath, 0o666); } catch (e) {}
      nativeRemovePath(targetPath);
      if (!fs.existsSync(targetPath)) return true;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      try { const waitUntil = Date.now() + 120 * (attempt + 1); while (Date.now() < waitUntil) {} } catch (e) {}
    }
  }
  return lastError || new Error('删除后仍检测到文件残留');
}

function clearDirectoryContents(dir, options = {}) {
  const failed = [];
  if (!fs.existsSync(dir)) {
    if (options.recreate) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (error) { failed.push({ path: dir, reason: error.code || error.message }); }
    }
    return failed;
  }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { return [{ path: dir, reason: error.code || error.message }]; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const result = removePathWithRetry(p);
    if (result !== true) failed.push({ path: p, reason: result.code || result.message });
  }
  if (options.recreate) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (error) { failed.push({ path: dir, reason: error.code || error.message }); }
  }
  return failed;
}

function clearAllUploads() {
  const failed = [];
  // 只清理复色拥有的白名单目录；未知目录可能属于其他模块，必须保留。
  for (const dir of ['templates', 'colors', 'sessions']) {
    failed.push(...clearDirectoryContents(path.join(UPLOAD_DIR, dir), { recreate: true }));
  }
  activeUploadSessionId = null;
  return { success: failed.length === 0, failed };
}

/** 清除上传目录 */
function clearUploads(type, options = {}) {
  const normalized = type === 'template' ? 'templates' : type === 'color' ? 'colors' : type;
  const allowed = ['templates', 'colors'];
  if (normalized && !allowed.includes(normalized)) return { success: false, error: '无效上传类型' };
  const root = getUploadRoot(options.sessionId || null);
  const dir = normalized ? path.join(root, normalized) : root;
  const failed = [];
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const result = removePathWithRetry(p);
      if (result !== true) failed.push({ path: p, reason: result.code || result.message });
    }
  }
  if (!options.sessionId) activeUploadSessionId = null;
  return { success: failed.length === 0, failed };
}

module.exports = { upload, getFileLists, getUploadPublicPath, getUploadRoot, safeSessionId, clearUploads, clearAllUploads, clearDirectoryContents, scanDir, UPLOAD_DIR, OUTPUT_DIR, getActiveUploadSessionId, clearActiveUploadSession };
