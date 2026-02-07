import { EmbedBuilder } from 'discord.js';
import { loggingConfig } from '../config/logging.js';
import { debug } from '../utils/debug.js';

const log = debug('transcript');

const MAX_MESSAGES = 100;
const MAX_TRANSCRIPT_LENGTH = 4000;

/**
 * Save a transcript of a ticket channel to the log channel.
 * @param {import('discord.js').Client} client
 * @param {string} channelId - Ticket channel ID
 * @param {string} requestId - Request ID for reference
 */
export async function saveTranscript(client, channelId, requestId) {
  if (!client || !channelId || !loggingConfig.logChannelId) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.messages) return;

    const messages = await channel.messages.fetch({ limit: MAX_MESSAGES });
    if (messages.size === 0) return;

    // Sort by timestamp (oldest first)
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Build transcript text
    const lines = sorted.map((m) => {
      const time = new Date(m.createdTimestamp).toISOString().slice(0, 19).replace('T', ' ');
      const author = m.author?.tag || 'Unknown';
      const content = m.content || '';
      const attachments = m.attachments?.size > 0
        ? ` [${m.attachments.size} attachment(s)]`
        : '';
      const embeds = m.embeds?.length > 0
        ? ` [${m.embeds.length} embed(s)]`
        : '';
      return `[${time}] ${author}: ${content}${attachments}${embeds}`;
    });

    let transcript = lines.join('\n');
    if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
      transcript = transcript.slice(0, MAX_TRANSCRIPT_LENGTH - 30) + '\n… (truncated)';
    }

    const ticketRef = `#${(requestId || '').slice(0, 8).toUpperCase()}`;

    const logChannel = await client.channels.fetch(loggingConfig.logChannelId).catch(() => null);
    if (!logChannel?.send) return;

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(`📝 Ticket Transcript — ${ticketRef}`)
      .setDescription(`\`\`\`\n${transcript}\n\`\`\``)
      .addFields(
        { name: 'Messages', value: `${sorted.length}`, inline: true },
        { name: 'Channel', value: `#${channel.name || channelId}`, inline: true }
      )
      .setFooter({ text: ticketRef })
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
    log(`Transcript saved for ticket ${ticketRef}`);
  } catch (err) {
    log('saveTranscript failed:', err?.message);
  }
}
