import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { completeRequest, getRequest, getPendingRequestForChannel } from '../services/requests.js';

export async function handleButton(interaction) {
  if (!interaction.isButton() || interaction.customId !== 'done_request') return false;

  const req = getPendingRequestForChannel(interaction.channelId);
  if (!req) {
    await interaction.reply({ content: 'No active request in this channel.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (req.issuer_id !== interaction.user.id) {
    await interaction.reply({ content: 'Only the assigned issuer can mark this as done.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`done_modal:${req.id}`)
    .setTitle('Enter authorization code');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('auth_code')
        .setLabel('Authorization code')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Paste the code from drm.steam.run')
    )
  );

  await interaction.showModal(modal);
  return true;
}

export async function handleModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('done_modal:')) return false;
  const requestId = interaction.customId.split(':')[1];
  const authCode = interaction.fields.getTextInputValue('auth_code');

  const req = getRequest(requestId);
  if (!req || req.issuer_id !== interaction.user.id) {
    await interaction.reply({ content: 'Invalid or unauthorized.', flags: MessageFlags.Ephemeral });
    return true;
  }

  completeRequest(requestId, authCode);

  const ticketChannel = req.ticket_channel_id
    ? await interaction.client.channels.fetch(req.ticket_channel_id).catch(() => null)
    : interaction.channel;
  if (ticketChannel) {
    try {
      const fetched = await ticketChannel.messages.fetch({ limit: 20 });
      const mainMsg = fetched.find((m) => m.author.id === interaction.client.user.id && m.components?.length);
      if (mainMsg?.editable) {
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Secondary)
        );
        await mainMsg.edit({ components: [closeRow] });
      }
    } catch {
      /* ignore */
    }
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Authorization code ready')
      .setDescription(`Here is your authorization code for **${req.game_name}**.\nSelect the code below and copy it.`)
      .addFields({
        name: 'Code',
        value: `\`\`\`\n${authCode}\n\`\`\``,
        inline: false,
      })
      .setFooter({ text: 'Click the button below to receive the code in a private message' });
    const copyRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`auth_copy:${requestId}`)
        .setLabel('📋 Copy code')
        .setStyle(ButtonStyle.Primary)
    );
    await ticketChannel.send({
      content: `<@${req.buyer_id}>`,
      embeds: [embed],
      components: [copyRow],
    });
  }

  await interaction.reply({
    content: `✅ **Activation completed.** Auth code sent to ticket. **${req.points_charged}** points transferred to you.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

export async function handleCopyButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('auth_copy:')) return false;
  const requestId = interaction.customId.split(':')[1];
  const req = getRequest(requestId);
  if (!req?.auth_code) {
    await interaction.reply({ content: 'Code no longer available.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const isBuyer = interaction.user.id === req.buyer_id;
  const isIssuer = interaction.user.id === req.issuer_id;
  if (!isBuyer && !isIssuer) {
    await interaction.reply({ content: 'Only the buyer or issuer can copy the code.', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.reply({
    content: `**Authorization code for ${req.game_name}:**\n\`\`\`\n${req.auth_code}\n\`\`\`\nSelect the text above and copy (Ctrl+C).`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
