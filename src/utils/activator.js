import { config } from '../config.js';

export function isActivator(member) {
  if (!member?.roles?.cache) return false;
  return config.activatorRoleId && member.roles.cache.has(config.activatorRoleId);
}
