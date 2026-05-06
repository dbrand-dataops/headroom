const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getCurrentLevel } = require('./entries');

// All routes require authentication
router.use(requireAuth);

function levelWord(level) {
  if (level <= 20) return 'calm';
  if (level <= 40) return 'settled';
  if (level <= 55) return 'building';
  if (level <= 70) return 'elevated';
  if (level <= 85) return 'high';
  return 'critical';
}

// ── GET /api/bucket ──
// Returns the current bucket state
router.get('/', async (req, res) => {
  try {
    const level = await getCurrentLevel(req.user.id, req.user.timezone);
    const headroom = 100 - level;

    return res.json({
      level,
      headroom,
      word: levelWord(level),
    });
  } catch (err) {
    console.error('Bucket error:', err.message);
    return res.status(500).json({ error: 'Failed to load bucket state.' });
  }
});

module.exports = router;
