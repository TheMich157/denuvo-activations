import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { debug } from '../utils/debug.js';
import { getRequest, updateRequestStatus } from './requests.js';
import { getBrowserPool } from './browserPool.js';
import { generateAuthCodeWithFallback } from './drm.js';
import { completeAndNotifyTicket } from '../commands/done.js';
import { DrmError } from './drm.js';

const log = debug('ticketAutomation');

/**
 * Enhanced ticket automation service that integrates browser automation
 * with the ticket system for seamless code generation
 */
class TicketAutomation {
  constructor() {
    this.activeAutomations = new Map(); // requestId -> automation data
    this.browserPool = null;
    this.initBrowserPool();
  }

  /**
   * Initialize browser pool for ticket automation
   */
  async initBrowserPool() {
    try {
      this.browserPool = getBrowserPool({
        maxPoolSize: 5, // Larger pool for ticket automation
        maxIdleTime: 600000, // 10 minutes
        healthCheckInterval: 30000 // 30 seconds
      });
      log('Browser pool initialized for ticket automation');
    } catch (error) {
      log('Failed to initialize browser pool:', error.message);
    }
  }

  /**
   * Start automated code generation for a ticket
   */
  async startAutomation(requestId, client, channel) {
    try {
      const request = getRequest(requestId);
      if (!request) {
        throw new Error('Request not found');
      }

      if (request.status !== 'in_progress') {
        throw new Error('Request is not in progress');
      }

      // Store automation data
      this.activeAutomations.set(requestId, {
        startTime: Date.now(),
        status: 'initializing',
        progressMessages: [],
        client,
        channel
      });

      log(`Starting automation for request ${requestId}`);

      // Send initial status message
      const initialMessage = await this.sendStatusMessage(requestId, channel, {
        status: '🔄 Initializing automation...',
        description: 'Setting up browser automation for code generation...',
        color: 0xf39c12
      });

      const automation = this.activeAutomations.get(requestId);
      if (initialMessage) {
        automation.progressMessages.push(initialMessage);
      }

      // Update request status
      updateRequestStatus(requestId, 'automating');

      // Start the automation process
      await this.performAutomation(requestId, request);

      return true;
    } catch (error) {
      log(`Automation failed for request ${requestId}:`, error.message);
      await this.handleAutomationError(requestId, error);
      return false;
    }
  }

  /**
   * Perform the actual automation process
   */
  async performAutomation(requestId, request) {
    const automation = this.activeAutomations.get(requestId);
    if (!automation) return;

    try {
      // Step 1: Check browser pool status
      await this.updateStatus(requestId, {
        status: '🔍 Checking browser pool...',
        description: 'Verifying browser automation availability...',
        color: 0xf39c12
      });

      const poolStats = this.browserPool?.getStats();
      if (!poolStats || poolStats.available === 0) {
        throw new Error('No browser instances available');
      }

      await this.updateStatus(requestId, {
        status: '✅ Browser pool ready',
        description: `Found ${poolStats.available} available browser instances`,
        color: 0x57f287
      });

      // Step 2: Start code generation
      await this.updateStatus(requestId, {
        status: '⚙️ Generating authorization code...',
        description: `Processing **${request.game_name}** (App ID: ${request.game_app_id})`,
        color: 0x3498db
      });

      const startTime = Date.now();
      const code = await generateAuthCodeWithFallback(request.game_app_id);
      const duration = Date.now() - startTime;

      // Step 3: Success
      await this.updateStatus(requestId, {
        status: '🎉 Code generated successfully!',
        description: `Authorization code: \`${code}\`\nGenerated in ${Math.round(duration / 1000)}s`,
        color: 0x57f287
      });

      // Complete the ticket
      const result = await completeAndNotifyTicket(request, code, automation.client);
      
      if (result === 'screenshot_not_verified') {
        await this.updateStatus(requestId, {
          status: '⚠️ Screenshot verification required',
          description: 'The screenshot must be verified before completing the activation.',
          color: 0xe67e22
        });
        return;
      }

      // Final success message
      await this.updateStatus(requestId, {
        status: '✅ Activation complete!',
        description: `Code: \`${code}\`\nUser has been notified and ticket will be closed.`,
        color: 0x57f287
      });

      // Clean up automation
      this.activeAutomations.delete(requestId);
      log(`Automation completed successfully for request ${requestId}`);

    } catch (error) {
      await this.handleAutomationError(requestId, error);
    }
  }

  /**
   * Handle automation errors with detailed feedback
   */
  async handleAutomationError(requestId, error) {
    const automation = this.activeAutomations.get(requestId);
    if (!automation) return;

    let errorType = 'unknown';
    let userMessage = 'An unexpected error occurred';
    let suggestedAction = 'Try using the **Done** button to enter the code manually';

    if (error instanceof DrmError) {
      errorType = error.step || 'drm_error';
      
      if (error.message.includes('Invalid Steam cookies') || error.message.includes('Steam cookies were not accepted')) {
        userMessage = '🔐 Steam session expired';
        suggestedAction = 'Use **Done** to enter the code manually or wait for credentials to be refreshed';
      } else if (error.message.includes('Browser automation failed') || error.step?.includes('browser:')) {
        userMessage = '🌐 Browser automation failed';
        suggestedAction = 'Use **Done** to enter the code manually or check browser installation';
      } else if (error.message.includes('2FA code required')) {
        userMessage = '📧 2FA verification required';
        suggestedAction = 'Check your email for the Steam Guard code and try again';
      } else {
        userMessage = error.message;
      }
    }

    await this.updateStatus(requestId, {
      status: `❌ ${userMessage}`,
      description: `${suggestedAction}\n\nError details: ${error.message}`,
      color: 0xed4245
    });

    // Update request status back to in_progress so manual completion is possible
    const request = getRequest(requestId);
    if (request) {
      updateRequestStatus(requestId, 'in_progress');
    }

    // Keep automation data for potential retry
    automation.status = 'failed';
    automation.error = error;
    automation.errorType = errorType;

    log(`Automation error handled for request ${requestId}: ${errorType}`);
  }

  /**
   * Send or update status message in ticket channel
   */
  async sendStatusMessage(requestId, channel, statusData) {
    try {
      const embed = new EmbedBuilder()
        .setColor(statusData.color)
        .setTitle(statusData.status)
        .setDescription(statusData.description)
        .setFooter({ text: `Request #${requestId.slice(0, 8).toUpperCase()}` })
        .setTimestamp();

      return await channel.send({ embeds: [embed] });
    } catch (error) {
      log('Failed to send status message:', error.message);
      return null;
    }
  }

  /**
   * Update existing status message
   */
  async updateStatus(requestId, statusData) {
    const automation = this.activeAutomations.get(requestId);
    if (!automation || automation.progressMessages.length === 0) {
      return await this.sendStatusMessage(requestId, automation.channel, statusData);
    }

    try {
      const lastMessage = automation.progressMessages[automation.progressMessages.length - 1];
      const embed = new EmbedBuilder()
        .setColor(statusData.color)
        .setTitle(statusData.status)
        .setDescription(statusData.description)
        .setFooter({ text: `Request #${requestId.slice(0, 8).toUpperCase()}` })
        .setTimestamp();

      await lastMessage.edit({ embeds: [embed] });
    } catch (error) {
      log('Failed to update status message:', error.message);
      // Send new message if edit fails
      await this.sendStatusMessage(requestId, automation.channel, statusData);
    }
  }

  /**
   * Get automation status for a request
   */
  getAutomationStatus(requestId) {
    const automation = this.activeAutomations.get(requestId);
    if (!automation) return null;

    return {
      active: true,
      status: automation.status,
      startTime: automation.startTime,
      duration: Date.now() - automation.startTime,
      error: automation.error,
      errorType: automation.errorType
    };
  }

  /**
   * Cancel automation for a request
   */
  async cancelAutomation(requestId) {
    const automation = this.activeAutomations.get(requestId);
    if (!automation) return false;

    try {
      await this.updateStatus(requestId, {
        status: '🛑 Automation cancelled',
        description: 'The automation process was cancelled. You can use **Done** to enter the code manually.',
        color: 0xe67e22
      });

      this.activeAutomations.delete(requestId);
      
      // Update request status back to in_progress
      const request = getRequest(requestId);
      if (request) {
        updateRequestStatus(requestId, 'in_progress');
      }

      log(`Automation cancelled for request ${requestId}`);
      return true;
    } catch (error) {
      log('Failed to cancel automation:', error.message);
      return false;
    }
  }

  /**
   * Get browser pool statistics for ticket system
   */
  getPoolStatistics() {
    if (!this.browserPool) return null;
    
    const stats = this.browserPool.getStats();
    const activeAutomations = this.activeAutomations.size;

    return {
      ...stats,
      activeAutomations,
      healthyInstances: stats.poolSize - stats.inUse,
      utilizationRate: stats.poolSize > 0 ? (stats.inUse / stats.poolSize * 100).toFixed(1) : 0
    };
  }

  /**
   * Cleanup completed automations
   */
  cleanup() {
    const now = Date.now();
    const toRemove = [];

    for (const [requestId, automation] of this.activeAutomations) {
      // Remove automations older than 1 hour or failed for more than 30 minutes
      const age = now - automation.startTime;
      if (age > 3600000 || (automation.status === 'failed' && age > 1800000)) {
        toRemove.push(requestId);
      }
    }

    for (const requestId of toRemove) {
      this.activeAutomations.delete(requestId);
    }

    if (toRemove.length > 0) {
      log(`Cleaned up ${toRemove.length} old automations`);
    }
  }
}

// Global instance
let ticketAutomation = null;

/**
 * Get or create the ticket automation instance
 */
export function getTicketAutomation() {
  if (!ticketAutomation) {
    ticketAutomation = new TicketAutomation();
    
    // Start cleanup interval
    setInterval(() => {
      ticketAutomation.cleanup();
    }, 300000); // Every 5 minutes
  }
  
  return ticketAutomation;
}

/**
 * Start automated code generation for a ticket
 */
export async function startTicketAutomation(requestId, client, channel) {
  const automation = getTicketAutomation();
  return await automation.startAutomation(requestId, client, channel);
}

/**
 * Get automation status for a request
 */
export function getTicketAutomationStatus(requestId) {
  const automation = getTicketAutomation();
  return automation.getAutomationStatus(requestId);
}

/**
 * Cancel automation for a request
 */
export async function cancelTicketAutomation(requestId) {
  const automation = getTicketAutomation();
  return await automation.cancelAutomation(requestId);
}

/**
 * Get browser pool statistics for ticket system
 */
export function getTicketAutomationStats() {
  const automation = getTicketAutomation();
  return automation.getPoolStatistics();
}

export default TicketAutomation;
