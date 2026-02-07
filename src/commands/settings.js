import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db, scheduleSave } from '../db/index.js';
import { requireGuild } from '../utils/guild.js';

const NOTIFICATION_OPTIONS = [
  { key: 'dm_notifications', col: 'dm_notifications', label: '📬 Cooldown DMs', desc: 'Cooldown expiry reminders' },
  { key: 'notify_status', col: 'notify_status', label: '🔔 Status Updates', desc: 'Request claimed/completed/failed DMs' },
  { key: 'notify_waitlist', col: 'notify_waitlist', label: '📋 Waitlist Alerts', desc: 'Game back-in-stock notifications' },
  { key: 'notify_levelup', col: 'notify_levelup', label: '⬆️ Level-Up DMs', desc: 'Level-up announcements via DM' },
  { key: 'notify_giveaway', col: 'notify_giveaway', label: '🎉 Giveaway Results', desc: 'Giveaway win/end notifications' },
];

function addOnOffOption(builder, key, description) {
  return builder.addStringOption((o) =>
    o.setName(key)
      .setDescription(description)
      .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })
      .setRequired(false)
  );
}

const builder = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('Manage your notification preferences')
  .setContexts(0);

for (const opt of NOTIFICATION_OPTIONS) {
  addOnOffOption(builder, opt.key, opt.desc);
}

export const data = builder;

/**
 * Ensure user row exists, return current settings.
 */
function getUserSettings(userId) {
  db.prepare('INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(userId);
  return db.prepare('SELECT dm_notifications, notify_status, notify_waitlist, notify_levelup, notify_giveaway FROM users WHERE id = ?').get(userId);
}

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;

  // Collect any provided options
  const updates = [];
  for (const opt of NOTIFICATION_OPTIONS) {
    const val = interaction.options.getString(opt.key);
    if (val) updates.push({ ...opt, value: val === 'on' ? 1 : 0 });
  }

  // If no options given, show current settings
  if (updates.length === 0) {
    const settings = getUserSettings(userId);
    const fields = NOTIFICATION_OPTIONS.map((opt) => ({
      name: opt.label,
      value: (settings?.[opt.col] ?? 1) ? '✅ On' : '❌ Off',
      inline: true,
    }));
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('⚙️ Your Settings')
      .addFields(fields)
      .setFooter({ text: 'Use /settings <option>:On/Off to change individual notifications' })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // Apply updates
  db.prepare('INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(userId);
  for (const u of updates) {
    db.prepare(`UPDATE users SET ${u.col} = ?, updated_at = datetime('now') WHERE id = ?`).run(u.value, userId);
  }
  scheduleSave();

  const settings = getUserSettings(userId);
  const fields = NOTIFICATION_OPTIONS.map((opt) => ({
    name: opt.label,
    value: (settings?.[opt.col] ?? 1) ? '✅ On' : '❌ Off',
    inline: true,
  }));

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Settings Updated')
    .addFields(fields)
    .setTimestamp();
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
