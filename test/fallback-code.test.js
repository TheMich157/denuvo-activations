#!/usr/bin/env node

/**
 * Test fallback code generation when Steam API is not available
 */

import { generateAuthCodeFromTicket } from '../src/services/steamTicketGenerator.js';

console.log('🧪 Testing Fallback Code Generation');
console.log('=====================================\n');

async function testFallbackCode() {
  try {
    // This should fail with Steam API error but generate fallback code
    const appId = 570; // Dota 2
    console.log(`Testing fallback code generation for AppID: ${appId}`);
    
    const authCode = await generateAuthCodeFromTicket(appId);
    
    console.log(`✅ Generated fallback auth code: ${authCode}`);
    console.log(`✅ Code length: ${authCode.length} characters`);
    console.log(`✅ Code format: ${/^[A-Z0-9]{6}$/.test(authCode) ? 'VALID' : 'INVALID'}`);
    
  } catch (error) {
    console.log('❌ Fallback generation failed:', error.message);
  }
}

testFallbackCode();
