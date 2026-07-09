/**
 * Chunk + incrementally embed all knowledge sources into the vector index.
 *
 * Namespaces: wiki, vendor, faq, commit-review, discord-capture.
 * Vendor docs come from Discord attachment ingest (data/vendor-ingest/).
 */

const { embedTexts, contentHash, flushCache } = require('./embeddings');
const {
  getHashesByNamespace,
  upsertRecords,
  pruneNamespace,
  stats,
} = require('./vector-store');
const { resolveKnowledgeRoot, loadKnowledgeIndex } = require('./knowledge-base');
const { buildVendorItemsFromStore, getPackage, packageFilesDir } = require('./vendor-ingest-store');
const { extractTextFromFile, titleFromFilename, walkIndexableFiles } = require('./binary-doc-extract');
const { loadProductFaq } = require('./product-faq');
const reviewStore = require('./commit-review-store');
const captureStore = require('./knowledge-capture-store');

const EMBLEM_REPO = process.env.GITHUB_REPO || 'semantic-software/EmblemTameiaki';
const CHUNK_CHARS = Number(process.env.INDEX_CHUNK_CHARS || 3000);
const CHUNK_OVERLAP = Number(process.env.INDEX_CHUNK_OVERLAP || 400);

function chunkText(text, { maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean.split(/\n\s*\n/);
  const raw = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChars) {
      if (current) raw.push(current.trim());
      if (para.length > maxChars) {
        for (let i = 0; i < para.length; i += maxChars - overlap) {
          raw.push(para.slice(i, i + maxChars).trim());
        }
        current = '';
      } else {
        current = para;
      }
    } else {
      current = candidate;
    }
  }
  if (current.trim()) raw.push(current.trim());

  if (raw.length <= 1 || overlap <= 0) return raw;

  return raw.map((chunk, i) => {
    if (i === 0) return chunk;
    const prevTail = raw[i - 1].slice(-overlap);
    return `${prevTail}\n${chunk}`;
  });
}

/**
 * Index one namespace from a list of items.
 * item: { sourcePath, title, url, timestamp, text, sourceType }
 * @param {object} opts { apiKey, prune }
 */
async function indexNamespace(namespace, items, { apiKey, prune = true } = {}) {
  const existing = getHashesByNamespace(namespace);
  const seenIds = new Set();
  const toEmbed = [];

  for (const item of items) {
    const chunks = chunkText(item.text);
    chunks.forEach((chunk, i) => {
      const id = `${namespace}:${item.sourcePath}#${i}`;
      seenIds.add(id);
      const hash = contentHash(chunk);
      if (existing.get(id) === hash) return;
      toEmbed.push({
        id,
        namespace,
        sourceType: item.sourceType || namespace,
        sourcePath: item.sourcePath,
        url: item.url || '',
        title: item.title || '',
        timestamp: item.timestamp || '',
        text: chunk,
        hash,
      });
    });
  }

  if (toEmbed.length) {
    const vectors = await embedTexts(toEmbed.map((r) => r.text), { apiKey });
    toEmbed.forEach((record, i) => { record.embedding = vectors[i]; });
    upsertRecords(toEmbed);
  }

  const removed = prune ? pruneNamespace(namespace, Array.from(seenIds)) : 0;
  return {
    namespace, embedded: toEmbed.length, total: seenIds.size, removed,
  };
}

function buildWikiItems() {
  const root = resolveKnowledgeRoot(EMBLEM_REPO);
  if (!root) return [];
  const docs = loadKnowledgeIndex(root);
  return docs.map((doc) => ({
    sourcePath: doc.relativePath,
    title: doc.title,
    sourceType: 'wiki',
    text: `${doc.title}\n\n${doc.content}`,
  }));
}

async function buildVendorItems() {
  return buildVendorItemsFromStore();
}

async function buildVendorItemsForPackage(packageId) {
  const pkg = getPackage(packageId);
  if (!pkg) return [];

  const filesDir = packageFilesDir(packageId);
  const items = [];

  for (const file of walkIndexableFiles(filesDir)) {
    const text = await extractTextFromFile(file.absolutePath);
    if (!text) continue;

    const title = `${titleFromFilename(file.relativePath)} (${pkg.attachmentName})`;
    items.push({
      sourcePath: `discord-vendor/${pkg.id}/${file.relativePath}`,
      title,
      url: pkg.messageUrl || '',
      timestamp: pkg.ingestedAt || '',
      sourceType: 'vendor',
      text: [
        title,
        `Source: Discord #${pkg.channelName || pkg.channelId}`,
        `Archive: ${pkg.attachmentName}`,
        '',
        text,
      ].join('\n'),
    });
  }

  return items;
}

function buildFaqItems() {
  const faq = loadProductFaq(EMBLEM_REPO);
  return (faq.items || []).map((item) => ({
    sourcePath: `faq#${item.number}`,
    title: `FAQ #${item.number}: ${item.question}`,
    sourceType: 'faq',
    text: `Ερώτηση: ${item.question}\n${item.body || ''}`,
  }));
}

function reviewToText(repo, r) {
  const findings = (r.review?.findings || [])
    .map((f) => `[${f.severity}] ${f.file}: ${f.title} — ${f.detail}`)
    .join('\n');
  return [
    `Repo: ${repo}`,
    `Branch: ${r.branch}`,
    `Commit: ${r.commitMessage}`,
    `Risk: ${r.review?.overallRisk || 'unknown'}`,
    r.review?.summary ? `Summary: ${r.review.summary}` : null,
    findings ? `Findings:\n${findings}` : null,
  ].filter(Boolean).join('\n');
}

function buildCommitReviewItems() {
  const items = [];
  for (const repo of reviewStore.listTrackedRepos()) {
    for (const r of reviewStore.getAllReviewsForRepo(repo)) {
      items.push({
        sourcePath: `${repo}@${r.sha}`,
        title: `${repo} ${r.shortSha}: ${r.commitMessage}`,
        url: r.commitUrl,
        timestamp: r.createdAt,
        sourceType: 'commit-review',
        text: reviewToText(repo, r),
      });
    }
  }
  return items;
}

function captureToItem(entry) {
  return {
    sourcePath: entry.id,
    title: entry.title,
    url: entry.sourceMessageUrl,
    timestamp: entry.updatedAt,
    sourceType: 'discord-capture',
    text: captureStore.captureToText(entry),
  };
}

function buildCaptureItems() {
  const items = [];
  for (const repo of captureStore.listTrackedRepos()) {
    for (const entry of captureStore.getAllCaptures(repo)) {
      items.push(captureToItem(entry));
    }
  }
  return items;
}

/** Index a single capture immediately (no pruning of others). */
async function indexCaptureEntry(entry, { apiKey } = {}) {
  return indexNamespace('discord-capture', [captureToItem(entry)], { apiKey, prune: false });
}

/** Index one Discord-ingested vendor package immediately. */
async function indexVendorPackage(packageId, { apiKey } = {}) {
  const items = await buildVendorItemsForPackage(packageId);
  if (!items.length) return { namespace: 'vendor', embedded: 0, total: 0, removed: 0 };
  return indexNamespace('vendor', items, { apiKey, prune: false });
}

async function reindexAll({ apiKey = process.env.OPENAI_API_KEY, onProgress = () => {} } = {}) {
  const results = [];

  onProgress('Indexing wiki docs…');
  results.push(await indexNamespace('wiki', buildWikiItems(), { apiKey }));

  onProgress('Indexing Discord vendor attachments…');
  results.push(await indexNamespace('vendor', await buildVendorItems(), { apiKey }));

  onProgress('Indexing FAQ…');
  results.push(await indexNamespace('faq', buildFaqItems(), { apiKey }));

  onProgress('Indexing commit reviews…');
  results.push(await indexNamespace('commit-review', buildCommitReviewItems(), { apiKey }));

  onProgress('Indexing Discord captures…');
  results.push(await indexNamespace('discord-capture', buildCaptureItems(), { apiKey }));

  flushCache();
  return { results, stats: stats() };
}

module.exports = {
  chunkText,
  indexNamespace,
  indexCaptureEntry,
  indexVendorPackage,
  reindexAll,
  buildWikiItems,
  buildVendorItems,
  buildFaqItems,
  buildCommitReviewItems,
  buildCaptureItems,
};
