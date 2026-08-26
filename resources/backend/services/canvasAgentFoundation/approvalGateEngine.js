class ApprovalGateEngine {
  constructor(artifactStore, options = {}) {
    this.artifactStore = artifactStore;
    this.clock = options.clock || (() => Date.now());
  }

  requestReview(id) {
    const artifact = this._require(id);
    if (artifact.metadata?.blockedReason) throw new Error(`产物仍处于真实阻塞：${artifact.metadata.blockedReason}`);
    if (artifact.approvalState !== 'draft') throw new Error('只有草稿可以提交审核');
    return this.artifactStore.updateState(id, { approvalState: 'awaiting-review' }, 'review-requested');
  }

  approve(id) {
    const artifact = this._require(id);
    if (artifact.approvalState !== 'awaiting-review') throw new Error('只有待审核版本可以批准');
    if (artifact.validityState !== 'current') throw new Error('非当前有效版本不能批准');
    return this.artifactStore.updateState(id, { approvalState: 'approved', approvedAt: this.clock() }, 'artifact-approved');
  }

  lock(id, options = {}) {
    const artifact = this._require(id);
    if (artifact.approvalState !== 'approved') throw new Error('只有已批准版本可以锁定');
    if (artifact.validityState !== 'current') throw new Error('非当前有效版本不能锁定');
    const locked = this.artifactStore.list({ logicalArtifactId: artifact.logicalArtifactId }).filter(item => item.approvalState === 'locked' && item.artifactVersionId !== id);
    if (locked.length && options.replaceLockedVersionId !== locked[0].artifactVersionId) throw new Error('必须精确确认替换当前锁定版本');
    locked.forEach(item => this.artifactStore.updateState(item.artifactVersionId, { approvalState: 'superseded' }, 'locked-version-superseded'));
    return this.artifactStore.updateState(id, { approvalState: 'locked', lockedAt: this.clock() }, 'artifact-locked');
  }

  _require(id) {
    const artifact = this.artifactStore.get(id, { verify: false });
    if (!artifact) throw new Error('产物版本不存在');
    const validation = this.artifactStore.verify(id);
    if (!validation.valid) {
      this.artifactStore.updateState(id, { validityState: 'invalid' }, 'artifact-verification-failed');
      throw new Error(validation.error);
    }
    return artifact;
  }
}

module.exports = { ApprovalGateEngine };
