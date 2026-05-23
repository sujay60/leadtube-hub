/**
 * Hub Authentication Routes
 * Handles signup, login, logout, and session checks for LeadTube Hub.
 * Also handles Google OAuth login and DB-backed storage for Email Extractor app data.
 */

const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { getDb } = require('./Bulk Email/database/db');

const router = express.Router();

// ── Helpers ──

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (stored === 'google_oauth') return false; // Google accounts can't log in with password this way
  const [salt, hash] = stored.split(':');
  const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === testHash;
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || 'https://leadtube.onrender.com'}/auth/google/callback`
  );
}

// Check if OAuth2 is configured
function isOAuthConfigured() {
  return process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_CLIENT_ID.length > 5 && process.env.GOOGLE_CLIENT_SECRET.length > 5;
}

// ── GET /hub/auth/google (Initiates Google Sign-In for Hub) ──
router.get('/auth/google', (req, res) => {
  if (!isOAuthConfigured()) {
    return res.redirect('/login.html?error=google_not_configured');
  }
  const oauth2Client = getOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'select_account consent',
    state: 'hub_login'
  });
  res.redirect(authUrl);
});

// ── POST /hub/signup ──
router.post('/signup', (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const db = getDb();

  // Check for duplicates
  const existingUser = db.prepare('SELECT id FROM hub_users WHERE username = ? OR email = ?').get(username.toLowerCase(), email.toLowerCase());
  if (existingUser) {
    return res.status(409).json({ error: 'Username or email already exists' });
  }

  const passwordHash = hashPassword(password);

  const result = db.prepare(
    'INSERT INTO hub_users (username, email, password_hash) VALUES (?, ?, ?)'
  ).run(username.toLowerCase(), email.toLowerCase(), passwordHash);

  req.session.userId = result.lastInsertRowid;
  req.session.username = username.toLowerCase();

  res.json({ success: true, username: username.toLowerCase() });
});

// ── POST /hub/login ──
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM hub_users WHERE username = ? OR email = ?').get(username.toLowerCase(), username.toLowerCase());

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (user.password_hash === 'google_oauth') {
    return res.status(401).json({ error: 'This account uses Google Sign-In. Please sign in with Google.' });
  }

  if (!verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;

  res.json({ success: true, username: user.username });
});

// ── POST /hub/logout ──
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

// ── GET /hub/me ──
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, username, email, created_at FROM hub_users WHERE id = ?').get(req.session.userId);

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({
    username: user.username,
    email: user.email,
    memberSince: user.created_at,
    google_configured: isOAuthConfigured()
  });
});

// ── Extractor History DB API Endpoints ──

router.get('/extractor/history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const history = db.prepare('SELECT id, session_id, filename, timestamp, queue_data, current_index FROM hub_extractor_history WHERE user_id = ? ORDER BY timestamp DESC').all(req.session.userId);
  
  // Format to match browser localStorage structure
  const formatted = history.map(item => ({
    id: item.session_id,
    filename: item.filename,
    timestamp: item.timestamp,
    queue: JSON.parse(item.queue_data || '[]'),
    currentIndex: item.current_index
  }));
  res.json(formatted);
});

router.post('/extractor/history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { id, filename, timestamp, queue, currentIndex } = req.body;
  if (!id) return res.status(400).json({ error: 'Session ID is required' });

  const db = getDb();
  
  // Check if session already exists
  const existing = db.prepare('SELECT id FROM hub_extractor_history WHERE user_id = ? AND session_id = ?').get(req.session.userId, id);
  const queueData = JSON.stringify(queue || []);

  if (existing) {
    db.prepare('UPDATE hub_extractor_history SET filename = ?, queue_data = ?, current_index = ? WHERE user_id = ? AND session_id = ?')
      .run(filename, queueData, currentIndex, req.session.userId, id);
  } else {
    const timeVal = timestamp || new Date().toISOString();
    db.prepare('INSERT INTO hub_extractor_history (user_id, session_id, filename, timestamp, queue_data, current_index) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, id, filename, timeVal, queueData, currentIndex);
  }
  res.json({ success: true });
});

router.delete('/extractor/history/:sessionId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_extractor_history WHERE user_id = ? AND session_id = ?').run(req.session.userId, req.params.sessionId);
  res.json({ success: true });
});

// Cache DB API Endpoints
router.get('/extractor/cache', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const cached = db.prepare('SELECT cache_data FROM hub_extractor_cache WHERE user_id = ?').get(req.session.userId);
  res.json(JSON.parse((cached && cached.cache_data) || '{}'));
});

router.post('/extractor/cache', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const cacheData = JSON.stringify(req.body || {});
  
  const existing = db.prepare('SELECT user_id FROM hub_extractor_cache WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_extractor_cache SET cache_data = ? WHERE user_id = ?').run(cacheData, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_extractor_cache (user_id, cache_data) VALUES (?, ?)').run(req.session.userId, cacheData);
  }
  res.json({ success: true });
});

// Settings DB API Endpoints
router.get('/extractor/settings', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const settings = db.prepare('SELECT settings_data FROM hub_extractor_settings WHERE user_id = ?').get(req.session.userId);
  res.json(JSON.parse((settings && settings.settings_data) || 'null'));
});

router.post('/extractor/settings', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const settingsData = JSON.stringify(req.body || {});
  
  const existing = db.prepare('SELECT user_id FROM hub_extractor_settings WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_extractor_settings SET settings_data = ? WHERE user_id = ?').run(settingsData, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_extractor_settings (user_id, settings_data) VALUES (?, ?)').run(req.session.userId, settingsData);
  }
  res.json({ success: true });
});

// ── Screenshot Extractor History DB API Endpoints ──

router.get('/screenshot/history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const history = db.prepare('SELECT session_id, date_val, lead_count, engine, leads_data FROM hub_screenshot_history WHERE user_id = ? ORDER BY date_val DESC').all(req.session.userId);
  
  const formatted = history.map(item => ({
    id: item.session_id,
    date: item.date_val,
    leadCount: item.lead_count,
    engine: item.engine,
    leads: JSON.parse(item.leads_data || '[]')
  }));
  res.json(formatted);
});

router.post('/screenshot/history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { id, date, leadCount, engine, leads } = req.body;
  if (!id) return res.status(400).json({ error: 'Session ID is required' });

  const db = getDb();
  const leadsData = JSON.stringify(leads || []);

  const existing = db.prepare('SELECT id FROM hub_screenshot_history WHERE user_id = ? AND session_id = ?').get(req.session.userId, id);
  if (existing) {
    db.prepare('UPDATE hub_screenshot_history SET lead_count = ?, engine = ?, leads_data = ? WHERE user_id = ? AND session_id = ?')
      .run(leadCount, engine, leadsData, req.session.userId, id);
  } else {
    const timeVal = date || new Date().toISOString();
    db.prepare('INSERT INTO hub_screenshot_history (user_id, session_id, date_val, lead_count, engine, leads_data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, id, timeVal, leadCount, engine, leadsData);
  }
  res.json({ success: true });
});

router.delete('/screenshot/history/:sessionId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_screenshot_history WHERE user_id = ? AND session_id = ?').run(req.session.userId, req.params.sessionId);
  res.json({ success: true });
});

router.delete('/screenshot/history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_screenshot_history WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

// ── Gemini API Keys DB API Endpoints ──

router.get('/api_keys', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const result = db.prepare('SELECT keys_data FROM hub_api_keys WHERE user_id = ?').get(req.session.userId);
  res.json(JSON.parse((result && result.keys_data) || '[]'));
});

router.post('/api_keys', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const keysData = JSON.stringify(req.body || []);

  const existing = db.prepare('SELECT user_id FROM hub_api_keys WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_api_keys SET keys_data = ? WHERE user_id = ?').run(keysData, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_api_keys (user_id, keys_data) VALUES (?, ?)').run(req.session.userId, keysData);
  }
  res.json({ success: true });
});

// ── Channel Finder Leads Endpoints ──
router.get('/cf/leads', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const leads = db.prepare('SELECT channel_id, name, status, date_val FROM hub_cf_leads WHERE user_id = ?').all(req.session.userId);
  const formatted = leads.map(l => ({
    id: l.channel_id,
    name: l.name,
    status: l.status,
    date: l.date_val
  }));
  res.json(formatted);
});

router.post('/cf/leads', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { id, name, status, date } = req.body;
  if (!id) return res.status(400).json({ error: 'Channel ID is required' });
  
  const db = getDb();
  const existing = db.prepare('SELECT id FROM hub_cf_leads WHERE user_id = ? AND channel_id = ?').get(req.session.userId, id);
  if (existing) {
    db.prepare('UPDATE hub_cf_leads SET name = ?, status = ?, date_val = ? WHERE user_id = ? AND channel_id = ?')
      .run(name, status, date, req.session.userId, id);
  } else {
    db.prepare('INSERT INTO hub_cf_leads (user_id, channel_id, name, status, date_val) VALUES (?, ?, ?, ?, ?)')
      .run(req.session.userId, id, name, status, date);
  }
  res.json({ success: true });
});

router.delete('/cf/leads/:channelId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_cf_leads WHERE user_id = ? AND channel_id = ?').run(req.session.userId, req.params.channelId);
  res.json({ success: true });
});

// ── Channel Finder Search History Endpoints ──
router.get('/cf/search_history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const history = db.prepare('SELECT campaign_id, query, country, token, found_count, results_data, timestamp FROM hub_cf_search_history WHERE user_id = ? ORDER BY id DESC').all(req.session.userId);
  const formatted = history.map(item => ({
    id: item.campaign_id,
    query: item.query,
    country: item.country,
    token: item.token,
    found: item.found_count,
    results: JSON.parse(item.results_data || '[]'),
    timestamp: item.timestamp
  }));
  res.json(formatted);
});

router.post('/cf/search_history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { id, query, country, token, found, results, timestamp } = req.body;
  if (!id) return res.status(400).json({ error: 'Campaign ID is required' });

  const db = getDb();
  const resultsData = JSON.stringify(results || []);

  const existing = db.prepare('SELECT id FROM hub_cf_search_history WHERE user_id = ? AND campaign_id = ?').get(req.session.userId, id);
  if (existing) {
    db.prepare('UPDATE hub_cf_search_history SET query = ?, country = ?, token = ?, found_count = ?, results_data = ?, timestamp = ? WHERE user_id = ? AND campaign_id = ?')
      .run(query, country, token, found, resultsData, timestamp, req.session.userId, id);
  } else {
    db.prepare('INSERT INTO hub_cf_search_history (user_id, campaign_id, query, country, token, found_count, results_data, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, id, query, country, token, found, resultsData, timestamp);
  }
  res.json({ success: true });
});

router.delete('/cf/search_history/:campaignId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_cf_search_history WHERE user_id = ? AND campaign_id = ?').run(req.session.userId, req.params.campaignId);
  res.json({ success: true });
});

router.delete('/cf/search_history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_cf_search_history WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

// ── Channel Finder Global Seen Endpoints ──
router.get('/cf/global_seen', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const result = db.prepare('SELECT seen_ids FROM hub_cf_global_seen WHERE user_id = ?').get(req.session.userId);
  res.json(JSON.parse((result && result.seen_ids) || '[]'));
});

router.post('/cf/global_seen', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const seenIds = JSON.stringify(req.body || []);

  const existing = db.prepare('SELECT user_id FROM hub_cf_global_seen WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_cf_global_seen SET seen_ids = ? WHERE user_id = ?').run(seenIds, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_cf_global_seen (user_id, seen_ids) VALUES (?, ?)').run(req.session.userId, seenIds);
  }
  res.json({ success: true });
});

router.delete('/cf/global_seen', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_cf_global_seen WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

// ── Channel Finder YouTube API Keys Endpoints ──
router.get('/cf/yt_keys', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const result = db.prepare('SELECT keys_data FROM hub_cf_yt_keys WHERE user_id = ?').get(req.session.userId);
  res.json(JSON.parse((result && result.keys_data) || '[]'));
});

router.post('/cf/yt_keys', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const keysData = JSON.stringify(req.body || []);

  const existing = db.prepare('SELECT user_id FROM hub_cf_yt_keys WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_cf_yt_keys SET keys_data = ? WHERE user_id = ?').run(keysData, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_cf_yt_keys (user_id, keys_data) VALUES (?, ?)').run(req.session.userId, keysData);
  }
  res.json({ success: true });
});

// ── Creator Research Active Session Endpoints ──

router.get('/creator-research/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const result = db.prepare('SELECT session_data FROM hub_creator_research_active WHERE user_id = ?').get(req.session.userId);
  if (!result || !result.session_data) return res.json(null);
  try { res.json(JSON.parse(result.session_data)); } catch(e) { res.json(null); }
});

router.post('/creator-research/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const sessionData = JSON.stringify(req.body || {});
  const existing = db.prepare('SELECT user_id FROM hub_creator_research_active WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_creator_research_active SET session_data = ? WHERE user_id = ?').run(sessionData, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_creator_research_active (user_id, session_data) VALUES (?, ?)').run(req.session.userId, sessionData);
  }
  res.json({ success: true });
});

router.delete('/creator-research/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_creator_research_active WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

// ── Email Extractor Active Session Endpoints ──

router.get('/extractor/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const result = db.prepare('SELECT session_data FROM hub_extractor_active WHERE user_id = ?').get(req.session.userId);
  if (!result || !result.session_data) return res.json(null);
  try { res.json(JSON.parse(result.session_data)); } catch(e) { res.json(null); }
});

router.post('/extractor/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const sessionData = JSON.stringify(req.body || {});
  const existing = db.prepare('SELECT user_id FROM hub_extractor_active WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_extractor_active SET session_data = ? WHERE user_id = ?').run(sessionData, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_extractor_active (user_id, session_data) VALUES (?, ?)').run(req.session.userId, sessionData);
  }
  res.json({ success: true });
});

router.delete('/extractor/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_extractor_active WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

// ── Screenshot Extractor Active Leads Endpoints ──

router.get('/screenshot/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const result = db.prepare('SELECT leads_data FROM hub_screenshot_active WHERE user_id = ?').get(req.session.userId);
  if (!result || !result.leads_data) return res.json(null);
  try { res.json(JSON.parse(result.leads_data)); } catch(e) { res.json(null); }
});

router.post('/screenshot/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const leadsData = JSON.stringify(req.body || []);
  const existing = db.prepare('SELECT user_id FROM hub_screenshot_active WHERE user_id = ?').get(req.session.userId);
  if (existing) {
    db.prepare('UPDATE hub_screenshot_active SET leads_data = ? WHERE user_id = ?').run(leadsData, req.session.userId);
  } else {
    db.prepare('INSERT INTO hub_screenshot_active (user_id, leads_data) VALUES (?, ?)').run(req.session.userId, leadsData);
  }
  res.json({ success: true });
});

router.delete('/screenshot/active', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  db.prepare('DELETE FROM hub_screenshot_active WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

module.exports = router;
