const express = require('express');
const router = express.Router();
const graphService = require('../services/graph.service');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ── GET all available licenses in tenant ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const licenses = await graphService.getAvailableLicenses();
    res.json({ success: true, licenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET licenses for a specific user ─────────────────────────────────────────
router.get('/users/:upn', async (req, res) => {
  try {
    const licenses = await graphService.getUserLicenses(req.params.upn);
    res.json({ success: true, licenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST assign license to user ───────────────────────────────────────────────
router.post('/users/:upn/assign', async (req, res) => {
  try {
    const { skuId } = req.body;
    if (!skuId) return res.status(400).json({ error: 'skuId is required' });
    const result = await graphService.assignLicense(req.params.upn, skuId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE remove license from user ──────────────────────────────────────────
router.delete('/users/:upn/:skuId', async (req, res) => {
  try {
    const result = await graphService.removeLicense(req.params.upn, req.params.skuId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
