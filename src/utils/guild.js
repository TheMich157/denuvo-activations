/**
 * Ensure the interaction is from a guild (server). Use for commands that require a server context.
 * @param {import('discord.js').Interaction} interaction
 * @returns {string | null} Error message if not in a guild, null if OK
 */
export function requireGuild(interaction) {
  if (!interaction?.guildId || !interaction.guild) {
    return 'This command must be used in a server.';
  }
  return null;
}
