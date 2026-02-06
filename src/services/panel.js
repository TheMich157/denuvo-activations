import { db, scheduleSave } from '../db/index.js';

export function getPanel() {
  return db.prepare('SELECT guild_id, channel_id, message_id FROM panel WHERE id = 1').get();
}

export function setPanel(guildId, channelId, messageId) {
  db.prepare('INSERT OR REPLACE INTO panel (id, guild_id, channel_id, message_id) VALUES (1, ?, ?, ?)')
    .run(guildId, channelId, messageId);
  scheduleSave();
}

export function clearPanel() {
  db.prepare('DELETE FROM panel WHERE id = 1').run();
  scheduleSave();
}
