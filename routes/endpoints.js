const express = require('express');
const router = express.Router();
const db = require('../db/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'packages');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Helper to generate endpoint ID ────────────────────────────────────────
function generateEndpointId(hostname, domain) {
  const raw = `${hostname}.${domain}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT-FACING ENDPOINTS (no auth — use machine-id + secret handshake)
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /api/endpoints/register ─────────────────────────────────────────
router.post('/register', (req, res) => {
  try {
    const { hostname, domain, ip_address, os_version, os_arch, cpu_model, cpu_cores, total_ram_gb, agent_version } = req.body;
    if (!hostname) return res.status(400).json({ error: 'hostname is required' });
    const id = generateEndpointId(hostname, domain || '');
    const existing = db.prepare('SELECT id FROM endpoints WHERE id = ?').get(id);
    if (existing) {
      db.prepare(`UPDATE endpoints SET hostname=?, ip_address=?, os_version=?, os_arch=?, cpu_model=?, cpu_cores=?, total_ram_gb=?, domain=?, agent_version=?, status='online', last_heartbeat=datetime('now') WHERE id=?`)
        .run(hostname, ip_address||null, os_version||null, os_arch||null, cpu_model||null, cpu_cores||null, total_ram_gb||null, domain||null, agent_version||null, id);
      return res.json({ success: true, endpoint_id: id, message: 'Re-registered' });
    }
    db.prepare(`INSERT INTO endpoints (id, hostname, ip_address, os_version, os_arch, cpu_model, cpu_cores, total_ram_gb, domain, agent_version, status, last_heartbeat) VALUES (?,?,?,?,?,?,?,?,?,?,'online',datetime('now'))`)
      .run(id, hostname, ip_address||null, os_version||null, os_arch||null, cpu_model||null, cpu_cores||null, total_ram_gb||null, domain||null, agent_version||null);
    res.json({ success: true, endpoint_id: id, message: 'Registered' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/endpoints/heartbeat ────────────────────────────────────────
router.post('/heartbeat', (req, res) => {
  try {
    const { endpoint_id, hostname, ip_address } = req.body;
    if (!endpoint_id) return res.status(400).json({ error: 'endpoint_id required' });
    const r = db.prepare(`UPDATE endpoints SET status='online', last_heartbeat=datetime('now'), ip_address=COALESCE(?,ip_address), hostname=COALESCE(?,hostname) WHERE id=?`)
      .run(ip_address||null, hostname||null, endpoint_id);
    if (r.changes === 0) return res.status(404).json({ error: 'Unknown endpoint. Register first.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/deployments/pending/:endpointId ──────────────────────────────
router.get('/deployments/pending/:endpointId', (req, res) => {
  try {
    const { endpointId } = req.params;
    // Mark overdue "in_progress" as pending (agent likely restarted)
    db.prepare(`UPDATE deployments SET status='pending', attempt_count=attempt_count+1 WHERE endpoint_id=? AND status='in_progress' AND started_at < datetime('now','-1 hour')`)
      .run(endpointId);
    const tasks = db.prepare(`
      SELECT d.id, d.file_id, f.name as file_name, f.stored_path, f.original_name, f.file_type, f.file_size
      FROM deployments d
      LEFT JOIN deployment_files f ON f.id = d.file_id
      WHERE d.endpoint_id = ? AND d.status = 'pending'
      ORDER BY d.created_at ASC
    `).all(endpointId);
    // Mark as in_progress
    for (const t of tasks) {
      db.prepare(`UPDATE deployments SET status='in_progress', started_at=datetime('now'), attempt_count=attempt_count+1 WHERE id=? AND status='pending'`).run(t.id);
    }
    res.json({ success: true, count: tasks.length, tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/deployments/:id/result ─────────────────────────────────────
router.post('/deployments/:id/result', (req, res) => {
  try {
    const { id } = req.params;
    const { status, error_message } = req.body;
    if (!status || !['success', 'failed'].includes(status)) return res.status(400).json({ error: 'status must be success or failed' });
    const existing = db.prepare('SELECT id FROM deployments WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Deployment not found' });
    db.prepare(`UPDATE deployments SET status=?, error_message=?, progress_pct=100, completed_at=datetime('now') WHERE id=?`)
      .run(status, error_message||null, id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/deployments/:id/progress ──────────────────────────────────
router.patch('/deployments/:id/progress', (req, res) => {
  try {
    const { id } = req.params;
    const { progress_pct, status, error_message } = req.body;
    const existing = db.prepare('SELECT id FROM deployments WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Deployment not found' });
    const updates = [];
    const params = [];
    if (progress_pct !== undefined) { updates.push('progress_pct = ?'); params.push(Math.min(100, Math.max(0, Number(progress_pct)))); }
    if (status) { updates.push('status = ?'); params.push(status); }
    if (error_message !== undefined) { updates.push('error_message = ?'); params.push(error_message); }
    if (status === 'in_progress' && !progress_pct) { updates.push('progress_pct = 10'); }
    if (status === 'success' || status === 'failed') { updates.push('progress_pct = 100'); updates.push("completed_at = datetime('now')"); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    db.prepare(`UPDATE deployments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/deployments/download/:filename ──────────────────────────────
router.get('/deployments/download/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const f = db.prepare('SELECT * FROM deployment_files WHERE stored_path = ?').get(req.params.filename);
  res.download(filePath, f ? f.original_name : req.params.filename);
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN-FACING ENDPOINTS (auth required)
// ═══════════════════════════════════════════════════════════════════════════

router.use(authMiddleware);

// ── GET /api/endpoints ────────────────────────────────────────────────────
router.get('/', requirePermission('endpoints:read'), (req, res) => {
  try {
    const { status, search } = req.query;
    let query = 'SELECT * FROM endpoints';
    const params = [];
    const wheres = [];
    if (status) { wheres.push('status = ?'); params.push(status); }
    if (search) { wheres.push('(hostname LIKE ? OR ip_address LIKE ? OR domain LIKE ?)'); const q = `%${search}%`; params.push(q,q,q); }
    if (wheres.length) query += ' WHERE ' + wheres.join(' AND ');
    query += ' ORDER BY last_heartbeat DESC';
    const endpoints = db.prepare(query).all(...params);
    // Check offline (no heartbeat in 5 min)
    const cutoff = new Date(Date.now() - 300000).toISOString().slice(0, 19).replace('T', ' ');
    for (const ep of endpoints) {
      if (ep.status === 'online' && ep.last_heartbeat < cutoff) {
        db.prepare("UPDATE endpoints SET status='offline' WHERE id=?").run(ep.id);
        ep.status = 'offline';
      }
    }
    res.json({ success: true, count: endpoints.length, endpoints });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/endpoints/:id ───────────────────────────────────────────────
router.get('/:id', requirePermission('endpoints:read'), (req, res) => {
  try {
    const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
    if (!ep) return res.status(404).json({ error: 'Endpoint not found' });
    const history = db.prepare('SELECT * FROM deployments WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
    res.json({ success: true, endpoint: ep, history });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/deployments ─────────────────────────────────────────────────
router.get('/deployments/list', requirePermission('endpoints:read'), (req, res) => {
  try {
    const { status: filterStatus, endpoint_id } = req.query;
    let query = `
      SELECT d.*, e.hostname, f.name as file_name, f.original_name, f.file_type
      FROM deployments d
      LEFT JOIN endpoints e ON e.id = d.endpoint_id
      LEFT JOIN deployment_files f ON f.id = d.file_id
    `;
    const params = [];
    const wheres = [];
    if (filterStatus) { wheres.push('d.status = ?'); params.push(filterStatus); }
    if (endpoint_id) { wheres.push('d.endpoint_id = ?'); params.push(endpoint_id); }
    if (wheres.length) query += ' WHERE ' + wheres.join(' AND ');
    query += ' ORDER BY d.created_at DESC LIMIT 200';
    const list = db.prepare(query).all(...params);
    res.json({ success: true, count: list.length, deployments: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/deployments ────────────────────────────────────────────────
router.post('/deployments', requirePermission('endpoints:deploy'), (req, res) => {
  try {
    const { file_id, endpoint_id } = req.body;
    if (!file_id || !endpoint_id) return res.status(400).json({ error: 'file_id and endpoint_id are required' });
    const ep = db.prepare('SELECT id FROM endpoints WHERE id = ?').get(endpoint_id);
    if (!ep) return res.status(404).json({ error: 'Endpoint not found' });
    const f = db.prepare('SELECT id FROM deployment_files WHERE id = ?').get(file_id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    const r = db.prepare(`INSERT INTO deployments (file_id, endpoint_id, status, created_by) VALUES (?,?,'pending',?)`).run(file_id, endpoint_id, req.user?.username||'admin');
    res.json({ success: true, id: r.lastInsertRowid, message: 'Deployment created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/deployments/bulk ───────────────────────────────────────────
router.post('/deployments/bulk', requirePermission('endpoints:deploy'), (req, res) => {
  try {
    const { file_id, endpoint_ids } = req.body;
    if (!file_id || !endpoint_ids || !Array.isArray(endpoint_ids) || endpoint_ids.length === 0)
      return res.status(400).json({ error: 'file_id and endpoint_ids[] required' });
    const stmt = db.prepare(`INSERT OR IGNORE INTO deployments (file_id, endpoint_id, status, created_by) VALUES (?,?,'pending',?)`);
    const tx = db.transaction((ids) => {
      for (const eid of ids) stmt.run(file_id, eid, req.user?.username||'admin');
    });
    tx(endpoint_ids);
    res.json({ success: true, count: endpoint_ids.length, message: `Deployed to ${endpoint_ids.length} endpoints` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/deployments/upload ─────────────────────────────────────────
router.post('/deployments/upload', requirePermission('endpoints:manage'), upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { name, description } = req.body;
    const displayName = name || req.file.originalname;
    const r = db.prepare(`INSERT INTO deployment_files (name, description, original_name, stored_path, file_size, file_type) VALUES (?,?,?,?,?,?)`)
      .run(displayName, description||null, req.file.originalname, req.file.filename, req.file.size, path.extname(req.file.originalname).toLowerCase());
    const cleanup = cleanupDuplicatePackages();
    res.json({ success: true, id: r.lastInsertRowid, message: 'File uploaded', cleanedUp: cleanup, file: { id: r.lastInsertRowid, name: displayName, size: req.file.size } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helper: remove duplicate deployment packages, keep only the latest per original_name ──
function cleanupDuplicatePackages() {
  const groups = db.prepare(`SELECT original_name, MAX(id) as keep_id FROM deployment_files GROUP BY original_name HAVING COUNT(*) > 1`).all();
  let deletedFiles = 0;
  let freedBytes = 0;
  for (const g of groups) {
    const dups = db.prepare(`SELECT * FROM deployment_files WHERE original_name = ? AND id != ? ORDER BY id ASC`).all(g.original_name, g.keep_id);
    for (const f of dups) {
      // Remove physical file
      const filePath = path.join(UPLOAD_DIR, f.stored_path);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { console.error('[cleanup] Failed to delete file:', filePath, e.message); }
      }
      freedBytes += (f.file_size || 0);
      // Delete deployments tied to this file (history no longer meaningful without package)
      db.prepare('DELETE FROM deployments WHERE file_id = ?').run(f.id);
      // Delete file record
      db.prepare('DELETE FROM deployment_files WHERE id = ?').run(f.id);
      deletedFiles++;
    }
  }
  if (deletedFiles > 0) {
    console.log(`[cleanup] Removed ${deletedFiles} duplicate package(s), freed ${Math.round(freedBytes / 1024 / 1024 * 10) / 10} MB`);
  }
  return { deleted: deletedFiles, freedBytes };
}

// ── GET /api/deployments/files ───────────────────────────────────────────
router.get('/deployments/files', requirePermission('endpoints:read'), (req, res) => {
  try {
    const files = db.prepare('SELECT * FROM deployment_files ORDER BY created_at DESC').all();
    res.json({ success: true, count: files.length, files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/deployments/cleanup-duplicates ─────────────────────────────
router.post('/deployments/cleanup-duplicates', requirePermission('endpoints:manage'), (req, res) => {
  try {
    const result = cleanupDuplicatePackages();
    res.json({ success: true, message: `Cleaned up ${result.deleted} duplicate package(s)`, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/deployments/files/:id ────────────────────────────────────
router.delete('/deployments/files/:id', requirePermission('endpoints:manage'), (req, res) => {
  try {
    const f = db.prepare('SELECT * FROM deployment_files WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(UPLOAD_DIR, f.stored_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM deployments WHERE file_id = ?').run(f.id);
    db.prepare('DELETE FROM deployment_files WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'File deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/deployments/:id/cancel ─────────────────────────────────────
router.post('/deployments/:id/cancel', requirePermission('endpoints:deploy'), (req, res) => {
  try {
    const d = db.prepare('SELECT id FROM deployments WHERE id = ? AND status IN (\'pending\',\'in_progress\')').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Deployment not found or already completed' });
    db.prepare("UPDATE deployments SET status='cancelled', completed_at=datetime('now') WHERE id=?").run(req.params.id);
    res.json({ success: true, message: 'Deployment cancelled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
