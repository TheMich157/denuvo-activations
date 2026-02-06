/**
 * Auto-closes tickets where the screenshot was not verified within 5 minutes.
 * Applies 24h cooldown to the user for that game.
 */

import { getUnverifiedPendingOlderThan } from './requests.js';
import { cancelRequest, setCooldown } from './requests.js';
import { clearState } from './screenshotVerify/state.js';

const VERIFY_DEADLINE_MINUTES = 5;
const COOLDOWN_HOURS = 24;
const CHECK_INTERVAL_MS = 60_000;

let clientRef = null;
let intervalId = null;

export function startTicketAutoClose(client) {
  clientRef = client;
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(runCheck, CHECK_INTERVAL_MS);
}

export function stopTicketAutoClose() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  clientRef = null;
}

async function runCheck() {
  if (!clientRef) return;
  const toClose = getUnverifiedPendingOlderThan(VERIFY_DEADLINE_MINUTES);
  for (const req of toClose) {
    cancelRequest(req.id);
    setCooldown(req.buyer_id, req.game_app_id, COOLDOWN_HOURS);
    clearState(req.ticket_channel_id);
    const msg = `⏱️ <@${req.buyer_id}> Your **${req.game_name}** ticket was closed: screenshot was not verified within ${VERIFY_DEADLINE_MINUTES} minutes. You can request this game again in 24 hours.`;
    const channel = await clientRef.channels.fetch(req.ticket_channel_id).catch(() => null);
    if (channel?.send) {
      await channel.send({ content: msg, allowedMentions: { users: [req.buyer_id] } }).catch(() => null);
    }
    try {
      const user = await clientRef.users.fetch(req.buyer_id).catch(() => null);
      if (user) await user.send(msg.replace(`<@${req.buyer_id}> `, '')).catch(() => null);
    } catch { /* ignore */ }
    if (channel?.deletable) {
      await channel.delete().catch(() => null);
    }
  }
}
