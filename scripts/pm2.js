#!/usr/bin/env node
/**
 * Thin wrapper around PM2 for daemon management.
 * Usage: node scripts/pm2.js <start|stop|restart|status|logs|save>
 */

const { spawnSync } = require('child_process');
const path = require('path');

const action = process.argv[2] || 'status';
const appName = 'discord-linear-bot';
const root = path.join(__dirname, '..');
const ecosystem = path.join(root, 'ecosystem.config.cjs');

const actions = {
  start: ['start', ecosystem, '--update-env'],
  stop: ['stop', appName],
  restart: ['restart', appName, '--update-env'],
  delete: ['delete', appName],
  status: ['status', appName],
  logs: ['logs', appName, '--lines', '100'],
  save: ['save'],
  startup: ['startup'],
};

const args = actions[action];
if (!args) {
  console.error(`Unknown action: ${action}`);
  console.error(`Available: ${Object.keys(actions).join(', ')}`);
  process.exit(1);
}

const result = spawnSync('npx', ['pm2', ...args], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
