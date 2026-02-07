import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db, scheduleSave } from '../db/index.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('Manage your notification preferences')
  .setContexts(0)
  .addStringOption((o) =>
    o.setName('dm_notifications')
      .setDescription('Receive DM notifications (cooldowns, waitlist)')
      .addChoices(
        { name: 'On', value: 'on' },
        { name: 'Off', value: 'off' }
      )
      .setRequired(false)
  );

/**
 * Ensure user row exists, return current settings.
 */
function getUserSettings(userId) {
  db.prepare('INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(userId);
  return db.prepare('SELECT dm_notifications FROM users WHERE id = ?').get(userId);
}

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const dmOption = interaction.options.getString('dm_notifications');

  // If no options given, show current settings
  if (!dmOption) {
    const settings = getUserSettings(userId);
    const dmStatus = (settings?.dm_notifications ?? 1) ? '✅ On' : '❌ Off';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('⚙️ Your Settings')
      .addFields(
        { name: '📬 DM Notifications', value: dmStatus, inline: true },
      )
      .setFooter({ text: 'Use /settings dm_notifications:On/Off to change' })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // Update settings
  const dmValue = dmOption === 'on' ? 1 : 0;
  db.prepare('INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(userId);
  db.prepare('UPDATE users SET dm_notifications = ?, updated_at = datetime(\'now\') WHERE id = ?').run(dmValue, userId);
  scheduleSave();

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Settings updated')
    .addFields(
      { name: '📬 DM Notifications', value: dmValue ? '✅ On' : '❌ Off', inline: true },
    )
    .setTimestamp();
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
