/**
 * Persistent commit review store — reusable by sales-support, unified context, webhooks.
 *
 * Layout: data/reviews/{owner}__{repo}.json
 */

const fs = require('fs');
const path = require('path');

const REVIEWS_DIR = path.join(__dirname, '..', 'data', 'reviews');
const LEGACY_STORE = path.join(__dirname, '..', 'data', 'commit-reviews.json');
const MAX_ENTRIES = 500;
const MAX_PER_REPO = 200;

function repoFileKey(repoFullName) {
  return String(repoFullName || '')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}

function storePath(repoFullName) {
  return path.join(REVIEWS_DIR, `${repoFileKey(repoFullName)}.json`);
}

function loadRepoStore(repoFullName) {
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  const file = storePath(repoFullName);

  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { entries: [] };
    }
  }

  return migrateLegacyEntries(repoFullName);
}

function migrateLegacyEntries(repoFullName) {
  if (!fs.existsSync(LEGACY_STORE)) return { entries: [] };

  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_STORE, 'utf8'));
    const entries = (legacy.entries || []).filter(
      (e) => e.repoFullName?.toLowerCase() === repoFullName.toLowerCase(),
    );
    if (entries.length) {
      saveRepoStore(repoFullName, { entries });
    }
    return { entries };
  } catch {
    return { entries: [] };
  }
}

function saveRepoStore(repoFullName, store) {
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  const trimmed = (store.entries || []).slice(0, MAX_PER_REPO);
  fs.writeFileSync(storePath(repoFullName), JSON.stringify({
    repoFullName,
    updatedAt: new Date().toISOString(),
    entries: trimmed,
  }, null, 2));
  return trimmed;
}

function saveCommitReview({
  repoFullName,
  branch,
  commit,
  review,
  discordMessage,
}) {
  const store = loadRepoStore(repoFullName);
  const entry = {
    id: `${repoFullName}:${commit.sha}`,
    repoFullName,
    branch,
    sha: commit.sha,
    shortSha: commit.shortSha || commit.sha?.slice(0, 7),
    commitMessage: commit.message || '',
    author: commit.author || null,
    commitUrl: commit.url || '',
    review: review || null,
    discordMessage: discordMessage || '',
    createdAt: new Date().toISOString(),
  };

  store.entries = store.entries.filter((e) => e.id !== entry.id);
  store.entries.unshift(entry);

  const globalCap = store.entries.slice(0, MAX_PER_REPO);
  saveRepoStore(repoFullName, { entries: globalCap });
  return entry;
}

function hasReview(repoFullName, sha) {
  if (!sha) return false;
  const store = loadRepoStore(repoFullName);
  return store.entries.some((e) => e.sha === sha);
}

function getReview(repoFullName, sha) {
  const store = loadRepoStore(repoFullName);
  return store.entries.find((e) => e.sha === sha) || null;
}

function getRecentReviewsForRepo(repoFullName, limit = 15) {
  const store = loadRepoStore(repoFullName);
  return store.entries.slice(0, limit);
}

function getAllReviewsForRepo(repoFullName) {
  return loadRepoStore(repoFullName).entries;
}

function listTrackedRepos() {
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  return fs.readdirSync(REVIEWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', '').replace(/__/g, '/'));
}

function formatReviewsForPrompt(reviews) {
  if (!reviews.length) {
    return 'Δεν υπάρχουν ακόμα αποθηκευμένα commit reviews για αυτό το repo.';
  }

  return reviews
    .map((entry, index) => {
      const findings = (entry.review?.findings || [])
        .slice(0, 5)
        .map((f) => `- [${f.severity}] ${f.file}: ${f.title} — ${f.detail}`)
        .join('\n');

      return [
        `### Review ${index + 1} · ${entry.branch} · ${entry.shortSha}`,
        `Commit: ${entry.commitMessage}`,
        `Risk: ${entry.review?.overallRisk || 'unknown'}`,
        `Summary: ${entry.review?.summary || entry.discordMessage?.slice(0, 500) || '(no summary)'}`,
        findings ? `Findings:\n${findings}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

module.exports = {
  REVIEWS_DIR,
  saveCommitReview,
  hasReview,
  getReview,
  getRecentReviewsForRepo,
  getAllReviewsForRepo,
  listTrackedRepos,
  formatReviewsForPrompt,
  storePath,
};
