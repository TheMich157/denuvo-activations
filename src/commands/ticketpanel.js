import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { buildStockSelectMenus, getStockCount, getChunkLabel, getGlobalStockStats, getRestockStats, getPerGameRestockDetails } from '../services/stock.js';
import { getGameDisplayName, getGameByAppId } from '../utils/games.js';
import { db } from '../db/index.js';
import { getAvailableActivatorCount, getTotalActivatorCount } from '../services/activatorStatus.js';
import { getPanel, setPanel, clearPanel, deleteClosedMessage, cancelReopenTimer } from '../services/panel.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';

export const data = new SlashCommandBuilder()
  .setName('ticketpanel')
  .setDescription('Post the activation ticket panel in this channel (Activator only)')
  .setContexts(0);

export function buildPanelComponents() {
  debugger; // Debug: buildPanelComponents start
  console.log('[DEBUG] Building panel components...');
  
  const chunks = buildStockSelectMenus();
  console.log('[DEBUG] Built stock chunks:', chunks.length);
  
  if (chunks.length === 0) {
    console.log('[DEBUG] No chunks available, returning empty panel');
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ticket_panel:0')
          .setPlaceholder('No games in list')
          .addOptions([{ label: '(Empty)', value: '0' }])
          .setDisabled(true)
      ),
    ];
  }

  const LOW = 10;
  console.log('[DEBUG] Building panel rows from chunks...');
  
  const rows = chunks.map((chunk, i) => {
    console.log(`[DEBUG] Processing chunk ${i} with ${chunk.length} games`);
    
    const options = chunk.map((g) => {
      const stock = getStockCount(g.appId);
      const gameWithDemand = getGameByAppId(g.appId) || g;
      const highDemand = gameWithDemand.highDemand === true;
      const emoji = highDemand ? '🔥' : (stock === 0 ? '🔴' : stock < LOW ? '🟡' : '🟢');
      const displayName = getGameDisplayName(g);
      const maxLabelLen = 95;
      const label = displayName.length > maxLabelLen ? displayName.slice(0, maxLabelLen - 3) + '...' : displayName;
      
      console.log(`[DEBUG] Game option: ${label} (stock: ${stock}, emoji: ${emoji})`);
      
      return {
        label,
        value: String(g.appId),
        description: `${stock} token${stock !== 1 ? 's' : ''} available`,
        emoji: { name: emoji },
      };
    });
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_panel:${i}`)
        .setPlaceholder(getChunkLabel(chunk))
        .addOptions(options)
    );
  });

  return rows;
}

export function buildPanelMessagePayload() {
  const components = buildPanelComponents();
  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_panel_refresh')
      .setLabel('🔄 Refresh Stock')
      .setStyle(ButtonStyle.Secondary)
  );
  const stats = getGlobalStockStats();
  const restock = getRestockStats();
  const perGame = getPerGameRestockDetails(8);

  let regenText;
  if (restock.total === 0) {
    regenText = '✅ All stocked up — no pending regeneration';
  } else {
    const lines = [];
    // Per-game breakdown
    for (const g of perGame) {
      const game = getGameByAppId(g.gameAppId);
      const name = game ? getGameDisplayName(game) : (g.dbGameName || `App ${g.gameAppId}`);
      const ts = Math.floor(new Date(g.nextAt + 'Z').getTime() / 1000);
      lines.push(`⏳ **${name}** — +${g.pending} slot${g.pending > 1 ? 's' : ''} <t:${ts}:R>`);
    }
    // If there are more games than shown
    const totalGames = new Set(
      db.prepare(`SELECT DISTINCT game_app_id FROM stock_restock_queue WHERE datetime(restock_at) > datetime('now')`).all().map(r => r.game_app_id)
    ).size;
    if (totalGames > perGame.length) {
      lines.push(`… and **${totalGames - perGame.length}** more game${totalGames - perGame.length > 1 ? 's' : ''}`);
    }
    // Summary line
    lines.push(`\n📊 **${restock.total}** total slots regenerating`);
    regenText = lines.join('\n');
  }

  const embed = new EmbedBuilder()
    .setColor(0x1b2838)
    .setTitle('🎮 DenuBrew Activation Point')
    .setDescription(
      '**Request a Denuvo game activation** — Pick a game from the dropdown below. A private ticket opens, and an activator will handle your request and send you the authorization code.'
    )
    .addFields(
      {
        name: '📦 Available',
        value: `**${stats.totalStock}** activation slots`,
        inline: true,
      },
      {
        name: '🎮 Games',
        value: `**${stats.gamesInStock}/${stats.totalGames}** in stock`,
        inline: true,
      },
      {
        name: '🔥 Low stock',
        value: `**${stats.lowStockCount}** games (<10 slots)`,
        inline: true,
      },
      {
        name: '👥 Activators online',
        value: `**${getAvailableActivatorCount()}/${getTotalActivatorCount()}** available`,
        inline: true,
      },
      {
        name: '🔄 Regenerating',
        value: regenText,
        inline: false,
      },
      {
        name: '📖 Legend',
        value: '🟢 **10+** slots • 🟡 **Under 10** • 🔴 **Empty** • 🔥 **High demand** (2-day cooldown)',
        inline: false,
      },
      {
        name: '⏱️ Cooldowns',
        value: 'After each activation you must wait before requesting the **same game** again: **24 hours** for most games, **48 hours** for 🔥 high-demand games. You’ll get a DM when a cooldown applies; use `/profile` to see your cooldowns.',
        inline: false,
      },
      {
        name: '✨ How it works',
        value: [
          '**1.** Choose a game from the menu below',
          '**2.** A ticket channel opens for you',
          '**3.** An activator claims and completes the activation',
          '**4.** You receive your authorization code in the ticket',
        ].join('\n'),
        inline: false,
      },
      {
        name: '💰 Cost',
        value: '**Free** — No points required',
        inline: true,
      },
      {
        name: '⭐ Activator rewards',
        value: 'Points earned per completed activation',
        inline: true,
      }
    )
    .setFooter({
      text: '🔄 Refresh Stock updates availability • Select a game below to start',
    })
    .setTimestamp();
  return { embeds: [embed], components: [...components, refreshRow] };
}

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can post the ticket panel.', flags: MessageFlags.Ephemeral });
  }
  if (!checkRateLimit(interaction.user.id, 'ticketpanel', 3, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'ticketpanel');
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }
  const channel = interaction.channel;
  if (!channel?.isTextBased() || channel.isDMBased()) {
    return interaction.reply({ content: 'This command must be run in a server text channel.', flags: MessageFlags.Ephemeral });
  }

  // Clean up any existing active panel message
  const existing = getPanel();
  if (existing) {
    try {
      const oldChannel = await interaction.client.channels.fetch(existing.channel_id).catch(() => null);
      if (oldChannel?.isTextBased()) {
        const msg = await oldChannel.messages.fetch(existing.message_id).catch(() => null);
        if (msg) await msg.delete();
      }
    } catch {}
    clearPanel();
  }

  // Clean up any closed/maintenance message and cancel auto-reopen timer
  cancelReopenTimer();
  await deleteClosedMessage(interaction.client);

  const payload = buildPanelMessagePayload();
  const msg = await channel.send(payload);
  setPanel(interaction.guildId, channel.id, msg.id);

  await interaction.reply({ content: 'Ticket panel posted. Only one panel exists globally; the previous one was replaced.', flags: MessageFlags.Ephemeral });
}
