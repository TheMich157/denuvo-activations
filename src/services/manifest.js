import { config } from '../config.js';

const BASE_URL = 'https://generator.ryuu.lol/secure_download';
const LUA_BASE_URL = 'https://generator.ryuu.lol/resellerlua';
const STEAM_STORE_API = 'https://store.steampowered.com/api/appdetails';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB Discord file limit

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
 * Fetch a game manifest from the Ryuu API.
 * @param {string|number} appId - Steam app ID
 * @returns {Promise<{ type: 'file', buffer: Buffer, filename: string } | { type: 'json', data: object }>}
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
    if (response.status === 404) throw new Error(`No manifest found for App ID **${id}**. The game may not exist or is not supported.`);
    if (response.status === 401 || response.status === 403) throw new Error('Authentication failed — check RYUU_API_KEY.');
    if (response.status === 429) throw new Error('Rate limited by the API. Please try again later.');
    throw new Error(`API error ${response.status}: ${text || response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';

  // If JSON response, return parsed data
  if (contentType.includes('application/json')) {
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    const result = { type: 'json', data };
    manifestCache.set(id, { data: result, ts: Date.now() });
    return result;
  }

  // Otherwise treat as binary file download
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw new Error('API returned an empty file. The manifest may not be available for this game.');
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`Manifest file is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Discord limit is 25 MB.`);
  }

  // Try to extract filename from content-disposition header
  const contentDisposition = response.headers.get('content-disposition') || '';
  let filename = `manifest_${id}.manifest`;
  const match = contentDisposition.match(/filename="?([^";\n]+)"?/i);
  if (match) filename = match[1].trim();

  const result = { type: 'file', buffer, filename };
  manifestCache.set(id, { data: result, ts: Date.now() });
  return result;
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
