import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { searchGames, getGameByAppId } from '../utils/games.js';
import { createTicketForGame } from '../services/ticket.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';
import { requireGuild } from '../utils/guild.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('request')
  .setDescription('Request a game activation')
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName('game')
      .setDescription('Search for the game')
      .setRequired(true)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const games = searchGames(focused);
  await interaction.respond(
    games.map((g) => ({ name: g.name, value: String(g.appId) }))
  );
}

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) {
    return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  }
  if (!config.ticketCategoryId) {
    return interaction.reply({
      content: 'Use the ticket panel to request activations. `/request` requires TICKET_CATEGORY_ID to be set.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!checkRateLimit(interaction.user.id, 'request', 5, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'request');
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }
  const appId = parseInt(interaction.options.getString('game'), 10);
  const game = getGameByAppId(appId);
  if (!game) {
    return interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
  }

  const result = await createTicketForGame(interaction, appId);
  if (!result.ok) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }

  if (result.channel) {
    await interaction.reply({
      content: `✅ Ticket created: ${result.channel}. Activators have been notified.`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply(result.message);
  }
}
