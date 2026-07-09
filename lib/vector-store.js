/**
 * Persistent local vector index with cosine top-K search.
 *
 * Layout: data/vector/index.json → { version, model, records: [...] }
 * Each record: { id, namespace, sourceType, sourcePath, url, title, timestamp, text, hash, embedding }
 *
 * The public interface is storage-agnostic so it can later be swapped for
 * sqlite or a hosted vector DB without touching callers.
 */

const fs = require('fs');
const path = require('path');

const { VECTOR_DIR, DEFAULT_MODEL } = require('./embeddings');

const INDEX_PATH = path.join(VECTOR_DIR, 'index.json');
const INDEX_VERSION = 1;

let index = null;

function emptyIndex() {
  return { version: INDEX_VERSION, model: DEFAULT_MODEL, records: [] };
}

function loadIndex() {
  if (index) return index;
  fs.mkdirSync(VECTOR_DIR, { recursive: true });

  if (fs.existsSync(INDEX_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      index = {
        version: parsed.version || INDEX_VERSION,
        model: parsed.model || DEFAULT_MODEL,
        records: Array.isArray(parsed.records) ? parsed.records : [],
      };
    } catch {
      index = emptyIndex();
    }
  } else {
    index = emptyIndex();
  }
  return index;
}

function saveIndex() {
  if (!index) return;
  const snapshot = {
    version: index.version,
    model: index.model,
    records: index.records,
  };
  setImmediate(() => {
    try {
      fs.mkdirSync(VECTOR_DIR, { recursive: true });
      fs.writeFileSync(INDEX_PATH, JSON.stringify(snapshot));
    } catch (error) {
      console.error('[vector-store] index save failed:', error.message);
    }
  });
}

function norm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  return Math.sqrt(sum) || 1;
}

function dot(a, b) {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Existing records' hashes for a namespace, keyed by record id.
 * Used by the indexer to skip unchanged chunks.
 */
function getHashesByNamespace(namespace) {
  const idx = loadIndex();
  const map = new Map();
  for (const record of idx.records) {
    if (record.namespace === namespace) map.set(record.id, record.hash);
  }
  return map;
}

/**
 * Insert or replace records by id. Each record must already include `embedding`.
 */
function upsertRecords(records) {
  if (!records?.length) return 0;
  const idx = loadIndex();
  const byId = new Map(idx.records.map((r) => [r.id, r]));

  for (const record of records) {
    const stored = {
      ...record,
      _norm: norm(record.embedding),
    };
    byId.set(record.id, stored);
  }

  idx.records = Array.from(byId.values());
  saveIndex();
  return records.length;
}

function deleteIds(ids) {
  if (!ids?.length) return 0;
  const idx = loadIndex();
  const remove = new Set(ids);
  const before = idx.records.length;
  idx.records = idx.records.filter((r) => !remove.has(r.id));
  saveIndex();
  return before - idx.records.length;
}

/**
 * Remove records in a namespace whose id is not in keepIds (stale cleanup for
 * a source whose chunks changed/shrank).
 */
function pruneNamespace(namespace, keepIds) {
  const idx = loadIndex();
  const keep = new Set(keepIds);
  const before = idx.records.length;
  idx.records = idx.records.filter(
    (r) => r.namespace !== namespace || keep.has(r.id),
  );
  saveIndex();
  return before - idx.records.length;
}

/**
 * Cosine top-K search.
 * @param {number[]} queryVector
 * @param {object} opts { topK, threshold, namespaces }
 * @returns {Array<{ record, score }>}
 */
function search(queryVector, { topK = 12, threshold = 0.15, namespaces = null } = {}) {
  const idx = loadIndex();
  if (!queryVector?.length || !idx.records.length) return [];

  const qNorm = norm(queryVector);
  const nsFilter = namespaces ? new Set(namespaces) : null;

  const scored = [];
  for (const record of idx.records) {
    if (nsFilter && !nsFilter.has(record.namespace)) continue;
    if (!record.embedding?.length) continue;
    const rNorm = record._norm || norm(record.embedding);
    const score = dot(queryVector, record.embedding) / (qNorm * rNorm);
    if (score >= threshold) scored.push({ record, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function stats() {
  const idx = loadIndex();
  const byNamespace = {};
  for (const record of idx.records) {
    byNamespace[record.namespace] = (byNamespace[record.namespace] || 0) + 1;
  }
  return { total: idx.records.length, model: idx.model, byNamespace };
}

function reset() {
  index = emptyIndex();
  saveIndex();
}

module.exports = {
  INDEX_PATH,
  loadIndex,
  saveIndex,
  getHashesByNamespace,
  upsertRecords,
  deleteIds,
  pruneNamespace,
  search,
  stats,
  reset,
};
