import { MessageFlags } from 'discord.js';
import { createTicketForGame } from '../services/ticket.js';
import { buildPanelMessagePayload } from './ticketpanel.js';
import { getPanel } from '../services/panel.js';
import { isValidAppId } from '../utils/validate.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';

export async function handleSelect(interaction) {
  if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('ticket_panel:')) return false;

  const value = interaction.values[0];
  if (value === '0') return true;

  const appId = parseInt(value, 10);
  if (!isValidAppId(appId)) {
    await interaction.reply({ content: 'Invalid game selection.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!checkRateLimit(interaction.user.id, 'panel_request', 5, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'panel_request');
    await interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await createTicketForGame(interaction, appId, { requireTicketCategory: true });
  if (!result.ok) {
    await interaction.editReply({ content: result.error });
    return true;
  }

  await interaction.editReply({ content: ` Ticket created: ${result.channel}. Activators have been notified.` });
  return true;
}

export async function handleRefresh(interaction) {
  if (!interaction.isButton() || interaction.customId !== 'ticket_panel_refresh') return false;

  const panel = getPanel();
  const msgId = interaction.message?.id != null ? String(interaction.message.id) : null;
  if (!panel || String(panel.message_id) !== msgId) {
    await interaction.reply({ content: 'This panel has been closed.', flags: MessageFlags.Ephemeral }).catch(() => null);
    return true;
  }

  const payload = buildPanelMessagePayload();
  await interaction.update({ components: payload.components });
  return true;
}
