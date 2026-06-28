const db = require('../db/database');

function log(action, targetType, targetName, targetDn, performedBy, details, result) {
  const stmt = db.prepare(`
    INSERT INTO audit_log (action, target_type, target_name, target_dn, performed_by, details, result)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(action, targetType, targetName || null, targetDn || null, performedBy || null, details || null, result || 'success');
  return info.lastInsertRowid;
}

function buildWhere(filters) {
  let sql = 'WHERE 1=1';
  const params = [];
  if (filters.action) { sql += ' AND action = ?'; params.push(filters.action); }
  if (filters.targetType) { sql += ' AND target_type = ?'; params.push(filters.targetType); }
  if (filters.targetName) { sql += ' AND target_name LIKE ?'; params.push('%' + filters.targetName + '%'); }
  if (filters.performedBy) { sql += ' AND performed_by LIKE ?'; params.push('%' + filters.performedBy + '%'); }
  if (filters.result) { sql += ' AND result = ?'; params.push(filters.result); }
  if (filters.from) { sql += ' AND timestamp >= ?'; params.push(filters.from); }
  if (filters.to) { sql += ' AND timestamp <= ?'; params.push(filters.to); }
  return { sql, params };
}

function query(filters) {
  const w = buildWhere(filters);
  let sql = 'SELECT * FROM audit_log ' + w.sql;
  const params = [...w.params];
  sql += ' ORDER BY timestamp DESC';
  if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
  else { sql += ' LIMIT 1000'; }
  if (filters.offset) { sql += ' OFFSET ?'; params.push(filters.offset); }
  return db.prepare(sql).all(...params);
}

function count(filters) {
  const w = buildWhere(filters);
  const row = db.prepare('SELECT COUNT(*) as c FROM audit_log ' + w.sql).get(...w.params);
  return row.c;
}

function getStats(filters) {
  const where = [];
  const params = [];
  if (filters.from) { where.push('timestamp >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('timestamp <= ?'); params.push(filters.to); }
  const wh = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) as c FROM audit_log ' + wh).get(...params);
  const byAction = db.prepare('SELECT action, COUNT(*) as c FROM audit_log ' + wh + ' GROUP BY action ORDER BY c DESC').all(...params);
  const byTarget = db.prepare('SELECT target_type, COUNT(*) as c FROM audit_log ' + wh + ' GROUP BY target_type ORDER BY c DESC').all(...params);
  return { total: total.c, byAction, byTarget };
}

module.exports = { log, query, count, getStats };
