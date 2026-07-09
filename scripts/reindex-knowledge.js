#!/usr/bin/env node
/**
 * Rebuild the vector index from all sources (wiki, Discord vendor attachments,
 * FAQ, commit reviews, Discord captures). Safe to re-run: incremental by content
 * hash, only new/changed chunks are embedded.
 *
 * Usage: node scripts/reindex-knowledge.js
 */

require('dotenv').config({ override: true });

const { reindexAll } = require('../lib/knowledge-indexer');

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set.');

  console.log('Reindexing knowledge into the vector store…');
  const { results, stats } = await reindexAll({
    onProgress: (status) => console.log(`  ${status}`),
  });

  console.log('\nPer-namespace results:');
  for (const r of results) {
    console.log(
      `  ${r.namespace.padEnd(16)} embedded=${r.embedded} total=${r.total} removed=${r.removed}`,
    );
  }

  console.log('\nIndex stats:');
  console.log(`  model: ${stats.model}`);
  console.log(`  total chunks: ${stats.total}`);
  for (const [ns, count] of Object.entries(stats.byNamespace)) {
    console.log(`  ${ns}: ${count}`);
  }
}

main().catch((error) => {
  console.error('Reindex failed:', error.message);
  process.exit(1);
});
