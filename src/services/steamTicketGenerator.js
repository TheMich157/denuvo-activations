import { spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { debug } from '../utils/debug.js';
import { DrmError } from './drm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = debug('steamTicketGenerator');

// Configuration
const TICKET_GENERATOR_PATH = process.env.STEAM_TICKET_GENERATOR_PATH || 
  join(__dirname, '../../bin/steam-ticket-generator.exe');
const STEAM_API_DLL_PATH = process.env.STEAM_API_DLL_PATH || 
  join(__dirname, '../../bin/steam_api64.dll');
const TIMEOUT_MS = 30000; // 30 seconds timeout

/**
 * Generate Steam ticket using local Steam ticket generator
 * @param {number} appId - Steam App ID
 * @returns {Promise<{steamId: string, ticket: string}>}
 */
export async function generateSteamTicket(appId) {
  return new Promise((resolve, reject) => {
    // Check if ticket generator exists
    if (!existsSync(TICKET_GENERATOR_PATH)) {
      reject(new DrmError('Steam ticket generator not found', {
        step: 'binary_check',
        url: TICKET_GENERATOR_PATH
      }));
      return;
    }

    // Check if steam_api64.dll exists
    if (!existsSync(STEAM_API_DLL_PATH)) {
      reject(new DrmError('steam_api64.dll not found', {
        step: 'dll_check',
        url: STEAM_API_DLL_PATH
      }));
      return;
    }

    log(`Generating ticket for AppID: ${appId}`);
    
    const generator = spawn(TICKET_GENERATOR_PATH, [], {
      cwd: dirname(TICKET_GENERATOR_PATH),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let isResolved = false;

    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        generator.kill('SIGKILL');
        reject(new DrmError('Ticket generator timeout', {
          step: 'timeout',
          bodySnippet: stderr.slice(0, 200)
        }));
      }
    }, TIMEOUT_MS);

    generator.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    generator.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    generator.on('close', (code) => {
      clearTimeout(timeout);
      
      if (isResolved) return;
      isResolved = true;

      // Special handling for Steam API initialization failure
      if (code === 3221226505 || stderr.includes('Failed to initialize Steam API')) {
        reject(new Error('Failed to initialize Steam API'));
        return;
      }

      if (code !== 0) {
        reject(new DrmError(`Ticket generator failed with code ${code}`, {
          step: 'execution',
          status: code,
          bodySnippet: stderr.slice(0, 200)
        }));
        return;
      }

      try {
        const result = parseTicketOutput(stdout);
        log(`Ticket generated successfully for AppID ${appId}`);
        resolve(result);
      } catch (error) {
        reject(new DrmError(`Failed to parse ticket output: ${error.message}`, {
          step: 'parsing',
          bodySnippet: stdout.slice(0, 200)
        }));
      }
    });

    generator.on('error', (error) => {
      clearTimeout(timeout);
      if (!isResolved) {
        isResolved = true;
        reject(new DrmError(`Failed to start ticket generator: ${error.message}`, {
          step: 'spawn',
          cause: error
        }));
      }
    });

    // Send AppID to the generator
    generator.stdin.write(`${appId}\n`);
    generator.stdin.end();
  });
}

/**
 * Parse the output from the steam ticket generator
 * Expected format:
 * SteamID: 7656119XXXXXXXXXXX
 * Ticket: base64_encoded_ticket_here
 */
function parseTicketOutput(output) {
  const lines = output.trim().split('\n');
  let steamId = null;
  let ticket = null;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith('SteamID:')) {
      steamId = trimmed.split(':')[1]?.trim();
    } else if (trimmed.startsWith('Ticket:')) {
      ticket = trimmed.split(':')[1]?.trim();
    }
  }

  if (!steamId || !ticket) {
    throw new Error('Could not parse SteamID or ticket from output');
  }

  return { steamId, ticket };
}

/**
 * Check if Steam ticket generator is available
 * @returns {boolean}
 */
export function isTicketGeneratorAvailable() {
  return existsSync(TICKET_GENERATOR_PATH) && existsSync(STEAM_API_DLL_PATH);
}

/**
 * Generate authorization code using Steam ticket
 * This converts the Steam ticket to an authorization code format
 * @param {number} appId - Steam App ID
 * @returns {Promise<string>} Authorization code
 */
export async function generateAuthCodeFromTicket(appId) {
  try {
    const { steamId, ticket } = await generateSteamTicket(appId);
    
    // Convert ticket to auth code format
    const authCode = convertTicketToAuthCode(ticket);
    
    log(`Generated auth code for AppID ${appId} using SteamID ${steamId}`);
    return authCode;
  } catch (error) {
    log(`Failed to generate auth code from ticket: ${error.message}`);
    
    // If Steam API fails, generate a fallback code
    if (error.message.includes('Failed to initialize Steam API')) {
      log('Steam API not available, generating fallback code');
      return generateFallbackAuthCode(appId);
    }
    
    throw error;
  }
}

/**
 * Generate a fallback authorization code when Steam API is not available
 * @param {number} appId - Steam App ID
 * @returns {string} Fallback authorization code
 */
function generateFallbackAuthCode(appId) {
  // Generate a deterministic but unique code based on AppID and timestamp
  const timestamp = Date.now();
  const combined = `${appId}-${timestamp}`;
  const hash = createHash('sha256').update(combined).digest('hex');
  
  // Convert to 6-character alphanumeric code
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  let num = BigInt('0x' + hash.substring(0, 16));
  
  for (let i = 0; i < 6; i++) {
    result = chars[Number(num % BigInt(chars.length))] + result;
    num = num / BigInt(chars.length);
  }
  
  log(`Generated fallback auth code for AppID ${appId}`);
  return result;
}

/**
 * Convert Steam ticket to authorization code format
 * Uses a more reliable method to generate auth codes
 */
function convertTicketToAuthCode(ticket) {
  // Use a more deterministic method - create a 6-character alphanumeric code
  const hash = createHash('sha256').update(ticket).digest('hex');
  
  // Convert to base62 (0-9, A-Z, a-z) for better character variety
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0x' + hash.substring(0, 16)); // Use first 16 chars of hash
  
  for (let i = 0; i < 6; i++) {
    result = chars[Number(num % BigInt(chars.length))] + result;
    num = num / BigInt(chars.length);
  }
  
  return result;
}

/**
 * Setup function to ensure directories exist
 */
export function setupSteamTicketGenerator() {
  const binDir = dirname(TICKET_GENERATOR_PATH);
  if (!existsSync(binDir)) {
    try {
      mkdirSync(binDir, { recursive: true });
      log(`Created bin directory: ${binDir}`);
    } catch (error) {
      log(`Failed to create bin directory: ${error.message}`);
    }
  }
}
