#!/usr/bin/env node
require('dotenv').config({ override: true });

const { google } = require('googleapis');
const {
  listLeadSpreadsheets,
  loadServiceAccountCredentials,
  getLeadsFolderId,
  downloadSpreadsheetBuffer,
} = require('../lib/leads-drive');
const { parseLeadsQuery } = require('../lib/leads-query');
const { searchLeadsAcrossSpreadsheets } = require('../lib/leads-search');

async function main() {
  const creds = loadServiceAccountCredentials();
  if (!creds) {
    console.error('No service account configured.');
    process.exit(1);
  }

  const queryArg = process.argv.slice(2).join(' ').trim();

  console.log('Service account:', creds.client_email);
  console.log('Folder ID:', getLeadsFolderId());

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const shared = await drive.files.list({
    q: 'sharedWithMe = true',
    fields: 'files(id,name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  console.log('Items shared with SA:', shared.data.files?.length || 0);

  const files = await listLeadSpreadsheets();
  console.log('Spreadsheets found:', files.length);
  files.forEach((f) => console.log(`- ${f.name}${f.folderPath ? ` (${f.folderPath})` : ''}`));

  if (files.length && process.argv.includes('--download-first')) {
    const buffer = await downloadSpreadsheetBuffer(files[0]);
    console.log(`Downloaded first file bytes: ${buffer.length}`);
  }

  if (queryArg) {
    const parsed = parseLeadsQuery(queryArg);
    console.log('Query mode:', parsed.mode, parsed.needle || '');
    const result = await searchLeadsAcrossSpreadsheets(queryArg);
    if (result.mode === 'search') {
      console.log('\n--- search result ---\n');
      console.log(result.result.content);
      for (const extra of result.result.extraMessages || []) {
        console.log('\n--- continued ---\n');
        console.log(extra);
      }
    } else {
      console.log('Would use filename matcher for this query.');
    }
  } else {
    console.log('\nTip: npm run leads:test -- 6912345678');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
