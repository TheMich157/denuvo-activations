import { readFileSync, existsSync, watchFile } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isActivator } from './activator.js';
import { ACTIVATOR_COMMANDS, WHITELISTED_COMMANDS, STAFF_COMMANDS, PUBLIC_COMMANDS } from '../config/commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const whitelistPath = join(__dirname, '../../whitelist.json');

let cachedIds = null;

function loadWhitelist() {
  if (cachedIds !== null) return cachedIds;
  if (!existsSync(whitelistPath)) {
    cachedIds = new Set();
    return cachedIds;
  }
  try {
    const data = JSON.parse(readFileSync(whitelistPath, 'utf8'));
    cachedIds = new Set(Array.isArray(data) ? data.map(String) : []);
  } catch {
    cachedIds = new Set();
  }
  return cachedIds;
}

// Auto-invalidate cache when whitelist.json changes on disk
try {
  if (existsSync(whitelistPath)) {
    watchFile(whitelistPath, { interval: 5000 }, () => {
      cachedIds = null;
      console.log('[Whitelist] File changed — cache invalidated');
    });
  }
} catch {}

export function isWhitelisted(userId) {
  return loadWhitelist().has(String(userId));
}

/**
 * Check if user can run a slash command.
 * @param {string} userId
 * @param {string} commandName
 * @param {import('discord.js').GuildMember | null} member - Guild member (for activator role check)
 * @returns {{ allowed: boolean; reason?: string }}
 */
export function canUseCommand(userId, commandName, member) {
  // Public commands — anyone can use
  if (PUBLIC_COMMANDS.includes(commandName)) {
    return { allowed: true };
  }

  // Activator-only commands — requires Activator role
  if (ACTIVATOR_COMMANDS.includes(commandName)) {
    return isActivator(member)
      ? { allowed: true }
      : { allowed: false, reason: 'Only activators can use this command.' };
  }

  // Whitelisted-only commands — requires whitelist.json
  if (WHITELISTED_COMMANDS.includes(commandName)) {
    return isWhitelisted(userId)
      ? { allowed: true }
      : { allowed: false, reason: 'Only whitelisted staff can use this command.' };
  }

  // Staff commands — activator OR whitelisted
  if (STAFF_COMMANDS.includes(commandName)) {
    return (isActivator(member) || isWhitelisted(userId))
      ? { allowed: true }
      : { allowed: false, reason: 'Only staff can use this command.' };
  }

  // Fallback: require whitelisted
  return isWhitelisted(userId)
    ? { allowed: true }
    : { allowed: false, reason: 'You are not authorized to use this command.' };
}

export function invalidateWhitelistCache() {
  cachedIds = null;
}
