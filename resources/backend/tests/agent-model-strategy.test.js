const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildModelCatalog, normalizeSelection, capabilityPlainText, modePlainText, safetyPlainText } = require('../services/agentModelStrategyService');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');

const config = {
  primaryProviderId: 'site-a',
  providers: [
    { id: 'site-a', name: '站点甲', enabled: true, image_models: ['img-a'], video_models: ['vid-a'], chat_models: ['llm-a'] },
    { id: 'site-b', name: '站点乙', enabled: true, image_models: ['img-b'], video_models: ['vid-b'] },
    { id: 'disabled', name: '禁用站点', enabled: false, image_models: ['x'], video_models: ['y'] }
  ]
};

test('模型目录只暴露启用站点和能力，不包含密钥', () => {
  const catalog = buildModelCatalog({ ...config, providers: config.providers.map(item => ({ ...item, api_key: 'secret' })) });
  assert.equal(catalog.providers.length, 2);
  assert.deepEqual(catalog.providers[0].imageModels, ['img-a']);
  assert.equal(JSON.stringify(catalog).includes('secret'), false);
});

test('设置必须从当前画布能力目录选择，自动模式仍绑定人工审核关', () => {
  const selection = normalizeSelection({ imageProviderId: 'site-b', imageModel: 'img-b', imageRatio: '1:1', imageQuantity: 4, videoProviderId: 'site-a', videoModel: 'vid-a', videoRatio: '9:16', videoQuantity: 2, mode: 'auto', budgetLimit: 50, retryLimit: 2, fallbackEnabled: true, fallbackProviderId: 'site-b', fallbackModel: 'vid-b' }, buildModelCatalog(config));
  assert.equal(selection.mode, 'auto');
  assert.equal(selection.reviewGatePolicy, 'never-cross-human-review-gates');
  assert.equal(selection.fallback.model, 'vid-b');
  assert.match(modePlainText(selection), /不能越过任何人工审核关/);
  assert.match(capabilityPlainText(selection), /站点乙/);
  assert.match(safetyPlainText(selection), /50 元/);
});

test('不允许未配置的备用站点', () => {
  assert.throws(() => normalizeSelection({ fallbackEnabled: true, fallbackProviderId: 'missing' }, buildModelCatalog(config)), /备用站点/);
});

test('付费授权精确绑定模式、备用、人工审核关和高价确认', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-strategy-'));
  const foundation = createCanvasAgentFoundation({ rootPath });
  const input = foundation.createArtifact({ logicalArtifactId: 'locked-input', artifactType: 'storyboard', operationId: 'create-locked-input', content: '已锁定分镜', extension: '.txt', metadata: { canvasId: 'canvas-a' } });
  foundation.approvalGate.requestReview(input.artifactVersionId);
  foundation.approvalGate.approve(input.artifactVersionId);
  foundation.approvalGate.lock(input.artifactVersionId);
  const request = { operationId: 'paid-batch', provider: 'site-a', model: 'vid-a', inputVersionIds: [input.artifactVersionId], quantity: 1, estimatedCost: 30, budgetLimit: 50, retryLimit: 1, executionMode: 'auto', allowFallback: true, fallbackProvider: 'site-b', fallbackModel: 'vid-b', reviewGateId: 'shot-1-review', highPriceThreshold: 20 };
  assert.throws(() => foundation.executionGuard.authorize(request), /高价批次/);
  const authorization = foundation.executionGuard.authorize({ ...request, highPriceConfirmed: true });
  assert.equal(foundation.executionGuard.assertAllowed({ ...request, highPriceConfirmed: true, authorizationId: authorization.authorizationId }).allowed, true);
  assert.throws(() => foundation.executionGuard.assertAllowed({ ...request, highPriceConfirmed: true, fallbackModel: 'other', authorizationId: authorization.authorizationId }), /旧授权失效/);
});
