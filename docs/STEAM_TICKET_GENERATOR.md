# Steam Ticket Generator Integration

This document explains how to set up and use the Steam Ticket Generator as an alternative to drm.steam.run.

## Overview

The Steam Ticket Generator provides a local, free alternative to drm.steam.run by using the denuvosanctuary/steam-ticket-generator project. It generates Steam EncryptedAppTickets directly from a logged-in Steam client.

## Setup Instructions

### 1. Download the Steam Ticket Generator

1. Go to: https://github.com/denuvosanctuary/steam-ticket-generator/releases
2. Download the latest release for your platform (Windows/Linux)
3. Extract the files to your bot's `bin/` directory

### 2. Required Files

You need these files in your `bin/` directory:
- `steam_ticket_generator.exe` (Windows) or `steam_ticket_generator` (Linux)
- `steam_api64.dll` (Windows) or `libsteam_api.so` (Linux)

### 3. Environment Variables

Configure these environment variables:

```bash
# Enable/disable the Steam ticket generator
STEAM_TICKET_ENABLED=true

# Set mode: 'primary' (try first) or 'fallback' (try only if drm.steam.run fails)
STEAM_TICKET_MODE=fallback

# Paths to binaries (if not in ./bin/)
STEAM_TICKET_GENERATOR_PATH=./bin/steam_ticket_generator.exe
STEAM_API_DLL_PATH=./bin/steam_api64.dll

# Timeout in milliseconds
STEAM_TICKET_TIMEOUT_MS=30000

# Maximum retry attempts
STEAM_TICKET_MAX_RETRIES=2

# Error handling
STEAM_FALLBACK_TO_DRM=true
STEAM_RETRY_ON_TIMEOUT=true
```

### 4. Steam Client Setup

1. Install and run Steam on the server
2. Log in with the Steam account you want to use
3. Keep Steam running in the background

## Configuration Options

### Mode Settings

- **Primary Mode**: `STEAM_TICKET_MODE=primary`
  - Tries Steam ticket generator first
  - Falls back to drm.steam.run if it fails (when `STEAM_FALLBACK_TO_DRM=true`)

- **Fallback Mode**: `STEAM_TICKET_MODE=fallback` (default)
  - Uses drm.steam.run first
  - Falls back to Steam ticket generator if drm.steam.run fails

### Error Handling

- `STEAM_FALLBACK_TO_DRM=true` - Fall back to drm.steam.run if Steam ticket generator fails
- `STEAM_RETRY_ON_TIMEOUT=true` - Retry on timeout errors
- `STEAM_NOTIFY_ON_FAILURE=true` - Send notifications when Steam ticket generator fails

## Usage Examples

### Basic Setup

```bash
# Enable Steam ticket generator as fallback
export STEAM_TICKET_ENABLED=true
export STEAM_TICKET_MODE=fallback
export STEAM_FALLBACK_TO_DRM=true

# Start the bot
node index.js
```

### Primary Mode Setup

```bash
# Use Steam ticket generator as primary method
export STEAM_TICKET_ENABLED=true
export STEAM_TICKET_MODE=primary
export STEAM_FALLBACK_TO_DRM=true

# Start the bot
node index.js
```

## Integration with Bot

The bot automatically uses the Steam ticket generator based on your configuration:

1. **Automatic Fallback**: If drm.steam.run fails, the bot tries the Steam ticket generator
2. **Primary Mode**: The bot tries Steam ticket generator first, then falls back
3. **Error Handling**: Proper error messages and logging for debugging

## Troubleshooting

### Common Issues

1. **"Steam ticket generator not found"**
   - Check if the binary exists in the specified path
   - Verify the `STEAM_TICKET_GENERATOR_PATH` environment variable

2. **"steam_api64.dll not found"**
   - Download the Steamworks SDK from Steam partner site
   - Extract `steam_api64.dll` to your `bin/` directory

3. **"Ticket generator timeout"**
   - Increase `STEAM_TICKET_TIMEOUT_MS`
   - Make sure Steam client is running and logged in

4. **"Failed to parse ticket output"**
   - Check if the Steam ticket generator is working manually
   - Verify the Steam account is logged in properly

### Debug Logging

Enable debug logging to troubleshoot issues:

```bash
export STEAM_TICKET_LOGGING=true
export STEAM_TICKET_LOG_LEVEL=debug
```

### Manual Testing

Test the Steam ticket generator manually:

```bash
cd bin
./steam_ticket_generator.exe
# Enter the AppID when prompted
# Check if it outputs SteamID and Ticket
```

## Security Considerations

- **Steam Account Security**: Keep your Steam account credentials secure
- **Local Only**: The Steam ticket generator runs locally, no external services
- **Educational Use**: This is intended for educational and research purposes
- **Terms of Service**: Be aware of Steam's Terms of Service regarding automation

## Performance

- **Speed**: Generally faster than drm.steam.run (no network latency)
- **Reliability**: More reliable as it doesn't depend on external services
- **Rate Limits**: No external rate limits, but Steam may have its own limits

## Monitoring

Monitor the Steam ticket generator usage:

```javascript
// Check if Steam ticket generator is available
import { isTicketGeneratorAvailable } from './src/services/steamTicketGenerator.js';

if (isTicketGeneratorAvailable()) {
  console.log('Steam ticket generator is ready');
} else {
  console.log('Steam ticket generator not available');
}
```

## Support

For issues with the Steam ticket generator itself:
- Check the GitHub repository: https://github.com/denuvosanctuary/steam-ticket-generator
- Review the issues and discussions
- For bot integration issues, check the bot logs

## Migration Guide

To migrate from drm.steam.run to Steam ticket generator:

1. Set up the Steam ticket generator following the instructions above
2. Set `STEAM_TICKET_MODE=primary` to use it as the main method
3. Keep `STEAM_FALLBACK_TO_DRM=true` for reliability
4. Test with a few requests before full deployment
5. Monitor logs for any issues

## Advanced Configuration

### Multiple Steam Accounts

For advanced setups with multiple Steam accounts:

```bash
# Enable multi-account mode
export STEAM_MULTI_ACCOUNT=true
export STEAM_AUTO_ROTATE=true
export STEAM_MAX_DAILY_USAGE=100

# Configure multiple accounts
export STEAM_USERNAME_1=account1
export STEAM_PASSWORD_1=password1
export STEAM_USERNAME_2=account2
export STEAM_PASSWORD_2=password2
```

### Custom Ticket Processing

For custom ticket processing or integration with gbe_fork:

```javascript
import { generateSteamTicket } from './src/services/steamTicketGenerator.js';

const { steamId, ticket } = await generateSteamTicket(appId);
// Use the ticket with gbe_fork or other services
```
