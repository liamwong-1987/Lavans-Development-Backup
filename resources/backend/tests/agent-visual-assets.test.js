const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildVisualAssetPlan, candidatePlainText, packagePlainText, planPlainText } = require('../services/agentVisualAssetService');

const strategy = {
  image: { providerId: 'site-a', providerName: '站点甲', model: 'image-a', ratio: '9:16', quantity: 2 },
  mode: 'manual', budgetLimit: 30, currency: 'CNY', retryLimit: 1
};

function runWithMaterials(materials) {
  return {
    id: 'run-phase6', canvasId: 'canvas-phase6', materials,
    storyboardPlan: { assets: [
      { id: 'character-a', type: 'character', name: '主角', usage: '全部镜头', sourceMaterialIds: [], anchorFacts: ['成年角色'], immutableConstraints: ['脸型保持一致'] },
      { id: 'product-a', type: 'product', name: '测试产品', usage: '产品特写', sourceMaterialIds: ['product-photo'], anchorFacts: ['黄色包装'], immutableConstraints: ['包装文字不得变化'] },
      { id: 'scene-a', type: 'scene', name: '夜间餐桌', usage: '主场景', sourceMaterialIds: [], anchorFacts: ['夜间'], immutableConstraints: ['空间连续'] },
      { id: 'prop-a', type: 'prop', name: '玻璃杯', usage: '互动道具', sourceMaterialIds: [], anchorFacts: [], immutableConstraints: ['形状一致'] }
    ] }
  };
}

test('阶段6批次绑定锁定策略、输入版本、预算和每项资产数量', () => {
  const run = runWithMaterials([{ id: 'product-photo', name: '产品实拍图.jpg', kind: 'image', url: '/canvas-assets/product.jpg' }]);
  const plan = buildVisualAssetPlan(run, strategy, ['coverage-v1', 'strategy-v1']);
  assert.equal(plan.totalAssets, 4);
  assert.equal(plan.totalImages, 8);
  assert.equal(plan.maximumAuthorizedCost, 30);
  assert.deepEqual(plan.inputVersionIds, ['coverage-v1', 'strategy-v1']);
  assert.match(planPlainText(plan), /本批最高授权金额：30 元/);
  assert.match(planPlainText(plan), /正式执行会逐项建立可见任务节点/);
});

test('产品资产强制携带上传实拍图，缺图时整个批次保持阻塞', () => {
  const ready = buildVisualAssetPlan(runWithMaterials([{ id: 'product-photo', name: '产品实拍图.jpg', kind: 'image', url: '/canvas-assets/product.jpg' }]), strategy, ['locked-input']);
  const product = ready.tasks.find(item => item.assetType === 'product');
  assert.equal(product.references[0].name, '产品实拍图.jpg');
  assert.match(product.prompt, /包装、Logo、文字、结构和颜色不得凭空改写/);
  const blocked = buildVisualAssetPlan(runWithMaterials([{ id: 'product-photo', name: '品牌说明.md', kind: 'text', url: '/canvas-assets/brand.md' }]), strategy, ['locked-input']);
  assert.match(blocked.blockedReason, /缺少实拍图片/);
});

test('候选和最终资产包使用纯文字说明并明确区分测试替身', () => {
  const text = candidatePlainText({ assetTypeLabel: '角色', assetName: '主角', candidateNumber: 1, testSubstitute: true, providerName: '站点甲', model: 'image-a', ratio: '9:16', assetType: 'character' });
  assert.match(text, /无费用测试替身，不是模型生成结果/);
  assert.doesNotMatch(text, /[{}\[\]"]/);
  const packageText = packagePlainText([{ assetTypeLabel: '角色', assetName: '主角' }, { assetTypeLabel: '产品', assetName: '测试产品' }]);
  assert.match(packageText, /最后只提交一次/);
  assert.match(packageText, /不会自动进入分镜图、故事板或视频生成/);
});

test('阶段6界面包含可见预览、分组单选、一次提交、真实任务与中断接线', () => {
  const frontend = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.css'), 'utf8');
  assert.match(frontend, /visual-assets\/prepare/);
  assert.match(frontend, /visual-assets\/authorize/);
  assert.match(frontend, /\/api\/canvas-image-tasks/);
  assert.match(frontend, /item\.url && item\.kind === 'image'/);
  assert.match(frontend, /visual-assets\/attempts\/register/);
  assert.match(frontend, /visual-assets\/attempts\/record/);
  assert.match(frontend, /data-agent-asset-choice/);
  assert.match(frontend, /一次提交并锁定阶段六资产包/);
  assert.match(frontend, /phase6-cancel/);
  assert.match(frontend, /无费用测试替身，不是模型生成结果/);
  assert.match(css, /smart-agent-asset-options/);
  assert.match(css, /smart-agent-visual-preview/);
});
