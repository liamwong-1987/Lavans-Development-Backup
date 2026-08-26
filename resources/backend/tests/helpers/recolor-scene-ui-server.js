const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SCENES = Object.freeze([
  'running', 'paused', 'prompt', 'history', 'billing', 'compare', 'export',
  'crop', 'palette', 'start', 'redo', 'clear', 'rebind', 'empty'
]);
const THEMES = Object.freeze(['light', 'dark']);
const DEFAULT_SCENE = 'running';
const FIXED_NOW = '2026-08-23T06:00:00.000Z';
const frontend = path.resolve(__dirname, '..', '..', '..', 'frontend');

const colors = Object.freeze([
  ['森林绿', '#566E51'],
  ['陶土橙', '#B46B38'],
  ['暮光紫', '#8B5BA7'],
  ['曜石黑', '#24262B']
]);

const syntheticSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#eee9e2"/><stop offset="1" stop-color="#b8c2aa"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><rect x="190" y="145" width="260" height="210" rx="52" fill="#566e51"/><rect x="225" y="340" width="32" height="160" fill="#6d4c35"/><rect x="383" y="340" width="32" height="160" fill="#6d4c35"/><circle cx="320" cy="250" r="36" fill="#8ca17f" opacity=".55"/></svg>');

function makeTasks(profile = 'running') {
  if (profile === 'empty' || profile === 'start') return [];
  return Array.from({ length: 24 }, (_, index) => {
    let state = index < 18 ? 'completed' : index < 22 ? 'running' : 'error';
    if (profile === 'paused') state = index < 18 ? 'completed' : index < 22 ? 'running' : 'pending';
    if (profile === 'rebind' && index >= 12) state = 'pending';
    const color = colors[index % colors.length];
    const templateNumber = Math.floor(index / colors.length) + 1;
    const template = `商品场景图-${templateNumber}.png`;
    const completed = state === 'completed';
    const submitted = ['completed', 'running', 'error'].includes(state);
    const apiAttempts = submitted ? 1 + (profile === 'running' && index < 5 ? 1 : 0) : 0;
    return {
      id: `fixture-task-${String(index + 1).padStart(2, '0')}`,
      order: index + 1,
      queueSequence: index + 1,
      template,
      templateNameWithoutExt: template.replace(/\.png$/, ''),
      templatePath: template,
      colorRef: `${color[0]}.png`,
      colorNameWithoutExt: color[0],
      colorPath: `${color[0]}.png`,
      referenceHex: color[1],
      executionStatus: state,
      runtimeStatus: state === 'running' ? 'awaiting_remote' : null,
      generationSubmissionState: completed ? 'resolved' : state === 'running' ? 'submitted' : state === 'error' ? 'failed' : 'not_submitted',
      output: completed ? `images/fixture-result-${index + 1}.jpg` : '',
      resultVersion: completed ? 1 : 0,
      exportedAt: index < 4 ? FIXED_NOW : null,
      exportedResultVersion: index < 4 ? 1 : 0,
      apiAttempts,
      costFen: apiAttempts * 8,
      elapsedMs: completed ? 48000 + index * 1200 : null,
      error: state === 'error' ? '接口响应超时' : null,
      modelSnapshot: profile === 'rebind' && index >= 12 ? '已停用模型' : 'Seedream 4.0',
      providerIdSnapshot: 'local-scene-fixture',
      lockedUnitPriceFen: 8,
      qualityStatus: completed ? 'passed' : 'review_required',
      uploadBatchId: index < 12 ? 'upload-fixture-A' : 'upload-fixture-B'
    };
  });
}

function countTasks(tasks) {
  const count = status => tasks.filter(task => task.executionStatus === status).length;
  const completed = count('completed');
  const failed = count('error') + count('failed');
  const running = count('running');
  const pending = count('pending');
  const interrupted = count('interrupted');
  const apiAttempts = tasks.reduce((sum, task) => sum + Number(task.apiAttempts || 0), 0);
  return {
    total: tasks.length,
    pending,
    running,
    completed,
    success: completed,
    failed,
    cancelled: 0,
    interrupted,
    done: completed + failed,
    costFen: apiAttempts * 8,
    apiAttempts
  };
}

function makeBatch(scene) {
  if (scene === 'start') return null;
  const profile = scene === 'paused' || scene === 'empty' || scene === 'rebind' ? scene : 'running';
  const tasks = makeTasks(profile);
  const active = profile === 'running';
  return {
    batchId: `fixture-${profile}`,
    status: profile === 'running' ? 'running' : profile === 'paused' || profile === 'rebind' ? 'paused' : profile === 'empty' ? 'empty' : 'ready',
    active,
    userPauseRequested: false,
    systemPauseRequested: profile === 'paused' || profile === 'rebind',
    pauseReason: profile === 'rebind' ? 'model_unavailable' : profile === 'paused' ? 'global_api_error' : null,
    unavailableBinding: profile === 'rebind' ? { providerId: 'local-scene-fixture', model: '已停用模型', detectedAt: FIXED_NOW } : null,
    healthCheckConsecutive: 0,
    lastHealthCheckError: profile === 'paused' ? '验收夹具：无费用检测尚未通过' : null,
    concurrency: 8,
    createdAt: '2026-08-23T05:26:00.000Z',
    startedAt: '2026-08-23T05:26:00.000Z',
    updatedAt: FIXED_NOW,
    providerIdSnapshot: 'local-scene-fixture',
    modelSnapshot: profile === 'rebind' ? '已停用模型' : 'Seedream 4.0',
    lockedUnitPriceFen: 8,
    costPerCallFenSnapshot: 8,
    totals: countTasks(tasks),
    tasks
  };
}

function makeReferences() {
  return colors.map((color, index) => ({
    name: `${color[0]}.png`,
    referenceHex: color[1],
    referenceColorLabel: color[0],
    cropApplied: index === 1,
    crop: index === 1 ? { x: 0.12, y: 0.1, width: 0.76, height: 0.76 } : null,
    primary: { hex: color[1], ratio: 0.42 },
    candidates: [
      { hex: color[1], ratio: 0.42 },
      { hex: colors[(index + 1) % colors.length][1], ratio: 0.21 },
      { hex: '#D8C9AF', ratio: 0.14 },
      { hex: '#2C2926', ratio: 0.09 },
      { hex: '#F2E8D6', ratio: 0.08 },
      { hex: '#87775C', ratio: 0.06 }
    ]
  }));
}

function imageUrl(kind, name) {
  return `/uploads/sessions/fixture/${kind}/${encodeURIComponent(name)}`;
}

function makeHistory() {
  return makeTasks('running').filter(task => task.executionStatus === 'completed').map(task => ({
    id: `history-${task.id}`,
    taskId: task.id,
    batchId: 'fixture-running',
    uploadBatchId: task.uploadBatchId,
    templateName: task.templateNameWithoutExt,
    colorName: task.colorNameWithoutExt,
    templateUrl: imageUrl('templates', task.template),
    resultUrl: `/output/fixture-running/${task.output}`,
    colorUrl: imageUrl('colors', task.colorRef),
    referenceHex: task.referenceHex,
    generatedAt: FIXED_NOW,
    exportedAt: task.exportedAt
  }));
}

function makeScanPairs() {
  return Array.from({ length: 24 }, (_, index) => {
    const color = colors[index % colors.length];
    const templateNumber = Math.floor(index / colors.length) + 1;
    return {
      id: `fixture-pair-${index + 1}`,
      templateName: `商品场景图-${templateNumber}.png`,
      templateNameWithoutExt: `商品场景图-${templateNumber}`,
      colorName: `${color[0]}.png`,
      colorNameWithoutExt: color[0],
      referenceHex: color[1],
      model: index < 18 ? 'Seedream 4.0' : 'GPT Image'
    };
  });
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((result, pair) => {
    const separator = pair.indexOf('=');
    if (separator < 0) return result;
    result[pair.slice(0, separator).trim()] = decodeURIComponent(pair.slice(separator + 1).trim());
    return result;
  }, {});
}

function resolveFixture(req, url) {
  const cookies = parseCookies(req);
  const requestedScene = url.searchParams.get('scene');
  const requestedTheme = url.searchParams.get('theme');
  const scene = requestedScene || cookies.recolor_fixture_scene || DEFAULT_SCENE;
  const theme = requestedTheme || cookies.recolor_fixture_theme || 'light';
  return { scene, theme, requestedScene, requestedTheme };
}

function fixtureBootstrap(scene, theme) {
  return `<script data-recolor-scene-fixture>(function(){
    const scene=${JSON.stringify(scene)};
    const theme=${JSON.stringify(theme)};
    document.body.dataset.fixtureScene=scene;
    window.addEventListener('error',event=>{ document.body.dataset.fixtureLastError=String(event.message||event.error||'unknown error'); });
    window.addEventListener('unhandledrejection',event=>{ document.body.dataset.fixtureLastError=String(event.reason?.message||event.reason||'unhandled rejection'); });
    localStorage.setItem('studio_theme',theme);
    if(window.StudioTheme) window.StudioTheme.set(theme);
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function waitFor(check){ for(let i=0;i<120;i++){ const value=check(); if(value)return value; await sleep(100); } return null; }
    async function hydrateUploadCards(){
      if(typeof filesStore==='object'){
        filesStore.template.length=0;
        filesStore.color.length=0;
        if(typeof renderUploadUI==='function'){
          renderUploadUI('template');
          renderUploadUI('color');
        }
      }
      if(scene==='empty') return;
      const blob=await fetch('/uploads/fixture/upload-card.svg').then(response=>response.blob());
      const templates=Array.from({length:6},(_,index)=>new File([blob],'商品场景图-'+(index+1)+'.png',{type:'image/svg+xml'}));
      const references=['森林绿.png','陶土橙.png','暮光紫.png','曜石黑.png'].map(name=>new File([blob],name,{type:'image/svg+xml'}));
      if(typeof addFiles==='function'){
        addFiles('template',templates,{silent:true,deferScan:true});
        addFiles('color',references,{silent:true,deferScan:true});
      }
    }
    async function openScene(){
      document.body.dataset.fixtureSceneStatus='pending';
      await hydrateUploadCards();
      if(['running','paused','empty'].includes(scene)){ document.body.dataset.fixtureSceneStatus='state'; return; }
      if(scene==='rebind'){
        const entry=await waitFor(()=>document.getElementById('recolor-pause-rebind') && !document.getElementById('recolor-pause-rebind').hidden && document.getElementById('recolor-pause-rebind'));
        if(!entry){ document.body.dataset.fixtureSceneStatus='entry-missing'; return; }
        entry.click();
        const modal=await waitFor(()=>document.querySelector('.recolor-workbench-modal.scene-rebind'));
        const preview=await waitFor(()=>document.querySelector('.rebind-preview-status.ready'));
        document.body.dataset.fixtureSceneStatus=modal&&preview?'opened':'preview-missing';
        return;
      }
      const entries={
        prompt:'[aria-label="提示词设置"]',
        history:'[aria-label="历史结果"]',
        billing:'#cost-note',
        compare:'.task-row img[alt="生成图"]',
        export:'#ba-export',
        palette:'#uc-clr .uc-info',
        start:'#ba-run',
        redo:'.task-row-btn.retry',
        clear:'#ba-soft-reset'
      };
      if(scene==='crop'){
        const input=await waitFor(()=>document.getElementById('clr-crop-input'));
        if(!input){ document.body.dataset.fixtureSceneStatus='entry-missing'; return; }
        const blob=await fetch('/uploads/fixture/reference.svg').then(response=>response.blob());
        const transfer=new DataTransfer();
        ['森林绿.png','陶土橙.png','暮光紫.png','曜石黑.png'].forEach(name=>transfer.items.add(new File([blob],name,{type:'image/svg+xml'})));
        input.files=transfer.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
      } else {
        const selector=entries[scene];
        if(scene==='prompt') await waitFor(()=>document.getElementById('prompt-modal'));
        if(scene==='billing') await waitFor(()=>window.__currentBatch && document.getElementById('cost-modal'));
        const entry=await waitFor(()=>selector && document.querySelector(selector));
        if(!entry){ document.body.dataset.fixtureSceneStatus='entry-missing'; return; }
        await sleep(350);
        document.querySelector(selector)?.click();
      }
      await sleep(250);
      document.body.dataset.fixtureSceneStatus='opened';
    }
    window.addEventListener('load',()=>openScene().catch(error=>{ document.body.dataset.fixtureSceneStatus='error'; console.error('[recolor fixture]',error); }),{once:true});
  })();</script>`;
}

function json(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { resolve({}); }
    });
  });
}

function createRecolorSceneServer() {
  const requests = [];
  const batches = new Map();
  const referencesBySession = new Map();
  let metadataWrites = 0;
  const batchFor = scene => {
    if (!batches.has(scene)) batches.set(scene, makeBatch(scene));
    return batches.get(scene);
  };
  const referencesFor = sessionId => {
    const key = String(sessionId || 'fixture-reference-session');
    if (!referencesBySession.has(key)) referencesBySession.set(key, makeReferences());
    return referencesBySession.get(key);
  };
  return http.createServer(async (req, res) => {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url, `http://${host}`);
    const fixture = resolveFixture(req, url);

    if ((fixture.requestedScene && !SCENES.includes(fixture.requestedScene)) || !SCENES.includes(fixture.scene)) {
      return json(res, { success: false, error: 'unknown fixture scene', allowed: SCENES }, 400);
    }
    if ((fixture.requestedTheme && !THEMES.includes(fixture.requestedTheme)) || !THEMES.includes(fixture.theme)) {
      return json(res, { success: false, error: 'unknown fixture theme', allowed: THEMES }, 400);
    }

    if (url.pathname === '/__fixture/state') {
      return json(res, {
        success: true,
        scene: fixture.scene,
        theme: fixture.theme,
        blocked: false,
        blocker: null,
        metadataWrites,
        providerGenerationCalls: 0,
        addedCostFen: 0,
        requests: requests.slice()
      });
    }

    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: req.method, path: url.pathname, scene: fixture.scene });
      const dangerous = url.pathname === '/api/generate-v2'
        || url.pathname === '/api/reset-all'
        || url.pathname === '/api/cancel'
        || /\/api\/batches\/[^/]+\/(retry-task|resume|cancel)$/.test(url.pathname);
      if (dangerous) return json(res, { success: false, error: 'fixture blocked dangerous request' }, 409);

      const batch = batchFor(fixture.scene);
      const rebindPath = batch && `/api/batches/${batch.batchId}/pending-model-rebind`;
      if (fixture.scene === 'rebind' && url.pathname === `${rebindPath}/preview` && req.method === 'GET') {
        const target = { providerId: String(url.searchParams.get('toProviderId') || ''), model: String(url.searchParams.get('toModel') || '') };
        const eligible = batch.tasks.filter(task => task.executionStatus === 'pending' && task.providerIdSnapshot === batch.unavailableBinding.providerId && task.modelSnapshot === batch.unavailableBinding.model && !task.runtimeStatus && !task.apiAttempts && !task.costFen);
        return json(res, { success: true, preview: {
          batchId: batch.batchId,
          from: batch.unavailableBinding,
          to: target,
          eligibleTaskIds: eligible.map(task => task.id),
          eligibleCount: eligible.length,
          protectedCount: batch.tasks.length - eligible.length,
          protectedCounts: { binding_mismatch: batch.tasks.length - eligible.length },
          oldCostsFen: [8],
          previewToken: `fixture-preview:${target.providerId}:${target.model}`,
          bindingRevision: 0,
          canResume: false,
          pricing: { selectionRequired: true, currentEstimatesFen: [8], targetEstimateFen: null }
        }});
      }
      if (fixture.scene === 'rebind' && url.pathname === rebindPath && req.method === 'POST') {
        const body = await readJsonBody(req);
        const expectedToken = `fixture-preview:${body?.to?.providerId || ''}:${body?.to?.model || ''}`;
        if (!body.requestId || body.previewToken !== expectedToken || !['keep-current-estimate', 'replace-estimate'].includes(body?.pricing?.mode)) {
          return json(res, { success: false, code: 'REBIND_PREVIEW_STALE', error: '验收夹具拒绝无效改绑确认' }, 409);
        }
        const updatedBatch = makeBatch('rebind');
        const changed = updatedBatch.tasks.filter(task => task.executionStatus === 'pending' && task.modelSnapshot === '已停用模型');
        changed.forEach(task => {
          task.providerIdSnapshot = body.to.providerId;
          task.modelSnapshot = body.to.model;
          if (body.pricing.mode === 'replace-estimate') task.costPerCallFenSnapshot = body.pricing.targetCostPerCallFen;
        });
        updatedBatch.lastModelRebind = { updatedCount: changed.length, to: body.to };
        updatedBatch.bindingRevision = 1;
        updatedBatch.totals = countTasks(updatedBatch.tasks);
        return json(res, { success: true, requestId: body.requestId, updatedCount: changed.length, protectedCount: updatedBatch.tasks.length - changed.length, bindingRevision: 1, replayed: false, remainsPaused: true, batch: updatedBatch });
      }
      if (url.pathname === '/api/recolor/reference-colors/metadata' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const sessionId = String(body.sessionId || '').trim();
        const colorName = String(body.colorName || body.name || '').trim();
        const hex = String(body.hex || body.referenceHex || '').trim().toUpperCase();
        const label = String(body.label || body.referenceColorLabel || '').trim();
        if (!sessionId || !colorName || !/^#[0-9A-F]{6}$/.test(hex)) {
          return json(res, { success: false, error: 'invalid local reference metadata' }, 400);
        }
        const references = referencesFor(sessionId);
        const colorStem = colorName.replace(/\.[^.]+$/, '').toLowerCase();
        const reference = references.find(item => String(item.name || '').toLowerCase() === colorName.toLowerCase() || String(item.name || '').replace(/\.[^.]+$/, '').toLowerCase() === colorStem);
        if (!reference) return json(res, { success: false, error: 'reference not found in fixture session' }, 404);
        reference.referenceHex = hex;
        reference.referenceColorLabel = label || reference.referenceColorLabel || colorStem;
        for (const storedBatch of batches.values()) {
          (storedBatch?.tasks || []).forEach(task => {
            const taskSessionId = task.uploadBatchId || task.sessionId || '';
            const taskColorName = task.colorRef || task.colorName || task.colorNameWithoutExt || '';
            const sameName = String(taskColorName).toLowerCase() === colorName.toLowerCase() || String(taskColorName).replace(/\.[^.]+$/, '').toLowerCase() === colorStem;
            if (taskSessionId === sessionId && sameName) {
              task.referenceHex = hex;
              task.referenceColorLabel = reference.referenceColorLabel;
            }
          });
          if (storedBatch) storedBatch.totals = countTasks(storedBatch.tasks || []);
        }
        metadataWrites += 1;
        return json(res, { success: true, sessionId, reference, metadata: { hex, label: reference.referenceColorLabel } });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, { success: false, error: 'fixture is read-only' }, 405, { allow: 'GET, HEAD' });

      if (url.pathname === '/api/config') return json(res, {
        success: true,
        config: { theme: fixture.theme, promptProfiles: [], selectedPromptProfileId: 'bedding', costPerCallFen: 8 },
        api_providers: [
          { id: 'local-scene-fixture', name: '本地验收服务', has_key: true, api_key: true, image_models: ['GPT Image', 'Seedream 4.0'] }
        ]
      });
      if (url.pathname === '/api/batches/latest') return json(res, { success: true, batch });
      if (batch && url.pathname === `/api/batches/${batch.batchId}`) return json(res, { success: true, batch });
      if (url.pathname === '/api/logs/recent') return json(res, {
        ok: true,
        logs: [
          { timestamp: FIXED_NOW, level: 'success', message: '任务 fixture-task-18 已写入最新结果' },
          { timestamp: FIXED_NOW, level: 'info', message: '本地验收夹具已载入，不连接 Provider' },
          { timestamp: FIXED_NOW, level: 'warning', message: '场景数据只存在于当前测试进程' },
          { timestamp: FIXED_NOW, level: 'error', message: '任务 fixture-task-24 接口响应超时' }
        ]
      });
      if (url.pathname === '/api/scan') {
        const pairs = makeScanPairs();
        return json(res, { success: true, sessionId: 'fixture-reference-session', totalPairs: pairs.length, pairs });
      }
      if (url.pathname === '/api/recolor/history') return json(res, { success: true, items: makeHistory() });
      if (url.pathname === '/api/recolor/reference-colors') {
        const sessionId = String(url.searchParams.get('sessionId') || 'fixture-reference-session');
        return json(res, { success: true, sessionId, references: referencesFor(sessionId) });
      }
      if (url.pathname === '/api/recolor/export/options') return json(res, {
        success: true,
        total: 18,
        uploads: ['upload-fixture-A', 'upload-fixture-B'],
        colors: colors.map(color => color[0]),
        colorOptions: colors.map(color => ({ name: color[0], referenceHex: color[1] })),
        templates: Array.from({ length: 6 }, (_, index) => `商品场景图-${index + 1}`)
      });
      return json(res, { success: false, error: 'fixture endpoint not defined' }, 404);
    }

    if (url.pathname.startsWith('/output/') || url.pathname.startsWith('/uploads/')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(syntheticSvg);
    }

    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^[/\\]+/, '');
    const file = path.resolve(frontend, relative);
    if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-store' };
    if (fixture.requestedScene || fixture.requestedTheme) {
      headers['set-cookie'] = [
        `recolor_fixture_scene=${encodeURIComponent(fixture.scene)}; Path=/; SameSite=Strict`,
        `recolor_fixture_theme=${encodeURIComponent(fixture.theme)}; Path=/; SameSite=Strict`
      ];
    }
    if (ext === '.html') {
      let html = fs.readFileSync(file, 'utf8');
      if (path.basename(file).toLowerCase() === 'recolor.html') html = html.replace('</body>', `${fixtureBootstrap(fixture.scene, fixture.theme)}\n</body>`);
      res.writeHead(200, headers);
      return res.end(html);
    }
    res.writeHead(200, headers);
    return fs.createReadStream(file).pipe(res);
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || 41740);
  const server = createRecolorSceneServer();
  server.listen(port, '127.0.0.1', () => console.log(`recolor-scene-ui http://127.0.0.1:${port}`));
}

module.exports = {
  SCENES,
  THEMES,
  createRecolorSceneServer,
  makeBatch,
  makeHistory,
  makeReferences,
  makeScanPairs
};
