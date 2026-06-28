const db = require('./database');

// ════════════════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════════════════

const upsertUserStmt = db.prepare(`
  INSERT INTO users (
    dn, sAMAccountName, userPrincipalName, displayName, givenName, sn,
    mail, department, title, telephoneNumber, userAccountControl,
    whenCreated, lastLogon, last_synced_at
  ) VALUES (
    @dn, @sAMAccountName, @userPrincipalName, @displayName, @givenName, @sn,
    @mail, @department, @title, @telephoneNumber, @userAccountControl,
    @whenCreated, @lastLogon, @last_synced_at
  )
  ON CONFLICT(dn) DO UPDATE SET
    sAMAccountName      = excluded.sAMAccountName,
    userPrincipalName    = excluded.userPrincipalName,
    displayName           = excluded.displayName,
    givenName              = excluded.givenName,
    sn                       = excluded.sn,
    mail                      = excluded.mail,
    department                 = excluded.department,
    title                       = excluded.title,
    telephoneNumber               = excluded.telephoneNumber,
    userAccountControl              = excluded.userAccountControl,
    whenCreated                       = excluded.whenCreated,
    lastLogon                          = excluded.lastLogon,
    last_synced_at                       = excluded.last_synced_at
`);

function upsertUser(user) {
  upsertUserStmt.run({
    dn: user.dn || user.distinguishedName,
    sAMAccountName: user.sAMAccountName || null,
    userPrincipalName: user.userPrincipalName || null,
    displayName: user.displayName || null,
    givenName: user.givenName || null,
    sn: user.sn || null,
    mail: user.mail || null,
    department: user.department || null,
    title: user.title || null,
    telephoneNumber: user.telephoneNumber || null,
    userAccountControl: user.userAccountControl != null ? Number(user.userAccountControl) : null,
    whenCreated: user.whenCreated || null,
    lastLogon: user.lastLogon || null,
    last_synced_at: new Date().toISOString()
  });
}

function upsertUsersBulk(users) {
  const tx = db.transaction((list) => {
    for (const u of list) upsertUser(u);
  });
  tx(users);
}

function updateUserStatus(dn, userAccountControl) {
  const now = new Date().toISOString();
  const val = Number(userAccountControl);

  // 1. Try exact match
  let r = db.prepare('UPDATE users SET userAccountControl = ?, last_synced_at = ? WHERE dn = ?').run(val, now, dn);
  if (r.changes > 0) return true;

  // 2. Try case-insensitive match
  r = db.prepare('UPDATE users SET userAccountControl = ?, last_synced_at = ? WHERE LOWER(dn) = LOWER(?)').run(val, now, dn);
  if (r.changes > 0) return true;

  // 3. Extract CN and try matching by displayName or sAMAccountName
  const cnMatch = dn.match(/^CN=([^,]+)/i);
  if (cnMatch) {
    const name = cnMatch[1].trim();
    r = db.prepare('UPDATE users SET userAccountControl = ?, last_synced_at = ? WHERE displayName = ?').run(val, now, name);
    if (r.changes > 0) return true;
    // Try partial match on displayName or sAMAccountName
    r = db.prepare("UPDATE users SET userAccountControl = ?, last_synced_at = ? WHERE displayName LIKE ?").run(val, now, `%${name}%`);
    return r.changes > 0;
  }

  return false;
}

function getAllUsers(limit = null, offset = 0) {
  const query = limit ? `SELECT * FROM users ORDER BY displayName LIMIT ? OFFSET ?` : `SELECT * FROM users ORDER BY displayName`;
  return limit ? db.prepare(query).all(limit, offset) : db.prepare('SELECT * FROM users ORDER BY displayName').all();
}

function getTotalUsersCount() {
  const result = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return result?.count || 0;
}

function getStats() {
  const totalCheck   = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const activeCheck  = db.prepare("SELECT COUNT(*) as count FROM users WHERE (userAccountControl & 2) = 0").get();
  const disabledCheck = db.prepare("SELECT COUNT(*) as count FROM users WHERE (userAccountControl & 2) != 0").get();
  const groupCheck   = db.prepare('SELECT COUNT(*) as count FROM groups').get();
  return {
    totalUsers:   totalCheck.count,
    activeUsers:  activeCheck.count,
    disabledUsers: disabledCheck.count,
    totalGroups:  groupCheck.count
  };
}

function getUsersByStatus(status, limit = null, offset = 0) {
  let query;
  if (status === 'active') {
    query = limit ? `SELECT * FROM users WHERE (userAccountControl & 2) = 0 ORDER BY displayName LIMIT ? OFFSET ?`
                  : `SELECT * FROM users WHERE (userAccountControl & 2) = 0 ORDER BY displayName`;
  } else if (status === 'disabled') {
    query = limit ? `SELECT * FROM users WHERE (userAccountControl & 2) != 0 ORDER BY displayName LIMIT ? OFFSET ?`
                  : `SELECT * FROM users WHERE (userAccountControl & 2) != 0 ORDER BY displayName`;
  } else {
    return getAllUsers(limit, offset);
  }
  return limit ? db.prepare(query).all(limit, offset) : db.prepare(query).all();
}

function searchUsersCache(query) {
  const q = `%${query}%`;
  return db.prepare(`
    SELECT * FROM users
    WHERE displayName LIKE ? OR sAMAccountName LIKE ? OR mail LIKE ? OR department LIKE ?
    ORDER BY displayName
  `).all(q, q, q, q);
}

function getUserByDN(dn) {
  return db.prepare('SELECT * FROM users WHERE dn = ?').get(dn);
}

function getUserByUsername(username) {
  return db.prepare(`
    SELECT * FROM users WHERE sAMAccountName = ? OR userPrincipalName = ?
  `).get(username, username);
}

function deleteUserCache(dn) {
  db.prepare('DELETE FROM users WHERE dn = ?').run(dn);
}

function removeStaleUsers(currentDNs) {
  // Remove users from cache that no longer exist in AD using SQL NOT IN
  if (currentDNs.length === 0) {
    // If AD returned no users, delete all cached users
    const result = db.prepare('DELETE FROM users').run();
    return result.changes;
  }
  
  // Build SQL placeholders for IN clause: (?, ?, ...)
  const placeholders = currentDNs.map(() => '?').join(',');
  const query = `DELETE FROM users WHERE dn NOT IN (${placeholders})`;
  const result = db.prepare(query).run(...currentDNs);
  return result.changes;
}

// ════════════════════════════════════════════════════════════════════════════
// GROUPS
// ════════════════════════════════════════════════════════════════════════════

const upsertGroupStmt = db.prepare(`
  INSERT INTO groups (dn, cn, description, group_type, last_synced_at)
  VALUES (@dn, @cn, @description, @group_type, @last_synced_at)
  ON CONFLICT(dn) DO UPDATE SET
    cn = excluded.cn,
    description = excluded.description,
    group_type = excluded.group_type,
    last_synced_at = excluded.last_synced_at
`);

function getGroupCategory(groupType) {
  if (groupType == null) return 'Unknown';
  const gt = parseInt(groupType, 10);
  if (isNaN(gt)) return 'Unknown';
  return (gt & 0x80000000) ? 'Security' : 'Distribution';
}

function upsertGroup(group) {
  upsertGroupStmt.run({
    dn: group.dn,
    cn: group.cn || group.name || null,
    description: group.description || null,
    group_type: getGroupCategory(group.groupType),
    last_synced_at: new Date().toISOString()
  });
}

function upsertGroupsBulk(groups) {
  const tx = db.transaction((list) => {
    for (const g of list) upsertGroup(g);
  });
  tx(groups);
}

function getAllGroups(limit = null, offset = 0) {
  const query = limit ? `SELECT * FROM groups ORDER BY cn LIMIT ? OFFSET ?` : `SELECT * FROM groups ORDER BY cn`;
  return limit ? db.prepare(query).all(limit, offset) : db.prepare('SELECT * FROM groups ORDER BY cn').all();
}

function getTotalGroupsCount() {
  const result = db.prepare('SELECT COUNT(*) as count FROM groups').get();
  return result?.count || 0;
}

function searchGroupsCache(query) {
  const q = `%${query}%`;
  return db.prepare(`SELECT * FROM groups WHERE cn LIKE ? OR description LIKE ? ORDER BY cn`).all(q, q);
}

function getGroupByName(name) {
  return db.prepare('SELECT * FROM groups WHERE cn = ?').get(name);
}

// ── Group membership cache ───────────────────────────────────────────────
function setGroupMembers(groupDN, userDNs) {
  const tx = db.transaction((dn, members) => {
    db.prepare('DELETE FROM group_members WHERE group_dn = ?').run(dn);
    const stmt = db.prepare('INSERT OR IGNORE INTO group_members (group_dn, user_dn) VALUES (?, ?)');
    for (const userDN of members) stmt.run(dn, userDN);
  });
  tx(groupDN, userDNs);
}

function getGroupMembersCache(groupDN) {
  // LEFT JOIN so members without a full user record still appear
  return db.prepare(`
    SELECT gm.user_dn, u.sAMAccountName, u.displayName, u.mail, u.userAccountControl, u.department, u.title
    FROM group_members gm
    LEFT JOIN users u ON u.dn = gm.user_dn
    WHERE gm.group_dn = ?
    ORDER BY COALESCE(u.displayName, gm.user_dn)
  `).all(groupDN).map(r => ({
    dn: r.user_dn,
    sAMAccountName: r.sAMAccountName || '',
    displayName: r.displayName || r.user_dn || '',
    mail: r.mail || '',
    department: r.department || '',
    title: r.title || '',
    userAccountControl: r.userAccountControl
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC LOG
// ════════════════════════════════════════════════════════════════════════════

function logSyncStart(syncType) {
  const result = db.prepare(`
    INSERT INTO sync_log (sync_type, status, started_at)
    VALUES (?, 'running', ?)
  `).run(syncType, new Date().toISOString());
  return result.lastInsertRowid;
}

function logSyncFinish(id, status, recordsSynced, errorMessage = null) {
  db.prepare(`
    UPDATE sync_log
    SET status = ?, records_synced = ?, error_message = ?, finished_at = ?
    WHERE id = ?
  `).run(status, recordsSynced, errorMessage, new Date().toISOString(), id);
}

function getLastSync() {
  return db.prepare(`
    SELECT * FROM sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1
  `).get();
}

function getSyncHistory(limit = 10) {
  return db.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT ?`).all(limit);
}

// ════════════════════════════════════════════════════════════════════════════
// COMPUTERS
// ════════════════════════════════════════════════════════════════════════════

const upsertComputerStmt = db.prepare(`
  INSERT INTO computers (
    dn, cn, sAMAccountName, dNSHostName, operatingSystem, operatingSystemVersion,
    userAccountControl, description, whenCreated, lastLogon, last_synced_at
  ) VALUES (
    @dn, @cn, @sAMAccountName, @dNSHostName, @operatingSystem, @operatingSystemVersion,
    @userAccountControl, @description, @whenCreated, @lastLogon, @last_synced_at
  )
  ON CONFLICT(dn) DO UPDATE SET
    cn = excluded.cn,
    sAMAccountName = excluded.sAMAccountName,
    dNSHostName = excluded.dNSHostName,
    operatingSystem = excluded.operatingSystem,
    operatingSystemVersion = excluded.operatingSystemVersion,
    userAccountControl = excluded.userAccountControl,
    description = excluded.description,
    whenCreated = excluded.whenCreated,
    lastLogon = excluded.lastLogon,
    last_synced_at = excluded.last_synced_at
`);

function upsertComputer(computer) {
  upsertComputerStmt.run({
    dn: computer.dn || computer.distinguishedName,
    cn: computer.cn || null,
    sAMAccountName: computer.sAMAccountName || null,
    dNSHostName: computer.dNSHostName || null,
    operatingSystem: computer.operatingSystem || null,
    operatingSystemVersion: computer.operatingSystemVersion || null,
    userAccountControl: computer.userAccountControl != null ? Number(computer.userAccountControl) : null,
    description: computer.description || null,
    whenCreated: computer.whenCreated || null,
    lastLogon: computer.lastLogon || null,
    last_synced_at: new Date().toISOString()
  });
}

function upsertComputersBulk(computers) {
  const tx = db.transaction((list) => {
    for (const c of list) upsertComputer(c);
  });
  tx(computers);
}

function getAllComputers(limit = null, offset = 0) {
  const query = limit ? `SELECT * FROM computers ORDER BY cn LIMIT ? OFFSET ?` : `SELECT * FROM computers ORDER BY cn`;
  return limit ? db.prepare(query).all(limit, offset) : db.prepare('SELECT * FROM computers ORDER BY cn').all();
}

function getTotalComputersCount() {
  const result = db.prepare('SELECT COUNT(*) as count FROM computers').get();
  return result?.count || 0;
}

function searchComputersCache(query) {
  const q = `%${query}%`;
  return db.prepare(`
    SELECT * FROM computers
    WHERE cn LIKE ? OR sAMAccountName LIKE ? OR dNSHostName LIKE ? OR operatingSystem LIKE ?
    ORDER BY cn
  `).all(q, q, q, q);
}

function getComputerByDN(dn) {
  return db.prepare('SELECT * FROM computers WHERE dn = ?').get(dn);
}

function deleteComputerCache(dn) {
  db.prepare('DELETE FROM computers WHERE dn = ?').run(dn);
}

function removeStaleComputers(currentDNs) {
  if (currentDNs.length === 0) {
    const result = db.prepare('DELETE FROM computers').run();
    return result.changes;
  }
  const placeholders = currentDNs.map(() => '?').join(',');
  const query = `DELETE FROM computers WHERE dn NOT IN (${placeholders})`;
  const result = db.prepare(query).run(...currentDNs);
  return result.changes;
}

module.exports = {
  // users
  upsertUser, upsertUsersBulk, getAllUsers, getTotalUsersCount, getStats, getUsersByStatus, searchUsersCache,
  getUserByDN, getUserByUsername, deleteUserCache, removeStaleUsers, updateUserStatus,
  // groups
  upsertGroup, upsertGroupsBulk, getAllGroups, getTotalGroupsCount, searchGroupsCache, getGroupByName,
  setGroupMembers, getGroupMembersCache,
  // computers
  upsertComputer, upsertComputersBulk, getAllComputers, getTotalComputersCount, searchComputersCache,
  getComputerByDN, deleteComputerCache, removeStaleComputers,
  // sync log
  logSyncStart, logSyncFinish, getLastSync, getSyncHistory
};
