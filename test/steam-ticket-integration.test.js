#!/usr/bin/env node

/**
 * Steam Ticket Generator Integration Test
 * 
 * This test verifies that the Steam ticket generator integration
 * is working correctly without actually generating tickets.
 */

import { validateSteamTicketConfig } from '../src/config/steamTicket.config.js';
import { isTicketGeneratorAvailable } from '../src/services/steamTicketGenerator.js';
import { generateAuthCodeFromSteamTicket } from '../src/services/drm.js';

console.log('🧪 Steam Ticket Generator Integration Test');
console.log('=======================================\n');

// Test 1: Configuration validation
console.log('1. Testing configuration validation...');
try {
  const validation = validateSteamTicketConfig();
  if (validation.valid) {
    console.log('✅ Configuration is valid');
  } else {
    console.log('⚠️  Configuration issues:');
    validation.issues.forEach(issue => console.log(`   - ${issue}`));
  }
} catch (error) {
  console.log('❌ Configuration validation failed:', error.message);
}

// Test 2: Binary availability
console.log('\n2. Testing binary availability...');
try {
  const available = isTicketGeneratorAvailable();
  if (available) {
    console.log('✅ Steam ticket generator binaries are available');
  } else {
    console.log('⚠️  Steam ticket generator binaries not found');
    console.log('   Run: node scripts/setup-steam-ticket.js');
  }
} catch (error) {
  console.log('❌ Binary availability check failed:', error.message);
}

// Test 3: Import test
console.log('\n3. Testing function imports...');
try {
  // Test that the function can be imported (doesn't execute it)
  const func = generateAuthCodeFromSteamTicket;
  if (typeof func === 'function') {
    console.log('✅ Functions imported successfully');
  } else {
    console.log('❌ Function import failed');
  }
} catch (error) {
  console.log('❌ Function import test failed:', error.message);
}

// Test 4: Configuration values
console.log('\n4. Testing configuration values...');
try {
  const { steamTicketConfig } = await import('../src/config/steamTicket.config.js');
  console.log('✅ Configuration loaded:');
  console.log(`   - Enabled: ${steamTicketConfig.enabled}`);
  console.log(`   - Mode: ${steamTicketConfig.mode}`);
  console.log(`   - Timeout: ${steamTicketConfig.timeoutMs}ms`);
  console.log(`   - Max retries: ${steamTicketConfig.maxRetries}`);
} catch (error) {
  console.log('❌ Configuration values test failed:', error.message);
}

// Test 5: Error handling
console.log('\n5. Testing error handling...');
try {
  // This should fail gracefully if binaries don't exist
  await generateAuthCodeFromSteamTicket(12345);
  console.log('❌ Expected error was not thrown');
} catch (error) {
  if (error.message.includes('not found') || error.message.includes('timeout')) {
    console.log('✅ Error handling works correctly');
  } else {
    console.log('⚠️  Unexpected error:', error.message);
  }
}

console.log('\n🎉 Integration test completed!');
console.log('\n📋 Next steps:');
console.log('1. Download Steam ticket generator binaries');
console.log('2. Place them in ./bin/ directory');
console.log('3. Start Steam client and log in');
console.log('4. Test with a real activation request');
