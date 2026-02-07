import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import {
  getUserLevel,
  getLeaderboard,
  getUserRank,
  getTotalTracked,
  xpForLevel,
  totalXpForLevel,
  getLevelTitle,
  getLevelEmoji,
  progressBar,
  setLevel,
  setXp,
  resetLevel,
  addBonusXp,
} from '../services/leveling.js';
import { requireGuild } from '../utils/guild.js';
import { isWhitelisted } from '../utils/whitelist.js';

export const data = new SlashCommandBuilder()
  .setName('level')
  .setDescription('Leveling system — check rank, leaderboard, or manage levels')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub
      .setName('check')
      .setDescription('View your (or another user\'s) level card')
      .addUserOption((o) =>
        o.setName('user').setDescription('User to check (defaults to you)')
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('top')
      .setDescription('View the server level leaderboard')
  )
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('[Staff] Set a user\'s level directly')
      .addUserOption((o) =>
        o.setName('user').setDescription('Target user').setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName('level').setDescription('Level to set (0-200)').setRequired(true).setMinValue(0).setMaxValue(200)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('addxp')
      .setDescription('[Staff] Add bonus XP to a user')
      .addUserOption((o) =>
        o.setName('user').setDescription('Target user').setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName('amount').setDescription('XP to add').setRequired(true).setMinValue(1).setMaxValue(100000)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('reset')
      .setDescription('[Staff] Reset a user\'s leveling data')
      .addUserOption((o) =>
        o.setName('user').setDescription('Target user').setRequired(true)
      )
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();

  if (sub === 'check') return handleCheck(interaction);
  if (sub === 'top') return handleTop(interaction);

  // Staff-only subcommands
  if (!isWhitelisted(interaction.user.id)) {
    return interaction.reply({ content: 'Only whitelisted staff can use this subcommand.', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'set') return handleSet(interaction);
  if (sub === 'addxp') return handleAddXp(interaction);
  if (sub === 'reset') return handleReset(interaction);
}

// ─── /level check ───────────────────────────────────────────────

async function handleCheck(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const data = getUserLevel(targetUser.id);

  const level = data?.level ?? 0;
  const xp = data?.xp ?? 0;
  const totalMessages = data?.total_messages ?? 0;
  const needed = xpForLevel(level);
  const title = getLevelTitle(level);
  const emoji = getLevelEmoji(level);
  const bar = progressBar(xp, needed, 16);
  const pct = needed > 0 ? Math.round((xp / needed) * 100) : 0;
  const rank = getUserRank(targetUser.id);
  const totalTracked = getTotalTracked();
  const cumXp = totalXpForLevel(level) + xp;

  // Color gradient based on level (scales to 200)
  const colors = [0x95a5a6, 0x3498db, 0x2ecc71, 0xe67e22, 0xe74c3c, 0x9b59b6, 0xf1c40f, 0xe91e63, 0x1abc9c, 0x5865f2, 0xff00ff];
  const colorIndex = Math.min(Math.floor(level / 20), colors.length - 1);

  const embed = new EmbedBuilder()
    .setColor(colors[colorIndex])
    .setAuthor({
      name: `${targetUser.displayName}'s Level Card`,
      iconURL: targetUser.displayAvatarURL({ size: 64 }),
    })
    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
    .setDescription(
      [
        `${emoji} **Level ${level}** — *${title}*`,
        '',
        `\`${bar}\` **${pct}%**`,
        `**${xp.toLocaleString()}** / **${needed.toLocaleString()}** XP`,
      ].join('\n')
    )
    .addFields(
      { name: 'Server Rank', value: rank ? `#${rank} / ${totalTracked}` : 'Unranked', inline: true },
      { name: 'Total XP', value: cumXp.toLocaleString(), inline: true },
      { name: 'Messages', value: totalMessages.toLocaleString(), inline: true },
    )
    .setFooter({ text: `${(needed - xp).toLocaleString()} XP to Level ${level + 1}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── /level top ─────────────────────────────────────────────────

async function handleTop(interaction) {
  const rows = getLeaderboard(15);

  if (rows.length === 0) {
    return interaction.reply({
      content: 'No leveling data yet. Start chatting to earn XP!',
      flags: MessageFlags.Ephemeral,
    });
  }

  const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
  const lines = rows.map((r, i) => {
    const prefix = medals[i] ?? `\`${String(i + 1).padStart(2, ' ')}.\``;
    const emoji = getLevelEmoji(r.level);
    const title = getLevelTitle(r.level);
    const cumXp = totalXpForLevel(r.level) + r.xp;
    return `${prefix} <@${r.user_id}> ${emoji} Lv.**${r.level}** *${title}* \u2022 ${cumXp.toLocaleString()} XP`;
  });

  // Caller's own rank
  const callerRank = getUserRank(interaction.user.id);
  const callerData = getUserLevel(interaction.user.id);
  const footer = callerRank
    ? `Your rank: #${callerRank} \u2022 Level ${callerData.level} \u2022 ${(totalXpForLevel(callerData.level) + callerData.xp).toLocaleString()} XP`
    : 'Start chatting to appear on the leaderboard!';

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('\uD83C\uDFC6 Level Leaderboard')
    .setDescription(lines.join('\n'))
    .setFooter({ text: footer })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── /level set (whitelisted) ───────────────────────────────────

async function handleSet(interaction) {
  const target = interaction.options.getUser('user');
  const newLevel = interaction.options.getInteger('level');

  const oldData = getUserLevel(target.id);
  setLevel(target.id, newLevel);

  const title = getLevelTitle(newLevel);
  const emoji = getLevelEmoji(newLevel);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Level Override')
    .setDescription(
      [
        `**User:** <@${target.id}>`,
        `**Before:** Level ${oldData?.level ?? 0} (${(oldData?.xp ?? 0).toLocaleString()} XP)`,
        `**After:** ${emoji} Level ${newLevel} — *${title}* (XP reset to 0)`,
        '',
        `Set by <@${interaction.user.id}>`,
      ].join('\n')
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── /level addxp (whitelisted) ─────────────────────────────────

async function handleAddXp(interaction) {
  const target = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');

  const result = addBonusXp(target.id, amount);

  const lines = [
    `**User:** <@${target.id}>`,
    `**XP Added:** +${amount.toLocaleString()}`,
    `**Current:** Level ${result.newLevel} — ${result.xp.toLocaleString()} / ${xpForLevel(result.newLevel).toLocaleString()} XP`,
  ];
  if (result.leveledUp) {
    lines.push(`\u2B06\uFE0F Leveled up from ${result.oldLevel} to **${result.newLevel}**!`);
  }
  lines.push('', `Added by <@${interaction.user.id}>`);

  const embed = new EmbedBuilder()
    .setColor(result.leveledUp ? 0xfee75c : 0x57f287)
    .setTitle('Bonus XP Granted')
    .setDescription(lines.join('\n'))
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── /level reset (whitelisted) ─────────────────────────────────

async function handleReset(interaction) {
  const target = interaction.options.getUser('user');
  const oldData = getUserLevel(target.id);

  resetLevel(target.id);

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('Level Reset')
    .setDescription(
      [
        `**User:** <@${target.id}>`,
        `**Was:** Level ${oldData?.level ?? 0} with ${(oldData?.xp ?? 0).toLocaleString()} XP and ${(oldData?.total_messages ?? 0).toLocaleString()} messages`,
        `**Now:** Level 0 — all data wiped`,
        '',
        `Reset by <@${interaction.user.id}>`,
      ].join('\n')
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
