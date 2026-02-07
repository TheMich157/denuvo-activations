import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { getTranscript, getTranscriptsForUser } from '../services/transcript.js';
import { requireGuild } from '../utils/guild.js';

const EMBED_CHAR_LIMIT = 3800; // Leave margin for code block wrappers

export const data = new SlashCommandBuilder()
  .setName('transcript')
  .setDescription('View a past ticket transcript')
  .setContexts(0)
  .addStringOption((o) =>
    o
      .setName('ticket')
      .setDescription('Ticket ID (e.g. A1B2C3D4) — leave empty to see your recent tickets')
      .setRequired(false)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const ticketId = interaction.options.getString('ticket')?.trim();

  if (!ticketId) {
    // Show list of recent transcripts
    const transcripts = getTranscriptsForUser(interaction.user.id, 10);
    if (transcripts.length === 0) {
      return interaction.reply({ content: 'No transcripts found for your account.', flags: MessageFlags.Ephemeral });
    }

    const lines = transcripts.map((t) => {
      const ref = `#${t.request_id.slice(0, 8).toUpperCase()}`;
      const role = t.buyer_id === interaction.user.id ? 'Buyer' : 'Activator';
      const date = t.created_at ? `<t:${Math.floor(new Date(t.created_at).getTime() / 1000)}:d>` : '—';
      const dur = t.duration_seconds ? formatDurationShort(t.duration_seconds) : '—';
      const outcome = t.outcome ? outcomeEmoji(t.outcome) : '';
      return `${outcome} \`${ref}\` — **${t.game_name || 'Unknown'}** (${role}) • ${t.message_count} msgs • ${dur} • ${date}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('📝 Your Transcripts')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Use /transcript <ticket-id> to view full transcript' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // Look up specific transcript — try matching by prefix
  const cleanId = ticketId.replace(/^#/, '').toLowerCase();
  // Try direct match first
  let transcript = getTranscript(cleanId);
  // If not found, search by prefix
  if (!transcript) {
    const { db } = await import('../db/index.js');
    const row = db.prepare(
      `SELECT request_id FROM transcripts WHERE LOWER(SUBSTR(request_id, 1, 8)) = ? LIMIT 1`
    ).get(cleanId.slice(0, 8).toLowerCase());
    if (row) transcript = getTranscript(row.request_id);
  }

  if (!transcript) {
    return interaction.reply({ content: `No transcript found for ticket \`${ticketId}\`.`, flags: MessageFlags.Ephemeral });
  }

  // Permission check: only buyer, issuer, or activators
  const isBuyer = transcript.buyer_id === interaction.user.id;
  const isIssuer = transcript.issuer_id === interaction.user.id;
  const { isActivator } = await import('../utils/activator.js');
  const activator = isActivator(interaction.member);
  if (!isBuyer && !isIssuer && !activator) {
    return interaction.reply({ content: 'You can only view transcripts for your own tickets.', flags: MessageFlags.Ephemeral });
  }

  const ref = `#${transcript.request_id.slice(0, 8).toUpperCase()}`;
  const content = transcript.transcript || '(empty)';
  const dur = transcript.duration_seconds ? formatDurationShort(transcript.duration_seconds) : '—';
  const outcome = transcript.outcome || '—';

  const embed = new EmbedBuilder()
    .setColor(outcomeColor(outcome))
    .setTitle(`📝 Transcript — ${ref}`)
    .addFields(
      { name: '🎮 Game', value: transcript.game_name || '—', inline: true },
      { name: '👤 Buyer', value: transcript.buyer_id ? `<@${transcript.buyer_id}>` : '—', inline: true },
      { name: '🛠️ Activator', value: transcript.issuer_id ? `<@${transcript.issuer_id}>` : '—', inline: true },
      { name: '💬 Messages', value: `${transcript.message_count}`, inline: true },
      { name: '⏱️ Duration', value: dur, inline: true },
      { name: '📋 Outcome', value: `${outcomeEmoji(outcome)} ${outcome}`, inline: true },
    )
    .setFooter({ text: ref })
    .setTimestamp();

  const replyOpts = { embeds: [embed], flags: MessageFlags.Ephemeral };

  if (content.length <= EMBED_CHAR_LIMIT) {
    embed.setDescription(`\`\`\`\n${content}\n\`\`\``);
  } else {
    // Attach full transcript as a file and show preview in embed
    const preview = content.slice(content.length - 1200);
    embed.setDescription(
      `*Full transcript attached as a file.*\n\n**Last messages:**\n\`\`\`\n${preview}\n\`\`\``
    );
    const file = new AttachmentBuilder(
      Buffer.from(content, 'utf-8'),
      { name: `transcript-${ref.replace('#', '')}.txt` }
    );
    replyOpts.files = [file];
  }

  await interaction.reply(replyOpts);
}

// ─── Helpers ───

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

function outcomeEmoji(outcome) {
  if (!outcome) return '⬜';
  if (outcome === 'completed') return '✅';
  if (outcome === 'cancelled') return '❌';
  if (outcome.startsWith('auto_closed')) return '⏱️';
  return '⬜';
}

function outcomeColor(outcome) {
  if (outcome === 'completed') return 0x57f287;
  if (outcome === 'cancelled') return 0xed4245;
  if (outcome?.startsWith('auto_closed')) return 0xe67e22;
  return 0x95a5a6;
}
