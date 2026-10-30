const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// In-memory stand-ins for the Google services, so the whole submit -> approve -> file workflow can run offline.
function createWorld() {
  const source = fs.readFileSync(`${__dirname}/Code.gs`, 'utf8');
  const sheets = {};
  const files = {};
  const folders = {};
  const mails = [];
  const triggers = [];
  const props = {
    SPREADSHEET_ID: 'sheet', WORKING_FOLDER_ID: 'work', ARCHIVE_FOLDER_ID: 'archive',
    PDF_SERVICE_URL: 'https://pdf.example/merge', PDF_SERVICE_TOKEN: 'token', ALLOWED_DOMAIN: 'x.edu',
    ADMIN_EMAILS: 'a@x.edu', AP_EMAIL: 'ap@x.edu',
  };
  let user = 'a@x.edu';
  let nextId = 1;
  const id = prefix => `${prefix}${nextId++}`;

  const makeSheet = name => {
    const rows = [];
    const sheet = {
      rows,
      getName: () => name,
      getLastRow: () => rows.length,
      getLastColumn: () => (rows[0] || []).length,
      getMaxColumns: () => 50,
      insertColumnsAfter() {},
      setFrozenRows() {},
      getDataRange: () => ({ getValues: () => rows.map(row => row.slice()) }),
      appendRow: row => { rows.push(row.slice()); },
      deleteRow: n => { rows.splice(n - 1, 1); },
      getRange: (row, col, numRows = 1, numCols = 1) => ({
        getValues: () => Array.from({ length: numRows }, (_, r) =>
          Array.from({ length: numCols }, (_, k) => (rows[row - 1 + r] || [])[col - 1 + k] ?? '')),
        setValues: values => values.forEach((vals, r) => {
          rows[row - 1 + r] = rows[row - 1 + r] || [];
          vals.forEach((value, k) => { rows[row - 1 + r][col - 1 + k] = value; });
        }),
        setValue: value => {
          rows[row - 1] = rows[row - 1] || [];
          rows[row - 1][col - 1] = value;
        },
      }),
    };
    return sheet;
  };

  const makeFolder = (name, parent) => {
    const folderId = id('folder');
    const folder = {
      id: folderId, name, trashed: false, children: [],
      getId: () => folderId, getName: () => name, setTrashed() { folder.trashed = true; },
      createFolder: childName => makeFolder(childName, folder),
      createFile(blob) {
        const fileId = id('file');
        const file = {
          id: fileId, trashed: false, blob, folder,
          getId: () => fileId, getBlob: () => blob, setTrashed() { file.trashed = true; },
          getParents: () => ({ hasNext: () => true, next: () => folder }),
          getAs: () => blob,
        };
        files[fileId] = file;
        return file;
      },
      getFoldersByName: wanted => {
        const found = folder.children.filter(child => child.getName() === wanted);
        let index = 0;
        return { hasNext: () => index < found.length, next: () => found[index++] };
      },
    };
    folders[folderId] = folder;
    if (parent) parent.children.push(folder);
    return folder;
  };

  const blobFor = (bytes, type, name) => ({
    bytes, type, name,
    getBytes: () => bytes,
    getDataAsString: () => Buffer.from(bytes).toString('latin1'),
    setName(newName) { this.name = newName; return this; },
  });

  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] || null }) },
    Session: { getActiveUser: () => ({ getEmail: () => user }), getScriptTimeZone: () => 'America/Phoenix' },
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets[name] || null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    MimeType: { PDF: 'application/pdf' },
    Utilities: {
      getUuid: () => id('uuid-'),
      base64Decode: text => [...Buffer.from(text, 'base64')],
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      newBlob: blobFor,
      formatDate: (date, zone, pattern) => `${pattern}:${new Date(date).toISOString().slice(0, 10)}`,
    },
    UrlFetchApp: {
      fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ pdf: Buffer.from('%PDF-1.4 merged').toString('base64') }) }),
    },
    MailApp: {
      sendEmail: (...args) => mails.push(typeof args[0] === 'object' ? args[0] : { to: args[0], subject: args[1], body: args[2] }),
      getRemainingDailyQuota: () => 100,
    },
    DriveApp: {
      getFolderById: folderId => folders[folderId],
      getFileById: fileId => {
        if (!files[fileId]) throw new Error('missing file');
        return files[fileId];
      },
    },
    ScriptApp: {
      EventType: { CLOCK: 'CLOCK' },
      getService: () => ({ getUrl: () => 'https://app.example/exec' }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: trigger => { triggers.splice(triggers.indexOf(trigger), 1); },
      newTrigger: handler => ({
        timeBased: () => ({ after: () => ({ create: () => {
          const trigger = { getHandlerFunction: () => handler, getEventType: () => 'CLOCK' };
          triggers.push(trigger);
          return trigger;
        } }) }),
      }),
    },
  });
  vm.runInContext(source, context);
  const run = expression => vm.runInContext(expression, context);
  const HEADERS = run('HEADERS');
  Object.keys(HEADERS).forEach(name => {
    sheets[name] = makeSheet(name);
    sheets[name].rows.push(HEADERS[name].slice());
  });
  const root = makeFolder('root');
  folders.work = root; root.id = 'work';
  const archive = makeFolder('archive'); folders.archive = archive;

  const signature = root.createFile(blobFor([1, 2, 3], 'image/png', 'sig.png'));
  const row = (name, values) => sheets[name].rows.push(HEADERS[name].map(key => values[key] ?? ''));
  row('Approvers', { Name: 'Alice', Email: 'a@x.edu', Active: true, SignatureFileId: signature.getId() });
  row('Approvers', { Name: 'Bob', Email: 'b@x.edu', Active: true, SignatureFileId: signature.getId() });

  const pdf = Buffer.from('%PDF-1.4 invoice').toString('base64');
  return {
    run, sheets, mails, triggers, files,
    as: email => { user = email; },
    call: (fn, arg) => { context.__arg = arg; return run(`${fn}(__arg)`); },
    invoiceInput: extra => ({
      vendor: 'Acme', po: 'PO-1', invoiceNo: 'INV-1', invoiceDate: '2026-02-03', amount: '15000',
      approver1: 'a@x.edu', approver2: 'b@x.edu', notes: '', file: { name: 'inv.pdf', data: pdf }, ...extra,
    }),
    runTrigger: () => { context.__event = { triggerUid: 'uid' }; run('processQueue(__event)'); },
  };
}

const status = world => world.sheets.Invoices.rows.slice(1).map(row => row[1]);

test('submit returns immediately and the queue builds the package and notifies the approver', () => {
  const world = createWorld();
  const result = world.call('submitInvoice', world.invoiceInput());
  assert.equal(result.queued, true);
  assert.equal(world.mails.length, 0);
  assert.equal(world.triggers.length, 1);
  const before = world.call('getDashboard');
  assert.equal(before[0].building, true);
  assert.equal(before[0].canApprove, false);

  world.runTrigger();
  assert.equal(world.triggers.length, 0);
  const [invoice] = world.call('getDashboard');
  assert.equal(invoice.canApprove, true);
  assert.equal(invoice.group, 'pending');
  assert.match(world.mails[0].body, /app\.example\/exec\?invoice=uuid-/);
});

test('two approvals, background filing, and AP email', () => {
  const world = createWorld();
  world.call('submitInvoice', world.invoiceInput());
  world.runTrigger();
  const invoiceId = world.call('getDashboard')[0].id;

  world.call('decideInvoice', { id: invoiceId, action: 'approve', note: 'ok' });
  assert.deepEqual(status(world), ['Pending Approver 2']);
  world.runTrigger();
  world.as('b@x.edu');
  assert.equal(world.call('getDashboard')[0].canApprove, true);
  world.call('decideInvoice', { id: invoiceId, action: 'approve', note: '' });
  assert.deepEqual(status(world), ['Processing final PDF']);
  world.runTrigger();
  assert.deepEqual(status(world), ['Filed']);
  assert.ok(world.mails.some(mail => mail.to === 'ap@x.edu'));
});

test('rejection reason is returned to the submitter and the invoice can be withdrawn and revised', () => {
  const world = createWorld();
  world.call('submitInvoice', world.invoiceInput({ approver2: '' }));
  world.runTrigger();
  const invoiceId = world.call('getDashboard')[0].id;
  world.call('decideInvoice', { id: invoiceId, action: 'reject', note: 'Wrong PO' });
  const [rejected] = world.call('getDashboard');
  assert.equal(rejected.rejectionNote, 'Wrong PO');
  assert.equal(rejected.canRevise, true);
  assert.equal(rejected.canWithdraw, true);

  world.call('withdrawInvoice', invoiceId);
  assert.deepEqual(status(world), ['Withdrawn']);
  assert.equal(world.call('getDashboard')[0].canRevise, true);
  const history = world.call('getHistory', invoiceId).map(entry => entry.action);
  assert.deepEqual(history.slice(0, 2), ['Submitted', 'Package built']);
  assert.ok(history.includes('Withdrawn'));
});

test('search filters by status and date, and CSV export neutralizes formulas', () => {
  const world = createWorld();
  world.call('submitInvoice', world.invoiceInput());
  world.call('submitInvoice', world.invoiceInput({ vendor: '=cmd', invoiceNo: 'INV-2', invoiceDate: '2026-05-01' }));
  assert.equal(world.call('searchInvoices', { status: 'pending' }).total, 2);
  assert.equal(world.call('searchInvoices', { status: 'filed' }).total, 0);
  assert.equal(world.call('searchInvoices', { from: '2026-04-01' }).total, 1);
  assert.equal(world.call('searchInvoices', { query: 'acme' }).total, 1);
  const csv = world.call('exportInvoicesCsv', {}).csv;
  assert.match(csv, /'=cmd/);
  assert.equal(csv.split('\r\n').length, 3);
});

test('vendor hints return recent POs and last-used approvers', () => {
  const world = createWorld();
  world.call('submitInvoice', world.invoiceInput());
  world.call('submitInvoice', world.invoiceInput({ invoiceNo: 'INV-2', po: 'PO-2' }));
  const boot = world.call('getBootstrap');
  assert.equal(boot.vendors.length, 1);
  assert.deepEqual([...boot.vendors[0].pos].sort(), ['PO-1', 'PO-2']);
  assert.equal(boot.vendors[0].approver2, 'b@x.edu');
});

test('only admins may run the queue by hand', () => {
  const world = createWorld();
  world.as('b@x.edu');
  assert.throws(() => world.run('processQueue()'), /Only an admin/);
});
