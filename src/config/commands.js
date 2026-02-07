/** Commands that require the Activator role */
export const ACTIVATOR_COMMANDS = ['add', 'remove', 'note'];

/** Commands that require whitelist.json */
export const WHITELISTED_COMMANDS = [
  'stock', 'removestock', 'bulkstock', 'addpoints',
  'ticketpanel', 'closepanel', 'closealltickets', 'refreshtickets', 'reloadgames', 'blacklist',
  'preorder', 'tier', 'warn', 'giveaway', 'bulkcode',
  'audit', 'info', 'schedule', 'skiptoken', 'transcript',
];

/** Commands that require either Activator role OR whitelist */
export const STAFF_COMMANDS = ['away', 'waitlist'];

/** Commands anyone in the server can use (no restrictions) */
export const PUBLIC_COMMANDS = [
  'profile', 'stats', 'leaderboard', 'shop',
  'pricegame', 'settings', 'transfer', 'appeal', 'vote', 'level',
  'daily', 'cooldown', 'history', 'mywaitlist',
];
