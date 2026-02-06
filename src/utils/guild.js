/**
 * Ensure interaction is in a guild. Returns error message or null if OK.
 */
export function requireGuild(interaction) {
  if (!interaction.guildId || !interaction.guild) {
    return 'This command must be used in a server.';
  }
  return null;
}
