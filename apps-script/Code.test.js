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

test('statusGroup_ buckets statuses for filtering', () => {
  assert.equal(call("statusGroup_('Pending Approver 2')"), 'pending');
  assert.equal(call("statusGroup_('Needs Revision')"), 'revision');
  assert.equal(call("statusGroup_('Filed')"), 'filed');
  assert.equal(call("statusGroup_('Withdrawn')"), 'withdrawn');
  assert.equal(call("statusGroup_('Processing final PDF')"), 'processing');
});

test('csvCell_ quotes values and neutralizes spreadsheet formulas', () => {
  assert.equal(call('csvCell_(\'Acme, Inc\')'), '"Acme, Inc"');
  assert.equal(call('csvCell_(\'=HYPERLINK("x")\')'), '"\'=HYPERLINK(""x"")"');
  assert.equal(call('csvCell_(12.5)'), '12.5');
});

test('iso_ and toMs_ handle Date objects and strings', () => {
  assert.equal(call("iso_(new Date('2026-01-02T03:04:05Z'))"), '2026-01-02T03:04:05.000Z');
  assert.equal(call("toMs_('2026-01-02T03:04:05.000Z')"), Date.parse('2026-01-02T03:04:05.000Z'));
  assert.equal(call("toMs_('')"), 0);
});
