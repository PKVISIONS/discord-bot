#!/usr/bin/env node
/**
 * Ensure EmblemTameiaki-Knowledge is cloned locally (needed on Railway / any host
 * without a pre-existing Mac path).
 *
 * Uses GITHUB_TOKEN when cloning private repos.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

require('dotenv').config({ override: true });

const DEFAULT_REPO = 'semantic-software/EmblemTameiaki-Knowledge';
const DEFAULT_BRANCH = 'ai/sales-support-knowledge';

function containerFallbackRoot() {
  return path.join(process.cwd(), 'data', 'EmblemTameiaki-Knowledge');
}

function knowledgeRoot() {
  const fallback = containerFallbackRoot();
  const envPath = (process.env.KNOWLEDGE_REPO_PATH || '').trim();
  if (!envPath) return fallback;

  const resolved = path.resolve(envPath);
  if (hasKnowledgeCheckout(resolved)) return resolved;

  // Common Railway mistake: Mac .env path copied into Variables.
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  const looksLikeMacPath = resolved.startsWith('/Users/') || resolved.includes('/Documents/GitHub/');
  if (onRailway || looksLikeMacPath || process.platform !== 'darwin') {
    console.warn(`[knowledge-boot] ignoring unavailable KNOWLEDGE_REPO_PATH=${envPath}`);
    console.warn(`[knowledge-boot] using ${fallback} instead`);
    return fallback;
  }

  return resolved;
}

function knowledgeRepoFullName() {
  return process.env.KNOWLEDGE_GITHUB_REPO || DEFAULT_REPO;
}

function preferredBranch() {
  return (process.env.KNOWLEDGE_REPO_BRANCH || DEFAULT_BRANCH).trim();
}

function cloneUrl(fullName) {
  const token = process.env.GITHUB_TOKEN || '';
  if (token) {
    return `https://x-access-token:${token}@github.com/${fullName}.git`;
  }
  return `https://github.com/${fullName}.git`;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function hasKnowledgeCheckout(root) {
  return fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, 'docs'));
}

function ensureKnowledgeRepo() {
  const root = knowledgeRoot();
  const fullName = knowledgeRepoFullName();
  const branch = preferredBranch();

  // #region agent log
  const { agentLog } = require('../lib/debug-log');
  let gitVersion = null;
  let gitError = null;
  try {
    gitVersion = git(process.cwd(), ['--version']);
  } catch (e) {
    gitError = e.message;
  }
  agentLog({
    runId: 'run1',
    hypothesisId: 'H2,H3',
    location: 'scripts/ensure-knowledge-repo.js:70',
    message: 'ensureKnowledgeRepo entry',
    data: {
      resolvedRoot: root,
      envPath: process.env.KNOWLEDGE_REPO_PATH || '',
      fullName,
      branch,
      tokenPresent: Boolean(process.env.GITHUB_TOKEN),
      alreadyCheckedOut: hasKnowledgeCheckout(root),
      gitVersion,
      gitError,
    },
  });
  // #endregion

  fs.mkdirSync(path.dirname(root), { recursive: true });

  if (!hasKnowledgeCheckout(root)) {
    console.log(`[knowledge-boot] cloning ${fullName} → ${root}`);
    // #region agent log
    try {
      git(process.cwd(), ['clone', '--depth', '50', '--branch', branch, cloneUrl(fullName), root]);
      agentLog({
        runId: 'run1',
        hypothesisId: 'H3,H4',
        location: 'scripts/ensure-knowledge-repo.js:105',
        message: 'clone finished',
        data: { root, docsExists: fs.existsSync(path.join(root, 'docs')), gitExists: fs.existsSync(path.join(root, '.git')) },
      });
    } catch (cloneError) {
      agentLog({
        runId: 'run1',
        hypothesisId: 'H3,H4',
        location: 'scripts/ensure-knowledge-repo.js:105',
        message: 'clone FAILED',
        data: { root, fullName, branch, error: String(cloneError.message || cloneError).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@') },
      });
      throw cloneError;
    }
    // #endregion
  } else {
    console.log(`[knowledge-boot] updating ${root} (branch ${branch})`);
    try {
      git(root, ['remote', 'set-url', 'origin', cloneUrl(fullName)]);
    } catch {
      // ignore if remote missing; fetch below will surface the real error
    }
    try {
      git(root, ['fetch', 'origin', branch, '--depth', '50', '--quiet']);
    } catch (error) {
      console.warn(`[knowledge-boot] fetch failed: ${error.message}`);
    }
  }

  if (!hasKnowledgeCheckout(root)) {
    throw new Error(`Knowledge repo missing after clone: ${root}`);
  }

  // Persist the resolved path for the bot process (and child scripts).
  process.env.KNOWLEDGE_REPO_PATH = root;
  console.log(`[knowledge-boot] ready at ${root}`);
  return root;
}

if (require.main === module) {
  try {
    ensureKnowledgeRepo();
  } catch (error) {
    console.error(`[knowledge-boot] failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { ensureKnowledgeRepo, knowledgeRoot };
