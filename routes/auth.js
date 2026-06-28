const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const adService = require('../services/ad.service');
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');

/**
 * POST /api/auth/login
 * Authenticate against AD and return JWT
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const isAuthenticated = await adService.authenticateUser(username, password);

    if (!isAuthenticated) {
      audit.log('login_failed', 'user', username, null, username, 'Invalid credentials', 'failure');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get user details after successful auth
    const user = await adService.findUser(username);

    audit.log('login_success', 'user', username, null, username, 'Successful login', 'success');

    const token = jwt.sign(
      {
        username,
        displayName: user?.displayName,
        email: user?.mail
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      success: true,
      token,
      user: {
        username,
        displayName: user?.displayName,
        email: user?.mail
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    audit.log('login_failed', 'user', username, null, username, err.message, 'failure');
    res.status(500).json({ error: 'Authentication failed', details: err.message });
  }
});

// ── GET /api/auth/me — validate token and return current user ─────────────
router.get('/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
