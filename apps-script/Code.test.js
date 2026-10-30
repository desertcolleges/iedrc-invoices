const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/Code.gs`, 'utf8');

function authenticate(email, domain = 'example.edu') {
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => domain }) },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
  };
  return vm.runInNewContext(`${source}\nrequireUser_()`, context);
}

test('accepts a signed-in user from the configured Workspace domain', () => {
  assert.equal(authenticate('Approver@Example.edu').email, 'approver@example.edu');
});

test('rejects users with no email or from another domain', () => {
  assert.throws(() => authenticate(''), /not authorized/);
  assert.throws(() => authenticate('user@other.edu'), /not authorized/);
});

test('requires ALLOWED_DOMAIN to be configured', () => {
  assert.throws(() => authenticate('user@example.edu', ''), /ALLOWED_DOMAIN/);
});

function call(expression, context = {}) {
  return vm.runInNewContext(`${source}\n${expression}`, context);
}

test('suggestRoute_ picks the highest matching active threshold', () => {
  const rules = [
    { MinAmount: 0, Approver1: 'A@x.edu', Approver2: '', Active: true },
    { MinAmount: 5000, Approver1: 'b@x.edu', Approver2: 'c@x.edu', Active: 'TRUE' },
    { MinAmount: 9000, Approver1: 'd@x.edu', Approver2: '', Active: false },
  ];
  const route = amount => call(`suggestRoute_(${JSON.stringify(rules)}, ${amount})`);
  assert.equal(route(100).approver1, 'a@x.edu');
  assert.equal(route(6000).approver2, 'c@x.edu');
  assert.equal(route(20000).approver1, 'b@x.edu');
});

test('duplicate detection ignores case and the invoice being revised', () => {
  const invoices = [{ ID: '1', Vendor: 'Acme', InvoiceNo: 'A-1', Status: 'Filed' }];
  const find = (vendor, number, exclude) =>
    call(`findDuplicate_(${JSON.stringify(invoices)}, ${JSON.stringify({ vendor, invoiceNo: number })}, '${exclude}')`);
  assert.equal(find(' acme ', 'a-1', '').ID, '1');
  assert.equal(find('acme', 'a-1', '1'), null);
  assert.equal(find('acme', 'a-2', ''), null);
});

test('settings validation enforces limits and normalizes emails', () => {
  const valid = { AP_EMAIL: 'AP@x.edu', DEFAULT_APPROVER: '', ESCALATION_EMAIL: '', MAX_UPLOAD_MB: '8',
    REMINDER_DAYS: '2', ESCALATION_DAYS: '5', DUPLICATE_MODE: 'warn' };
  const validate = input => call(`validateSettings_(${JSON.stringify(input)})`);
  assert.equal(validate(valid).AP_EMAIL, 'ap@x.edu');
  assert.throws(() => validate({ ...valid, MAX_UPLOAD_MB: '50' }), /Upload limit/);
  assert.throws(() => validate({ ...valid, DUPLICATE_MODE: 'maybe' }), /Duplicate detection/);
  assert.throws(() => validate({ ...valid, REMINDER_DAYS: '-1' }), /REMINDER_DAYS/);
  assert.throws(() => validate({ ...valid, AP_EMAIL: 'nope' }), /AP email/);
});

test('active approvers are recognized whether the sheet stores booleans or text', () => {
  const active = value => call(`isActive_(${JSON.stringify(value)})`);
  assert.equal(active(true), true);
  assert.equal(active('TRUE'), true);
  assert.equal(active(false), false);
  assert.equal(active('false'), false);
  assert.equal(active(''), false);
});

test('reminderAction_ reminds on schedule and escalates once', () => {
  const day = 86400000;
  const now = Date.parse('2026-02-20T00:00:00Z');
  const settings = { REMINDER_DAYS: '2', ESCALATION_DAYS: '5', ESCALATION_EMAIL: 'boss@x.edu' };
  const action = (approval, daysWaiting, s = settings) => call(
    `reminderAction_(${JSON.stringify(approval)}, { UpdatedAt: '${new Date(now - daysWaiting * day).toISOString()}' }, ${now}, ${JSON.stringify(s)})`);
  assert.equal(action({}, 1), '');
  assert.equal(action({}, 2), 'remind');
  assert.equal(action({ RemindedAt: new Date(now - day).toISOString() }, 3), '');
  assert.equal(action({}, 6), 'escalate');
  assert.equal(action({ EscalatedAt: 'x', RemindedAt: new Date(now - 3 * day).toISOString() }, 6), 'remind');
  assert.equal(action({}, 6, { ...settings, ESCALATION_EMAIL: '' }), 'remind');
  assert.equal(action({}, 9, { ...settings, REMINDER_DAYS: '0', ESCALATION_DAYS: '0' }), '');
});

test('matchesCriteria_ filters by text, status, dates, amounts and people', () => {
  const item = { vendor: 'Acme Corp', invoiceNo: 'INV-9', po: 'PO-77', notes: '', status: 'Filed',
    invoiceDate: '2026-03-15', amount: 250, submitter: 'sam@x.edu', approver1: 'pat@x.edu', approver2: '' };
  const match = criteria => call(`matchesCriteria_(${JSON.stringify(item)}, ${JSON.stringify(criteria)})`);
  assert.equal(match({}), true);
  assert.equal(match({ text: 'acme' }), true);
  assert.equal(match({ text: 'po-77' }), true);
  assert.equal(match({ text: 'zzz' }), false);
  assert.equal(match({ status: 'Filed' }), true);
  assert.equal(match({ status: 'Needs Revision' }), false);
  assert.equal(match({ dateFrom: '2026-03-01', dateTo: '2026-03-31' }), true);
  assert.equal(match({ dateFrom: '2026-04-01' }), false);
  assert.equal(match({ minAmount: '100', maxAmount: '300' }), true);
  assert.equal(match({ minAmount: '300' }), false);
  assert.equal(match({ person: 'PAT@' }), true);
  assert.equal(match({ person: 'lee@' }), false);
});
