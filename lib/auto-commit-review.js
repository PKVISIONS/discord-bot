/**
 * Auto-review: poll GitHub for new commits → AI review → Discord + persistent store.
 */

const { createClientForFullName } = require('./github-api');
const { reviewCommit } = require('./commit-review');
const { postCommitSummary } = require('./discord-commit-summary');
const { hasReview, getReview } = require('./commit-review-store');

const recentShas = new Set();
const MAX_RECENT = 300;

function isAutoReviewEnabled() {
  return process.env.COMMIT_AUTO_REVIEW === 'true';
}

function getAutoReviewRepo() {
  return process.env.COMMIT_AUTO_REVIEW_REPO
    || process.env.GITHUB_REPO
    || 'semantic-software/EmblemTameiaki';
}

function getPollIntervalMs() {
  const minutes = Number(process.env.COMMIT_AUTO_REVIEW_POLL_MINUTES || 10);
  return Math.max(2, minutes) * 60 * 1000;
}

function getBackfillLimit() {
  const n = Number(process.env.COMMIT_AUTO_REVIEW_BACKFILL || 10);
  return Math.max(0, Math.min(30, n));
}

function rememberSha(sha) {
  recentShas.add(sha);
  if (recentShas.size > MAX_RECENT) {
    const first = recentShas.values().next().value;
    recentShas.delete(first);
  }
}

function normalizeCommit(commit, branch) {
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    message: (commit.commit?.message || '').split('\n')[0],
    author: commit.commit?.author?.name || commit.author?.login || 'unknown',
    url: commit.html_url || '',
    branch,
  };
}

async function reviewAndPublish({
  discordClient,
  repoFullName,
  branch,
  commit,
  compareUrl,
  onLog = console.log,
  postToDiscord = true,
}) {
  if (hasReview(repoFullName, commit.sha)) {
    onLog(`[auto-review] skip stored ${commit.shortSha}`);
    return getReview(repoFullName, commit.sha);
  }

  if (recentShas.has(commit.sha)) {
    onLog(`[auto-review] skip in-flight ${commit.shortSha}`);
    return null;
  }

  rememberSha(commit.sha);

  onLog(`[auto-review] reviewing ${commit.shortSha} on ${branch}…`);

  const result = await reviewCommit({
    repoFullName,
    branch,
    commit,
    compareUrl: compareUrl || commit.url,
    onProgress: (status) => onLog(`[auto-review] ${status}`),
  });

  if (postToDiscord && discordClient) {
    await postCommitSummary(discordClient, result.messages);
    onLog(`[auto-review] posted ${commit.shortSha} → #commit-summary`);
  }

  return result;
}

async function fetchUnreviewedCommits(repoFullName, limit) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);
  const repoInfo = await client.getRepo(repo);
  const branch = repoInfo.default_branch;

  const commits = await client.listCommits(repo, { sha: branch, perPage: Math.max(limit * 2, 20) });

  const unreviewed = [];
  for (const raw of commits) {
    const commit = normalizeCommit(raw, branch);
    if (hasReview(repoFullName, commit.sha)) continue;
    if (recentShas.has(commit.sha)) continue;
    unreviewed.push(commit);
    if (unreviewed.length >= limit) break;
  }

  return {
    branch,
    commits: unreviewed.reverse(),
    compareUrl: `${repoInfo.html_url}/commits/${branch}`,
  };
}

async function runBackfill({ discordClient, repoFullName = getAutoReviewRepo(), onLog = console.log }) {
  const limit = getBackfillLimit();
  if (!limit) return { reviewed: 0 };

  const { branch, commits, compareUrl } = await fetchUnreviewedCommits(repoFullName, limit);
  if (!commits.length) {
    onLog(`[auto-review] backfill: nothing new on ${branch}`);
    return { reviewed: 0 };
  }

  onLog(`[auto-review] backfill: ${commits.length} commit(s) on ${branch}`);

  let reviewed = 0;
  for (const commit of commits) {
    try {
      await reviewAndPublish({
        discordClient,
        repoFullName,
        branch,
        commit,
        compareUrl,
        onLog,
      });
      reviewed += 1;
    } catch (error) {
      onLog(`[auto-review] backfill failed ${commit.shortSha}: ${error.message}`);
      if (discordClient) {
        await postCommitSummary(
          discordClient,
          `⚠️ **Auto-review failed** · \`${repoFullName}\` · \`${commit.shortSha}\`\n${error.message}`,
        ).catch(() => {});
      }
    }
  }

  return { reviewed };
}

async function pollOnce({ discordClient, repoFullName = getAutoReviewRepo(), onLog = console.log }) {
  const { branch, commits, compareUrl } = await fetchUnreviewedCommits(repoFullName, 5);
  if (!commits.length) return { reviewed: 0 };

  onLog(`[auto-review] poll: ${commits.length} new commit(s) on ${branch}`);

  let reviewed = 0;
  for (const commit of commits) {
    try {
      await reviewAndPublish({
        discordClient,
        repoFullName,
        branch,
        commit,
        compareUrl,
        onLog,
      });
      reviewed += 1;
    } catch (error) {
      onLog(`[auto-review] poll failed ${commit.shortSha}: ${error.message}`);
    }
  }

  return { reviewed };
}

function startAutoCommitReview(discordClient, onLog = console.log) {
  if (!isAutoReviewEnabled()) {
    onLog('[auto-review] disabled (set COMMIT_AUTO_REVIEW=true)');
    return null;
  }

  if (!process.env.OPENAI_API_KEY) {
    onLog('[auto-review] disabled (OPENAI_API_KEY not set)');
    return null;
  }

  const repoFullName = getAutoReviewRepo();
  const intervalMs = getPollIntervalMs();

  onLog(`[auto-review] enabled for ${repoFullName} — poll every ${intervalMs / 60000}m`);

  const run = async (label) => {
    try {
      if (label === 'backfill') {
        await runBackfill({ discordClient, repoFullName, onLog });
      } else {
        await pollOnce({ discordClient, repoFullName, onLog });
      }
    } catch (error) {
      onLog(`[auto-review] ${label} error: ${error.message}`);
    }
  };

  setTimeout(() => run('backfill'), 15_000);

  const timer = setInterval(() => run('poll'), intervalMs);

  return {
    stop: () => clearInterval(timer),
    repoFullName,
    intervalMs,
  };
}

module.exports = {
  isAutoReviewEnabled,
  getAutoReviewRepo,
  reviewAndPublish,
  runBackfill,
  pollOnce,
  startAutoCommitReview,
};
