/**
 * Minimal OpenAI Chat Completions API client.
 */

async function message({
  apiKey,
  model,
  system,
  user,
  maxTokens = 8192,
  timeoutMs = 240000,
  onHeartbeat,
  heartbeatMs = 20000,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const heartbeat = onHeartbeat
    ? setInterval(() => onHeartbeat(), heartbeatMs)
    : null;

  const started = Date.now();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const errMsg = data?.error?.message || response.statusText;
      throw new Error(`OpenAI API ${response.status}: ${errMsg}`);
    }

    const text = data.choices?.[0]?.message?.content || '';

    return { text: text.trim(), elapsedMs: Date.now() - started };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`OpenAI API timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
  }
}

function parseJsonResponse(text) {
  const clean = text.replace(/```json\n?|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (error) {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(clean.slice(start, end + 1));
    }
    throw new Error(`AI returned invalid JSON: ${error.message}`);
  }
}

module.exports = {
  message,
  parseJsonResponse,
};
