const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPOSITORY,
  BRANCH,
  normalizeVersion,
  compareVersions,
  isAllowedUpdatePath
} = require('./appUpdatePolicy');

const API_ROOT = 'https://api.github.com';
const RAW_ROOT = 'https://raw.githubusercontent.com';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 384 * 1024 * 1024;
const MAX_FILES = 1000;

function updateError(message, code, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeId(value) {
  return String(value || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 80) || crypto.randomUUID();
}

function resolveUpdatePath(projectRoot, relativePath) {
  if (!isAllowedUpdatePath(relativePath)) {
    throw updateError(`更新清单包含受保护路径: ${relativePath}`, 'UPDATE_PATH_BLOCKED', 400);
  }
  const target = path.resolve(projectRoot, ...relativePath.split('/'));
  const relative = path.relative(projectRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw updateError(`更新路径越界: ${relativePath}`, 'UPDATE_PATH_INVALID', 400);
  }
  return target;
}

function assertNoSymlink(projectRoot, targetPath) {
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, path.resolve(targetPath));
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = root;
  if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
    throw updateError('应用目录不能是符号链接', 'UPDATE_SYMLINK_BLOCKED', 409);
  }
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw updateError(`更新路径包含符号链接: ${relative}`, 'UPDATE_SYMLINK_BLOCKED', 409);
    }
  }
}

function atomicReplaceFromFile(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const token = crypto.randomBytes(6).toString('hex');
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.lavans-${token}.tmp`);
  const displacedPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.lavans-${token}.old`);
  fs.copyFileSync(sourcePath, temporaryPath);
  let displaced = false;
  let replacementCompleted = false;
  try {
    try {
      fs.renameSync(temporaryPath, targetPath);
      replacementCompleted = true;
    } catch (error) {
      if (!fs.existsSync(targetPath)) throw error;
      fs.renameSync(targetPath, displacedPath);
      displaced = true;
      try {
        fs.renameSync(temporaryPath, targetPath);
        replacementCompleted = true;
      } catch (replaceError) {
        if (!fs.existsSync(targetPath) && fs.existsSync(displacedPath)) {
          fs.renameSync(displacedPath, targetPath);
          displaced = false;
        }
        throw replaceError;
      }
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    if (replacementCompleted && displaced) fs.rmSync(displacedPath, { force: true });
  }
}

function normalizeManifest(raw, expectedVersion) {
  if (!raw || raw.schemaVersion !== 1 || raw.repository !== REPOSITORY || raw.branch !== BRANCH) {
    throw updateError('更新清单身份不匹配', 'UPDATE_MANIFEST_IDENTITY_INVALID', 409);
  }
  const version = normalizeVersion(raw.version);
  if (version !== expectedVersion) throw updateError('版本文件与更新清单不一致', 'UPDATE_VERSION_MISMATCH', 409);
  if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > MAX_FILES) {
    throw updateError('更新清单文件数量无效', 'UPDATE_MANIFEST_COUNT_INVALID', 409);
  }

  const seen = new Set();
  let totalBytes = 0;
  const files = raw.files.map(item => {
    const relativePath = String(item?.path || '');
    if (!isAllowedUpdatePath(relativePath)) {
      throw updateError(`更新清单包含受保护路径: ${relativePath}`, 'UPDATE_PATH_BLOCKED', 409);
    }
    const comparisonKey = relativePath.toLowerCase();
    if (seen.has(comparisonKey)) throw updateError(`更新清单路径重复: ${relativePath}`, 'UPDATE_PATH_DUPLICATE', 409);
    seen.add(comparisonKey);
    const size = Number(item?.size);
    const digest = String(item?.sha256 || '').toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(digest)) {
      throw updateError(`更新清单文件元数据无效: ${relativePath}`, 'UPDATE_FILE_METADATA_INVALID', 409);
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) throw updateError('更新总大小超过安全上限', 'UPDATE_TOTAL_SIZE_INVALID', 409);
    return { path: relativePath, size, sha256: digest };
  });
  if (!seen.has('version')) throw updateError('更新清单缺少 VERSION', 'UPDATE_VERSION_FILE_MISSING', 409);
  return { schemaVersion: 1, repository: REPOSITORY, branch: BRANCH, version, files, totalBytes };
}

function encodeRawPath(relativePath) {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function createAppUpdateService(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '..', '..', '..'));
  const stateRoot = path.resolve(options.stateRoot || path.join(projectRoot, 'resources', 'output', '.state', 'app-updates'));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const replaceFile = options.replaceFile || atomicReplaceFromFile;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
  let applying = false;

  if (typeof fetchImpl !== 'function') throw updateError('当前运行时不支持安全更新请求', 'UPDATE_FETCH_UNAVAILABLE', 500);

  function localVersion() {
    const versionPath = path.join(projectRoot, 'VERSION');
    if (!fs.existsSync(versionPath)) throw updateError('本机缺少 VERSION，需重新安装带更新引导的版本', 'UPDATE_BOOTSTRAP_REQUIRED', 409);
    return normalizeVersion(fs.readFileSync(versionPath, 'utf8'));
  }

  async function fetchBytes(url, expectedHost, maxBytes, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity', 'User-Agent': 'Lavans-Updater' }
      });
      if (!response?.ok) throw updateError(`${label}失败: HTTP ${response?.status || 0}`, 'UPDATE_HTTP_FAILED', 502);
      if (response.url) {
        let finalHost = '';
        try { finalHost = new URL(response.url).hostname.toLowerCase(); } catch (_error) {}
        if (finalHost && finalHost !== expectedHost) throw updateError(`${label}被重定向到未授权主机`, 'UPDATE_REDIRECT_BLOCKED', 502);
      }
      const contentEncoding = String(response.headers?.get?.('content-encoding') || '').toLowerCase();
      const declaredSize = Number(response.headers?.get?.('content-length') || 0);
      if ((!contentEncoding || contentEncoding === 'identity') && declaredSize > maxBytes) {
        throw updateError(`${label}超过安全大小`, 'UPDATE_DOWNLOAD_TOO_LARGE', 502);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw updateError(`${label}超过安全大小`, 'UPDATE_DOWNLOAD_TOO_LARGE', 502);
      return buffer;
    } catch (error) {
      if (error?.code?.startsWith?.('UPDATE_')) throw error;
      const code = error?.name === 'AbortError' ? 'UPDATE_REQUEST_TIMEOUT' : 'UPDATE_NETWORK_FAILED';
      throw updateError(`${label}失败: ${error.message || '网络不可用'}`, code, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJson(url, expectedHost, maxBytes, label) {
    const buffer = await fetchBytes(url, expectedHost, maxBytes, label);
    try { return JSON.parse(buffer.toString('utf8')); }
    catch (_error) { throw updateError(`${label}不是有效 JSON`, 'UPDATE_JSON_INVALID', 502); }
  }

  async function latestCommitSha() {
    const data = await fetchJson(`${API_ROOT}/repos/${REPOSITORY}/commits/${encodeURIComponent(BRANCH)}`, 'api.github.com', MAX_MANIFEST_BYTES, '读取仓库版本');
    const commitSha = String(data?.sha || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw updateError('仓库提交标识无效', 'UPDATE_COMMIT_INVALID', 502);
    return commitSha;
  }

  function rawUrl(commitSha, relativePath) {
    return `${RAW_ROOT}/${REPOSITORY}/${commitSha}/${encodeRawPath(relativePath)}`;
  }

  async function remoteMetadata(commitSha, knownVersion = '') {
    const version = knownVersion || normalizeVersion((await fetchBytes(rawUrl(commitSha, 'VERSION'), 'raw.githubusercontent.com', 128, '读取远端版本')).toString('utf8'));
    const manifestRaw = await fetchJson(rawUrl(commitSha, 'update-manifest.json'), 'raw.githubusercontent.com', MAX_MANIFEST_BYTES, '读取更新清单');
    const manifest = normalizeManifest(manifestRaw, version);
    let notes = { schemaVersion: 1, version, title: `Lavans ${version}`, notes: [] };
    try {
      const candidate = await fetchJson(rawUrl(commitSha, 'update-notes.json'), 'raw.githubusercontent.com', 256 * 1024, '读取更新说明');
      if (candidate?.schemaVersion === 1 && normalizeVersion(candidate.version) === version && Array.isArray(candidate.notes)) {
        notes = { schemaVersion: 1, version, title: String(candidate.title || `Lavans ${version}`).slice(0, 120), notes: candidate.notes.slice(0, 20).map(item => String(item).slice(0, 500)) };
      }
    } catch (_error) {
      // 更新说明是展示信息；版本、清单和文件校验仍是硬门。
    }
    return { version, manifest, notes };
  }

  async function check() {
    const currentVersion = localVersion();
    const commitSha = await latestCommitSha();
    const versionBytes = await fetchBytes(rawUrl(commitSha, 'VERSION'), 'raw.githubusercontent.com', 128, '读取远端版本');
    const latestVersion = normalizeVersion(versionBytes.toString('utf8'));
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return { repository: REPOSITORY, branch: BRANCH, currentVersion, latestVersion, commitSha, updateAvailable: false, notes: [] };
    }
    const metadata = await remoteMetadata(commitSha, latestVersion);
    return {
      repository: REPOSITORY,
      branch: BRANCH,
      currentVersion,
      latestVersion: metadata.version,
      commitSha,
      updateAvailable: true,
      fileCount: metadata.manifest.files.length,
      totalBytes: metadata.manifest.totalBytes,
      title: metadata.notes.title,
      notes: metadata.notes.notes
    };
  }

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  async function stageFiles(commitSha, manifest, stagingRoot) {
    await mapLimit(manifest.files, 6, async entry => {
      const content = await fetchBytes(rawUrl(commitSha, entry.path), 'raw.githubusercontent.com', Math.min(MAX_FILE_BYTES, entry.size + 1), `下载 ${entry.path}`);
      if (content.length !== entry.size || sha256(content) !== entry.sha256) {
        throw updateError(`文件校验失败: ${entry.path}`, 'UPDATE_FILE_HASH_MISMATCH', 409);
      }
      const stagedPath = resolveUpdatePath(stagingRoot, entry.path);
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      fs.writeFileSync(stagedPath, content);
    });
  }

  function writeReceipt(backupRoot, receipt) {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.writeFileSync(path.join(backupRoot, 'update-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }

  function prepareBackups(manifest, backupRoot) {
    const entries = [];
    for (const entry of manifest.files) {
      const targetPath = resolveUpdatePath(projectRoot, entry.path);
      assertNoSymlink(projectRoot, targetPath);
      const existed = fs.existsSync(targetPath);
      if (existed && !fs.lstatSync(targetPath).isFile()) {
        throw updateError(`更新目标不是普通文件: ${entry.path}`, 'UPDATE_TARGET_INVALID', 409);
      }
      const record = { path: entry.path, existed, previousSha256: null };
      if (existed) {
        const content = fs.readFileSync(targetPath);
        record.previousSha256 = sha256(content);
        const backupPath = resolveUpdatePath(backupRoot, entry.path);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, content);
      }
      entries.push(record);
    }
    return entries;
  }

  function rollback(entries, backupRoot) {
    const failures = [];
    for (const entry of [...entries].reverse()) {
      const targetPath = resolveUpdatePath(projectRoot, entry.path);
      try {
        if (entry.existed) {
          const backupPath = resolveUpdatePath(backupRoot, entry.path);
          atomicReplaceFromFile(backupPath, targetPath);
        } else {
          fs.rmSync(targetPath, { force: true });
        }
      } catch (error) {
        failures.push(`${entry.path}: ${error.message}`);
      }
    }
    if (failures.length) throw updateError(`自动恢复失败: ${failures.join('; ')}`, 'UPDATE_ROLLBACK_FAILED', 500);
  }

  async function applyUnlocked(request = {}) {
    const expectedCommit = String(request.commitSha || '').toLowerCase();
    const expectedVersion = normalizeVersion(request.version);
    if (!/^[a-f0-9]{40}$/.test(expectedCommit)) throw updateError('更新提交标识无效', 'UPDATE_COMMIT_INVALID', 400);
    const currentVersion = localVersion();
    if (compareVersions(expectedVersion, currentVersion) <= 0) throw updateError('当前版本无需更新', 'UPDATE_NOT_NEWER', 409);

    const commitSha = await latestCommitSha();
    if (commitSha !== expectedCommit) throw updateError('仓库已经出现新提交，请重新检查更新', 'UPDATE_COMMIT_CHANGED', 409);
    const metadata = await remoteMetadata(commitSha);
    if (metadata.version !== expectedVersion) throw updateError('待安装版本已经变化，请重新检查更新', 'UPDATE_VERSION_CHANGED', 409);

    const updateId = `${metadata.version}-${safeId(commitSha.slice(0, 12))}-${Date.now()}`;
    const stagingRoot = path.join(stateRoot, 'staging', updateId);
    const backupRoot = path.join(stateRoot, 'backups', updateId);
    fs.mkdirSync(stagingRoot, { recursive: true });
    let backupEntries = [];
    const receipt = {
      schemaVersion: 1,
      updateId,
      repository: REPOSITORY,
      branch: BRANCH,
      commitSha,
      fromVersion: currentVersion,
      toVersion: metadata.version,
      status: 'staging',
      createdAt: new Date().toISOString(),
      files: []
    };

    try {
      await stageFiles(commitSha, metadata.manifest, stagingRoot);
      backupEntries = prepareBackups(metadata.manifest, backupRoot);
      receipt.files = backupEntries;
      receipt.status = 'applying';
      writeReceipt(backupRoot, receipt);

      const orderedFiles = [...metadata.manifest.files].sort((left, right) => {
        if (left.path === 'VERSION') return 1;
        if (right.path === 'VERSION') return -1;
        return left.path.localeCompare(right.path, 'en');
      });
      for (const entry of orderedFiles) {
        const stagedPath = resolveUpdatePath(stagingRoot, entry.path);
        const targetPath = resolveUpdatePath(projectRoot, entry.path);
        assertNoSymlink(projectRoot, targetPath);
        replaceFile(stagedPath, targetPath, entry.path);
        const installed = fs.readFileSync(targetPath);
        if (installed.length !== entry.size || sha256(installed) !== entry.sha256) {
          throw updateError(`写入后校验失败: ${entry.path}`, 'UPDATE_WRITE_VERIFY_FAILED', 500);
        }
      }

      receipt.status = 'completed';
      receipt.completedAt = new Date().toISOString();
      writeReceipt(backupRoot, receipt);
      return { success: true, updateId, fromVersion: currentVersion, version: metadata.version, commitSha, restartRequired: true };
    } catch (error) {
      let failure = error;
      if (backupEntries.length) {
        try {
          rollback(backupEntries, backupRoot);
          receipt.status = 'rolled_back';
        } catch (rollbackError) {
          receipt.status = 'rollback_failed';
          receipt.rollbackError = rollbackError.message;
          failure = rollbackError;
        }
        receipt.error = error.message;
        receipt.completedAt = new Date().toISOString();
        writeReceipt(backupRoot, receipt);
      }
      throw failure;
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  async function apply(request = {}) {
    if (applying) throw updateError('已有更新正在执行', 'UPDATE_ALREADY_RUNNING', 409);
    applying = true;
    try { return await applyUnlocked(request); }
    finally { applying = false; }
  }

  return {
    status: () => ({ repository: REPOSITORY, branch: BRANCH, currentVersion: localVersion() }),
    check,
    apply
  };
}

module.exports = {
  createAppUpdateService,
  normalizeManifest,
  resolveUpdatePath,
  atomicReplaceFromFile,
  updateError
};
