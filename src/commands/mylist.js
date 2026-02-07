import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getActivatorGames, getDailyCount, getPendingRestockCount, getNextRestockAt } from '../services/activators.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('mylist')
  .setDescription('List your registered games (Activator only)')
  .setDMPermission(false);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can use this command.', flags: MessageFlags.Ephemeral });
  }

  const games = getActivatorGames(interaction.user.id);
  if (games.length === 0) {
    return interaction.reply({
      content: 'You have no games registered. Use `/add` to register games.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const limit = config.dailyActivationLimit;
  const restockHours = config.restockHours || 24;
  const lines = games.map((g) => {
    const steamId = g.steam_username || `manual_${interaction.user.id}_${g.game_app_id}`;
    const today = getDailyCount(steamId);
    const remaining = Math.max(0, limit - today);
    const stock = g.stock_quantity ?? 5;
    const pending = getPendingRestockCount(interaction.user.id, g.game_app_id);
    const nextAt = getNextRestockAt(interaction.user.id, g.game_app_id);
    let restockText = '';
    if (pending > 0 && nextAt) {
      const ms = new Date(nextAt).getTime() - Date.now();
      const hrs = Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
      restockText = ` • +${pending} restocking in ~${hrs}h`;
    }
    return `• **${g.game_name}** — stock: ${stock}${restockText ? restockText : ''} • ${remaining}/${limit} today`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x1b2838)
    .setTitle('📦 Your Stock')
    .setDescription(lines.join('\n'))
    .setFooter({
      text: `Stock restocks automatically after ${restockHours}h • ${limit} activations/day • Use /remove to unregister`,
    })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
