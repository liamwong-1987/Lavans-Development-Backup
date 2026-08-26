const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];
const RENAME_RETRY_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : clone(fallback);
  } catch (error) {
    error.message = `无法读取 JSON：${filePath}；${error.message}`;
    throw error;
  }
}

function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      if (!RENAME_RETRY_ERRORS.has(error?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      Atomics.wait(RENAME_RETRY_BUFFER, 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function atomicWriteJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(temporary, 'utf8'));
  renameWithRetry(temporary, filePath);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : stableStringify(value), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeId(value, label = 'ID') {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id)) throw new Error(`${label} 不合法`);
  return id;
}

module.exports = { atomicWriteJson, clone, ensureDir, readJson, safeId, sha256, stableStringify };
