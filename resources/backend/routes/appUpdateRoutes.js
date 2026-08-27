const express = require('express');

function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isTrustedLocalRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = String(req.get?.('host') || '').toLowerCase();
  const origin = String(req.get?.('origin') || '').toLowerCase();
  const expectedOrigins = new Set([`http://${host}`, `https://${host}`]);
  if (!host) return false;
  if (origin) return expectedOrigins.has(origin);
  const referer = String(req.get?.('referer') || '');
  if (!referer) return false;
  try { return expectedOrigins.has(new URL(referer).origin.toLowerCase()); }
  catch (_error) { return false; }
}

module.exports = function appUpdateRoutes(options = {}) {
  const router = express.Router();
  const service = options.service;
  if (!service) throw new Error('appUpdateRoutes requires service');

  router.use('/api/app-update', (req, res, next) => {
    if (!isTrustedLocalRequest(req)) return res.status(403).json({ success: false, code: 'UPDATE_LOCAL_ORIGIN_REQUIRED', error: '更新功能只允许 Lavans 本机页面调用' });
    next();
  });

  router.get('/api/app-update/status', (_req, res) => {
    try { res.json({ success: true, ...service.status() }); }
    catch (error) { res.status(Number(error.statusCode) || 500).json({ success: false, code: error.code || 'UPDATE_STATUS_FAILED', error: error.message }); }
  });

  router.get('/api/app-update/check', async (_req, res) => {
    try { res.json({ success: true, ...(await service.check()) }); }
    catch (error) { res.status(Number(error.statusCode) || 500).json({ success: false, code: error.code || 'UPDATE_CHECK_FAILED', error: error.message }); }
  });

  router.post('/api/app-update/apply', async (req, res) => {
    try { res.json(await service.apply({ commitSha: req.body?.commitSha, version: req.body?.version })); }
    catch (error) { res.status(Number(error.statusCode) || 500).json({ success: false, code: error.code || 'UPDATE_APPLY_FAILED', error: error.message }); }
  });

  return router;
};

module.exports.isLoopbackAddress = isLoopbackAddress;
module.exports.isTrustedLocalRequest = isTrustedLocalRequest;
