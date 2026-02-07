import { EmbedBuilder } from 'discord.js';
import { loggingConfig } from '../config/logging.js';
import { debug } from '../utils/debug.js';

const log = debug('activationLog');

let clientRef = null;

export function setClient(client) {
  clientRef = client;
}

async function getLogChannel() {
  if (!clientRef || !loggingConfig.logChannelId) return null;
  try {
    return await clientRef.channels.fetch(loggingConfig.logChannelId).catch(() => null);
  } catch {
    return null;
  }
}


async function sendToLogChannel(embed) {
  const channel = await getLogChannel();
  if (!channel?.send) return;
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log('Failed to send to log channel:', err?.message);
  }
}

const EMBED_FIELD_MAX = 1024;

function truncateCode(code) {
  if (typeof code !== 'string') return '';
  const s = code.trim();
  if (s.length <= EMBED_FIELD_MAX - 10) return s;
  return s.slice(0, EMBED_FIELD_MAX - 20) + '… (truncated)';
}

/**
 * Log a completed activation: who activated, when, with whom, game, token, request id.
 * @param {Object} req - Full request row from DB (id, buyer_id, issuer_id, game_name, game_app_id, auth_code, completed_at, points_charged, ticket_channel_id, created_at)
 */
export async function logActivation(req) {
  if (!req?.id || !req.auth_code) return;
  const completedAt = req.completed_at ? new Date(req.completed_at) : new Date();
  const codeDisplay = truncateCode(req.auth_code);
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Activation completed')
    .setDescription('Game activation completed and auth code delivered.')
    .addFields(
      { name: 'Request ID', value: `\`${req.id}\``, inline: true },
      { name: 'Game', value: `${req.game_name} (\`${req.game_app_id}\`)`, inline: true },
      { name: 'Points', value: String(req.points_charged ?? 0), inline: true },
      { name: 'Activator (issuer)', value: `<@${req.issuer_id}> (\`${req.issuer_id}\`)`, inline: false },
      { name: 'Buyer', value: `<@${req.buyer_id}> (\`${req.buyer_id}\`)`, inline: false },
      { name: 'Auth code / token', value: `\`\`\`\n${codeDisplay}\n\`\`\``, inline: false },
      { name: 'Completed at', value: `<t:${Math.floor(completedAt.getTime() / 1000)}:F>`, inline: true }
    )
    .setFooter({ text: `Ticket #${req.id.slice(0, 8).toUpperCase()}` })
    .setTimestamp(completedAt);
  await sendToLogChannel(embed);
}

/**
 * Log a ticket auto-closed (unverified pending timeout).
 */
export async function logTicketAutoClosed(data) {
  const { requestId, buyerId, gameName, gameAppId } = data;
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('⏱️ Ticket auto-closed')
    .setDescription('Ticket closed: screenshot not verified within deadline.')
    .addFields(
      { name: 'Request ID', value: `\`${requestId}\``, inline: true },
      { name: 'Game', value: `${gameName} (\`${gameAppId}\`)`, inline: true },
      { name: 'Buyer', value: `<@${buyerId}> (\`${buyerId}\`)`, inline: false }
    )
    .setFooter({ text: `Ticket #${(requestId || '').slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a failed/invalid request (invalid token, cancelled, or generic failure).
 */
export async function logRequestFailed(req, reason = 'failed') {
  if (!req?.id) return;
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('❌ Request failed')
    .setDescription(`Request marked as failed: **${reason}**.`)
    .addFields(
      { name: 'Request ID', value: `\`${req.id}\``, inline: true },
      { name: 'Game', value: `${req.game_name} (\`${req.game_app_id}\`)`, inline: true },
      { name: 'Activator (issuer)', value: req.issuer_id ? `<@${req.issuer_id}> (\`${req.issuer_id}\`)` : '—', inline: false },
      { name: 'Buyer', value: `<@${req.buyer_id}> (\`${req.buyer_id}\`)`, inline: false }
    )
    .setFooter({ text: `Ticket #${req.id.slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  await sendToLogChannel(embed);
}
