/**
 * drm.steam.run selector configuration.
 * Override via environment variables if the site structure changes.
 *
 * Format: CSS selector or "text:Button Text" for text-based lookup.
 */
export const drmConfig = {
  baseUrl: process.env.DRM_BASE_URL || 'https://drm.steam.run',
  timeoutMs: parseInt(process.env.DRM_TIMEOUT_MS || '60000', 10),

  selectors: {
    loginLink: process.env.DRM_SELECTOR_LOGIN || 'a[href*="steam_login"], a[href*="steam"]',
    steamUsername: process.env.DRM_SELECTOR_USERNAME || 'input[name="username"], input#input_username',
    steamPassword: process.env.DRM_SELECTOR_PASSWORD || 'input[name="password"], input#input_password',
    steamSubmit: process.env.DRM_SELECTOR_STEAM_SUBMIT || 'button[type="submit"], input[type="submit"]',
    twoFactorInput: process.env.DRM_SELECTOR_2FA || 'input[name="twofactorcode"], input[name="authcode"]',
    gameIdInput: process.env.DRM_SELECTOR_GAME_ID || 'input[name="appid"], input[name="gameid"], input[id*="game"], input[placeholder*="App"]',
    extractButton: process.env.DRM_SELECTOR_EXTRACT || 'button:has-text("Extract"), button:has-text("提取")',
    fillInfoButton: process.env.DRM_SELECTOR_FILL || 'button:has-text("Fill"), button:has-text("填充"), button:has-text("Fill Info")',
    submitButton: process.env.DRM_SELECTOR_SUBMIT || 'button:has-text("Submit"), button:has-text("提交"), button:has-text("Generate")',
    codeOutput: process.env.DRM_SELECTOR_CODE || 'input[readonly], .auth-code, [class*="code"]',
  },
};
