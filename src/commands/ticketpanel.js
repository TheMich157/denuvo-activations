import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { buildStockSelectMenus, getStockCount, getChunkLabel, getGlobalStockStats, getRestockStats } from '../services/stock.js';
import { getPanel, setPanel, clearPanel } from '../services/panel.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';

export const data = new SlashCommandBuilder()
  .setName('ticketpanel')
  .setDescription('Post the activation ticket panel in this channel (Activator only)')
  .setDMPermission(false);

export function buildPanelComponents() {
  const chunks = buildStockSelectMenus();
  if (chunks.length === 0) {
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
  const rows = chunks.map((chunk, i) => {
    const options = chunk.map((g) => {
      const stock = getStockCount(g.appId);
      const emoji = stock === 0 ? '🔴' : stock < LOW ? '🟡' : '🟢';
      const maxLabelLen = 95;
      const label = g.name.length > maxLabelLen ? g.name.slice(0, maxLabelLen - 3) + '...' : g.name;
      return {
        label,
        value: String(g.appId),
        description: `${stock} in stock`,
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
  const regenParts = [];
  if (restock.in1h > 0) regenParts.push(`**${restock.in1h}** in <1h`);
  if (restock.in6h > 0) regenParts.push(`**${restock.in6h}** in <6h`);
  if (restock.in24h > 0) regenParts.push(`**${restock.in24h}** in <24h`);
  const regenText = regenParts.length > 0 ? regenParts.join(' • ') : 'None';

  const embed = new EmbedBuilder()
    .setColor(0x1b2838)
    .setTitle('🎮 Game Activation Center')
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
        name: '🔄 Regenerating',
        value: regenText,
        inline: false,
      },
      {
        name: '📖 Legend',
        value: '🟢 **10+** slots • 🟡 **Under 10** • 🔴 **Empty**',
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

  const payload = buildPanelMessagePayload();
  const msg = await channel.send(payload);
  setPanel(interaction.guildId, channel.id, msg.id);

  await interaction.reply({ content: 'Ticket panel posted. Only one panel exists globally; the previous one was replaced.', flags: MessageFlags.Ephemeral });
}
