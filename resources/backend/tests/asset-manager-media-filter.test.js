const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/asset-manager.js'), 'utf8');
const mediaExts = source.match(/^const CANVAS_MEDIA_EXTS = .*;$/m)?.[0];
const mediaItems = source.match(/function mediaAssetItems\(items\)\{[\s\S]*?\n\}/)?.[0];

test('素材库只接收图片、视频和音频卡片', () => {
  assert.ok(mediaExts && mediaItems, '媒体过滤函数必须保留为可验证的单一入口');
  const context = {};
  vm.runInNewContext(`${mediaExts}\n${mediaItems}\nthis.mediaAssetItems = mediaAssetItems;`, context);
  const items = [
    { name: 'image.png', url: '/canvas-assets/image.png', kind: 'image' },
    { name: 'video.mkv', url: '/canvas-assets/video.mkv', kind: 'video' },
    { name: 'voice', url: '/canvas-output/voice', mime: 'audio/mpeg', kind: 'audio' },
    { name: 'signed image', url: 'https://example.test/media', kind: 'image' },
    { name: 'final-script.md', url: '/canvas-output/final-script', kind: 'image' },
    { name: 'project.json', url: '/canvas-assets/project.json', kind: 'workflow' },
    { name: 'archive.zip', url: '/canvas-assets/archive.zip', kind: 'image' }
  ];

  assert.deepEqual(Array.from(context.mediaAssetItems(items), item => item.name), [
    'image.png',
    'video.mkv',
    'voice',
    'signed image'
  ]);
});
