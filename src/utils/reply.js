import { MessageFlags } from 'discord.js';
import { sanitizeError } from './validate.js';

/** Options for ephemeral (only-you-see) slash command replies. */
export const ephemeralReply = { flags: MessageFlags.Ephemeral };

/**
 * Build an ephemeral reply with optional error sanitization.
 * @param {string} content - Message text
 * @param {Error} [err] - If provided, content is ignored and sanitized error message is used
 */
export function ephemeralContent(content, err) {
  const text = err ? sanitizeError(err) : content;
  return { content: text || 'Something went wrong.', flags: MessageFlags.Ephemeral };
}
