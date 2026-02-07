import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getTranscript, getTranscriptsForUser } from '../services/transcript.js';
import { requireGuild } from '../utils/guild.js';

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
      return `\`${ref}\` — **${t.game_name || 'Unknown'}** (${role}) • ${t.message_count} msgs • ${date}`;
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

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`📝 Transcript — ${ref}`)
    .setDescription(`\`\`\`\n${content}\n\`\`\``)
    .addFields(
      { name: '🎮 Game', value: transcript.game_name || '—', inline: true },
      { name: '👤 Buyer', value: transcript.buyer_id ? `<@${transcript.buyer_id}>` : '—', inline: true },
      { name: '🛠️ Activator', value: transcript.issuer_id ? `<@${transcript.issuer_id}>` : '—', inline: true },
      { name: '💬 Messages', value: `${transcript.message_count}`, inline: true },
    )
    .setFooter({ text: ref })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
