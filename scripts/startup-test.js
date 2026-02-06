#!/usr/bin/env node
/**
 * Startup tests – validates config, DB, games before running the bot.
 * Run: node scripts/startup-test.js  OR  npm run test:startup
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const dbPath = join(dataDir, 'bot.db');
const listPath = join(rootDir, 'list.json');

const results = { ok: 0, fail: 0, tests: [] };

function pass(name, detail = '') {
  results.ok++;
  results.tests.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
}

function fail(name, err) {
  results.fail++;
  results.tests.push({ name, ok: false, error: String(err) });
  console.log(`  ✗ ${name}: ${err}`);
}

async function runTests() {
  console.log('\n🔍 Startup tests\n');

  // 1. Config
  console.log('Config');
  try {
    const { config, validateConfig } = await import('../src/config.js');
    validateConfig();
    pass('required env vars present');
    pass('DAILY_ACTIVATION_LIMIT', `${config.dailyActivationLimit}`);
    pass('POINTS_PER_ACTIVATION', `${config.pointsPerActivation}`);
    if (config.encryptionKey && config.encryptionKey.length >= 64) {
      pass('ENCRYPTION_KEY valid');
    } else {
      pass('ENCRYPTION_KEY', 'not set or invalid (manual mode only)');
    }
  } catch (e) {
    fail('config validation', e.message);
  }

  // 2. Games list
  console.log('\nGames');
  try {
    if (!existsSync(listPath)) {
      fail('list.json', 'file not found');
    } else {
      const data = JSON.parse(readFileSync(listPath, 'utf8'));
      const games = data.games || [];
      pass('list.json loads', `${games.length} games`);
      if (games.length > 0) {
        const sample = games[0];
        if (sample.appId && sample.name) {
          pass('game format valid', `e.g. ${sample.name} (${sample.appId})`);
        } else {
          fail('game format', 'games need appId and name');
        }
      }
    }
  } catch (e) {
    fail('games list', e.message);
  }

  // 3. Database
  console.log('\nDatabase');
  try {
    const { initDb, flushSave } = await import('../src/db/index.js');
    const db = await initDb();
    pass('DB init', 'sql.js loaded');

    const users = db.prepare('SELECT COUNT(*) as c FROM users').get();
    const gamesCount = db.prepare('SELECT COUNT(*) as c FROM activator_games').get();
    const requestsCount = db.prepare('SELECT COUNT(*) as c FROM requests').get();
    pass('schema / tables', `users:${users.c} activator_games:${gamesCount.c} requests:${requestsCount.c}`);

    if (existsSync(dbPath)) {
      const stat = await import('fs').then((fs) => fs.statSync(dbPath));
      pass('bot.db exists', `${Math.round(stat.size / 1024)} KB`);
    } else {
      pass('bot.db', 'will be created on first save');
    }

    flushSave?.();
    pass('DB save/flush', 'OK');
  } catch (e) {
    fail('database', e.message);
  }

  // 4. Games service
  console.log('\nServices');
  try {
    const { loadGames, searchGames } = await import('../src/utils/games.js');
    const games = loadGames();
    pass('loadGames()', `${games.length} games`);
    const search = searchGames('test');
    pass('searchGames()', `${search.length} results for "test"`);
  } catch (e) {
    fail('games service', e.message);
  }

  // Summary
  console.log('\n' + '─'.repeat(40));
  const total = results.ok + results.fail;
  if (results.fail > 0) {
    console.log(`❌ ${results.fail}/${total} failed`);
    process.exit(1);
  } else {
    console.log(`✅ ${results.ok}/${total} passed`);
    process.exit(0);
  }
}

runTests().catch((e) => {
  console.error('Startup test error:', e);
  process.exit(1);
});
