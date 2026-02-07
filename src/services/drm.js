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

/**
 * Extract Set-Cookie header values from a fetch Response.
 * Node 18.14+ has getSetCookie(); older versions fall back to raw header parsing.
 */
function extractSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  // Fallback: parse the combined header (comma-split, but careful with Expires dates)
  const raw = response.headers.get('set-cookie');
  if (!raw) return [];
  // Split on ", <token>=" but not inside "Expires=Thu, 01 Jan ..."
  return raw.split(/,\s*(?=[A-Za-z0-9_.-]+=)/).filter(Boolean);
}

class CookieJar {
  constructor() { this.cookies = {}; }

  /** Parse Set-Cookie headers from a Response and store them keyed by host. */
  addFromResponse(url, response) {
    const host = new URL(url).hostname;
    const raw = extractSetCookies(response);
    if (!this.cookies[host]) this.cookies[host] = {};
    for (const h of raw) {
      const [pair] = h.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies[host][name] = value;

      // Also honour explicit Domain= attribute so the cookie is sent to subdomains
      const domainMatch = h.match(/;\s*[Dd]omain=\.?([^;]+)/);
      if (domainMatch) {
        const d = domainMatch[1].trim().toLowerCase();
        if (d && d !== host) {
          if (!this.cookies[d]) this.cookies[d] = {};
          this.cookies[d][name] = value;
        }
      }
    }
  }

  set(host, name, value) {
    if (!this.cookies[host]) this.cookies[host] = {};
    this.cookies[host][name] = value;
  }

  /** Build Cookie header string for a URL — matches exact host and parent domain. */
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
const REDIRECT_CODES = [301, 302, 303, 307, 308];

async function httpGet(url, jar, { maxRedirects = 15 } = {}) {
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(current, {
      method: 'GET',
      headers: { 'User-Agent': UA, Cookie: jar.headerFor(current), Accept: 'text/html,*/*' },
      redirect: 'manual',
    });
    jar.addFromResponse(current, res);
    if (REDIRECT_CODES.includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).href;
      continue;
    }
    return { url: current, status: res.status, body: await res.text(), headers: res.headers };
  }
  throw new Error('Too many redirects');
}

async function httpPost(url, formData, jar, { maxRedirects = 15 } = {}) {
  const body =
    typeof formData === 'string' ? formData
      : formData instanceof URLSearchParams ? formData.toString()
        : new URLSearchParams(formData).toString();

  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const isFirst = i === 0;
    const res = await fetch(current, {
      method: isFirst ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        Cookie: jar.headerFor(current),
        Accept: 'text/html,*/*',
        ...(isFirst ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: isFirst ? body : undefined,
      redirect: 'manual',
    });
    jar.addFromResponse(current, res);
    if (REDIRECT_CODES.includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).href;
      continue;
    }
    return { url: current, status: res.status, body: await res.text(), headers: res.headers };
  }
  throw new Error('Too many redirects');
}

/** Collect all hidden + submit inputs from a cheerio form element into URLSearchParams. */
function serializeForm($, form, base) {
  const action = new URL(form.attr('action') || '', base).href;
  const params = new URLSearchParams();
  form.find('input').each(function () {
    const n = $(this).attr('name');
    const v = $(this).val() || '';
    if (n) params.set(n, v);
  });
  return { action, params };
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

async function steamAuth(username, password, confirmCode = null) {
  const { LoginSession, EAuthTokenPlatformType } = await import('steam-session');
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);

  const startOpts = { accountName: username, password };
  if (confirmCode) startOpts.steamGuardCode = confirmCode;

  const result = await session.startWithCredentials(startOpts);

  if (result.actionRequired) {
    const actions = result.validActions || [];
    const emailAction = actions.find(a => a.type === 2);
    const domain = emailAction?.detail || 'your email';
    if (!confirmCode) {
      throw new Error(`Confirmation code required. Steam sent a code to ${domain}.`);
    }
    throw new Error('The confirmation code was rejected. Check your email for a fresh code and try again.');
  }

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

async function steamAuthFromToken(refreshToken) {
  const { LoginSession, EAuthTokenPlatformType } = await import('steam-session');
  try {
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
    session.refreshToken = refreshToken;
    return await session.getWebCookies();
  } catch (err) {
    log('Refresh token expired or invalid:', err?.message);
    return null;
  }
}

/* ---------- drm.steam.run interaction (HTTP) ---------- */

const DRM_HOST = new URL(drmConfig.baseUrl).hostname;
const STEAM_DOMAINS = [
  'steamcommunity.com',
  'store.steampowered.com',
  'login.steampowered.com',
  'help.steampowered.com',
];

function isDrmHost(urlStr) {
  try { return new URL(urlStr).hostname.includes(DRM_HOST); }
  catch { return false; }
}

/**
 * Fully decode a URL string that may have multiple levels of percent-encoding.
 * Steam nests goto=goto=goto= with double/triple encoding.
 */
function fullyDecode(str) {
  let prev = str;
  for (let i = 0; i < 6; i++) {
    const next = decodeURIComponent(prev);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/**
 * Extract the actual /openid/login?... URL hidden inside Steam's
 * /login/home/?goto=openid/loginform/?goto=%2Fopenid%2Flogin%3F... chain.
 */
function extractOpenIdUrl(steamPageUrl) {
  try {
    const decoded = fullyDecode(steamPageUrl);
    const m = decoded.match(/(\/openid\/login\?[^\s"'<>]+)/);
    if (m) return new URL(m[1], 'https://steamcommunity.com').href;
  } catch {}
  return null;
}

/**
 * Build a standard Steam OpenID URL for drm.steam.run as a last-resort fallback.
 * Uses auth/steam_callback.php as the return_to (observed from the real site).
 */
function buildFallbackOpenIdUrl() {
  const returnTo = `${drmConfig.baseUrl}/auth/steam_callback.php`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': drmConfig.baseUrl,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `https://steamcommunity.com/openid/login?${params}`;
}

/**
 * Login to drm.steam.run using Steam web cookies via the OpenID flow.
 *
 * Real flow observed:
 *   drm.steam.run  →  auth/steam_login.php  (302)
 *   →  steamcommunity.com/login/home/?goto=openid/loginform/?goto=<encoded OpenID URL>
 *      (JS-only page — returns 200, cannot follow redirect via HTTP)
 *   →  we extract the actual OpenID URL and hit it directly
 *   →  steamcommunity.com/openid/login?...  (processes w/ cookies, 302 to callback)
 *   →  drm.steam.run/auth/steam_callback.php  (sets session cookie)
 */
async function drmLogin(steamCookieStrings) {
  const jar = new CookieJar();
  const cheerio = await import('cheerio');

  for (const domain of STEAM_DOMAINS) {
    jar.importStrings(domain, steamCookieStrings);
  }

  // 1. Visit drm site, check if already logged in
  log('drmLogin: visiting', drmConfig.baseUrl);
  const mainPage = await httpGet(drmConfig.baseUrl, jar);
  let $ = cheerio.load(mainPage.body);

  const loginSels = drmConfig.selectors.loginLink.split(',').map(s => s.trim());
  let loginHref = null;
  for (const sel of loginSels) {
    const el = $(sel).first();
    if (el.length && el.attr('href')) { loginHref = el.attr('href'); break; }
  }

  if (!loginHref) {
    log('drmLogin: no login link → already logged in');
    return jar;
  }

  // 2. Follow the login link (drm → steam_login.php → steamcommunity.com/login/home/?goto=...)
  const loginUrl = new URL(loginHref, drmConfig.baseUrl).href;
  log('drmLogin: following login link →', loginUrl);
  const loginRes = await httpGet(loginUrl, jar);

  if (isDrmHost(loginRes.url)) {
    log('drmLogin: auto-approved via redirect');
    return jar;
  }

  // 3. We're on Steam (usually /login/home/ which is JS-only).
  //    Extract the real OpenID endpoint URL from the nested goto params.
  log('drmLogin: landed on Steam page →', loginRes.url);

  let openIdUrl = extractOpenIdUrl(loginRes.url);
  if (!openIdUrl) {
    // Also try the page body — sometimes the URL is in an embedded link or script
    const bodyDecoded = fullyDecode(loginRes.body);
    const m = bodyDecoded.match(/(\/openid\/login\?[^\s"'<>]+)/);
    if (m) openIdUrl = new URL(m[1], 'https://steamcommunity.com').href;
  }
  if (!openIdUrl) {
    log('drmLogin: could not extract OpenID URL, trying fallback');
    openIdUrl = buildFallbackOpenIdUrl();
  }

  log('drmLogin: hitting OpenID endpoint directly →', openIdUrl);
  const openIdRes = await httpGet(openIdUrl, jar);

  if (isDrmHost(openIdRes.url)) {
    log('drmLogin: OpenID redirected to drm site ✓');
    return jar;
  }

  // 4. OpenID may have returned a page with a form (approval page or auto-submit page)
  $ = cheerio.load(openIdRes.body);
  const forms = $('form').toArray();
  log('drmLogin: OpenID page has', forms.length, 'form(s)');

  for (const formEl of forms) {
    const form = $(formEl);
    const { action, params } = serializeForm($, form, openIdRes.url);
    log('drmLogin: submitting form →', action);
    const formRes = await httpPost(action, params, jar);
    if (isDrmHost(formRes.url)) {
      log('drmLogin: form redirected to drm site ✓');
      return jar;
    }
    // One more level of chained forms
    const $next = cheerio.load(formRes.body);
    const nextForm = $next('form').first();
    if (nextForm.length) {
      const next = serializeForm($next, nextForm, formRes.url);
      log('drmLogin: chained form →', next.action);
      const nextRes = await httpPost(next.action, next.params, jar);
      if (isDrmHost(nextRes.url)) {
        log('drmLogin: chained form → drm site ✓');
        return jar;
      }
    }
  }

  // 5. Last resort: re-check main page in case cookies were set along the way
  const recheck = await httpGet(drmConfig.baseUrl, jar);
  $ = cheerio.load(recheck.body);
  let stillNeedsLogin = false;
  for (const sel of loginSels) {
    if ($(sel).first().length) { stillNeedsLogin = true; break; }
  }
  if (!stillNeedsLogin) {
    log('drmLogin: logged in after re-check ✓');
    return jar;
  }

  log('drmLogin: FAILED — final URL was', openIdRes.url);
  throw new Error('Could not authenticate with drm.steam.run via Steam OpenID. Try using **Done** to paste the code manually.');
}

/**
 * Extract an auth code from drm.steam.run for a given game.
 */
async function drmExtractCode(jar, gameAppId) {
  const cheerio = await import('cheerio');

  log('drmExtractCode: loading main page');
  const mainRes = await httpGet(drmConfig.baseUrl, jar);
  let $ = cheerio.load(mainRes.body);

  // Find game ID input
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

  // Form-based submission
  if (form.length) {
    const action = new URL(form.attr('action') || '', drmConfig.baseUrl).href;
    const method = (form.attr('method') || 'POST').toUpperCase();
    const params = new URLSearchParams();
    form.find('input, select, textarea').each(function () {
      const n = $(this).attr('name');
      if (!n) return;
      if ($(this).attr('type') === 'submit') return;
      params.set(n, $(this).val() || '');
    });
    params.set(inputName, String(gameAppId));

    log('drmExtractCode: submitting game ID via form →', action);
    const res = method === 'GET'
      ? await httpGet(`${action}?${params}`, jar)
      : await httpPost(action, params, jar);
    $ = cheerio.load(res.body);

    const code = findCodeInPage($);
    if (code) return code;

    const seqCode = await trySequentialSubmits($, jar, drmConfig.baseUrl);
    if (seqCode) return seqCode;
  }

  // Fallback: direct POST
  log('drmExtractCode: no form found, trying direct POST');
  const directRes = await httpPost(drmConfig.baseUrl, { [inputName]: String(gameAppId) }, jar);
  $ = cheerio.load(directRes.body);

  let code = findCodeInPage($);
  if (code) return code;

  const seqCode = await trySequentialSubmits($, jar, drmConfig.baseUrl);
  if (seqCode) return seqCode;

  // Try common API patterns
  for (const apiPath of ['/api/extract', '/extract', '/api/generate', '/generate']) {
    try {
      const apiUrl = new URL(apiPath, drmConfig.baseUrl).href;
      const apiRes = await httpPost(apiUrl, { appid: String(gameAppId), gameid: String(gameAppId) }, jar);
      try {
        const json = JSON.parse(apiRes.body);
        const val = json.code || json.auth_code || json.token || json.result;
        if (typeof val === 'string' && val.length >= MIN_CODE_LENGTH) return val;
      } catch {}
      const $api = cheerio.load(apiRes.body);
      code = findCodeInPage($api);
      if (code) return code;
    } catch {}
  }

  throw new Error('Could not extract authorization code. The site may have changed. Use **Done** to paste the code from drm.steam.run manually.');
}

async function trySequentialSubmits($, jar, baseUrl) {
  const cheerio = await import('cheerio');
  const buttonTexts = [
    ['Extract', '提取'],
    ['Fill', '填充', 'Fill Info'],
    ['Submit', '提交', 'Generate'],
  ];

  for (const texts of buttonTexts) {
    for (const text of texts) {
      const btn = $('button, input[type="submit"]').filter(function () {
        const t = $(this).text().trim();
        const v = $(this).val() || '';
        return t.includes(text) || v.includes(text);
      }).first();

      if (!btn.length) continue;

      const form = btn.closest('form');
      if (!form.length) continue;

      const { action, params } = serializeForm($, form, baseUrl);
      const btnName = btn.attr('name');
      if (btnName) params.set(btnName, btn.val() || text);

      log(`drmExtractCode: submitting "${text}" form →`, action);
      const res = await httpPost(action, params, jar);
      $ = cheerio.load(res.body);

      const code = findCodeInPage($);
      if (code) return code;
      break;
    }
  }
  return null;
}

function findCodeInPage($) {
  const codeSels = drmConfig.selectors.codeOutput.split(',').map(s => s.trim());
  for (const sel of codeSels) {
    const el = $(sel).first();
    if (!el.length) continue;
    const val = (el.val() || el.text() || '').trim();
    if (val.length >= MIN_CODE_LENGTH) return val;
  }
  const bodyText = $('body').text() || '';
  const match = bodyText.match(CODE_FALLBACK_REGEX);
  return match ? match[0] : null;
}

/* ---------- public API ---------- */

export async function isAutomatedAvailable() {
  try {
    await import('steam-session');
    return true;
  } catch {
    return false;
  }
}

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
    saveSession(username, { refreshToken, steamCookies: cookies });
    log('testLogin: success, session saved');
    return { ok: true };
  } catch (err) {
    const msg = err?.message || 'Unknown error';
    if (msg.includes('Confirmation code required')) {
      log('testLogin: credentials accepted, confirmation code needed');
      return { ok: true, requires2FA: true };
    }
    if (msg.includes('InvalidPassword') || msg.includes('invalid_password') || msg.toLowerCase().includes('incorrect')) {
      return { ok: false, error: 'Steam login failed: username or password incorrect.' };
    }
    if (msg.includes('RateLimitExceeded') || msg.includes('rate limit')) {
      return { ok: false, error: 'Steam rate limit hit. Wait a few minutes and try again.' };
    }
    log('testLogin error:', msg);
    return { ok: false, error: msg };
  }
}

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

  // 1. Try saved drm cookies directly (fastest path — skip Steam entirely)
  if (saved?.drmCookies && !confirmCode) {
    log('generateAuthCode: trying saved drm cookies');
    const jar = CookieJar.fromJSON(saved.drmCookies);
    try {
      const cheerio = await import('cheerio');
      const check = await httpGet(drmConfig.baseUrl, jar);
      const $ = cheerio.load(check.body);
      const loginSels = drmConfig.selectors.loginLink.split(',').map(s => s.trim());
      let needsLogin = false;
      for (const sel of loginSels) {
        if ($(sel).first().length) { needsLogin = true; break; }
      }
      if (!needsLogin) {
        log('generateAuthCode: saved drm cookies still valid');
        const code = await drmExtractCode(jar, appId);
        if (code && code.length >= MIN_CODE_LENGTH) {
          saveSession(username, { ...saved, drmCookies: jar.toJSON() });
          log('Code extracted successfully');
          return code;
        }
      }
    } catch (e) {
      log('generateAuthCode: saved drm cookies failed:', e?.message);
    }
  }

  // 2. Try saved refresh token
  if (saved?.refreshToken && !confirmCode) {
    log('generateAuthCode: trying saved refresh token');
    steamCookies = await steamAuthFromToken(saved.refreshToken);
    if (steamCookies) {
      log('generateAuthCode: refresh token valid');
    } else {
      log('generateAuthCode: refresh token expired');
      deleteSession(username);
    }
  }

  // 3. Fresh login if needed
  if (!steamCookies) {
    log('generateAuthCode: performing fresh Steam login');
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

  // 4. Login to drm.steam.run via OpenID
  let jar;
  try {
    jar = await drmLogin(steamCookies);
  } catch (err) {
    throw new Error(`Could not login to drm.steam.run. ${err?.message || 'Unknown error'}`);
  }

  // 5. Extract the code
  const code = await drmExtractCode(jar, appId);
  if (!code || code.length < MIN_CODE_LENGTH) {
    throw new Error('Could not extract authorization code. The site may have changed. Use **Done** to paste the code from drm.steam.run manually.');
  }

  const freshSession = loadSession(username);
  if (freshSession?.refreshToken) {
    saveSession(username, { ...freshSession, drmCookies: jar.toJSON() });
  }

  log('Code extracted successfully');
  return code;
}
