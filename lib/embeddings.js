/**
 * OpenAI embeddings client with batching, retry, and a persistent content-hash cache.
 *
 * Cache layout: data/vector/embedding-cache.json  → { [model:hash]: number[] }
 * The cache means unchanged text is never re-embedded (cost + latency control).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VECTOR_DIR = path.join(__dirname, '..', 'data', 'vector');
const CACHE_PATH = path.join(VECTOR_DIR, 'embedding-cache.json');

const DEFAULT_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const MAX_BATCH = 96;
const MAX_INPUT_CHARS = 30000;

let cache = null;

function contentHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

function cacheKey(model, text) {
  return `${model}:${contentHash(text)}`;
}

function loadCache() {
  if (cache) return cache;
  fs.mkdirSync(VECTOR_DIR, { recursive: true });

  if (fs.existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch {
      cache = {};
    }
  } else {
    cache = {};
  }
  return cache;
}

let saveTimer = null;
function scheduleCacheSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushCache();
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

function flushCache() {
  if (!cache) return;
  const snapshot = cache;
  setImmediate(() => {
    try {
      fs.mkdirSync(VECTOR_DIR, { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify(snapshot));
    } catch (error) {
      console.error('[embeddings] cache flush failed:', error.message);
    }
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callEmbeddingApi(apiKey, model, inputs) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(EMBED_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: inputs }),
      });

      const data = await response.json();
      if (!response.ok) {
        const msg = data?.error?.message || response.statusText;
        const err = new Error(`OpenAI embeddings ${response.status}: ${msg}`);
        err.status = response.status;
        throw err;
      }

      return data.data.map((d) => d.embedding);
    } catch (error) {
      lastError = error;
      const retriable = !error.status || error.status === 429 || error.status >= 500;
      if (!retriable || attempt === 3) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function normalizeInput(text) {
  const clean = String(text || '').trim();
  if (!clean) return ' ';
  return clean.length > MAX_INPUT_CHARS ? clean.slice(0, MAX_INPUT_CHARS) : clean;
}

/**
 * Embed an array of texts. Returns array of vectors (same order).
 * Uses the persistent cache; only uncached texts hit the API.
 */
async function embedTexts(texts, { apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_MODEL } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (needed for embeddings).');
  if (!Array.isArray(texts) || !texts.length) return [];

  const store = loadCache();
  const results = new Array(texts.length);
  const misses = [];

  texts.forEach((raw, index) => {
    const text = normalizeInput(raw);
    const key = cacheKey(model, text);
    if (store[key]) {
      results[index] = store[key];
    } else {
      misses.push({ index, text, key });
    }
  });

  for (let i = 0; i < misses.length; i += MAX_BATCH) {
    const batch = misses.slice(i, i + MAX_BATCH);
    const vectors = await callEmbeddingApi(apiKey, model, batch.map((m) => m.text));
    batch.forEach((m, j) => {
      results[m.index] = vectors[j];
      store[m.key] = vectors[j];
    });
    scheduleCacheSave();
  }

  flushCache();
  return results;
}

async function embedQuery(text, options = {}) {
  const [vector] = await embedTexts([text], options);
  return vector;
}

module.exports = {
  embedTexts,
  embedQuery,
  contentHash,
  flushCache,
  DEFAULT_MODEL,
  VECTOR_DIR,
};
