import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { searchGames, getGameByAppId } from '../utils/games.js';
import { addActivatorStock } from '../services/activators.js';
import { getStockCount } from '../services/stock.js';
import { logRestock } from '../services/activationLog.js';
import { notifyWaitlistAndClear } from '../services/waitlist.js';
import { syncPanelMessage } from '../services/panel.js';
import { buildPanelMessagePayload } from './ticketpanel.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';

export const data = new SlashCommandBuilder()
  .setName('stock')
  .setDescription('Add a game to your stock (Activator only) – quick add as manual')
  .setContexts(0)
  .addStringOption((o) =>
    o
      .setName('game')
      .setDescription('Search for a game by name')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption((o) =>
    o
      .setName('quantity')
      .setDescription('How many pieces to add (1–9999, default: 5)')
      .setMinValue(1)
      .setMaxValue(9999)
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
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can add to stock.', flags: MessageFlags.Ephemeral });
  }
  if (!checkRateLimit(interaction.user.id, 'stock', 20, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'stock');
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }
  const appId = parseInt(interaction.options.getString('game'), 10);
  const quantity = interaction.options.getInteger('quantity') ?? 5;
  const game = getGameByAppId(appId);
  if (!game) {
    return interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
  }

  addActivatorStock(interaction.user.id, appId, game.name, quantity);
  logRestock({
    activatorId: interaction.user.id,
    gameAppId: appId,
    gameName: game.name,
    quantity,
    method: 'manual',
  }).catch(() => {});
  const count = getStockCount(appId);
  await interaction.reply({
    content: `Added **${quantity}** piece(s) of **${game.name}** to your stock. **${count}** in stock now. Deducts when you press Done and enter the code. Use \`/add\` for automated mode.`,
    flags: MessageFlags.Ephemeral,
  });

  // Auto-refresh panel and notify waitlisted users
  syncPanelMessage(interaction.client, buildPanelMessagePayload()).catch(() => {});
  notifyWaitlistAndClear(interaction.client, appId).catch(() => {});
}
