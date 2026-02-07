const baseUrl = (process.env.DRM_BASE_URL || 'https://drm.steam.run').replace(/\/+$/, '');
const timeoutMs = Math.max(10000, Math.min(120000, parseInt(process.env.DRM_TIMEOUT_MS || '60000', 10) || 60000));

const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const drmConfig = {
  baseUrl,
  timeoutMs,
  userAgent: process.env.DRM_USER_AGENT || defaultUserAgent,

  selectors: {
    loginLink: process.env.DRM_SELECTOR_LOGIN || 'a[href*="steam_login"], a[href*="steam"]',
    gameIdInput:
      process.env.DRM_SELECTOR_GAME_ID ||
      'input[name="appid"], input[name="gameid"], input[id*="game"], input[placeholder*="App"]',
    codeOutput:
      process.env.DRM_SELECTOR_CODE || 'input[readonly], .auth-code, [class*="code"]',
  },
};
