export function requireGuild(interaction) {
  if (!interaction.guildId || !interaction.guild) {
    return 'This command must be used in a server.';
  }
  return null;
}
