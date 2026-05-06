const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());

// Trust proxy (Render runs behind a load balancer)
app.set('trust proxy', 1);

// API rate limiting
const { apiLimiter } = require('./middleware/rate-limit');
app.use('/api/', apiLimiter);

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/items', require('./routes/items'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api/bucket', require('./routes/bucket'));
app.use('/api/share', require('./routes/share'));
app.use('/api/patterns', require('./routes/patterns'));
app.use('/api/admin', require('./routes/admin'));
// app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/me', require('./routes/user'));

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback for client-side routing
// API 404s should not fall through to this
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server, run migrations if database is configured
async function start() {
  if (process.env.DATABASE_URL) {
    try {
      const { migrate } = require('./migrate');
      await migrate();
      console.log('Database ready');
    } catch (err) {
      console.error('Database migration failed:', err.message);
      console.error('Server will start but database features will not work');
    }
  } else {
    console.log('No DATABASE_URL set, running without database (static site only)');
  }

  app.listen(PORT, () => {
    console.log(`Headroom running on port ${PORT}`);
  });
}

start();
