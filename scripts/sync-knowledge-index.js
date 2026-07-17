#!/usr/bin/env node
/**
 * Manually sync the vector index when EmblemTameiaki-Knowledge changed.
 * The bot also does this automatically on push webhook + polling.
 */

require('dotenv').config({ override: true });

const { runKnowledgeReindexSync } = require('../lib/knowledge-reindex-sync');

async function main() {
  const force = process.argv.includes('--force');
  const result = await runKnowledgeReindexSync({
    reason: 'cli',
    force,
    onLog: (status) => console.log(status),
  });

  if (result.skipped) {
    console.log(`Skipped: ${result.reason}${result.sha ? ` (${result.sha.slice(0, 7)})` : ''}`);
    return;
  }

  console.log(`Synced @ ${result.sha.slice(0, 7)} — ${result.stats.total} chunks total`);
}

main().catch((error) => {
  console.error('Knowledge sync failed:', error.message);
  process.exit(1);
});
