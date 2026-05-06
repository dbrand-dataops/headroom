const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hasFullAccess } = require('../middleware/tier');


// ── POST /api/share ──
// Create a share token (requires full access)
router.post('/', requireAuth, async (req, res) => {
  try {
    if (!hasFullAccess(req.user)) {
      return res.status(403).json({
        error: 'Share links require a full account.',
        upgrade: true,
      });
    }

    const { label } = req.body;
    const tokenLabel = (label && label.trim()) || 'Shared view';

    if (tokenLabel.length > 60) {
      return res.status(400).json({ error: 'Label must be 60 characters or less.' });
    }

    // Limit to 10 active share tokens per user
    const countResult = await queryOne(
      'SELECT COUNT(*) AS count FROM share_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [req.user.id]
    );
    if (parseInt(countResult.count) >= 10) {
      return res.status(400).json({ error: 'Maximum of 10 active share links.' });
    }

    const token = crypto.randomBytes(32).toString('hex');

    const result = await queryOne(
      `INSERT INTO share_tokens (user_id, token, label)
       VALUES ($1, $2, $3)
       RETURNING id, token, label, created_at`,
      [req.user.id, token, tokenLabel]
    );

    return res.status(201).json({
      share: {
        id: result.id,
        token: result.token,
        label: result.label,
        url: `${req.protocol}://${req.get('host')}/#/shared/${result.token}`,
        createdAt: result.created_at,
      },
    });
  } catch (err) {
    console.error('Create share error:', err.message);
    return res.status(500).json({ error: 'Failed to create share link.' });
  }
});


// ── GET /api/share ──
// List user's share tokens
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, token, label, created_at, revoked_at
       FROM share_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    return res.json({
      shares: result.rows.map(r => ({
        id: r.id,
        token: r.token,
        label: r.label,
        url: `${req.protocol}://${req.get('host')}/#/shared/${r.token}`,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
        active: !r.revoked_at,
      })),
    });
  } catch (err) {
    console.error('List shares error:', err.message);
    return res.status(500).json({ error: 'Failed to load share links.' });
  }
});


// ── DELETE /api/share/:id ──
// Revoke a share token
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE share_tokens SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Share link not found or already revoked.' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Revoke share error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke share link.' });
  }
});


// ── GET /api/shared/:token ──
// Public endpoint: view someone's bucket via share token (no auth required)
router.get('/view/:token', async (req, res) => {
  try {
    const share = await queryOne(
      `SELECT st.user_id, st.label, u.display_name, u.timezone
       FROM share_tokens st
       JOIN users u ON u.id = st.user_id
       WHERE st.token = $1 AND st.revoked_at IS NULL`,
      [req.params.token]
    );

    if (!share) {
      return res.status(404).json({ error: 'Share link not found or has been revoked.' });
    }

    // Get current level
    const { getCurrentLevel } = require('./entries');
    const level = await getCurrentLevel(share.user_id, share.timezone);
    const headroom = 100 - level;

    // Get recent entries (last 7 days)
    const entries = await query(
      `SELECT e.id, i.label, i.type, e.value, e.level_after, e.logged_at
       FROM entries e
       JOIN items i ON i.id = e.item_id
       WHERE e.user_id = $1
         AND e.logged_at >= NOW() - INTERVAL '7 days'
       ORDER BY e.logged_at DESC
       LIMIT 200`,
      [share.user_id]
    );

    // Level word
    let word = 'calm';
    if (level > 85) word = 'critical';
    else if (level > 70) word = 'high';
    else if (level > 55) word = 'elevated';
    else if (level > 40) word = 'building';
    else if (level > 20) word = 'settled';

    return res.json({
      displayName: share.display_name || 'Anonymous',
      shareLabel: share.label,
      level,
      headroom,
      word,
      entries: entries.rows.map(r => ({
        id: r.id,
        label: r.label,
        type: r.type,
        value: r.value,
        levelAfter: r.level_after,
        loggedAt: r.logged_at,
      })),
    });
  } catch (err) {
    console.error('View share error:', err.message);
    return res.status(500).json({ error: 'Failed to load shared view.' });
  }
});


module.exports = router;
