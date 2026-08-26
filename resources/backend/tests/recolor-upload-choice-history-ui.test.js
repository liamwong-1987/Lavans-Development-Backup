const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'recolor.html'), 'utf8');
const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');

test('参考色点击、拖放与粘贴都保留明确的添加方式', () => {
  assert.match(html, /id="clr-add-btn"[^>]*>继续添加<\/button>/);
  assert.match(html, /id="clr-crop-btn"[^>]*>[\s\S]*?裁剪后添加<\/button>/);
  assert.match(html, /id="clr-crop-input"[\s\S]*?handleReferenceCropPick/);
  assert.match(app, /if \(type === 'color'\) chooseReferenceUploadMode\(files, '已拖入'\)/);
  assert.match(app, /if \(type === 'color'\) chooseReferenceUploadMode\(\[file\], '已粘贴'\)/);
  assert.match(app, /选择参考色添加方式/);
  assert.match(app, /直接添加/);
  assert.match(app, /裁剪后添加/);
});

test('选择弹窗打开后仍保存真实文件，取消会彻底清理', () => {
  const chooserStart = app.indexOf('function chooseReferenceUploadMode');
  const chooserEnd = app.indexOf('function cancelReferenceUploadMode', chooserStart);
  const chooser = app.slice(chooserStart, chooserEnd);
  assert.ok(chooser.indexOf('openRecolorOverlay') < chooser.indexOf('pendingReferenceUploadFiles = selectedFiles'));
  assert.match(app, /function closeRecolorOverlay\(\)[\s\S]*?pendingReferenceUploadFiles = \[\]/);
});

test('裁剪确认前不加入上传区，真实裁剪框含八个控制点', () => {
  assert.match(app, /function openPendingReferenceCrop/);
  assert.match(app, /mode:'pending'/);
  assert.match(app, /确认前图片只保留在本机，不上传、不创建任务/);
  assert.match(app, /\['nw','n','ne','e','se','s','sw','w'\]/);
  assert.match(app, /确认裁剪并添加/);
});

test('历史下载使用隐藏下载链接，不再把复色页面导航走', () => {
  const historyStart = app.indexOf('function triggerRecolorDownload');
  const historyEnd = app.indexOf('function openRecolorHistoryPreview', historyStart);
  const history = app.slice(historyStart, historyEnd);
  assert.match(history, /document\.createElement\('a'\)/);
  assert.match(history, /anchor\.download = ''/);
  assert.match(history, /triggerRecolorDownload\('\/api\/recolor\/export\?'/);
  assert.doesNotMatch(history, /window\.location\.assign|location\.href\s*=/);
});
