import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { searchGames, getGameByAppId } from '../utils/games.js';
import { addActivatorGame, getActivatorGames } from '../services/activators.js';
import { getStockCount } from '../services/stock.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { config } from '../config.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';

export const data = new SlashCommandBuilder()
  .setName('add')
  .setDescription('Register a game for activations (Activator only)')
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName('game')
      .setDescription('Search for a game by name')
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
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can use this command.', flags: MessageFlags.Ephemeral });
  }
  if (!checkRateLimit(interaction.user.id, 'add', 20, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'add');
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }
  const appId = parseInt(interaction.options.getString('game'), 10);
  const game = getGameByAppId(appId);
  if (!game) {
    return interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
  }

  const existing = getActivatorGames(interaction.user.id).find((g) => g.game_app_id === appId);
  if (existing) {
    return interaction.reply({
      content: `You already have **${game.name}** registered (${existing.method}). Use \`/remove\` first to change.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`add_method:${appId}`)
      .setPlaceholder('Choose activation method')
      .addOptions([
        { label: 'Manual (I do activations myself)', value: 'manual' },
        { label: 'Automated (store Steam credentials)', value: 'automated' },
      ])
  );

  await interaction.reply({
    content: `**${game.name}** — How do you want to handle activations?`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSelect(interaction) {
  if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('add_method:')) return false;
  const appId = parseInt(interaction.customId.split(':')[1], 10);
  const game = getGameByAppId(appId);
  const method = interaction.values[0];

  if (method === 'manual') {
    addActivatorGame(interaction.user.id, appId, game.name, 'manual');
    const count = getStockCount(appId);
    await interaction.update({
      content: `Added **${game.name}** as manual activation. **${count}** in stock. You'll be pinged when someone requests it. Stock deducts only when you press Done and enter the code.`,
      components: [],
    });
    return true;
  }

  if (!config.encryptionKey || config.encryptionKey.length < 64) {
    await interaction.update({
      content: 'Automated mode requires ENCRYPTION_KEY (64 hex chars) in .env. Use manual mode or configure the bot.',
      components: [],
    });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`add_creds:${appId}`)
    .setTitle('Steam credentials (encrypted)');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('username')
        .setLabel('Steam username')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('password')
        .setLabel('Steam password')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Stored encrypted')
    )
  );

  await interaction.showModal(modal);
  return true;
}

export async function handleModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('add_creds:')) return false;
  const appId = parseInt(interaction.customId.split(':')[1], 10);
  const game = getGameByAppId(appId);
  const username = interaction.fields.getTextInputValue('username');
  const password = interaction.fields.getTextInputValue('password');

  addActivatorGame(interaction.user.id, appId, game.name, 'automated', { username, password });
  const count = getStockCount(appId);
  await interaction.reply({
    content: `Added **${game.name}** with automated activation. **${count}** in stock. Credentials stored encrypted. Stock deducts only when you press Done and enter the code.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
