const fs = require('fs');
const path = require('path');
const { pool, query } = require('./db');

async function migrate() {
  // Ensure migrations table exists
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const applied = await query('SELECT filename FROM migrations ORDER BY filename');
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  // Read migration files
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;

  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }

    console.log(`Applying migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    try {
      await query('BEGIN');
      await query(sql);
      await query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
      await query('COMMIT');
      console.log(`  Applied: ${file}`);
      count++;
    } catch (err) {
      await query('ROLLBACK');
      console.error(`  FAILED: ${file}`);
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
  }

  if (count === 0) {
    console.log('No new migrations to apply.');
  } else {
    console.log(`Applied ${count} migration(s).`);
  }
}

// Run if called directly: node migrate.js
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
