const express = require('express');
const router = express.Router();
const db = require('../db/database');
const adService = require('../services/ad.service');
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/auth');

router.use(authMiddleware);

// ── GET all scheduled access entries ─────────────────────────────────────────
router.get('/', requirePermission('scheduled_access:manage'), (req, res) => {
  try {
    const entries = db.prepare('SELECT * FROM scheduled_access ORDER BY created_at DESC').all();
    res.json({ success: true, count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create a scheduled access entry ─────────────────────────────────────
router.post('/', requirePermission('scheduled_access:manage'), async (req, res) => {
  try {
    const { userDN, groupDN, userName, groupName, startTime, endTime } = req.body;

    if (!userDN || !groupDN || !endTime) {
      return res.status(400).json({ error: 'userDN, groupDN, and endTime are required' });
    }

    // Check if user is already a member
    const alreadyMember = await adService.isUserInGroup(userDN, groupDN);
    if (alreadyMember) {
      return res.status(409).json({ error: `User is already a member of ${groupName || groupDN}` });
    }

    // Add user to group immediately
    console.log(`[scheduled] Adding user to group: ${userDN} -> ${groupDN}`);
    await adService.addUserToGroup(userDN, groupDN);

    const stmt = db.prepare(`
      INSERT INTO scheduled_access (user_dn, group_dn, user_name, group_name, start_time, end_time, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `);
    const info = stmt.run(userDN, groupDN, userName || '', groupName || '', startTime || new Date().toISOString(), endTime);

    console.log(`[scheduled] Created scheduled access ID ${info.lastInsertRowid} for ${userName || userDN} in ${groupName || groupDN} until ${endTime}`);

    const performer = req.user?.username || 'unknown';
    audit.log('scheduled_create', 'scheduled_access', userName || userDN, userDN, performer, `Added to ${groupName || groupDN} until ${endTime}`);

    res.json({ success: true, id: info.lastInsertRowid, message: 'User added to group. Will be auto-removed at ' + endTime });
  } catch (err) {
    console.error('[scheduled] Create error:', err.message);
    if (err.message && err.message.includes('ENTRY_EXISTS')) {
      return res.status(409).json({ error: 'User is already a member of this group' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE permanently delete an old entry ──────────────────────────────────
router.delete('/entry/:id', requirePermission('scheduled_access:manage'), async (req, res) => {
  try {
    const entry = db.prepare('SELECT * FROM scheduled_access WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    // If still active, remove from group first
    if (entry.status === 'active') {
      try {
        await adService.removeUserFromGroup(entry.user_dn, entry.group_dn);
        console.log(`[scheduled] Removed user from group before delete: ${entry.user_dn} <- ${entry.group_dn}`);
      } catch (e) {
        console.warn(`[scheduled] Could not remove user on delete: ${e.message}`);
      }
    }

    db.prepare('DELETE FROM scheduled_access WHERE id = ?').run(req.params.id);
    console.log(`[scheduled] Deleted entry ID ${req.params.id}`);
    const performer = req.user?.username || 'unknown';
    audit.log('scheduled_delete', 'scheduled_access', String(entry.user_name || entry.user_dn), entry.user_dn, performer, `Deleted entry for group ${entry.group_name || entry.group_dn}`);
    res.json({ success: true, message: 'Entry deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE cancel a scheduled access entry and remove user from group ────────
router.delete('/:id', requirePermission('scheduled_access:manage'), async (req, res) => {
  try {
    const entry = db.prepare('SELECT * FROM scheduled_access WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    if (entry.status === 'active') {
      await adService.removeUserFromGroup(entry.user_dn, entry.group_dn);
      console.log(`[scheduled] Removed user from group on cancel: ${entry.user_dn} <- ${entry.group_dn}`);
    }

    db.prepare('UPDATE scheduled_access SET status = ?, removed_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), req.params.id);
    const performer = req.user?.username || 'unknown';
    audit.log('scheduled_cancel', 'scheduled_access', String(entry.user_name || entry.user_dn), entry.user_dn, performer, `Cancelled access to group ${entry.group_name || entry.group_dn}`);
    res.json({ success: true, message: 'Scheduled access cancelled and user removed from group' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
