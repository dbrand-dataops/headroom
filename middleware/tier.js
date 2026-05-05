const { queryOne } = require('../db');

// Check if user has full access (full tier, early adopter, or admin)
function hasFullAccess(user) {
  return user.tier === 'full'
      || user.tier === 'early_adopter'
      || user.earlyAdopter
      || user.isAdmin;
}

// Middleware that requires full tier for the route
function requireFull(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!hasFullAccess(req.user)) {
    return res.status(403).json({
      error: 'This feature requires a full account.',
      tier: req.user.tier,
      upgrade: true,
    });
  }

  next();
}

// Get tier limits from config (cached in memory, refreshed every 5 min)
let limitsCache = null;
let limitsCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getTierLimits() {
  if (limitsCache && Date.now() - limitsCacheTime < CACHE_TTL) {
    return limitsCache;
  }

  try {
    const maxItems = await queryOne("SELECT value FROM config WHERE key = 'max_items_free'");
    const maxDays = await queryOne("SELECT value FROM config WHERE key = 'max_history_days_free'");

    limitsCache = {
      maxItemsFree: maxItems ? JSON.parse(maxItems.value) : 5,
      maxHistoryDaysFree: maxDays ? JSON.parse(maxDays.value) : 7,
    };
    limitsCacheTime = Date.now();
  } catch (err) {
    // Fallback defaults
    limitsCache = { maxItemsFree: 5, maxHistoryDaysFree: 7 };
    limitsCacheTime = Date.now();
  }

  return limitsCache;
}

module.exports = { hasFullAccess, requireFull, getTierLimits };
