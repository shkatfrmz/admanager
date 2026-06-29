const express = require('express');
const router = express.Router();
const adService = require('../services/ad.service');
const cache = require('../db/cache.repository');
const syncService = require('../services/sync.service');
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/auth');

router.use(authMiddleware);

// ── POST create group ─────────────────────────────────────────────────────
router.post('/', requirePermission('groups:create'), async (req, res) => {
  try {
    const result = await adService.createGroup(req.body);
    const performer = req.user?.username || 'unknown';
    audit.log('create', 'group', req.body.name, result.dn, performer);
    // Immediately refresh cache so the new group shows up
    syncService.syncGroups().catch(e => console.error('[groups] Post-create sync error:', e.message));
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH update group ────────────────────────────────────────────────────
router.patch('/:dn', requirePermission('groups:edit'), async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.updateGroup(dn, req.body);
    const performer = req.user?.username || 'unknown';
    audit.log('modify', 'group', dn, dn, performer);
    syncService.syncGroups().catch(e => console.error('[groups] Post-update sync error:', e.message));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE group ──────────────────────────────────────────────────────────
router.delete('/:dn', requirePermission('groups:delete'), async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.deleteGroup(dn);
    const performer = req.user?.username || 'unknown';
    audit.log('delete', 'group', dn, dn, performer);
    syncService.syncGroups().catch(e => console.error('[groups] Post-delete sync error:', e.message));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET all groups (from cache) ───────────────────────────────────────────────
router.get('/', requirePermission('groups:read'), async (req, res) => {
  try {
    const { search } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500); // Cap at 500
    const offset = parseInt(req.query.offset) || 0;
    
    let groups, total;
    if (search) {
      // Search mode
      groups = cache.searchGroupsCache(search);
      total = groups.length;
      groups = groups.slice(offset, offset + limit);
    } else {
      // Normal mode - paginated
      total = cache.getTotalGroupsCount();
      groups = cache.getAllGroups(limit, offset);
    }
    
    if (groups && groups.length > 0) {
      return res.json({ 
        success: true, 
        count: groups.length, 
        total: total,
        offset: offset,
        limit: limit,
        groups: groups, 
        source: 'cache', 
        lastSync: cache.getLastSync()?.finished_at || null 
      });
    }
    
    // Fallback to AD if cache is empty
    console.log('[groups] Cache empty, syncing from AD...');
    const adGroups = await adService.getAllGroups();
    if (!adGroups || adGroups.length === 0) {
      return res.json({ 
        success: true, 
        count: 0, 
        total: 0,
        groups: [], 
        source: 'ad' 
      });
    }
    
    const paged = adGroups.slice(offset, offset + limit);
    for (const g of paged) { 
      try { cache.upsertGroup(g); } catch (e) { console.error('[groups] Cache error:', e.message); }
    }
    return res.json({ 
      success: true, 
      count: paged.length, 
      total: adGroups.length,
      offset: offset,
      limit: limit,
      groups: paged, 
      source: 'ad', 
      lastSync: null 
    });
  } catch (err) {
    console.error('[groups] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET group members (from cache — joined against cached users) ─────────────
router.get('/:groupName/members', requirePermission('groups:read'), async (req, res) => {
  try {
    const group = cache.getGroupByName(decodeURIComponent(req.params.groupName));
    if (!group) return res.status(404).json({ error: 'Group not found in cache' });
    const members = cache.getGroupMembersCache(group.dn);
    res.json({ success: true, count: members.length, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST add user to group (writes to AD, refreshes that group's cache) ──────
router.post('/:groupDN/members', requirePermission('groups:manage_members'), async (req, res) => {
  try {
    const groupDN = decodeURIComponent(req.params.groupDN);
    const { userDN } = req.body;

    if (!userDN) {
      console.warn('[groups] Add member validation failed: missing userDN');
      return res.status(400).json({ error: 'userDN is required' });
    }

    console.log(`[groups] Adding user to group: ${userDN} -> ${groupDN}`);
    const result = await adService.addUserToGroup(userDN, groupDN);

    if (!result.success) {
      console.error('[groups] AD add member failed:', result);
      return res.status(400).json(result);
    }

    // Update cache: get current members, add new one
    const existing = cache.getGroupMembersCache(groupDN).map(m => m.dn);
    if (!existing.includes(userDN)) {
      cache.setGroupMembers(groupDN, [...existing, userDN]);
      console.log(`[groups] Group members cache updated for ${groupDN}`);
    } else {
      console.log(`[groups] User already in group cache`);
    }

    // Ensure user exists in users table (for LEFT JOIN to work)
    const userInDb = cache.getUserByDN(userDN);
    if (!userInDb) {
      cache.upsertUser({ dn: userDN, userAccountControl: 512, last_synced_at: new Date().toISOString() });
      console.log(`[groups] Created minimal user record for ${userDN}`);
    }

    const performer = req.user?.username || 'unknown';
    audit.log('group_add_member', 'group', groupDN, groupDN, performer, `Added user ${userDN}`);

    res.json(result);
  } catch (err) {
    console.error('[groups] Add member error:', err.message);
    res.status(500).json({ error: err.message, details: 'Failed to add user to group' });
  }
});

// ── DELETE remove user from group ─────────────────────────────────────────────
router.delete('/:groupDN/members/:userDN', requirePermission('groups:manage_members'), async (req, res) => {
  try {
    const groupDN = decodeURIComponent(req.params.groupDN);
    const userDN = decodeURIComponent(req.params.userDN);
    console.log(`[groups] Removing user from group: ${userDN} -> ${groupDN}`);
    
    const result = await adService.removeUserFromGroup(userDN, groupDN);
    if (!result.success) {
      console.error('[groups] AD remove member failed:', result);
      return res.status(400).json(result);
    }

    // Update cache: remove user from group members
    const existing = cache.getGroupMembersCache(groupDN).map(m => m.dn);
    const updated = existing.filter(dn => dn !== userDN);
    cache.setGroupMembers(groupDN, updated);
    console.log(`[groups] Group members cache updated, removed ${userDN}`);

    const performer = req.user?.username || 'unknown';
    audit.log('group_remove_member', 'group', groupDN, groupDN, performer, `Removed user ${userDN}`);

    res.json(result);
  } catch (err) {
    console.error('[groups] Remove member error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST force a manual sync right now ────────────────────────────────────────
router.post('/sync/now', requirePermission('sync:trigger'), async (req, res) => {
  try {
    const result = await syncService.syncGroups();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
