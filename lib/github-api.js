/**
 * Minimal GitHub REST client for plan execution.
 */

const API_VERSION = '2022-11-28';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'Content-Type': 'application/json',
  };
}

async function githubRequest(token, method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: authHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.message || data?.errors?.[0]?.message || text || response.statusText;
    const error = new Error(`GitHub API ${response.status}: ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function createClient(token, org) {
  const get = (path) => githubRequest(token, 'GET', path);
  const post = (path, body) => githubRequest(token, 'POST', path, body);
  const put = (path, body) => githubRequest(token, 'PUT', path, body);

  return {
    org,
    token,

    async getRepo(repo) {
      return get(`/repos/${org}/${repo}`);
    },

    async getDefaultBranchSha(repo) {
      const repoInfo = await this.getRepo(repo);
      const ref = await get(`/repos/${org}/${repo}/git/ref/heads/${repoInfo.default_branch}`);
      return {
        defaultBranch: repoInfo.default_branch,
        sha: ref.object.sha,
        htmlUrl: repoInfo.html_url,
      };
    },

    async getBranchSha(repo, branch) {
      const ref = await get(`/repos/${org}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      return ref.object.sha;
    },

    async listTreePaths(repo, sha) {
      const tree = await get(`/repos/${org}/${repo}/git/trees/${sha}?recursive=1`);
      return (tree.tree || [])
        .filter((entry) => entry.type === 'blob')
        .map((entry) => entry.path);
    },

    async getFileContent(repo, path, ref) {
      const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
      const file = await get(`/repos/${org}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
      if (Array.isArray(file) || file.type !== 'file') {
        throw new Error(`Path is not a file: ${path}`);
      }
      const content = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      return { content, sha: file.sha };
    },

    async createBranch(repo, branch, baseSha) {
      try {
        await post(`/repos/${org}/${repo}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });
        return branch;
      } catch (error) {
        if (error.status !== 422) throw error;
        const alt = `${branch}-${Date.now()}`;
        await post(`/repos/${org}/${repo}/git/refs`, {
          ref: `refs/heads/${alt}`,
          sha: baseSha,
        });
        return alt;
      }
    },

    async upsertFile(repo, path, branch, content, message, existingSha) {
      const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
      const body = {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
      };
      if (existingSha) body.sha = existingSha;

      return put(`/repos/${org}/${repo}/contents/${encoded}`, body);
    },

    async createPullRequest(repo, title, head, base, body) {
      return post(`/repos/${org}/${repo}/pulls`, { title, head, base, body });
    },

    async searchIssues(query) {
      return get(`/search/issues?q=${query}`);
    },

    async createIssue(repo, { title, body, labels = [] }) {
      return post(`/repos/${org}/${repo}/issues`, { title, body, labels });
    },

    async getCommit(repo, sha) {
      return get(`/repos/${org}/${repo}/commits/${sha}`);
    },

    async listCommits(repo, { sha, perPage = 1 } = {}) {
      const params = new URLSearchParams({ per_page: String(perPage) });
      if (sha) params.set('sha', sha);
      return get(`/repos/${org}/${repo}/commits?${params}`);
    },

    async listOrgRepos(perPage = 100) {
      return get(`/orgs/${org}/repos?per_page=${perPage}&sort=updated`);
    },

    async listBranches(repo, perPage = 100) {
      return get(`/repos/${org}/${repo}/branches?per_page=${perPage}`);
    },

    async listAllBranches(repo, { maxPages = 10 } = {}) {
      const all = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const batch = await get(`/repos/${org}/${repo}/branches?per_page=100&page=${page}`);
        if (!Array.isArray(batch) || !batch.length) break;
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },

    async listPullRequests(repo, { state = 'closed', perPage = 25, sort = 'updated' } = {}) {
      const params = new URLSearchParams({
        state,
        per_page: String(perPage),
        sort,
      });
      return get(`/repos/${org}/${repo}/pulls?${params}`);
    },
  };
}

function parseRepoFullName(fullName) {
  const parts = String(fullName || '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo full name: ${fullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function createClientForFullName(token, fullName) {
  const { owner, repo } = parseRepoFullName(fullName);
  const client = createClient(token, owner);
  return { client, owner, repo, fullName: `${owner}/${repo}` };
}

const SKIP_PATH_RE =
  /(^|\/)(node_modules|dist|build|coverage|\.next|vendor|__pycache__|\.git)(\/|$)|\.(lock|min\.js|min\.css|map|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip|tar|gz)$/i;

function filterTreePaths(paths, max = 250) {
  return paths
    .filter((p) => !SKIP_PATH_RE.test(p))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
}

module.exports = {
  createClient,
  createClientForFullName,
  parseRepoFullName,
  filterTreePaths,
};
