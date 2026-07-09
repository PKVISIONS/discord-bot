/**
 * Persistent store for knowledge captured from Discord (bug/fix/problem→solution).
 *
 * Layout: data/knowledge-captures/{owner}__{repo}.json
 * Mirrors the commit-review-store pattern so it is reusable by retrieval,
 * the indexer, and the sales-support unified context.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAPTURES_DIR = path.join(__dirname, '..', 'data', 'knowledge-captures');
const MAX_PER_REPO = 1000;

function repoFileKey(repoFullName) {
  return String(repoFullName || 'general')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}

function storePath(repoFullName) {
  return path.join(CAPTURES_DIR, `${repoFileKey(repoFullName)}.json`);
}

function loadRepoStore(repoFullName) {
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  const file = storePath(repoFullName);

  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { entries: [] };
    }
  }

  return { entries: [] };
}

function saveRepoStore(repoFullName, store) {
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  const trimmed = (store.entries || []).slice(0, MAX_PER_REPO);
  fs.writeFileSync(storePath(repoFullName), JSON.stringify({
    repoFullName,
    updatedAt: new Date().toISOString(),
    entries: trimmed,
  }, null, 2));
  return trimmed;
}

function makeId(repoFullName, sourceKey) {
  const hash = crypto.createHash('sha1')
    .update(`${repoFullName}:${sourceKey}`)
    .digest('hex')
    .slice(0, 12);
  return `cap_${hash}`;
}

/**
 * Save (or update) a captured knowledge entry.
 * `sourceKey` should be a stable identifier for the source thread/message so
 * re-promoting the same thread updates rather than duplicates.
 */
function saveCapture({
  repoFullName = 'general',
  sourceKey,
  title,
  problem,
  symptoms,
  rootCause,
  solution,
  productArea,
  tags,
  links,
  participants,
  sourceMessageUrl,
  channelId,
  threadId,
  status = 'captured',
  raw,
}) {
  const store = loadRepoStore(repoFullName);
  const key = sourceKey || threadId || sourceMessageUrl || crypto.randomUUID();
  const id = makeId(repoFullName, key);
  const existing = store.entries.find((e) => e.id === id);

  const entry = {
    id,
    repoFullName,
    sourceKey: key,
    title: title || 'Captured solution',
    problem: problem || '',
    symptoms: symptoms || '',
    rootCause: rootCause || '',
    solution: solution || '',
    productArea: productArea || '',
    tags: Array.isArray(tags) ? tags : [],
    links: Array.isArray(links) ? links : [],
    participants: Array.isArray(participants) ? participants : [],
    sourceMessageUrl: sourceMessageUrl || '',
    channelId: channelId || '',
    threadId: threadId || '',
    status,
    raw: raw || '',
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  store.entries = store.entries.filter((e) => e.id !== id);
  store.entries.unshift(entry);
  saveRepoStore(repoFullName, store);
  return entry;
}

function updateCaptureStatus(repoFullName, id, status, extra = {}) {
  const store = loadRepoStore(repoFullName);
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.status = status;
  entry.updatedAt = new Date().toISOString();
  Object.assign(entry, extra);
  saveRepoStore(repoFullName, store);
  return entry;
}

function getCaptureById(repoFullName, id) {
  return loadRepoStore(repoFullName).entries.find((e) => e.id === id) || null;
}

function hasCaptureForSource(repoFullName, sourceKey) {
  if (!sourceKey) return false;
  const id = makeId(repoFullName, sourceKey);
  return loadRepoStore(repoFullName).entries.some((e) => e.id === id);
}

function getAllCaptures(repoFullName) {
  return loadRepoStore(repoFullName).entries;
}

function getRecentCaptures(repoFullName, limit = 20) {
  return loadRepoStore(repoFullName).entries.slice(0, limit);
}

function listTrackedRepos() {
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  return fs.readdirSync(CAPTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', '').replace(/__/g, '/'));
}

/** Flatten a capture into embeddable / prompt text. */
function captureToText(entry) {
  return [
    `Title: ${entry.title}`,
    entry.productArea ? `Area: ${entry.productArea}` : null,
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : null,
    entry.problem ? `Problem: ${entry.problem}` : null,
    entry.symptoms ? `Symptoms: ${entry.symptoms}` : null,
    entry.rootCause ? `Root cause: ${entry.rootCause}` : null,
    entry.solution ? `Solution: ${entry.solution}` : null,
  ].filter(Boolean).join('\n');
}

function formatCapturesForPrompt(entries) {
  if (!entries.length) {
    return 'Δεν υπάρχουν ακόμα αποθηκευμένες λύσεις από Discord για αυτό το repo.';
  }
  return entries
    .map((entry, index) => [
      `### Λύση ${index + 1}: ${entry.title}`,
      entry.problem ? `Πρόβλημα: ${entry.problem}` : null,
      entry.solution ? `Λύση: ${entry.solution}` : null,
      entry.sourceMessageUrl ? `Πηγή: ${entry.sourceMessageUrl}` : null,
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

module.exports = {
  CAPTURES_DIR,
  storePath,
  makeId,
  saveCapture,
  updateCaptureStatus,
  getCaptureById,
  hasCaptureForSource,
  getAllCaptures,
  getRecentCaptures,
  listTrackedRepos,
  captureToText,
  formatCapturesForPrompt,
};
