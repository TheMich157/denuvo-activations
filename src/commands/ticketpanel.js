import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { buildStockSelectMenus, getStockCount, getChunkLabel } from '../services/stock.js';
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

  const rows = chunks.map((chunk, i) => {
    const options = chunk.map((g) => {
      const stock = getStockCount(g.appId);
      const stockSuffix = ` — ${stock} in stock`;
      const maxNameLen = 82;
      const label = (g.name.length > maxNameLen ? g.name.slice(0, maxNameLen - 3) + '...' : g.name) + stockSuffix;
      return { label, value: String(g.appId) };
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
    } catch {
      /* ignore */
    }
    clearPanel();
  }

  const components = buildPanelComponents();
  const embed = new EmbedBuilder()
    .setColor(0x1b2838)
    .setTitle('🎮 Game Activation Center')
    .setDescription(
      '**Request a Denuvo game activation** — Pick a game from the dropdown below. A private ticket opens, and an activator will handle your request and send you the authorization code.'
    )
    .addFields(
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
        name: '📦 Availability',
        value: 'Games show stock count. Click **Refresh Stock** to update.',
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

  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_panel_refresh')
      .setLabel('🔄 Refresh Stock')
      .setStyle(ButtonStyle.Secondary)
  );

  const msg = await channel.send({
    embeds: [embed],
    components: [...components, refreshRow],
  });
  setPanel(interaction.guildId, channel.id, msg.id);

  await interaction.reply({ content: 'Ticket panel posted. Only one panel exists globally; the previous one was replaced.', flags: MessageFlags.Ephemeral });
}
