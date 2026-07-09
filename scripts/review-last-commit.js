#!/usr/bin/env node
/**
 * Review the latest commit on a repo and post to #commit-summary.
 * Usage: node scripts/review-last-commit.js [owner/repo]
 */

require('dotenv').config({ override: true });

const { Client, GatewayIntentBits } = require('discord.js');
const { createClientForFullName } = require('../lib/github-api');
const { reviewCommit } = require('../lib/commit-review');
const { postCommitSummary } = require('../lib/discord-commit-summary');

const repoFullName =
  process.argv[2] ||
  process.env.GITHUB_REPO ||
  'semantic-software/EmblemTameiaki';

async function main() {
  const discordToken = process.env.DISCORD_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!discordToken) throw new Error('DISCORD_TOKEN is not set.');
  if (!githubToken) throw new Error('GITHUB_TOKEN is not set.');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const { client, repo } = createClientForFullName(githubToken, repoFullName);
  const repoInfo = await client.getRepo(repo);
  const branch = repoInfo.default_branch;

  console.log(`Fetching latest commit on ${repoFullName}@${branch}…`);
  const commits = await client.listCommits(repo, { sha: branch, perPage: 1 });
  const latest = commits[0];
  if (!latest) throw new Error(`No commits found on ${repoFullName}@${branch}`);

  const commit = {
    sha: latest.sha,
    shortSha: latest.sha.slice(0, 7),
    message: (latest.commit?.message || '').split('\n')[0],
    author: latest.commit?.author?.name || latest.author?.login || 'unknown',
    url: latest.html_url || '',
  };

  console.log(`Reviewing ${commit.shortSha}: ${commit.message}`);

  const result = await reviewCommit({
    repoFullName,
    branch,
    commit,
    compareUrl: `${repoInfo.html_url}/commit/${commit.sha}`,
    onProgress: (status) => console.log(status),
  });

  console.log('Posting to Discord…');
  const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
  await discord.login(discordToken);

  try {
    const channel = await postCommitSummary(discord, result.messages);
    console.log(`Posted to #${channel.name}`);
  } finally {
    discord.destroy();
  }
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
