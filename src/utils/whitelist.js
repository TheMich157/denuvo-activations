import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isActivator } from './activator.js';
import { ACTIVATOR_COMMANDS } from '../config/commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Commands only activators can use; whitelist users get profile, request, pricegame, shop, etc. */
const ACTIVATOR_ONLY_COMMANDS = ACTIVATOR_COMMANDS;

let cachedIds = null;

function loadWhitelist() {
  if (cachedIds !== null) return cachedIds;
  const path = join(__dirname, '../../whitelist.json');
  if (!existsSync(path)) {
    cachedIds = new Set();
    return cachedIds;
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    cachedIds = new Set(Array.isArray(data) ? data.map(String) : []);
  } catch {
    cachedIds = new Set();
  }
  return cachedIds;
}

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
  const activator = isActivator(member);

  if (ACTIVATOR_ONLY_COMMANDS.includes(commandName)) {
    return activator
      ? { allowed: true }
      : { allowed: false, reason: 'Only activators can use this command.' };
  }

  if (!isWhitelisted(userId)) {
    return { allowed: false, reason: 'You are not whitelisted to use commands.' };
  }
  return { allowed: true };
}

export function invalidateWhitelistCache() {
  cachedIds = null;
}
