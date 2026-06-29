const express = require('express');
const router = express.Router();
const { authMiddleware, requirePermission } = require('../middleware/auth');
const rbac = require('../services/rbac.service');
const audit = require('../services/audit.service');

router.use(authMiddleware);
router.use(requirePermission('rbac:manage'));

// ── GET /api/rbac/roles ────────────────────────────────────────────────────
router.get('/roles', (req, res) => {
  try {
    const roles = rbac.getAllRoles();
    res.json({ success: true, roles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rbac/roles ───────────────────────────────────────────────────
router.post('/roles', (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name || !Array.isArray(permissions)) {
      return res.status(400).json({ error: 'name and permissions[] are required' });
    }
    const role = rbac.createRole({ name, description, permissions });
    audit.log('role_created', 'role', role.name, String(role.id), req.user.username, JSON.stringify(permissions), 'success');
    res.json({ success: true, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/rbac/roles/:id ────────────────────────────────────────────────
router.put('/roles/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, permissions } = req.body;
    const role = rbac.updateRole(id, { name, description, permissions });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    audit.log('role_updated', 'role', role.name, String(role.id), req.user.username, JSON.stringify(role.permissions), 'success');
    res.json({ success: true, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/rbac/roles/:id ─────────────────────────────────────────────
router.delete('/roles/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const role = rbac.getRoleById(id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    rbac.deleteRole(id);
    audit.log('role_deleted', 'role', role.name, String(id), req.user.username, null, 'success');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rbac/assignments ──────────────────────────────────────────────
router.get('/assignments', (req, res) => {
  try {
    const assignments = rbac.getAllAssignments();
    res.json({ success: true, assignments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rbac/assignments ───────────────────────────────────────────────
router.post('/assignments', (req, res) => {
  try {
    const { username, role_id } = req.body;
    if (!username || !role_id) {
      return res.status(400).json({ error: 'username and role_id are required' });
    }
    const roles = rbac.assignRole(username, role_id, req.user.username);
    audit.log('role_assigned', 'user', username, null, req.user.username, `role_id=${role_id}`, 'success');
    res.json({ success: true, roles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/rbac/assignments/:username ────────────────────────────────────
router.put('/assignments/:username', (req, res) => {
  try {
    const username = req.params.username;
    const { role_ids } = req.body;
    if (!Array.isArray(role_ids)) {
      return res.status(400).json({ error: 'role_ids[] is required' });
    }
    const roles = rbac.setUserRoles(username, role_ids, req.user.username);
    audit.log('roles_set', 'user', username, null, req.user.username, JSON.stringify(role_ids), 'success');
    res.json({ success: true, roles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/rbac/assignments ─────────────────────────────────────────────
router.delete('/assignments', (req, res) => {
  try {
    const { username, role_id } = req.body;
    if (!username || !role_id) {
      return res.status(400).json({ error: 'username and role_id are required' });
    }
    const roles = rbac.revokeRole(username, role_id);
    audit.log('role_revoked', 'user', username, null, req.user.username, `role_id=${role_id}`, 'success');
    res.json({ success: true, roles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
