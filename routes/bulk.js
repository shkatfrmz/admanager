const express = require('express');
const router = express.Router();
const adService = require('../services/ad.service');
const audit = require('../services/audit.service');
const cache = require('../db/cache.repository');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ── POST /api/bulk/import — CSV import users ─────────────────────────────
router.post('/import', async (req, res) => {
  try {
    const { users } = req.body;
    if (!users || !Array.isArray(users) || !users.length) {
      return res.status(400).json({ error: 'Send an array of user objects in the "users" field' });
    }

    const results = { success: 0, failed: 0, errors: [] };
    for (const u of users) {
      try {
        if (!u.firstName || !u.lastName || !u.username) {
          results.failed++;
          results.errors.push({ username: u.username, error: 'Missing required fields (firstName, lastName, username)' });
          continue;
        }
        const userData = {
          firstName: u.firstName,
          lastName: u.lastName,
          username: u.username,
          upn: u.upn || u.username,
          password: u.password || 'Welcome@123',
          department: u.department || '',
          title: u.title || '',
          email: u.email || '',
          ou: u.ou || ''
        };
        const result = await adService.createUser(userData);
        if (result.success) {
          results.success++;
          const performer = req.user?.username || 'unknown';
          audit.log('create', 'user', u.username, result.dn, performer, `Bulk import: ${u.firstName} ${u.lastName}`);
        } else {
          results.failed++;
          results.errors.push({ username: u.username, error: result.error || 'AD creation failed' });
        }
      } catch (e) {
        results.failed++;
        results.errors.push({ username: u.username, error: e.message });
      }
    }
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/bulk/export — export users as CSV ────────────────────────────
router.get('/export', (req, res) => {
  try {
    const users = cache.getAllUsers(10000, 0);
    if (!users || !users.length) {
      return res.status(404).json({ error: 'No users in cache. Sync first.' });
    }
    const headers = ['sAMAccountName', 'displayName', 'givenName', 'sn', 'mail', 'department', 'title', 'telephoneNumber', 'userPrincipalName', 'dn'];
    let csv = headers.join(',') + '\r\n';
    for (const u of users) {
      const row = headers.map(h => {
        let val = u[h] || '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      });
      csv += row.join(',') + '\r\n';
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=ad-users-export.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
