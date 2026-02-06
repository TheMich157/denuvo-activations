# Screenshot Verification

Modular detection for activation screenshots. Verifies:
1. **Game folder Properties** – Windows Explorer Properties dialog
2. **WUB** – Windows Update Blocker with updates paused/disabled

## Providers (in order)

| Provider | When used | Config |
|----------|-----------|--------|
| **Groq Vision** | Best accuracy; uses Llama 4 Scout to extract text | `GROQ_API_KEY` in .env |
| **Tesseract OCR** | Default; uses local `data/*.traineddata` | None |

If Groq fails or isn’t configured, Tesseract is used automatically. Groq requests timeout after 30s.

**Partial progress:** Detection state is saved per ticket. If one element (Properties or WUB) is detected, posting another screenshot can add the missing one—no need to resend both.

**Manual verification:** After 5 failed attempts (error or partial), an "Approve manually" button appears. Activators or the assigned issuer can click it to mark the screenshot as verified.

**Model selection:** Set `GROQ_MODEL` in .env. Options: `meta-llama/llama-4-scout-17b-16e-instruct` (default), `meta-llama/llama-4-maverick-17b-128e-instruct`.

## Adding detection patterns

Edit `patterns.js`:
- `PROPERTIES_PATTERNS` – Properties dialog terms (multi-language)
- `WUB_PATTERNS` – WUB / “updates paused” terms

## Adding a provider

1. Add `providers/yourprovider.js` with:
   ```js
   export async function extractText(imageUrl) {
     // return { text: "..." } or { error: "..." }
   }
   ```
2. Register in `index.js`:
   ```js
   import { extractText as yourExtract } from './providers/yourprovider.js';
   const PROVIDERS = [
     { name: 'yourprovider', extract: yourExtract, needsKey: 'YOUR_API_KEY' },
     ...
   ];
   ```
