require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDatabase } = require('./database/db');

const authRoutes = require('./routes/auth');
const templateRoutes = require('./routes/templates');
const contactRoutes = require('./routes/contacts');
const campaignRoutes = require('./routes/campaigns');
const trackingRoutes = require('./routes/tracking');
const inboxRoutes = require('./routes/inbox');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Trust proxy in production (Fly.io terminates TLS)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/t', trackingRoutes);

// Global error handler for API routes — always return JSON, never HTML
app.use('/api', (err, req, res, next) => {
  console.error('API Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});
app.use('/auth', (err, req, res, next) => {
  console.error('Auth Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// SPA fallback — only for non-API GET requests
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/t/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database, start scheduler, and start server
async function start() {
  await initDatabase();

  // ── Recovery: reset any campaigns stuck in 'sending' from a previous crashed/restarted process
  const { getDb } = require('./database/db');
  const db = getDb();
  const stuck = db.prepare("SELECT id, name FROM campaigns WHERE status = 'sending'").all();
  if (stuck.length) {
    console.log(`  ⚠️  Found ${stuck.length} campaign(s) stuck in 'sending' — resetting to 'draft' for re-send`);
    for (const c of stuck) {
      db.prepare("UPDATE campaigns SET status = 'draft', is_paused = 0 WHERE id = ?").run(c.id);
      console.log(`     ↳ Reset: "${c.name}" (id ${c.id})`);
    }
  }

  // Start the follow-up auto-sender scheduler and inbox scanner
  const { startScheduler, checkOverdueFollowUps } = require('./services/emailService');
  const { startInboxScanner } = require('./services/inboxService');
  startScheduler();
  startInboxScanner();
  await checkOverdueFollowUps();

  app.listen(PORT, () => {
    console.log(`\n  🚀 MailBlast Server running at http://localhost:${PORT}\n`);
  });
}
start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
