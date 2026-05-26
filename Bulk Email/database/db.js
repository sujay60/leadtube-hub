const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'mailblast.db');
let dbWrapper = null;

class DbWrapper {
  constructor(sqlDb) {
    this.db = sqlDb;
    this._inTransaction = false;
  }
  prepare(sql) {
    const db = this.db;
    const self = this;
    return {
      run(...params) {
        db.run(sql, params);
        const rid = db.exec("SELECT last_insert_rowid()");
        const result = {
          lastInsertRowid: rid.length ? rid[0].values[0][0] : 0,
          changes: db.getRowsModified()
        };
        if (!self._inTransaction) self._save();
        return result;
      },
      get(...params) {
        let result = null;
        try {
          const stmt = db.prepare(sql);
          if (params.length) stmt.bind(params);
          if (stmt.step()) result = stmt.getAsObject();
          stmt.free();
        } catch (e) { console.error('DB get error:', e.message, sql); }
        return result;
      },
      all(...params) {
        const results = [];
        try {
          const stmt = db.prepare(sql);
          if (params.length) stmt.bind(params);
          while (stmt.step()) results.push(stmt.getAsObject());
          stmt.free();
        } catch (e) { console.error('DB all error:', e.message, sql); }
        return results;
      }
    };
  }
  exec(sql) {
    this.db.exec(sql);
    if (!this._inTransaction) this._save();
  }
  pragma(str) {
    try { this.db.exec(`PRAGMA ${str}`); } catch(e) {}
  }
  transaction(fn) {
    const self = this;
    return (...args) => {
      self._inTransaction = true;
      self.db.exec("BEGIN TRANSACTION");
      try {
        fn(...args);
        self.db.exec("COMMIT");
        self._inTransaction = false;
        self._save();
      } catch (e) {
        self._inTransaction = false;
        try { self.db.exec("ROLLBACK"); } catch(re) {}
        throw e;
      }
    };
  }
  _save() {
    try {
      const data = this.db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {}
  }
}

async function initDatabase() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();
  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }
  dbWrapper = new DbWrapper(sqlDb);
  const db = dbWrapper;

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT,
      picture_url TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expiry INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT,
      variables TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS custom_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_name TEXT NOT NULL UNIQUE,
      field_label TEXT NOT NULL,
      field_type TEXT DEFAULT 'text',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      channel_name TEXT,
      channel_url TEXT,
      subscriber_count TEXT,
      niche TEXT,
      country TEXT,
      language TEXT DEFAULT 'English',
      custom_fields TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      status TEXT DEFAULT 'draft',
      total_emails INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      opened_count INTEGER DEFAULT 0,
      clicked_count INTEGER DEFAULT 0,
      scheduled_at DATETIME,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (template_id) REFERENCES templates(id),
      FOREIGN KEY (group_id) REFERENCES contact_groups(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS campaign_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      tracking_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      opened_at DATETIME,
      clicked_at DATETIME,
      sent_at DATETIME,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
    CREATE TABLE IF NOT EXISTS tracking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      url TEXT,
      user_agent TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      contact_id INTEGER,
      campaign_id INTEGER,
      message_id TEXT UNIQUE,
      thread_id TEXT,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      received_at DATETIME,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS hub_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS hub_extractor_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      filename TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      queue_data TEXT,
      current_index INTEGER,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE,
      UNIQUE(user_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS hub_extractor_cache (
      user_id INTEGER PRIMARY KEY,
      cache_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hub_extractor_settings (
      user_id INTEGER PRIMARY KEY,
      settings_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hub_screenshot_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      date_val DATETIME DEFAULT CURRENT_TIMESTAMP,
      lead_count INTEGER,
      engine TEXT,
      leads_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE,
      UNIQUE(user_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS hub_api_keys (
      user_id INTEGER PRIMARY KEY,
      keys_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hub_cf_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT,
      status TEXT,
      date_val TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE,
      UNIQUE(user_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS hub_cf_search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      query TEXT,
      country TEXT,
      token TEXT,
      found_count INTEGER,
      results_data TEXT,
      timestamp TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE,
      UNIQUE(user_id, campaign_id)
    );
    CREATE TABLE IF NOT EXISTS hub_cf_global_seen (
      user_id INTEGER PRIMARY KEY,
      seen_ids TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hub_cf_yt_keys (
      user_id INTEGER PRIMARY KEY,
      keys_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hub_sessions (
      sid TEXT PRIMARY KEY,
      expired DATETIME NOT NULL,
      sess TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_creator_research_active (
      user_id INTEGER PRIMARY KEY,
      session_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hub_extractor_active (
      user_id INTEGER PRIMARY KEY,
      session_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hub_screenshot_active (
      user_id INTEGER PRIMARY KEY,
      leads_data TEXT,
      FOREIGN KEY (user_id) REFERENCES hub_users(id) ON DELETE CASCADE
    );
  `);

  // Migrations — add new columns if they don't exist
  const migrations = [
    "ALTER TABLE campaigns ADD COLUMN delay_ms INTEGER DEFAULT 2000",
    "ALTER TABLE campaigns ADD COLUMN is_paused INTEGER DEFAULT 0",
    "ALTER TABLE campaigns ADD COLUMN follow_up_of INTEGER",
    "ALTER TABLE campaigns ADD COLUMN follow_up_days INTEGER DEFAULT 1",
    "ALTER TABLE campaigns ADD COLUMN follow_up_condition TEXT DEFAULT 'not_opened'",
    "ALTER TABLE campaigns ADD COLUMN account_ids TEXT DEFAULT '[]'",
    "ALTER TABLE campaigns ADD COLUMN scheduled_send_at DATETIME",
    "ALTER TABLE campaign_emails ADD COLUMN message_id TEXT",
    "ALTER TABLE campaign_emails ADD COLUMN replied_at DATETIME",
    "ALTER TABLE campaign_emails ADD COLUMN is_paused INTEGER DEFAULT 0",
    "ALTER TABLE campaign_emails ADD COLUMN account_id INTEGER",
    "ALTER TABLE accounts ADD COLUMN user_id INTEGER",
    "ALTER TABLE templates ADD COLUMN user_id INTEGER",
    "ALTER TABLE contact_groups ADD COLUMN user_id INTEGER",
    "ALTER TABLE contacts ADD COLUMN user_id INTEGER",
    "ALTER TABLE campaigns ADD COLUMN user_id INTEGER",
    "ALTER TABLE replies ADD COLUMN user_id INTEGER"
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch(e) { /* column or table update already applied */ }
  }

  // Insert default custom fields
  try {
    const existing = db.prepare('SELECT COUNT(*) as cnt FROM custom_fields').get();
    if (!existing || existing.cnt === 0) {
      db.exec(`
        INSERT OR IGNORE INTO custom_fields (field_name, field_label, field_type) VALUES ('instagram', 'Instagram Handle', 'text');
        INSERT OR IGNORE INTO custom_fields (field_name, field_label, field_type) VALUES ('twitter', 'Twitter/X Handle', 'text');
        INSERT OR IGNORE INTO custom_fields (field_name, field_label, field_type) VALUES ('content_type', 'Content Type', 'text');
        INSERT OR IGNORE INTO custom_fields (field_name, field_label, field_type) VALUES ('avg_views', 'Average Views', 'text');
        INSERT OR IGNORE INTO custom_fields (field_name, field_label, field_type) VALUES ('collab_rate', 'Collaboration Rate', 'text');
      `);
    }
  } catch(e) {}

  console.log('  ✅ Database initialized (sql.js)');
}

function getDb() {
  if (!dbWrapper) throw new Error('Database not initialized. Call initDatabase() first.');
  return dbWrapper;
}

module.exports = { getDb, initDatabase };
