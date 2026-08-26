// 一键复色参考图的本地裁剪与 HEX 元数据。只影响上传会话和导出信息，绝不改提示词或 API 请求。
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { return fallback; }
}

function writeJson(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function normalizeCrop(value) {
  const input = value || {};
  const number = key => Number(input[key]);
  let x = Number.isFinite(number('x')) ? number('x') : 0;
  let y = Number.isFinite(number('y')) ? number('y') : 0;
  let width = Number.isFinite(number('width')) ? number('width') : 1;
  let height = Number.isFinite(number('height')) ? number('height') : 1;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  width = Math.max(0.02, Math.min(1 - x, width));
  height = Math.max(0.02, Math.min(1 - y, height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('裁剪范围无效');
  return { x, y, width, height };
}

function cropPixels(meta, crop) {
  const width = Math.max(1, Math.round(meta.width * crop.width));
  const height = Math.max(1, Math.round(meta.height * crop.height));
  return {
    left: Math.min(Math.max(0, Math.round(meta.width * crop.x)), Math.max(0, meta.width - width)),
    top: Math.min(Math.max(0, Math.round(meta.height * crop.y)), Math.max(0, meta.height - height)),
    width,
    height
  };
}

function validHex(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}

module.exports = function createRecolorReferenceService({ fileStore, colorEngine, now = () => new Date().toISOString() }) {
  function root(sessionId) { return fileStore.getUploadRoot(sessionId || fileStore.getActiveUploadSessionId() || null); }
  function cropDir(sessionId) { return path.join(root(sessionId), '.recolor-color-crops'); }
  function cropManifestPath(sessionId) { return path.join(root(sessionId), '.recolor-color-crop.json'); }
  function metadataPath(sessionId) { return path.join(root(sessionId), '.recolor-color-metadata.json'); }
  function sourcePath(sessionId, colorName) { return path.join(root(sessionId), 'colors', path.basename(String(colorName || ''))); }
  function cropManifest(sessionId) { return readJson(cropManifestPath(sessionId), { version: 1, files: {} }); }
  function metadata(sessionId) { return readJson(metadataPath(sessionId), { version: 1, colors: {} }); }

  function getEffectiveColor(sessionId, colorName) {
    const name = path.basename(String(colorName || ''));
    const originalPath = sourcePath(sessionId, name);
    const manifest = cropManifest(sessionId);
    const croppedPath = path.join(cropDir(sessionId), name);
    const cropApplied = Boolean(manifest.files?.[name] && fs.existsSync(croppedPath));
    const meta = metadata(sessionId).colors?.[name] || {};
    return {
      name,
      path: cropApplied ? croppedPath : originalPath,
      originalPath,
      cropApplied,
      crop: cropApplied ? manifest.files[name].crop : null,
      referenceHex: validHex(meta.hex) ? String(meta.hex).toUpperCase() : null,
      referenceColorLabel: typeof meta.label === 'string' ? meta.label.slice(0, 80) : '',
      referenceHexSource: validHex(meta.hex) ? (meta.source === 'auto' ? 'auto' : 'manual') : ''
    };
  }

  function effectiveColors(sessionId) {
    const lists = fileStore.getFileLists(sessionId);
    return lists.colors.files.map(file => {
      const effective = getEffectiveColor(sessionId, file.name);
      return { ...file, path: effective.path, originalPath: effective.originalPath, cropApplied: effective.cropApplied, crop: effective.crop, referenceHex: effective.referenceHex, referenceColorLabel: effective.referenceColorLabel, referenceHexSource: effective.referenceHexSource };
    });
  }

  function decoratePair(pair, sessionId) {
    const effective = getEffectiveColor(sessionId, pair.colorName || pair.colorRef);
    return { ...pair, colorPath: effective.path, originalColorPath: effective.originalPath, colorCropped: effective.cropApplied, referenceHex: effective.referenceHex, referenceColorLabel: effective.referenceColorLabel, referenceHexSource: effective.referenceHexSource };
  }

  async function cropWarnings(sessionId, crop) {
    const colors = fileStore.getFileLists(sessionId).colors.files;
    const metas = await Promise.all(colors.map(async file => ({ file, meta: await sharp(file.path).metadata() })));
    const first = metas[0]?.meta;
    const baseRatio = first?.width && first?.height ? first.width / first.height : null;
    return metas.filter(({ meta }) => baseRatio && meta.width && meta.height && Math.abs(meta.width / meta.height - baseRatio) > 0.02)
      .map(({ file, meta }) => ({ name: file.name, width: meta.width, height: meta.height, reason: '比例与第一张参考色不同，需要单独确认' }));
  }

  async function previewCrop(sessionId, colorName, cropInput) {
    const crop = normalizeCrop(cropInput);
    const source = sourcePath(sessionId, colorName);
    if (!fs.existsSync(source)) throw new Error('参考色图不存在');
    const meta = await sharp(source).metadata();
    const buffer = await sharp(source).extract(cropPixels(meta, crop)).png().toBuffer();
    return { crop, previewDataUrl: `data:image/png;base64,${buffer.toString('base64')}` };
  }

  async function applyCrop(sessionId, cropInput, { confirmAspectWarnings = false } = {}) {
    const crop = normalizeCrop(cropInput);
    const colors = fileStore.getFileLists(sessionId).colors.files;
    if (!colors.length) throw new Error('当前上传批次没有参考色图');
    const warnings = await cropWarnings(sessionId, crop);
    if (warnings.length && !confirmAspectWarnings) return { success: false, requiresConfirmation: true, warnings, crop };
    const dir = cropDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const files = {};
    for (const file of colors) {
      const meta = await sharp(file.path).metadata();
      const destination = path.join(dir, path.basename(file.name));
      const temp = `${destination}.${process.pid}.${Date.now()}.tmp${path.extname(destination) || '.png'}`;
      await sharp(file.path).extract(cropPixels(meta, crop)).toFile(temp);
      fs.renameSync(temp, destination);
      files[file.name] = { crop, appliedAt: now(), originalWidth: meta.width, originalHeight: meta.height };
    }
    writeJson(cropManifestPath(sessionId), { version: 1, appliedAt: now(), crop, files });
    return { success: true, crop, count: colors.length, warnings, files: effectiveColors(sessionId) };
  }

  function clearCrop(sessionId) {
    const dir = cropDir(sessionId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(cropManifestPath(sessionId))) fs.rmSync(cropManifestPath(sessionId), { force: true });
    return { success: true };
  }

  function clearColorState(sessionId) {
    clearCrop(sessionId);
    if (fs.existsSync(metadataPath(sessionId))) fs.rmSync(metadataPath(sessionId), { force: true });
  }

  function setMetadata(sessionId, colorName, { hex, label, source = 'manual' } = {}) {
    const name = path.basename(String(colorName || ''));
    if (!name || !fs.existsSync(sourcePath(sessionId, name))) throw new Error('参考色图不存在');
    if (hex != null && !validHex(hex)) throw new Error('HEX 格式无效');
    const data = metadata(sessionId);
    const previous = data.colors?.[name] || {};
    const next = {
      hex: hex == null ? previous.hex || null : String(hex).toUpperCase(),
      label: label == null ? previous.label || '' : String(label).trim().slice(0, 80),
      source: hex == null ? previous.source || '' : (source === 'auto' ? 'auto' : 'manual'),
      updatedAt: now()
    };
    data.colors = data.colors || {};
    data.colors[name] = next;
    writeJson(metadataPath(sessionId), data);
    return { name, ...next, changed: next.hex !== (validHex(previous.hex) ? String(previous.hex).toUpperCase() : null) || next.label !== (previous.label || '') || next.source !== (previous.source || '') };
  }

  async function ensureExtractedMetadata(sessionId) {
    const extractions = {};
    const updated = [];
    for (const file of effectiveColors(sessionId)) {
      let extracted = null;
      try { extracted = await colorEngine.extractColor(file.path); }
      catch (error) { extracted = { success: false, reason: error.message }; }
      extractions[file.name] = extracted;
      const automaticHex = validHex(extracted?.primary?.hex) ? String(extracted.primary.hex).toUpperCase() : '';
      if (automaticHex && (!file.referenceHex || file.referenceHexSource === 'auto')) {
        const metadata = setMetadata(sessionId, file.name, { hex: automaticHex, label: file.referenceColorLabel, source: 'auto' });
        if (metadata.changed) updated.push({ name: file.name, metadata });
      }
    }
    return { files: effectiveColors(sessionId), extractions, updated };
  }

  return { normalizeCrop, getEffectiveColor, effectiveColors, decoratePair, previewCrop, applyCrop, clearCrop, clearColorState, setMetadata, ensureExtractedMetadata };
};
