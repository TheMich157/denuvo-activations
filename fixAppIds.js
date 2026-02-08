import fs from 'fs';
import fetch from 'node-fetch';

const FILE = './list.json';
const SEARCH_API = 'https://store.steampowered.com/api/storesearch/?cc=us&l=en&term=';

async function findAppId(name) {
  const url = SEARCH_API + encodeURIComponent(name);

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!data.items || data.items.length === 0) {
      console.warn(`❌ No Steam result for: ${name}`);
      return null;
    }

    // Prefer exact (case-insensitive) name match if possible
    const exact = data.items.find(
      i => i.name.toLowerCase() === name.toLowerCase()
    );

    return (exact || data.items[0]).id;
  } catch (err) {
    console.error(`⚠️ Failed for ${name}:`, err.message);
    return null;
  }
}

async function run() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const json = JSON.parse(raw);

  for (const game of json.games) {
    console.log(`🔍 ${game.name}`);

    const newId = await findAppId(game.name);

    if (newId && newId !== game.appId) {
      console.log(`✅ ${game.name}: ${game.appId} → ${newId}`);
      game.appId = newId;
    } else {
      console.log(`⏭️ ${game.name}: unchanged`);
    }
  }

  fs.writeFileSync(FILE, JSON.stringify(json, null, 2));
  console.log('\n🎉 AppIDs updated (structure preserved)');
}

run();
