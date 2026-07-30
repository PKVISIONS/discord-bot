#!/usr/bin/env node
/**
 * HTTP server for GitHub push webhooks → commit review + knowledge reindex,
 * plus the Ops GUI error handler (/ops).
 */

const http = require('http');
const { verifySignature, parsePushEvent } = require('./github-webhook');
const { shouldReviewRepo } = require('./commit-review');
const { hasReview } = require('./commit-review-store');
const { reviewAndPublish } = require('./auto-commit-review');
const {
  isKnowledgeAutoReindexEnabled,
  shouldHandleKnowledgePush,
  queueKnowledgeReindex,
} = require('./knowledge-reindex-sync');
const { tryHandleOpsRequest, isOpsGuiEnabled } = require('./ops-gui');

function isCommitReviewEnabled() {
  return process.env.COMMIT_REVIEW_ENABLED === 'true';
}

function shouldStartWebhookServer() {
  return isCommitReviewEnabled() || isKnowledgeAutoReindexEnabled() || isOpsGuiEnabled();
}

function needsGithubWebhookSecret() {
  return isCommitReviewEnabled() || isKnowledgeAutoReindexEnabled();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function resolveListenPort() {
  // Railway (and most PaaS) inject PORT — prefer that so /ops is publicly reachable.
  const raw = process.env.PORT || process.env.WEBHOOK_PORT || '3847';
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : 3847;
}

function publicBaseUrl(port) {
  if (process.env.WEBHOOK_PUBLIC_URL) {
    return String(process.env.WEBHOOK_PUBLIC_URL).replace(/\/$/, '');
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `http://localhost:${port}`;
}

function createWebhookServer({ discordClient, onLog = console.log }) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
  const port = resolveListenPort();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        commitReview: isCommitReviewEnabled(),
        knowledgeReindex: isKnowledgeAutoReindexEnabled(),
        autoReview: process.env.COMMIT_AUTO_REVIEW === 'true',
        opsGui: isOpsGuiEnabled(),
      }));
      return;
    }

    try {
      if (await tryHandleOpsRequest(req, res)) return;
    } catch (error) {
      onLog(`[ops-gui] request failed: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Ops GUI error' }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/github/webhook') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (!needsGithubWebhookSecret()) {
      res.writeHead(503);
      res.end('GitHub webhook disabled');
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

    if (shouldHandleKnowledgePush(payload)) {
      const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
      onLog(`[webhook] knowledge docs changed on ${payload.repository?.full_name}@${branch}`);
      queueKnowledgeReindex({
        reason: `webhook ${branch}@${payload.after || 'unknown'}`,
        sha: payload.after || null,
        onLog,
      });
    }

    if (!isCommitReviewEnabled()) return;

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
    if (!shouldStartWebhookServer()) {
      onLog('[webhook] disabled (commit review off, knowledge auto-reindex off, ops GUI off)');
      return null;
    }

    if (needsGithubWebhookSecret() && !secret) {
      if (!isOpsGuiEnabled()) {
        onLog('[webhook] disabled (GITHUB_WEBHOOK_SECRET not set)');
        return null;
      }
      onLog('[webhook] GitHub webhook off (GITHUB_WEBHOOK_SECRET not set); Ops GUI still starting');
    }

    server.listen(port, '0.0.0.0', () => {
      const publicUrl = publicBaseUrl(port);
      if (needsGithubWebhookSecret() && secret) {
        onLog(`[webhook] listening on 0.0.0.0:${port} — configure GitHub → ${publicUrl}/github/webhook`);
      } else {
        onLog(`[webhook] listening on 0.0.0.0:${port}`);
      }
      if (isKnowledgeAutoReindexEnabled()) {
        onLog(`[webhook] knowledge auto-reindex on for ${process.env.KNOWLEDGE_GITHUB_REPO || 'semantic-software/EmblemTameiaki-Knowledge'}`);
      }
      if (isOpsGuiEnabled()) {
        const token = process.env.OPS_GUI_TOKEN;
        const guiUrl = token
          ? `${publicUrl}/ops/?token=${encodeURIComponent(token)}`
          : `${publicUrl}/ops/`;
        onLog(`[ops-gui] open ${guiUrl}`);
        if (!token && (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.WEBHOOK_PUBLIC_URL)) {
          onLog('[ops-gui] warning: set OPS_GUI_TOKEN — /ops is publicly reachable without a token');
        }
      }
    });

    return server;
  }

  return { server, start, port };
}

module.exports = {
  createWebhookServer,
  isCommitReviewEnabled,
  shouldStartWebhookServer,
};
