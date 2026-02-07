import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db, scheduleSave } from '../db/index.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { isGameInStock } from '../services/stock.js';

export const data = new SlashCommandBuilder()
  .setName('mywaitlist')
  .setDescription('View or manage your game waitlists')
  .addSubcommand((sub) =>
    sub.setName('view').setDescription('See all games you are waiting for')
  )
  .addSubcommand((sub) =>
    sub
      .setName('leave')
      .setDescription('Leave a game waitlist')
      .addIntegerOption((opt) =>
        opt.setName('appid').setDescription('The game App ID to leave').setRequired(true)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === 'view') {
    const rows = db.prepare(
      'SELECT game_app_id, created_at FROM game_waitlist WHERE user_id = ? ORDER BY created_at ASC'
    ).all(userId);

    if (rows.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('📋 My Waitlists')
        .setDescription('You are not on any waitlists. When a game is out of stock, you\'ll be auto-added.')
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const lines = rows.map((r) => {
      const game = getGameByAppId(r.game_app_id);
      const name = game ? getGameDisplayName(game) : `App ${r.game_app_id}`;
      const inStock = isGameInStock(r.game_app_id);
      const status = inStock ? '🟢 In stock now!' : '🔴 Out of stock';
      const joined = r.created_at ? ` — joined <t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>` : '';
      return `**${name}** (${r.game_app_id}) — ${status}${joined}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 My Waitlists')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${rows.length} game${rows.length !== 1 ? 's' : ''} • Use /mywaitlist leave to remove` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'leave') {
    const appId = interaction.options.getInteger('appid');
    const existing = db.prepare(
      'SELECT 1 FROM game_waitlist WHERE user_id = ? AND game_app_id = ?'
    ).get(userId, appId);

    if (!existing) {
      return interaction.reply({ content: 'You are not on the waitlist for that game.', ephemeral: true });
    }

    db.prepare('DELETE FROM game_waitlist WHERE user_id = ? AND game_app_id = ?').run(userId, appId);
    scheduleSave();

    const game = getGameByAppId(appId);
    const name = game ? getGameDisplayName(game) : `App ${appId}`;
    return interaction.reply({ content: `✅ Removed from the waitlist for **${name}**.`, ephemeral: true });
  }
}
