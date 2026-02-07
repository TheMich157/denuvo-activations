import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { loggingConfig } from '../config/logging.js';
import { db, scheduleSave } from '../db/index.js';
import { debug } from '../utils/debug.js';

const log = debug('transcript');

const MAX_MESSAGES = 200;
const EMBED_CHAR_LIMIT = 4000;   // Discord embed description limit (leave some margin)

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Format a single Discord message into a human-readable line.
 */
function formatMessage(m, botId) {
  const time = new Date(m.createdTimestamp).toISOString().slice(0, 19).replace('T', ' ');
  const tag = m.author?.tag || m.author?.username || 'Unknown';
  const isBot = m.author?.id === botId;
  const label = isBot ? `[BOT] ${tag}` : tag;

  const parts = [];

  // Main text content
  if (m.content) parts.push(m.content);

  // Embed content — capture titles and descriptions instead of just "[N embed(s)]"
  if (m.embeds?.length > 0) {
    for (const embed of m.embeds) {
      const embedParts = [];
      if (embed.title) embedParts.push(`[Embed: ${embed.title}]`);
      if (embed.description) {
        // Keep embed description compact (strip markdown links, limit length)
        const desc = embed.description
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url) → text
          .replace(/\n{3,}/g, '\n')                    // collapse blank lines
          .slice(0, 300);
        embedParts.push(desc);
      }
      if (embed.fields?.length > 0) {
        for (const f of embed.fields) {
          embedParts.push(`  ${f.name}: ${f.value}`);
        }
      }
      if (embedParts.length > 0) parts.push(embedParts.join('\n'));
      else parts.push('[Embed]');
    }
  }

  // Attachment URLs
  if (m.attachments?.size > 0) {
    for (const [, att] of m.attachments) {
      parts.push(`[Attachment: ${att.name || 'file'} — ${att.url}]`);
    }
  }

  // Sticker names
  if (m.stickers?.size > 0) {
    const names = [...m.stickers.values()].map((s) => s.name).join(', ');
    parts.push(`[Sticker: ${names}]`);
  }

  // Component interactions (buttons shown)
  if (m.components?.length > 0) {
    const buttons = m.components
      .flatMap((row) => row.components || [])
      .filter((c) => c.label || c.emoji)
      .map((c) => c.label || c.emoji?.name || '?');
    if (buttons.length > 0) parts.push(`[Buttons: ${buttons.join(' | ')}]`);
  }

  const body = parts.join('\n  ') || '(empty)';
  return `[${time}] ${label}: ${body}`;
}

/**
 * Build a metadata header for the transcript.
 */
function buildHeader(reqRow, sorted, outcome) {
  const lines = ['═══════════════ TICKET TRANSCRIPT ═══════════════', ''];
  const ref = reqRow ? `#${reqRow.id?.slice(0, 8).toUpperCase()}` : '—';
  lines.push(`Ticket:     ${ref}`);
  if (reqRow?.game_name) lines.push(`Game:       ${reqRow.game_name}`);
  if (reqRow?.buyer_id) lines.push(`Buyer:      ${reqRow.buyer_id}`);
  if (reqRow?.issuer_id) lines.push(`Activator:  ${reqRow.issuer_id}`);
  if (reqRow?.status) lines.push(`Status:     ${reqRow.status}`);
  if (outcome) lines.push(`Outcome:    ${outcome}`);

  // Duration
  if (sorted.length >= 2) {
    const first = sorted[0].createdTimestamp;
    const last = sorted[sorted.length - 1].createdTimestamp;
    const dur = Math.round((last - first) / 1000);
    if (dur > 0) {
      const h = Math.floor(dur / 3600);
      const m = Math.floor((dur % 3600) / 60);
      const s = dur % 60;
      const parts = [];
      if (h) parts.push(`${h}h`);
      if (m) parts.push(`${m}m`);
      parts.push(`${s}s`);
      lines.push(`Duration:   ${parts.join(' ')}`);
    }
  }

  lines.push(`Messages:   ${sorted.length}`);

  const start = sorted.length > 0
    ? new Date(sorted[0].createdTimestamp).toISOString().slice(0, 19).replace('T', ' ')
    : '—';
  const end = sorted.length > 0
    ? new Date(sorted[sorted.length - 1].createdTimestamp).toISOString().slice(0, 19).replace('T', ' ')
    : '—';
  lines.push(`Opened:     ${start}`);
  lines.push(`Closed:     ${end}`);
  lines.push('', '═══════════════════════════════════════════════════', '');

  return lines.join('\n');
}

/**
 * Calculate ticket duration in seconds.
 */
function calcDuration(sorted) {
  if (sorted.length < 2) return null;
  return Math.round((sorted[sorted.length - 1].createdTimestamp - sorted[0].createdTimestamp) / 1000);
}

// ─── Main Export ────────────────────────────────────────────────

/**
 * Save a transcript of a ticket channel to the log channel AND to the database.
 * @param {import('discord.js').Client} client
 * @param {string} channelId - Ticket channel ID
 * @param {string} requestId - Request ID for reference
 * @param {string} [outcome] - How the ticket ended: 'completed', 'cancelled', 'auto_closed', etc.
 */
export async function saveTranscript(client, channelId, requestId, outcome) {
  if (!client || !channelId) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.messages) return;

    const messages = await channel.messages.fetch({ limit: MAX_MESSAGES });
    if (messages.size === 0) return;

    // Sort by timestamp (oldest first)
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Fetch request metadata
    let reqRow = null;
    try {
      reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    } catch {}

    // Build full transcript
    const header = buildHeader(reqRow, sorted, outcome);
    const lines = sorted.map((m) => formatMessage(m, client.user.id));
    const fullTranscript = header + lines.join('\n');
    const durationSecs = calcDuration(sorted);

    // Save to DB (store full text, no truncation)
    try {
      db.prepare(`
        INSERT OR REPLACE INTO transcripts (request_id, buyer_id, issuer_id, game_name, transcript, message_count, duration_seconds, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        reqRow?.buyer_id || '',
        reqRow?.issuer_id || null,
        reqRow?.game_name || '',
        fullTranscript,
        sorted.length,
        durationSecs,
        outcome || reqRow?.status || null
      );
      scheduleSave();
    } catch (err) {
      log('DB transcript save failed:', err?.message);
    }

    // Post to log channel
    if (loggingConfig.logChannelId) {
      const ticketRef = `#${(requestId || '').slice(0, 8).toUpperCase()}`;
      const logChannel = await client.channels.fetch(loggingConfig.logChannelId).catch(() => null);
      if (logChannel?.send) {
        const gameName = reqRow?.game_name || '—';
        const durationStr = durationSecs
          ? formatDurationShort(durationSecs)
          : '—';
        const outcomeStr = outcome || reqRow?.status || '—';

        const embed = new EmbedBuilder()
          .setColor(outcome === 'completed' ? 0x57f287 : outcome === 'cancelled' ? 0xed4245 : 0x95a5a6)
          .setTitle(`📝 Transcript — ${ticketRef}`)
          .addFields(
            { name: '🎮 Game', value: gameName, inline: true },
            { name: '👤 Buyer', value: reqRow?.buyer_id ? `<@${reqRow.buyer_id}>` : '—', inline: true },
            { name: '🛠️ Activator', value: reqRow?.issuer_id ? `<@${reqRow.issuer_id}>` : '—', inline: true },
            { name: '💬 Messages', value: `${sorted.length}`, inline: true },
            { name: '⏱️ Duration', value: durationStr, inline: true },
            { name: '📋 Outcome', value: outcomeStr, inline: true },
          )
          .setFooter({ text: ticketRef })
          .setTimestamp();

        // If transcript fits in an embed description, use it; otherwise attach as file
        if (fullTranscript.length <= EMBED_CHAR_LIMIT) {
          embed.setDescription(`\`\`\`\n${fullTranscript}\n\`\`\``);
          await logChannel.send({ embeds: [embed] });
        } else {
          // Short preview in embed + full transcript as .txt file
          const preview = lines.slice(-8).join('\n');
          const previewTruncated = preview.length > 1500
            ? preview.slice(0, 1500) + '\n… (see attached file for full transcript)'
            : preview;
          embed.setDescription(
            `*Transcript too long for embed — see attached file.*\n\n**Last messages:**\n\`\`\`\n${previewTruncated}\n\`\`\``
          );

          const file = new AttachmentBuilder(
            Buffer.from(fullTranscript, 'utf-8'),
            { name: `transcript-${ticketRef.replace('#', '')}.txt` }
          );
          await logChannel.send({ embeds: [embed], files: [file] });
        }
      }
    }

    log(`Transcript saved for ticket #${(requestId || '').slice(0, 8).toUpperCase()} (${sorted.length} msgs, ${outcome || 'unknown'})`);
  } catch (err) {
    log('saveTranscript failed:', err?.message);
  }
}

/**
 * Get a stored transcript by request ID.
 */
export function getTranscript(requestId) {
  return db.prepare('SELECT * FROM transcripts WHERE request_id = ?').get(requestId);
}

/**
 * Get transcripts for a user (as buyer or issuer).
 */
export function getTranscriptsForUser(userId, limit = 10) {
  return db.prepare(`
    SELECT request_id, buyer_id, issuer_id, game_name, message_count, duration_seconds, outcome, created_at
    FROM transcripts
    WHERE buyer_id = ? OR issuer_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, userId, limit);
}

// ─── Utilities ──────────────────────────────────────────────────

function formatDurationShort(seconds) {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
