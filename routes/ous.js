const express = require('express');
const router = express.Router();
const adService = require('../services/ad.service');
const audit = require('../services/audit.service');
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', requirePermission('ous:read'), async (req, res) => {
  try {
    const { search } = req.query;
    const ous = await adService.searchOUs(search || null);
    res.json({ success: true, count: ous.length, ous });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requirePermission('settings:manage'), async (req, res) => {
  try {
    const result = await adService.createOU(req.body);
    const performer = req.user?.username || 'unknown';
    audit.log('create', 'ou', req.body.name, result.dn, performer);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:dn', requirePermission('settings:manage'), async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.deleteOU(dn);
    const performer = req.user?.username || 'unknown';
    audit.log('delete', 'ou', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
