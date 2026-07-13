/**
 * Single source of truth for slash command registration and /help content.
 *
 * - `description` / option descriptions → English (Discord slash UI)
 * - `helpSummary`, `helpExamples`, `helpNotes` → Greek (/help message only)
 *
 * Add new commands to COMMAND_CATALOG — registration + /help update together.
 */

const { SlashCommandBuilder } = require('discord.js');
const { splitDiscordMessages } = require('./sales-support');

const COMMAND_CATALOG = [
  {
    name: 'help',
    description: 'Show bot commands with usage examples',
    helpSummary: 'Σύντομος οδηγός για όλες τις εντολές του bot.',
    helpExamples: ['/help'],
  },
  {
    name: 'n8n-linear',
    description: 'Create or manage Linear issues with natural language',
    helpSummary: 'Μίλα στο Linear με απλά λόγια — δημιουργία, αναζήτηση ή ενημέρωση issues.',
    helpExamples: [
      '/n8n-linear command:δημιούργησε issue Διόρθωση Bluetooth εκτυπωτή σε Sunmi P3',
      '/n8n-linear command:ψάξε ανοιχτά bugs στο android',
      '/n8n-linear command:ανάθεσε ENG-42 σε μένα',
    ],
    options: [
      {
        type: 'string',
        name: 'command',
        description: 'Natural language, e.g. create issue Fix login bug',
        required: true,
        maxLength: 2000,
      },
    ],
  },
  {
    name: 'deploy',
    description: 'Trigger an Android APK build for EmblemTameiaki',
    helpSummary: 'Ξεκίνα CI build. Το DEV χρειάζεται branch· το QA πάει στο develop· το PROD στο main.',
    helpExamples: [
      '/deploy type:dev branch:feature/payment-retry',
      '/deploy type:qa',
      '/deploy type:prod',
    ],
    helpNotes: 'Το PROD ζητά επιβεβαίωση. Απαιτείται ρόλος Developer ή Admin.',
    options: [
      {
        type: 'string',
        name: 'type',
        description: 'Build type — DEV needs a branch; QA → develop; PROD → main',
        required: true,
        choices: [
          { name: 'DEV', value: 'dev' },
          { name: 'QA', value: 'qa' },
          { name: 'PROD', value: 'prod' },
        ],
      },
      {
        type: 'string',
        name: 'branch',
        description: 'Branch to build from (DEV builds only)',
        required: false,
      },
    ],
  },
  {
    name: 'sales-support',
    description: 'Sales & customer support briefing from repo + commit reviews',
    helpSummary: 'Εσωτερικό briefing για πωλήσεις/υποστήριξη — απαντήσεις από τεκμηρίωση, κώδικα και commit reviews (EmblemTameiaki).',
    helpExamples: [
      '/sales-support',
      '/sales-support question:Πώς ενεργοποιώ το SoftPOS;',
    ],
    helpNotes: 'Απάντησε στο μήνυμα του bot με «πηγές» ή «sources» για να δεις τις αναφορές από το EmblemTameiaki-Knowledge.',
    options: [
      {
        type: 'string',
        name: 'question',
        description: 'Employee question for sales/support (optional)',
        required: false,
      },
    ],
  },
  {
    name: 'app-status',
    description: 'App status: recent features + potential risks',
    helpSummary: 'Δες πού βρίσκεται η εφαρμογή — πρόσφατες αλλαγές, πιθανά προβλήματα και τι να ελέγξεις.',
    helpExamples: [
      '/app-status',
      '/app-status question:Ποια είναι τα πρόσφατα features;',
      '/app-status question:Τι πιθανά προβλήματα υπάρχουν τώρα;',
    ],
    options: [
      {
        type: 'string',
        name: 'question',
        description: 'Example: recent features, potential problems',
        required: false,
      },
    ],
  },
  {
    name: 'github-issue',
    description: 'Create a new GitHub issue in an org repository',
    helpSummary: 'Άνοιξε GitHub issue χωρίς να φύγεις από το Discord. Το bot διαβάζει τίτλο + περιγραφή, τα μεταφράζει στα **Αγγλικά** και τα κατηγοριοποιεί ως **bug**, **feature** ή **task**.',
    helpExamples: [
      '/github-issue title:Αποσύνδεση εκτυπωτή σε Sunmi P3',
      '/github-issue title:Crash στο αποθήκευση τιμολογίου description:Βήματα αναπαραγωγής…',
      '/github-issue title:Νέα ροή IRIS description:Ο πελάτης θέλει…',
    ],
    helpNotes: 'Το issue στο GitHub είναι πάντα στα Αγγλικά. Ο τύπος (bug / feature / task) μπαίνει στο GitHub **Type** πεδίο — όχι ως label. Προαιρετικό label: discord (default). Χειροκίνητος τύπος: `type:bug` ή `type:feature` ή `type:task`.',
    options: [
      {
        type: 'string',
        name: 'title',
        description: 'Issue title',
        required: true,
      },
      {
        type: 'string',
        name: 'description',
        description: 'Issue description (steps to reproduce, context, etc.)',
        required: false,
      },
      {
        type: 'string',
        name: 'type',
        description: 'Issue type — bug, feature, or task (optional; AI classifies if omitted)',
        required: false,
        choices: [
          { name: 'Bug', value: 'bug' },
          { name: 'Feature', value: 'feature' },
          { name: 'Task', value: 'task' },
        ],
      },
      {
        type: 'string',
        name: 'labels',
        description: 'Comma-separated labels (default: discord)',
        required: false,
      },
    ],
  },
  {
    name: 'leads',
    description: 'Find the Google Drive Excel file for company leads',
    helpSummary: 'Βρες ποιο Excel αρχείο στο Google Drive περιέχει leads για μια εταιρεία ή προϊόν.',
    helpExamples: [
      '/leads question:Ποιο αρχείο έχει τα leads για Emblem Tameiaki;',
      '/leads question:Πού είναι το excel με leads για SoftPOS;',
    ],
    helpNotes: 'Αναζητά read-only στο Google Drive και επιστρέφει σύνδεσμο στο πιο πιθανό Excel. Χρειάζεται service account με πρόσβαση Viewer στον φάκελο leads.',
    options: [
      {
        type: 'string',
        name: 'question',
        description: 'e.g. Which file has leads for Emblem Tameiaki?',
        required: true,
      },
    ],
  },
  {
    name: 'dev',
    description: 'Dev assistant — implementation plans, code ideas, and execution steps',
    helpSummary: 'Πάρε πλάνο υλοποίησης με snippets κώδικα, paths αρχείων και επόμενα βήματα.',
    helpExamples: [
      '/dev question:Πώς προσθέτουμε retry logic στο payment sync;',
      '/dev question:Πού αλλάζω το print encoding για Sunmi;',
    ],
    helpNotes: 'Στέλνει συνημμένο .md με το πλήρες πλάνο όταν η απάντηση είναι μεγάλη. Χρησιμοποιεί πάντα EmblemTameiaki.',
    options: [
      {
        type: 'string',
        name: 'question',
        description: 'Coding question, bug, or feature you want to implement',
        required: true,
      },
    ],
  },
];

function applyStringOption(builder, opt) {
  builder.addStringOption((option) => {
    let chain = option
      .setName(opt.name)
      .setDescription(opt.description)
      .setRequired(!!opt.required);
    if (opt.maxLength) chain = chain.setMaxLength(opt.maxLength);
    if (opt.choices?.length) chain = chain.addChoices(...opt.choices);
    return chain;
  });
}

function buildSlashCommandBuilders() {
  return COMMAND_CATALOG.map((entry) => {
    const builder = new SlashCommandBuilder()
      .setName(entry.name)
      .setDescription(entry.description);

    for (const opt of entry.options || []) {
      if (opt.type === 'string') applyStringOption(builder, opt);
    }

    return builder;
  });
}

function buildSlashCommandsPayload() {
  return buildSlashCommandBuilders().map((command) => command.toJSON());
}

function getSlashCommandNamesLine() {
  return COMMAND_CATALOG.map((entry) => `/${entry.name}`).join(' ');
}

/** Greek help text sent by /help — does not use English `description` fields. */
function buildHelpMessage() {
  const lines = [
    '**Οδηγός εντολών n8n-linear bot**',
    '',
    'Χρησιμοποίησε `/help` όποτε θέλεις βοήθεια. Η λίστα ενημερώνεται αυτόματα όταν προστίθεται νέα εντολή.',
    '',
  ];

  for (const entry of COMMAND_CATALOG) {
    lines.push(`**/${entry.name}**`);
    lines.push(entry.helpSummary);
    for (const example of entry.helpExamples || []) {
      lines.push(`• Παράδειγμα: \`${example}\``);
    }
    if (entry.helpNotes) lines.push(`_${entry.helpNotes}_`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function buildHelpMessages() {
  return splitDiscordMessages(buildHelpMessage());
}

module.exports = {
  COMMAND_CATALOG,
  buildSlashCommandBuilders,
  buildSlashCommandsPayload,
  buildHelpMessage,
  buildHelpMessages,
  getSlashCommandNamesLine,
};
