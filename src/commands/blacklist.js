import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { addToBlacklist, removeFromBlacklist, getBlacklistAll, getBlacklistEntry } from '../services/blacklist.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('blacklist')
  .setDescription('Manage blacklisted users (Activator only)')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Blacklist a user from making requests')
      .addUserOption((o) => o.setName('user').setDescription('User to blacklist').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for blacklisting'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a user from the blacklist')
      .addUserOption((o) => o.setName('user').setDescription('User to unblacklist').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show all blacklisted users')
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can manage the blacklist.', flags: MessageFlags.Ephemeral });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') ?? null;
    if (target.bot) return interaction.reply({ content: 'Cannot blacklist a bot.', flags: MessageFlags.Ephemeral });
    addToBlacklist(target.id, reason, interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🚫 User blacklisted')
      .setDescription(`${target} has been blacklisted.${reason ? ` Reason: **${reason}**` : ''}`)
      .setFooter({ text: `By ${interaction.user.displayName || interaction.user.username}` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'remove') {
    const target = interaction.options.getUser('user');
    const entry = getBlacklistEntry(target.id);
    if (!entry) return interaction.reply({ content: `${target} is not blacklisted.`, flags: MessageFlags.Ephemeral });
    removeFromBlacklist(target.id);
    return interaction.reply({ content: `✅ ${target} has been removed from the blacklist.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'list') {
    const all = getBlacklistAll();
    if (all.length === 0) return interaction.reply({ content: 'Blacklist is empty.', flags: MessageFlags.Ephemeral });
    const lines = all.slice(0, 25).map((e) => {
      const ts = e.created_at ? `<t:${Math.floor(new Date(e.created_at).getTime() / 1000)}:d>` : '—';
      return `• <@${e.user_id}> — ${e.reason || 'No reason'} (${ts}, by <@${e.added_by}>)`;
    });
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🚫 Blacklisted users')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${all.length} user(s)` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}
