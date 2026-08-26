'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const createCanvasRoutes = require('../routes/canvasRoutes');

async function withServer(outputRoot, callback, routeOptions = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(createCanvasRoutes({ ...routeOptions, outputRoot }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Skill 组合状态与确认路由复用现有服务并保留路由 Skill 身份', async t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-skill-composition-route-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const calls = [];
  const agentSkillCompositionService = {
    inspect(skillId) {
      calls.push({ method: 'inspect', skillId });
      if (skillId === 'broken-skill') {
        const error = new Error('Skill 组合身份已经漂移');
        error.statusCode = 409;
        error.code = 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH';
        throw error;
      }
      return {
        primarySkillId: skillId,
        status: 'link-required',
        dependencies: [{ id: 'brainstorming-obra-share', declaredVersion: '1.0.0' }],
        actions: ['confirm-link', 'use-without-skill']
      };
    },
    confirm(input) {
      calls.push({ method: 'confirm', input });
      return {
        idempotent: input.requestId === 'repeat-confirmation',
        composition: { primarySkillId: input.primarySkillId, status: 'ready' }
      };
    }
  };

  await withServer(outputRoot, async baseUrl => {
    const inspected = await json(await fetch(`${baseUrl}/api/canvas/agent-skills/ecommerce-video-director-skill/composition`));
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.composition.status, 'link-required');
    assert.equal(inspected.body.composition.primarySkillId, 'ecommerce-video-director-skill');

    const confirmed = await json(await fetch(`${baseUrl}/api/canvas/agent-skills/ecommerce-video-director-skill/composition/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primarySkillId: 'client-must-not-override-route',
        dependencySkillId: 'brainstorming-obra-share',
        requestId: 'confirmation-1',
        confirm: true
      })
    }));
    assert.equal(confirmed.status, 201);
    assert.equal(confirmed.body.composition.primarySkillId, 'ecommerce-video-director-skill');
    assert.deepEqual(calls.at(-1).input, {
      primarySkillId: 'ecommerce-video-director-skill',
      dependencySkillId: 'brainstorming-obra-share',
      requestId: 'confirmation-1',
      confirm: true
    });

    const replayed = await json(await fetch(`${baseUrl}/api/canvas/agent-skills/ecommerce-video-director-skill/composition/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dependencySkillId: 'brainstorming-obra-share', requestId: 'repeat-confirmation', confirm: true })
    }));
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.idempotent, true);

    const failed = await json(await fetch(`${baseUrl}/api/canvas/agent-skills/broken-skill/composition`));
    assert.equal(failed.status, 409);
    assert.equal(failed.body.code, 'AGENT_SKILL_DEPENDENCY_IDENTITY_MISMATCH');
    assert.equal(failed.body.error, 'Skill 组合身份已经漂移');
  }, { agentSkillCompositionService });
});

async function json(response) {
  const body = await response.json();
  return { status: response.status, body };
}

function skillMarkdown(name = 'persistent-custom-skill') {
  return `---\nname: ${name}\ndescription: 一个本地持久化的自定义 Skill\nversion: 1.0.0\n---\n\n# ${name}\n\n只作为聊天指令。\n`;
}

test('画布路由两阶段导入、图标读取和重启复用保持 Lavans 独立', async t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-skill-route-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const outsideSentinel = path.join(path.dirname(outputRoot), `${path.basename(outputRoot)}.outside-sentinel`);
  fs.writeFileSync(outsideSentinel, 'unchanged');
  t.after(() => { if (fs.existsSync(outsideSentinel)) fs.unlinkSync(outsideSentinel); });

  let importedId = '';
  const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await withServer(outputRoot, async baseUrl => {
    const before = await json(await fetch(`${baseUrl}/api/canvas/agent-skills`));
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.errors, [], '尚未导入自定义 Skill 时不应产生部分加载警告');
    assert.equal(before.body.skills.some(skill => skill.id === 'persistent-custom-skill'), false);

    const form = new FormData();
    form.append('files', new Blob([skillMarkdown()], { type: 'text/markdown' }), 'SKILL.md');
    form.append('files', new Blob([icon], { type: 'image/png' }), 'icon.png');
    form.append('relativePaths', JSON.stringify(['SKILL.md', 'icon.png']));
    const previewResult = await json(await fetch(`${baseUrl}/api/canvas/agent-skills/imports/preview`, { method: 'POST', body: form }));
    assert.equal(previewResult.status, 200);
    const preview = previewResult.body.preview;
    importedId = preview.suggestedSkillId;
    assert.equal(importedId, 'persistent-custom-skill');
    assert.equal(preview.fileCount, 2);
    assert.equal(preview.signatureStatus, 'unsigned-local');

    const stillHidden = await json(await fetch(`${baseUrl}/api/canvas/agent-skills`));
    assert.equal(stillHidden.body.skills.some(skill => skill.id === importedId), false, 'preview 不得登记 Skill');

    const confirmed = await json(await fetch(`${baseUrl}/api/canvas/agent-skills/imports/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ importId: preview.importId, previewHash: preview.previewHash, confirm: true, skillId: importedId })
    }));
    assert.equal(confirmed.status, 201);
    assert.equal(confirmed.body.adapter.id, importedId);
    assert.equal(confirmed.body.adapter.capabilities.executable, false);
    assert.equal(confirmed.body.adapter.ui.iconAsset, 'icon.png');

    const listed = await json(await fetch(`${baseUrl}/api/canvas/agent-skills`));
    const imported = listed.body.skills.find(skill => skill.id === importedId);
    assert.ok(imported);
    assert.equal(imported.ui.iconAsset, 'icon.png');
    assert.equal(imported.signatureStatus, 'unsigned-local');
    assert.equal(imported.executionStatus, 'instruction-only');
    assert.equal(JSON.stringify(imported).includes(outputRoot), false, '公共 DTO 不得泄漏绝对路径');

    const iconResponse = await fetch(`${baseUrl}/api/canvas/agent-skills/${encodeURIComponent(importedId)}/icon`);
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await iconResponse.arrayBuffer()), icon);
  });

  await withServer(outputRoot, async baseUrl => {
    const afterRestart = await json(await fetch(`${baseUrl}/api/canvas/agent-skills`));
    assert.ok(afterRestart.body.skills.some(skill => skill.id === importedId), '软件重启后自定义 Skill 仍可调用');
  });

  assert.equal(fs.readFileSync(outsideSentinel, 'utf8'), 'unchanged');
  const allowedRoot = path.join(outputRoot, '.state', 'canvas-agent-skills');
  const importedFiles = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else importedFiles.push(target);
    }
  }
  walk(allowedRoot);
  assert.ok(importedFiles.length > 0);
  assert.ok(importedFiles.every(file => file.startsWith(allowedRoot + path.sep)));
});
