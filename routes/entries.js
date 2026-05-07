const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hasFullAccess, getTierLimits } = require('../middleware/tier');


// All routes require authentication
router.use(requireAuth);


// ── POST /api/entries ──
// Log an item tap. Server calculates level_after from current level + value.
router.post('/', async (req, res) => {
  try {
    const { itemId, value } = req.body;

    if (!itemId) {
      return res.status(400).json({ error: 'Item ID is required.' });
    }

    // Verify item belongs to user and is active
    const item = await queryOne(
      'SELECT id, type, default_value FROM items WHERE id = $1 AND user_id = $2 AND active = TRUE',
      [itemId, req.user.id]
    );
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    // Use provided value or item default
    const impactValue = typeof value === 'number' ? value : item.default_value;

    // Calculate delta based on type
    const delta = item.type === 'filler' ? impactValue : -impactValue;

    // Get current level (most recent entry today in user's timezone, or 0)
    const currentLevel = await getCurrentLevel(req.user.id, req.user.timezone);

    // Calculate new level, clamped 0-100
    const newLevel = Math.max(0, Math.min(100, currentLevel + delta));

    // Insert entry
    const entry = await queryOne(
      `INSERT INTO entries (user_id, item_id, value, level_after, logged_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, item_id, value, level_after, logged_at`,
      [req.user.id, item.id, delta, newLevel]
    );

    return res.status(201).json({
      entry: {
        id: entry.id,
        itemId: entry.item_id,
        label: item.type,
        value: delta,
        levelAfter: entry.level_after,
        loggedAt: entry.logged_at,
      },
      level: newLevel,
    });
  } catch (err) {
    console.error('Create entry error:', err.message);
    return res.status(500).json({ error: 'Failed to log entry.' });
  }
});


// ── GET /api/entries ──
// Get history entries with item labels, respecting tier limits
router.get('/', async (req, res) => {
  try {
    let days = parseInt(req.query.days) || 7;
    const limit = parseInt(req.query.limit) || 500;

    // Enforce tier limit on history range
    if (!hasFullAccess(req.user)) {
      const tierLimits = await getTierLimits();
      days = Math.min(days, tierLimits.maxHistoryDaysFree);
    }

    const result = await query(
      `SELECT e.id, e.item_id, i.label, i.type, e.value, e.level_after, e.logged_at
       FROM entries e
       JOIN items i ON i.id = e.item_id
       WHERE e.user_id = $1
         AND e.logged_at >= NOW() - INTERVAL '1 day' * $2
       ORDER BY e.logged_at DESC
       LIMIT $3`,
      [req.user.id, days, limit]
    );

    return res.json({
      entries: result.rows.map(r => ({
        id: r.id,
        itemId: r.item_id,
        label: r.label,
        type: r.type,
        value: r.value,
        levelAfter: r.level_after,
        loggedAt: r.logged_at,
      })),
      days,
    });
  } catch (err) {
    console.error('Get entries error:', err.message);
    return res.status(500).json({ error: 'Failed to load history.' });
  }
});


// ── GET /api/entries/today ──
// Get only today's entries (used by the main bucket view)
router.get('/today', async (req, res) => {
  try {
    const result = await query(
      `SELECT e.id, e.item_id, i.label, i.type, e.value, e.level_after, e.logged_at
       FROM entries e
       JOIN items i ON i.id = e.item_id
       WHERE e.user_id = $1
         AND e.logged_at::date = (NOW() AT TIME ZONE $2)::date
       ORDER BY e.logged_at ASC`,
      [req.user.id, req.user.timezone]
    );

    return res.json({
      entries: result.rows.map(r => ({
        id: r.id,
        itemId: r.item_id,
        label: r.label,
        type: r.type,
        value: r.value,
        levelAfter: r.level_after,
        loggedAt: r.logged_at,
      })),
    });
  } catch (err) {
    console.error('Get today entries error:', err.message);
    return res.status(500).json({ error: 'Failed to load today\'s entries.' });
  }
});


// ── DELETE /api/entries/:id ──
// Delete an entry and recalculate all subsequent levels
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership and get the entry
    const entry = await queryOne(
      'SELECT id, user_id, logged_at FROM entries WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found.' });
    }

    // Get all entries after this one (same day, for recalculation)
    const subsequent = await query(
      `SELECT id, value FROM entries
       WHERE user_id = $1 AND logged_at > $2
       ORDER BY logged_at ASC`,
      [req.user.id, entry.logged_at]
    );

    // Get the level before the deleted entry
    const prior = await queryOne(
      `SELECT level_after FROM entries
       WHERE user_id = $1 AND logged_at < $2
       ORDER BY logged_at DESC LIMIT 1`,
      [req.user.id, entry.logged_at]
    );
    let runningLevel = prior ? prior.level_after : 0;

    // Delete the entry
    await query('DELETE FROM entries WHERE id = $1', [id]);

    // Recalculate all subsequent entries
    for (const sub of subsequent.rows) {
      runningLevel = Math.max(0, Math.min(100, runningLevel + sub.value));
      await query('UPDATE entries SET level_after = $1 WHERE id = $2', [runningLevel, sub.id]);
    }

    return res.json({ ok: true, level: runningLevel });
  } catch (err) {
    console.error('Delete entry error:', err.message);
    return res.status(500).json({ error: 'Failed to delete entry.' });
  }
});


// ── Helper: get current bucket level ──
// Returns the level_after of the most recent entry, regardless of date.
// The bucket does not reset at midnight. Stressors persist until acted on.
async function getCurrentLevel(userId, timezone) {
  const latest = await queryOne(
    `SELECT level_after
     FROM entries
     WHERE user_id = $1
     ORDER BY logged_at DESC
     LIMIT 1`,
    [userId]
  );

  return latest ? latest.level_after : 0;
}


module.exports = router;
module.exports.getCurrentLevel = getCurrentLevel;
