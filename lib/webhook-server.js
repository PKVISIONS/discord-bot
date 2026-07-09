/**
 * HTTP server for GitHub push webhooks → AI commit review → Discord.
 */

const http = require('http');
const { verifySignature, parsePushEvent } = require('./github-webhook');
const { shouldReviewRepo } = require('./commit-review');
const { hasReview } = require('./commit-review-store');
const { reviewAndPublish } = require('./auto-commit-review');

function isEnabled() {
  return process.env.COMMIT_REVIEW_ENABLED === 'true';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createWebhookServer({ discordClient, onLog = console.log }) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
  const port = Number(process.env.WEBHOOK_PORT || 3847);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        commitReview: isEnabled(),
        autoReview: process.env.COMMIT_AUTO_REVIEW === 'true',
      }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/github/webhook') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (!isEnabled()) {
      res.writeHead(503);
      res.end('Commit review disabled');
      return;
    }

    const rawBody = await readBody(req);
    const signature = req.headers['x-hub-signature-256'] || '';
    const event = req.headers['x-github-event'] || '';

    if (!verifySignature(rawBody, signature, secret)) {
      onLog('[webhook] rejected: invalid signature');
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, event }));

    if (event !== 'push') {
      onLog(`[webhook] ignored event: ${event}`);
      return;
    }

    const push = parsePushEvent(payload);
    if (!push || push.deleted) {
      onLog('[webhook] ignored: deleted branch or invalid push');
      return;
    }

    if (!shouldReviewRepo(push.repoFullName)) {
      onLog(`[webhook] skipped repo (filter): ${push.repoFullName}`);
      return;
    }

    const commits = push.commits.filter((c) => c.distinct);
    if (!commits.length) {
      onLog('[webhook] no distinct commits to review');
      return;
    }

    onLog(`[webhook] push ${push.repoFullName}@${push.branch} (${commits.length} commit(s))`);

    for (const commit of commits) {
      if (hasReview(push.repoFullName, commit.sha)) {
        onLog(`[webhook] skip stored ${commit.shortSha}`);
        continue;
      }

      try {
        await reviewAndPublish({
          discordClient,
          repoFullName: push.repoFullName,
          branch: push.branch,
          commit,
          compareUrl: push.compareUrl,
          onLog,
        });
      } catch (error) {
        onLog(`[review] failed ${commit.shortSha}: ${error.message}`);
      }
    }
  });

  function start() {
    if (!isEnabled()) {
      onLog('[webhook] commit review disabled (set COMMIT_REVIEW_ENABLED=true)');
      return null;
    }

    if (!secret) {
      onLog('[webhook] commit review disabled (GITHUB_WEBHOOK_SECRET not set)');
      return null;
    }

    server.listen(port, () => {
      const publicUrl = process.env.WEBHOOK_PUBLIC_URL || `http://localhost:${port}`;
      onLog(`[webhook] listening on :${port} — configure GitHub → ${publicUrl}/github/webhook`);
    });

    return server;
  }

  return { server, start, port };
}

module.exports = {
  createWebhookServer,
  isEnabled,
};
