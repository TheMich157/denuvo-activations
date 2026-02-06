/**
 * drm.steam.run integration.
 *
 * Workflow:
 * 1. Navigate to drm.steam.run
 * 2. Click Steam login → Steam OAuth page
 * 3. Enter username/password, handle 2FA (Mobile Authenticator / email code)
 * 4. Redirect back to drm.steam.run (logged in)
 * 5. Extract Authorizations → input game App ID
 * 6. Fill Info → Submit → get authorization code
 */

import { drmConfig } from '../config/drm.config.js';

/**
 * Check if Playwright is available.
 */
export async function isAutomatedAvailable() {
  try {
    await import('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate authorization code via drm.steam.run.
 *
 * @param {number} gameAppId - Steam App ID
 * @param {{ username: string, password: string }} credentials - Steam login
 * @param {string} [twoFactorCode] - Steam Guard / Mobile Authenticator code
 * @returns {Promise<string>} The generated authorization code
 */
export async function generateAuthCode(gameAppId, credentials, twoFactorCode = null) {
  const available = await isAutomatedAvailable();
  if (!available) {
    throw new Error(
      'Playwright not installed. Run: npm install playwright. ' +
      'Until then, issuers perform the flow manually at drm.steam.run and paste the code via "Mark Done".'
    );
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    locale: 'en-US',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(drmConfig.timeoutMs);

  try {
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

    await page.locator(drmConfig.selectors.steamUsername).first().fill(credentials.username);
    await page.locator(drmConfig.selectors.steamPassword).first().fill(credentials.password);
    await page.locator(drmConfig.selectors.steamSubmit).first().click();
    await page.waitForLoadState('networkidle');

    const twoFactorInput = page.locator(drmConfig.selectors.twoFactorInput);
    const twoFactorVisible = await twoFactorInput.first().isVisible().catch(() => false);

    if (twoFactorVisible && twoFactorCode) {
      await twoFactorInput.first().fill(twoFactorCode);
      await page.locator(drmConfig.selectors.steamSubmit).first().click();
      await page.waitForLoadState('networkidle');
    } else if (twoFactorVisible && !twoFactorCode) {
      await browser.close();
      throw new Error('Steam Guard 2FA required. Provide the current authenticator or email code.');
    }

    const baseHost = new URL(drmConfig.baseUrl).hostname;
    await page.waitForURL((url) => url.hostname.includes(baseHost) || url.pathname.includes('drm'), { timeout: 20000 });

    await page.locator(drmConfig.selectors.gameIdInput).first().fill(String(gameAppId));

    await page.locator(drmConfig.selectors.extractButton).first().click();
    await page.waitForLoadState('networkidle');

    const fillBtn = page.locator(drmConfig.selectors.fillInfoButton).first();
    if (await fillBtn.isVisible().catch(() => false)) {
      await fillBtn.click();
      await page.waitForLoadState('networkidle');
    }

    await page.locator(drmConfig.selectors.submitButton).first().click();
    await page.waitForLoadState('networkidle');

    const codeEl = page.locator(drmConfig.selectors.codeOutput).first();
    await codeEl.waitFor({ state: 'visible', timeout: 15000 });

    let code = await codeEl.inputValue().catch(() => null);
    if (code === null) {
      code = await codeEl.textContent();
    }
    const trimmed = String(code || '').trim();

    if (!trimmed || trimmed.length < 10) {
      const body = await page.locator('body').textContent();
      const match = body.match(/[A-Za-z0-9_-]{20,}/);
      if (match) {
        await browser.close();
        return match[0];
      }
      throw new Error('Could not extract authorization code. Check drm.config.js selectors.');
    }

    await browser.close();
    return trimmed;
  } catch (err) {
    await browser.close().catch(() => {});
    const msg = err.message || 'Unknown error';
    if (msg.includes('Steam Guard') || msg.includes('2FA')) throw err;
    if (msg.includes('timeout') || msg.includes('Timeout')) {
      throw new Error(`drm.steam.run timed out. Check credentials and 2FA. Original: ${msg}`);
    }
    throw new Error(`drm.steam.run automation failed: ${msg}`);
  }
}
