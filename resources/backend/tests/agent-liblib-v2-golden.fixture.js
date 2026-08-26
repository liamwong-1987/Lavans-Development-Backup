'use strict';

module.exports = Object.freeze({
  schemaVersion: 1,
  source: {
    videoName: '8月24日.mp4',
    sha256: 'A28D589C7C02F0B37DA18C6D8C7C3484C8DD15BC5D8B73B750535F6BF8FDAF4C',
    durationSeconds: 427.85,
    width: 1920,
    height: 1080,
    fps: 24,
    observedSplitX: 1119,
    rightPanelShareApprox: 0.412
  },
  keyframes: [
    '00-01.000.png',
    '01-20.000.png',
    '01-22.500.png',
    '01-34.000.png',
    '02-26.000.png',
    '02-28.000.png',
    '02-52.000.png',
    '02-54.000.png',
    '03-26.000.png',
    '03-28.000.png',
    '03-40.000.png',
    '04-30.000.png',
    '04-32.000.png',
    '04-36.000.png',
    '05-10.000.png',
    '05-12.000.png',
    '05-28.000.png',
    '05-30.000.png',
    '05-38.000.png',
    '05-40.000.png',
    '06-16.000.png',
    '06-18.000.png',
    '06-28.000.png',
    '06-48.000.png',
    '07-06.000.png'
  ],
  confirmedDefaults: {
    busyMessage: 'next-safe-boundary',
    explicitStop: 'cancel-if-possible-and-monitor-remote-result',
    promptRerun: 'create-branch',
    replaceCurrent: 'move-current-pointer-only',
    deleteNode: 'detach-from-canvas-only',
    permanentDelete: 'separate-confirmation'
  },
  taskNodes: [
    { id: 'input-product', kind: 'image', role: 'input' },
    { id: 'image-character', kind: 'image', role: 'generated' },
    { id: 'image-prop', kind: 'image', role: 'generated' },
    { id: 'image-storyboard', kind: 'image', role: 'generated' },
    { id: 'video-main', kind: 'video', role: 'generated' },
    { id: 'audio-bgm', kind: 'audio', role: 'generated' },
    { id: 'tool-smart-edit', kind: 'tool', role: 'execution' },
    { id: 'video-final', kind: 'video', role: 'generated' }
  ],
  documentMessages: [
    { id: 'doc-anchor-list', kind: 'document', canvasNode: false },
    { id: 'doc-storyboard-table', kind: 'document', canvasNode: false },
    { id: 'doc-final-summary', kind: 'document', canvasNode: false }
  ],
  chatReplay: {
    session: {
      id: 'agent-session-stage2-fixture',
      canvasId: 'agent-stage2-fixture-canvas',
      skillId: 'create-product-microstory-seedance',
      title: '剧情 TVC 广告片',
      status: 'completed'
    },
    messages: [
      { id: 'message-user-brief', role: 'user', kind: 'text', content: '我要做一条品牌剧情短片', createdAt: 1 },
      { id: 'message-agent-question', role: 'assistant', kind: 'choice', content: '请选择主要发布平台', createdAt: 2 },
      { id: 'message-user-answer', role: 'user', kind: 'choice', content: '抖音、小红书', createdAt: 3 },
      { id: 'doc-anchor-list', role: 'assistant', kind: 'document', content: '创作锚点清单已保存', createdAt: 4, canvasNode: false },
      { id: 'message-tool-running', role: 'tool', kind: 'tool-status', content: '角色图片生成中', createdAt: 5 },
      { id: 'message-media-ready', role: 'assistant', kind: 'media', content: '角色图片已完成', createdAt: 6 },
      { id: 'doc-storyboard-table', role: 'assistant', kind: 'document', content: '分镜表已保存', createdAt: 7, canvasNode: false },
      { id: 'doc-final-summary', role: 'assistant', kind: 'final-receipt', content: '本次任务资产与节点回执', createdAt: 8, canvasNode: false }
    ],
    toolRuns: [
      { id: 'tool-image-character', type: 'image-generation', status: 'succeeded', provider: 'fixture-only', model: 'fixture-only' },
      { id: 'tool-video-main', type: 'video-generation', status: 'remote-unknown', provider: 'fixture-only', model: 'fixture-only' }
    ],
    stateCheckpoints: [
      { status: 'collecting', composerAvailable: true },
      { status: 'running', composerAvailable: true },
      { status: 'paused', composerAvailable: true },
      { status: 'blocked', composerAvailable: true },
      { status: 'completed', composerAvailable: true }
    ]
  },
  mediaLifecycles: [
    { nodeId: 'image-character', runningAt: 146, completedAt: 172 },
    { nodeId: 'image-prop', runningAt: 208, completedAt: 222 },
    { nodeId: 'image-storyboard', runningAt: 272, completedAt: 276 },
    { nodeId: 'video-main', runningAt: 312, completedAt: 330 },
    { nodeId: 'audio-bgm', runningAt: 340, completedAt: 378 },
    { nodeId: 'video-final', runningAt: 380, completedAt: 386 }
  ],
  checkpoints: [
    { id: 'before-send', at: 80, taskNodeCount: 0, composerAvailable: true },
    { id: 'input-sent', at: 82.5, taskNodeCount: 1, composerAvailable: true },
    { id: 'character-running', at: 154, taskNodeCount: 2, composerAvailable: true },
    { id: 'character-complete', at: 174, taskNodeCount: 2, composerAvailable: true },
    { id: 'prop-running', at: 208, taskNodeCount: 3, composerAvailable: true },
    { id: 'prop-complete', at: 222, taskNodeCount: 3, composerAvailable: true },
    { id: 'storyboard-running', at: 272, taskNodeCount: 4, composerAvailable: true },
    { id: 'storyboard-complete', at: 276, taskNodeCount: 4, composerAvailable: true },
    { id: 'main-video-running', at: 312, taskNodeCount: 5, composerAvailable: true },
    { id: 'main-video-complete', at: 330, taskNodeCount: 5, composerAvailable: true },
    { id: 'audio-running', at: 340, taskNodeCount: 6, composerAvailable: true },
    { id: 'audio-complete', at: 378, taskNodeCount: 6, composerAvailable: true },
    { id: 'composition-running', at: 380, taskNodeCount: 8, composerAvailable: true },
    { id: 'complete', at: 426, taskNodeCount: 8, composerAvailable: true }
  ],
  safety: {
    networkAllowed: false,
    realMaterialAllowed: false,
    generationRequestCount: 0,
    providerCallCount: 0,
    addedCost: 0
  }
});
