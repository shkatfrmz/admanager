const jwt = require('jsonwebtoken');
const rbac = require('../services/rbac.service');

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const permissions = rbac.getUserPermissions(decoded.username);
    const roles = rbac.getUserRoles(decoded.username);
    req.user = {
      ...decoded,
      permissions,
      roles: roles.map(r => ({ id: r.id, name: r.name, description: r.description }))
    };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Access denied. No user context.' });
    }
    const perms = req.user.permissions || [];
    // Admin fallback: if no roles assigned, allow everything (migration safety)
    if (perms.length === 0) {
      return next();
    }
    if (perms.includes(permission)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: insufficient permissions.' });
  };
}

module.exports = authMiddleware;
module.exports.authMiddleware = authMiddleware;
module.exports.requirePermission = requirePermission;
