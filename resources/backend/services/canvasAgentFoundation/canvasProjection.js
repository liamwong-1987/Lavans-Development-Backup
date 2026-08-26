const { clone, safeId } = require('./atomicJsonStore');

const STATUS_LABELS = {
  current: '当前有效',
  'needs-review': '需要复核',
  stale: '已过期',
  invalid: '无效'
};

const MODES = new Set(['session-workset', 'legacy-history']);
const CURRENT_NODE_KINDS = new Set(['image', 'video', 'audio', 'tool']);

function projectionError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function optionalId(value, label) {
  const text = String(value || '').trim();
  return text ? safeId(text, label) : '';
}

function normalizeCurrentNodeRefs(value) {
  const refs = value === undefined || value === null ? [] : value;
  if (!Array.isArray(refs) || refs.length > 100) throw projectionError('当前节点引用不合法', 'INVALID_CURRENT_NODE_REFS');
  const seen = new Set();
  return refs.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw projectionError('当前节点引用不合法', 'INVALID_CURRENT_NODE_REFS');
    const nodeId = safeId(ref.nodeId, '节点 ID');
    if (seen.has(nodeId)) throw projectionError('当前节点引用不能重复', 'DUPLICATE_CURRENT_NODE_REF');
    seen.add(nodeId);
    if (ref.workspaceScope !== 'canvas-agent') throw projectionError('Foundation 工作集只接受 canvas-agent 节点引用', 'INVALID_CURRENT_NODE_SCOPE');
    const kind = optionalId(ref.kind, '节点类型');
    if (!CURRENT_NODE_KINDS.has(kind)) throw projectionError('当前工作集只接受图片、视频、音频或工具节点', 'INVALID_CURRENT_NODE_KIND');
    return {
      nodeId,
      workspaceScope: 'canvas-agent',
      kind,
      nodeRole: optionalId(ref.nodeRole || ref.role, '节点角色'),
      toolRunId: optionalId(ref.toolRunId, 'Tool Run ID'),
      assetVersionId: optionalId(ref.assetVersionId, 'Asset Version ID'),
      parentNodeRef: optionalId(ref.parentNodeRef, '父节点引用'),
      branchRootRef: optionalId(ref.branchRootRef, '分支根引用'),
      supersedesRef: optionalId(ref.supersedesRef, '替代节点引用'),
      finalDelivery: ref.finalDelivery === true
    };
  });
}

function historyArtifact(artifactStore, dependencyGraph, scopedArtifactIds, artifact) {
    let integrity = artifactStore.verify(artifact.artifactVersionId);
    let contentPreview = '';
    if (integrity.valid) {
      try {
        contentPreview = artifactStore.readContent(artifact.artifactVersionId, { maxBytes: 12000 });
      } catch (error) {
        integrity = { valid: false, error: error.message || String(error) };
      }
    }
    const effectiveValidityState = integrity.valid ? artifact.validityState : 'invalid';
    return {
      artifactVersionId: artifact.artifactVersionId,
      logicalArtifactId: artifact.logicalArtifactId,
      artifactType: artifact.artifactType,
      version: artifact.version,
      approvalState: artifact.approvalState,
      validityState: effectiveValidityState,
      recordedValidityState: artifact.validityState,
      statusLabel: STATUS_LABELS[effectiveValidityState] || effectiveValidityState,
      locked: integrity.valid && artifact.approvalState === 'locked',
      integrity,
      displayTitle: String(artifact.metadata?.displayTitle || artifact.artifactType),
      summary: String(artifact.metadata?.summary || ''),
      contentPreview,
      reviewChecklist: Array.isArray(artifact.metadata?.reviewChecklist) ? artifact.metadata.reviewChecklist.map(String).slice(0, 12) : [],
      reviewOptions: Array.isArray(artifact.metadata?.reviewOptions) ? artifact.metadata.reviewOptions.slice(0, 8).map(item => ({ id: String(item?.id || ''), label: String(item?.label || ''), description: String(item?.description || '') })) : [],
      blockedReason: String(artifact.metadata?.blockedReason || ''),
      phaseId: String(artifact.metadata?.phaseId || ''),
      runId: String(artifact.metadata?.runId || ''),
      strategyId: String(artifact.metadata?.strategyId || ''),
      previewUrl: String(artifact.metadata?.previewUrl || ''),
      taskId: String(artifact.metadata?.taskId || ''),
      taskStatus: String(artifact.metadata?.taskStatus || ''),
      error: String(artifact.metadata?.error || ''),
      failureKind: String(artifact.metadata?.failureKind || ''),
      assetId: String(artifact.metadata?.assetId || ''),
      assetType: String(artifact.metadata?.assetType || ''),
      assetTypeLabel: String(artifact.metadata?.assetTypeLabel || ''),
      assetName: String(artifact.metadata?.assetName || ''),
      candidateNumber: Math.max(0, Number(artifact.metadata?.candidateNumber) || 0),
      testSubstitute: artifact.metadata?.testSubstitute === true,
      visualPlan: artifact.metadata?.visualPlan && typeof artifact.metadata.visualPlan === 'object' ? artifact.metadata.visualPlan : null,
      assetCandidateGroups: Array.isArray(artifact.metadata?.assetCandidateGroups) ? artifact.metadata.assetCandidateGroups.slice(0, 200) : [],
      storyboardDispatchPlan: artifact.metadata?.storyboardDispatchPlan && typeof artifact.metadata.storyboardDispatchPlan === 'object' ? artifact.metadata.storyboardDispatchPlan : null,
      storyboardGroups: Array.isArray(artifact.metadata?.storyboardGroups) ? artifact.metadata.storyboardGroups.slice(0, 80) : [],
      dispatchSheets: Array.isArray(artifact.metadata?.dispatchSheets) ? artifact.metadata.dispatchSheets.slice(0, 80) : [],
      soundProductionPlan: artifact.metadata?.soundProductionPlan && typeof artifact.metadata.soundProductionPlan === 'object' ? artifact.metadata.soundProductionPlan : null,
      soundPolicyOptions: artifact.metadata?.soundPolicyOptions && typeof artifact.metadata.soundPolicyOptions === 'object' ? artifact.metadata.soundPolicyOptions : null,
      soundPolicyDefaults: artifact.metadata?.soundPolicyDefaults && typeof artifact.metadata.soundPolicyDefaults === 'object' ? artifact.metadata.soundPolicyDefaults : null,
      selectedSoundPolicy: artifact.metadata?.selectedSoundPolicy && typeof artifact.metadata.selectedSoundPolicy === 'object' ? artifact.metadata.selectedSoundPolicy : null,
      shotProductionPackage: artifact.metadata?.shotProductionPackage && typeof artifact.metadata.shotProductionPackage === 'object' ? artifact.metadata.shotProductionPackage : null,
      shotProductionPackages: Array.isArray(artifact.metadata?.shotProductionPackages) ? artifact.metadata.shotProductionPackages.slice(0, 80) : [],
      shotVideoPlan: artifact.metadata?.shotVideoPlan && typeof artifact.metadata.shotVideoPlan === 'object' ? artifact.metadata.shotVideoPlan : null,
      shotVideoGroups: Array.isArray(artifact.metadata?.shotVideoGroups) ? artifact.metadata.shotVideoGroups.slice(0, 80) : [],
      videoCandidate: artifact.metadata?.videoCandidate && typeof artifact.metadata.videoCandidate === 'object' ? artifact.metadata.videoCandidate : null,
      promptRevision: artifact.metadata?.promptRevision && typeof artifact.metadata.promptRevision === 'object' ? artifact.metadata.promptRevision : null,
      finalDeliveryPlan: artifact.metadata?.finalDeliveryPlan && typeof artifact.metadata.finalDeliveryPlan === 'object' ? artifact.metadata.finalDeliveryPlan : null,
      finalDeliveryResult: artifact.metadata?.finalDeliveryResult && typeof artifact.metadata.finalDeliveryResult === 'object' ? artifact.metadata.finalDeliveryResult : null,
      qualityReport: artifact.metadata?.qualityReport && typeof artifact.metadata.qualityReport === 'object' ? artifact.metadata.qualityReport : null,
      subtitleUrl: String(artifact.metadata?.subtitleUrl || ''),
      deliveryFiles: Array.isArray(artifact.metadata?.deliveryFiles) ? artifact.metadata.deliveryFiles.slice(0, 20) : [],
      planArtifactVersionId: String(artifact.metadata?.planArtifactVersionId || ''),
      shotId: String(artifact.metadata?.shotId || ''),
      shotOrder: Math.max(0, Number(artifact.metadata?.shotOrder) || 0),
      frameRole: String(artifact.metadata?.frameRole || ''),
      frameRoleLabel: String(artifact.metadata?.frameRoleLabel || ''),
      affectedCount: dependencyGraph.descendantsOf(artifact.artifactVersionId).filter(item => scopedArtifactIds.has(item.artifactVersionId)).length
    };
}

function historySummary(artifacts) {
  const byValidity = {};
  const byApproval = {};
  artifacts.forEach(artifact => {
    byValidity[artifact.validityState] = (byValidity[artifact.validityState] || 0) + 1;
    byApproval[artifact.approvalState] = (byApproval[artifact.approvalState] || 0) + 1;
  });
  return {
    artifactCount: artifacts.length,
    latestCreatedAt: artifacts.reduce((latest, artifact) => Math.max(latest, Number(artifact.createdAt) || 0), 0),
    byValidity,
    byApproval
  };
}

function buildCanvasProjection(artifactStore, dependencyGraph, options = {}) {
  const mode = String(options.mode || 'session-workset').trim();
  if (!MODES.has(mode)) throw projectionError('Foundation 读取模式不合法', 'INVALID_FOUNDATION_PROJECTION_MODE');
  const rawCanvasId = String(options.canvasId || '').trim();
  if (mode === 'legacy-history' && !rawCanvasId) {
    throw projectionError('读取历史必须指定 canvasId', 'FOUNDATION_CANVAS_ID_REQUIRED');
  }
  const canvasId = rawCanvasId ? safeId(rawCanvasId, 'canvasId') : '';
  const artifacts = Array.isArray(options.artifacts) ? options.artifacts.map(clone) : [];
  if (artifacts.some(artifact => String(artifact.metadata?.canvasId || '') !== canvasId)) {
    throw projectionError('Foundation 历史产物与 canvasId 不一致', 'FOUNDATION_HISTORY_SCOPE_MISMATCH');
  }
  const summary = historySummary(artifacts);
  const base = {
    schemaVersion: 2,
    mode,
    canvasId,
    artifactCount: artifacts.length,
    historySummary: summary,
    currentNodeRefs: mode === 'session-workset' ? normalizeCurrentNodeRefs(options.currentNodeRefs) : [],
    nodes: [],
    edges: []
  };
  if (mode === 'session-workset') return clone(base);

  const scopedArtifactIds = new Set(artifacts.map(artifact => artifact.artifactVersionId));
  const historyArtifacts = artifacts.map(artifact => historyArtifact(artifactStore, dependencyGraph, scopedArtifactIds, artifact));
  const dependencies = [];
  artifacts.forEach(artifact => {
    dependencyGraph.inputsOf(artifact.artifactVersionId).forEach(ref => {
      if (scopedArtifactIds.has(ref.artifactVersionId)) dependencies.push({ from: ref.artifactVersionId, to: artifact.artifactVersionId, role: ref.role });
    });
  });
  return clone({ ...base, history: { artifacts: historyArtifacts, dependencies } });
}

module.exports = { buildCanvasProjection };
