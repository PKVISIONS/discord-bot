/**
 * Recent code activity across branches for EmblemTameiaki.
 */

const { createClientForFullName } = require('./github-api');
const { fetchBranchesWithLatestCommit } = require('./commit-summary-flow');

const DEFAULT_BRANCH_COMMITS = Number(process.env.CODE_ACTIVITY_DEFAULT_COMMITS || 40);
const MERGED_PRS = Number(process.env.CODE_ACTIVITY_MERGED_PRS || 50);
const MAX_ACTIVITY_CHARS = Number(process.env.CODE_ACTIVITY_MAX_CHARS || 42000);

function branchLimit() {
  const raw = process.env.CODE_ACTIVITY_BRANCHES;
  if (raw === undefined || raw === '' || raw === '0') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function isEmblemTameiakiRepo(repoFullName) {
  const name = (repoFullName || '').split('/').pop()?.toLowerCase() || '';
  return name === 'emblemtameiaki';
}

function normalizeCommit(commit, branch) {
  const message = (commit?.commit?.message || commit?.message || '').split('\n')[0];
  const date = commit?.commit?.author?.date || commit?.commit?.committer?.date || commit?.date || '';
  return {
    sha: commit?.sha || '',
    shortSha: (commit?.sha || commit?.shortSha || '').slice(0, 7),
    branch,
    message: message || '(no message)',
    author: commit?.commit?.author?.name || commit?.author?.login || commit?.author || 'unknown',
    date,
    url: commit?.html_url || commit?.url || '',
  };
}

function branchTipToCommit(branch) {
  return normalizeCommit({
    sha: branch.sha,
    shortSha: branch.shortSha,
    message: branch.message,
    date: branch.date,
    url: branch.url,
    author: 'unknown',
  }, branch.name);
}

function truncateBlock(text, maxLen, suffix = '\n\n…(περικομμένο)') {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - suffix.length).trimEnd()}${suffix}`;
}

async function fetchCodeActivity(repoFullName) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);
  const repoInfo = await client.getRepo(repo);
  const defaultBranch = repoInfo.default_branch;
  const limit = branchLimit();

  const [defaultCommits, allBranches, pulls] = await Promise.all([
    client.listCommits(repo, { sha: defaultBranch, perPage: DEFAULT_BRANCH_COMMITS }),
    fetchBranchesWithLatestCommit(repoFullName),
    client.listPullRequests(repo, { state: 'closed', perPage: MERGED_PRS, sort: 'updated' }),
  ]);

  const branches = Number.isFinite(limit) ? allBranches.slice(0, limit) : allBranches;

  const seen = new Set();
  const allCommits = [];

  for (const c of defaultCommits.map((commit) => normalizeCommit(commit, defaultBranch))) {
    if (!c.sha || seen.has(c.sha)) continue;
    seen.add(c.sha);
    allCommits.push(c);
  }

  for (const branch of branches) {
    const tip = branchTipToCommit(branch);
    if (!tip.sha || seen.has(tip.sha)) continue;
    seen.add(tip.sha);
    allCommits.push(tip);
  }

  allCommits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const mergedPrs = pulls
    .filter((pr) => pr.merged_at)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.head?.ref || '',
      mergedAt: pr.merged_at,
      author: pr.user?.login || 'unknown',
      url: pr.html_url,
    }));

  return {
    defaultBranch,
    branchCount: allBranches.length,
    branchesSampled: branches.length,
    branches,
    commits: allCommits,
    mergedPrs,
  };
}

function formatCodeActivityForPrompt(activity) {
  const branchCatalog = activity.branches.length
    ? activity.branches
      .map((b) => `- \`${b.name}\` · \`${b.shortSha}\` · ${(b.date || '').slice(0, 10) || '?'} · ${b.message}`)
      .join('\n')
    : '(Δεν βρέθηκαν branches.)';

  const branchHeader = activity.branchesSampled < activity.branchCount
    ? `Κατάλογος branches: ${activity.branchesSampled} από ${activity.branchCount} (ρίζα CODE_ACTIVITY_BRANCHES).`
    : `Κατάλογος όλων των ${activity.branchCount} branches (τελευταίο commit ανά branch).`;

  const prBlock = activity.mergedPrs.length
    ? activity.mergedPrs
      .slice(0, MERGED_PRS)
      .map((pr) => `- #${pr.number} \`${pr.branch}\` → merged · ${pr.title}`)
      .join('\n')
    : '(Δεν βρέθηκαν πρόσφατα merged PRs.)';

  const defaultCommits = activity.commits
    .filter((c) => c.branch === activity.defaultBranch)
    .map((c) => `- \`${c.shortSha}\` · ${c.date?.slice(0, 10) || '?'} · ${c.message}`)
    .join('\n');

  const recentAcrossBranches = activity.commits
    .slice(0, 80)
    .map((c) => `- \`${c.branch}\` · \`${c.shortSha}\` · ${c.date?.slice(0, 10) || '?'} · ${c.message}`)
    .join('\n');

  const sections = [
    `Default branch: ${activity.defaultBranch}`,
    branchHeader,
    '',
    '### Όλα τα branches (τελευταίο commit)',
    branchCatalog,
    '',
    '### Πρόσφατα merged PRs',
    prBlock,
    '',
    `### Commits στο ${activity.defaultBranch}`,
    defaultCommits || '(Δεν βρέθηκαν commits.)',
    '',
    '### Πρόσφατη δραστηριότητα (όλα τα branches)',
    recentAcrossBranches || '(Δεν βρέθηκαν commits.)',
  ];

  let text = sections.join('\n');
  if (text.length > MAX_ACTIVITY_CHARS) {
    const branchSection = [
      `Default branch: ${activity.defaultBranch}`,
      branchHeader,
      '',
      '### Όλα τα branches (τελευταίο commit)',
      branchCatalog,
    ].join('\n');

    const budget = MAX_ACTIVITY_CHARS - branchSection.length - 120;
    const tail = truncateBlock(
      sections.slice(4).join('\n'),
      Math.max(2000, budget),
    );
    text = `${branchSection}\n\n${tail}`;
  }

  return text;
}

module.exports = {
  isEmblemTameiakiRepo,
  fetchCodeActivity,
  formatCodeActivityForPrompt,
};
