const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { query, queryOne, transaction } = require('../db');
const { requireAuth, getSessionToken } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rate-limit');
const { sendPasswordResetEmail } = require('./email');

const BCRYPT_ROUNDS = 12;
const SESSION_DAYS = 30;
const RESET_EXPIRY_HOURS = 1;

// Generate a cryptographic token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Set session cookie
function setSessionCookie(res, token) {
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// Validate email format
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Validate password strength
function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}


// ── POST /api/auth/register ──
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password, displayName, timezone } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normEmail = email.trim().toLowerCase();

    // Check for existing user
    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [normEmail]);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Determine tier based on signup mode
    const modeRow = await queryOne("SELECT value FROM config WHERE key = 'signup_mode'");
    const signupMode = modeRow ? modeRow.value : 'launch';

    let tier = 'free';
    let earlyAdopter = false;

    if (signupMode === 'launch') {
      const tierRow = await queryOne("SELECT value FROM config WHERE key = 'launch_tier'");
      tier = tierRow ? tierRow.value : 'full';
      earlyAdopter = true;
    } else if (signupMode === 'freemium') {
      const tierRow = await queryOne("SELECT value FROM config WHERE key = 'freemium_tier'");
      tier = tierRow ? tierRow.value : 'free';
    }

    // Get consent text
    const consentRow = await queryOne("SELECT value FROM config WHERE key = 'registration_consent_text'");
    const consentText = consentRow ? consentRow.value : 'Consent text not configured.';

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create user and log consent in a transaction
    const result = await transaction(async (client) => {
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, display_name, tier, early_adopter, timezone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, display_name, tier, early_adopter, is_admin, timezone, onboarded_at`,
        [normEmail, passwordHash, displayName || null, tier, earlyAdopter,
         timezone || 'Europe/London']
      );

      const user = userResult.rows[0];

      // Log consent
      await client.query(
        `INSERT INTO consent_log (user_id, consent_type, consent_text, ip_address)
         VALUES ($1, 'registration', $2, $3)`,
        [user.id, consentText, req.ip]
      );

      // Create session
      const token = generateToken();
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
      await client.query(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, token, expiresAt]
      );

      return { user, token };
    });

    // Check if mobile client
    if (req.headers['x-client'] === 'mobile') {
      // Return token in JSON body for mobile clients (they'll store it in secure storage)
      return res.status(201).json({
        user: {
          id: result.user.id,
          email: result.user.email,
          displayName: result.user.display_name,
          tier: result.user.tier,
          earlyAdopter: result.user.early_adopter,
          isAdmin: result.user.is_admin,
          timezone: result.user.timezone,
          onboarded: !!result.user.onboarded_at,
        },
        token: result.token,  // Mobile client will store this in secure storage
      });
    }

    // For web clients, use cookie-based auth
    setSessionCookie(res, result.token);

    return res.status(201).json({
      user: {
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.display_name,
        tier: result.user.tier,
        earlyAdopter: result.user.early_adopter,
        isAdmin: result.user.is_admin,
        timezone: result.user.timezone,
        onboarded: !!result.user.onboarded_at,
      },
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});


// ── POST /api/auth/login ──
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normEmail = email.trim().toLowerCase();

    const user = await queryOne(
      `SELECT id, email, password_hash, display_name, tier, is_admin,
              early_adopter, timezone, onboarded_at
       FROM users WHERE email = $1`,
      [normEmail]
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Create session
    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    // Update last active
    await query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);

    // Check if mobile client
    if (req.headers['x-client'] === 'mobile') {
      return res.json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          tier: user.tier,
          earlyAdopter: user.early_adopter,
          isAdmin: user.is_admin,
          timezone: user.timezone,
          onboarded: !!user.onboarded_at,
        },
        token: token,
      });
    }

    // For web clients, use cookie-based auth
    setSessionCookie(res, token);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        tier: user.tier,
        earlyAdopter: user.early_adopter,
        isAdmin: user.is_admin,
        timezone: user.timezone,
        onboarded: !!user.onboarded_at,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});


// ── POST /api/auth/logout ──
router.post('/logout', async (req, res) => {
  const { token, isBearer } = getSessionToken(req);

  if (token) {
    await query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
    if (!isBearer) res.clearCookie('session', { path: '/' });
  }

  return res.json({ ok: true });
});


// ── GET /api/auth/me ──
// Returns current user if authenticated, 401 if not
router.get('/me', requireAuth, (req, res) => {
  return res.json({ user: req.user });
});


// ── PUT /api/auth/password ──
// Change password while logged in
router.put('/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required.' });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const user = await queryOne('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.id]);

    // Invalidate all other sessions
    const { token: currentToken } = getSessionToken(req);
    await query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [req.user.id, currentToken]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Password change error:', err.message);
    return res.status(500).json({ error: 'Password change failed.' });
  }
});


// ── PUT /api/auth/profile ──
// Update display name, timezone
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { displayName, timezone } = req.body;

    const updates = [];
    const values = [];
    let idx = 1;

    if (displayName !== undefined) {
      updates.push(`display_name = $${idx++}`);
      values.push(displayName || null);
    }
    if (timezone) {
      updates.push(`timezone = $${idx++}`);
      values.push(timezone);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Profile update error:', err.message);
    return res.status(500).json({ error: 'Profile update failed.' });
  }
});


// ── Clean up expired sessions (called periodically or on startup) ──
async function cleanExpiredSessions() {
  try {
    const result = await query('DELETE FROM sessions WHERE expires_at < NOW()');
    if (result.rowCount > 0) {
      console.log(`Cleaned ${result.rowCount} expired session(s)`);
    }
  } catch (err) {
    console.error('Session cleanup error:', err.message);
  }
}

// Run cleanup every hour
setInterval(cleanExpiredSessions, 60 * 60 * 1000);


// ── POST /api/auth/forgot-password ──
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const normEmail = email.trim().toLowerCase();
    const user = await queryOne('SELECT id FROM users WHERE email = $1', [normEmail]);

    // Always respond ok, even if email doesn't exist (security best practice)
    if (!user) {
      return res.json({ ok: true });
    }

    // Generate token (raw token sent to user, hash stored in DB)
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store token hash in DB
    await query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );

    // Send email (fire and forget, errors logged but don't fail the request)
    sendPasswordResetEmail(normEmail, token).catch(err => {
      console.error('Failed to send reset email:', err.message);
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    return res.status(500).json({ error: 'Request failed. Please try again.' });
  }
});

// ── POST /api/auth/reset-password ──
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Hash the provided token and look it up
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRecord = await queryOne(
      `SELECT user_id FROM password_resets
       WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL`,
      [tokenHash]
    );

    if (!resetRecord) {
      // Token invalid, expired, or already used
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    // Hash new password and update user
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await transaction(async (client) => {
      // Update password
      await client.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, resetRecord.user_id]
      );

      // Mark token as used (don't delete, keep the audit trail)
      await client.query(
        'UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1',
        [tokenHash]
      );

      // Invalidate all sessions for this user
      await client.query('DELETE FROM sessions WHERE user_id = $1', [resetRecord.user_id]);
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err.message);
    return res.status(500).json({ error: 'Reset failed. Please try again.' });
  }
});

module.exports = router;
