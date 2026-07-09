/**
 * Scan a repository for product / sales context files.
 */

const { createClientForFullName, filterTreePaths } = require('./github-api');

const MAX_FILES = 14;
const MAX_FILE_CHARS = 7000;
const MAX_TOTAL_CHARS = 55000;

const SCORE_RULES = [
  { re: /^readme\.md$/i, score: 100 },
  { re: /^docs\/.+\.md$/i, score: 90 },
  { re: /^(changelog|history)\.md$/i, score: 85 },
  { re: /^package\.json$/i, score: 80 },
  { re: /^app\.json$/i, score: 75 },
  { re: /^(marketing|product|features)\/.+/i, score: 75 },
  { re: /\.md$/i, score: 50 },
  { re: /^(src|lib)\/.+\.(tsx?|jsx?)$/i, score: 20 },
];

function scorePath(filePath) {
  let score = 0;
  for (const rule of SCORE_RULES) {
    if (rule.re.test(filePath)) score = Math.max(score, rule.score);
  }
  return score;
}

function pickProductFiles(treePaths) {
  const filtered = filterTreePaths(treePaths, 400);
  return filtered
    .map((path) => ({ path, score: scorePath(path) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES)
    .map((item) => item.path);
}

async function scanRepoProductContext(repoFullName) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);
  const repoInfo = await client.getRepo(repo);
  const defaultBranch = repoInfo.default_branch;
  const { sha } = await client.getDefaultBranchSha(repo);

  const treePaths = await client.listTreePaths(repo, sha);
  const filesToRead = pickProductFiles(treePaths);

  if (!filesToRead.length && treePaths.includes('README.md')) {
    filesToRead.push('README.md');
  }

  const chunks = [];
  let total = 0;

  for (const filePath of filesToRead) {
    try {
      const file = await client.getFileContent(repo, filePath, defaultBranch);
      const body = file.content.slice(0, MAX_FILE_CHARS);
      const chunk = `--- ${filePath} ---\n${body}\n`;
      if (total + chunk.length > MAX_TOTAL_CHARS) break;
      chunks.push(chunk);
      total += chunk.length;
    } catch {
      // skip unreadable files
    }
  }

  return {
    repoFullName,
    defaultBranch,
    description: repoInfo.description || '',
    homepage: repoInfo.homepage || '',
    filesScanned: filesToRead,
    content: chunks.join('\n') || '(No readable product documentation found in repo.)',
  };
}

module.exports = {
  scanRepoProductContext,
  pickProductFiles,
};
