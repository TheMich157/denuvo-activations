import { config } from '../config.js';
import { gzipSync, gunzipSync } from 'zlib';
import https from 'https';

const BASE_URL = 'https://generator.ryuu.lol/secure_download';
const LUA_BASE_URL = 'https://generator.ryuu.lol/resellerlua';
const STEAM_STORE_API = 'https://store.steampowered.com/api/appdetails';
const FETCH_TIMEOUT_MS = 90_000;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB Discord file limit
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000]; // ms

// Manifest result cache (avoids hitting Ryuu API for repeated requests)
const manifestCache = new Map();
const luaCache = new Map();
const MANIFEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache for Steam store info (avoid hitting API repeatedly)
const storeCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch game info from the Steam Store API.
 * Returns { name, price, genres, description, headerImage, url } or null on failure.
 */
export async function fetchSteamStoreInfo(appId) {
  const id = parseInt(appId, 10);
  if (!Number.isInteger(id) || id < 1) return null;

  // Check cache
  const cached = storeCache.get(id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${STEAM_STORE_API}?appids=${id}&cc=us&l=english`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DenuvoActivationsBot/1.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json[String(id)];
    if (!entry?.success || !entry.data) return null;

    const d = entry.data;
    const info = {
      name: d.name || `App ${id}`,
      price: d.is_free
        ? 'Free to Play'
        : d.price_overview
          ? `${d.price_overview.final_formatted}`
          : 'N/A',
      genres: (d.genres || []).map(g => g.description).slice(0, 3).join(', ') || 'N/A',
      description: (d.short_description || '').slice(0, 200) || 'No description available.',
      headerImage: d.header_image || null,
      url: `https://store.steampowered.com/app/${id}`,
    };

    storeCache.set(id, { data: info, ts: Date.now() });
    return info;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Raw HTTPS streaming download — bypasses fetch() body size limits.
 * Collects the full response into a Buffer by streaming chunks.
 */
function httpsDownload(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'DenuvoActivationsBot/1.0',
        'Accept-Encoding': 'gzip, deflate',
      },
    }, (res) => {
      // Follow redirects (3xx)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return httpsDownload(res.headers.location, timeoutMs).then(resolve, reject);
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s`));
    });
  });
}

/** Determine if an error/status is retryable. */
function isRetryable(statusCode, errMsg) {
  if (!statusCode) return true; // network error
  if (statusCode === 413) return true; // entity too large — retry with streaming
  if (statusCode === 429) return true; // rate limited
  if (statusCode >= 500) return true; // server error
  if (errMsg && /timeout|ECONNRESET|ETIMEDOUT|socket hang up/i.test(errMsg)) return true;
  return false;
}

/** Sleep helper. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse the raw response from either fetch or httpsDownload into a manifest result.
 */
function parseManifestResponse(statusCode, headers, buffer, id) {
  const contentType = headers['content-type'] || '';
  const contentEncoding = (headers['content-encoding'] || '').toLowerCase();

  // Decompress if server sent gzip/deflate
  let buf = buffer;
  if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
    try { buf = gunzipSync(buf); } catch {}
  }

  // If JSON response, return parsed data
  if (contentType.includes('application/json')) {
    const text = buf.toString('utf-8');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Invalid JSON response from API.`); }
    if (data.error) {
      if (String(data.error).toLowerCase().includes('too large')) {
        return null; // signal to retry with streaming
      }
      throw new Error(data.error);
    }
    return { type: 'json', data };
  }

  if (buf.length === 0) {
    throw new Error('API returned an empty file. The manifest may not be available for this game.');
  }

  // Binary file — compress if needed for Discord
  let compressed = false;
  if (buf.length > MAX_FILE_SIZE) {
    const gzipped = gzipSync(buf, { level: 9 });
    if (gzipped.length <= MAX_FILE_SIZE) {
      buf = gzipped;
      compressed = true;
    } else {
      throw new Error(`Manifest file is too large even after compression (${(gzipped.length / 1024 / 1024).toFixed(1)} MB). Discord limit is 25 MB.`);
    }
  }

  // Extract filename
  const contentDisposition = headers['content-disposition'] || '';
  let filename = `manifest_${id}.manifest`;
  const match = contentDisposition.match(/filename="?([^";\n]+)"?/i);
  if (match) filename = match[1].trim();
  if (compressed) filename += '.gz';

  return { type: 'file', buffer: buf, filename, compressed };
}

/**
 * Fetch a game manifest from the Ryuu API.
 * Uses fetch() first, falls back to raw HTTPS streaming for large files.
 * Retries up to MAX_RETRIES times on transient failures.
 * @param {string|number} appId - Steam app ID
 * @returns {Promise<{ type: 'file', buffer: Buffer, filename: string, compressed?: boolean } | { type: 'json', data: object }>}
 */
export async function fetchManifest(appId) {
  if (!config.ryuuApiKey) {
    throw new Error('RYUU_API_KEY is not configured.');
  }

  const id = parseInt(appId, 10);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error('Invalid App ID — must be a positive integer.');
  }

  // Check cache
  const cached = manifestCache.get(id);
  if (cached && Date.now() - cached.ts < MANIFEST_CACHE_TTL) return cached.data;

  const url = `${BASE_URL}?appid=${id}&auth_code=${encodeURIComponent(config.ryuuApiKey)}`;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
    }

    try {
      let statusCode, headers, buffer;

      if (attempt < 2) {
        // First two attempts: use fetch()
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'DenuvoActivationsBot/1.0',
              'Accept-Encoding': 'gzip, deflate, br',
            },
          });
          statusCode = response.status;
          // Normalize headers to plain object
          headers = {};
          response.headers.forEach((v, k) => { headers[k] = v; });
          buffer = Buffer.from(await response.arrayBuffer());
        } catch (err) {
          clearTimeout(timeout);
          if (err.name === 'AbortError') {
            lastError = new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
          } else {
            lastError = new Error(`Network error: ${err.message}`);
          }
          if (isRetryable(null, err.message)) continue;
          throw lastError;
        } finally {
          clearTimeout(timeout);
        }
      } else {
        // Later attempts: use raw HTTPS streaming (bypasses fetch body limits)
        try {
          const res = await httpsDownload(url, FETCH_TIMEOUT_MS);
          statusCode = res.statusCode;
          headers = res.headers;
          buffer = res.buffer;
        } catch (err) {
          lastError = new Error(`Stream download failed: ${err.message}`);
          if (isRetryable(null, err.message)) continue;
          throw lastError;
        }
      }

      // Handle error status codes
      if (statusCode === 404) throw new Error(`No manifest found for App ID **${id}**. The game may not exist or is not supported.`);
      if (statusCode === 401 || statusCode === 403) throw new Error('Authentication failed — check RYUU_API_KEY.');

      if (statusCode !== 200 && isRetryable(statusCode)) {
        const bodyText = buffer.toString('utf-8').slice(0, 200);
        lastError = new Error(`API error ${statusCode}: ${bodyText}`);
        continue;
      }

      if (statusCode !== 200) {
        const bodyText = buffer.toString('utf-8').slice(0, 200);
        throw new Error(`API error ${statusCode}: ${bodyText}`);
      }

      // Parse the successful response
      const result = parseManifestResponse(statusCode, headers, buffer, id);
      if (result === null) {
        // JSON "too large" error — retry with streaming
        lastError = new Error('API reported manifest too large');
        continue;
      }

      manifestCache.set(id, { data: result, ts: Date.now() });
      return result;

    } catch (err) {
      // Non-retryable errors bubble up immediately
      if (err.message.includes('not found') || err.message.includes('Authentication') ||
          err.message.includes('Discord limit') || err.message.includes('not configured') ||
          err.message.includes('Invalid App ID')) {
        throw err;
      }
      lastError = err;
      if (!isRetryable(null, err.message)) throw err;
    }
  }

  throw lastError || new Error(`Failed to fetch manifest for App ID **${id}** after ${MAX_RETRIES + 1} attempts.`);
}

/**
 * Fetch a Lua manifest script from the Ryuu API.
 * @param {string|number} appId - Steam app ID
 * @returns {Promise<{ script: string }>}
 */
export async function fetchLuaManifest(appId) {
  if (!config.ryuuApiKey) {
    throw new Error('RYUU_API_KEY is not configured.');
  }

  const id = parseInt(appId, 10);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error('Invalid App ID — must be a positive integer.');
  }

  // Check cache
  const cached = luaCache.get(id);
  if (cached && Date.now() - cached.ts < MANIFEST_CACHE_TTL) return cached.data;

  const url = `${LUA_BASE_URL}/${id}?auth_code=${encodeURIComponent(config.ryuuApiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DenuvoActivationsBot/1.0' },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. The API may be slow or unreachable.`);
    }
    throw new Error(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 404) throw new Error(`No Lua manifest found for App ID **${id}**.`);
    if (response.status === 401 || response.status === 403) throw new Error('Authentication failed — check RYUU_API_KEY.');
    if (response.status === 429) throw new Error('Rate limited by the API. Please try again later.');
    throw new Error(`API error ${response.status}: ${text || response.statusText}`);
  }

  const script = await response.text();

  if (!script || !script.trim()) {
    throw new Error('API returned an empty response. No Lua manifest available for this game.');
  }

  const result = { script: script.trim() };
  luaCache.set(id, { data: result, ts: Date.now() });
  return result;
}
