import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { db, scheduleSave } from '../db/index.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('bulkcode')
  .setDescription('Enter multiple auth codes to distribute to pending requests')
  .setContexts(0)
  .addIntegerOption((o) => o.setName('appid').setDescription('Game App ID').setRequired(true));

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const appId = interaction.options.getInteger('appid');

  // Check pending requests for this game
  const pending = db.prepare(`
    SELECT id, buyer_id, game_name, ticket_channel_id FROM requests
    WHERE game_app_id = ? AND status IN ('pending', 'in_progress')
    ORDER BY created_at ASC
  `).all(appId);

  if (pending.length === 0) {
    return interaction.reply({ content: `No pending requests for App ID **${appId}**.`, flags: MessageFlags.Ephemeral });
  }

  // Show a modal to enter codes
  const modal = new ModalBuilder()
    .setCustomId(`bulkcode_modal:${appId}`)
    .setTitle(`Bulk Codes — ${pending[0].game_name} (${pending.length} pending)`);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('codes')
        .setLabel(`Enter codes (one per line, ${pending.length} needed)`)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('CODE-AAA-BBB-CCC\nCODE-DDD-EEE-FFF\n...')
    )
  );

  await interaction.showModal(modal);
}

/**
 * Handle the bulk code modal submission.
 */
export async function handleBulkCodeModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('bulkcode_modal:')) return false;

  const appId = parseInt(interaction.customId.split(':')[1], 10);
  const codesRaw = interaction.fields.getTextInputValue('codes');
  const codes = codesRaw.split('\n').map((c) => c.trim()).filter(Boolean);

  if (codes.length === 0) {
    await interaction.reply({ content: 'No valid codes entered.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const pending = db.prepare(`
    SELECT id, buyer_id, game_name, ticket_channel_id FROM requests
    WHERE game_app_id = ? AND status IN ('pending', 'in_progress')
    ORDER BY created_at ASC
  `).all(appId);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let distributed = 0;
  const results = [];

  for (let i = 0; i < Math.min(codes.length, pending.length); i++) {
    const req = pending[i];
    const code = codes[i];

    // Mark as completed
    db.prepare(`
      UPDATE requests SET status = 'completed', auth_code = ?, issuer_id = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(code, interaction.user.id, req.id);
    scheduleSave();

    distributed++;
    results.push(`✅ <@${req.buyer_id}> — \`${code.slice(0, 8)}…\``);

    // Try to send code to ticket channel
    if (req.ticket_channel_id) {
      try {
        const channel = await interaction.client.channels.fetch(req.ticket_channel_id).catch(() => null);
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('🔑 Auth Code Delivered (Bulk)')
            .setDescription(`Your auth code for **${req.game_name}**:\n\`\`\`\n${code}\n\`\`\``)
            .setFooter({ text: `Distributed by ${interaction.user.displayName || interaction.user.username}` })
            .setTimestamp();
          await channel.send({ content: `<@${req.buyer_id}>`, embeds: [embed] });
        }
      } catch {}
    }

    // DM the user
    try {
      const user = await interaction.client.users.fetch(req.buyer_id).catch(() => null);
      if (user) {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle('🔑 Your Auth Code')
              .setDescription(`Your code for **${req.game_name}**:\n\`\`\`\n${code}\n\`\`\``)
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    } catch {}
  }

  const leftover = codes.length > pending.length ? codes.length - pending.length : 0;
  const unserved = pending.length > codes.length ? pending.length - codes.length : 0;

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`📦 Bulk Distribution: ${pending[0]?.game_name || appId}`)
    .setDescription(results.join('\n') || 'No codes distributed.')
    .addFields(
      { name: 'Distributed', value: `**${distributed}**`, inline: true },
      { name: 'Leftover codes', value: `${leftover}`, inline: true },
      { name: 'Still pending', value: `${unserved}`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  return true;
}
