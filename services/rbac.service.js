const db = require('../db/database');

// Permission definitions — organized by functional area.
const PERMISSIONS = {
  users: {
    read:        'users:read',
    create:      'users:create',
    edit:        'users:edit',
    delete:      'users:delete',
    enable:      'users:enable',
    disable:     'users:disable',
    resetPassword:'users:reset_password',
    bulk:        'users:bulk',
    unlock:      'users:unlock'
  },
  groups: {
    read:        'groups:read',
    create:      'groups:create',
    edit:        'groups:edit',
    delete:      'groups:delete',
    manageMembers:'groups:manage_members'
  },
  computers: {
    read:        'computers:read',
    enable:      'computers:enable',
    disable:     'computers:disable',
    delete:      'computers:delete'
  },
  contacts: {
    read:        'contacts:read',
    edit:        'contacts:edit'
  },
  ous: {
    read:        'ous:read'
  },
  reports: {
    read:        'reports:read',
    writeAttributes: 'reports:write_attributes',
    restore:     'reports:restore'
  },
  audit: {
    read:        'audit:read'
  },
  endpoints: {
    read:        'endpoints:read',
    deploy:      'endpoints:deploy',
    manage:      'endpoints:manage'
  },
  sync: {
    trigger:     'sync:trigger'
  },
  scheduledAccess: {
    manage:      'scheduled_access:manage'
  },
  settings: {
    manage:      'settings:manage'
  },
  rbac: {
    manage:      'rbac:manage'
  }
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS).flatMap(area => Object.values(area));

// Built-in roles shipped with the application.
const DEFAULT_ROLES = [
  {
    name: 'admin',
    description: 'Full access to all features',
    permissions: ALL_PERMISSIONS,
    is_system: 1
  },
  {
    name: 'helpdesk',
    description: 'Can reset passwords, enable/disable users, and view directory',
    permissions: [
      PERMISSIONS.users.read,
      PERMISSIONS.users.enable,
      PERMISSIONS.users.disable,
      PERMISSIONS.users.resetPassword,
      PERMISSIONS.users.unlock,
      PERMISSIONS.groups.read,
      PERMISSIONS.computers.read,
      PERMISSIONS.contacts.read,
      PERMISSIONS.ous.read,
      PERMISSIONS.reports.read,
      PERMISSIONS.audit.read,
      PERMISSIONS.endpoints.read
    ],
    is_system: 1
  },
  {
    name: 'read-only',
    description: 'Can view directory, reports, and audit logs only',
    permissions: [
      PERMISSIONS.users.read,
      PERMISSIONS.groups.read,
      PERMISSIONS.computers.read,
      PERMISSIONS.contacts.read,
      PERMISSIONS.ous.read,
      PERMISSIONS.reports.read,
      PERMISSIONS.audit.read,
      PERMISSIONS.endpoints.read
    ],
    is_system: 1
  }
];

function ensureDefaultRoles() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO roles (name, description, permissions, is_system)
    VALUES (?, ?, ?, ?)
  `);
  for (const role of DEFAULT_ROLES) {
    insert.run(role.name, role.description, JSON.stringify(role.permissions), role.is_system);
  }
}

function getRoleByName(name) {
  const r = db.prepare('SELECT * FROM roles WHERE name = ?').get(name);
  if (r) r.permissions = safeParse(r.permissions);
  return r;
}

function getRoleById(id) {
  const r = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (r) r.permissions = safeParse(r.permissions);
  return r;
}

function getAllRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY name').all().map(r => ({
    ...r,
    permissions: safeParse(r.permissions)
  }));
}

function createRole({ name, description, permissions }) {
  const insert = db.prepare(`
    INSERT INTO roles (name, description, permissions, is_system)
    VALUES (?, ?, ?, 0)
  `);
  const info = insert.run(name, description || '', JSON.stringify(permissions || []));
  return getRoleById(info.lastInsertRowid);
}

function updateRole(id, { name, description, permissions }) {
  const role = getRoleById(id);
  if (!role) return null;
  if (role.is_system) {
    throw new Error('System roles cannot be modified');
  }
  db.prepare(`
    UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?
  `).run(name, description || role.description, JSON.stringify(permissions || []), id);
  return getRoleById(id);
}

function deleteRole(id) {
  const role = getRoleById(id);
  if (!role) return false;
  if (role.is_system) {
    throw new Error('System roles cannot be deleted');
  }
  db.prepare('DELETE FROM admin_roles WHERE role_id = ?').run(id);
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  return true;
}

function safeParse(json) {
  try {
    return JSON.parse(json || '[]');
  } catch {
    return [];
  }
}

function getUserRoles(username) {
  return db.prepare(`
    SELECT r.* FROM roles r
    JOIN admin_roles ar ON ar.role_id = r.id
    WHERE ar.username = ?
  `).all(username).map(r => ({
    ...r,
    permissions: safeParse(r.permissions)
  }));
}

function getUserPermissions(username) {
  const rows = db.prepare(`
    SELECT DISTINCT r.permissions FROM roles r
    JOIN admin_roles ar ON ar.role_id = r.id
    WHERE ar.username = ?
  `).all(username);
  const set = new Set();
  for (const row of rows) {
    for (const p of safeParse(row.permissions)) {
      set.add(p);
    }
  }
  return Array.from(set);
}

function hasPermission(username, permission) {
  const perms = getUserPermissions(username);
  // Admin fallback: if a user has no roles assigned, allow everything.
  // This prevents locking out existing admins after migration.
  if (perms.length === 0) return true;
  return perms.includes(permission);
}

function hasAnyPermission(username, permissions) {
  if (!Array.isArray(permissions)) permissions = [permissions];
  const perms = getUserPermissions(username);
  if (perms.length === 0) return true; // admin fallback
  return permissions.some(p => perms.includes(p));
}

function assignRole(username, roleId, grantedBy) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO admin_roles (username, role_id, granted_by)
    VALUES (?, ?, ?)
  `);
  insert.run(username, roleId, grantedBy || null);
  return getUserRoles(username);
}

function revokeRole(username, roleId) {
  db.prepare('DELETE FROM admin_roles WHERE username = ? AND role_id = ?').run(username, roleId);
  return getUserRoles(username);
}

function setUserRoles(username, roleIds, grantedBy) {
  db.prepare('DELETE FROM admin_roles WHERE username = ?').run(username);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO admin_roles (username, role_id, granted_by)
    VALUES (?, ?, ?)
  `);
  for (const id of roleIds) {
    insert.run(username, id, grantedBy || null);
  }
  return getUserRoles(username);
}

function getAllAssignments() {
  return db.prepare(`
    SELECT ar.*, r.name as role_name FROM admin_roles ar
    JOIN roles r ON r.id = ar.role_id
    ORDER BY ar.username, r.name
  `).all();
}

// Initialize built-in roles on first load.
ensureDefaultRoles();

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  DEFAULT_ROLES,
  getAllRoles,
  getRoleById,
  getRoleByName,
  createRole,
  updateRole,
  deleteRole,
  getUserRoles,
  getUserPermissions,
  hasPermission,
  hasAnyPermission,
  assignRole,
  revokeRole,
  setUserRoles,
  getAllAssignments
};
