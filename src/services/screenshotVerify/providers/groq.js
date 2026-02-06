/**
 * Groq Vision provider. Uses Llama 4 for OCR.
 * Set GROQ_API_KEY in .env to enable.
 * Optional: GROQ_MODEL to select vision model (default: llama-4-scout).
 */

const DEFAULT_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
];
const TIMEOUT_MS = 30000;

const PROMPT = `Extract ALL visible text from this screenshot exactly as shown.
Focus on: Windows dialog text, window titles, buttons, labels, and any UI text.
Include: "Properties", "File folder", Steam paths, "Disable Updates", "Enable Updates", "Apply Now", "STATUS", "Windows Update Blocker", "Protect Services Settings".
Return only the raw extracted text, no commentary.`;

/**
 * @param {string} imageUrl - URL of the image (must be publicly accessible)
 * @returns {Promise<{ text: string } | { error: string }>}
 */
export async function extractText(imageUrl) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { error: 'GROQ_API_KEY not configured' };

  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const modelId = VISION_MODELS.includes(model) ? model : DEFAULT_MODEL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1024,
        temperature: 0.1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || err.message || `HTTP ${response.status}`;
      if (response.status === 429) return { error: 'Groq rate limit. Retry shortly.' };
      return { error: msg };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    return text ? { text } : { error: 'No text extracted from image' };
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'Groq request timed out' };
    return { error: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
