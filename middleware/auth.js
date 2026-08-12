const { queryOne, query } = require('../db');

// Extract the session token from a request: cookie first, then the
// Authorization: Bearer header (for mobile/API clients).
function getSessionToken(req) {
  const cookieToken = req.cookies.session;
  if (cookieToken) {
    return { token: cookieToken, isBearer: false };
  }

  if (req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return { token: parts[1], isBearer: true };
    }
  }

  return { token: null, isBearer: false };
}

async function requireAuth(req, res, next) {
  const { token, isBearer } = getSessionToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const session = await queryOne(
      `SELECT s.user_id, s.expires_at, u.email, u.display_name, u.tier,
              u.is_admin, u.early_adopter, u.timezone, u.onboarded_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (!session) {
      if (!isBearer) res.clearCookie('session'); // Only clear cookie if it was cookie-based auth
      return res.status(401).json({ error: 'Session expired' });
    }

    req.user = {
      id: session.user_id,
      email: session.email,
      displayName: session.display_name,
      tier: session.tier,
      isAdmin: session.is_admin,
      earlyAdopter: session.early_adopter,
      timezone: session.timezone,
      onboarded: !!session.onboarded_at,
    };

    // Update last_active_at
    query(
      'UPDATE users SET last_active_at = NOW() WHERE id = $1',
      [session.user_id]
    ).catch(() => {});

    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// Optional auth - attaches user if session exists, continues without if not
async function optionalAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return next();

  try {
    const session = await queryOne(
      `SELECT s.user_id, u.email, u.display_name, u.tier,
              u.is_admin, u.early_adopter, u.timezone, u.onboarded_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (session) {
      req.user = {
        id: session.user_id,
        email: session.email,
        displayName: session.display_name,
        tier: session.tier,
        isAdmin: session.is_admin,
        earlyAdopter: session.early_adopter,
        timezone: session.timezone,
        onboarded: !!session.onboarded_at,
      };
    }
  } catch (err) {
    // Silently continue without auth
  }

  next();
}

module.exports = { requireAuth, optionalAuth, getSessionToken };
