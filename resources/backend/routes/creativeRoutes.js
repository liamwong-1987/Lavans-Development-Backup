const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { getModuleConfig, updateModuleConfig, publicConfig } = require('../moduleConfigService');

const MAX_REFERENCES = 10;
const MAX_HISTORY = 200;
const ALLOWED_PRESETS = {
  '1:1-1K': { label: '正方形 1K', width: 1024, height: 1024, apiSize: '1024x1024' },
  '1:1-2K': { label: '正方形 2K', width: 2048, height: 2048, apiSize: '2048x2048' },
  '1:1-4K': { label: '正方形 4K', width: 3840, height: 3840, apiSize: '3840x3840' },
  '16:9-1K': { label: '横屏 1K', width: 1920, height: 1080, apiSize: '1920x1080' },
  '16:9-2K': { label: '横屏 2K', width: 2560, height: 1440, apiSize: '2560x1440' },
  '16:9-4K': { label: '横屏 4K', width: 3840, height: 2160, apiSize: '3840x2160' },
  '9:16-1K': { label: '竖屏 1K', width: 1080, height: 1920, apiSize: '1080x1920' },
  '9:16-2K': { label: '竖屏 2K', width: 1440, height: 2560, apiSize: '1440x2560' },
  '9:16-4K': { label: '竖屏 4K', width: 2160, height: 3840, apiSize: '2160x3840' }
};

module.exports = function creativeRoutes() {
  const router = express.Router();
  const resourcesRoot = path.resolve(__dirname, '..');
  const uploadRoot = path.join(resourcesRoot, 'uploads', 'creative');
  const outputRoot = path.join(resourcesRoot, 'output', 'creative-history');
  const historyPath = path.join(__dirname, 'creative-history.json');
  [uploadRoot, outputRoot].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });
  router.use('/creative-output', express.static(outputRoot));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadRoot),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
        cb(null, `ref_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
      }
    }),
    limits: { files: MAX_REFERENCES, fileSize: 30 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = /^image\/(jpeg|png|webp|bmp|gif)$/i.test(file.mimetype || '');
      cb(ok ? null : new Error('只支持 JPG、PNG、WEBP、BMP、GIF 图片'), ok);
    }
  });

  function readHistory() {
    try { return fs.existsSync(historyPath) && Array.isArray(JSON.parse(fs.readFileSync(historyPath, 'utf8'))) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : []; } catch (_error) { return []; }
  }
  function writeHistory(items) { fs.writeFileSync(historyPath, JSON.stringify(items.slice(0, MAX_HISTORY), null, 2), 'utf8'); }
  function safeName(value) { return String(value || 'creative').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.+$/g, '').slice(0, 80) || 'creative'; }
  function imageMime(file) { return file?.mimetype || 'image/png'; }
  function presetFromRequest(value) { const preset = ALLOWED_PRESETS[String(value || '')]; if (!preset) throw new Error('请选择有效的输出分辨率'); return preset; }
  function expandReferences(prompt, files) {
    const missing = [];
    const expanded = String(prompt || '').trim().replace(/@图(\d+)/g, (_match, rawIndex) => {
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 1 || index > files.length) { missing.push(`图${rawIndex}`); return `图${rawIndex}`; }
      return `参考图${index}（${files[index - 1].originalname}）`;
    });
    if (missing.length) throw new Error(`提示词引用不存在的图片：${missing.join('、')}`);
    const mapping = files.length ? files.map((file, index) => `参考图${index + 1}：${file.originalname}`).join('\n') : '本次没有上传参考图';
    return `参考图对应关系：\n${mapping}\n\n创作要求：\n${expanded}`;
  }
  function extractImage(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) { const part = content.find(item => item?.image_url?.url || item?.data || item?.b64_json); if (part) return part.image_url?.url || part.data || part.b64_json; }
    if (typeof content === 'string') {
      if (content.startsWith('http') || content.startsWith('data:image/')) return content;
      const markdown = content.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
      if (markdown) return markdown[1];
      try { const parsed = JSON.parse(content); return parsed.url || parsed.b64_json || parsed.data || null; } catch (_error) {}
    }
    return data?.data?.[0]?.b64_json || data?.data?.[0]?.url || data?.url || data?.candidates?.[0]?.content?.parts?.find(part => part.inlineData || part.inline_data)?.inlineData?.data || null;
  }
  async function fetchImageBuffer(value) {
    if (!value) throw new Error('模型没有返回图片');
    const text = String(value); const base64 = text.replace(/^data:image\/[^;]+;base64,/, '');
    if (base64 !== text || /^[A-Za-z0-9+/=]{100,}$/.test(text)) return Buffer.from(base64, 'base64');
    if (!/^https?:\/\//i.test(text)) throw new Error('模型返回了无法识别的图片数据');
    const response = await fetch(text);
    if (!response.ok) throw new Error(`下载生成图片失败：HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  async function callGemini(config, prompt, files, preset) {
    const parts = [{ text: prompt }];
    for (const file of files) parts.push({ inline_data: { mime_type: imageMime(file), data: fs.readFileSync(file.path).toString('base64') } });
    const sizeLevel = preset.width >= 3840 || preset.height >= 3840 ? '4K' : preset.width >= 2048 || preset.height >= 2048 ? '2K' : '1K';
    const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: preset.width / preset.height === 1 ? '1:1' : preset.width > preset.height ? '16:9' : '9:16', imageSize: sizeLevel } } };
    const endpoint = `${config.baseUrl.replace(/\/v1$/, '')}/v1beta/models/${config.imageModel}:generateContent`;
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text(); let data = {}; try { data = JSON.parse(text); } catch (_error) {}
    if (!response.ok) throw new Error(data?.error?.message || text.slice(0, 500) || `生成失败：HTTP ${response.status}`);
    const inline = data?.candidates?.[0]?.content?.parts?.find(part => part.inlineData || part.inline_data);
    return fetchImageBuffer(inline?.inlineData?.data || inline?.inline_data?.data);
  }
  async function callOpenAICompatible(config, prompt, files, preset) {
    let response;
    if (files.length) {
      const form = new FormData(); form.append('model', config.imageModel); form.append('prompt', prompt); form.append('size', preset.apiSize); form.append('n', '1');
      for (const file of files) form.append('image', new Blob([fs.readFileSync(file.path)], { type: imageMime(file) }), file.originalname);
      response = await fetch(`${config.baseUrl}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form });
    } else {
      response = await fetch(`${config.baseUrl}/images/generations`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.imageModel, prompt, size: preset.apiSize, n: 1 }) });
    }
    const text = await response.text(); let data = {}; try { data = JSON.parse(text); } catch (_error) {}
    if (!response.ok) throw new Error(data?.error?.message || text.slice(0, 500) || `生成失败：HTTP ${response.status}`);
    return fetchImageBuffer(extractImage(data));
  }
  async function generate(config, prompt, files, preset) { return /gemini-.*image/i.test(config.imageModel) ? callGemini(config, prompt, files, preset) : callOpenAICompatible(config, prompt, files, preset); }

  router.get('/api/creative/config', (_req, res) => res.json({ success: true, config: publicConfig(getModuleConfig('creative')) }));
  router.post('/api/creative/config', (req, res) => {
    try { res.json({ success: true, config: publicConfig(updateModuleConfig('creative', req.body || {})) }); }
    catch (error) { res.status(400).json({ success: false, error: error.message || '创作接口配置保存失败' }); }
  });
  router.get('/api/creative/options', (_req, res) => res.json({ success: true, maxReferences: MAX_REFERENCES, presets: ALLOWED_PRESETS }));
  function historyKey(item) { return String(item?.id || item?.createdAt || ''); }
  function deleteCreativeHistory(key) {
    const history = readHistory();
    const item = history.find(entry => historyKey(entry) === String(key || ''));
    if (!item) return { success: false, status: 404, error: '创作记录不存在' };
    if (item.outputPath && fs.existsSync(item.outputPath)) {
      try { fs.unlinkSync(item.outputPath); }
      catch (error) {
        if (fs.existsSync(item.outputPath)) return { success: false, status: 500, error: `历史记录已找到，但输出文件删除失败：${error.message}` };
      }
    }
    writeHistory(history.filter(entry => entry !== item));
    return { success: true, item };
  }

  router.get('/api/creative/history', (_req, res) => res.json({ success: true, history: readHistory().map(item => ({ ...item, historyTimestamp: historyKey(item), outputUrl: item.outputUrl || `/creative-output/${encodeURIComponent(path.basename(item.outputPath || ''))}` })) }));
  router.post('/api/history/delete', (req, res) => {
    const result = deleteCreativeHistory(req.body?.timestamp);
    if (!result.success) return res.status(result.status).json({ success: false, error: result.error });
    res.json({ success: true });
  });
  router.delete('/api/creative/history/:id', (req, res) => {
    const result = deleteCreativeHistory(req.params.id);
    if (!result.success) return res.status(result.status).json({ success: false, error: result.error });
    res.json({ success: true });
  });
  router.post('/api/creative/generate', (req, res) => {
    upload.array('references', MAX_REFERENCES)(req, res, async error => {
      const files = req.files || [];
      if (error) return res.status(400).json({ success: false, error: error.message });
      try {
        const config = getModuleConfig('creative');
        if (!config.apiKey) throw new Error('创作生成尚未配置 API Key');
        if (files.length > MAX_REFERENCES) throw new Error(`最多支持 ${MAX_REFERENCES} 张参考图`);
        const prompt = String(req.body.prompt || '').trim(); if (!prompt) throw new Error('请输入创作提示词');
        const preset = presetFromRequest(req.body.preset); const expandedPrompt = expandReferences(prompt, files);
        const id = `creative_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; const targetPath = path.join(outputRoot, `${safeName(id)}.png`);
        try { await sharp(await generate(config, expandedPrompt, files, preset)).resize(preset.width, preset.height, { fit: 'fill' }).png().toFile(targetPath); }
        finally { for (const file of files) { try { fs.unlinkSync(file.path); } catch (_error) {} } }
        const metadata = await sharp(targetPath).metadata(); if (metadata.width !== preset.width || metadata.height !== preset.height) throw new Error('输出尺寸校验失败');
        const item = { id, createdAt: new Date().toISOString(), prompt, expandedPrompt, references: files.map((file, index) => ({ index: index + 1, name: file.originalname })), preset: req.body.preset, resolution: preset.label, width: metadata.width, height: metadata.height, status: 'completed', model: config.imageModel, baseUrl: config.baseUrl, outputPath: targetPath, outputUrl: `/creative-output/${encodeURIComponent(path.basename(targetPath))}` };
        writeHistory([item, ...readHistory()]); res.json({ success: true, item });
      } catch (generationError) {
        for (const file of files) { try { fs.unlinkSync(file.path); } catch (_error) {} }
        res.status(500).json({ success: false, error: generationError.message || '创作生成失败' });
      }
    });
  });
  return router;
};
