import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { addWarning, getWarnings, getWarningCount, removeWarning, clearWarnings } from '../services/warnings.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Manage user warnings')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('add')
      .setDescription('Warn a user')
      .addUserOption((o) => o.setName('user').setDescription('User to warn').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for warning').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('View a user\'s warnings')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('remove')
      .setDescription('Remove a specific warning by ID')
      .addIntegerOption((o) => o.setName('id').setDescription('Warning ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('clear')
      .setDescription('Clear all warnings for a user')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const result = addWarning(user.id, reason, interaction.user.id);

    const embed = new EmbedBuilder()
      .setColor(result.autoBlacklisted ? 0xed4245 : 0xfee75c)
      .setTitle(result.autoBlacklisted ? '⛔ User Auto-Blacklisted' : '⚠️ Warning Issued')
      .setDescription(`<@${user.id}> has been warned.`)
      .addFields(
        { name: 'Reason', value: reason, inline: false },
        { name: 'Total Warnings', value: `${result.totalWarnings}/3`, inline: true },
        { name: 'Warning ID', value: `#${result.warningId}`, inline: true },
      )
      .setTimestamp();

    if (result.autoBlacklisted) {
      embed.addFields({ name: '⛔ Auto-Blacklisted', value: 'User reached 3 warnings and has been automatically blacklisted.', inline: false });
    }

    // DM the user
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(result.autoBlacklisted ? 0xed4245 : 0xfee75c)
            .setTitle(result.autoBlacklisted ? '⛔ You Have Been Blacklisted' : '⚠️ You Have Been Warned')
            .setDescription(
              result.autoBlacklisted
                ? `You have received **${result.totalWarnings}** warnings and have been automatically blacklisted.\n\n**Latest reason:** ${reason}`
                : `You have received a warning.\n\n**Reason:** ${reason}\n**Warnings:** ${result.totalWarnings}/3\n\n⚠️ At 3 warnings you will be automatically blacklisted.`
            )
            .setTimestamp(),
        ],
      }).catch(() => {});
    } catch {}

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'list') {
    const user = interaction.options.getUser('user');
    const warns = getWarnings(user.id);
    if (warns.length === 0) return interaction.reply({ content: `<@${user.id}> has no warnings.`, flags: MessageFlags.Ephemeral });

    const lines = warns.map((w) => {
      const date = new Date(w.created_at + 'Z');
      return `**#${w.id}** — ${w.reason}\n> By <@${w.issued_by}> • <t:${Math.floor(date.getTime() / 1000)}:R>`;
    });
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle(`⚠️ Warnings for ${user.displayName}`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `${warns.length}/3 warnings` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id');
    const removed = removeWarning(id);
    if (!removed) return interaction.reply({ content: `Warning #${id} not found.`, flags: MessageFlags.Ephemeral });
    return interaction.reply({ content: `✅ Warning **#${id}** removed.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'clear') {
    const user = interaction.options.getUser('user');
    const count = clearWarnings(user.id);
    return interaction.reply({ content: `✅ Cleared **${count}** warning${count !== 1 ? 's' : ''} for <@${user.id}>.`, flags: MessageFlags.Ephemeral });
  }
}
