/**
 * Semantic retrieval over the vector index.
 *
 * Embeds the query, retrieves top-K across all namespaces, dedupes, and
 * assembles a grounded context under a dynamic token budget (not a char cap).
 * Returns structured sources so callers can cite exactly what was used.
 */

const { embedQuery } = require('./embeddings');
const { search, stats } = require('./vector-store');

const DEFAULT_TOP_K = Number(process.env.RETRIEVAL_TOP_K || 24);
const DEFAULT_TOKEN_BUDGET = Number(process.env.RETRIEVAL_TOKEN_BUDGET || 40000);
const DEFAULT_THRESHOLD = Number(process.env.RETRIEVAL_THRESHOLD || 0.16);
const CHARS_PER_TOKEN = 4;

const SOURCE_LABELS = {
  wiki: 'Τεκμηρίωση',
  faq: 'FAQ',
  'commit-review': 'Commit review',
  'discord-capture': 'Λύση από Discord',
};

function confidenceFromScore(score) {
  if (score >= 0.55) return 'high';
  if (score >= 0.38) return 'medium';
  return 'low';
}

function isIndexEmpty() {
  return stats().total === 0;
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string[]} [opts.namespaces]
 * @param {number} [opts.topK]
 * @param {number} [opts.tokenBudget]
 * @param {number} [opts.threshold]
 * @param {string} [opts.apiKey]
 * @returns {Promise<{ content, sources, confidence, topScore, chunkCount, empty }>}
 */
async function retrieveContext({
  query,
  namespaces = null,
  topK = DEFAULT_TOP_K,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  threshold = DEFAULT_THRESHOLD,
  apiKey = process.env.OPENAI_API_KEY,
} = {}) {
  if (isIndexEmpty()) {
    return {
      content: '', sources: [], confidence: 'none', topScore: 0, chunkCount: 0, empty: true,
    };
  }

  const queryVector = await embedQuery(query, { apiKey });
  const hits = search(queryVector, { topK, threshold, namespaces });

  if (!hits.length) {
    return {
      content: '', sources: [], confidence: 'low', topScore: 0, chunkCount: 0, empty: false,
    };
  }

  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const parts = [];
  const sources = [];
  const seenSourcePaths = new Set();
  let usedChars = 0;

  for (const { record, score } of hits) {
    const label = SOURCE_LABELS[record.namespace] || record.sourceType || record.namespace;
    const headerBits = [`[${label}]`, record.title || record.sourcePath];
    if (record.url) headerBits.push(record.url);
    const header = headerBits.filter(Boolean).join(' · ');
    const chunk = `--- ${header} (relevance ${score.toFixed(2)}) ---\n${record.text}\n`;

    if (usedChars + chunk.length > charBudget && parts.length) break;

    parts.push(chunk);
    usedChars += chunk.length;

    if (!seenSourcePaths.has(record.sourcePath)) {
      seenSourcePaths.add(record.sourcePath);
      sources.push({
        namespace: record.namespace,
        label,
        title: record.title || record.sourcePath,
        sourcePath: record.sourcePath,
        url: record.url || '',
        score,
      });
    }
  }

  const topScore = hits[0].score;

  return {
    content: parts.join('\n'),
    sources,
    confidence: confidenceFromScore(topScore),
    topScore,
    chunkCount: parts.length,
    empty: false,
  };
}

/** Group cited sources by type for an internal source block. */
function groupSourcesByLabel(sources) {
  const grouped = {};
  for (const source of sources) {
    (grouped[source.label] = grouped[source.label] || []).push(source);
  }
  return grouped;
}

module.exports = {
  retrieveContext,
  groupSourcesByLabel,
  confidenceFromScore,
  isIndexEmpty,
  SOURCE_LABELS,
};
