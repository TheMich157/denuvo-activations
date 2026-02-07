import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { getBalance, transferPoints } from '../services/points.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';
import { requireGuild } from '../utils/guild.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';

const pendingTransfers = new Map();
const TRANSFER_EXPIRE_MS = 60_000;

export const data = new SlashCommandBuilder()
  .setName('transfer')
  .setDescription('Send points to another user')
  .setContexts(0)
  .addUserOption((o) =>
    o.setName('user').setDescription('Who to send points to').setRequired(true)
  )
  .addIntegerOption((o) =>
    o.setName('amount').setDescription('How many points to send').setRequired(true).setMinValue(1)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  if (!checkRateLimit(interaction.user.id, 'transfer', 5, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'transfer');
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');

  if (target.id === interaction.user.id) {
    return interaction.reply({ content: 'You can\'t transfer points to yourself.', flags: MessageFlags.Ephemeral });
  }
  if (target.bot) {
    return interaction.reply({ content: 'You can\'t transfer points to a bot.', flags: MessageFlags.Ephemeral });
  }

  const balance = getBalance(interaction.user.id);
  if (balance < amount) {
    return interaction.reply({
      content: `Insufficient balance. You have **${balance}** points (${formatPointsAsMoney(balance)}).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const transferId = `${interaction.user.id}_${Date.now()}`;
  pendingTransfers.set(transferId, {
    fromId: interaction.user.id,
    toId: target.id,
    amount,
    expiresAt: Date.now() + TRANSFER_EXPIRE_MS,
  });
  setTimeout(() => pendingTransfers.delete(transferId), TRANSFER_EXPIRE_MS);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`transfer_confirm:${transferId}`)
      .setLabel(`Confirm — send ${amount} pts`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`transfer_cancel:${transferId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('💸 Confirm transfer')
    .setDescription(
      `Send **${amount}** points (${formatPointsAsMoney(amount)}) to ${target}?\n\nYour balance: **${balance}** → **${balance - amount}** after transfer.`
    )
    .setFooter({ text: 'Expires in 60 seconds' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleButton(interaction) {
  if (!interaction.isButton()) return false;
  const isConfirm = interaction.customId.startsWith('transfer_confirm:');
  const isCancel = interaction.customId.startsWith('transfer_cancel:');
  if (!isConfirm && !isCancel) return false;

  const transferId = interaction.customId.split(':')[1];
  const pending = pendingTransfers.get(transferId);

  if (!pending || pending.fromId !== interaction.user.id) {
    await interaction.update({ content: 'This transfer is no longer valid.', embeds: [], components: [] });
    return true;
  }

  pendingTransfers.delete(transferId);

  if (isCancel) {
    await interaction.update({ content: 'Transfer cancelled.', embeds: [], components: [] });
    return true;
  }

  if (Date.now() > pending.expiresAt) {
    await interaction.update({ content: 'Transfer expired. Use `/transfer` again.', embeds: [], components: [] });
    return true;
  }

  const ok = transferPoints(pending.fromId, pending.toId, pending.amount, `transfer_${transferId}`);
  if (!ok) {
    await interaction.update({ content: 'Transfer failed — insufficient balance.', embeds: [], components: [] });
    return true;
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Transfer complete')
    .setDescription(
      `**${pending.amount}** points sent to <@${pending.toId}>.`
    )
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [] });

  // DM recipient
  try {
    const toUser = await interaction.client.users.fetch(pending.toId).catch(() => null);
    if (toUser) {
      await toUser.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('💰 Points received')
            .setDescription(`<@${pending.fromId}> sent you **${pending.amount}** points (${formatPointsAsMoney(pending.amount)}).`)
            .setTimestamp(),
        ],
      });
    }
  } catch {}

  return true;
}
