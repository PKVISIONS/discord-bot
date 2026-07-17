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
const DEFAULT_STALE_BRANCH_DAYS = 7;
const DEFAULT_STALE_BRANCH_LIMIT = 0;

const PROTECTED_BRANCH_NAMES = new Set([
  'main',
  'master',
  'develop',
  'development',
  'staging',
  'production',
  'release',
  'qa',
]);

function getStaleBranchDays() {
  const n = Number(process.env.CODEBASE_BRIEF_STALE_BRANCH_DAYS || DEFAULT_STALE_BRANCH_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 90) : DEFAULT_STALE_BRANCH_DAYS;
}

function getStaleBranchLimit() {
  const n = Number(process.env.CODEBASE_BRIEF_STALE_BRANCH_LIMIT ?? DEFAULT_STALE_BRANCH_LIMIT);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 500);
}

function isProtectedBranchName(name, defaultBranch) {
  const lower = String(name || '').toLowerCase();
  if (!lower) return true;
  if (lower === String(defaultBranch || '').toLowerCase()) return true;
  if (PROTECTED_BRANCH_NAMES.has(lower)) return true;
  if (/^dependabot\//i.test(name) || /^renovate\//i.test(name)) return true;
  if (/^release\//i.test(name)) return true;
  return false;
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function formatGreekStaleDate(isoDate, timeZone) {
  if (!isoDate) return 'άγνωστη';
  return new Intl.DateTimeFormat('el-GR', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(isoDate));
}

function collectStaleBranches({
  branches,
  defaultBranch,
  openPullRequests = [],
  staleDays = getStaleBranchDays(),
  limit = getStaleBranchLimit(),
  timeZone = 'Europe/Athens',
}) {
  const prByBranch = new Map(
    openPullRequests.map((pr) => [String(pr.branch || '').toLowerCase(), pr]),
  );

  const stale = branches
    .filter((branch) => !isProtectedBranchName(branch.name, defaultBranch))
    .map((branch) => {
      const idleDays = daysSince(branch.date);
      const openPr = prByBranch.get(branch.name.toLowerCase()) || null;
      return {
        name: branch.name,
        shortSha: branch.shortSha,
        message: branch.message,
        date: branch.date,
        idleDays,
        lastCommitLabel: formatGreekStaleDate(branch.date, timeZone),
        hasOpenPr: Boolean(openPr),
        openPrNumber: openPr?.number || null,
        openPrTitle: openPr?.title || null,
        openPrDraft: Boolean(openPr?.draft),
        openPrUrl: openPr?.url || null,
      };
    })
    .filter((branch) => branch.idleDays != null && branch.idleDays >= staleDays)
    .sort((a, b) => (b.idleDays || 0) - (a.idleDays || 0));

  return limit > 0 ? stale.slice(0, limit) : stale;
}

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

  const staleBranches = collectStaleBranches({
    branches: allBranches,
    defaultBranch: repoInfo.default_branch,
    openPullRequests,
    staleDays: getStaleBranchDays(),
    limit: getStaleBranchLimit(),
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
    staleBranches,
    staleBranchDays: getStaleBranchDays(),
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

  const staleBranchLines = data.staleBranches?.length
    ? [
      `Σύνολο: ${data.staleBranches.length} stale branches (πλήρης λίστα στο έγγραφο).`,
      `Χωρίς ανοιχτό PR: ${data.staleBranches.filter((b) => !b.hasOpenPr).length}`,
      `Με ανοιχτό PR: ${data.staleBranches.filter((b) => b.hasOpenPr).length}`,
      'Top 5 (για context):',
      ...data.staleBranches.slice(0, 5).map((branch) => {
        const prNote = branch.hasOpenPr
          ? ` · PR #${branch.openPrNumber}`
          : ' · χωρίς PR';
        return `- origin/${branch.name} · ${branch.idleDays}d${prNote}`;
      }),
    ].join('\n')
    : `(Δεν βρέθηκαν feature branches χωρίς commit ≥${data.staleBranchDays || 7} ημέρες.)`;

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
    `### Stale branches (χωρίς commit ≥${data.staleBranchDays || 7} ημέρες)`,
    staleBranchLines,
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

function formatStaleBranchesMarkdown({ staleBranches, staleBranchDays }) {
  if (!staleBranches?.length) {
    return [
      '## Stale branches — πλήρης λίστα',
      '',
      `Δεν εντοπίστηκαν feature branches χωρίς commit ≥${staleBranchDays || 7} ημέρες.`,
    ].join('\n');
  }

  const orphaned = staleBranches.filter((branch) => !branch.hasOpenPr).length;
  const withPr = staleBranches.length - orphaned;

  const lines = [
    `## Stale branches — πλήρης λίστα (${staleBranches.length})`,
    '',
    `Κριτήριο: χωρίς commit ≥${staleBranchDays} ημέρες.`,
    `${orphaned} χωρίς ανοιχτό PR · ${withPr} με ανοιχτό PR.`,
    '',
  ];

  staleBranches.forEach((branch, index) => {
    const prNote = branch.hasOpenPr
      ? `ανοιχτό PR #${branch.openPrNumber}${branch.openPrDraft ? ' (draft)' : ''}: ${branch.openPrTitle}`
      : 'χωρίς ανοιχτό PR';
    lines.push(
      `${index + 1}. **origin/${branch.name}** — ${branch.idleDays} ημέρες · τελευταίο commit ${branch.lastCommitLabel} · \`${branch.shortSha}\` · ${prNote}`,
    );
    lines.push(`   _${branch.message}_`);
  });

  return lines.join('\n');
}

function formatCommitsMarkdown(data) {
  const {
    commits = [],
    commitsByDay = [],
    lookbackDays,
    lookbackStart,
    lookbackEnd,
    timeZone,
  } = data;

  const periodLabel = lookbackStart && lookbackEnd
    ? `${lookbackStart} έως ${lookbackEnd}`
    : `τελευταίες ${lookbackDays || 3} ημέρες`;

  if (!commits.length) {
    return [
      `## Όλα τα commits (${periodLabel})`,
      '',
      'Δεν καταγράφηκαν commits στο διάστημα lookback.',
    ].join('\n');
  }

  const lines = [
    `## Όλα τα commits (${commits.length}) — ${periodLabel}`,
    '',
    'Πλήρης λίστα κάθε commit στο διάστημα ανάλυσης (όχι σύνοψη).',
    '',
  ];

  const days = commitsByDay.length
    ? commitsByDay
    : [{ dateLabel: periodLabel, commits }];

  let index = 0;
  for (const day of days) {
    if (!day.commits?.length) continue;
    lines.push(`### ${day.dateLabel} (${day.commits.length})`);
    lines.push('');

    for (const commit of day.commits) {
      index += 1;
      const time = formatTimeInTz(commit.date, timeZone);
      const stats = commit.stats || {};
      const statsLine = stats.isApkOnly
        ? 'χωρίς αλλαγές πηγαίου κώδικα (πιθανό DEV APK / build)'
        : `${stats.fileCount || 0} αρχεία · +${stats.additions || 0}/-${stats.deletions || 0}`;
      const paths = stats.topPaths?.length
        ? ` · ${stats.topPaths.slice(0, 4).join(', ')}`
        : '';

      lines.push(
        `${index}. \`${commit.shortSha}\` · **${time}** · ${commit.author} — ${commit.message}`,
      );
      lines.push(`   _${statsLine}${paths}_`);
      if (commit.url) lines.push(`   ${commit.url}`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

function insertSectionAfterHeading(body, headingMarkers, sectionMarkdown) {
  for (const marker of headingMarkers) {
    if (!body.includes(marker)) continue;
    const start = body.indexOf(marker);
    const nextHeading = body.indexOf('\n## ', start + marker.length);
    const before = body.slice(0, start).trimEnd();
    const block = nextHeading === -1
      ? body.slice(start).trimEnd()
      : body.slice(start, nextHeading).trimEnd();
    const after = nextHeading === -1 ? '' : body.slice(nextHeading + 1).trimStart();
    return [before, block, sectionMarkdown, after].filter(Boolean).join('\n\n');
  }
  return null;
}

function insertBeforeMethodology(body, sectionMarkdown) {
  const methodologyMarker = '## Σημείωση μεθοδολογίας';
  if (body.includes(methodologyMarker)) {
    return body.replace(methodologyMarker, `${sectionMarkdown}\n\n${methodologyMarker}`);
  }
  return `${body}\n\n${sectionMarkdown}`;
}

/**
 * Append deterministic appendix sections into the AI day-plan brief (one file):
 * 1. Full commit list for the lookback period
 * 2. Full stale-branch list
 */
function appendBriefAppendixSections(markdown, data) {
  let body = String(markdown || '').trim();

  const commitsSection = formatCommitsMarkdown(data);
  const insertedCommits = insertSectionAfterHeading(body, [
    '## ✅ Τι έχει γίνει (τελευταίες ημέρες)',
    '## ✅ Τι έχει γίνει',
    '## Τι έχει γίνει (τελευταίες ημέρες)',
    '## Τι έχει γίνει',
  ], commitsSection);

  body = insertedCommits || insertBeforeMethodology(body, commitsSection);

  const staleSection = formatStaleBranchesMarkdown(data);
  const insertedStale = insertSectionAfterHeading(body, [
    '## ⚠️ Stale branches — τι να προσέξετε',
    '## Stale branches — τι να προσέξετε',
    '## ⚠️ Stale branches',
  ], staleSection);

  body = insertedStale || insertBeforeMethodology(body, staleSection);

  return body.trim();
}

/** @deprecated use appendBriefAppendixSections */
function appendStaleBranchesSection(markdown, data) {
  return appendBriefAppendixSections(markdown, data);
}

module.exports = {
  fetchCodebaseBriefData,
  formatBriefDataForPrompt,
  formatStaleBranchesMarkdown,
  formatCommitsMarkdown,
  appendBriefAppendixSections,
  appendStaleBranchesSection,
  collectStaleBranches,
  getTodayReportDateKey,
  getLookbackDays,
  getStaleBranchDays,
  formatGreekDate,
  formatDateKey,
  getYesterdayReportDateKey: (tz) => dateKeyDaysAgo(1, tz),
};
