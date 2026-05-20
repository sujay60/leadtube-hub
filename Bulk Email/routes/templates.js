const express = require('express');
const { getDb } = require('../database/db');

const router = express.Router();

// List all templates
router.get('/', (req, res) => {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all();
  res.json(templates);
});

// Get single template
router.get('/:id', (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  res.json(template);
});

// Create template
router.post('/', (req, res) => {
  const { name, subject, body_html, body_text } = req.body;
  if (!name || !subject || !body_html) {
    return res.status(400).json({ error: 'Name, subject, and body are required' });
  }

  // Extract variables from template
  const variables = extractVariables(subject + ' ' + body_html);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO templates (name, subject, body_html, body_text, variables)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, subject, body_html, body_text || '', JSON.stringify(variables));

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(template);
});

// Update template
router.put('/:id', (req, res) => {
  const { name, subject, body_html, body_text } = req.body;
  const variables = extractVariables((subject || '') + ' ' + (body_html || ''));

  const db = getDb();
  db.prepare(`
    UPDATE templates SET name = ?, subject = ?, body_html = ?, body_text = ?, 
    variables = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, subject, body_html, body_text || '', JSON.stringify(variables), req.params.id);

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  res.json(template);
});

// Delete template
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Extract {{variable}} patterns from text
function extractVariables(text) {
  const regex = /\{\{(\w+)(?:\|default:"[^"]*")?\}\}/g;
  const vars = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}

module.exports = router;
