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

/** Custom error class for DRM flow failures with step-level diagnostics. */
export class DrmError extends Error {
  constructor(message, { step, url, status, cookieDomains, bodySnippet, cause } = {}) {
    super(message);
    this.name = 'DrmError';
    this.step = step || 'unknown';
    this.diagnosticUrl = url || null;
    this.httpStatus = status || null;
    this.cookieDomains = cookieDomains || null;
    this.bodySnippet = bodySnippet || null;
    if (cause) this.cause = cause;
  }

  /** Build a concise diagnostic string for logging. */
  toDiagnostic() {
    const parts = [`[DrmError] step=${this.step}`];
    if (this.diagnosticUrl) parts.push(`url=${this.diagnosticUrl}`);
    if (this.httpStatus) parts.push(`status=${this.httpStatus}`);
    if (this.cookieDomains) parts.push(`cookies=[${this.cookieDomains}]`);
    if (this.bodySnippet) parts.push(`body=${this.bodySnippet}`);
    parts.push(`msg=${this.message}`);
    return parts.join(' | ');
  }
}

const MIN_CODE_LENGTH = 6;
// The final auth code is exactly 6 alphanumeric characters (digits + letters)
const AUTH_CODE_REGEX = /\b[A-Za-z0-9]{6}\b/;
// Longer codes as secondary fallback
const CODE_FALLBACK_REGEX = /[A-Za-z0-9_-]{6,}/;

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
 * Extract a URL from a <meta http-equiv="refresh"> tag.
 * Some Steam pages use meta refresh for JS-free redirects.
 */
function extractMetaRefresh(html, baseUrl) {
  const m = html.match(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\d+;\s*url\s*=\s*([^\s"'>]+)/i);
  if (m) {
    try { return new URL(m[1], baseUrl).href; } catch {}
  }
  return null;
}

/**
 * Search page HTML for OpenID assertion forms (openid.mode=id_res) or forms
 * whose action points to drm.steam.run, and submit them.
 * Returns true if we ended up on the DRM host.
 */
async function trySubmitAssertionForms(cheerio, html, baseUrl, jar) {
  const $ = cheerio.load(html);
  const forms = $('form').toArray();
  if (!forms.length) return false;

  // Prioritise OpenID assertion forms and forms pointing at drm host
  const sorted = forms.sort((a, b) => {
    const aAction = $(a).attr('action') || '';
    const bAction = $(b).attr('action') || '';
    const aIsAssertion = $(a).find('input[name="openid.mode"][value="id_res"]').length > 0 || isDrmHost(aAction);
    const bIsAssertion = $(b).find('input[name="openid.mode"][value="id_res"]').length > 0 || isDrmHost(bAction);
    return (bIsAssertion ? 1 : 0) - (aIsAssertion ? 1 : 0);
  });

  for (const formEl of sorted) {
    const form = $(formEl);
    const { action, params } = serializeForm($, form, baseUrl);
    log('trySubmitAssertionForms: submitting form →', action, '| fields:', [...params.keys()].join(','));
    try {
      const res = await httpPost(action, params, jar);
      if (isDrmHost(res.url)) {
        log('trySubmitAssertionForms: reached drm site ✓');
        return true;
      }
      // Follow one more level of chained forms
      const $next = cheerio.load(res.body);
      const nextForms = $next('form').toArray();
      for (const nf of nextForms) {
        const next = serializeForm($next, $(nf), res.url);
        log('trySubmitAssertionForms: chained form →', next.action);
        const nextRes = await httpPost(next.action, next.params, jar);
        if (isDrmHost(nextRes.url)) {
          log('trySubmitAssertionForms: chained form → drm site ✓');
          return true;
        }
      }
    } catch (e) {
      log('trySubmitAssertionForms: form submission error:', e?.message);
    }
  }
  return false;
}

/** Truncate a string for logging (first N chars). */
function snippet(str, len = 300) {
  if (!str) return '(empty)';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

/**
 * Login to drm.steam.run using Steam web cookies via the OpenID flow.
 *
 * Real flow observed:
 *   drm.steam.run  →  auth/steam_login.php  (302)
 *   →  steamcommunity.com/openid/login?... OR /login/home/?goto=openid/loginform/?goto=<encoded>
 *      (Steam may auto-redirect back, show an approval form, or show the JS login page)
 *   →  we handle each case: direct redirect, assertion form, or extract+re-request
 *   →  drm.steam.run/auth/steam_callback.php  (sets session cookie)
 */
async function drmLogin(steamCookieStrings) {
  const jar = new CookieJar();
  const cheerio = await import('cheerio');

  for (const domain of STEAM_DOMAINS) {
    jar.importStrings(domain, steamCookieStrings);
  }

  // Ensure sessionid cookie exists for all Steam domains — required for OpenID approval.
  // steam-session sometimes omits it or returns one that doesn't match the web session.
  for (const domain of STEAM_DOMAINS) {
    if (!jar.cookies[domain]?.sessionid) {
      const id = createHash('sha256')
        .update(`${Date.now()}${Math.random()}`)
        .digest('hex')
        .slice(0, 24);
      jar.set(domain, 'sessionid', id);
      log('drmLogin: generated sessionid for', domain);
    }
  }

  log('drmLogin: cookie domains:', Object.keys(jar.cookies).join(', '));
  log('drmLogin: cookie names per domain:',
    Object.entries(jar.cookies).map(([d, c]) => `${d}=[${Object.keys(c).join(',')}]`).join(' '));

  // 1. Visit drm site, check if already logged in
  log('drmLogin: visiting', drmConfig.baseUrl);
  const mainPage = await httpGet(drmConfig.baseUrl, jar);
  let $ = cheerio.load(mainPage.body);
  log('drmLogin: main page status', mainPage.status, '| url', mainPage.url);

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
  log('drmLogin: login link found →', loginHref);

  // 2. Follow the login link (drm → steam_login.php → steamcommunity.com/…)
  const loginUrl = new URL(loginHref, drmConfig.baseUrl).href;
  log('drmLogin: following login link →', loginUrl);
  const loginRes = await httpGet(loginUrl, jar);
  log('drmLogin: login chain ended at', loginRes.url, '| status', loginRes.status);

  if (isDrmHost(loginRes.url)) {
    log('drmLogin: auto-approved via redirect ✓');
    return jar;
  }

  // 2b. The login redirect may have landed on the OpenID assertion page directly
  //     (Steam auto-approved with cookies and returned the id_res form).
  //     We must check the response body for forms BEFORE re-requesting the URL,
  //     because re-requesting may invalidate the one-time OpenID nonce.
  if (await trySubmitAssertionForms(cheerio, loginRes.body, loginRes.url, jar)) {
    log('drmLogin: assertion form from login redirect succeeded ✓');
    return jar;
  }

  // Check for meta refresh redirect (JS-free redirect)
  const metaUrl = extractMetaRefresh(loginRes.body, loginRes.url);
  if (metaUrl) {
    log('drmLogin: following meta refresh from login page →', metaUrl);
    const metaRes = await httpGet(metaUrl, jar);
    if (isDrmHost(metaRes.url)) {
      log('drmLogin: meta refresh → drm site ✓');
      return jar;
    }
    if (await trySubmitAssertionForms(cheerio, metaRes.body, metaRes.url, jar)) {
      log('drmLogin: assertion form from meta refresh succeeded ✓');
      return jar;
    }
  }

  // 3. We're on Steam (usually /login/home/ which is JS-only).
  //    Extract the real OpenID endpoint URL from the nested goto params.
  log('drmLogin: on Steam page →', loginRes.url);
  log('drmLogin: Steam page title:', cheerio.load(loginRes.body)('title').text().trim());
  log('drmLogin: Steam page body snippet:', snippet(loginRes.body));

  let openIdUrl = extractOpenIdUrl(loginRes.url);
  if (!openIdUrl) {
    // Also try the page body — sometimes the URL is in an embedded link or script
    const bodyDecoded = fullyDecode(loginRes.body);
    const m = bodyDecoded.match(/(\/openid\/login\?[^\s"'<>]+)/);
    if (m) openIdUrl = new URL(m[1], 'https://steamcommunity.com').href;
  }

  const fallbackUrl = buildFallbackOpenIdUrl();
  const openIdUrls = [];
  if (openIdUrl) openIdUrls.push(openIdUrl);
  if (openIdUrl !== fallbackUrl) openIdUrls.push(fallbackUrl);

  let lastOpenIdUrl = null;
  let lastOpenIdStatus = null;

  for (const url of openIdUrls) {
    log('drmLogin: hitting OpenID endpoint →', url);
    try {
      const openIdRes = await httpGet(url, jar);
      lastOpenIdUrl = openIdRes.url;
      lastOpenIdStatus = openIdRes.status;
      log('drmLogin: OpenID response status', openIdRes.status, '| url', openIdRes.url);

      if (isDrmHost(openIdRes.url)) {
        log('drmLogin: OpenID redirected to drm site ✓');
        return jar;
      }

      // Try assertion forms on the OpenID response page
      if (await trySubmitAssertionForms(cheerio, openIdRes.body, openIdRes.url, jar)) {
        log('drmLogin: assertion form from OpenID page succeeded ✓');
        return jar;
      }

      // Check meta refresh on OpenID page
      const openIdMeta = extractMetaRefresh(openIdRes.body, openIdRes.url);
      if (openIdMeta) {
        log('drmLogin: following meta refresh from OpenID page →', openIdMeta);
        const metaRes = await httpGet(openIdMeta, jar);
        if (isDrmHost(metaRes.url)) {
          log('drmLogin: OpenID meta refresh → drm site ✓');
          return jar;
        }
      }

      log('drmLogin: OpenID page body snippet:', snippet(openIdRes.body));
    } catch (e) {
      log('drmLogin: OpenID attempt failed:', e?.message);
    }
  }

  // 4. Last resort: re-check main page in case cookies were set along the way
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

  // Gather diagnostics for the error
  const cookieDomains = Object.keys(jar.cookies).join(', ');
  const steamCookieNames = Object.entries(jar.cookies)
    .filter(([d]) => d.includes('steam'))
    .map(([d, c]) => `${d}=[${Object.keys(c).join(',')}]`).join(' ');
  const lastPathname = lastOpenIdUrl ? new URL(lastOpenIdUrl).pathname : 'N/A';
  const recheckBody = snippet(cheerio.load(recheck.body)('body').text(), 200);

  log('drmLogin: FAILED — last OpenID url:', lastOpenIdUrl, '| status:', lastOpenIdStatus);
  log('drmLogin: FAILED — cookie domains:', cookieDomains);
  log('drmLogin: FAILED — steam cookies:', steamCookieNames);
  log('drmLogin: FAILED — recheck body:', recheckBody);

  // Determine specific failure reason
  let reason;
  if (lastOpenIdUrl && lastPathname.includes('/login')) {
    reason = 'Steam cookies were not accepted — OpenID redirected to login page instead of approving.';
  } else if (lastOpenIdUrl && lastOpenIdStatus && lastOpenIdStatus >= 400) {
    reason = `Steam OpenID returned HTTP ${lastOpenIdStatus} at ${lastPathname}.`;
  } else if (!lastOpenIdUrl) {
    reason = 'Could not find or reach the Steam OpenID endpoint.';
  } else {
    reason = `Steam OpenID flow ended at ${lastPathname} without redirecting back to drm.steam.run.`;
  }

  throw new DrmError(
    `Could not authenticate with drm.steam.run. ${reason}`,
    {
      step: 'drmLogin:openid',
      url: lastOpenIdUrl,
      status: lastOpenIdStatus,
      cookieDomains,
      bodySnippet: recheckBody,
    }
  );
}

/* ---------- page helpers ---------- */

/** Find a clickable element (button / submit / link) whose visible text matches any of `texts`. */
function findClickable($, texts) {
  const SELS = 'button, input[type="submit"], a.btn, a.button, [role="button"], a';
  for (const text of texts) {
    const lower = text.toLowerCase();
    const el = $(SELS).filter(function () {
      const t = ($(this).text() || '').trim().toLowerCase();
      const v = ($(this).val() || '').toLowerCase();
      return t.includes(lower) || v.includes(lower);
    }).first();
    if (el.length) return el;
  }
  return null;
}

/** Find a game/app ID input on the current page. */
function findGameIdInput($) {
  for (const sel of drmConfig.selectors.gameIdInput.split(',').map(s => s.trim())) {
    const el = $(sel).first();
    if (el.length) return el;
  }
  const fb = $('input[type="text"], input[type="number"], input:not([type])').filter(function () {
    const blob = (($(this).attr('name') || '') + ($(this).attr('id') || '') + ($(this).attr('placeholder') || '')).toLowerCase();
    return /app|game|id/.test(blob);
  }).first();
  return fb.length ? fb : null;
}

/** Click a clickable element — submit its form or follow its link. Returns { $, url } or null. */
async function clickEl($, el, jar, pageUrl, overrides = {}) {
  const cheerio = await import('cheerio');
  const form = el.closest('form');
  if (form.length) {
    const { action, params } = serializeForm($, form, pageUrl);
    const name = el.attr('name');
    if (name) params.set(name, el.val() || el.text().trim());
    for (const [k, v] of Object.entries(overrides)) params.set(k, v);
    const method = (form.attr('method') || 'POST').toUpperCase();
    log('clickEl: submit form →', action, '| method:', method);
    const res = method === 'GET'
      ? await httpGet(`${action}?${params}`, jar)
      : await httpPost(action, params, jar);
    return { $: cheerio.load(res.body), url: res.url, body: res.body };
  }
  const href = el.attr('href');
  if (href && href !== '#' && !href.startsWith('javascript:')) {
    const full = new URL(href, pageUrl).href;
    log('clickEl: follow link →', full);
    const res = await httpGet(full, jar);
    return { $: cheerio.load(res.body), url: res.url, body: res.body };
  }
  const onclick = el.attr('onclick') || el.attr('data-href') || '';
  const m = onclick.match(/['"]([^'"]*(?:\.php|\/)[^'"]*)['"]/);
  if (m) {
    const full = new URL(m[1], pageUrl).href;
    log('clickEl: onclick →', full);
    const res = await httpGet(full, jar);
    return { $: cheerio.load(res.body), url: res.url, body: res.body };
  }
  return null;
}

/**
 * Search the page for the final 6-character alphanumeric authorization code.
 * Checks config selectors, data attributes, and regex patterns.
 */
function findCodeInPage($) {
  // 1. Explicit selectors from config
  for (const sel of drmConfig.selectors.codeOutput.split(',').map(s => s.trim())) {
    try {
      const el = $(sel).first();
      if (!el.length) continue;
      const val = (el.val() || el.text() || '').trim();
      if (val.length >= MIN_CODE_LENGTH && !/[<{]/.test(val)) return val;
    } catch {}
  }
  // 2. Data attributes
  let found = null;
  $('[data-code], [data-auth], [data-token], [data-result]').each(function () {
    if (found) return;
    const v = ($(this).attr('data-code') || $(this).attr('data-auth') || $(this).attr('data-token') || $(this).attr('data-result') || '').trim();
    if (v.length >= MIN_CODE_LENGTH) found = v;
  });
  if (found) return found;
  // 3. Look for a standalone 6-char alphanumeric code (the final auth code)
  const bodyText = $('body').text() || '';
  const m6 = bodyText.match(AUTH_CODE_REGEX);
  if (m6) return m6[0];
  // 4. Longer fallback
  const mLong = bodyText.match(CODE_FALLBACK_REGEX);
  return mLong ? mLong[0] : null;
}

/**
 * Extract extracted data (GameId, SteamId, BillData) from the extraction results page.
 * Returns an object with all key-value pairs found, or null.
 */
function extractExtractionData($) {
  const data = {};
  // Look for labeled values: "GameId: xxx", "SteamId: xxx", "BillData: xxx" etc.
  const text = $('body').text() || '';
  const patterns = [
    /Game\s*Id\s*[:\s]\s*(\S+)/i,
    /Steam\s*Id\s*[:\s]\s*(\S+)/i,
    /Bill\s*Data\s*[:\s]\s*(\S+)/i,
    /App\s*Id\s*[:\s]\s*(\S+)/i,
  ];
  const keys = ['GameId', 'SteamId', 'BillData', 'AppId'];
  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (m) data[keys[i]] = m[1];
  }

  // Also scrape from table rows, definition lists, or labeled spans
  $('tr, dl, .row, .field, .info-row, .data-row').each(function () {
    const t = ($(this).text() || '').trim();
    for (let i = 0; i < patterns.length; i++) {
      const m = t.match(patterns[i]);
      if (m && !data[keys[i]]) data[keys[i]] = m[1];
    }
  });

  // Scrape from input fields that are pre-filled (readonly or with values)
  $('input[value], textarea').each(function () {
    const name = ($(this).attr('name') || $(this).attr('id') || '').toLowerCase();
    const val = ($(this).val() || '').trim();
    if (!val) return;
    if (name.includes('game') || name.includes('appid')) data.GameId = data.GameId || val;
    if (name.includes('steam')) data.SteamId = data.SteamId || val;
    if (name.includes('bill')) data.BillData = data.BillData || val;
  });

  return Object.keys(data).length > 0 ? data : null;
}

/* ---------- exact drm.steam.run multi-step code extraction ---------- */

/**
 * Extract an auth code from drm.steam.run for a given game.
 *
 * Exact site flow (as described by the user):
 *   1. Login to drm.steam.run (already done before this function is called)
 *   2. Click "Authorization Code Generation" button/link on the dashboard
 *   3. Click "Extract Authorization" button/link
 *   4. A window/form appears with a Game ID input — enter the AppId
 *   5. Click "Start Extraction" button
 *   6. Results show: GameId, SteamId, BillData strings
 *   7. Fill out the Authorization Code Generation form with the extracted data
 *      (use the "Fill Info" button if available, otherwise fill manually)
 *   8. Click "Submit the Authorization and Generate the Authorization Code"
 *   9. A 6-character alphanumeric code appears — that's the final code
 *
 * Each step logs exactly what it sees so failures are debuggable.
 */
async function drmExtractCode(jar, gameAppId) {
  const cheerio = await import('cheerio');
  const appIdStr = String(gameAppId);

  // ── Step 1: Load dashboard (post-login) ──
  log('step1: loading dashboard', drmConfig.baseUrl);
  let page = await httpGet(drmConfig.baseUrl, jar);
  let $ = cheerio.load(page.body);
  let url = page.url;
  log('step1: title:', $('title').text().trim(), '| url:', url);

  // ── Step 2: Click "Authorization Code Generation" ──
  log('step2: looking for "Authorization Code Generation" link/button');
  let btn = findClickable($, [
    'Authorization Code Generation', 'Authorization Code', 'Code Generation',
    'Auth Code', 'Generate Code', 'Generate Authorization',
    '授权码生成', '生成授权码', '授权码', '生成',
  ]);
  if (btn) {
    log('step2: found, clicking');
    const res = await clickEl($, btn, jar, url);
    if (res) { $ = res.$; url = res.url; }
  } else {
    // Fallback: try known paths
    log('step2: button not found, trying known paths');
    for (const path of (drmConfig.knownPaths || [])) {
      try {
        const tryUrl = new URL(path, drmConfig.baseUrl).href;
        const res = await httpGet(tryUrl, jar);
        if (res.status < 400) {
          $ = cheerio.load(res.body);
          url = res.url;
          // Check if this page has the next step
          if (findClickable($, ['Extract', '提取']) || findGameIdInput($)) {
            log('step2: found relevant page at', tryUrl);
            break;
          }
        }
      } catch {}
    }
  }
  log('step2: now on:', url, '| title:', $('title').text().trim());

  // ── Step 3: Click "Extract Authorization" ──
  log('step3: looking for "Extract Authorization" link/button');
  btn = findClickable($, [
    'Extract Authorization', 'Extract Authorizations', 'Extract Auth',
    'Extract', '提取授权', '提取', 'Extraction',
  ]);
  if (btn) {
    log('step3: found, clicking');
    const res = await clickEl($, btn, jar, url);
    if (res) { $ = res.$; url = res.url; }
  } else {
    log('step3: not found — may already be on the extraction page');
  }
  log('step3: now on:', url);

  // ── Step 4: Find Game ID input and enter the AppId ──
  log('step4: looking for Game ID input');
  let gameInput = findGameIdInput($);
  if (!gameInput) {
    // The input might appear after clicking a tab or expanding a section
    log('step4: no input found, scanning all links on page');
    const allLinks = $('a[href]').toArray();
    for (const linkEl of allLinks.slice(0, 10)) {
      const href = $(linkEl).attr('href');
      const text = ($(linkEl).text() || '').toLowerCase();
      if (!href || href === '#') continue;
      if (text.includes('extract') || text.includes('game') || text.includes('提取') || text.includes('appid')) {
        try {
          const linkUrl = new URL(href, url).href;
          log('step4: trying link:', text, '→', linkUrl);
          const res = await httpGet(linkUrl, jar);
          if (res.status < 400) {
            $ = cheerio.load(res.body);
            url = res.url;
            gameInput = findGameIdInput($);
            if (gameInput) { log('step4: found input after following link'); break; }
          }
        } catch {}
      }
    }
  }

  if (!gameInput) {
    const pageText = snippet($('body').text(), 500);
    log('step4: FAILED — page text:', pageText);
    throw new DrmError(
      'Could not find Game ID input on drm.steam.run.',
      { step: 'drmExtractCode:step4-gameInput', url, bodySnippet: snippet($('body').text(), 200) }
    );
  }

  const inputName = gameInput.attr('name') || 'appid';
  log('step4: filling', inputName, '=', appIdStr);

  // ── Step 5: Click "Start Extraction" ──
  log('step5: submitting Game ID and clicking Start Extraction');
  const form = gameInput.closest('form');
  if (form.length) {
    const { action, params } = serializeForm($, form, url);
    params.set(inputName, appIdStr);
    // Look for "Start Extraction" submit button
    const startBtn = form.find('button, input[type="submit"]').filter(function () {
      const t = ($(this).text() || $(this).val() || '').toLowerCase();
      return t.includes('start') || t.includes('extract') || t.includes('search') ||
             t.includes('开始') || t.includes('提取') || t.includes('搜索') || t.includes('submit');
    }).first();
    if (startBtn.length && startBtn.attr('name')) {
      params.set(startBtn.attr('name'), startBtn.val() || startBtn.text().trim());
    }
    const method = (form.attr('method') || 'POST').toUpperCase();
    log('step5: submitting form →', action);
    const res = method === 'GET'
      ? await httpGet(`${action}?${params}`, jar)
      : await httpPost(action, params, jar);
    $ = cheerio.load(res.body);
    url = res.url;
  } else {
    // No form — try clicking a "Start Extraction" button separately
    const startBtn = findClickable($, [
      'Start Extraction', 'Start', 'Extract', '开始提取', '开始', '提取',
    ]);
    if (startBtn) {
      const res = await clickEl($, startBtn, jar, url, { [inputName]: appIdStr });
      if (res) { $ = res.$; url = res.url; }
    } else {
      // Direct POST with the app ID
      log('step5: no form or button, direct POST');
      const res = await httpPost(url, { [inputName]: appIdStr }, jar);
      $ = cheerio.load(res.body);
      url = res.url;
    }
  }

  // Check if code appeared already (short flow)
  let code = findCodeInPage($);
  if (code) { log('step5: code found immediately after extraction'); return code; }

  // ── Step 6: Read extracted data (GameId, SteamId, BillData) ──
  log('step6: reading extracted data from results');
  const extractedData = extractExtractionData($);
  if (extractedData) {
    log('step6: extracted data:', JSON.stringify(extractedData));
  } else {
    log('step6: no structured data found, will rely on Fill Info button');
  }

  // ── Step 7: Fill out the Authorization Code Generation form ──
  // First try the "Fill Info" button which auto-populates the form
  log('step7: looking for Fill Info button');
  const fillBtn = findClickable($, [
    'Fill Info', 'Fill', 'Fill Out', 'Auto Fill', 'Autofill',
    '填充信息', '填充', '填写', '自动填充', '自动填写', '自动',
  ]);
  if (fillBtn) {
    log('step7: found Fill Info button, clicking');
    const res = await clickEl($, fillBtn, jar, url, extractedData || {});
    if (res) { $ = res.$; url = res.url; }
    code = findCodeInPage($);
    if (code) { log('step7: code found after fill'); return code; }
  } else if (extractedData) {
    // Manually fill form fields with extracted data
    log('step7: no Fill button, trying to fill form fields manually');
    const genForm = $('form').filter(function () {
      const t = ($(this).text() || '').toLowerCase();
      return t.includes('authorization') || t.includes('generate') || t.includes('submit') ||
             t.includes('授权') || t.includes('生成') || t.includes('提交');
    }).first();
    if (genForm.length) {
      const { action, params } = serializeForm($, genForm, url);
      // Fill in extracted data into matching fields
      for (const [key] of params) {
        const lower = key.toLowerCase();
        if ((lower.includes('game') || lower.includes('app')) && extractedData.GameId) params.set(key, extractedData.GameId);
        if (lower.includes('steam') && extractedData.SteamId) params.set(key, extractedData.SteamId);
        if (lower.includes('bill') && extractedData.BillData) params.set(key, extractedData.BillData);
      }
      log('step7: submitting filled form →', action);
      const res = await httpPost(action, params, jar);
      $ = cheerio.load(res.body);
      url = res.url;
      code = findCodeInPage($);
      if (code) { log('step7: code found after manual fill'); return code; }
    }
  } else {
    log('step7: no Fill button and no extracted data');
  }

  // ── Step 8: Click "Submit the Authorization and Generate the Authorization Code" ──
  log('step8: looking for Submit/Generate button');
  const submitBtn = findClickable($, [
    'Submit the Authorization and Generate', 'Submit the Authorization',
    'Generate the Authorization Code', 'Generate Authorization Code',
    'Submit Authorization', 'Generate Code',
    'Submit', 'Generate', 'Authorize',
    '提交授权', '生成授权码', '提交', '生成', '授权',
    'Confirm', '确认', 'OK', '确定',
  ]);
  if (submitBtn) {
    log('step8: found, clicking');
    const res = await clickEl($, submitBtn, jar, url);
    if (res) { $ = res.$; url = res.url; }
    code = findCodeInPage($);
    if (code) { log('step8: code found — SUCCESS'); return code; }
  } else {
    log('step8: no Submit button found, trying all forms');
    // Try submitting every form on the page
    for (const formEl of $('form').toArray()) {
      const f = $(formEl);
      const { action, params } = serializeForm($, f, url);
      for (const [key] of params) {
        if (/app|game|id/i.test(key)) params.set(key, appIdStr);
      }
      try {
        const res = await httpPost(action, params, jar);
        const $r = cheerio.load(res.body);
        code = findCodeInPage($r);
        if (code) { log('step8: code found via form brute-force'); return code; }
      } catch {}
    }
  }

  // ── Step 9: API fallback ──
  log('step9: trying API endpoints');
  for (const path of ['/api/extract', '/api/generate', '/api/authorize', '/api/token']) {
    try {
      const apiUrl = new URL(path, drmConfig.baseUrl).href;
      const res = await httpPost(apiUrl, { appid: appIdStr, app_id: appIdStr, gameid: appIdStr }, jar);
      try {
        const j = JSON.parse(res.body);
        const v = j.code || j.auth_code || j.token || j.result || j.authorization_code || j.data?.code;
        if (typeof v === 'string' && v.length >= MIN_CODE_LENGTH) { log('step9: code from API', path); return v; }
      } catch {}
      code = findCodeInPage(cheerio.load(res.body));
      if (code) return code;
    } catch {}
  }

  // ── Step 10: AI-assisted fallback ──
  if (process.env.GROQ_API_KEY) {
    log('step10: trying AI-assisted extraction');
    try {
      const aiResult = await aiAssistExtraction($, url, jar, appIdStr);
      if (aiResult) { log('step10: AI found code'); return aiResult; }
    } catch (e) {
      log('step10: AI error:', e?.message);
    }
  }

  const failPageText = snippet($('body').text(), 500);
  log('FAILED — page text:', failPageText);
  throw new DrmError(
    'Could not extract authorization code. The site may have changed.',
    { step: 'drmExtractCode:final', url, bodySnippet: snippet($('body').text(), 200) }
  );
}

/** Describe the current page state for the AI agent. */
function describePageForAI($, pageUrl) {
  const pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
  const forms = [];
  $('form').each(function (i) {
    const action = $(this).attr('action') || '';
    const method = $(this).attr('method') || 'POST';
    const inputs = [];
    $(this).find('input, select, textarea, button').each(function () {
      const tag = this.tagName;
      const name = $(this).attr('name') || '';
      const type = $(this).attr('type') || '';
      const value = ($(this).val() || '').slice(0, 80);
      const text = ($(this).text() || '').trim().slice(0, 80);
      inputs.push(`<${tag} name="${name}" type="${type}" value="${value}"${text ? ` text="${text}"` : ''}>`);
    });
    forms.push(`Form[${i}] action="${action}" method="${method}":\n  ${inputs.join('\n  ')}`);
  });
  const links = [];
  $('a[href]').each(function () {
    const href = $(this).attr('href') || '';
    const text = ($(this).text() || '').trim().slice(0, 80);
    if (href && href !== '#' && text) links.push(`[${text}](${href})`);
  });
  const buttons = [];
  $('button, input[type="submit"], [role="button"]').each(function () {
    const text = ($(this).text() || $(this).val() || '').trim().slice(0, 80);
    if (text) buttons.push(text);
  });
  return { pageText, forms, links: links.slice(0, 25), buttons };
}

/** Call Groq LLM and return the response text. */
async function askAI(apiKey, messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL?.trim() || 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 300,
        temperature: 0,
        messages,
      }),
    });
    if (!res.ok) { log('AI: Groq error', res.status); return null; }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    log('AI request error:', e?.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const AI_SYSTEM_PROMPT = `You are an autonomous web navigation agent for drm.steam.run, a Steam DRM authorization code generation site.
Your goal: navigate the site to generate a 6-character alphanumeric authorization code for a given Steam App ID.

The typical site flow is:
1. Dashboard → click "Authorization Code Generation"
2. Click "Extract Authorization"
3. Enter Game/App ID in the input field → click "Start Extraction"
4. Read extracted data (GameId, SteamId, BillData)
5. Fill the authorization form (or click "Fill Info") → Submit
6. Read the 6-character code from the result

You will be shown the current page state (URL, text, forms, links, buttons).
Respond with EXACTLY ONE action per message:
- CODE: <the_code> — if you can see the final 6-char alphanumeric auth code on the page
- SUBMIT_FORM: <index> [field=value, field=value] — submit form by 0-based index, optionally setting field values
- FOLLOW_LINK: <href> — navigate to a link
- CLICK_BUTTON: <exact_button_text> — click a button by its visible text
- FILL_AND_SUBMIT: <form_index> <field_name>=<value> [field_name=value ...] — fill specific fields then submit
- GIVE_UP: <reason> — if you're stuck and can't proceed

Important:
- Always fill app/game ID fields with the target App ID when submitting forms
- Look for the code in page text, form values, data attributes, or result sections
- The code is exactly 6 alphanumeric characters (letters and digits)
- If you see extraction results (GameId, SteamId, BillData), look for a form to fill them into
- Be decisive — pick the most promising action`;

/**
 * Multi-step AI agent that autonomously navigates drm.steam.run to extract an auth code.
 * Runs up to MAX_AI_STEPS iterations, each time analyzing the page and deciding the next action.
 */
const MAX_AI_STEPS = 10;

async function aiAssistExtraction($, pageUrl, jar, appIdStr) {
  const cheerio = await import('cheerio');
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  let currentUrl = pageUrl;
  let current$ = $;
  const conversationHistory = [{ role: 'system', content: AI_SYSTEM_PROMPT }];

  for (let step = 0; step < MAX_AI_STEPS; step++) {
    // Check for code on current page before asking AI
    const immediateCode = findCodeInPage(current$);
    if (immediateCode) {
      log(`AI step ${step}: code found on page before asking AI`);
      return immediateCode;
    }

    const { pageText, forms, links, buttons } = describePageForAI(current$, currentUrl);
    const userMsg = [
      `Step ${step + 1}/${MAX_AI_STEPS} — Target App ID: ${appIdStr}`,
      `URL: ${currentUrl}`,
      `Page text: ${pageText.slice(0, 2500)}`,
      '',
      forms.length ? `Forms:\n${forms.join('\n\n')}` : 'Forms: (none)',
      '',
      links.length ? `Links:\n${links.join('\n')}` : 'Links: (none)',
      '',
      buttons.length ? `Buttons: ${buttons.join(' | ')}` : 'Buttons: (none)',
    ].join('\n');

    conversationHistory.push({ role: 'user', content: userMsg });
    log(`AI step ${step}: asking AI (url=${currentUrl})`);

    const answer = await askAI(apiKey, conversationHistory);
    if (!answer) { log(`AI step ${step}: no response`); break; }
    log(`AI step ${step}: answer = ${answer}`);
    conversationHistory.push({ role: 'assistant', content: answer });

    // Parse action
    try {
      if (answer.startsWith('CODE:')) {
        const code = answer.slice(5).trim().replace(/[^A-Za-z0-9]/g, '');
        if (code.length >= MIN_CODE_LENGTH) {
          log(`AI step ${step}: extracted code`);
          return code;
        }
      }

      if (answer.startsWith('GIVE_UP:')) {
        log(`AI step ${step}: gave up — ${answer.slice(8).trim()}`);
        break;
      }

      if (answer.startsWith('SUBMIT_FORM:')) {
        const rest = answer.slice(12).trim();
        const idxMatch = rest.match(/^(\d+)/);
        if (!idxMatch) continue;
        const idx = parseInt(idxMatch[1], 10);
        const formEls = current$('form').toArray();
        if (!formEls[idx]) { log(`AI step ${step}: form index ${idx} not found`); continue; }
        const f = current$(formEls[idx]);
        const { action, params } = serializeForm(current$, f, currentUrl);
        // Auto-fill app ID fields
        for (const [key] of params) {
          if (/app|game|id/i.test(key) && !params.get(key)) params.set(key, appIdStr);
        }
        // Parse optional field overrides: [field=value, field=value]
        const overrides = rest.match(/\[([^\]]+)\]/);
        if (overrides) {
          for (const pair of overrides[1].split(',')) {
            const [k, ...vParts] = pair.split('=');
            if (k?.trim() && vParts.length) params.set(k.trim(), vParts.join('=').trim());
          }
        }
        log(`AI step ${step}: submitting form ${idx} → ${action}`);
        const fRes = await httpPost(action, params, jar);
        current$ = cheerio.load(fRes.body);
        currentUrl = fRes.url;
        continue;
      }

      if (answer.startsWith('FILL_AND_SUBMIT:')) {
        const rest = answer.slice(16).trim();
        const idxMatch = rest.match(/^(\d+)/);
        if (!idxMatch) continue;
        const idx = parseInt(idxMatch[1], 10);
        const formEls = current$('form').toArray();
        if (!formEls[idx]) continue;
        const f = current$(formEls[idx]);
        const { action, params } = serializeForm(current$, f, currentUrl);
        // Parse field=value pairs
        const pairs = rest.slice(idxMatch[0].length).trim().split(/\s+/);
        for (const pair of pairs) {
          const eq = pair.indexOf('=');
          if (eq > 0) params.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
        // Auto-fill app ID fields
        for (const [key] of params) {
          if (/app|game|id/i.test(key) && !params.get(key)) params.set(key, appIdStr);
        }
        log(`AI step ${step}: fill+submit form ${idx} → ${action}`);
        const fRes = await httpPost(action, params, jar);
        current$ = cheerio.load(fRes.body);
        currentUrl = fRes.url;
        continue;
      }

      if (answer.startsWith('FOLLOW_LINK:')) {
        const href = answer.slice(12).trim();
        try {
          const fullUrl = new URL(href, currentUrl).href;
          log(`AI step ${step}: following link → ${fullUrl}`);
          const linkRes = await httpGet(fullUrl, jar);
          current$ = cheerio.load(linkRes.body);
          currentUrl = linkRes.url;
        } catch (e) {
          log(`AI step ${step}: link error: ${e?.message}`);
        }
        continue;
      }

      if (answer.startsWith('CLICK_BUTTON:')) {
        const btnText = answer.slice(13).trim();
        const b = findClickable(current$, [btnText]);
        if (b) {
          log(`AI step ${step}: clicking "${btnText}"`);
          const r = await clickEl(current$, b, jar, currentUrl, { appid: appIdStr });
          if (r) { current$ = r.$; currentUrl = r.url; }
        } else {
          log(`AI step ${step}: button "${btnText}" not found`);
        }
        continue;
      }

      log(`AI step ${step}: unrecognized action`);
    } catch (e) {
      log(`AI step ${step}: action error: ${e?.message}`);
    }
  }

  // Final check
  return findCodeInPage(current$);
}

/* ---------- retry wrapper ---------- */

const MAX_RETRIES = 2;
const RETRY_DELAYS = [3000, 8000]; // exponential-ish backoff

/**
 * Wrap drmExtractCode with retry logic for transient failures
 * (network timeouts, rate limits, temporary server errors).
 */
async function drmExtractCodeWithRetry(jar, gameAppId) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await drmExtractCode(jar, gameAppId);
    } catch (err) {
      lastErr = err;
      const msg = (err?.message || '').toLowerCase();
      // Only retry on transient errors, not on permanent failures
      const isTransient = msg.includes('timeout') || msg.includes('timed out') ||
        msg.includes('rate limit') || msg.includes('429') ||
        msg.includes('econnreset') || msg.includes('econnrefused') ||
        msg.includes('socket hang up') || msg.includes('network') ||
        msg.includes('fetch failed');
      if (!isTransient || attempt >= MAX_RETRIES) break;
      const delay = RETRY_DELAYS[attempt] || 5000;
      log(`drmExtractCode: attempt ${attempt + 1} failed (${err?.message}), retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
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
        const code = await drmExtractCodeWithRetry(jar, appId);
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
    if (err instanceof DrmError) {
      log('generateAuthCode: DRM login failed:', err.toDiagnostic());
      throw new DrmError(
        `Could not login to drm.steam.run. ${err.message}`,
        { ...err, step: `generateAuthCode>${err.step}`, cause: err }
      );
    }
    log('generateAuthCode: DRM login failed (generic):', err?.message);
    throw new DrmError(
      `Could not login to drm.steam.run. ${err?.message || 'Unknown error'}`,
      { step: 'generateAuthCode:drmLogin', cause: err }
    );
  }

  // 5. Extract the code
  const code = await drmExtractCodeWithRetry(jar, appId);
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

/**
 * Auto-find a Steam account in the database that owns a given game,
 * then generate the auth code using that account's credentials.
 *
 * This is the main entry point for normal user requests — the bot
 * searches its own DB for any activator account that has the game
 * registered with method='automated', decrypts the credentials,
 * and runs the full flow.
 *
 * @param {number} gameAppId
 * @param {string} [confirmCode] - Optional 2FA code
 * @returns {Promise<string>} The authorization code
 */
export async function generateAuthCodeForRequest(gameAppId, confirmCode = null) {
  const { getActivatorsForGame, getCredentials: getCredsFromDb } = await import('./activators.js');

  const appId = Number(gameAppId);
  if (!Number.isInteger(appId) || appId < 1) throw new Error('Invalid game App ID.');

  // Find all activators that have this game with automated method
  const activators = getActivatorsForGame(appId, true);
  const automated = activators.filter(a => a.method === 'automated' && a.steam_username);

  if (automated.length === 0) {
    throw new Error('No automated Steam account found for this game. An activator must add it with `/add` first.');
  }

  // Try each automated account until one succeeds
  let lastError = null;
  for (const row of automated) {
    const credentials = getCredsFromDb(row.activator_id, appId);
    if (!credentials?.username || !credentials?.password) {
      log(`generateAuthCodeForRequest: skipping ${row.steam_username} — credentials missing or unreadable`);
      continue;
    }

    log(`generateAuthCodeForRequest: trying account ${credentials.username} for app ${appId}`);
    try {
      const code = await generateAuthCode(appId, credentials, confirmCode);
      return code;
    } catch (err) {
      lastError = err;
      log(`generateAuthCodeForRequest: account ${credentials.username} failed:`, err?.message);
      // If it's a 2FA prompt, propagate immediately — user needs to provide the code
      if (err?.message?.includes('Confirmation code')) throw err;
      // Otherwise try next account
    }
  }

  throw lastError || new Error('All automated accounts failed to generate a code for this game.');
}
