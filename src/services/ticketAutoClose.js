import { getUnverifiedPendingOlderThan } from './requests.js';
import { cancelRequest, setCooldown } from './requests.js';
import { clearState } from './screenshotVerify/state.js';
import { ticketConfig } from '../config/ticket.js';
import { logTicketAutoClosed, logStaleTicketClosed } from './activationLog.js';
import { debug } from '../utils/debug.js';
import { getCooldownHours } from '../utils/games.js';
import { db } from '../db/index.js';
import { saveTranscript } from './transcript.js';
import { addWarning } from './warnings.js';

const log = debug('ticketAutoClose');

let clientRef = null;
let intervalId = null;

const STALE_TICKET_MINUTES = 120; // 2 hours idle for in_progress tickets

export function startTicketAutoClose(client) {
  clientRef = client;
  if (intervalId) clearInterval(intervalId);
  const { checkIntervalMs, verifyDeadlineMinutes } = ticketConfig;
  intervalId = setInterval(() => {
    runCheck(verifyDeadlineMinutes).catch((err) => log('Check failed:', err?.message));
    runStaleCheck().catch((err) => log('Stale check failed:', err?.message));
  }, checkIntervalMs);
  runCheck(verifyDeadlineMinutes).catch((err) => {
    log('First run check failed:', err?.message);
  });
}

export function stopTicketAutoClose() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  clientRef = null;
}

async function runCheck(deadlineMinutes = ticketConfig.verifyDeadlineMinutes) {
  if (!clientRef) return;
  const toClose = getUnverifiedPendingOlderThan(deadlineMinutes);
  for (const req of toClose) {
    // Save transcript before closing
    if (req.ticket_channel_id) {
      await saveTranscript(clientRef, req.ticket_channel_id, req.id).catch((err) =>
        log('Transcript save failed:', err?.message)
      );
    }
    cancelRequest(req.id);
    setCooldown(req.buyer_id, req.game_app_id);
    clearState(req.ticket_channel_id);
    const cooldownH = getCooldownHours(req.game_app_id);
    const msg = `⏱️ <@${req.buyer_id}> Your **${req.game_name}** ticket was closed: screenshot was not verified within ${deadlineMinutes} minutes. You can request this game again in **${cooldownH} hours**.`;
    const channel = await clientRef.channels.fetch(req.ticket_channel_id).catch((err) => {
      log('Fetch ticket channel failed:', req.ticket_channel_id, err?.message);
      return null;
    });
    if (channel?.send) {
      await channel.send({ content: msg, allowedMentions: { users: [req.buyer_id] } }).catch((err) => {
        log('Send to ticket channel failed:', req.id, err?.message);
      });
    }
    try {
      const user = await clientRef.users.fetch(req.buyer_id).catch((err) => {
        log('DM buyer failed:', req.buyer_id, err?.message);
        return null;
      });
      if (user) await user.send(msg.replace(`<@${req.buyer_id}> `, '')).catch(() => null);
    } catch (e) {
      log('DM buyer error:', e?.message);
    }
    if (channel?.deletable) {
      await channel.delete().catch((err) => {
        log('Delete ticket channel failed:', req.ticket_channel_id, err?.message);
      });
    }
    await logTicketAutoClosed({
      requestId: req.id,
      buyerId: req.buyer_id,
      gameName: req.game_name,
      gameAppId: req.game_app_id,
    });

    // Auto-warn the requester for inactivity
    try {
      const result = addWarning(
        req.buyer_id,
        `Ticket auto-closed: screenshot not verified within ${deadlineMinutes} minutes (${req.game_name})`,
        clientRef.user.id
      );
      log(`Warning issued to ${req.buyer_id} (${result.totalWarnings}/3)${result.autoBlacklisted ? ' — AUTO-BLACKLISTED' : ''}`);
      const user = await clientRef.users.fetch(req.buyer_id).catch(() => null);
      if (user) {
        const warnMsg = result.autoBlacklisted
          ? `⛔ You have been **auto-blacklisted** (${result.totalWarnings}/3 warnings). Your ticket for **${req.game_name}** was closed due to inactivity.`
          : `⚠️ You received a **warning** (${result.totalWarnings}/3) because your ticket for **${req.game_name}** was auto-closed due to inactivity. At 3 warnings you will be blacklisted.`;
        await user.send(warnMsg).catch(() => {});
      }
    } catch (e) {
      log('Auto-warn failed:', e?.message);
    }
  }
}

/**
 * Close stale in_progress tickets (no activity for STALE_TICKET_MINUTES).
 */
async function runStaleCheck() {
  if (!clientRef) return;
  const stale = db.prepare(`
    SELECT id, buyer_id, issuer_id, game_app_id, game_name, ticket_channel_id
    FROM requests
    WHERE status = 'in_progress'
      AND datetime(created_at) < datetime('now', '-' || ? || ' minutes')
  `).all(STALE_TICKET_MINUTES);

  for (const req of stale) {
    // Check if channel has recent messages before closing
    let hasRecentActivity = false;
    if (req.ticket_channel_id) {
      try {
        const channel = await clientRef.channels.fetch(req.ticket_channel_id).catch(() => null);
        if (channel?.messages) {
          const recent = await channel.messages.fetch({ limit: 1 });
          const lastMsg = recent.first();
          if (lastMsg) {
            const msgAge = Date.now() - lastMsg.createdTimestamp;
            if (msgAge < STALE_TICKET_MINUTES * 60 * 1000) {
              hasRecentActivity = true;
            }
          }
        }
      } catch {
        // ignore fetch errors
      }
    }
    if (hasRecentActivity) continue;

    // Save transcript before closing
    if (req.ticket_channel_id) {
      await saveTranscript(clientRef, req.ticket_channel_id, req.id).catch((err) =>
        log('Transcript save failed:', err?.message)
      );
    }

    cancelRequest(req.id);
    clearState(req.ticket_channel_id);
    const msg = `⏱️ This ticket was automatically closed due to **${STALE_TICKET_MINUTES} minutes** of inactivity. If you need help, please create a new request.`;
    const channel = await clientRef.channels.fetch(req.ticket_channel_id).catch(() => null);
    if (channel?.send) {
      await channel.send({ content: msg }).catch((err) =>
        log('Send stale close msg failed:', err?.message)
      );
    }
    if (channel?.deletable) {
      // Wait a few seconds so the user can see the message
      await new Promise((r) => setTimeout(r, 5000));
      await channel.delete().catch((err) =>
        log('Delete stale channel failed:', err?.message)
      );
    }
    await logStaleTicketClosed({
      requestId: req.id,
      buyerId: req.buyer_id,
      issuerId: req.issuer_id,
      gameName: req.game_name,
      gameAppId: req.game_app_id,
      idleMinutes: STALE_TICKET_MINUTES,
    });

    // Auto-warn the requester for inactivity
    try {
      const result = addWarning(
        req.buyer_id,
        `Ticket auto-closed: ${STALE_TICKET_MINUTES} minutes of inactivity (${req.game_name})`,
        clientRef.user.id
      );
      log(`Warning issued to ${req.buyer_id} (${result.totalWarnings}/3)${result.autoBlacklisted ? ' — AUTO-BLACKLISTED' : ''}`);
      const user = await clientRef.users.fetch(req.buyer_id).catch(() => null);
      if (user) {
        const warnMsg = result.autoBlacklisted
          ? `⛔ You have been **auto-blacklisted** (${result.totalWarnings}/3 warnings). Your ticket for **${req.game_name}** was closed due to inactivity.`
          : `⚠️ You received a **warning** (${result.totalWarnings}/3) because your ticket for **${req.game_name}** was auto-closed after ${STALE_TICKET_MINUTES} minutes of inactivity. At 3 warnings you will be blacklisted.`;
        await user.send(warnMsg).catch(() => {});
      }
    } catch (e) {
      log('Auto-warn failed:', e?.message);
    }
  }
}
