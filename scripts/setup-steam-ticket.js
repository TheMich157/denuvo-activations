#!/usr/bin/env node

/**
 * Steam Ticket Generator Setup Script
 * 
 * This script helps set up the Steam ticket generator integration
 * by downloading necessary files and configuring environment variables.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const binDir = join(rootDir, 'bin');

console.log('🚀 Steam Ticket Generator Setup Script');
console.log('=====================================\n');

// Ensure bin directory exists
if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
  console.log('✅ Created bin directory');
}

// Check if files already exist
const generatorExists = existsSync(join(binDir, 'steam_ticket_generator.exe')) || 
                        existsSync(join(binDir, 'steam_ticket_generator'));
const dllExists = existsSync(join(binDir, 'steam_api64.dll')) || 
                  existsSync(join(binDir, 'libsteam_api.so'));

if (generatorExists && dllExists) {
  console.log('✅ Steam ticket generator files already exist');
} else {
  console.log('📥 Downloading Steam ticket generator...');
  console.log('Please download manually from:');
  console.log('https://github.com/denuvosanctuary/steam-ticket-generator/releases');
  console.log('');
  console.log('Required files:');
  console.log('- steam_ticket_generator.exe (Windows) or steam_ticket_generator (Linux)');
  console.log('- steam_api64.dll (Windows) or libsteam_api.so (Linux)');
  console.log('');
  console.log('Place them in the ./bin/ directory');
}

// Create .env file with Steam ticket generator configuration
const envFile = join(rootDir, '.env');
const envContent = `
# Steam Ticket Generator Configuration
STEAM_TICKET_ENABLED=true
STEAM_TICKET_MODE=fallback
STEAM_TICKET_GENERATOR_PATH=./bin/steam_ticket_generator.exe
STEAM_API_DLL_PATH=./bin/steam_api64.dll
STEAM_TICKET_TIMEOUT_MS=30000
STEAM_TICKET_MAX_RETRIES=2
STEAM_FALLBACK_TO_DRM=true
STEAM_RETRY_ON_TIMEOUT=true
STEAM_TICKET_LOGGING=true
STEAM_TICKET_LOG_LEVEL=info
`;

if (!existsSync(envFile)) {
  writeFileSync(envFile, envContent.trim());
  console.log('✅ Created .env file with Steam ticket generator configuration');
} else {
  console.log('ℹ️  .env file already exists - please add Steam ticket generator config manually');
}

// Test configuration
console.log('\n🔧 Testing configuration...');
try {
  const { validateSteamTicketConfig } = await import('../src/config/steamTicket.config.js');
  const validation = validateSteamTicketConfig();
  
  if (validation.valid) {
    console.log('✅ Configuration is valid');
  } else {
    console.log('⚠️  Configuration issues:');
    validation.issues.forEach(issue => console.log(`   - ${issue}`));
  }
} catch (error) {
  console.log('❌ Configuration test failed:', error.message);
}

// Check Steam client
console.log('\n🎮 Checking Steam client...');
const steamCheck = spawn('cmd', ['/c', 'tasklist | findstr steam.exe'], { shell: true });

steamCheck.on('close', (code) => {
  if (code === 0) {
    console.log('✅ Steam client is running');
  } else {
    console.log('⚠️  Steam client not detected');
    console.log('   Make sure Steam is running and logged in');
  }
});

// Final instructions
console.log('\n📋 Setup Summary:');
console.log('==================');
console.log('1. Download Steam ticket generator from GitHub releases');
console.log('2. Place files in ./bin/ directory');
console.log('3. Start Steam client and log in');
console.log('4. Configure environment variables in .env');
console.log('5. Start the bot with: node index.js');
console.log('');
console.log('📖 For detailed instructions, see: docs/STEAM_TICKET_GENERATOR.md');
console.log('');
console.log('🔗 Useful links:');
console.log('- GitHub: https://github.com/denuvosanctuary/steam-ticket-generator');
console.log('- Releases: https://github.com/denuvosanctuary/steam-ticket-generator/releases');
console.log('- Steamworks SDK: https://partner.steamgames.com/doc/sdk');
