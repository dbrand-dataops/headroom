const express = require('express');
const router = express.Router();
const { query, queryOne, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

// All admin routes require auth + admin
router.use(requireAuth);
router.use(requireAdmin);


// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

// ── GET /api/admin/config ──
router.get('/config', async (req, res) => {
  try {
    const result = await query('SELECT key, value FROM config ORDER BY key');
    const config = {};
    for (const row of result.rows) {
      config[row.key] = row.value;
    }
    return res.json({ config });
  } catch (err) {
    console.error('Admin config error:', err.message);
    return res.status(500).json({ error: 'Failed to load config.' });
  }
});

// ── PUT /api/admin/config ──
router.put('/config', async (req, res) => {
  try {
    const { updates } = req.body;

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Updates object required.' });
    }

    for (const [key, value] of Object.entries(updates)) {
      await query(
        `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Admin config update error:', err.message);
    return res.status(500).json({ error: 'Failed to update config.' });
  }
});


// ═══════════════════════════════════════
// USERS
// ═══════════════════════════════════════

// ── GET /api/admin/users ──
router.get('/users', async (req, res) => {
  try {
    const search = req.query.search || '';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    let result;
    if (search) {
      result = await query(
        `SELECT u.id, u.email, u.display_name, u.tier, u.is_admin,
                u.early_adopter, u.onboarded_at, u.last_active_at, u.created_at,
                (SELECT COUNT(*) FROM entries WHERE user_id = u.id) AS entry_count,
                (SELECT COUNT(*) FROM share_tokens WHERE user_id = u.id AND revoked_at IS NULL) AS share_count
         FROM users u
         WHERE u.email ILIKE $1 OR u.display_name ILIKE $1
         ORDER BY u.created_at DESC
         LIMIT $2 OFFSET $3`,
        [`%${search}%`, limit, offset]
      );
    } else {
      result = await query(
        `SELECT u.id, u.email, u.display_name, u.tier, u.is_admin,
                u.early_adopter, u.onboarded_at, u.last_active_at, u.created_at,
                (SELECT COUNT(*) FROM entries WHERE user_id = u.id) AS entry_count,
                (SELECT COUNT(*) FROM share_tokens WHERE user_id = u.id AND revoked_at IS NULL) AS share_count
         FROM users u
         ORDER BY u.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    }

    const total = await queryOne('SELECT COUNT(*) AS count FROM users');

    return res.json({
      users: result.rows.map(r => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        tier: r.tier,
        isAdmin: r.is_admin,
        earlyAdopter: r.early_adopter,
        onboarded: !!r.onboarded_at,
        lastActive: r.last_active_at,
        createdAt: r.created_at,
        entryCount: parseInt(r.entry_count),
        shareCount: parseInt(r.share_count),
      })),
      total: parseInt(total.count),
    });
  } catch (err) {
    console.error('Admin users error:', err.message);
    return res.status(500).json({ error: 'Failed to load users.' });
  }
});

// ── PUT /api/admin/users/:id/tier ──
router.put('/users/:id/tier', async (req, res) => {
  try {
    const { tier } = req.body;

    if (!['free', 'full', 'early_adopter'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier.' });
    }

    const result = await query(
      'UPDATE users SET tier = $1, updated_at = NOW() WHERE id = $2',
      [tier, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Admin tier update error:', err.message);
    return res.status(500).json({ error: 'Failed to update tier.' });
  }
});

// ── GET /api/admin/users/:id/data ──
// View a user's full data (support / GDPR subject access)
router.get('/users/:id/data', async (req, res) => {
  try {
    const userId = req.params.id;

    const user = await queryOne(
      'SELECT id, email, display_name, tier, early_adopter, timezone, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const items = await query('SELECT * FROM items WHERE user_id = $1', [userId]);
    const entries = await query('SELECT * FROM entries WHERE user_id = $1 ORDER BY logged_at', [userId]);
    const shares = await query('SELECT * FROM share_tokens WHERE user_id = $1', [userId]);
    const consents = await query('SELECT * FROM consent_log WHERE user_id = $1', [userId]);

    return res.json({
      user,
      items: items.rows,
      entries: entries.rows,
      shares: shares.rows,
      consents: consents.rows,
    });
  } catch (err) {
    console.error('Admin user data error:', err.message);
    return res.status(500).json({ error: 'Failed to load user data.' });
  }
});

// ── DELETE /api/admin/users/:id ──
// GDPR erasure (admin-initiated)
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Prevent self-deletion
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own admin account from here.' });
    }

    await transaction(async (client) => {
      // Nullify donation user references (keep financial records)
      await client.query('UPDATE donations SET user_id = NULL WHERE user_id = $1', [userId]);
      // Delete everything else (cascades handle most of it)
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    });

    return res.json({ ok: true, deleted: userId });
  } catch (err) {
    console.error('Admin delete user error:', err.message);
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});


// ═══════════════════════════════════════
// PARTNER CODES
// ═══════════════════════════════════════

// ── GET /api/admin/partner-codes ──
router.get('/partner-codes', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM partner_codes ORDER BY created_at DESC'
    );
    return res.json({ codes: result.rows });
  } catch (err) {
    console.error('Admin partner codes error:', err.message);
    return res.status(500).json({ error: 'Failed to load partner codes.' });
  }
});

// ── POST /api/admin/partner-codes ──
router.post('/partner-codes', async (req, res) => {
  try {
    const { code, label, tierAssignment, maxUses, expiresAt } = req.body;

    if (!code || !label) {
      return res.status(400).json({ error: 'Code and label are required.' });
    }

    const result = await queryOne(
      `INSERT INTO partner_codes (code, label, tier_assignment, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        code.trim().toUpperCase(),
        label.trim(),
        tierAssignment || 'full',
        maxUses || null,
        expiresAt || null,
      ]
    );

    return res.status(201).json({ partnerCode: result });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That code already exists.' });
    }
    console.error('Admin create partner code error:', err.message);
    return res.status(500).json({ error: 'Failed to create partner code.' });
  }
});


// ═══════════════════════════════════════
// DONATIONS & SUBSCRIPTIONS OVERVIEW
// ═══════════════════════════════════════

// ── GET /api/admin/donations ──
router.get('/donations', async (req, res) => {
  try {
    const donations = await query(
      `SELECT d.id, d.amount_pence, d.currency, d.created_at,
              u.email, u.display_name
       FROM donations d
       LEFT JOIN users u ON u.id = d.user_id
       ORDER BY d.created_at DESC
       LIMIT 100`
    );

    const totalResult = await queryOne(
      "SELECT COALESCE(SUM(amount_pence), 0) AS total FROM donations WHERE currency = 'gbp'"
    );

    return res.json({
      donations: donations.rows,
      totalGBP: parseInt(totalResult.total),
    });
  } catch (err) {
    console.error('Admin donations error:', err.message);
    return res.status(500).json({ error: 'Failed to load donations.' });
  }
});


// ═══════════════════════════════════════
// STATS OVERVIEW
// ═══════════════════════════════════════

// ── GET /api/admin/stats ──
router.get('/stats', async (req, res) => {
  try {
    const [users, entries, activeToday, activeWeek] = await Promise.all([
      queryOne('SELECT COUNT(*) AS count FROM users'),
      queryOne('SELECT COUNT(*) AS count FROM entries'),
      queryOne("SELECT COUNT(DISTINCT user_id) AS count FROM entries WHERE logged_at >= NOW() - INTERVAL '1 day'"),
      queryOne("SELECT COUNT(DISTINCT user_id) AS count FROM entries WHERE logged_at >= NOW() - INTERVAL '7 days'"),
    ]);

    return res.json({
      totalUsers: parseInt(users.count),
      totalEntries: parseInt(entries.count),
      activeToday: parseInt(activeToday.count),
      activeThisWeek: parseInt(activeWeek.count),
    });
  } catch (err) {
    console.error('Admin stats error:', err.message);
    return res.status(500).json({ error: 'Failed to load stats.' });
  }
});


module.exports = router;
