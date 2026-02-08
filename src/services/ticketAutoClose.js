import { getUnverifiedPendingOlderThan, getUnclaimedPendingOlderThan } from './requests.js';
import { cancelRequest, setCooldown } from './requests.js';
import { clearState } from './screenshotVerify/state.js';
import { ticketConfig } from '../config/ticket.js';
import { logTicketAutoClosed, logStaleTicketClosed } from './activationLog.js';
import { debug } from '../utils/debug.js';
import { getCooldownHours } from '../utils/games.js';
import { db } from '../db/index.js';
import { saveTranscript } from './transcript.js';
import { addWarning } from './warnings.js';
import { removeStaleUnverifiedClaims, getPreorderSpots, formatSpotsText, buildPreorderEmbed } from './preorder.js';
import { config } from '../config.js';
import { EmbedBuilder } from 'discord.js';
import { getActivatorsForGame } from './activators.js';
import { isAway } from './activatorStatus.js';

const log = debug('ticketAutoClose');

let clientRef = null;
let intervalId = null;

const STALE_TICKET_MINUTES = 120; // 2 hours idle for in_progress tickets
const STALE_CLAIM_HOURS = 48;     // unverified preorder claims released after 48h
const ESCALATION_MINUTES = 10;    // ping again if unclaimed after 10 min
const escalatedTickets = new Set(); // track already-escalated request IDs

export function startTicketAutoClose(client) {
  clientRef = client;
  if (intervalId) clearInterval(intervalId);
  const { checkIntervalMs, verifyDeadlineMinutes } = ticketConfig;
  intervalId = setInterval(() => {
    runCheck(verifyDeadlineMinutes).catch((err) => log('Check failed:', err?.message));
    runStaleCheck().catch((err) => log('Stale check failed:', err?.message));
    runStaleClaimCheck().catch((err) => log('Stale claim check failed:', err?.message));
    runEscalationCheck().catch((err) => log('Escalation check failed:', err?.message));
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
      await saveTranscript(clientRef, req.ticket_channel_id, req.id, 'auto_closed_unverified').catch((err) =>
        log('Transcript save failed:', err?.message)
      );
    }
    cancelRequest(req.id);
    // No cooldown — ticket closed before any code was generated
    clearState(req.ticket_channel_id);

    // Issue warning on every auto-close for unverified screenshot
    let warnText = '';
    try {
      const result = addWarning(
        req.buyer_id,
        `Ticket auto-closed: screenshot not verified within ${deadlineMinutes} minutes (${req.game_name})`,
        clientRef.user.id
      );
      log(`Warning issued to ${req.buyer_id} (${result.totalWarnings}/3)${result.autoBlacklisted ? ' — AUTO-BLACKLISTED' : ''}`);
      if (result.autoBlacklisted) {
        warnText = `\n⛔ You have been **auto-blacklisted** (${result.totalWarnings}/3 warnings) due to repeated inactivity.`;
      } else {
        warnText = `\n⚠️ **Warning issued** (${result.totalWarnings}/3). At 3 warnings you will be blacklisted.`;
      }
    } catch (e) {
      log('Auto-warn failed:', e?.message);
    }

    const msg = `⏱️ <@${req.buyer_id}> Your **${req.game_name}** ticket was auto-closed: screenshot was not verified within **${deadlineMinutes} minutes**.${warnText}`;
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
    // Delete the ticket channel
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

/**
 * Close stale in_progress tickets (no activity for STALE_TICKET_MINUTES).
 */
async function runStaleCheck() {
  if (!clientRef) return;
  const stale = db.prepare(`
    SELECT id, buyer_id, issuer_id, game_app_id, game_name, ticket_channel_id
    FROM requests
    WHERE status = 'in_progress'
      AND COALESCE(no_auto_close, 0) = 0
      AND datetime(COALESCE(updated_at, created_at)) < datetime('now', '-' || ? || ' minutes')
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
      await saveTranscript(clientRef, req.ticket_channel_id, req.id, 'auto_closed_stale').catch((err) =>
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

    // Notify both buyer and activator — don't auto-warn for stale tickets
    // since the activator could be at fault for not completing the ticket
    if (req.issuer_id) {
      try {
        const issuer = await clientRef.users.fetch(req.issuer_id).catch(() => null);
        if (issuer) {
          await issuer.send(
            `ℹ️ Ticket **${req.game_name}** (assigned to you) was auto-closed after **${STALE_TICKET_MINUTES} minutes** of inactivity.`
          ).catch(() => {});
        }
      } catch {}
    }

    try {
      const user = await clientRef.users.fetch(req.buyer_id).catch(() => null);
      if (user) {
        await user.send(
          `ℹ️ Your ticket for **${req.game_name}** was auto-closed after **${STALE_TICKET_MINUTES} minutes** of inactivity. You can open a new ticket if you still need an activation.`
        ).catch(() => {});
      }
    } catch (e) {
      log('Stale ticket DM failed:', e?.message);
    }
  }
}

/**
 * Release stale unverified preorder claims after STALE_CLAIM_HOURS.
 * DMs the user and updates the forum post.
 */
async function runStaleClaimCheck() {
  if (!clientRef) return;
  const { removed, claims } = removeStaleUnverifiedClaims(STALE_CLAIM_HOURS);
  if (removed === 0) return;

  log(`Released ${removed} stale unverified preorder claim(s)`);

  // Group by preorder to batch forum post updates
  const byPreorder = new Map();
  for (const claim of claims) {
    if (!byPreorder.has(claim.preorder_id)) byPreorder.set(claim.preorder_id, []);
    byPreorder.get(claim.preorder_id).push(claim);
  }

  // DM each user
  for (const claim of claims) {
    try {
      const user = await clientRef.users.fetch(claim.user_id).catch(() => null);
      if (user) {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xfee75c)
              .setTitle('⏰ Preorder Spot Released')
              .setDescription(
                [
                  `Your reserved spot on preorder **#${claim.preorder_id}** (${claim.game_name}) has been **released** because you didn't verify your donation within **${STALE_CLAIM_HOURS} hours**.`,
                  '',
                  'If you still want this preorder, you can reserve a new spot and post your Ko-fi receipt to verify.',
                ].join('\n')
              )
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    } catch {}
  }

  // Update forum posts for affected preorders
  for (const [preorderId, preorderClaims] of byPreorder) {
    const threadId = preorderClaims[0]?.thread_id;
    if (!threadId) continue;
    try {
      const thread = await clientRef.channels.fetch(threadId).catch(() => null);
      if (!thread) continue;

      // Update starter message embed
      const starterMessage = await thread.fetchStarterMessage().catch(() => null);
      if (starterMessage) {
        const { getPreorder } = await import('./preorder.js');
        const preorder = getPreorder(preorderId);
        if (preorder) {
          const updatedEmbed = buildPreorderEmbed({
            preorder, preorderId,
            kofiUrl: config.kofiUrl,
            tipChannelId: config.tipVerifyChannelId,
          });
          await starterMessage.edit({ embeds: [updatedEmbed] }).catch(() => {});
        }
      }

      // Notify in thread
      const spots = getPreorderSpots(preorderId);
      const releasedUsers = preorderClaims.map((c) => `<@${c.user_id}>`).join(', ');
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle('⏰ Stale Spots Released')
            .setDescription(`**${preorderClaims.length}** unverified spot(s) released after ${STALE_CLAIM_HOURS}h: ${releasedUsers}\n🎟️ ${formatSpotsText(spots)}`)
            .setTimestamp(),
        ],
      }).catch(() => {});
    } catch {}
  }
}

/**
 * Escalation: if a ticket has been pending (unclaimed) for ESCALATION_MINUTES,
 * ping all available activators again + the activator role as a reminder.
 */
async function runEscalationCheck() {
  if (!clientRef) return;
  const unclaimed = getUnclaimedPendingOlderThan(ESCALATION_MINUTES);
  for (const req of unclaimed) {
    if (escalatedTickets.has(req.id)) continue;
    if (!req.ticket_channel_id) continue;
    escalatedTickets.add(req.id);

    const channel = await clientRef.channels.fetch(req.ticket_channel_id).catch(() => null);
    if (!channel?.send) continue;

    const activators = getActivatorsForGame(req.game_app_id);
    const available = activators.filter((a) => !isAway(a.activator_id));
    const mentions = available.map((a) => `<@${a.activator_id}>`).join(' ');
    const rolePing = config.activatorRoleId ? `<@&${config.activatorRoleId}>` : '';

    const elapsed = Math.round((Date.now() - new Date(req.created_at).getTime()) / 60000);

    await channel.send({
      content: [
        `⚠️ **Escalation** — This ticket has been unclaimed for **${elapsed} minutes**.`,
        '',
        mentions || rolePing || '*(no activators available)*',
        rolePing && mentions ? rolePing : '',
        '',
        `Please claim this request or it will be auto-closed.`,
      ].filter(Boolean).join('\n'),
      allowedMentions: {
        users: available.map((a) => a.activator_id),
        roles: config.activatorRoleId ? [config.activatorRoleId] : [],
      },
    }).catch((err) => log('Escalation ping failed:', err?.message));

    log(`Escalated ticket ${req.id} (${req.game_name}) after ${elapsed} min`);
  }

  // Clean up escalated set for tickets that are no longer pending
  for (const id of escalatedTickets) {
    const still = db.prepare("SELECT id FROM requests WHERE id = ? AND status = 'pending'").get(id);
    if (!still) escalatedTickets.delete(id);
  }
}
