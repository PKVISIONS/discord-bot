/**
 * GitHub tracking issues for Linear plans (created before PR).
 */

function githubIssueTitle(plan) {
  return `[${plan.issueIdentifier}] ${plan.summary || plan.issueTitle}`;
}

function formatGitHubIssueBody(plan) {
  const lines = [
    `**Linear:** [${plan.issueIdentifier}](${plan.issueUrl}) — ${plan.issueTitle || plan.summary}`,
    plan.planDocUrl ? `**Plan doc:** ${plan.planDocUrl}` : null,
    plan.repo && plan.repo !== 'TBD' ? `**Repo:** \`${plan.repo}\`` : null,
    plan.branch ? `**Planned branch:** \`${plan.branch}\`` : null,
    '',
    '## Plan steps',
    '',
    ...(plan.steps || []).map((step, i) => `${i + 1}. ${step}`),
    '',
    plan.issueDescription ? '## Linear description\n' : null,
    plan.issueDescription || null,
    '',
    '_Created by Discord → Linear bot. Reply **go** in Discord to run AI edits and open a PR._',
  ].filter((line) => line !== null);

  return lines.join('\n');
}

async function findOpenIssueForLinear(github, repo, issueIdentifier) {
  try {
    const q = encodeURIComponent(
      `repo:${github.org}/${repo} is:issue is:open ${issueIdentifier} in:title`,
    );
    const data = await github.searchIssues(q);
    return (data.items || []).find((item) => item.title?.includes(`[${issueIdentifier}]`)) || null;
  } catch (error) {
    if (error.status === 403 || error.status === 404) return null;
    throw error;
  }
}

/**
 * @returns {{ number: number, url: string, created: boolean } | null}
 */
async function ensureGitHubIssue(github, plan) {
  if (!plan.repo || plan.repo === 'TBD') return null;

  if (plan.githubIssueNumber && plan.githubIssueUrl) {
    return {
      number: plan.githubIssueNumber,
      url: plan.githubIssueUrl,
      created: false,
    };
  }

  const existing = await findOpenIssueForLinear(github, plan.repo, plan.issueIdentifier);
  if (existing) {
    return {
      number: existing.number,
      url: existing.html_url,
      created: false,
    };
  }

  const payload = {
    title: githubIssueTitle(plan),
    body: formatGitHubIssueBody(plan),
  };

  try {
    const created = await github.createIssue(plan.repo, { ...payload, labels: ['linear-bot'] });
    return { number: created.number, url: created.html_url, created: true };
  } catch (error) {
    if (error.status === 422) {
      try {
        const created = await github.createIssue(plan.repo, payload);
        return { number: created.number, url: created.html_url, created: true };
      } catch (retryError) {
        if (retryError.status === 403) return null;
        throw retryError;
      }
    }
    if (error.status === 403) return null;
    throw error;
  }
}

module.exports = {
  githubIssueTitle,
  formatGitHubIssueBody,
  ensureGitHubIssue,
};
