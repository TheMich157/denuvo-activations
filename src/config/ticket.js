

const VERIFY_DEADLINE_MINUTES = parseInt(process.env.TICKET_VERIFY_DEADLINE_MINUTES ?? '5', 10) || 5;
const COOLDOWN_HOURS = parseInt(process.env.TICKET_AUTOCLOSE_COOLDOWN_HOURS ?? '24', 10) || 24;
const CHECK_INTERVAL_MS = parseInt(process.env.TICKET_AUTOCLOSE_CHECK_INTERVAL_MS ?? '60000', 10) || 60_000;

export const ticketConfig = {
  verifyDeadlineMinutes: VERIFY_DEADLINE_MINUTES,
  autoCloseCooldownHours: COOLDOWN_HOURS,
  checkIntervalMs: CHECK_INTERVAL_MS,
};
