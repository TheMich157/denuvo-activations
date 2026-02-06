import initSqlJs from 'sql.js';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { debug } from '../utils/debug.js';

const log = debug('db');
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '../../data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'bot.db');

let sqlDb = null;

function wrapPrepare(sql) {
  return {
    run(...params) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();
    },
    get(...params) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row;
    },
    all(...params) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  };
}

const db = {
  prepare(sql) {
    return wrapPrepare(sql);
  },
  exec(sql) {
    sqlDb.exec(sql);
  },
  transaction(fn) {
    sqlDb.run('BEGIN TRANSACTION');
    try {
      const result = fn();
      sqlDb.run('COMMIT');
      return result;
    } catch (e) {
      sqlDb.run('ROLLBACK');
      throw e;
    }
  },
};

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0,
    strikes INTEGER DEFAULT 0,
    notify_dm INTEGER DEFAULT 1,
    notify_ping INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS activator_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activator_id TEXT NOT NULL,
    game_app_id INTEGER NOT NULL,
    game_name TEXT NOT NULL,
    method TEXT NOT NULL CHECK(method IN ('manual', 'automated')),
    credentials_encrypted TEXT,
    steam_username TEXT,
    stock_quantity INTEGER DEFAULT 5,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(activator_id, game_app_id)
  );
  CREATE TABLE IF NOT EXISTS daily_activations (
    steam_account_id TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (steam_account_id, date)
  );
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL,
    game_app_id INTEGER NOT NULL,
    game_name TEXT NOT NULL,
    issuer_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    auth_code TEXT,
    ticket_channel_id TEXT,
    points_charged INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    reference_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activator_games_activator ON activator_games(activator_id);
  CREATE INDEX IF NOT EXISTS idx_activator_games_game ON activator_games(game_app_id);
  CREATE INDEX IF NOT EXISTS idx_requests_buyer ON requests(buyer_id);
  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_requests_game ON requests(game_app_id);
  CREATE TABLE IF NOT EXISTS panel (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;

export async function initDb() {
  const SQL = await initSqlJs();
  if (existsSync(dbPath)) {
    const buf = readFileSync(dbPath);
    sqlDb = new SQL.Database(buf);
  } else {
    sqlDb = new SQL.Database();
  }
  sqlDb.exec(schema);
  try {
    sqlDb.exec('ALTER TABLE activator_games ADD COLUMN stock_quantity INTEGER DEFAULT 5');
  } catch { /* column may already exist */ }
  try {
    sqlDb.exec('ALTER TABLE requests ADD COLUMN screenshot_verified INTEGER DEFAULT 0');
  } catch { /* column may already exist */ }
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS activation_cooldowns (
        buyer_id TEXT NOT NULL,
        game_app_id INTEGER NOT NULL,
        cooldown_until TEXT NOT NULL,
        PRIMARY KEY (buyer_id, game_app_id)
      )
    `);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_cooldowns_buyer ON activation_cooldowns(buyer_id)');
  } catch { /* table may already exist */ }
  return db;
}

let saveTimeout = null;
const SAVE_DEBOUNCE_MS = 1000;

function saveDb() {
  if (!sqlDb) return;
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const data = sqlDb.export();
    writeFileSync(dbPath, Buffer.from(data), { flag: 'w' });
    log('saved', dbPath);
  } catch (err) {
    console.error('[DB] Save failed:', err.message);
  }
}

export function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveDb();
  }, SAVE_DEBOUNCE_MS);
  log('scheduleSave queued');
}

export function flushSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  saveDb();
}

setInterval(saveDb, 30000);
process.on('beforeExit', saveDb);
process.on('exit', () => { saveDb(); });
const onExit = () => {
  flushSave();
  process.exit(0);
};
process.on('SIGINT', onExit);
process.on('SIGTERM', onExit);

export { db };
