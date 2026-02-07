import { config } from '../config.js';

const BASE_URL = 'https://generator.ryuu.lol/secure_download';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB Discord file limit

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
    return { type: 'json', data };
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

  return { type: 'file', buffer, filename };
}
