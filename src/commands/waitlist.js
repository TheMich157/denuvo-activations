import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getFullWaitlist, removeFromWaitlist, removeUserFromAllWaitlists, getWaitlistCount } from '../services/waitlist.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { requireGuild } from '../utils/guild.js';
import { isWhitelisted } from '../utils/whitelist.js';

export const data = new SlashCommandBuilder()
  .setName('waitlist')
  .setDescription('View and manage the game waitlist')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('View all users on the waitlist, grouped by game')
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a user from a game waitlist')
      .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true))
      .addIntegerOption((o) => o.setName('appid').setDescription('Game App ID (leave empty to remove from all)').setRequired(false))
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const entries = getFullWaitlist();
    const total = getWaitlistCount();

    if (entries.length === 0) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📋 Waitlist')
            .setDescription('The waitlist is empty — no users are waiting for any games.')
            .setTimestamp(),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const lines = [];
    for (const entry of entries) {
      const game = getGameByAppId(entry.game_app_id);
      const name = game ? getGameDisplayName(game) : `App ${entry.game_app_id}`;
      const userMentions = entry.users.map((u) => `<@${u}>`).join(', ');
      lines.push(`**${name}** (${entry.game_app_id}) — ${entry.users.length} user${entry.users.length !== 1 ? 's' : ''}\n${userMentions}`);
    }

    // Paginate if too long
    let description = lines.join('\n\n');
    if (description.length > 4000) {
      description = description.slice(0, 3950) + '\n\n*… and more (truncated)*';
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Waitlist')
      .setDescription(description)
      .setFooter({ text: `${total} total entries across ${entries.length} game${entries.length !== 1 ? 's' : ''}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'remove') {
    if (!isWhitelisted(interaction.user.id)) {
      return interaction.reply({ content: 'Only whitelisted staff can remove users from the waitlist.', flags: MessageFlags.Ephemeral });
    }
    const targetUser = interaction.options.getUser('user');
    const appId = interaction.options.getInteger('appid');

    if (appId) {
      const removed = removeFromWaitlist(targetUser.id, appId);
      if (!removed) {
        return interaction.reply({ content: `<@${targetUser.id}> is not on the waitlist for App ID **${appId}**.`, flags: MessageFlags.Ephemeral });
      }
      const game = getGameByAppId(appId);
      const name = game ? getGameDisplayName(game) : `App ${appId}`;
      return interaction.reply({ content: `✅ Removed <@${targetUser.id}> from the waitlist for **${name}**.`, flags: MessageFlags.Ephemeral });
    }

    // Remove from all
    const count = removeUserFromAllWaitlists(targetUser.id);
    if (count === 0) {
      return interaction.reply({ content: `<@${targetUser.id}> is not on any waitlist.`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: `✅ Removed <@${targetUser.id}> from **${count}** waitlist${count !== 1 ? 's' : ''}.`, flags: MessageFlags.Ephemeral });
  }
}
