import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getTicketAutomationStats } from '../services/ticketAutomation.js';
import { isActivator } from '../utils/activator.js';

/**
 * Command to show browser automation statistics and health
 */
export const data = new SlashCommandBuilder()
  .setName('browserstats')
  .setDescription('Show browser automation statistics and system health')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  // Only allow activators or admins
  if (!isActivator(interaction.member)) {
    await interaction.reply({
      content: 'Only activators can use this command.',
      flags: 64 // Ephemeral
    });
    return;
  }

  await interaction.deferReply();

  try {
    const stats = getTicketAutomationStats();
    
    if (!stats) {
      await interaction.editReply({
        content: '❌ Browser automation system is not available.'
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🌐 Browser Automation Statistics')
      .setColor(0x3498db)
      .setDescription('Real-time browser pool and automation system status')
      .addFields(
        {
          name: '🏊 Browser Pool',
          value: [
            `**Total Instances:** ${stats.poolSize}`,
            `**Available:** ${stats.available}`,
            `**In Use:** ${stats.inUse}`,
            `**Healthy:** ${stats.healthyInstances}`,
            `**Utilization:** ${stats.utilizationRate}%`
          ].join('\n'),
          inline: true
        },
        {
          name: '📊 Performance',
          value: [
            `**Created:** ${stats.created}`,
            `**Destroyed:** ${stats.destroyed}`,
            `**Reused:** ${stats.reused}`,
            `**Errors:** ${stats.errors}`,
            `**Success Rate:** ${stats.created > 0 ? ((stats.created - stats.errors) / stats.created * 100).toFixed(1) : 0}%`
          ].join('\n'),
          inline: true
        },
        {
          name: '🎫 Ticket Automation',
          value: [
            `**Active Automations:** ${stats.activeAutomations}`,
            `**Pool Health:** ${stats.errors === 0 ? '✅ Excellent' : stats.errors < stats.created * 0.1 ? '⚠️ Good' : '❌ Poor'}`
          ].join('\n'),
          inline: false
        }
      )
      .setFooter({ text: 'Browser automation provides fallback when Steam cookies fail' })
      .setTimestamp();

    // Add status indicators
    let statusColor = 0x57f287; // Green
    let statusText = '🟢 Healthy';
    
    if (stats.errors > stats.created * 0.2) {
      statusColor = 0xed4245; // Red
      statusText = '🔴 Poor Health';
    } else if (stats.errors > 0 || stats.available === 0) {
      statusColor = 0xe67e22; // Orange
      statusText = '🟡 Needs Attention';
    }

    embed.addFields({
      name: '🏥 System Health',
      value: statusText,
      inline: true
    });

    embed.setColor(statusColor);

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Browser stats command error:', error);
    await interaction.editReply({
      content: '❌ Failed to retrieve browser automation statistics.'
    });
  }
}
