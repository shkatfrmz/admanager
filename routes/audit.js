const express = require('express');
const router = express.Router();
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', (req, res) => {
  try {
    const entries = audit.query(req.query);
    const total = audit.count(req.query);
    res.json({ success: true, count: entries.length, total, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', (req, res) => {
  try {
    const stats = audit.getStats(req.query);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.log = audit.log;
