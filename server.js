require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(compression()); // Enable gzip compression for all responses
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cache middleware for GET requests (5 minutes for list endpoints, 1 hour for cache)
app.use((req, res, next) => {
  if (req.method === 'GET') {
    res.set('Cache-Control', req.path.includes('/api/') ? 'public, max-age=300' : 'public, max-age=3600');
  } else {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// Rate limiting — protect against brute force (skip agent-facing endpoints)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000,
  skip: (req) => {
    // Agent endpoints poll frequently; don't rate-limit them
    const agentPaths = ['/api/endpoints/register', '/api/endpoints/heartbeat', '/api/endpoints/deployments'];
    return agentPaths.some(p => req.path.startsWith(p));
  }
});
app.use('/api/', limiter);

// Stricter limit on login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/auth/login', loginLimiter);

// ── Serve static frontend (no-cache so browser always gets latest) ────────────
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/users',      require('./routes/users'));
app.use('/api/groups',     require('./routes/groups'));
app.use('/api/licenses',   require('./routes/licenses'));
app.use('/api/sync',       require('./routes/sync'));
app.use('/api/scheduled',  require('./routes/scheduled-access'));
app.use('/api/audit',       require('./routes/audit'));
app.use('/api/computers',   require('./routes/computers'));
app.use('/api/contacts',    require('./routes/contacts'));
app.use('/api/ous',         require('./routes/ous'));
app.use('/api/reports',     require('./routes/reports'));
app.use('/api/bulk',        require('./routes/bulk'));
app.use('/api/endpoints',   require('./routes/endpoints'));
app.use('/api/health',      require('./routes/health'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── AD Connection test ─────────────────────────────────────────────────────────
app.get('/api/test-ad', async (req, res) => {
  try {
    const adService = require('./services/ad.service');
    // Try to get all users as a test
    const users = await adService.getAllUsers();
    res.json({ 
      status: 'connected', 
      message: 'Successfully connected to Active Directory',
      usersFound: users?.length || 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[test-ad] Connection failed:', err.message);
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to connect to Active Directory',
      error: err.message,
      troubleshooting: [
        'Check AD_URL is correct in .env',
        'Check AD_BASE_DN is correct in .env',
        'Check AD_USERNAME and AD_PASSWORD are set in .env',
        'Verify network connectivity to AD server',
        'Check firewall rules for LDAP port (389 or 636 for LDAPS)'
      ]
    });
  }
});

// ── Catch-all → serve frontend ────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║        AD Manager Running             ║
  ║   http://localhost:${PORT}               ║
  ╚═══════════════════════════════════════╝
  `);

  // Start background AD → SQLite sync (runs immediately, then every 2 min)
  const syncService = require('./services/sync.service');
  syncService.startScheduler();
});
