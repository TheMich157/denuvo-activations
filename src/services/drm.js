import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { drmConfig } from '../config/drm.config.js';
import { debug } from '../utils/debug.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../../data');
const sessionsDir = join(dataDir, 'drm_sessions');
if (!existsSync(sessionsDir)) {
  try { mkdirSync(sessionsDir, { recursive: true }); } catch {}
}

const log = debug('drm');

const MIN_CODE_LENGTH = 10;
const CODE_FALLBACK_REGEX = /[A-Za-z0-9_-]{20,}/;

/* ---------- session helpers ---------- */

function getSessionPath(username) {
  const safe = createHash('sha256').update(String(username).trim().toLowerCase()).digest('hex').slice(0, 32);
  return join(sessionsDir, `${safe}.json`);
}

function saveSession(username, data) {
  try {
    writeFileSync(getSessionPath(username), JSON.stringify(data, null, 2));
    log('Session saved for', username);
  } catch (e) {
    log('Could not save session:', e?.message);
  }
}

function loadSession(username) {
  const p = getSessionPath(username);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function deleteSession(username) {
  const p = getSessionPath(username);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch {}
  }
}

/* ---------- simple cookie jar ---------- */

class CookieJar {
  constructor() { this.cookies = {}; }

  /** Parse Set-Cookie headers from a Response and store them. */
  addFromResponse(url, response) {
    const host = new URL(url).hostname;
    const raw = response.headers.getSetCookie?.() ?? [];
    if (!this.cookies[host]) this.cookies[host] = {};
    for (const h of raw) {
      const [pair] = h.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies[host][name] = value;
    }
  }

  /** Set an explicit cookie for a host. */
  set(host, name, value) {
    if (!this.cookies[host]) this.cookies[host] = {};
    this.cookies[host][name] = value;
  }

  /** Build Cookie header string for a URL. */
  headerFor(url) {
    const host = new URL(url).hostname;
    const parts = [];
    for (const [h, c] of Object.entries(this.cookies)) {
      if (host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`)) {
        for (const [n, v] of Object.entries(c)) parts.push(`${n}=${v}`);
      }
    }
    return parts.join('; ');
  }

  /** Import cookies from an array of "name=value" strings for a given host. */
  importStrings(host, arr) {
    if (!this.cookies[host]) this.cookies[host] = {};
    for (const s of arr) {
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      this.cookies[host][s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
    }
  }

  toJSON() { return this.cookies; }

  static fromJSON(obj) {
    const jar = new CookieJar();
    jar.cookies = obj ?? {};
    return jar;
  }
}

/* ---------- HTTP helpers ---------- */

const UA = drmConfig.userAgent;

/**
 * Fetch with cookie jar, following redirects manually so cookies are tracked at every hop.
 */
async function httpGet(url, jar, { maxRedirects = 12 } = {}) {
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(current, {
      method: 'GET',
      headers: { 'User-Agent': UA, Cookie: jar.headerFor(current) },
      redirect: 'manual',
    });
    jar.addFromResponse(current, res);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).href;
      continue;
    }
    return { url: current, status: res.status, body: await res.text(), headers: res.headers };
  }
  throw new Error('Too many redirects');
}

async function httpPost(url, formData, jar, { maxRedirects = 12, contentType } = {}) {
  let body;
  let ct = contentType;
  if (typeof formData === 'string') {
    body = formData;
    ct = ct || 'application/x-www-form-urlencoded';
  } else if (formData instanceof URLSearchParams) {
    body = formData.toString();
    ct = ct || 'application/x-www-form-urlencoded';
  } else {
    body = new URLSearchParams(formData).toString();
    ct = ct || 'application/x-www-form-urlencoded';
  }

  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const isFirst = i === 0;
    const res = await fetch(current, {
      method: isFirst ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        Cookie: jar.headerFor(current),
        ...(isFirst ? { 'Content-Type': ct } : {}),
      },
      body: isFirst ? body : undefined,
      redirect: 'manual',
    });
    jar.addFromResponse(current, res);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).href;
      continue;
    }
    return { url: current, status: res.status, body: await res.text(), headers: res.headers };
  }
  throw new Error('Too many redirects');
}

/* ---------- input validation ---------- */

function validateInputs(gameAppId, credentials) {
  const appId = Number(gameAppId);
  if (!Number.isInteger(appId) || appId < 1) throw new Error('Invalid game App ID.');
  if (!credentials || typeof credentials !== 'object') throw new Error('Credentials object is required.');
  const user = credentials.username;
  const pass = credentials.password;
  if (typeof user !== 'string' || !user.trim()) throw new Error('Steam username is required.');
  if (typeof pass !== 'string' || !pass) throw new Error('Steam password is required.');
  return { gameAppId: appId, username: user.trim(), password: pass };
}

function validateCredentialsOnly(credentials) {
  if (!credentials || typeof credentials !== 'object') throw new Error('Credentials object is required.');
  const user = credentials.username;
  const pass = credentials.password;
  if (typeof user !== 'string' || !user.trim()) throw new Error('Steam username is required.');
  if (typeof pass !== 'string' || !pass) throw new Error('Steam password is required.');
  return { username: user.trim(), password: pass };
}

/* ---------- Steam auth via steam-session ---------- */

/**
 * Authenticate with Steam and return { cookies, refreshToken }.
 * `cookies` is an array of "name=value" strings for steamcommunity.com.
 * If a confirmation code is needed and not provided, throws with a recognizable message.
 */
async function steamAuth(username, password, confirmCode = null) {
  const { LoginSession, EAuthTokenPlatformType } = await import('steam-session');
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);

  const startOpts = { accountName: username, password };
  if (confirmCode) startOpts.steamGuardCode = confirmCode;

  const result = await session.startWithCredentials(startOpts);

  if (result.actionRequired) {
    const actions = result.validActions || [];
    const emailAction = actions.find(a => a.type === 2); // EAuthSessionGuardType.EmailCode
    const domain = emailAction?.detail || 'your email';
    if (!confirmCode) {
      throw new Error(`Confirmation code required. Steam sent a code to ${domain}.`);
    }
    throw new Error('The confirmation code was rejected. Check your email for a fresh code and try again.');
  }

  // Wait for authenticated event (polling happens internally)
  const cookies = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Steam authentication timed out after 60 s.')), 60_000);
    session.on('authenticated', async () => {
      clearTimeout(timer);
      try { resolve(await session.getWebCookies()); }
      catch (e) { reject(e); }
    });
    session.on('timeout', () => { clearTimeout(timer); reject(new Error('Steam session polling timed out.')); });
    session.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  return { cookies, refreshToken: session.refreshToken };
}

/**
 * Restore a session from a saved refresh token.
 * Returns cookies array or null if the token is expired/invalid.
 */
async function steamAuthFromToken(refreshToken) {
  const { LoginSession, EAuthTokenPlatformType } = await import('steam-session');
  try {
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
    session.refreshToken = refreshToken;
    const cookies = await session.getWebCookies();
    return cookies;
  } catch (err) {
    log('Refresh token expired or invalid:', err?.message);
    return null;
  }
}

/* ---------- drm.steam.run interaction (HTTP) ---------- */

/**
 * Login to drm.steam.run using Steam web cookies via the OpenID flow.
 * Returns a CookieJar with valid drm.steam.run session cookies.
 */
async function drmLogin(steamCookieStrings) {
  const jar = new CookieJar();

  // Put Steam cookies into the jar for steamcommunity.com
  jar.importStrings('steamcommunity.com', steamCookieStrings);
  // Also need them for store.steampowered.com and login.steampowered.com
  jar.importStrings('store.steampowered.com', steamCookieStrings);
  jar.importStrings('login.steampowered.com', steamCookieStrings);

  // Step 1: visit drm site to get the login redirect URL
  log('Visiting', drmConfig.baseUrl);
  const mainPage = await httpGet(drmConfig.baseUrl, jar);
  const cheerio = await import('cheerio');
  let $ = cheerio.load(mainPage.body);

  // Check if already logged in (no login link visible)
  const selectorParts = drmConfig.selectors.loginLink.split(',').map(s => s.trim());
  let loginHref = null;
  for (const sel of selectorParts) {
    const el = $(sel).first();
    if (el.length && el.attr('href')) {
      loginHref = el.attr('href');
      break;
    }
  }

  if (!loginHref) {
    log('Already logged in on drm site (no login link found)');
    return jar;
  }

  // Step 2: follow the login link (may redirect to Steam OpenID)
  const loginUrl = new URL(loginHref, drmConfig.baseUrl).href;
  log('Following login link:', loginUrl);
  const loginResult = await httpGet(loginUrl, jar);

  // After following all redirects we should land back on drm site (logged in)
  // If we ended up on Steam (OpenID page) it means cookies auto-approved and we got redirected
  // Check where we ended up
  const finalHost = new URL(loginResult.url).hostname;
  const drmHost = new URL(drmConfig.baseUrl).hostname;

  if (finalHost.includes(drmHost)) {
    log('Steam OpenID auto-approved, now logged in on drm site');
    return jar;
  }

  // If we're on a Steam OpenID page, look for an approval/allow form
  $ = cheerio.load(loginResult.body);
  const allowForm = $('form').filter(function () {
    const action = $(this).attr('action') || '';
    return action.includes('openid') || $(this).find('input[name="action"]').val() === 'allow';
  }).first();

  if (allowForm.length) {
    log('Steam OpenID needs manual approval, submitting form');
    const action = new URL(allowForm.attr('action') || loginResult.url, loginResult.url).href;
    const params = new URLSearchParams();
    allowForm.find('input[type="hidden"], input[type="submit"]').each(function () {
      const n = $(this).attr('name');
      const v = $(this).val();
      if (n) params.set(n, v || '');
    });
    // Set the allow action
    params.set('action', 'allow');

    const approvalResult = await httpPost(action, params, jar);
    const approvalHost = new URL(approvalResult.url).hostname;
    if (approvalHost.includes(drmHost)) {
      log('OpenID approved, now logged in on drm site');
      return jar;
    }
  }

  // Last resort: check if the redirect chain eventually put us on the drm site
  // by re-fetching the main page with the cookies we have
  const recheck = await httpGet(drmConfig.baseUrl, jar);
  $ = cheerio.load(recheck.body);
  let stillNeedsLogin = false;
  for (const sel of selectorParts) {
    if ($(sel).first().length) { stillNeedsLogin = true; break; }
  }
  if (stillNeedsLogin) {
    throw new Error('Could not authenticate with drm.steam.run via Steam OpenID. Try using **Done** to paste the code manually.');
  }

  log('Logged in on drm site after re-check');
  return jar;
}

/**
 * Extract an auth code from drm.steam.run for a given game.
 * Expects the jar to already have valid session cookies.
 */
async function drmExtractCode(jar, gameAppId) {
  const cheerio = await import('cheerio');

  // Step 1: load main page
  log('Loading drm site for code extraction');
  const mainRes = await httpGet(drmConfig.baseUrl, jar);
  let $ = cheerio.load(mainRes.body);

  // Find the game ID form/input
  const gameInputSels = drmConfig.selectors.gameIdInput.split(',').map(s => s.trim());
  let gameInput = null;
  for (const sel of gameInputSels) {
    const el = $(sel).first();
    if (el.length) { gameInput = el; break; }
  }

  if (!gameInput) {
    throw new Error('Could not find game ID input on drm.steam.run. The site may have changed.');
  }

  const inputName = gameInput.attr('name') || 'appid';
  const form = gameInput.closest('form');

  // Try form-based submission
  if (form.length) {
    const action = new URL(form.attr('action') || '', drmConfig.baseUrl).href;
    const method = (form.attr('method') || 'POST').toUpperCase();
    const params = new URLSearchParams();

    // Collect all form fields
    form.find('input, select, textarea').each(function () {
      const n = $(this).attr('name');
      if (!n) return;
      const type = $(this).attr('type') || '';
      if (type === 'submit') return; // skip submit buttons
      params.set(n, $(this).val() || '');
    });
    params.set(inputName, String(gameAppId));

    log('Submitting game ID via form to', action);
    const res = method === 'GET'
      ? await httpGet(`${action}?${params}`, jar)
      : await httpPost(action, params, jar);
    $ = cheerio.load(res.body);

    // Look for code immediately
    const code = findCodeInPage($);
    if (code) return code;

    // Try sequential button actions (Extract → Fill → Submit)
    const nextRes = await trySequentialSubmits($, jar, drmConfig.baseUrl);
    if (nextRes) return nextRes;
  }

  // No form: try posting directly to the base URL
  log('No form found, trying direct POST');
  const directRes = await httpPost(drmConfig.baseUrl, { [inputName]: String(gameAppId) }, jar);
  $ = cheerio.load(directRes.body);

  const code = findCodeInPage($);
  if (code) return code;

  const nextRes = await trySequentialSubmits($, jar, drmConfig.baseUrl);
  if (nextRes) return nextRes;

  // Try common API patterns
  for (const apiPath of ['/api/extract', '/extract', '/api/generate', '/generate']) {
    try {
      const apiUrl = new URL(apiPath, drmConfig.baseUrl).href;
      const apiRes = await httpPost(apiUrl, { appid: String(gameAppId), gameid: String(gameAppId) }, jar);
      // Try JSON response
      try {
        const json = JSON.parse(apiRes.body);
        const codeVal = json.code || json.auth_code || json.token || json.result;
        if (typeof codeVal === 'string' && codeVal.length >= MIN_CODE_LENGTH) return codeVal;
      } catch {}
      // Try HTML response
      const $api = cheerio.load(apiRes.body);
      const apiCode = findCodeInPage($api);
      if (apiCode) return apiCode;
    } catch {}
  }

  throw new Error('Could not extract authorization code. The site may have changed or requires a browser. Use **Done** to paste the code from drm.steam.run manually.');
}

/**
 * Try finding and submitting Extract → Fill → Submit forms sequentially.
 */
async function trySequentialSubmits($, jar, baseUrl) {
  const cheerio = await import('cheerio');
  const buttonTexts = [
    ['Extract', '提取'],
    ['Fill', '填充', 'Fill Info'],
    ['Submit', '提交', 'Generate'],
  ];

  for (const texts of buttonTexts) {
    for (const text of texts) {
      const btn = $(`button, input[type="submit"]`).filter(function () {
        const t = $(this).text().trim();
        const v = $(this).val() || '';
        return t.includes(text) || v.includes(text);
      }).first();

      if (!btn.length) continue;

      const form = btn.closest('form');
      if (!form.length) continue;

      const action = new URL(form.attr('action') || '', baseUrl).href;
      const params = new URLSearchParams();
      form.find('input, select, textarea').each(function () {
        const n = $(this).attr('name');
        if (!n) return;
        params.set(n, $(this).val() || '');
      });
      // Include the button's name/value if it has one (some forms use submit button value)
      const btnName = btn.attr('name');
      if (btnName) params.set(btnName, btn.val() || text);

      log(`Submitting "${text}" form to`, action);
      const res = await httpPost(action, params, jar);
      $ = cheerio.load(res.body);

      const code = findCodeInPage($);
      if (code) return code;
      break; // Move to next button group
    }
  }
  return null;
}

/**
 * Search the page HTML for an authorization code.
 */
function findCodeInPage($) {
  // 1. Try configured selectors
  const codeSels = drmConfig.selectors.codeOutput.split(',').map(s => s.trim());
  for (const sel of codeSels) {
    const el = $(sel).first();
    if (!el.length) continue;
    const val = (el.val() || el.text() || '').trim();
    if (val.length >= MIN_CODE_LENGTH) return val;
  }

  // 2. Regex fallback on entire body text
  const bodyText = $('body').text() || '';
  const match = bodyText.match(CODE_FALLBACK_REGEX);
  return match ? match[0] : null;
}

/* ---------- public API ---------- */

/**
 * Check whether automated code generation is available (steam-session installed).
 */
export async function isAutomatedAvailable() {
  try {
    await import('steam-session');
    return true;
  } catch {
    return false;
  }
}

/**
 * Test Steam login with the given credentials.
 * @returns {{ ok: boolean; requires2FA?: boolean; error?: string }}
 */
export async function testLogin(credentials) {
  const available = await isAutomatedAvailable();
  if (!available) {
    return { ok: false, error: 'steam-session package not installed. Run: npm install steam-session' };
  }

  let username, password;
  try {
    const c = validateCredentialsOnly(credentials);
    username = c.username;
    password = c.password;
  } catch (err) {
    return { ok: false, error: err?.message || 'Invalid credentials' };
  }

  try {
    const { cookies, refreshToken } = await steamAuth(username, password, null);
    // Save session for reuse
    saveSession(username, { refreshToken, steamCookies: cookies });
    log('Test login: success, session saved');
    return { ok: true };
  } catch (err) {
    const msg = err?.message || 'Unknown error';
    if (msg.includes('Confirmation code required')) {
      log('Test login: credentials accepted, confirmation code needed');
      return { ok: true, requires2FA: true };
    }
    if (msg.includes('InvalidPassword') || msg.includes('invalid_password') || msg.toLowerCase().includes('incorrect')) {
      return { ok: false, error: 'Steam login failed: username or password incorrect.' };
    }
    if (msg.includes('RateLimitExceeded') || msg.includes('rate limit')) {
      return { ok: false, error: 'Steam rate limit hit. Wait a few minutes and try again.' };
    }
    log('Test login error:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * Generate an auth code via drm.steam.run using HTTP (no browser).
 * Reuses saved Steam session (refresh token) when available.
 *
 * @param {number} gameAppId
 * @param {{ username: string; password: string }} credentials
 * @param {string | null} confirmCode - 5-digit email code, only when session needs it
 * @returns {Promise<string>}
 */
export async function generateAuthCode(gameAppId, credentials, confirmCode = null) {
  const available = await isAutomatedAvailable();
  if (!available) {
    throw new Error(
      'steam-session package not installed. Run: npm install steam-session. ' +
      'Until then, perform the flow manually at drm.steam.run and paste the code via "Done".'
    );
  }

  const { gameAppId: appId, username, password } = validateInputs(gameAppId, credentials);
  const saved = loadSession(username);

  let steamCookies = null;

  // Step 1: try saved refresh token first
  if (saved?.refreshToken && !confirmCode) {
    log('Trying saved refresh token for', username);
    steamCookies = await steamAuthFromToken(saved.refreshToken);
    if (steamCookies) {
      log('Refresh token still valid, got cookies');
    } else {
      log('Refresh token expired, need fresh login');
      deleteSession(username);
    }
  }

  // Step 2: fresh login if needed
  if (!steamCookies) {
    log('Performing fresh Steam login for', username);
    try {
      const result = await steamAuth(username, password, confirmCode);
      steamCookies = result.cookies;
      saveSession(username, { refreshToken: result.refreshToken, steamCookies });
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('Confirmation code')) throw err;
      if (msg.includes('InvalidPassword') || msg.toLowerCase().includes('incorrect')) {
        throw new Error('Steam login failed: username or password incorrect.');
      }
      throw new Error(`Steam login failed. ${msg}`);
    }
  }

  // Step 3: login to drm.steam.run via OpenID
  let jar;
  try {
    jar = await drmLogin(steamCookies);
  } catch (err) {
    throw new Error(`Could not login to drm.steam.run. ${err?.message || 'Unknown error'}`);
  }

  // Step 4: extract the code
  const code = await drmExtractCode(jar, appId);
  if (!code || code.length < MIN_CODE_LENGTH) {
    throw new Error('Could not extract authorization code. The site may have changed. Use **Done** to paste the code from drm.steam.run manually.');
  }

  // Persist drm cookies for faster next run
  const freshSession = loadSession(username);
  if (freshSession?.refreshToken) {
    saveSession(username, { ...freshSession, drmCookies: jar.toJSON() });
  }

  log('Code extracted successfully');
  return code;
}
