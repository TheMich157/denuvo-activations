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
      'input[name="appid"], input[name="gameid"], input[name="app_id"], input[id*="game"], input[id*="appid"], input[id*="app_id"], input[placeholder*="App"], input[placeholder*="appid"], input[placeholder*="ID"]',
    codeOutput:
      process.env.DRM_SELECTOR_CODE || 'input[readonly], textarea[readonly], .auth-code, [class*="code"], [class*="result"], [id*="code"], [id*="result"], pre, code',
    // Navigation links to find the authorization/generate page
    navLinks:
      process.env.DRM_SELECTOR_NAV ||
      'a[href*="generat"], a[href*="extract"], a[href*="authoriz"], a[href*="token"], a[href*="ticket"], nav a, .nav a, .sidebar a, .menu a',
    // Fill info / auto-fill button
    fillButton:
      process.env.DRM_SELECTOR_FILL ||
      'button:contains("Fill"), button:contains("填"), input[value*="Fill"], input[value*="填"], a:contains("Fill"), a:contains("填"), button:contains("Auto"), button:contains("自动")',
    // Submit / generate button
    submitButton:
      process.env.DRM_SELECTOR_SUBMIT ||
      'button:contains("Submit"), button:contains("Generate"), button:contains("提交"), button:contains("生成"), button:contains("授权"), input[type="submit"], button[type="submit"]',
  },

  // Known page paths to try when navigation discovery fails
  // Ordered by most likely based on the drm.steam.run flow
  knownPaths: [
    '/generate', '/generate.php',
    '/authorization', '/authorization.php',
    '/extract', '/extract.php',
    '/auth/generate', '/auth/generate.php',
    '/auth/extract', '/auth/extract.php',
    '/auth/authorization', '/auth/authorization.php',
    '/token', '/token.php', '/auth/token', '/auth/token.php',
    '/ticket', '/ticket.php', '/auth/ticket', '/auth/ticket.php',
    '/dashboard', '/dashboard.php', '/index.php',
    '/home', '/home.php',
  ],
};
