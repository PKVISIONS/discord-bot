/**
 * Collect recent GitHub activity for the daily dev planning brief.
 */

const { createClientForFullName } = require('./github-api');
const { fetchBranchesWithLatestCommit } = require('./commit-summary-flow');
const {
  getRecentReviewsForRepo,
  formatReviewsForPrompt,
} = require('./commit-review-store');

const DETAIL_CONCURRENCY = 6;
const DEFAULT_LOOKBACK_DAYS = 3;

function getLookbackDays() {
  const n = Number(process.env.CODEBASE_BRIEF_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 7) : DEFAULT_LOOKBACK_DAYS;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

function formatDateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function daysBetweenKeys(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const utcA = Date.UTC(ay, am - 1, ad);
  const utcB = Date.UTC(by, bm - 1, bd);
  return Math.round((utcB - utcA) / (24 * 60 * 60 * 1000));
}

function dateKeyDaysAgo(days, timeZone) {
  const todayKey = formatDateKey(new Date(), timeZone);
  const msPerDay = 24 * 60 * 60 * 1000;
  for (let delta = 1; delta <= days + 3; delta += 1) {
    const candidate = new Date(Date.now() - delta * msPerDay);
    const key = formatDateKey(candidate, timeZone);
    if (daysBetweenKeys(key, todayKey) === days) return key;
  }
  const fallback = new Date(Date.now() - days * msPerDay);
  return formatDateKey(fallback, timeZone);
}

function getTodayReportDateKey(timeZone = 'Europe/Athens') {
  return formatDateKey(new Date(), timeZone);
}

function getLookbackDateKeys(timeZone, lookbackDays) {
  const keys = [];
  for (let offset = 1; offset <= lookbackDays; offset += 1) {
    keys.push(dateKeyDaysAgo(offset, timeZone));
  }
  return keys.sort();
}

function formatGreekDate(dateKey, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return new Intl.DateTimeFormat('el-GR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(noonUtc);
}

function formatTimeInTz(isoDate, timeZone) {
  if (!isoDate) return '??:??';
  return new Intl.DateTimeFormat('el-GR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoDate));
}

function normalizeSearchCommit(item) {
  const message = (item.commit?.message || '').split('\n')[0];
  const date = item.commit?.committer?.date || item.commit?.author?.date || '';
  return {
    sha: item.sha,
    shortSha: item.sha.slice(0, 8),
    message: message || '(no message)',
    author: item.commit?.author?.name || item.author?.login || 'unknown',
    date,
    dateKey: '',
    url: item.html_url || '',
  };
}

function summarizeCommitFiles(files = [], message = '') {
  const codeFiles = files.filter((f) => f.filename && f.status !== 'removed');
  const fileCount = codeFiles.length;
  const additions = codeFiles.reduce((sum, f) => sum + (f.additions || 0), 0);
  const deletions = codeFiles.reduce((sum, f) => sum + (f.deletions || 0), 0);
  const topPaths = codeFiles
    .slice(0, 8)
    .map((f) => `${f.filename} (+${f.additions || 0}/-${f.deletions || 0})`);
  const isApkOnly = fileCount === 0 && /generate apk|\[DEV\]/i.test(message);
  return { fileCount, additions, deletions, topPaths, isApkOnly };
}

async function fetchCommitsForDateRange({ client, repo, repoFullName, startKey, endKey, timeZone }) {
  const query = `repo:${repoFullName} committer-date:${startKey}..${endKey}`;
  const response = await client.searchCommits(query, { perPage: 100 });
  const items = response?.items || [];
  const seen = new Set();
  const commits = [];

  for (const item of items) {
    if (seen.has(item.sha)) continue;
    seen.add(item.sha);
    const commit = normalizeSearchCommit(item);
    commit.dateKey = formatDateKey(new Date(commit.date), timeZone);
    commits.push(commit);
  }

  const detailed = await mapPool(commits, DETAIL_CONCURRENCY, async (commit) => {
    try {
      const detail = await client.getCommit(repo, commit.sha);
      const files = detail.files || [];
      return {
        ...commit,
        stats: summarizeCommitFiles(files, commit.message),
      };
    } catch (error) {
      return {
        ...commit,
        stats: {
          fileCount: 0,
          additions: 0,
          deletions: 0,
          topPaths: [],
          isApkOnly: false,
          error: error.message,
        },
      };
    }
  });

  detailed.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return detailed;
}

async function fetchOpenIssues(client, repo) {
  const issues = await client.listIssues(repo, { state: 'open', perPage: 30 });
  return (issues || [])
    .filter((issue) => !issue.pull_request)
    .slice(0, 25)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      labels: (issue.labels || []).map((l) => l.name).join(', '),
      type: issue.type?.name || null,
      url: issue.html_url,
      updatedAt: issue.updated_at,
    }));
}

async function fetchOpenPullRequests(client, repo) {
  const pulls = await client.listPullRequests(repo, { state: 'open', perPage: 20, sort: 'updated' });
  return (pulls || []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.head?.ref || '',
    author: pr.user?.login || 'unknown',
    url: pr.html_url,
    updatedAt: pr.updated_at,
    draft: Boolean(pr.draft),
  }));
}

async function fetchRecentMergedPullRequests(client, repo, limit = 10) {
  const pulls = await client.listPullRequests(repo, { state: 'closed', perPage: 30, sort: 'updated' });
  return (pulls || [])
    .filter((pr) => pr.merged_at)
    .slice(0, limit)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.head?.ref || '',
      mergedAt: pr.merged_at,
      url: pr.html_url,
    }));
}

function fetchActiveFeatureBranches({ branches, defaultBranch, lookbackKeys, commitShas, timeZone }) {
  const shaSet = new Set(commitShas);
  const lookbackSet = new Set(lookbackKeys);

  return branches
    .filter((branch) => branch.name !== defaultBranch)
    .filter((branch) => {
      if (shaSet.has(branch.sha)) return true;
      const branchDateKey = formatDateKey(new Date(branch.date || 0), timeZone);
      return lookbackSet.has(branchDateKey);
    })
    .slice(0, 30)
    .map((branch) => ({
      name: branch.name,
      shortSha: branch.shortSha,
      message: branch.message,
      date: branch.date,
    }));
}

async function fetchCodebaseBriefData({
  repoFullName,
  reportDateKey,
  timeZone = 'Europe/Athens',
  lookbackDays = getLookbackDays(),
}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);
  const repoInfo = await client.getRepo(repo);
  const lookbackKeys = getLookbackDateKeys(timeZone, lookbackDays);
  const lookbackStart = lookbackKeys[0];
  const lookbackEnd = lookbackKeys[lookbackKeys.length - 1];

  const [
    commits,
    allBranches,
    openIssues,
    openPullRequests,
    mergedPullRequests,
    recentReviews,
  ] = await Promise.all([
    fetchCommitsForDateRange({
      client,
      repo,
      repoFullName,
      startKey: lookbackStart,
      endKey: lookbackEnd,
      timeZone,
    }),
    fetchBranchesWithLatestCommit(repoFullName),
    fetchOpenIssues(client, repo),
    fetchOpenPullRequests(client, repo),
    fetchRecentMergedPullRequests(client, repo),
    Promise.resolve(getRecentReviewsForRepo(repoFullName, 12)),
  ]);

  const branches = fetchActiveFeatureBranches({
    branches: allBranches,
    defaultBranch: repoInfo.default_branch,
    lookbackKeys,
    commitShas: commits.map((c) => c.sha),
    timeZone,
  });

  const contributors = [...new Set(commits.map((c) => c.author))];
  const commitsByDay = lookbackKeys.map((key) => ({
    dateKey: key,
    dateLabel: formatGreekDate(key, timeZone),
    commits: commits.filter((c) => c.dateKey === key),
  }));

  return {
    repoFullName,
    defaultBranch: repoInfo.default_branch,
    reportDateKey,
    reportDateLabel: formatGreekDate(reportDateKey, timeZone),
    lookbackDays,
    lookbackStart,
    lookbackEnd,
    lookbackKeys,
    generatedAt: new Date().toISOString(),
    timeZone,
    commits,
    commitsByDay,
    branches,
    branchCount: allBranches.length,
    contributors,
    openIssues,
    openPullRequests,
    mergedPullRequests,
    recentReviews,
    checkedAtLabel: formatGreekDate(formatDateKey(new Date(), timeZone), timeZone),
  };
}

function formatBriefDataForPrompt(data) {
  const timeline = data.commits.length
    ? data.commits.map((commit) => {
      const day = commit.dateKey || '?';
      const time = formatTimeInTz(commit.date, data.timeZone);
      const stats = commit.stats || {};
      const statsLine = stats.isApkOnly
        ? 'Χωρίς αλλαγές πηγαίου κώδικα — πιθανό DEV APK / build artifact'
        : `${stats.fileCount || 0} αρχεία, +${stats.additions || 0}/-${stats.deletions || 0}`;
      const paths = stats.topPaths?.length ? ` | ${stats.topPaths.join(', ')}` : '';
      return `${day} ${time} | ${commit.shortSha} | ${commit.message}\n${statsLine}${paths}`;
    }).join('\n\n')
    : '(Δεν καταγράφηκαν commits στο διάστημα lookback.)';

  const branchLines = data.branches.length
    ? data.branches.map((b) => `- origin/${b.name} · ${b.shortSha} · ${b.message}`).join('\n')
    : '(Δεν εντοπίστηκαν ενεργά feature refs.)';

  const issueLines = data.openIssues.length
    ? data.openIssues.map((i) => `- #${i.number} [${i.labels || 'no labels'}] ${i.title}`).join('\n')
    : '(Δεν υπάρχουν ανοιχτά issues.)';

  const prLines = data.openPullRequests.length
    ? data.openPullRequests.map((pr) => `- #${pr.number} \`${pr.branch}\` · ${pr.title}${pr.draft ? ' (draft)' : ''}`).join('\n')
    : '(Δεν υπάρχουν ανοιχτά PRs.)';

  const mergedLines = data.mergedPullRequests.length
    ? data.mergedPullRequests.map((pr) => `- #${pr.number} merged · \`${pr.branch}\` · ${pr.title}`).join('\n')
    : '(Δεν βρέθηκαν πρόσφατα merged PRs.)';

  const daySummary = data.commitsByDay
    .map((day) => `- ${day.dateLabel}: ${day.commits.length} commit(s)`)
    .join('\n');

  return [
    `Repository: ${data.repoFullName}`,
    `Πλάνο για: ${data.reportDateLabel} (${data.timeZone})`,
    `Lookback: ${data.lookbackDays} ημέρες (${data.lookbackStart} έως ${data.lookbackEnd})`,
    `Default branch: ${data.defaultBranch}`,
    `Συνεισφέροντες (lookback): ${data.contributors.join(', ') || '—'}`,
    `Σύνολο commits (lookback): ${data.commits.length}`,
    '',
    '### Commits ανά ημέρα (lookback)',
    daySummary,
    '',
    '### Ενεργά feature branches',
    branchLines,
    '',
    '### Χρονολόγιο commits (lookback)',
    timeline,
    '',
    '### Ανοιχτά GitHub issues',
    issueLines,
    '',
    '### Ανοιχτά pull requests',
    prLines,
    '',
    '### Πρόσφατα merged PRs',
    mergedLines,
    '',
    '### Πρόσφατα AI commit reviews',
    formatReviewsForPrompt(data.recentReviews),
  ].join('\n');
}

module.exports = {
  fetchCodebaseBriefData,
  formatBriefDataForPrompt,
  getTodayReportDateKey,
  getLookbackDays,
  formatGreekDate,
  formatDateKey,
  getYesterdayReportDateKey: (tz) => dateKeyDaysAgo(1, tz),
};
