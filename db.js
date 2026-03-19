const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || './data/hands.db';
const db = new Database(path.resolve(dbPath));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS button_assignments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    button_number INTEGER NOT NULL,
    person_name TEXT NOT NULL,
    UNIQUE(meeting_id, button_number)
  );

  CREATE TABLE IF NOT EXISTS hand_raises (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    button_number INTEGER NOT NULL,
    raised_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_raised INTEGER NOT NULL DEFAULT 1
  );
`);

module.exports = db;
