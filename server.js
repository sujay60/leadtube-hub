/**
 * LeadTube Hub — Unified Production Server
 * 
 * Serves the Hub dashboard (static) + Channel Finder, Email Extractor,
 * Screenshot Extractor as static apps, and MailBlast (Bulk Email) as
 * a full Node.js backend — all from a single Express server.
 */

const path = require('path');

// Load environment variables (check root first, then Bulk Email dir)
require('dotenv').config();
if (!process.env.SESSION_SECRET) {
  require('dotenv').config({ path: path.join(__dirname, 'Bulk Email', '.env') });
}

const express = require('express');
const session = require('express-session');

// ── Import MailBlast (Bulk Email) modules ──
const { initDatabase } = require('./Bulk Email/database/db');
const authRoutes = require('./Bulk Email/routes/auth');
const templateRoutes = require('./Bulk Email/routes/templates');
const contactRoutes = require('./Bulk Email/routes/contacts');
const campaignRoutes = require('./Bulk Email/routes/campaigns');
const trackingRoutes = require('./Bulk Email/routes/tracking');
const inboxRoutes = require('./Bulk Email/routes/inbox');

// ── Import Hub Auth ──
const hubAuthRoutes = require('./hub-auth');

const app = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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

// ── Security: Block access to server-side source files ──
app.use((req, res, next) => {
  const blocked = [
    '/server.js', '/hub-server.js', '/hub-auth.js', '/package.json', '/package-lock.json',
    '/Dockerfile', '/fly.toml', '/.env', '/.dockerignore', '/.gitignore',
    '/Bulk Email/server.js', '/Bulk Email/routes/', '/Bulk Email/services/',
    '/Bulk Email/database/', '/Bulk Email/node_modules/', '/Bulk Email/.env',
    '/Bulk Email/package', '/Bulk Email/Dockerfile', '/Bulk Email/fly.toml',
    '/Bulk Email/uploads/', '/Bulk Email/mailblast.db',
    '/node_modules/'
  ];
  const decodedPath = decodeURIComponent(req.path);
  if (blocked.some(p => decodedPath === p || decodedPath.startsWith(p))) {
    return res.status(404).send('Not found');
  }
  next();
});

// ── Hub Auth Routes (must be BEFORE the auth guard) ──
app.use('/hub', hubAuthRoutes);

// ── MailBlast API Routes ──
app.use('/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/t', trackingRoutes);

// ── MailBlast API error handlers ──
app.use('/api', (err, req, res, next) => {
  console.error('API Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});
app.use('/auth', (err, req, res, next) => {
  console.error('Auth Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Auth Guard: Protect all pages behind login ──
app.use((req, res, next) => {
  // Allow login page, hub auth API, tracking pixels, and Google OAuth callbacks
  const publicPaths = ['/login.html', '/hub/', '/t/', '/auth/google', '/auth/google/callback'];
  const decodedPath = decodeURIComponent(req.path);
  if (publicPaths.some(p => decodedPath === p || decodedPath.startsWith(p))) {
    return next();
  }

  // If user is not logged in, redirect to login
  if (!req.session || !req.session.userId) {
    // For API requests, return 401 JSON
    if (decodedPath.startsWith('/api/') || decodedPath.startsWith('/auth/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login.html');
  }

  next();
});

// ── MailBlast Static Files (CSS & JS for the Bulk Email frontend) ──
app.use('/css', express.static(path.join(__dirname, 'Bulk Email', 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'Bulk Email', 'public', 'js')));

// ── MailBlast Frontend (loaded inside Hub iframe) ──
app.get('/mailblast', (req, res) => {
  res.sendFile(path.join(__dirname, 'Bulk Email', 'public', 'index.html'));
});

// ── Hub Static Files (custom handler for URL-encoded paths with spaces) ──
const fs = require('fs');
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webp': 'image/webp'
};

app.use((req, res, next) => {
  // Only handle GET requests for static files
  if (req.method !== 'GET') return next();

  const urlWithoutQuery = req.path.split('?')[0];
  const decodedUrl = decodeURIComponent(urlWithoutQuery);
  const filePath = path.join(__dirname, decodedUrl === '/' ? 'index.html' : decodedUrl);

  // Safety: ensure the resolved path is within __dirname
  if (!filePath.startsWith(__dirname)) return next();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return next();
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.sendFile(filePath);
  });
});

// ── Start Server ──
async function start() {
  await initDatabase();

  // Start MailBlast background services
  const { startScheduler, checkOverdueFollowUps } = require('./Bulk Email/services/emailService');
  const { startInboxScanner } = require('./Bulk Email/services/inboxService');
  startScheduler();
  startInboxScanner();
  await checkOverdueFollowUps();

  app.listen(PORT, () => {
    console.log(`\n  🌟 LeadTube Hub running at http://localhost:${PORT}`);
    console.log(`  📧 MailBlast backend active at /mailblast`);
    console.log(`  🚀 Everything is unified and ready!\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
