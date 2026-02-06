/**
 * Debug logger. Enable with DEBUG=1 or DEBUG=denuvo:* in env.
 * Usage: debug('db')('message') or debug('interaction')('handler', data)
 */

const enabled = process.env.DEBUG && /^(1|true|denuvo|denuvo:\*|denuvo:.*)$/i.test(process.env.DEBUG);

function matchesScope(scope) {
  if (!enabled) return false;
  const d = process.env.DEBUG.toLowerCase();
  if (d === '1' || d === 'true' || d === 'denuvo' || d === 'denuvo:*') return true;
  return d.includes(`denuvo:${scope}`) || d.includes('denuvo:*');
}

export function debug(scope) {
  return (...args) => {
    if (matchesScope(scope)) {
      const prefix = `[${new Date().toISOString()}] [${scope}]`;
      console.log(prefix, ...args);
    }
  };
}

export const scopes = {
  db: 'db',
  config: 'config',
  startup: 'startup',
  interaction: 'interaction',
  request: 'request',
  save: 'save',
};
