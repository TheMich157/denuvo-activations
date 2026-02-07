import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { addActivatorStock } from '../services/activators.js';
import { loadGames, getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { logRestock } from '../services/activationLog.js';
import { syncPanelMessage } from '../services/panel.js';
import { buildPanelMessagePayload } from './ticketpanel.js';
import { notifyWaitlistAndClear } from '../services/waitlist.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('bulkstock')
  .setDescription('Add stock for multiple games at once')
  .setContexts(0)
  .addStringOption((o) =>
    o.setName('games')
      .setDescription('Comma-separated list of AppIDs (e.g. "123456, 789012, 345678")')
      .setRequired(true)
  )
  .addIntegerOption((o) =>
    o.setName('quantity')
      .setDescription('Stock quantity per game (default: 5)')
      .setMinValue(1)
      .setMaxValue(999)
      .setRequired(false)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const gamesInput = interaction.options.getString('games', true);
  const quantity = interaction.options.getInteger('quantity') ?? 5;

  // Parse app IDs
  const appIds = gamesInput
    .split(/[,;\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  if (appIds.length === 0) {
    return interaction.reply({
      content: 'No valid App IDs found. Provide comma-separated numbers (e.g. `123456, 789012`).',
      flags: MessageFlags.Ephemeral,
    });
  }

  const activatorId = interaction.user.id;
  const allGames = loadGames();
  const results = [];
  const notFound = [];

  for (const appId of appIds) {
    const game = getGameByAppId(appId);
    if (!game) {
      notFound.push(appId);
      continue;
    }
    try {
      addActivatorStock(activatorId, appId, game.name, quantity);
      results.push({ appId, name: getGameDisplayName(game), quantity });
      logRestock({
        activatorId,
        gameAppId: appId,
        gameName: game.name,
        quantity,
        method: 'manual',
      }).catch(() => {});
      notifyWaitlistAndClear(interaction.client, appId, game.name).catch(() => {});
    } catch (err) {
      notFound.push(appId);
    }
  }

  syncPanelMessage(interaction.client, buildPanelMessagePayload()).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(results.length > 0 ? 0x57f287 : 0xe74c3c)
    .setTitle('📦 Bulk Stock Update')
    .setTimestamp();

  if (results.length > 0) {
    const lines = results.map((r) => `✅ **${r.name}** — +${r.quantity}`);
    embed.setDescription(`Added stock for **${results.length}** game${results.length !== 1 ? 's' : ''}:`);
    embed.addFields({ name: 'Updated', value: lines.join('\n'), inline: false });
  }
  if (notFound.length > 0) {
    embed.addFields({
      name: '⚠️ Not found',
      value: notFound.map((id) => `\`${id}\``).join(', '),
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
