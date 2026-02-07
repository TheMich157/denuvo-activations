import { getUnverifiedPendingOlderThan } from './requests.js';
import { cancelRequest, setCooldown } from './requests.js';
import { clearState } from './screenshotVerify/state.js';
import { ticketConfig } from '../config/ticket.js';
import { logTicketAutoClosed } from './activationLog.js';
import { debug } from '../utils/debug.js';

const log = debug('ticketAutoClose');

let clientRef = null;
let intervalId = null;

export function startTicketAutoClose(client) {
  clientRef = client;
  if (intervalId) clearInterval(intervalId);
  const { checkIntervalMs, verifyDeadlineMinutes, autoCloseCooldownHours } = ticketConfig;
  intervalId = setInterval(runCheck, checkIntervalMs);
  runCheck(verifyDeadlineMinutes, autoCloseCooldownHours).catch((err) => {
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

async function runCheck(deadlineMinutes = ticketConfig.verifyDeadlineMinutes, cooldownHours = ticketConfig.autoCloseCooldownHours) {
  if (!clientRef) return;
  const toClose = getUnverifiedPendingOlderThan(deadlineMinutes);
  for (const req of toClose) {
    cancelRequest(req.id);
    setCooldown(req.buyer_id, req.game_app_id, cooldownHours);
    clearState(req.ticket_channel_id);
    const msg = `⏱️ <@${req.buyer_id}> Your **${req.game_name}** ticket was closed: screenshot was not verified within ${deadlineMinutes} minutes. You can request this game again in 24 hours.`;
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
  }
}
