const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log connection status
pool.on('connect', () => {
  console.log('PostgreSQL client connected');
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// Query helper with parameterised queries
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 500) {
    console.log('Slow query:', { text: text.substring(0, 80), duration, rows: result.rowCount });
  }
  return result;
}

// Transaction helper
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Single row helper
async function queryOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

module.exports = { pool, query, queryOne, transaction };
