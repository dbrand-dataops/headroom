const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireFull } = require('../middleware/tier');

// Patterns require auth + full tier
router.use(requireAuth);
router.use(requireFull);


// ── GET /api/patterns ──
// Returns computed analytics for the given period
router.get('/', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const userId = req.user.id;
    const tz = req.user.timezone;

    // Run all analytics queries in parallel
    const [
      topFillers,
      topEmptiers,
      byHour,
      byDayOfWeek,
      dailyPeaks,
      longestFillerRun,
      summary,
    ] = await Promise.all([
      // Top load items by cumulative impact
      query(
        `SELECT i.label, COUNT(*) AS count, SUM(e.value) AS total_impact
         FROM entries e JOIN items i ON i.id = e.item_id
         WHERE e.user_id = $1 AND e.value > 0
           AND e.logged_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY i.label
         ORDER BY total_impact DESC
         LIMIT 10`,
        [userId, days]
      ),

      // Top relief items by cumulative impact
      query(
        `SELECT i.label, COUNT(*) AS count, SUM(ABS(e.value)) AS total_relief
         FROM entries e JOIN items i ON i.id = e.item_id
         WHERE e.user_id = $1 AND e.value < 0
           AND e.logged_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY i.label
         ORDER BY total_relief DESC
         LIMIT 10`,
        [userId, days]
      ),

      // Average level by hour of day
      query(
        `SELECT EXTRACT(HOUR FROM logged_at AT TIME ZONE $2) AS hour,
                ROUND(AVG(level_after)) AS avg_level,
                COUNT(*) AS entries
         FROM entries
         WHERE user_id = $1
           AND logged_at >= NOW() - INTERVAL '1 day' * $3
         GROUP BY hour
         ORDER BY hour`,
        [userId, tz, days]
      ),

      // Average level by day of week (0=Sun, 6=Sat)
      query(
        `SELECT EXTRACT(DOW FROM logged_at AT TIME ZONE $2) AS dow,
                ROUND(AVG(level_after)) AS avg_level,
                COUNT(*) AS entries
         FROM entries
         WHERE user_id = $1
           AND logged_at >= NOW() - INTERVAL '1 day' * $3
         GROUP BY dow
         ORDER BY dow`,
        [userId, tz, days]
      ),

      // Peak level per day
      query(
        `SELECT (logged_at AT TIME ZONE $2)::date AS day,
                MAX(level_after) AS peak,
                MIN(level_after) AS low,
                COUNT(*) AS entries
         FROM entries
         WHERE user_id = $1
           AND logged_at >= NOW() - INTERVAL '1 day' * $3
         GROUP BY day
         ORDER BY day`,
        [userId, tz, days]
      ),

      // Longest consecutive filler run without relief
      query(
        `WITH numbered AS (
           SELECT value,
                  ROW_NUMBER() OVER (ORDER BY logged_at) AS rn,
                  SUM(CASE WHEN value <= 0 THEN 1 ELSE 0 END)
                    OVER (ORDER BY logged_at) AS grp
           FROM entries
           WHERE user_id = $1
             AND logged_at >= NOW() - INTERVAL '1 day' * $2
         )
         SELECT MAX(run_length) AS longest_run
         FROM (
           SELECT COUNT(*) AS run_length
           FROM numbered
           WHERE value > 0
           GROUP BY grp
         ) runs`,
        [userId, days]
      ),

      // Summary stats
      query(
        `SELECT COUNT(*) AS total_entries,
                COUNT(DISTINCT (logged_at AT TIME ZONE $2)::date) AS active_days,
                ROUND(AVG(level_after)) AS avg_level,
                MAX(level_after) AS peak_level
         FROM entries
         WHERE user_id = $1
           AND logged_at >= NOW() - INTERVAL '1 day' * $3`,
        [userId, tz, days]
      ),
    ]);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    return res.json({
      period: days,
      summary: summary.rows[0] ? {
        totalEntries: parseInt(summary.rows[0].total_entries),
        activeDays: parseInt(summary.rows[0].active_days),
        avgLevel: parseInt(summary.rows[0].avg_level) || 0,
        peakLevel: parseInt(summary.rows[0].peak_level) || 0,
      } : { totalEntries: 0, activeDays: 0, avgLevel: 0, peakLevel: 0 },

      topFillers: topFillers.rows.map(r => ({
        label: r.label,
        count: parseInt(r.count),
        totalImpact: parseInt(r.total_impact),
      })),

      topEmptiers: topEmptiers.rows.map(r => ({
        label: r.label,
        count: parseInt(r.count),
        totalRelief: parseInt(r.total_relief),
      })),

      byHour: byHour.rows.map(r => ({
        hour: parseInt(r.hour),
        avgLevel: parseInt(r.avg_level),
        entries: parseInt(r.entries),
      })),

      byDayOfWeek: byDayOfWeek.rows.map(r => ({
        day: dayNames[parseInt(r.dow)],
        dow: parseInt(r.dow),
        avgLevel: parseInt(r.avg_level),
        entries: parseInt(r.entries),
      })),

      dailyPeaks: dailyPeaks.rows.map(r => ({
        day: r.day,
        peak: parseInt(r.peak),
        low: parseInt(r.low),
        entries: parseInt(r.entries),
      })),

      longestFillerRun: longestFillerRun.rows[0]
        ? parseInt(longestFillerRun.rows[0].longest_run) || 0
        : 0,
    });
  } catch (err) {
    console.error('Patterns error:', err.message);
    return res.status(500).json({ error: 'Failed to compute patterns.' });
  }
});


module.exports = router;
