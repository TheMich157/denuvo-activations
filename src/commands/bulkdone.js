import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { db } from '../db/index.js';
import { getRequest } from '../services/requests.js';
import { completeAndNotifyTicket } from './done.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('bulkdone')
  .setDescription('Complete multiple assigned requests at once by providing auth codes')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;

  // Get all in_progress requests assigned to this activator
  const assigned = db.prepare(`
    SELECT id, game_name, game_app_id, buyer_id, ticket_channel_id
    FROM requests
    WHERE issuer_id = ? AND status = 'in_progress'
    ORDER BY created_at ASC
  `).all(userId);

  if (assigned.length === 0) {
    return interaction.reply({
      content: 'You have no in-progress requests to complete.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Show a modal with a text area for entering codes
  // Format: one line per request — "REQUEST_ID CODE" or just list codes in order
  const listing = assigned.slice(0, 10).map((r, i) =>
    `${i + 1}. ${r.game_name} (#${r.id.slice(0, 8).toUpperCase()}) — <@${r.buyer_id}>`
  ).join('\n');

  const modal = new ModalBuilder()
    .setCustomId('bulkdone_modal')
    .setTitle('Bulk Complete Requests');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('codes')
        .setLabel(`Codes (one per line, in order — ${assigned.length} pending)`)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder(assigned.slice(0, 3).map((r, i) => `${r.id.slice(0, 8)} CODE${i + 1}`).join('\n'))
    )
  );

  await interaction.showModal(modal);
}

export async function handleModal(interaction) {
  if (!interaction.isModalSubmit() || interaction.customId !== 'bulkdone_modal') return false;

  const userId = interaction.user.id;
  const codesRaw = interaction.fields.getTextInputValue('codes').trim();
  const lines = codesRaw.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    await interaction.reply({ content: 'No codes provided.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Get assigned requests
  const assigned = db.prepare(`
    SELECT id, game_name, game_app_id, buyer_id, issuer_id, ticket_channel_id
    FROM requests
    WHERE issuer_id = ? AND status = 'in_progress'
    ORDER BY created_at ASC
  `).all(userId);

  if (assigned.length === 0) {
    await interaction.reply({ content: 'No in-progress requests found.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const results = [];
  let completed = 0;
  let failed = 0;

  for (const line of lines) {
    // Parse line: either "REQUEST_ID CODE" or just "CODE" (matched to next request in order)
    const parts = line.split(/\s+/);
    let req = null;
    let code = '';

    if (parts.length >= 2) {
      // Try to match first part as request ID prefix
      const prefix = parts[0].toLowerCase();
      req = assigned.find(r => r.id.toLowerCase().startsWith(prefix) && r.issuer_id === userId);
      code = parts.slice(1).join(' ');
    }

    if (!req) {
      // Treat entire line as a code, assign to next unprocessed request
      code = line;
      req = assigned.find(r => !results.some(res => res.id === r.id));
    }

    if (!req) {
      results.push({ game: '?', status: '⚠️ No matching request', id: '' });
      failed++;
      continue;
    }

    const fullReq = getRequest(req.id);
    if (!fullReq || fullReq.status !== 'in_progress') {
      results.push({ game: req.game_name, status: '⚠️ Already completed or cancelled', id: req.id });
      failed++;
      continue;
    }

    try {
      const result = await completeAndNotifyTicket(fullReq, code, interaction.client);
      if (result === 'screenshot_not_verified') {
        results.push({ game: req.game_name, status: '❌ Screenshot not verified', id: req.id });
        failed++;
      } else if (result) {
        results.push({ game: req.game_name, status: '✅ Completed', id: req.id });
        completed++;
      } else {
        results.push({ game: req.game_name, status: '❌ Failed to complete', id: req.id });
        failed++;
      }
    } catch (err) {
      results.push({ game: req.game_name, status: `❌ ${err?.message || 'Error'}`, id: req.id });
      failed++;
    }
  }

  const resultLines = results.map(r =>
    `${r.status} **${r.game}**${r.id ? ` (\`#${r.id.slice(0, 8).toUpperCase()}\`)` : ''}`
  );

  const embed = new EmbedBuilder()
    .setColor(failed === 0 ? 0x57f287 : completed === 0 ? 0xed4245 : 0xfee75c)
    .setTitle(`📦 Bulk Complete — ${completed}/${lines.length} done`)
    .setDescription(resultLines.join('\n'))
    .setFooter({ text: `${completed} completed • ${failed} failed` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  return true;
}
