import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { suggestGame, voteForGame, getTopVotes, hasVoted, closeVote, getVote, getUserVotes } from '../services/voting.js';
import { requireGuild } from '../utils/guild.js';
import { getUserTierInfo } from '../services/tiers.js';
import { isWhitelisted } from '../utils/whitelist.js';

export const data = new SlashCommandBuilder()
  .setName('vote')
  .setDescription('Vote on game requests')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('suggest')
      .setDescription('Suggest a game to be added')
      .addStringOption((o) => o.setName('game').setDescription('Game name').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('up')
      .setDescription('Vote for an existing suggestion')
      .addIntegerOption((o) => o.setName('id').setDescription('Suggestion ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('View top voted game suggestions')
  )
  .addSubcommand((sub) =>
    sub.setName('mine')
      .setDescription('View suggestions you\'ve voted for or created')
  )
  .addSubcommand((sub) =>
    sub.setName('close')
      .setDescription('Close a suggestion (Activator only)')
      .addIntegerOption((o) => o.setName('id').setDescription('Suggestion ID').setRequired(true))
      .addStringOption((o) =>
        o.setName('status').setDescription('Outcome').setRequired(true)
          .addChoices({ name: 'Added', value: 'added' }, { name: 'Rejected', value: 'rejected' })
      )
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'suggest') {
    const tierInfo = getUserTierInfo(interaction.user.id);
    if (tierInfo.tier === 'none') {
      return interaction.reply({ content: 'Only Ko-fi tier subscribers can suggest games. Subscribe at our Ko-fi page to unlock this!', flags: MessageFlags.Ephemeral });
    }
    const gameName = interaction.options.getString('game');
    const result = suggestGame(gameName, interaction.user.id);
    if (result.isNew) {
      return interaction.reply({ content: `✅ **${gameName}** has been suggested! Others can vote with \`/vote up id:${result.id}\`.`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: `👍 **${gameName}** already exists — your vote has been counted! (ID: ${result.id})`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'up') {
    const tierInfo = getUserTierInfo(interaction.user.id);
    if (tierInfo.tier === 'none') {
      return interaction.reply({ content: 'Only Ko-fi tier subscribers can vote. Subscribe at our Ko-fi page to unlock this!', flags: MessageFlags.Ephemeral });
    }
    const id = interaction.options.getInteger('id');
    const vote = getVote(id);
    if (!vote) return interaction.reply({ content: `Suggestion #${id} not found.`, flags: MessageFlags.Ephemeral });
    if (vote.status !== 'open') return interaction.reply({ content: `Suggestion #${id} is closed (${vote.status}).`, flags: MessageFlags.Ephemeral });
    if (hasVoted(id, interaction.user.id)) return interaction.reply({ content: 'You already voted for this.', flags: MessageFlags.Ephemeral });
    voteForGame(id, interaction.user.id);
    return interaction.reply({ content: `👍 Voted for **${vote.game_name}** (#${id}). Total: **${vote.votes + 1}** votes.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'list') {
    const top = getTopVotes(15);
    if (top.length === 0) return interaction.reply({ content: 'No game suggestions yet. Use `/vote suggest` to add one!', flags: MessageFlags.Ephemeral });
    const lines = top.map((v, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      return `${medal} **${v.game_name}** — ${v.votes} vote${v.votes !== 1 ? 's' : ''} (#${v.id})`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('🗳️ Game Request Votes')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Use /vote suggest to add • /vote up id:# to vote' })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'mine') {
    const votes = getUserVotes(interaction.user.id);
    if (votes.length === 0) return interaction.reply({ content: 'You haven\'t voted for or suggested any games yet.', flags: MessageFlags.Ephemeral });
    const statusEmoji = { open: '🟢', added: '✅', rejected: '❌' };
    const lines = votes.map((v) => {
      const emoji = statusEmoji[v.status] ?? '⚪';
      return `${emoji} **${v.game_name}** — ${v.votes} vote${v.votes !== 1 ? 's' : ''} (#${v.id}) [${v.status}]`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('🗳️ My Votes & Suggestions')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${votes.length} total` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'close') {
    if (!isWhitelisted(interaction.user.id)) {
      return interaction.reply({ content: 'Only whitelisted staff can close suggestions.', flags: MessageFlags.Ephemeral });
    }
    const id = interaction.options.getInteger('id');
    const status = interaction.options.getString('status');
    const vote = getVote(id);
    if (!vote) return interaction.reply({ content: `Suggestion #${id} not found.`, flags: MessageFlags.Ephemeral });
    closeVote(id, status);
    const emoji = status === 'added' ? '✅' : '❌';
    return interaction.reply({ content: `${emoji} Suggestion **#${id}** (${vote.game_name}) marked as **${status}**.`, flags: MessageFlags.Ephemeral });
  }
}
