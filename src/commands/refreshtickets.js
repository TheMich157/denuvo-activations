import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getOpenTicketRequests } from '../services/requests.js';
import { buildTicketRecoveryPayload } from '../services/ticket.js';
import { triggerPanelSync } from '../services/panel.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('refreshtickets')
  .setDescription('Refresh the ticket panel and re-post missing messages in open ticket channels (staff only)')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let panelOk = false;
  try {
    await triggerPanelSync();
    panelOk = true;
  } catch (e) {
    console.error('[Refreshtickets] Panel sync failed:', e?.message);
  }

  const open = getOpenTicketRequests();
  let repaired = 0;
  let failed = 0;

  for (const req of open) {
    if (!req.ticket_channel_id) continue;
    try {
      const channel = await interaction.client.channels.fetch(req.ticket_channel_id).catch(() => null);
      if (!channel?.isTextBased?.() || channel.isDMBased()) {
        failed++;
        continue;
      }

      const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
      if (!messages) {
        failed++;
        continue;
      }

      const hasBotMessageWithButtons = messages.some(
        (m) => m.author.id === interaction.client.user.id && m.components?.length > 0
      );

      if (!hasBotMessageWithButtons) {
        const payload = buildTicketRecoveryPayload(req);
        await channel.send({
          content: '🔄 **Ticket refreshed** — the control message was missing and has been re-posted.',
          embeds: payload.embeds,
          components: payload.components,
        });
        repaired++;
      }
    } catch (e) {
      failed++;
      console.error('[Refreshtickets] Ticket repair failed:', req.id, e?.message);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(repaired > 0 || !panelOk ? 0xfee75c : 0x57f287)
    .setTitle('🔃 Refresh Tickets')
    .setDescription(
      [
        panelOk ? '✅ **Ticket panel** synced with current games/stock.' : '⚠️ **Ticket panel** could not be synced (no panel set or error).',
        '',
        open.length === 0
          ? 'No open ticket channels to check.'
          : `**Open tickets checked:** ${open.length}`,
        repaired > 0 ? `**Repaired:** ${repaired} channel(s) had the control message re-posted.` : repaired === 0 && open.length > 0 ? 'All open tickets already had their control message.' : '',
        failed > 0 ? `**Skipped/failed:** ${failed}` : '',
      ].filter(Boolean).join('\n')
    )
    .setFooter({ text: `Requested by ${interaction.user.displayName || interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
