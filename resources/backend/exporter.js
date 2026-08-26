/**
 * exporter.js — ZIP 打包
 */
const path = require('path');
const fs = require('fs');

function createZip(dir, files, zipName) {
  const zipPath = path.join(dir, `${zipName}.zip`);
  if (files.length === 0) return null;

  // 先删除旧 zip
  if (fs.existsSync(zipPath)) {
    try { fs.unlinkSync(zipPath); } catch(e) {}
  }

  try {
    const archiver = require('archiver');
    const output = fs.createWriteStream(zipPath);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ZIP 打包超时'));
      }, 30000);

      output.on('close', () => {
        clearTimeout(timeout);
        // 验证 ZIP 文件大小 > 0
        try {
          const stat = fs.statSync(zipPath);
          if (stat.size > 0) {
            resolve(zipPath);
          } else {
            reject(new Error('ZIP 文件为空'));
          }
        } catch(e) {
          reject(new Error('ZIP 文件创建失败'));
        }
      });

      output.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      const archive = archiver('zip', { zlib: { level: 5 } });
      archive.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      archive.pipe(output);

      let added = 0;
      for (const f of files) {
        if (fs.existsSync(f)) {
          archive.file(f, { name: path.basename(f) });
          added++;
        }
      }

      if (added === 0) {
        clearTimeout(timeout);
        reject(new Error('无有效文件可打包'));
        return;
      }

      archive.finalize();
    });
  } catch (e) {
    // archiver 不可用时尝试 7-Zip
    const { execSync } = require('child_process');
    const a7z = 'C:/Program Files/7-Zip/7z.exe';
    if (fs.existsSync(a7z)) {
      try {
        const args = `a -tzip "${zipPath}" ${files.filter(f => fs.existsSync(f)).map(f => `"${f}"`).join(' ')}`;
        execSync(`"${a7z}" ${args}`, { cwd: dir, timeout: 30000 });
        if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) return zipPath;
      } catch (e2) { /* fall through */ }
    }
    return null;
  }
}

function safeName(value, fallback = '未命名') {
  return String(value || fallback)
    .replace(/[\\/:"*?<>|]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, 60) || fallback;
}

function formatDate(value, withTime = false) {
  const date = value ? new Date(value) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = number => String(number).padStart(2, '0');
  const day = `${valid.getFullYear()}${pad(valid.getMonth() + 1)}${pad(valid.getDate())}`;
  return withTime ? `${day}-${pad(valid.getHours())}${pad(valid.getMinutes())}${pad(valid.getSeconds())}` : day;
}

function semanticImageName(task, existingNames = new Set()) {
  const template = safeName(task.templateNameWithoutExt || task.template || '模板图');
  const reference = safeName(task.referenceColorLabel || task.colorNameWithoutExt || task.colorRef || '参考色');
  const hex = /^#[0-9a-f]{6}$/i.test(String(task.referenceHex || ''))
    ? `HEX-${String(task.referenceHex).slice(1).toUpperCase()}` : '';
  const stamp = formatDate(task.createdAt || task.finishedAt, true);
  const ext = path.extname(task.output || '') || '.png';
  const base = [template, reference, hex, stamp].filter(Boolean).join('-');
  let name = `${base}${ext}`;
  if (existingNames.has(name)) {
    const code = String(task.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || 'DUPL';
    name = `${base}-${code}${ext}`;
  }
  existingNames.add(name);
  return name;
}

function semanticArchiveName(tasks, exportedAt = new Date()) {
  const templates = [...new Set(tasks.map(task => safeName(task.templateNameWithoutExt || task.template || '模板图')))];
  const lead = templates[0] || '复色结果';
  const body = templates.length <= 1 ? lead : `${lead}等${templates.length}张`;
  return `${formatDate(exportedAt)}-${body}-复色结果.zip`;
}

async function createNamedZip(tempDir, files, zipName) {
  if (!files.length) return null;
  const zipPath = path.join(tempDir, safeName(zipName, '复色结果.zip'));
  const archiver = require('archiver');
  const output = fs.createWriteStream(zipPath);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ZIP 打包超时')), 60000);
    output.on('close', () => {
      clearTimeout(timeout);
      try { resolve(fs.statSync(zipPath).size > 0 ? zipPath : null); }
      catch (error) { reject(new Error('ZIP 文件创建失败')); }
    });
    output.on('error', error => { clearTimeout(timeout); reject(error); });
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', error => { clearTimeout(timeout); reject(error); });
    archive.pipe(output);
    for (const file of files) archive.file(file.src, { name: file.name });
    archive.finalize();
  });
}

module.exports = { createZip, createStructuredZip, safeName, formatDate, semanticImageName, semanticArchiveName, createNamedZip };

/**
 * createStructuredZip — 按颜色分文件夹 + 文件夹内数字编号
 * @param {string} dir 临时目录
 * @param {object} groups { "颜色名": [{src: "/path/to/file", seq: 1}, ...] }
 * @param {string} zipName ZIP文件名
 */
async function createStructuredZip(dir, groups, zipName) {
  const zipPath = path.join(dir, `${zipName}.zip`);
  const entries = Object.keys(groups);
  if (entries.length === 0) return null;

  // 计算总文件数决定编号位数
  let maxCount = 0;
  for (const key of entries) maxCount = Math.max(maxCount, groups[key].length);
  const padLen = maxCount > 99 ? 3 : 2;

  // 安全化文件夹名
  function safeName(name) {
    return String(name || '未分类')
      .replace(/[\\/:"*?<>|]/g, '_')
      .replace(/\.\./g, '_')
      .replace(/^\.+/, '_')
      .replace(/^\s+|\s+$/g, '')
      .slice(0, 60) || '未分类';
  }

  // 先删除旧 zip
  if (fs.existsSync(zipPath)) {
    try { fs.unlinkSync(zipPath); } catch(e) {}
  }

  try {
    const archiver = require('archiver');
    const output = fs.createWriteStream(zipPath);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ZIP 打包超时')), 60000);

      output.on('close', () => {
        clearTimeout(timeout);
        try {
          const stat = fs.statSync(zipPath);
          if (stat.size > 0) resolve(zipPath);
          else reject(new Error('ZIP 文件为空'));
        } catch(e) { reject(new Error('ZIP 文件创建失败')); }
      });
      output.on('error', (err) => { clearTimeout(timeout); reject(err); });

      const archive = archiver('zip', { zlib: { level: 5 } });
      archive.on('error', (err) => { clearTimeout(timeout); reject(err); });
      archive.pipe(output);

      let added = 0;
      for (const key of entries) {
        const folder = safeName(key);
        const items = groups[key];
        items.sort((a, b) => (a.seq || 0) - (b.seq || 0));
        for (const item of items) {
          if (fs.existsSync(item.src)) {
            const num = String(item.seq || (added + 1)).padStart(padLen, '0');
            const ext = path.extname(item.src) || '.png';
            archive.file(item.src, { name: `${folder}/${num}${ext}` });
            added++;
          }
        }
      }

      if (added === 0) { clearTimeout(timeout); reject(new Error('无有效文件可打包')); return; }
      archive.finalize();
    });
  } catch (e) {
    return null;
  }
}
