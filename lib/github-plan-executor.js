/**
 * Execute a pending GitHub plan: AI edits → branch → commit → PR.
 */

const { createClient, filterTreePaths } = require('./github-api');
const { message, parseJsonResponse } = require('./openai');
const { ensureGitHubIssue } = require('./github-plan-issue');

const MAX_READ_FILES = 4;
const MAX_FILE_CHARS = 6000;
const MAX_EDIT_FILES = 3;

const FILE_SELECT_SYSTEM = `You are a senior software engineer planning a code change.
Given a Linear issue, implementation steps, and a repository file tree, pick which files to read before editing.

Return ONLY valid JSON:
{
  "filesToRead": ["path/relative/to/repo", ...],
  "reasoning": "one short sentence"
}

Rules:
- Pick at most ${MAX_READ_FILES} files from the provided tree (exact paths only).
- Prefer the smallest set of source files that can implement the fix.
- Include tests only if the issue clearly requires test changes.`;

const EDIT_SYSTEM = `You are a senior software engineer implementing a focused fix in a GitHub repository.

Return ONLY valid JSON:
{
  "files": [
    {
      "path": "relative/path/from/repo/root",
      "replacements": [
        { "old": "exact text copied from the file (include enough lines to be unique)", "new": "replacement text" }
      ]
    }
  ],
  "commitMessage": "short imperative commit subject",
  "prSummary": "2-4 sentence summary of the change for the PR body"
}

Rules:
- Change at most ${MAX_EDIT_FILES} files.
- Every "path" for existing files MUST be copied exactly from the repository paths list.
- To create a NEW file, use one replacement with old "" and new as the full file content.
- Use "replacements" with exact "old" snippets from the provided file contents — do NOT return full files.
- Each "old" block must appear exactly once in the file.
- Keep changes minimal and focused on the Linear issue.
- If you must add a new file, use one replacement with old "" and new as the full new file content.`;

function validatePlan(plan) {
  if (!plan) throw new Error('No plan provided.');
  if (!plan.repo || plan.repo === 'TBD') {
    throw new Error('Plan has no target repo. Re-plan with: `plan fix ENG-11 in repo-name`');
  }
  if (!plan.branch) throw new Error('Plan is missing a branch name.');
  if (!plan.issueIdentifier) throw new Error('Plan is missing a Linear issue id.');
}

function pickReadableFiles(treePaths, plan) {
  const preferred = ['README.md', 'readme.md', 'package.json'];
  const picked = new Set();

  for (const name of preferred) {
    if (treePaths.includes(name)) picked.add(name);
  }

  const issueText = `${plan.issueTitle || ''} ${plan.issueDescription || ''} ${plan.summary || ''}`.toLowerCase();
  const tokens = issueText.split(/[^a-z0-9]+/i).filter((t) => t.length > 3);

  const scored = treePaths
    .map((path) => {
      const lower = path.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (lower.includes(token)) score += 2;
      }
      if (/transcription|reference|workspace/i.test(lower)) score += 3;
      if (/\.(tsx?|jsx?|vue|svelte)$/i.test(path)) score += 1;
      return { path, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const entry of scored) {
    if (picked.size >= MAX_READ_FILES) break;
    picked.add(entry.path);
  }

  for (const path of treePaths) {
    if (picked.size >= MAX_READ_FILES) break;
    if (/\.(tsx?|jsx?|py|go|rs|vue|svelte)$/i.test(path)) picked.add(path);
  }

  return [...picked].slice(0, MAX_READ_FILES);
}

function resolveTreePath(requested, treePaths) {
  if (!requested) return null;
  const normalized = requested.replace(/^\/+/, '');
  if (treePaths.includes(normalized)) return normalized;

  const suffixMatches = treePaths.filter(
    (p) => p === normalized || p.endsWith(`/${normalized}`),
  );
  if (suffixMatches.length === 1) return suffixMatches[0];

  const base = normalized.split('/').pop();
  const baseMatches = treePaths.filter((p) => p.split('/').pop() === base);
  if (baseMatches.length === 1) return baseMatches[0];

  return null;
}

async function resolveSourceFile(path, fileContents, context, replacements = []) {
  const { github, repo, defaultBranch, treePaths } = context;

  let source = fileContents.find((f) => f.path === path);
  if (source) return source;

  const resolved = resolveTreePath(path, treePaths);
  if (resolved) {
    source = fileContents.find((f) => f.path === resolved);
    if (source) return source;

    const file = await github.getFileContent(repo, resolved, defaultBranch);
    source = { path: resolved, content: file.content, sha: file.sha };
    fileContents.push(source);
    console.log(`[execute] fetched missing edit target: ${resolved}`);
    return source;
  }

  const normalized = path.replace(/^\/+/, '');
  const isNewFile = replacements.some((r) => (r.old ?? '') === '' && (r.new ?? '').length > 0);
  if (isNewFile) {
    source = { path: normalized, content: '', sha: undefined };
    fileContents.push(source);
    console.log(`[execute] creating new file: ${normalized}`);
    return source;
  }

  const base = path.split('/').pop();
  const similar = treePaths.filter((p) => p.includes(base)).slice(0, 5);
  const hint = similar.length ? ` Did you mean: ${similar.join(', ')}?` : ' That path is not in this repository.';
  throw new Error(`AI picked a file that does not exist: ${path}.${hint}`);
}

function applyReplacements(path, content, replacements) {
  let updated = content;
  for (const { old, new: replacement } of replacements) {
    const search = old ?? '';
    const next = replacement ?? '';
    if (search === '' && updated === '') {
      updated = next;
      continue;
    }
    if (search === '' && updated !== '') {
      throw new Error(`Cannot create new file content for ${path} — file already exists.`);
    }
    if (!updated.includes(search)) {
      throw new Error(`AI edit did not match ${path} — snippet not found. Try planning again.`);
    }
    updated = updated.replace(search, next);
  }
  return updated;
}

async function selectFilesWithAi({ llm, model, plan, treePaths, onHeartbeat }) {
  const prompt = [
    `Linear issue: ${plan.issueIdentifier} — ${plan.issueTitle || plan.summary}`,
    plan.issueDescription ? `Description:\n${plan.issueDescription.slice(0, 2000)}` : null,
    plan.steps?.length ? `Plan steps:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : null,
    `Repository file tree (${treePaths.length} paths):\n${treePaths.slice(0, 80).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { text } = await message({
    apiKey: llm.apiKey,
    model,
    system: FILE_SELECT_SYSTEM,
    user: prompt,
    maxTokens: 1024,
    timeoutMs: 90000,
    onHeartbeat,
  });

  const parsed = parseJsonResponse(text);
  const allowed = new Set(treePaths);
  const files = (parsed.filesToRead || []).filter((p) => allowed.has(p)).slice(0, MAX_READ_FILES);
  return files.length ? files : pickReadableFiles(treePaths, plan);
}

async function generateEditsWithAi({ llm, model, plan, fileContents, treePaths, fileContext, onHeartbeat }) {
  const allowedPaths = fileContents.map((f) => f.path).join('\n');
  const relevantTree = pickReadableFiles(treePaths, plan)
    .concat(treePaths.filter((p) => /transcription|reference|workspace/i.test(p)))
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .slice(0, 40);

  const filesBlock = fileContents
    .map((f) => `--- FILE: ${f.path} ---\n${f.content.slice(0, MAX_FILE_CHARS)}`)
    .join('\n\n');

  const prompt = [
    `Implement this change using minimal search-and-replace edits.`,
    `Linear: ${plan.issueIdentifier} — ${plan.issueTitle || plan.summary}`,
    plan.issueDescription ? `Issue description:\n${plan.issueDescription.slice(0, 2000)}` : null,
    plan.steps?.length ? `Plan steps:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : null,
    `Repository paths that exist (you MUST use exact paths from this list):\n${relevantTree.join('\n')}`,
    `Files already loaded (prefer editing these):\n${allowedPaths}`,
    `Files (current contents):\n\n${filesBlock}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { text, elapsedMs } = await message({
    apiKey: llm.apiKey,
    model,
    system: EDIT_SYSTEM,
    user: prompt,
    maxTokens: 8192,
    timeoutMs: 300000,
    onHeartbeat,
  });

  console.log(`[execute] AI edit pass finished in ${Math.round(elapsedMs / 1000)}s`);

  const parsed = parseJsonResponse(text);
  if (!parsed.files?.length) {
    throw new Error('AI returned no file edits.');
  }

  const edits = [];
  for (const file of parsed.files.slice(0, MAX_EDIT_FILES)) {
    const source = await resolveSourceFile(file.path, fileContents, fileContext, file.replacements || []);
    const content = applyReplacements(source.path, source.content, file.replacements || []);
    edits.push({ path: source.path, content });
  }

  return {
    files: edits,
    commitMessage: parsed.commitMessage,
    prSummary: parsed.prSummary,
  };
}

/**
 * @param {object} plan - pending plan from bridge/n8n
 * @param {object} options
 * @param {function} [options.onProgress] - async (status: string) => void
 */
async function executePlan(plan, options = {}) {
  const { onProgress = async () => {} } = options;

  const githubToken = process.env.GITHUB_TOKEN;
  const githubOrg = process.env.GITHUB_ORG || 'TechFlow-Labs';
  const openaiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o';

  if (!githubToken) throw new Error('GITHUB_TOKEN is not set.');
  if (!openaiKey) throw new Error('OPENAI_API_KEY is not set (required for AI edits).');

  validatePlan(plan);

  const github = createClient(githubToken, githubOrg);
  const llm = { apiKey: openaiKey };

  let heartbeatCount = 0;
  const aiHeartbeat = async () => {
    heartbeatCount += 1;
    await onProgress(`Still generating edits with AI… (${heartbeatCount * 20}s)`);
  };

  await onProgress(`Validating repo \`${plan.repo}\`…`);
  const { defaultBranch, sha: baseSha } = await github.getDefaultBranchSha(plan.repo);

  await onProgress('Ensuring GitHub tracking issue…');
  const githubIssue = await ensureGitHubIssue(github, plan);
  if (githubIssue) {
    plan.githubIssueNumber = githubIssue.number;
    plan.githubIssueUrl = githubIssue.url;
    await onProgress(
      githubIssue.created
        ? `Created GitHub issue #${githubIssue.number}`
        : `Using GitHub issue #${githubIssue.number}`,
    );
  } else if (plan.repo && plan.repo !== 'TBD') {
    await onProgress(
      '⚠️ No GitHub issue (token needs **Issues: Read and write** on this repo). Continuing…',
    );
  }

  await onProgress('Scanning repository file tree…');
  const allPaths = await github.listTreePaths(plan.repo, baseSha);
  const treePaths = filterTreePaths(allPaths, 150);

  await onProgress('Asking AI which files to inspect…');
  const filesToRead = await selectFilesWithAi({
    llm,
    model,
    plan,
    treePaths,
    onHeartbeat: aiHeartbeat,
  });

  await onProgress(`Reading ${filesToRead.length} file(s)…`);
  const fileContents = [];
  for (const path of filesToRead) {
    try {
      const file = await github.getFileContent(plan.repo, path, defaultBranch);
      fileContents.push({ path, content: file.content, sha: file.sha });
    } catch {
      // Skip unreadable paths
    }
  }

  if (!fileContents.length) {
    throw new Error('Could not read any repository files for context.');
  }

  await onProgress('Generating code edits with AI (usually 30–90s)…');
  const fileContext = { github, repo: plan.repo, defaultBranch, treePaths };
  const edits = await generateEditsWithAi({
    llm,
    model,
    plan,
    fileContents,
    treePaths,
    fileContext,
    onHeartbeat: aiHeartbeat,
  });

  await onProgress(`Creating branch \`${plan.branch}\`…`);
  const branch = await github.createBranch(plan.repo, plan.branch, baseSha);

  const changedPaths = [];
  for (const file of edits.files) {
    await onProgress(`Committing \`${file.path}\`…`);
    const source = fileContents.find((f) => f.path === file.path);
    await github.upsertFile(
      plan.repo,
      file.path,
      branch,
      file.content,
      edits.commitMessage || `[${plan.issueIdentifier}] ${plan.summary || plan.issueTitle}`,
      source?.sha,
    );
    changedPaths.push(file.path);
  }

  await onProgress('Opening pull request…');
  const prBody = [
    plan.githubIssueNumber ? `Fixes #${plan.githubIssueNumber}` : `Fixes ${plan.issueIdentifier}`,
    plan.githubIssueUrl || null,
    plan.issueUrl || '',
    plan.planDocUrl ? `Plan doc: ${plan.planDocUrl}` : null,
    '',
    edits.prSummary || plan.summary || '',
    '',
    '## Plan',
    ...(plan.steps || []).map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Files changed',
    ...changedPaths.map((p) => `- \`${p}\``),
    '',
    '_Opened by Discord → Linear bot (AI-assisted)._',
  ]
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n');

  const pr = await github.createPullRequest(
    plan.repo,
    plan.prTitle || `[${plan.issueIdentifier}] ${plan.summary || plan.issueTitle}`,
    branch,
    defaultBranch,
    prBody,
  );

  return {
    message: [
      '✅ **Pull request opened**',
      `**${plan.issueIdentifier}** — ${plan.summary || plan.issueTitle}`,
      pr.html_url,
      plan.githubIssueUrl ? `GitHub issue: ${plan.githubIssueUrl}` : null,
      '',
      `Branch: \`${branch}\` → \`${defaultBranch}\``,
      `Files: ${changedPaths.map((p) => `\`${p}\``).join(', ')}`,
    ].filter(Boolean).join('\n'),
    prUrl: pr.html_url,
    branch,
    changedPaths,
    clearPendingPlan: true,
  };
}

module.exports = {
  executePlan,
};
