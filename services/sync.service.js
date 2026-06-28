const cron = require('node-cron');
const adService = require('../services/ad.service');
const cache = require('../db/cache.repository');
const db = require('../db/database');
const audit = require('./audit.service');

let isSyncing = false; // prevent overlapping syncs

// ════════════════════════════════════════════════════════════════════════════
// SYNC USERS
// ════════════════════════════════════════════════════════════════════════════
async function syncUsers() {
  const syncId = cache.logSyncStart('users');
  try {
    const users = await adService.getAllUsers();
    cache.upsertUsersBulk(users);

    const currentDNs = users.map(u => u.dn || u.distinguishedName);
    const removed = cache.removeStaleUsers(currentDNs);

    cache.logSyncFinish(syncId, 'success', users.length);
    console.log(`[sync] Users: ${users.length} synced, ${removed} stale removed — ${new Date().toLocaleTimeString()}`);
    return { success: true, count: users.length, removed };
  } catch (err) {
    cache.logSyncFinish(syncId, 'failed', 0, err.message);
    console.error('[sync] Users sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC GROUPS + MEMBERSHIPS
// ════════════════════════════════════════════════════════════════════════════
async function syncGroups() {
  const syncId = cache.logSyncStart('groups');
  try {
    const groups = await adService.getAllGroups();
    cache.upsertGroupsBulk(groups);

      // Sync membership for each group (kept lightweight — only DNs)
      const memberPromises = groups.map(async (group) => {
        try {
          const members = await adService.getGroupMembers(group.cn || group.name);
          const memberDNs = members.map(m => m.dn || m.distinguishedName).filter(Boolean);
          cache.setGroupMembers(group.dn, memberDNs);
        } catch (e) {
          // Skip groups that fail (e.g. built-in groups with odd permissions) but keep going
          console.warn(`[sync] Skipped members for group "${group.cn}": ${e.message}`);
        }
      });
      await Promise.allSettled(memberPromises);

    cache.logSyncFinish(syncId, 'success', groups.length);
    console.log(`[sync] Groups: ${groups.length} synced — ${new Date().toLocaleTimeString()}`);
    return { success: true, count: groups.length };
  } catch (err) {
    cache.logSyncFinish(syncId, 'failed', 0, err.message);
    console.error('[sync] Groups sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC COMPUTERS
// ════════════════════════════════════════════════════════════════════════════
async function syncComputers() {
  const syncId = cache.logSyncStart('computers');
  try {
    const computers = await adService.getAllComputers();
    cache.upsertComputersBulk(computers);

    const currentDNs = computers.map(c => c.dn || c.distinguishedName);
    const removed = cache.removeStaleComputers(currentDNs);

    cache.logSyncFinish(syncId, 'success', computers.length);
    console.log(`[sync] Computers: ${computers.length} synced, ${removed} stale removed — ${new Date().toLocaleTimeString()}`);
    return { success: true, count: computers.length, removed };
  } catch (err) {
    cache.logSyncFinish(syncId, 'failed', 0, err.message);
    console.error('[sync] Computers sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FULL SYNC (users + groups + computers)
// ════════════════════════════════════════════════════════════════════════════
let pendingManualSync = false;

async function runFullSync() {
  if (isSyncing) {
    pendingManualSync = true;
    console.log('[sync] Queued — another sync in progress, will re-run after');
    return { skipped: true, message: 'Sync already in progress — will re-run automatically' };
  }
  isSyncing = true;
  pendingManualSync = false;
  try {
    const userResult = await syncUsers();
    const groupResult = await syncGroups();
    const computerResult = await syncComputers();
    return { success: true, users: userResult, groups: groupResult, computers: computerResult };
  } finally {
    isSyncing = false;
    // If a manual sync was requested while we were running, re-run immediately
    if (pendingManualSync) {
      console.log('[sync] Re-running for queued manual request');
      pendingManualSync = false;
      runFullSync();
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULED ACCESS — check every minute for expired entries
// ════════════════════════════════════════════════════════════════════════════
async function checkExpiredAccess() {
  try {
    const now = new Date().toISOString();
      const expired = db.prepare(
        "SELECT * FROM scheduled_access WHERE (status = 'active' AND end_time <= ?) OR (status = 'error')"
      ).all(now);

    for (const entry of expired) {
      console.log(`[scheduled] Expired: removing ${entry.user_dn} from ${entry.group_dn}`);
      try {
        await adService.removeUserFromGroup(entry.user_dn, entry.group_dn);
        db.prepare("UPDATE scheduled_access SET status = 'expired', removed_at = ? WHERE id = ?").run(now, entry.id);
        audit.log('scheduled_expired', 'scheduled_access', String(entry.user_name || entry.user_dn), entry.user_dn, 'system', `Auto-removed from ${entry.group_name || entry.group_dn} (schedule expired)`);
        console.log(`[scheduled] ✓ Auto-removed ID ${entry.id} (${entry.user_name || entry.user_dn} from ${entry.group_name || entry.group_dn})`);
      } catch (e) {
        console.error(`[scheduled] Failed to remove ID ${entry.id}:`, e.message);
        db.prepare("UPDATE scheduled_access SET status = 'error' WHERE id = ?").run(entry.id);
      }
    }
  } catch (err) {
    console.error('[scheduled] Check error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULER — every 2 minutes
// ════════════════════════════════════════════════════════════════════════════
function startScheduler() {
  // Run once immediately on boot so cache isn't empty
  runFullSync();

  // Then every 1 minute
  cron.schedule('* * * * *', () => {
    runFullSync();
  });

  // Check for expired scheduled access every 30 seconds
  cron.schedule('*/30 * * * * *', () => {
    checkExpiredAccess();
  });

  console.log('[sync] Scheduler started — syncing AD every 2 minutes, checking scheduled access every 30s');
}

module.exports = {
  syncUsers,
  syncGroups,
  syncComputers,
  runFullSync,
  checkExpiredAccess,
  startScheduler
};
