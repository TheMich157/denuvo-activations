import { drmConfig } from '../config/drm.config.js';
import { debug } from '../utils/debug.js';

const log = debug('drm');

const MIN_CODE_LENGTH = 10;
const CODE_FALLBACK_REGEX = /[A-Za-z0-9_-]{20,}/;

export async function isAutomatedAvailable() {
  try {
    await import('playwright');
    return true;
  } catch {
    return false;
  }
}

function validateInputs(gameAppId, credentials) {
  const appId = Number(gameAppId);
  if (!Number.isInteger(appId) || appId < 1) {
    throw new Error('Invalid game App ID.');
  }
  if (!credentials || typeof credentials !== 'object') {
    throw new Error('Credentials object is required.');
  }
  const user = credentials.username;
  const pass = credentials.password;
  if (typeof user !== 'string' || !user.trim()) {
    throw new Error('Steam username is required.');
  }
  if (typeof pass !== 'string' || !pass) {
    throw new Error('Steam password is required.');
  }
  return { gameAppId: appId, username: user.trim(), password: pass };
}

/**
 * Extract auth code from the page: try code output element first, then body fallback.
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
async function extractCodeFromPage(page) {
  const codeEl = page.locator(drmConfig.selectors.codeOutput).first();
  await codeEl.waitFor({ state: 'visible', timeout: drmConfig.codeOutputTimeoutMs });

  let raw = await codeEl.inputValue().catch(() => null);
  if (raw === null) {
    raw = await codeEl.textContent().catch(() => null);
  }
  const trimmed = String(raw ?? '').trim();
  if (trimmed.length >= MIN_CODE_LENGTH) return trimmed;

  const body = await page.locator('body').textContent().catch(() => '');
  const match = body.match(CODE_FALLBACK_REGEX);
  return match ? match[0] : null;
}

/**
 * Generate an auth code via drm.steam.run automation.
 * @param {number} gameAppId - Steam app ID
 * @param {{ username: string; password: string }} credentials - Steam login
 * @param {string | null} twoFactorCode - Current 2FA code (Steam Guard)
 * @returns {Promise<string>} - Authorization code
 */
export async function generateAuthCode(gameAppId, credentials, twoFactorCode = null) {
  const available = await isAutomatedAvailable();
  if (!available) {
    throw new Error(
      'Playwright not installed. Run: npm install playwright. ' +
      'Until then, perform the flow manually at drm.steam.run and paste the code via "Done".'
    );
  }

  const { gameAppId: appId, username, password } = validateInputs(gameAppId, credentials);
  const creds = { username, password };

  const { chromium } = await import('playwright');
  const launchOptions = {
    headless: drmConfig.headless !== false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (drmConfig.browserArgs?.length) {
    launchOptions.args.push(...drmConfig.browserArgs);
  }

  const browser = await chromium.launch(launchOptions);

  const closeBrowser = () => {
    browser.close().catch((err) => log('Browser close error:', err?.message));
  };

  try {
    const context = await browser.newContext({
      userAgent: drmConfig.userAgent,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      locale: 'en-US',
    });

    const page = await context.newPage();
    page.setDefaultTimeout(drmConfig.timeoutMs);

    log('Navigating to', drmConfig.baseUrl);
    await page.goto(drmConfig.baseUrl, { waitUntil: 'domcontentloaded' });

    const loginLink = page.locator(drmConfig.selectors.loginLink).first();
    await loginLink.click({ timeout: 10000 });
    await page.waitForURL(
      (url) =>
        url.hostname.includes('steampowered') ||
        url.hostname.includes('steamcommunity') ||
        url.pathname.includes('steam_login'),
      { timeout: 15000 }
    );

    await page.locator(drmConfig.selectors.steamUsername).first().fill(creds.username);
    await page.locator(drmConfig.selectors.steamPassword).first().fill(creds.password);
    await page.locator(drmConfig.selectors.steamSubmit).first().click();
    await page.waitForLoadState('networkidle');

    const twoFactorInput = page.locator(drmConfig.selectors.twoFactorInput);
    const twoFactorVisible = await twoFactorInput.first().isVisible().catch(() => false);

    if (twoFactorVisible && twoFactorCode) {
      await twoFactorInput.first().fill(String(twoFactorCode).trim());
      await page.locator(drmConfig.selectors.steamSubmit).first().click();
      await page.waitForLoadState('networkidle');
    } else if (twoFactorVisible && !twoFactorCode) {
      throw new Error('Steam Guard 2FA required. Provide the current authenticator or email code.');
    }

    const baseHost = new URL(drmConfig.baseUrl).hostname;
    await page.waitForURL(
      (url) => url.hostname.includes(baseHost) || url.pathname.includes('drm'),
      { timeout: 20000 }
    );

    log('Filling game ID and extracting', appId);
    await page.locator(drmConfig.selectors.gameIdInput).first().fill(String(appId));
    await page.locator(drmConfig.selectors.extractButton).first().click();
    await page.waitForLoadState('networkidle');

    const fillBtn = page.locator(drmConfig.selectors.fillInfoButton).first();
    if (await fillBtn.isVisible().catch(() => false)) {
      await fillBtn.click();
      await page.waitForLoadState('networkidle');
    }

    await page.locator(drmConfig.selectors.submitButton).first().click();
    await page.waitForLoadState('networkidle');

    const code = await extractCodeFromPage(page);
    if (!code || code.length < MIN_CODE_LENGTH) {
      throw new Error('Could not extract authorization code. The site may have changed; check drm.config.js selectors.');
    }

    log('Code extracted successfully');
    return code;
  } catch (err) {
    const msg = err?.message || 'Unknown error';
    if (msg.includes('Steam Guard') || msg.includes('2FA')) throw err;
    if (msg.includes('timeout') || msg.includes('Timeout')) {
      throw new Error('drm.steam.run timed out. Check credentials and 2FA, then try again.');
    }
    if (msg.includes('Could not extract')) throw err;
    throw new Error(`drm.steam.run automation failed. ${msg}`);
  } finally {
    closeBrowser();
  }
}
