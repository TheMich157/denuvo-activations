// Steam Ticket Generator Configuration

export const steamTicketConfig = {
  // Path to the steam_ticket_generator.exe binary
  binaryPath: process.env.STEAM_TICKET_GENERATOR_PATH || './bin/steam-ticket-generator.exe',
  
  // Path to steam_api64.dll
  dllPath: process.env.STEAM_API_DLL_PATH || './bin/steam_api64.dll',
  
  // Timeout for ticket generation (milliseconds)
  timeoutMs: parseInt(process.env.STEAM_TICKET_TIMEOUT_MS || '30000', 10),
  
  // Enable/disable Steam ticket generator as fallback
  enabled: process.env.STEAM_TICKET_ENABLED !== 'false',
  
  // Priority: 'primary' or 'fallback'
  mode: process.env.STEAM_TICKET_MODE || 'fallback',
  
  // Maximum retry attempts
  maxRetries: parseInt(process.env.STEAM_TICKET_MAX_RETRIES || '2', 10),
  
  // Steam account management
  accounts: {
    // List of Steam accounts that can be used for ticket generation
    // Format: { username: string, password: string, priority: number }
    enabled: process.env.STEAM_MULTI_ACCOUNT === 'true',
    autoRotate: process.env.STEAM_AUTO_ROTATE === 'true',
    maxDailyUsage: parseInt(process.env.STEAM_MAX_DAILY_USAGE || '100', 10),
  },
  
  // Logging and monitoring
  logging: {
    enabled: process.env.STEAM_TICKET_LOGGING !== 'false',
    level: process.env.STEAM_TICKET_LOG_LEVEL || 'info',
    saveTickets: process.env.STEAM_SAVE_TICKETS === 'true',
  },
  
  // Error handling
  errorHandling: {
    retryOnTimeout: process.env.STEAM_RETRY_ON_TIMEOUT !== 'false',
    fallbackToDrm: process.env.STEAM_FALLBACK_TO_DRM !== 'false',
    notifyOnFailure: process.env.STEAM_NOTIFY_ON_FAILURE === 'true',
  },
};

// Default Steam account configuration (for development)
export const defaultSteamAccounts = [
  {
    username: process.env.STEAM_USERNAME_1 || '',
    password: process.env.STEAM_PASSWORD_1 || '',
    priority: 1,
  },
  {
    username: process.env.STEAM_USERNAME_2 || '',
    password: process.env.STEAM_PASSWORD_2 || '',
    priority: 2,
  },
];

// Helper function to get current configuration
export function getSteamTicketConfig() {
  return {
    ...steamTicketConfig,
    binaryPath: steamTicketConfig.binaryPath.startsWith('./') 
      ? steamTicketConfig.binaryPath 
      : `./${steamTicketConfig.binaryPath}`,
    dllPath: steamTicketConfig.dllPath.startsWith('./') 
      ? steamTicketConfig.dllPath 
      : `./${steamTicketConfig.dllPath}`,
  };
}

// Helper function to validate configuration
export function validateSteamTicketConfig() {
  const config = getSteamTicketConfig();
  const issues = [];
  
  if (!config.enabled) {
    return { valid: true, issues: ['Steam ticket generator is disabled'] };
  }
  
  if (!config.binaryPath) {
    issues.push('Binary path not configured');
  }
  
  if (!config.dllPath) {
    issues.push('DLL path not configured');
  }
  
  if (config.timeoutMs < 5000) {
    issues.push('Timeout too short (minimum 5000ms)');
  }
  
  if (config.maxRetries < 0 || config.maxRetries > 10) {
    issues.push('Invalid retry count (0-10 allowed)');
  }
  
  return {
    valid: issues.length === 0,
    issues,
  };
}
