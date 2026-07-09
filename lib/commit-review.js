/**
 * AI code review for a single GitHub commit.
 */

const { createClientForFullName } = require('./github-api');
const { message, parseJsonResponse } = require('./openai');

const BINARY_OR_SKIP_RE =
  /\.(lock|min\.js|min\.css|map|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip|tar|gz)$/i;

const REVIEW_SYSTEM = `You are a senior engineer performing a concise code review on a single commit.

Return ONLY valid JSON:
{
  "summary": "2-4 sentences: what changed and overall risk",
  "overallRisk": "low" | "medium" | "high",
  "findings": [
    {
      "severity": "info" | "warning" | "critical",
      "file": "path/from/diff",
      "title": "short title",
      "detail": "what might break or what to double-check"
    }
  ]
}

Rules:
- Focus on bugs, regressions, security issues, missing error handling, race conditions, and logic errors.
- Ignore formatting-only nits unless they hide a real bug.
- If the diff is empty or too small to judge, say so with overallRisk "low" and empty findings.
- At most 8 findings; prefer the most important issues.
- Do not invent files or lines not present in the diff.`;

function buildDiffText(commitDetail) {
  const files = (commitDetail.files || [])
    .filter((f) => f.filename && !BINARY_OR_SKIP_RE.test(f.filename))
    .slice(0, 25);

  const parts = [];
  let total = 0;
  const maxChars = 45000;

  for (const file of files) {
    const patch = file.patch || `(binary or no patch: ${file.status})`;
    const chunk = `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n${patch}\n`;
    if (total + chunk.length > maxChars) {
      parts.push(`### ${file.filename}\n(patch truncated — diff too large)\n`);
      break;
    }
    parts.push(chunk);
    total += chunk.length;
  }

  return parts.join('\n') || '(no textual diff available)';
}

function severityEmoji(severity) {
  if (severity === 'critical') return '🔴';
  if (severity === 'warning') return '🟡';
  return '🔵';
}

function riskEmoji(risk) {
  if (risk === 'high') return '🔴';
  if (risk === 'medium') return '🟡';
  return '🟢';
}

function formatDiscordReview({
  repoFullName,
  branch,
  commit,
  review,
  commitUrl,
  compareUrl,
}) {
  const risk = review.overallRisk || 'low';
  const lines = [
    `${riskEmoji(risk)} **Commit review** · \`${repoFullName}\` · \`${commit.shortSha}\``,
    `**Branch:** \`${branch}\``,
    `**Author:** ${commit.author}`,
    `**Message:** ${commit.message}`,
    commitUrl ? commitUrl : null,
    '',
    '**Summary**',
    review.summary || '_No summary returned._',
  ].filter((line) => line !== null);

  const findings = review.findings || [];
  if (findings.length) {
    lines.push('', '**Findings**');
    for (const f of findings.slice(0, 8)) {
      const file = f.file ? `\`${f.file}\`` : '';
      lines.push(`${severityEmoji(f.severity)} ${file} — **${f.title}**: ${f.detail}`);
    }
  } else {
    lines.push('', '_No specific issues flagged._');
  }

  if (compareUrl) {
    lines.push('', `Compare: ${compareUrl}`);
  }

  return lines.join('\n');
}

function splitDiscordMessages(text, maxLen = 1900) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function reviewCommit({
  repoFullName,
  branch,
  commit,
  compareUrl,
  onProgress,
}) {
  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o';

  if (!token) throw new Error('GITHUB_TOKEN is not set.');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);

  if (onProgress) await onProgress(`Fetching diff for \`${commit.shortSha}\`…`);

  const detail = await client.getCommit(repo, commit.sha);
  const diffText = buildDiffText(detail);
  const commitUrl = detail.html_url || commit.url;

  if (onProgress) await onProgress(`Reviewing \`${commit.shortSha}\` with AI…`);

  const userPrompt = [
    `Repository: ${repoFullName}`,
    `Branch: ${branch}`,
    `Commit: ${commit.sha}`,
    `Author: ${commit.author}`,
    `Subject: ${commit.message}`,
    '',
    'Diff:',
    diffText,
  ].join('\n');

  const { text } = await message({
    apiKey,
    model,
    system: REVIEW_SYSTEM,
    user: userPrompt,
    maxTokens: 4096,
    timeoutMs: 120000,
    onHeartbeat: onProgress
      ? () => onProgress(`Still reviewing \`${commit.shortSha}\`…`)
      : undefined,
  });

  const review = parseJsonResponse(text);

  const result = {
    review,
    message: formatDiscordReview({
      repoFullName,
      branch,
      commit,
      review,
      commitUrl,
      compareUrl,
    }),
    messages: splitDiscordMessages(
      formatDiscordReview({
        repoFullName,
        branch,
        commit,
        review,
        commitUrl,
        compareUrl,
      }),
    ),
  };

  try {
    const { saveCommitReview } = require('./commit-review-store');
    saveCommitReview({
      repoFullName,
      branch,
      commit,
      review,
      discordMessage: result.message,
    });
  } catch (error) {
    console.warn('[commit-review] could not persist review:', error.message);
  }

  return result;
}

function shouldReviewRepo(repoFullName) {
  const allow = (process.env.COMMIT_REVIEW_REPOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!allow.length) return true;

  const normalized = repoFullName.toLowerCase();
  return allow.some((entry) => {
    const e = entry.toLowerCase();
    if (e.includes('/')) return e === normalized;
    return normalized.endsWith(`/${e}`);
  });
}

module.exports = {
  reviewCommit,
  formatDiscordReview,
  splitDiscordMessages,
  shouldReviewRepo,
};
