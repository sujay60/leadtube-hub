const express = require('express');
const multer = require('multer');
const path = require('path');
const { getDb } = require('../database/db');
const { parseCSV } = require('../services/csvParser');

const router = express.Router();

// Configure multer for CSV uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    require('fs').mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `csv_${Date.now()}_${file.originalname}`);
  }
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV files are allowed'));
  }
}});

// ===== CONTACT GROUPS =====

// List all groups
router.get('/groups', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const groups = db.prepare(`
    SELECT cg.*, COUNT(c.id) as contact_count 
    FROM contact_groups cg 
    LEFT JOIN contacts c ON c.group_id = cg.id 
    WHERE cg.user_id = ?
    GROUP BY cg.id 
    ORDER BY cg.created_at DESC
  `).all(userId);
  res.json(groups);
});

// Create group
router.post('/groups', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const result = db.prepare('INSERT INTO contact_groups (name, description, user_id) VALUES (?, ?, ?)').run(name, description || '', userId);
  const group = db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(group);
});

// Delete group
router.delete('/groups/:id', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  db.prepare('UPDATE contacts SET group_id = NULL WHERE group_id = ? AND user_id = ?').run(req.params.id, userId);
  db.prepare('DELETE FROM contact_groups WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  res.json({ success: true });
});

// ===== CUSTOM FIELDS (must be before /:id route) =====

router.get('/fields', (req, res) => {
  const db = getDb();
  const fields = db.prepare('SELECT * FROM custom_fields ORDER BY created_at').all();
  res.json(fields);
});

router.post('/fields', (req, res) => {
  const { field_name, field_label, field_type } = req.body;
  if (!field_name || !field_label) return res.status(400).json({ error: 'Field name and label are required' });

  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO custom_fields (field_name, field_label, field_type) VALUES (?, ?, ?)').run(
      field_name.replace(/\s+/g, '_').toLowerCase(),
      field_label,
      field_type || 'text'
    );
    const field = db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(field);
  } catch (e) {
    res.status(400).json({ error: 'Field name already exists' });
  }
});

router.delete('/fields/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM custom_fields WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== CONTACTS =====

// List contacts (optionally by group)
router.get('/', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const { group_id, search } = req.query;
  
  let query = 'SELECT c.*, cg.name as group_name FROM contacts c LEFT JOIN contact_groups cg ON c.group_id = cg.id WHERE c.user_id = ?';
  const params = [userId];

  if (group_id) {
    query += ' AND c.group_id = ?';
    params.push(group_id);
  }

  if (search) {
    query += ' AND (c.email LIKE ? OR c.first_name LIKE ? OR c.channel_name LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  query += ' ORDER BY c.created_at DESC';
  const contacts = db.prepare(query).all(...params);
  res.json(contacts);
});

// Get single contact
router.get('/:id', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(contact);
});

// Create contact
router.post('/', (req, res) => {
  const { email, first_name, last_name, channel_name, channel_url, subscriber_count, niche, country, language, group_id, custom_fields } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const result = db.prepare(`
    INSERT INTO contacts (email, first_name, last_name, channel_name, channel_url, subscriber_count, niche, country, language, group_id, custom_fields, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(email, first_name || '', last_name || '', channel_name || '', channel_url || '', subscriber_count || '', niche || '', country || '', language || 'English', group_id || null, JSON.stringify(custom_fields || {}), userId);

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(contact);
});

// Update contact
router.put('/:id', (req, res) => {
  const { email, first_name, last_name, channel_name, channel_url, subscriber_count, niche, country, language, group_id, custom_fields } = req.body;

  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  db.prepare(`
    UPDATE contacts SET email = ?, first_name = ?, last_name = ?, channel_name = ?, channel_url = ?,
    subscriber_count = ?, niche = ?, country = ?, language = ?, group_id = ?, custom_fields = ?
    WHERE id = ? AND user_id = ?
  `).run(email, first_name, last_name, channel_name, channel_url, subscriber_count, niche, country, language, group_id || null, JSON.stringify(custom_fields || {}), req.params.id, userId);

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  res.json(contact);
});

// Delete contact
router.delete('/:id', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  res.json({ success: true });
});

// Bulk delete contacts
router.post('/bulk-delete', (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No contact IDs provided' });

  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders}) AND user_id = ?`).run(...ids, userId);
  res.json({ success: true, deleted: ids.length });
});

// ===== CSV IMPORT =====

// Upload and preview CSV
router.post('/import/preview', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

  try {
    const records = await parseCSV(req.file.path);
    const headers = records.length > 0 ? Object.keys(records[0]) : [];
    const preview = records.slice(0, 5);

    res.json({
      file: req.file.filename,
      total_rows: records.length,
      headers,
      preview
    });
  } catch (error) {
    res.status(400).json({ error: 'Failed to parse CSV: ' + error.message });
  }
});

// Import CSV with column mapping
router.post('/import', upload.single('csv'), async (req, res) => {
  if (!req.file && !req.body.file) {
    return res.status(400).json({ error: 'No CSV file' });
  }

  try {
    const filePath = req.file 
      ? req.file.path 
      : path.join(__dirname, '..', 'uploads', req.body.file);
    
    const records = await parseCSV(filePath);
    const mapping = JSON.parse(req.body.mapping || '{}');
    const groupId = req.body.group_id;

    const db = getDb();
    const userId = (req.session && req.session.userId) || null;

    let imported = 0;
    let skipped = 0;

    for (const row of records) {
      const email = row[mapping.email];
      if (!email || !email.includes('@')) { skipped++; continue; }

      // Build custom fields from unmapped columns
      const customFields = {};
      for (const [csvCol, value] of Object.entries(row)) {
        const mappedTo = Object.entries(mapping).find(([k, v]) => v === csvCol);
        if (!mappedTo) {
          customFields[csvCol] = value;
        }
      }

      try {
        const existing = db.prepare('SELECT id FROM contacts WHERE email = ? AND group_id = ? AND user_id = ?').get(email, groupId || null, userId);
        if (existing) { skipped++; continue; }

        db.prepare(`
          INSERT INTO contacts (email, first_name, last_name, channel_name, channel_url, subscriber_count, niche, country, language, group_id, custom_fields, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          email,
          row[mapping.first_name] || '',
          row[mapping.last_name] || '',
          row[mapping.channel_name] || '',
          row[mapping.channel_url] || '',
          row[mapping.subscriber_count] || '',
          row[mapping.niche] || '',
          row[mapping.country] || '',
          row[mapping.language] || 'English',
          groupId || null,
          JSON.stringify(customFields),
          userId
        );
        imported++;
      } catch (e) {
        skipped++;
      }
    }

    res.json({ success: true, imported, skipped });
  } catch (error) {
    res.status(400).json({ error: 'Import failed: ' + error.message });
  }
});

module.exports = router;
