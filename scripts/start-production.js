#!/usr/bin/env node
/**
 * Railway / production entry: clone knowledge repo, then start the Discord bridge.
 */

try {
  require('./ensure-knowledge-repo').ensureKnowledgeRepo();
} catch (error) {
  console.error(`[knowledge-boot] skipping knowledge repo sync: ${error.message}`);
}

require('../discord-bridge');
