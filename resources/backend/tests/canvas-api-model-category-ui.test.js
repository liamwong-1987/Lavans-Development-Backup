'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '../../frontend/canvas-api-settings.html');
const i18nPath = path.resolve(__dirname, '../../frontend/smart-canvas-core/i18n/api-settings.js');

test('API 设置模型选择器显示五类并保留人工分类覆盖', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const category of ['image', 'chat', 'video', 'audio', 'unknown']) {
    assert.match(html, new RegExp(`data-cat="${category}"`));
    assert.match(html, new RegExp(`${category}ModelList`));
  }
  assert.match(html, /manualCategory \|\| automaticPickerCategory/);
  assert.match(html, /lastFetchedModelCategories\[id\][\s\S]*\|\| suggestedPickerCategory\(id\)[\s\S]*\|\| existingPickerCategory\(id, existing\)[\s\S]*\|\| 'unknown'/);
  assert.match(html, /model_category_overrides:\(item\.model_category_overrides/);
  assert.match(html, /vision_models:item\.vision_models \|\| \[\]/);
  assert.doesNotMatch(html, /else cat = 'chat'/);

  const protocolProbeStart = html.indexOf('async function probeAsync(){');
  const protocolProbeEnd = html.indexOf('async function testConnection()', protocolProbeStart);
  assert.ok(protocolProbeStart >= 0 && protocolProbeEnd > protocolProbeStart);
  const protocolProbe = html.slice(protocolProbeStart, protocolProbeEnd);
  assert.match(protocolProbe, /currentProtocol !== 'apimart'[\s\S]*\/api\/canvas\/providers\/test-connection/);
  assert.match(protocolProbe, /\/api\/canvas\/providers\/probe-async/);
  assert.doesNotMatch(protocolProbe, /applyDetectedProtocol|setFetchedModelState/);

  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(inlineScripts.length >= 2);
  inlineScripts.forEach(script => assert.doesNotThrow(() => new Function(script)));
});

test('API 设置文案明确音频和未知分类', () => {
  const source = fs.readFileSync(i18nPath, 'utf8');
  assert.match(source, /"api\.audioModels"/);
  assert.match(source, /"api\.unknownModels"/);
  assert.match(source, /image \/ chat \/ video \/ audio \/ unknown/);
});
