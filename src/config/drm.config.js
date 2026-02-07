/**
 * DRM (drm.steam.run) automation config.
 * Env: DRM_BASE_URL, DRM_TIMEOUT_MS, DRM_HEADLESS, DRM_CODE_OUTPUT_TIMEOUT_MS,
 *      DRM_SELECTOR_* for each selector (see below).
 */
const baseUrl = (process.env.DRM_BASE_URL || 'https://drm.steam.run').replace(/\/+$/, '');
const timeoutMs = Math.max(10000, Math.min(120000, parseInt(process.env.DRM_TIMEOUT_MS || '60000', 10) || 60000));
const codeOutputTimeoutMs = Math.max(5000, Math.min(30000, parseInt(process.env.DRM_CODE_OUTPUT_TIMEOUT_MS || '15000', 10) || 15000));
const headless = process.env.DRM_HEADLESS !== '0' && process.env.DRM_HEADLESS !== 'false';
const browserArgs = process.env.DRM_BROWSER_ARGS ? process.env.DRM_BROWSER_ARGS.split(/\s+/).filter(Boolean) : [];

const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const drmConfig = {
  baseUrl,
  timeoutMs,
  codeOutputTimeoutMs,
  headless,
  browserArgs,
  userAgent: process.env.DRM_USER_AGENT || defaultUserAgent,

  selectors: {
    loginLink: process.env.DRM_SELECTOR_LOGIN || 'a[href*="steam_login"], a[href*="steam"]',
    steamUsername: process.env.DRM_SELECTOR_USERNAME || 'input[name="username"], input#input_username',
    steamPassword: process.env.DRM_SELECTOR_PASSWORD || 'input[name="password"], input#input_password',
    steamSubmit: process.env.DRM_SELECTOR_STEAM_SUBMIT || 'button[type="submit"], input[type="submit"]',
    twoFactorInput: process.env.DRM_SELECTOR_2FA || 'input[name="twofactorcode"], input[name="authcode"]',
    gameIdInput:
      process.env.DRM_SELECTOR_GAME_ID ||
      'input[name="appid"], input[name="gameid"], input[id*="game"], input[placeholder*="App"]',
    extractButton:
      process.env.DRM_SELECTOR_EXTRACT || 'button:has-text("Extract"), button:has-text("提取")',
    fillInfoButton:
      process.env.DRM_SELECTOR_FILL ||
      'button:has-text("Fill"), button:has-text("填充"), button:has-text("Fill Info")',
    submitButton:
      process.env.DRM_SELECTOR_SUBMIT ||
      'button:has-text("Submit"), button:has-text("提交"), button:has-text("Generate")',
    codeOutput:
      process.env.DRM_SELECTOR_CODE || 'input[readonly], .auth-code, [class*="code"]',
  },
};
