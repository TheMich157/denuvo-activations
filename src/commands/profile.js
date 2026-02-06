import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getBalance } from '../services/points.js';
import { getActivatorGames, getDailyCount } from '../services/activators.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View your profile: credits, games, and activation method')
  .setDMPermission(false);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const points = getBalance(userId);
  const activator = isActivator(interaction.member);
  const games = activator ? getActivatorGames(userId) : [];

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: interaction.user.displayName || interaction.user.username,
      iconURL: interaction.user.displayAvatarURL({ size: 64 }),
    })
    .setTimestamp();

  embed.addFields({
    name: '💰 Credits',
    value: `**${points}** points (${formatPointsAsMoney(points)})`,
    inline: true,
  });

  if (activator && games.length > 0) {
    const limit = config.dailyActivationLimit;
    const lines = games.map((g) => {
      const steamId = g.steam_username || `manual_${userId}_${g.game_app_id}`;
      const today = getDailyCount(steamId);
      const remaining = Math.max(0, limit - today);
      const methodLabel = g.method === 'automated' ? '🤖 automated' : '👤 manual';
      return `• **${g.game_name}** — ${methodLabel} (${remaining}/${limit} today)`;
    });
    embed.addFields({
      name: '🎮 Your Games',
      value: lines.join('\n'),
      inline: false,
    });
  } else if (activator) {
    embed.addFields({
      name: '🎮 Your Games',
      value: 'No games registered. Use `/add` or `/stock` to add games.',
      inline: false,
    });
  }

  embed.setFooter({
    text: activator
      ? 'Activator • Use /add or /stock to add games'
      : 'Use /shop to buy points',
  });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
