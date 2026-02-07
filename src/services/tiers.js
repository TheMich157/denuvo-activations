import { db, scheduleSave } from '../db/index.js';
import { config } from '../config.js';

/**
 * Tier definitions — Low, Mid, High.
 * Benefits increase with tier level.
 */
export const TIERS = {
  none:  { level: 0, label: 'None',      emoji: '',   color: 0x95a5a6, cooldownReduction: 0,   priorityBonus: 0,  preorderDiscount: 0,    waitlistPriority: false },
  low:   { level: 1, label: 'Low Tier',   emoji: '🥉', color: 0xcd7f32, cooldownReduction: 0.25, priorityBonus: 5,  preorderDiscount: 0,    waitlistPriority: true  },
  mid:   { level: 2, label: 'Mid Tier',   emoji: '🥈', color: 0xc0c0c0, cooldownReduction: 0.50, priorityBonus: 10, preorderDiscount: 0.10, waitlistPriority: true  },
  high:  { level: 3, label: 'High Tier',  emoji: '🥇', color: 0xffd700, cooldownReduction: 0.75, priorityBonus: 20, preorderDiscount: 0.20, waitlistPriority: true  },
};

/** Map tier names to their Discord role IDs. */
export function getTierRoleId(tier) {
  if (tier === 'low') return config.lowTierRoleId;
  if (tier === 'mid') return config.midTierRoleId;
  if (tier === 'high') return config.highTierRoleId;
  return null;
}

/** Get all tier role IDs. */
export function getAllTierRoleIds() {
  return [config.lowTierRoleId, config.midTierRoleId, config.highTierRoleId].filter(Boolean);
}

/** Detect tier from a member's Discord roles. */
export function getTierFromRoles(member) {
  if (!member?.roles?.cache) return 'none';
  if (config.highTierRoleId && member.roles.cache.has(config.highTierRoleId)) return 'high';
  if (config.midTierRoleId && member.roles.cache.has(config.midTierRoleId)) return 'mid';
  if (config.lowTierRoleId && member.roles.cache.has(config.lowTierRoleId)) return 'low';
  return 'none';
}

/**
 * Assign the correct tier Discord role to a member (remove others).
 */
export async function syncTierRole(member, tier) {
  if (!member?.roles) return;
  const allRoleIds = getAllTierRoleIds();
  const targetRoleId = getTierRoleId(tier);

  // Remove all other tier roles
  for (const roleId of allRoleIds) {
    if (roleId && roleId !== targetRoleId && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId).catch(() => {});
    }
  }

  // Add the target tier role
  if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
    await member.roles.add(targetRoleId).catch(() => {});
  }
}

/**
 * Set a user's tier.
 */
export function setUserTier(userId, tier) {
  if (!TIERS[tier]) throw new Error(`Invalid tier: ${tier}`);
  db.prepare(`
    INSERT INTO user_tiers (user_id, tier) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET tier = ?, updated_at = datetime('now')
  `).run(userId, tier, tier);
  scheduleSave();
}

/**
 * Get a user's tier.
 */
export function getUserTier(userId) {
  const row = db.prepare('SELECT tier FROM user_tiers WHERE user_id = ?').get(userId);
  return row?.tier || 'none';
}

/**
 * Get tier info for a user (full definition).
 */
export function getUserTierInfo(userId) {
  const tier = getUserTier(userId);
  return { tier, ...TIERS[tier] };
}

/**
 * Remove a user's tier.
 */
export function removeUserTier(userId) {
  db.prepare('DELETE FROM user_tiers WHERE user_id = ?').run(userId);
  scheduleSave();
}

/**
 * Get all users with a specific tier.
 */
export function getUsersByTier(tier) {
  return db.prepare('SELECT * FROM user_tiers WHERE tier = ?').all(tier);
}

/**
 * Get all tiered users.
 */
export function getAllTieredUsers() {
  return db.prepare('SELECT * FROM user_tiers ORDER BY tier DESC').all();
}

/**
 * Get tier label with emoji.
 */
export function getTierLabel(userId) {
  const info = getUserTierInfo(userId);
  if (info.tier === 'none') return '';
  return `${info.emoji} ${info.label}`;
}

/**
 * Calculate adjusted cooldown hours based on tier.
 */
export function getAdjustedCooldown(baseCooldownHours, userId) {
  const info = getUserTierInfo(userId);
  const reduction = info.cooldownReduction;
  return Math.max(1, Math.round(baseCooldownHours * (1 - reduction)));
}

/**
 * Calculate preorder price after tier discount.
 */
export function getDiscountedPrice(basePrice, userId) {
  const info = getUserTierInfo(userId);
  return Math.max(1, basePrice * (1 - info.preorderDiscount));
}
