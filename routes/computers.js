const express = require('express');
const router = express.Router();
const adService = require('../services/ad.service');
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/auth');

const cache = require('../db/cache.repository');

router.use(authMiddleware);

router.get('/', requirePermission('computers:read'), async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));

    let total;
    let computers;
    if (search) {
      // Search uses live AD for flexibility, but we report total from results
      computers = await adService.searchComputers(search);
      total = computers.length;
      const start = (pageNum - 1) * pageSize;
      computers = computers.slice(start, start + pageSize);
    } else {
      total = cache.getTotalComputersCount();
      computers = cache.getAllComputers(pageSize, (pageNum - 1) * pageSize);
    }

    res.json({
      success: true,
      count: computers.length,
      total,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      computers
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name', requirePermission('computers:read'), async (req, res) => {
  try {
    const computer = await adService.findComputer(req.params.name);
    if (!computer) return res.status(404).json({ error: 'Computer not found' });
    res.json({ success: true, computer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requirePermission('computers:create'), async (req, res) => {
  try {
    const result = await adService.createComputer(req.body);
    const performer = req.user?.username || 'unknown';
    audit.log('create', 'computer', req.body.name, result.dn, performer);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:dn', requirePermission('computers:delete'), async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.deleteComputer(dn);
    const performer = req.user?.username || 'unknown';
    audit.log('delete', 'computer', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:dn/enable', requirePermission('computers:enable'), async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.enableComputer(dn);
    const performer = req.user?.username || 'unknown';
    audit.log('enable', 'computer', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:dn/disable', requirePermission('computers:disable'), async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.disableComputer(dn);
    const performer = req.user?.username || 'unknown';
    audit.log('disable', 'computer', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:dn/reset', requirePermission('computers:disable'), async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.resetComputer(dn);
    const performer = req.user?.username || 'unknown';
    audit.log('reset', 'computer', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
