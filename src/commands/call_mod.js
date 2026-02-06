import { config } from '../config.js';

export async function handleButton(interaction) {
  if (!interaction.isButton() || interaction.customId !== 'call_activator') return false;

  const content = config.activatorRoleId
    ? `<@&${config.activatorRoleId}> — **Activator support requested** in this ticket.`
    : '**Activator support requested.** An activator will assist shortly.';
  await interaction.reply({
    content,
    allowedMentions: config.activatorRoleId ? { roles: [config.activatorRoleId] } : {},
  });
  return true;
}
