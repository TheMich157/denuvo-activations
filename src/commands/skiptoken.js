import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getTokens, buyToken, addTokens, SKIP_TOKEN_COST } from '../services/skipTokens.js';
import { getBalance } from '../services/points.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('skiptoken')
  .setDescription('Cooldown skip tokens')
  .setContexts(0, 1)
  .addSubcommand((sub) =>
    sub.setName('buy')
      .setDescription(`Buy a cooldown skip token (${SKIP_TOKEN_COST} points)`)
  )
  .addSubcommand((sub) =>
    sub.setName('balance')
      .setDescription('Check skip token balance')
      .addUserOption((o) => o.setName('user').setDescription('User to check (leave empty for yourself)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('give')
      .setDescription('Give skip tokens to a user (Staff only)')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Number of tokens').setRequired(true))
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'buy') {
    const guildErr = requireGuild(interaction);
    if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
    const result = buyToken(interaction.user.id);
    if (!result.ok) {
      return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }
    const tokens = getTokens(interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('⚡ Skip Token Purchased!')
      .setDescription([
        `You bought a cooldown skip token for **${result.cost}** points.`,
        '',
        `💰 Remaining points: **${result.remaining}**`,
        `⚡ Skip tokens: **${tokens}**`,
        '',
        '> Your next activation request with an active cooldown will automatically use a skip token to bypass it.',
      ].join('\n'))
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'balance') {
    const target = interaction.options.getUser('user') || interaction.user;
    const isSelf = target.id === interaction.user.id;
    const tokens = getTokens(target.id);
    const points = getBalance(target.id);
    const label = isSelf ? 'Your' : `${target.displayName}'s`;
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`⚡ ${isSelf ? 'Skip Tokens' : `Skip Tokens — ${target.displayName}`}`)
      .addFields(
        { name: `${label} Tokens`, value: `**${tokens}**`, inline: true },
        { name: `${label} Points`, value: `**${points}**`, inline: true },
        { name: 'Token Cost', value: `**${SKIP_TOKEN_COST}** points`, inline: true },
      )
      .setFooter({ text: isSelf ? 'Use /skiptoken buy to purchase • Tokens auto-apply when you have a cooldown' : `Viewing ${target.tag || target.username}'s balance` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'give') {
    const guildErr = requireGuild(interaction);
    if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
    if (!isActivator(interaction.member)) {
      return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });
    }
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (amount < 1 || amount > 100) return interaction.reply({ content: 'Amount must be 1–100.', flags: MessageFlags.Ephemeral });
    addTokens(user.id, amount);
    const total = getTokens(user.id);

    // DM the recipient
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('⚡ You Received Skip Tokens!')
            .setDescription([
              `You've been given **${amount}** skip token${amount !== 1 ? 's' : ''}!`,
              '',
              `⚡ Your token balance: **${total}**`,
              '',
              '> Skip tokens automatically bypass cooldowns on your next activation request.',
            ].join('\n'))
            .setFooter({ text: 'Use /skiptoken balance to check your tokens' })
            .setTimestamp(),
        ],
      });
    } catch {
      // DMs may be disabled — continue silently
    }

    return interaction.reply({
      content: `✅ Gave **${amount}** skip token${amount !== 1 ? 's' : ''} to <@${user.id}>. They now have **${total}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
