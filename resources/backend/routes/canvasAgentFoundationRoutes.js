const express = require('express');
const fs = require('fs');
const path = require('path');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');

function createCanvasAgentFoundationRoutes(options = {}) {
  const router = express.Router();
  let instance = options.foundation || null;
  const foundation = () => {
    const developmentLedgerPath = path.resolve(__dirname, '../../../docs/canvas-agent/execution-ledger.json');
    const ledgerPath = options.ledgerPath || (fs.existsSync(developmentLedgerPath) ? developmentLedgerPath : undefined);
    if (!instance) instance = createCanvasAgentFoundation({ rootPath: path.join(options.outputRoot, 'agent-foundation'), ledgerPath });
    return instance;
  };
  const fail = (res, error) => res.status(400).json({ success: false, error: error.message || String(error) });

  router.get('/api/canvas-agent/foundation/status', (req, res) => {
    try { res.json({ success: true, ...foundation().status({ canvasId: String(req.query?.canvasId || '') }) }); } catch (error) { fail(res, error); }
  });

  router.post('/api/canvas-agent/foundation/artifacts', (req, res) => {
    try {
      const body = req.body || {};
      const canvasId = String(body.canvasId || '').trim();
      if (!canvasId) throw new Error('canvasId 不能为空');
      res.json({ success: true, artifact: foundation().createArtifact({ ...body, metadata: { ...(body.metadata || {}), canvasId } }) });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/canvas-agent/foundation/artifacts/:artifactVersionId/review', (req, res) => {
    try { res.json({ success: true, artifact: foundation().approvalGate.requestReview(req.params.artifactVersionId) }); } catch (error) { fail(res, error); }
  });

  router.post('/api/canvas-agent/foundation/artifacts/:artifactVersionId/approve', (req, res) => {
    try { res.json({ success: true, artifact: foundation().approvalGate.approve(req.params.artifactVersionId) }); } catch (error) { fail(res, error); }
  });

  router.post('/api/canvas-agent/foundation/artifacts/:artifactVersionId/lock', (req, res) => {
    try { res.json({ success: true, artifact: foundation().approvalGate.lock(req.params.artifactVersionId, req.body || {}) }); } catch (error) { fail(res, error); }
  });

  router.post('/api/canvas-agent/foundation/impact', (req, res) => {
    try {
      const body = req.body || {};
      res.json({ success: true, impact: foundation().impactPropagator.propagateReplacement(body.oldVersionId, body.newVersionId, body) });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/canvas-agent/foundation/execution/authorize', (req, res) => {
    try {
      const body = req.body || {};
      if (String(body.reviewGateId || '').trim().toLowerCase().startsWith('agent-session:')) {
        throw new Error('agent-session 授权只能由 AgentSession 专属路由创建');
      }
      res.json({ success: true, authorization: foundation().executionGuard.authorize(body) });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/canvas-agent/foundation/execution/check', (req, res) => {
    try { res.json({ success: true, result: foundation().executionGuard.assertAllowed(req.body || {}) }); } catch (error) { fail(res, error); }
  });

  router.getFoundation = foundation;
  return router;
}

module.exports = { createCanvasAgentFoundationRoutes };
