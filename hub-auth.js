/**
 * Hub Authentication Routes
 * Handles signup, login, logout, and session checks for LeadTube Hub.
 * Uses Node.js built-in crypto.scryptSync for password hashing (zero dependencies).
 */

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./Bulk Email/database/db');

const router = express.Router();

// ── Helpers ──

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === testHash;
}

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
    memberSince: user.created_at
  });
});

module.exports = router;
