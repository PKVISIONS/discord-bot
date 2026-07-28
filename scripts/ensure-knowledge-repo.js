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

  fs.mkdirSync(path.dirname(root), { recursive: true });

  if (!hasKnowledgeCheckout(root)) {
    console.log(`[knowledge-boot] cloning ${fullName} → ${root}`);
    git(process.cwd(), [
      'clone',
      '--depth',
      '50',
      '--branch',
      branch,
      cloneUrl(fullName),
      root,
    ]);
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
