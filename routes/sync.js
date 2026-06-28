const express = require('express');
const router = express.Router();
const cache = require('../db/cache.repository');
const syncService = require('../services/sync.service');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ── GET sync status / history ─────────────────────────────────────────────────
router.get('/status', (req, res) => {
  try {
    const lastSync = cache.getLastSync();
    const history = cache.getSyncHistory(10);
    res.json({ success: true, lastSync, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST trigger a full sync (users + groups) right now ──────────────────────
router.post('/run', async (req, res) => {
  try {
    const result = await syncService.runFullSync();
    if (result?.skipped) {
      res.json({ success: false, error: result.message });
    } else {
      res.json({ success: true, message: 'Full sync completed', result });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
