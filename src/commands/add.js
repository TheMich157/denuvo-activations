import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { searchGames, getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { addActivatorGame, getActivatorGames } from '../services/activators.js';
import { getStockCount } from '../services/stock.js';
import { logRestock } from '../services/activationLog.js';
import { notifyWaitlistAndClear } from '../services/waitlist.js';
import { syncPanelMessage } from '../services/panel.js';
import { buildPanelMessagePayload } from './ticketpanel.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { config } from '../config.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';
import { testLogin } from '../services/drm.js';

export const data = new SlashCommandBuilder()
  .setName('add')
  .setDescription('Register a game for activations (Activator only)')
  .setContexts(0)
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
    games.map((g) => ({ name: getGameDisplayName(g), value: String(g.appId) }))
  );
}

export async function execute(interaction) {
  debugger; // Debug: add command execute start
  console.log('[DEBUG] /add command executed', { 
    userId: interaction.user.id, 
    gameOption: interaction.options.getString('game')
  });
  
  const guildErr = requireGuild(interaction);
  if (guildErr) {
    console.log('[DEBUG] Guild check failed:', guildErr);
    return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  }
  
  if (!isActivator(interaction.member)) {
    console.log('[DEBUG] User is not an activator:', interaction.user.id);
    return interaction.reply({ content: 'Only activators can use this command.', flags: MessageFlags.Ephemeral });
  }
  
  if (!checkRateLimit(interaction.user.id, 'add', 20, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'add');
    console.log('[DEBUG] Rate limited, remaining cooldown:', sec);
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }
  
  const appId = parseInt(interaction.options.getString('game'), 10);
  console.log('[DEBUG] Parsed appId:', appId);
  
  const game = getGameByAppId(appId);
  console.log('[DEBUG] Found game:', game?.name);
  
  if (!game) {
    console.log('[DEBUG] Game not found for appId:', appId);
    return interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
  }

  const existingEntries = getActivatorGames(interaction.user.id).filter((g) => g.game_app_id === appId);
  console.log('[DEBUG] Existing entries for game:', existingEntries.length);
  
  const hasManual = existingEntries.some((g) => g.method === 'manual');
  console.log('[DEBUG] Has manual entry:', hasManual);
  
  if (hasManual) {
    console.log('[DEBUG] User already has manual entry, rejecting');
    return interaction.reply({
      content: `You already have **${game.name}** registered as manual. Use \`/remove\` first to change.`,
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
  debugger; // Debug: add handleSelect start
  console.log('[DEBUG] add handleSelect called', { 
    customId: interaction.customId,
    values: interaction.values,
    userId: interaction.user.id
  });
  
  if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('add_method:')) return false;
  const appId = parseInt(interaction.customId.split(':')[1], 10);
  console.log('[DEBUG] Parsed appId from select:', appId);
  
  const game = getGameByAppId(appId);
  console.log('[DEBUG] Retrieved game:', game?.name);
  
  const method = interaction.values[0];
  console.log('[DEBUG] Selected method:', method);

  if (method === 'manual') {
    console.log('[DEBUG] Processing manual method for game:', game.name);
    
    const initialStock = 5;
    console.log('[DEBUG] Adding manual game with stock:', initialStock);
    
    addActivatorGame(interaction.user.id, appId, game.name, 'manual', null, initialStock);
    
    logRestock({
      activatorId: interaction.user.id,
      gameAppId: appId,
      gameName: game.name,
      quantity: initialStock,
      method: 'manual',
    }).catch(() => {});
    
    const count = getStockCount(appId);
    console.log('[DEBUG] New stock count:', count);
    
    await interaction.update({
      content: `Added **${game.name}** as manual activation. **${count}** in stock. You'll be pinged when someone requests it. Stock deducts only when you press Done and enter the code.`,
      components: [],
    });
    
    console.log('[DEBUG] Manual game added successfully');
    
    syncPanelMessage(interaction.client, buildPanelMessagePayload()).catch(() => {});
    notifyWaitlistAndClear(interaction.client, appId).catch(() => {});
    return true;
  }

  if (!config.encryptionKey || config.encryptionKey.length < 64) {
    console.log('[DEBUG] Encryption key check failed:', { 
      hasKey: !!config.encryptionKey, 
      keyLength: config.encryptionKey?.length 
    });
    
    await interaction.update({
      content: 'Automated mode requires ENCRYPTION_KEY (64 hex chars) in .env. Use manual mode or configure the bot.',
      components: [],
    });
    return true;
  }
  
  console.log('[DEBUG] Processing automated method, showing modal');

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
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('consent')
        .setLabel('Staff view credentials if auto fails?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('yes or no')
        .setMaxLength(3)
        .setMinLength(2)
    )
  );

  await interaction.showModal(modal);
  return true;
}

export async function handleModal(interaction) {
  debugger; // Debug: add handleModal start
  console.log('[DEBUG] add handleModal called', { 
    customId: interaction.customId,
    userId: interaction.user.id
  });
  
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('add_creds:')) return false;
  const appId = parseInt(interaction.customId.split(':')[1], 10);
  console.log('[DEBUG] Parsed appId from modal:', appId);
  
  const game = getGameByAppId(appId);
  console.log('[DEBUG] Retrieved game for modal:', game?.name);
  
  const username = interaction.fields.getTextInputValue('username');
  const password = interaction.fields.getTextInputValue('password');
  const consentRaw = interaction.fields.getTextInputValue('consent').trim().toLowerCase();
  const consentGranted = consentRaw === 'yes' || consentRaw === 'y';
  
  console.log('[DEBUG] Modal inputs:', { 
    username: username, 
    hasPassword: !!password, 
    consentRaw: consentRaw, 
    consentGranted: consentGranted 
  });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  console.log('[DEBUG] Deferred reply, testing login...');

  const testResult = await testLogin({ username, password });
  console.log('[DEBUG] Login test result:', testResult);
  
  if (!testResult.ok) {
    console.log('[DEBUG] Login test failed:', testResult.error);
    await interaction.editReply({
      content: `❌ **Login test failed** — credentials were not saved.\n\n${testResult.error}\n\nCheck your Steam username and password, then try \`/add\` again.`,
    });
    return true;
  }
  
  console.log('[DEBUG] Login test passed, checking existing accounts...');

  // Check if this exact Steam account is already registered for this game
  const existingAccounts = getActivatorGames(interaction.user.id).filter(
    (g) => g.game_app_id === appId && g.method === 'automated'
  );
  console.log('[DEBUG] Existing automated accounts:', existingAccounts.length);
  
  const alreadyHasAccount = existingAccounts.some((g) => g.steam_username === username);
  console.log('[DEBUG] Already has this account:', alreadyHasAccount);

  const initialStock = 5;
  console.log('[DEBUG] Adding automated game with stock:', initialStock);
  
  addActivatorGame(interaction.user.id, appId, game.name, 'automated', { username, password }, initialStock, consentGranted);
  
  logRestock({
    activatorId: interaction.user.id,
    gameAppId: appId,
    gameName: game.name,
    quantity: initialStock,
    method: 'automated',
  }).catch(() => {});
  
  const count = getStockCount(appId);
  const totalAccounts = existingAccounts.length + (alreadyHasAccount ? 0 : 1);
  
  console.log('[DEBUG] Final counts:', { stockCount: count, totalAccounts: totalAccounts });

  const twoFANote = testResult.requires2FA
    ? ' When generating a code, you\'ll be asked for the 5-digit confirmation code Steam sends to your email.'
    : '';
  const consentNote = consentGranted
    ? ' Staff can view credentials if automation fails.'
    : ' Staff **cannot** view credentials (no consent).';
  const accountNote = totalAccounts > 1
    ? ` You now have **${totalAccounts}** automated accounts for this game.`
    : '';
  const updateNote = alreadyHasAccount ? ' (credentials updated)' : '';
  await interaction.editReply({
    content: `✅ **Login test passed.** ${alreadyHasAccount ? 'Updated' : 'Added'} **${game.name}** with automated activation${updateNote}. **${count}** in stock. Credentials stored encrypted.${twoFANote}${consentNote}${accountNote}`,
  });
  syncPanelMessage(interaction.client, buildPanelMessagePayload()).catch(() => {});
  notifyWaitlistAndClear(interaction.client, appId).catch(() => {});
  return true;
}
