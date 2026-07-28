#!/usr/bin/env node
/**
 * Railway / production entry: clone knowledge repo, then start the Discord bridge.
 */

require('./ensure-knowledge-repo').ensureKnowledgeRepo();
require('../discord-bridge');
