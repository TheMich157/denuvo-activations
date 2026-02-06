import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getActivatorGames, getDailyCount } from '../services/activators.js';
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
  const lines = games.map((g) => {
    const steamId = g.steam_username || `manual_${interaction.user.id}_${g.game_app_id}`;
    const today = getDailyCount(steamId);
    const remaining = Math.max(0, limit - today);
    return `• **${g.game_name}** — ${g.method} (${remaining}/${limit} left today)`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x1b2838)
    .setTitle('📦 Your Stock')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${limit} activations per account per day • Use /remove to unregister` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
