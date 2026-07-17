/**
 * Auto-sync vector index when EmblemTameiaki-Knowledge changes.
 * Triggered by GitHub push webhook and/or periodic git fetch polling.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  resolveKnowledgeRoot,
  getKnowledgeBranch,
  clearKnowledgeCache,
} = require('./knowledge-base');
const { reindexAll } = require('./knowledge-indexer');
const { stats } = require('./vector-store');

const EMBLEM_REPO = process.env.GITHUB_REPO || 'semantic-software/EmblemTameiaki';
const STATE_PATH = path.join(__dirname, '..', 'data', 'knowledge-reindex-state.json');
const DEFAULT_KNOWLEDGE_GITHUB_REPO = 'semantic-software/EmblemTameiaki-Knowledge';
const DEFAULT_POLL_MS = Number(process.env.KNOWLEDGE_REINDEX_POLL_MS || 120_000);
const DEBOUNCE_MS = Number(process.env.KNOWLEDGE_REINDEX_DEBOUNCE_MS || 8_000);

let running = false;
let debounceTimer = null;
let pollTimer = null;

function isKnowledgeAutoReindexEnabled() {
  if (process.env.KNOWLEDGE_AUTO_REINDEX === 'false') return false;
  if (!process.env.OPENAI_API_KEY) return false;
  return Boolean(resolveKnowledgeRoot(EMBLEM_REPO));
}

function getKnowledgeGithubRepo() {
  return process.env.KNOWLEDGE_GITHUB_REPO || DEFAULT_KNOWLEDGE_GITHUB_REPO;
}

function getWatchedBranches() {
  const branch = getKnowledgeBranch();
  const extra = (process.env.KNOWLEDGE_REINDEX_BRANCHES || 'restructure/wiki-structure,ai/sales-support-knowledge')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([branch, ...extra].filter(Boolean))];
}

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function gitExec(knowledgeRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['-C', knowledgeRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function fetchKnowledgeBranch(knowledgeRoot, branch) {
  try {
    gitExec(knowledgeRoot, ['fetch', 'origin', branch, '--quiet']);
  } catch (error) {
    console.warn(`[knowledge-reindex] git fetch origin ${branch} failed: ${error.message}`);
  }
}

function resolveRemoteHead(knowledgeRoot, branch) {
  fetchKnowledgeBranch(knowledgeRoot, branch);
  const candidates = [`origin/${branch}`, branch];
  for (const ref of candidates) {
    const sha = gitExec(knowledgeRoot, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
    if (sha) return { ref, sha };
  }
  throw new Error(`Knowledge branch "${branch}" not found in ${knowledgeRoot}`);
}

function getKnowledgeHead() {
  const knowledgeRoot = resolveKnowledgeRoot(EMBLEM_REPO);
  if (!knowledgeRoot) return null;

  const branch = getKnowledgeBranch();
  if (!branch) {
    const docsDir = path.join(knowledgeRoot, 'docs');
    if (!fs.existsSync(docsDir)) return null;
    return {
      knowledgeRoot,
      branch: 'working tree',
      ref: 'working tree',
      sha: String(fs.statSync(docsDir).mtimeMs),
    };
  }

  const { ref, sha } = resolveRemoteHead(knowledgeRoot, branch);
  return { knowledgeRoot, branch, ref, sha };
}

function pushTouchesDocs(payload) {
  return (payload.commits || []).some((commit) => {
    const files = [
      ...(commit.added || []),
      ...(commit.modified || []),
      ...(commit.removed || []),
    ];
    return files.some((file) => String(file).startsWith('docs/'));
  });
}

function shouldHandleKnowledgePush(payload) {
  if (!isKnowledgeAutoReindexEnabled()) return false;
  if (!payload || payload.deleted) return false;

  const repoFullName = payload.repository?.full_name || '';
  if (repoFullName !== getKnowledgeGithubRepo()) return false;

  const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
  if (!getWatchedBranches().includes(branch)) return false;

  return pushTouchesDocs(payload);
}

function queueKnowledgeReindex({ reason, sha, onLog = console.log } = {}) {
  if (!isKnowledgeAutoReindexEnabled()) return;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    runKnowledgeReindexSync({ reason, expectedSha: sha, onLog }).catch((error) => {
      onLog(`[knowledge-reindex] failed: ${error.message}`);
    });
  }, DEBOUNCE_MS);
}

async function runKnowledgeReindexSync({
  reason = 'manual',
  expectedSha = null,
  force = false,
  onLog = console.log,
} = {}) {
  if (!isKnowledgeAutoReindexEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }

  if (running) {
    onLog('[knowledge-reindex] already running — skip');
    return { skipped: true, reason: 'busy' };
  }

  const head = getKnowledgeHead();
  if (!head) {
    return { skipped: true, reason: 'no-knowledge-root' };
  }

  const state = readState();
  const sameSha = state.sha === head.sha;
  if (!force && sameSha && state.indexedSha === head.sha) {
    return { skipped: true, reason: 'up-to-date', sha: head.sha };
  }

  if (expectedSha && expectedSha !== head.sha) {
    onLog(`[knowledge-reindex] remote moved ${expectedSha.slice(0, 7)} → ${head.sha.slice(0, 7)} before sync`);
  }

  running = true;
  const startedAt = new Date().toISOString();
  onLog(`[knowledge-reindex] start (${reason}) @ ${head.ref} ${head.sha.slice(0, 7)}`);

  try {
    const { results, stats: indexStats } = await reindexAll({
      onProgress: (status) => onLog(`[knowledge-reindex] ${status}`),
    });

    clearKnowledgeCache();

    const wiki = results.find((entry) => entry.namespace === 'wiki');
    writeState({
      branch: head.branch,
      ref: head.ref,
      sha: head.sha,
      indexedSha: head.sha,
      lastReason: reason,
      lastStartedAt: startedAt,
      lastFinishedAt: new Date().toISOString(),
      wikiEmbedded: wiki?.embedded ?? 0,
      wikiTotal: wiki?.total ?? 0,
      indexTotal: indexStats.total,
    });

    onLog(
      `[knowledge-reindex] done — wiki embedded=${wiki?.embedded ?? 0} total=${wiki?.total ?? 0} `
      + `index=${indexStats.total} chunks`,
    );

    return {
      skipped: false,
      sha: head.sha,
      results,
      stats: indexStats,
    };
  } finally {
    running = false;
  }
}

async function checkKnowledgeReindexSync({ onLog = console.log } = {}) {
  if (!isKnowledgeAutoReindexEnabled()) return { skipped: true, reason: 'disabled' };

  const head = getKnowledgeHead();
  if (!head) return { skipped: true, reason: 'no-knowledge-root' };

  const state = readState();
  if (state.indexedSha === head.sha) {
    return { skipped: true, reason: 'up-to-date', sha: head.sha };
  }

  return runKnowledgeReindexSync({
    reason: `poll ${head.ref}`,
    expectedSha: head.sha,
    onLog,
  });
}

function knowledgeReindexStatus() {
  if (!isKnowledgeAutoReindexEnabled()) return 'off';
  const state = readState();
  const index = stats();
  const head = (() => {
    try {
      return getKnowledgeHead();
    } catch {
      return null;
    }
  })();

  const parts = ['auto-reindex on'];
  if (head?.sha) {
    const synced = state.indexedSha === head.sha;
    parts.push(synced ? `synced ${head.sha.slice(0, 7)}` : `pending ${head.sha.slice(0, 7)}`);
  } else if (state.indexedSha) {
    parts.push(`indexed ${String(state.indexedSha).slice(0, 7)}`);
  }
  parts.push(`${index.total || 0} chunks`);
  return parts.join(' | ');
}

function startKnowledgeReindexWatcher({ onLog = console.log } = {}) {
  if (!isKnowledgeAutoReindexEnabled()) {
    onLog('[knowledge-reindex] disabled (set KNOWLEDGE_REPO_PATH + OPENAI_API_KEY; opt out with KNOWLEDGE_AUTO_REINDEX=false)');
    return;
  }

  onLog(`[knowledge-reindex] watcher on — poll every ${Math.round(DEFAULT_POLL_MS / 1000)}s, branches: ${getWatchedBranches().join(', ')}`);

  checkKnowledgeReindexSync({ onLog }).catch((error) => {
    onLog(`[knowledge-reindex] startup sync failed: ${error.message}`);
  });

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    checkKnowledgeReindexSync({ onLog }).catch((error) => {
      onLog(`[knowledge-reindex] poll failed: ${error.message}`);
    });
  }, DEFAULT_POLL_MS);
}

module.exports = {
  isKnowledgeAutoReindexEnabled,
  shouldHandleKnowledgePush,
  queueKnowledgeReindex,
  runKnowledgeReindexSync,
  checkKnowledgeReindexSync,
  knowledgeReindexStatus,
  startKnowledgeReindexWatcher,
  getWatchedBranches,
  getKnowledgeGithubRepo,
};
