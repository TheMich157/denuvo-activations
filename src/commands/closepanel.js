import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getPanel, clearPanel } from '../services/panel.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

const CLOSED_EMBED = new EmbedBuilder()
  .setColor(0xed4245)
  .setTitle('🔒 Panel Closed')
  .setDescription('This ticket panel is **no longer active**. Requests cannot be opened from this message.')
  .addFields({
    name: 'How to reopen',
    value: 'An activator must run `/ticketpanel` in the channel where the panel should appear. A new panel will then be posted here or in another channel.',
    inline: false,
  })
  .setFooter({ text: 'Panel closed by an activator • Use /ticketpanel to post a new one' })
  .setTimestamp();

export const data = new SlashCommandBuilder()
  .setName('closepanel')
  .setDescription('Close the ticket panel (Activator only)')
  .setDMPermission(false);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can close the panel.', flags: MessageFlags.Ephemeral });
  }

  const panel = getPanel();
  if (!panel) {
    return interaction.reply({ content: 'No active panel to close.', flags: MessageFlags.Ephemeral });
  }

  try {
    const channel = await interaction.client.channels.fetch(panel.channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      const msg = await channel.messages.fetch(panel.message_id).catch(() => null);
      if (msg?.editable) {
        await msg.edit({ embeds: [CLOSED_EMBED], components: [] });
      } else if (msg) {
        await msg.delete();
      }
    }
  } catch {
    /* ignore */
  }
  clearPanel();

  await interaction.reply({ content: '✅ Ticket panel closed.', flags: MessageFlags.Ephemeral });
}
