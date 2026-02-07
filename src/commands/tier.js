import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { setUserTier, getUserTierInfo, removeUserTier, getAllTieredUsers, TIERS, syncTierRole } from '../services/tiers.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('tier')
  .setDescription('Manage Ko-fi supporter tiers')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('set')
      .setDescription('Set a user\'s Ko-fi tier')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) =>
        o.setName('tier').setDescription('Tier level').setRequired(true)
          .addChoices(
            { name: '🥉 Low Tier', value: 'low' },
            { name: '🥈 Mid Tier', value: 'mid' },
            { name: '🥇 High Tier', value: 'high' },
          )
      )
  )
  .addSubcommand((sub) =>
    sub.setName('remove')
      .setDescription('Remove a user\'s tier')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('view')
      .setDescription('View a user\'s tier')
      .addUserOption((o) => o.setName('user').setDescription('User (leave empty for yourself)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('List all tiered supporters')
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const user = interaction.options.getUser('user');
    const tier = interaction.options.getString('tier');
    setUserTier(user.id, tier);
    const info = TIERS[tier];

    // Auto-assign Discord role
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (member) await syncTierRole(member, tier);

    return interaction.reply({ content: `✅ Set <@${user.id}> to **${info.emoji} ${info.label}** (role synced).`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'remove') {
    const user = interaction.options.getUser('user');
    removeUserTier(user.id);

    // Remove all tier Discord roles
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (member) await syncTierRole(member, 'none');

    return interaction.reply({ content: `✅ Removed tier and role from <@${user.id}>.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'view') {
    const user = interaction.options.getUser('user') || interaction.user;
    const info = getUserTierInfo(user.id);
    if (info.tier === 'none') {
      return interaction.reply({ content: `<@${user.id}> has no Ko-fi tier.`, flags: MessageFlags.Ephemeral });
    }
    const t = TIERS[info.tier];
    const embed = new EmbedBuilder()
      .setColor(t.color)
      .setTitle(`${t.emoji} ${t.label}`)
      .setDescription(`<@${user.id}>`)
      .addFields(
        { name: 'Cooldown Reduction', value: `${Math.round(t.cooldownReduction * 100)}%`, inline: true },
        { name: 'Priority Bonus', value: `+${t.priorityBonus}`, inline: true },
        { name: 'Preorder Discount', value: t.preorderDiscount > 0 ? `${Math.round(t.preorderDiscount * 100)}%` : '—', inline: true },
        { name: 'Waitlist Priority', value: t.waitlistPriority ? '✅ Yes' : '❌ No', inline: true },
      )
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'list') {
    const all = getAllTieredUsers();
    if (all.length === 0) return interaction.reply({ content: 'No tiered supporters.', flags: MessageFlags.Ephemeral });
    const lines = all.map((u) => {
      const t = TIERS[u.tier];
      return `${t.emoji} **${t.label}** — <@${u.user_id}>`;
    });
    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('☕ Ko-fi Supporters')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${all.length} supporter${all.length !== 1 ? 's' : ''}` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}
