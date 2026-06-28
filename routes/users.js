const express = require('express');
const router = express.Router();
const adService = require('../services/ad.service');
const cache = require('../db/cache.repository');
const syncService = require('../services/sync.service');
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');

// All routes below require authentication
router.use(authMiddleware);

// ── GET all users (reads from SQLite cache — fast) ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, status } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 5000, 20000);
    const offset = parseInt(req.query.offset) || 0;
    
    let users, total;
    
    if (search) {
      users = cache.searchUsersCache(search);
      total = users.length;
      users = users.slice(offset, offset + limit);
    } else if (status === 'active' || status === 'disabled') {
      users = cache.getUsersByStatus(status, limit, offset);
      total = cache.getStats()[status === 'active' ? 'activeUsers' : 'disabledUsers'];
    } else {
      total = cache.getTotalUsersCount();
      users = cache.getAllUsers(limit, offset);
    }
    
    if (users && users.length > 0) {
      return res.json({ 
        success: true, 
        count: users.length, 
        total: total,
        offset: offset,
        limit: limit,
        users: users, 
        source: 'cache', 
        lastSync: cache.getLastSync()?.finished_at || null 
      });
    }
    
    // If cache is empty, fallback to AD
    console.log('[users] Cache empty, syncing from AD...');
    const adUsersRaw = await adService.searchUsers(search || null);
    if (!adUsersRaw || adUsersRaw.length === 0) {
      return res.json({ 
        success: true, 
        count: 0, 
        total: 0,
        users: [], 
        source: 'ad' 
      });
    }

    const normalized = adUsersRaw.map(u => ({
      dn: u.distinguishedName || u.dn,
      sAMAccountName: u.sAMAccountName || '',
      userPrincipalName: u.userPrincipalName || '',
      displayName: u.displayName || '',
      givenName: u.givenName || '',
      sn: u.sn || '',
      mail: u.mail || '',
      department: u.department || '',
      title: u.title || '',
      telephoneNumber: u.telephoneNumber || '',
      userAccountControl: u.userAccountControl || null,
      whenCreated: u.whenCreated || '',
      lastLogon: u.lastLogon || ''
    }));
    
    const paged = normalized.slice(offset, offset + limit);
    
    // Cache the results
    for (const u of paged) {
      try { cache.upsertUser(u); } catch (e) { console.error('[users] Cache error:', e.message); }
    }
    
    return res.json({ 
      success: true, 
      count: paged.length, 
      total: normalized.length,
      offset: offset,
      limit: limit,
      users: paged, 
      source: 'ad', 
      lastSync: null 
    });
  } catch (err) {
    console.error('[users] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET dashboard stats (direct SQL aggregation — fast) ────────────────────
router.get('/stats', async (req, res) => {
  try {
    const stats = cache.getStats();
    // Get real total from AD (paged query to bypass 1000 limit)
    let realTotal = 0;
    try {
      realTotal = await adService.getTotalUserCount();
    } catch (_) {}
    res.json({ success: true, ...stats, totalUsers: realTotal || stats.totalUsers });
  } catch (err) {
    console.error('[users] Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET single user (cache first, falls back to live AD) ─────────────────────
router.get('/:username', async (req, res) => {
  try {
    let user = cache.getUserByUsername(req.params.username);
    if (!user) user = await adService.findUser(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Also fetch group membership and manager/directReports
    let groups = [];
    let manager = null;
    let directReports = [];
    try {
      groups = await adService.getUserGroups(req.params.username);
    } catch (_) {}
    try {
      const fullUser = await adService.findUserFull(req.params.username);
      if (fullUser) {
        manager = fullUser.manager || null;
        directReports = fullUser.directReports || [];
      }
    } catch (_) {}
    res.json({ success: true, user, groups, manager, directReports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET user groups (live — membership detail not critical to cache) ─────────
router.get('/:username/groups', async (req, res) => {
  try {
    const groups = await adService.getUserGroups(req.params.username);
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create user (writes to AD, then patches cache immediately) ──────────
router.post('/', async (req, res) => {
  try {
    const { firstName, lastName, username, upn, password, department, title, email, ou, accountExpiry, passwordNeverExpires, userMustChangePassword, userCannotChangePassword } = req.body;

    // Validation
    if (!firstName || !lastName || !username || !password) {
      console.warn('[users] Create user validation failed:', { firstName, lastName, username, password: '***' });
      return res.status(400).json({ error: 'firstName, lastName, username, and password are required' });
    }

    console.log(`[users] Creating user: ${username} (${upn || 'no UPN'})`);
    const result = await adService.createUser({ ...req.body, accountExpiry, passwordNeverExpires, userMustChangePassword, userCannotChangePassword });

    if (!result.success) {
      console.error('[users] AD create user failed:', result);
      return res.status(400).json(result);
    }

    // Pull the freshly created user from AD and add it to cache right away
    const upnToFind = upn || username;
    const newUser = await adService.findUser(upnToFind);
    if (newUser) {
      cache.upsertUser(newUser);
      console.log(`[users] User created and cached: ${username}`);
    }

    const performer = req.user?.username || 'unknown';
    audit.log('create', 'user', username, upn, performer, JSON.stringify({ firstName, lastName, department, title }));

    res.status(201).json(result);
  } catch (err) {
    console.error('[users] Create user error:', err.message);
    res.status(500).json({ error: err.message, details: 'Failed to create user in Active Directory' });
  }
});

// ── PATCH update user attributes ──────────────────────────────────────────────
router.patch('/:dn', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.updateUser(dn, req.body);
    // Patch cache directly — no need to re-fetch from AD
    const cached = cache.getUserByDN(dn);
    if (cached) cache.upsertUser({ ...cached, ...req.body, dn });
    const performer = req.user?.username || 'unknown';
    audit.log('modify', 'user', req.body.displayName || cached?.displayName || dn, dn, performer, JSON.stringify(Object.keys(req.body)));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST enable user ───────────────────────────────────────────────────────────
router.post('/:dn/enable', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    console.log(`[users] Enabling user: ${dn}`);
    
    const result = await adService.enableUser(dn);
    console.log(`[users] User enabled. Result:`, result);
    
    if (!result.success) {
      console.error('[users] Enable failed:', result);
      return res.status(400).json(result);
    }
    
    const updated = cache.updateUserStatus(dn, 512);
    console.log(`[users] Cache ${updated ? 'updated' : 'not found, trying upsert...'}`);
    if (!updated) {
      cache.upsertUser({ dn, userAccountControl: 512, last_synced_at: new Date().toISOString() });
    }

    const performer = req.user?.username || 'unknown';
    audit.log('enable', 'user', dn, dn, performer);

    res.json(result);
  } catch (err) {
    console.error('[users] Enable user error:', err.message, err.stack);
    res.status(500).json({ error: err.message, details: 'Failed to enable user in Active Directory' });
  }
});

// ── POST disable user ────────────────────────────────────────────────────────
router.post('/:dn/disable', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    console.log(`[users] Disabling user: ${dn}`);
    
    const result = await adService.disableUser(dn);
    console.log(`[users] User disabled. Result:`, result);
    
    if (!result.success) {
      console.error('[users] Disable failed:', result);
      return res.status(400).json(result);
    }
    
    const updated = cache.updateUserStatus(dn, 514);
    console.log(`[users] Cache ${updated ? 'updated' : 'not found, trying upsert...'}`);
    if (!updated) {
      cache.upsertUser({ dn, userAccountControl: 514, last_synced_at: new Date().toISOString() });
    }

    const performer = req.user?.username || 'unknown';
    audit.log('disable', 'user', dn, dn, performer);

    res.json(result);
  } catch (err) {
    console.error('[users] Disable user error:', err.message, err.stack);
    res.status(500).json({ error: err.message, details: 'Failed to disable user in Active Directory' });
  }
});

// ── POST reset password (no cache field for this — passthrough) ──────────────
router.post('/:dn/reset-password', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'newPassword is required' });
    const result = await adService.resetPassword(dn, newPassword);
    const performer = req.user?.username || 'unknown';
    audit.log('password_reset', 'user', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST move user to different OU (DN changes, so re-sync that user) ────────
router.post('/:dn/move', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const { newOU } = req.body;
    if (!newOU) return res.status(400).json({ error: 'newOU is required' });
    const result = await adService.moveUser(dn, newOU);
    cache.deleteUserCache(dn); // old DN is gone; next 2-min sync will add new DN
    const performer = req.user?.username || 'unknown';
    audit.log('move', 'user', dn, dn, performer, `Moved to ${newOU}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE user ──────────────────────────────────────────────────────────────
router.delete('/:dn', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    console.log(`[users] Deleting user: ${dn}`);
    
    const result = await adService.deleteUser(dn);
    console.log(`[users] User deleted. Result:`, result);
    
    const performer = req.user?.username || 'unknown';

    if (!result.success) {
      console.error('[users] Delete failed:', result);
      audit.log('delete', 'user', dn, dn, performer, result.error, 'failure');
      return res.status(400).json(result);
    }
    
    cache.deleteUserCache(dn);
    console.log(`[users] User removed from cache`);

    audit.log('delete', 'user', dn, dn, performer);

    res.json(result);
  } catch (err) {
    console.error('[users] Delete user error:', err.message, err.stack);
    res.status(500).json({ error: err.message, details: 'Failed to delete user from Active Directory' });
  }
});

// ── POST force a manual sync right now ────────────────────────────────────────
router.post('/sync/now', async (req, res) => {
  try {
    const result = await syncService.syncUsers();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create GMSA (Group Managed Service Account) ─────────────────────────
router.post('/gmsa', async (req, res) => {
  try {
    const result = await adService.createGMSA(req.body);
    const performer = req.user?.username || 'unknown';
    audit.log('create', 'gmsa', req.body.name, result.dn, performer);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET password expiration stats ────────────────────────────────────────────
router.get('/password-expiry/stats', async (req, res) => {
  try {
    const users = cache.getAllUsers(20000, 0);
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    const expiring = { within7: 0, within14: 0, within30: 0, expired: 0, never: 0, total: users.length };
    for (const u of users) {
      if (u.userAccountControl & 65536) { expiring.never++; continue; }
      // Estimate pwdLastSet from last_synced_at if not available
      const pwdSet = u.pwdLastSet ? (typeof u.pwdLastSet === 'object' ? Number(u.pwdLastSet.low || u.pwdLastSet) : Number(u.pwdLastSet)) : null;
      if (!pwdSet || pwdSet === 0) { expiring.never++; continue; }
      // AD stores pwdLastSet as filetime (100-ns intervals since 1601-01-01)
      const pwdTime = (pwdSet / 10000) - 11644473600000;
      const ageDays = (Date.now() - pwdTime) / (day * 1000);
      const maxAge = 42; // typical 42-day AD password policy
      const remaining = maxAge - ageDays;
      if (remaining <= 0) expiring.expired++;
      else if (remaining <= 7) expiring.within7++;
      else if (remaining <= 14) expiring.within14++;
      else if (remaining <= 30) expiring.within30++;
    }
    res.json({ success: true, ...expiring });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET stale accounts (not logged in for N+ days) ────────────────────────────
router.get('/stale/list', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const users = cache.getAllUsers(20000, 0);
    const cutoff = Date.now() - days * 86400000;
    const stale = users.filter(u => {
      if (u.userAccountControl & 2) return false; // skip disabled
      const lastLogon = u.lastLogon ? (typeof u.lastLogon === 'object' ? Number(u.lastLogon.low || u.lastLogon) : Number(u.lastLogon)) : 0;
      if (!lastLogon || lastLogon === 0) return false;
      const logonTime = (lastLogon / 10000) - 11644473600000;
      return logonTime < cutoff;
    }).map(u => ({
      dn: u.dn, displayName: u.displayName, sAMAccountName: u.sAMAccountName,
      mail: u.mail, lastLogon: u.lastLogon ? new Date((Number(u.lastLogon) / 10000) - 11644473600000).toISOString() : null,
      department: u.department
    }));
    res.json({ success: true, count: stale.length, users: stale, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
