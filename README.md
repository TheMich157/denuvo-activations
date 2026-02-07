# Denuvo Activations Discord Bot

Discord bot for coordinating Denuvo game activations between buyers and activators. See [ARCHITECTURE.md](ARCHITECTURE.md) for full design.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```
   Uses `sql.js` (pure JS, no native build required).

2. **Create `.env`** from `.env.example`. All vars under "Required" must be set or the bot will not start:
   ```
   DISCORD_TOKEN=your_bot_token
   DISCORD_CLIENT_ID=your_application_id
ENCRYPTION_KEY=64_character_hex_string  # 32 bytes, e.g. openssl rand -hex 32
  ACTIVATOR_ROLE_ID=role_id
  TICKET_CATEGORY_ID=category_for_ticket_channels
  DAILY_ACTIVATION_LIMIT=5
  POINTS_PER_ACTIVATION=50
  GUILD_ID=your_guild_id  # Optional: restricts activator-only commands to the Activator role
  LOG_CHANNEL_ID=channel_id  # Optional: audit log channel for activations and ticket events
  TICKET_VERIFY_DEADLINE_MINUTES=5  # Optional: auto-close unverified tickets after N minutes
  TICKET_AUTOCLOSE_CHECK_INTERVAL_MS=60000  # Optional: interval for auto-close check
  ```

3. **Generate encryption key**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. **Run the bot**
   ```bash
   npm start
   ```

## Commands

| Command | Description |
|---------|-------------|
| `/add` | Activators: Register a game (manual or automated with Steam credentials) |
| `/stock` | Activators: Quick-add a game to stock (manual only) |
| `/removestock` | Activators: Remove stock from a game (game + quantity) |
| `/remove` | Activators: Remove a game from your list |
| `/mylist` | Activators: List your registered games + daily limits |
| `/request` | Request a game activation (opens ticket, pings activators) |
| `/balance` | Check your points |
| `/profile` | View your profile (credits, games, method) |
| `/shop` | View point packages |
| `/addpoints` | Activators: Add points to user (for purchases) |
| `/strikes` | Check your strikes (or another user's, Activator only) |
| `/clearestrikes` | Activators: Clear strikes for a user |
| `/ticketpanel` | Activators: Post ticket panel (one globally; replaces previous) |
| `/closepanel` | Activators: Close the ticket panel |
| `/reloadgames` | Activators: Reload game list from list.json |

## Flow

1. **Activator** uses `/stock` or `/add` → add game to stock (5 activations/day per account, counts add together)
2. **Buyer** uses panel or `/request` → ticket created, activators pinged
3. **First activator** to press "I'll handle this" is assigned; ticket becomes visible only to buyer + issuer
4. Issuer goes to drm.steam.run, extracts auth, fills, submits → gets code
5. Issuer presses "Done", enters code → embed sent to ticket with copy button; points to issuer
6. Or "Invalid token" → strike to issuer; "Call activator" pings activators

## Automated Auth Code Generation (drm.steam.run)

Optional: `npm install playwright` to enable automated code generation for activators with stored credentials.

- Config: `src/config/drm.config.js` — adjust selectors if the site changes
- Env: `DRM_BASE_URL`, `DRM_TIMEOUT_MS`
- Requires 2FA code at runtime (Steam Guard / Mobile Authenticator)

## Safety

- **Input validation** – Discord IDs, app IDs, points amounts, request IDs validated
- **Rate limiting** – Per-user limits on sensitive commands (`/request`, `/add`, `/addpoints`, panel)
- **Error sanitization** – Internal/crypto errors not exposed to users
- **Race protection** – Transaction used when claiming requests
- **Credential handling** – Decrypt wrapped in try/catch, no key leakage

## Audit logging

Optional: set `LOG_CHANNEL_ID` (Discord channel ID) to send audit embeds for:

- **Activation completed** — activator, buyer, game, auth code/token, request ID, timestamp
- **Ticket auto-closed** — buyer, game, request ID (unverified pending timeout)
- **Request failed** — e.g. invalid token; activator, buyer, game, reason

Config: `src/config/logging.js`. Default log channel ID is `1469597575211389040` if not set.

## Data

- SQLite DB: `data/bot.db`
- Games list: `list.json`
