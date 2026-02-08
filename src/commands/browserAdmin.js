import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getBrowserPool } from '../services/browserPool.js';
import { getTicketAutomation } from '../services/ticketAutomation.js';
import { isActivator } from '../utils/activator.js';

/**
 * Admin command for managing browser automation system
 */
export const data = new SlashCommandBuilder()
  .setName('browseradmin')
  .setDescription('Manage browser automation system (Admin only)')
  .addSubcommand(subcommand =>
    subcommand
      .setName('status')
      .setDescription('Show detailed browser automation status')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('restart')
      .setDescription('Restart the browser pool')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('clear')
      .setDescription('Clear all browser instances')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('cleanup')
      .setDescription('Force cleanup of old automations')
  );

export async function execute(interaction) {
  // Only allow activators
  if (!isActivator(interaction.member)) {
    await interaction.reply({
      content: 'Only activators can use this command.',
      flags: 64 // Ephemeral
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'status':
      await handleStatus(interaction);
      break;
    case 'restart':
      await handleRestart(interaction);
      break;
    case 'clear':
      await handleClear(interaction);
      break;
    case 'cleanup':
      await handleCleanup(interaction);
      break;
    default:
      await interaction.reply({
        content: 'Unknown subcommand.',
        flags: 64
      });
  }
}

async function handleStatus(interaction) {
  await interaction.deferReply();

  try {
    const pool = getBrowserPool();
    const ticketAutomation = getTicketAutomation();
    const poolStats = pool.getStats();
    const automationStats = ticketAutomation.getPoolStatistics();

    const embed = new EmbedBuilder()
      .setTitle('🔧 Browser Administration Panel')
      .setColor(0x9b59b6)
      .setDescription('Detailed browser automation system status')
      .addFields(
        {
          name: '🏊 Browser Pool Details',
          value: [
            `**Pool Size:** ${poolStats.poolSize}/${pool.options.maxPoolSize}`,
            `**Available:** ${poolStats.available}`,
            `**In Use:** ${poolStats.inUse}`,
            `**Created:** ${poolStats.created}`,
            `**Destroyed:** ${poolStats.destroyed}`,
            `**Reused:** ${poolStats.reused}`,
            `**Errors:** ${poolStats.errors}`
          ].join('\n'),
          inline: true
        },
        {
          name: '⚙️ Pool Configuration',
          value: [
            `**Max Pool Size:** ${pool.options.maxPoolSize}`,
            `**Max Idle Time:** ${pool.options.maxIdleTime / 60000} minutes`,
            `**Max Age:** ${pool.options.maxAge / 60000} minutes`,
            `**Health Check:** ${pool.options.healthCheckInterval / 1000} seconds`,
            `**Max Retries:** ${pool.options.maxRetries}`
          ].join('\n'),
          inline: true
        },
        {
          name: '🎫 Active Automations',
          value: [
            `**Active:** ${automationStats.activeAutomations}`,
            `**Utilization Rate:** ${automationStats.utilizationRate}%`,
            `**Healthy Instances:** ${automationStats.healthyInstances}`
          ].join('\n'),
          inline: false
        }
      )
      .setFooter({ text: 'Use /browseradmin restart|clear|cleanup to manage the system' })
      .setTimestamp();

    // Add health indicators
    let healthStatus = '🟢 Excellent';
    let healthColor = 0x57f287;
    
    if (poolStats.errors > poolStats.created * 0.2) {
      healthStatus = '🔴 Critical';
      healthColor = 0xed4245;
    } else if (poolStats.errors > 0 || poolStats.available === 0) {
      healthStatus = '🟡 Warning';
      healthColor = 0xe67e22;
    }

    embed.addFields({
      name: '🏥 System Health',
      value: healthStatus,
      inline: true
    });

    embed.setColor(healthColor);

    // Add action buttons
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('browser_restart')
        .setLabel('Restart Pool')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('browser_clear')
        .setLabel('Clear All')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('browser_cleanup')
        .setLabel('Force Cleanup')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

    // Handle button interactions
    const filter = i => i.user.id === interaction.user.id;
    const collector = interaction.channel.createMessageComponentCollector({ 
      filter, 
      time: 60000 // 1 minute
    });

    collector.on('collect', async (i) => {
      await i.deferUpdate();
      
      switch (i.customId) {
        case 'browser_restart':
          await performRestart(interaction);
          break;
        case 'browser_clear':
          await performClear(interaction);
          break;
        case 'browser_cleanup':
          await performCleanup(interaction);
          break;
      }
    });

    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });

  } catch (error) {
    console.error('Browser admin status error:', error);
    await interaction.editReply({
      content: '❌ Failed to retrieve browser administration status.'
    });
  }
}

async function handleRestart(interaction) {
  await interaction.deferReply();

  try {
    const pool = getBrowserPool();
    await pool.clear();
    
    // Reinitialize the pool
    const newPool = getBrowserPool();
    const stats = newPool.getStats();

    await interaction.editReply({
      content: `✅ **Browser pool restarted successfully!**\n\nNew pool status: ${stats.poolSize} instances ready.`
    });

  } catch (error) {
    console.error('Browser restart error:', error);
    await interaction.editReply({
      content: '❌ Failed to restart browser pool.'
    });
  }
}

async function handleClear(interaction) {
  await interaction.deferReply();

  try {
    const pool = getBrowserPool();
    const statsBefore = pool.getStats();
    await pool.clear();
    
    await interaction.editReply({
      content: `✅ **Browser pool cleared!**\n\nCleared ${statsBefore.poolSize} instances. New instances will be created on demand.`
    });

  } catch (error) {
    console.error('Browser clear error:', error);
    await interaction.editReply({
      content: '❌ Failed to clear browser pool.'
    });
  }
}

async function handleCleanup(interaction) {
  await interaction.deferReply();

  try {
    const ticketAutomation = getTicketAutomation();
    ticketAutomation.cleanup();
    
    const pool = getBrowserPool();
    await pool.performHealthCheck();
    const stats = pool.getStats();

    await interaction.editReply({
      content: `✅ **Cleanup completed!**\n\nCurrent pool status: ${stats.poolSize} instances, ${stats.available} available.`
    });

  } catch (error) {
    console.error('Browser cleanup error:', error);
    await interaction.editReply({
      content: '❌ Failed to perform cleanup.'
    });
  }
}

// Helper functions for button interactions
async function performRestart(interaction) {
  try {
    const pool = getBrowserPool();
    await pool.clear();
    const newPool = getBrowserPool();
    const stats = newPool.getStats();

    await interaction.followUp({
      content: `✅ **Browser pool restarted!**\n\nNew pool: ${stats.poolSize} instances ready.`,
      flags: 64 // Ephemeral
    });
  } catch (error) {
    await interaction.followUp({
      content: '❌ Failed to restart browser pool.',
      flags: 64
    });
  }
}

async function performClear(interaction) {
  try {
    const pool = getBrowserPool();
    const statsBefore = pool.getStats();
    await pool.clear();

    await interaction.followUp({
      content: `✅ **Browser pool cleared!**\n\nCleared ${statsBefore.poolSize} instances.`,
      flags: 64
    });
  } catch (error) {
    await interaction.followUp({
      content: '❌ Failed to clear browser pool.',
      flags: 64
    });
  }
}

async function performCleanup(interaction) {
  try {
    const ticketAutomation = getTicketAutomation();
    ticketAutomation.cleanup();
    const pool = getBrowserPool();
    await pool.performHealthCheck();
    const stats = pool.getStats();

    await interaction.followUp({
      content: `✅ **Cleanup completed!**\n\nPool: ${stats.poolSize} instances, ${stats.available} available.`,
      flags: 64
    });
  } catch (error) {
    await interaction.followUp({
      content: '❌ Failed to perform cleanup.',
      flags: 64
    });
  }
}
