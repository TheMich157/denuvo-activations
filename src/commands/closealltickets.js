import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getOpenTicketRequests, cancelRequest } from '../services/requests.js';
import { saveTranscript } from '../services/transcript.js';
import { clearState } from '../services/screenshotVerify/state.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('closealltickets')
  .setDescription('Close all open activation ticket channels (staff only)')
  .setContexts(0)
  .addBooleanOption((o) =>
    o
      .setName('confirm')
      .setDescription('Set to true to confirm you want to close ALL open tickets')
      .setRequired(true)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const confirm = interaction.options.getBoolean('confirm');
  if (!confirm) {
    return interaction.reply({
      content: '❌ Set **confirm** to `true` to close all open tickets. This will cancel every pending and in-progress ticket and delete their channels.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const open = getOpenTicketRequests();
  if (open.length === 0) {
    return interaction.reply({
      content: '✅ There are no open tickets to close.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let channelsDeleted = 0;
  const errors = [];

  for (const req of open) {
    try {
      if (req.ticket_channel_id) {
        await saveTranscript(interaction.client, req.ticket_channel_id, req.id).catch((err) => {
          errors.push(`Transcript #${req.id.slice(0, 8)}: ${err?.message || err}`);
        });
      }
      cancelRequest(req.id);
      clearState(req.ticket_channel_id);

      const channel = await interaction.client.channels.fetch(req.ticket_channel_id).catch(() => null);
      if (channel?.send) {
        await channel.send({
          content: `🔒 **Ticket closed by staff.** All open tickets were closed via \`/closealltickets\` by <@${interaction.user.id}>.`,
        }).catch(() => {});
      }
      if (channel?.deletable) {
        await channel.delete().then(() => { channelsDeleted++; }).catch((err) => {
          errors.push(`Delete #${req.id.slice(0, 8)}: ${err?.message || err}`);
        });
      }
    } catch (err) {
      errors.push(`#${req.id.slice(0, 8)}: ${err?.message || err}`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🔒 Close All Tickets')
    .setDescription(
      [
        `**${open.length}** ticket(s) cancelled. **${channelsDeleted}** channel(s) deleted.`,
        errors.length > 0
          ? `\n**Warnings (${errors.length}):**\n${errors.slice(0, 5).map((e) => `• ${e}`).join('\n')}${errors.length > 5 ? `\n• …and ${errors.length - 5} more` : ''}`
          : '',
      ].join('')
    )
    .setFooter({ text: `Requested by ${interaction.user.displayName || interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
