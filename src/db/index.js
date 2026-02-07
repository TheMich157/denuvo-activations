import initSqlJs from 'sql.js';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, accessSync, constants } from 'fs';
import { debug } from '../utils/debug.js';

const log = debug('db');
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../../data');
const isCustomDir = !!process.env.DATA_DIR;
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'bot.db');

// ---- Startup storage diagnostics ----
function logStorageDiagnostics() {
  console.log('[Storage] ─────────────────────────────────');
  console.log(`[Storage] Data dir:    ${dataDir}`);
  console.log(`[Storage] DB path:     ${dbPath}`);
  console.log(`[Storage] Source:      ${isCustomDir ? 'DATA_DIR env (Render Disk / custom)' : 'Default (./data)'}`);

  // Check if directory exists and is writable
  try {
    accessSync(dataDir, constants.W_OK);
    console.log('[Storage] Writable:    ✅ Yes');
  } catch {
    console.error('[Storage] Writable:    ❌ NO — database saves will fail!');
  }

  // Check if DB file already exists (persistence test)
  if (existsSync(dbPath)) {
    try {
      const stat = statSync(dbPath);
      const sizeKb = (stat.size / 1024).toFixed(1);
      const modified = stat.mtime.toISOString();
      console.log(`[Storage] DB exists:   ✅ Yes (${sizeKb} KB, last modified: ${modified})`);
      console.log('[Storage] Persistent:  ✅ Data survived restart');
    } catch {
      console.log('[Storage] DB exists:   ✅ Yes (could not read stats)');
    }
  } else {
    console.log('[Storage] DB exists:   ⚠️  No — creating new database');
    if (isCustomDir) {
      console.warn('[Storage] ⚠️  If you expected data to persist, check your Render Disk mount.');
    }
  }
  console.log('[Storage] ─────────────────────────────────');
}
logStorageDiagnostics();

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
  } catch {}
  try {
    sqlDb.exec('ALTER TABLE requests ADD COLUMN screenshot_verified INTEGER DEFAULT 0');
  } catch {}
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
  } catch {}
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS stock_restock_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activator_id TEXT NOT NULL,
        game_app_id INTEGER NOT NULL,
        restock_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_restock_queue_at ON stock_restock_queue(restock_at)');
  } catch {}
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS game_waitlist (
        user_id TEXT NOT NULL,
        game_app_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, game_app_id)
      )
    `);
  } catch {}
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS blacklist (
        user_id TEXT PRIMARY KEY,
        reason TEXT,
        added_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS activator_status (
        activator_id TEXT PRIMARY KEY,
        away INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Activator ratings
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS activator_ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        activator_id TEXT NOT NULL,
        buyer_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(request_id)
      )
    `);
    sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_ratings_activator ON activator_ratings(activator_id)');
  } catch {}
  // User notification settings
  try {
    sqlDb.exec('ALTER TABLE users ADD COLUMN dm_notifications INTEGER DEFAULT 1');
  } catch {}
  // Streaks
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS activator_streaks (
        activator_id TEXT PRIMARY KEY,
        current_streak INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        last_active_date TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Transcripts
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS transcripts (
        request_id TEXT PRIMARY KEY,
        buyer_id TEXT NOT NULL,
        issuer_id TEXT,
        game_name TEXT,
        transcript TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Preorders
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS preorders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_name TEXT NOT NULL,
        game_app_id INTEGER,
        description TEXT,
        price REAL DEFAULT 5.0,
        max_spots INTEGER DEFAULT 0,
        created_by TEXT NOT NULL,
        thread_id TEXT,
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed', 'fulfilled')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Migration: add max_spots column if missing
  try {
    sqlDb.exec(`ALTER TABLE preorders ADD COLUMN max_spots INTEGER DEFAULT 0`);
  } catch {}
  // Preorder claims (users who paid/donated)
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS preorder_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        preorder_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        verified INTEGER DEFAULT 0,
        proof_message_id TEXT,
        verified_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(preorder_id, user_id)
      )
    `);
  } catch {}
  // User tiers (Ko-fi supporter tiers)
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS user_tiers (
        user_id TEXT PRIMARY KEY,
        tier TEXT NOT NULL DEFAULT 'none' CHECK(tier IN ('none', 'low', 'mid', 'high')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Warnings
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Giveaways
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS giveaways (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_name TEXT NOT NULL,
        game_app_id INTEGER,
        created_by TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        max_winners INTEGER DEFAULT 1,
        message_id TEXT,
        channel_id TEXT,
        winners TEXT,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'ended')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS giveaway_entries (
        giveaway_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY(giveaway_id, user_id)
      )
    `);
  } catch {}
  // Game request voting
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS game_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_name TEXT NOT NULL,
        suggested_by TEXT NOT NULL,
        votes INTEGER DEFAULT 0,
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'added', 'rejected')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS game_vote_users (
        vote_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY(vote_id, user_id)
      )
    `);
  } catch {}
  // Ticket feedback
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS ticket_feedback (
        request_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Activator schedules
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS activator_schedules (
        activator_id TEXT PRIMARY KEY,
        timezone TEXT DEFAULT 'UTC',
        available_start INTEGER DEFAULT 0,
        available_end INTEGER DEFAULT 24,
        days TEXT DEFAULT '0,1,2,3,4,5,6',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Ban appeals
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS ban_appeals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
        reviewed_by TEXT,
        review_note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        reviewed_at TEXT
      )
    `);
  } catch {}
  // User notes (staff)
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS user_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        note TEXT NOT NULL,
        added_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  // Cooldown skip tokens
  try {
    sqlDb.exec(`
      CREATE TABLE IF NOT EXISTS skip_tokens (
        user_id TEXT NOT NULL,
        tokens INTEGER DEFAULT 0,
        PRIMARY KEY(user_id)
      )
    `);

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_levels (
        user_id TEXT PRIMARY KEY,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 0,
        total_messages INTEGER DEFAULT 0,
        last_xp_at TEXT
      )
    `).run();
  } catch {}
  return db;
}

let saveTimeout = null;
let firstSave = true;
const SAVE_DEBOUNCE_MS = 1000;

function saveDb() {
  if (!sqlDb) return;
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const data = sqlDb.export();
    writeFileSync(dbPath, Buffer.from(data), { flag: 'w' });
    log('saved', dbPath);
    if (firstSave) {
      firstSave = false;
      // Verify the file was actually written
      if (existsSync(dbPath)) {
        const stat = statSync(dbPath);
        console.log(`[Storage] First save:  ✅ OK (${(stat.size / 1024).toFixed(1)} KB written to disk)`);
      } else {
        console.error('[Storage] First save:  ❌ File not found after write — disk may not be mounted!');
      }
    }
  } catch (err) {
    console.error('[DB] Save failed:', err.message);
    if (firstSave) {
      firstSave = false;
      console.error('[Storage] First save:  ❌ FAILED — check disk permissions and mount path');
    }
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
