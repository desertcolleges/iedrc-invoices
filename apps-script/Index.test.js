const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/Index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function client() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) {
      nodes.set(selector, {
        textContent: '', innerHTML: '', disabled: false, hidden: false, dataset: {},
        addEventListener() {},
        getContext: () => ({}),
        elements: new Proxy({}, { get: (_target, name) => node(`${selector}.${name}`) }),
      });
    }
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: {
      querySelector: node, querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener() {} },
    setTimeout, clearTimeout,
  });
  context.google = { script: { run: {
    withSuccessHandler(resolve) {
      return { withFailureHandler: reject => new Proxy({}, {
        get: (_target, name) => (...args) => context.request(name, ...args).then(resolve, reject),
      }) };
    },
  } } };
  vm.runInContext(script, context);
  return { node, context, run: expression => vm.runInContext(expression, context) };
}

test('invoice rows collapse metadata and group secondary actions', () => {
  const page = client();
  page.context.invoice = {
    id: 'invoice-1', vendor: 'Acme', invoiceNo: 'INV-1', po: 'PO-1',
    status: 'Pending Approver 1', amount: 123.45, canApprove: true,
    canWithdraw: true, canDelete: true, hasPackage: true,
  };
  const card = page.run('invoiceCard(invoice)');
  assert.match(card, /<details class="invoice-expand">/);
  assert.doesNotMatch(card, /<details class="invoice-expand" open/);
  assert.match(card, /Review & approve/);
  assert.match(card, /View PDF/);
  assert.match(card, /\$123\.45/);
  assert.match(card, /<details class="more-actions">/);
  assert.match(card, /Withdraw/);
  assert.match(card, /Delete record/);
  assert.match(card, /Approve with my signature/);
  assert.match(card, /Reject/);
  assert.equal((card.match(/class="actions/g) || []).length, 1);
});

test('compact records escape user-provided metadata and preserve permission gating', () => {
  const page = client();
  page.context.invoice = {
    id: 'invoice-2', vendor: '<script>alert(1)</script>', invoiceNo: '"test"',
    po: '<b>PO</b>', notes: '<img src=x>', amount: 10, status: 'Filed',
    submitter: '<user>', invoiceDate: '2026-11-04',
  };
  const card = page.run('invoiceCard(invoice)');
  assert.doesNotMatch(card, /<script>|<img src=x>|<b>PO<\/b>/);
  assert.match(card, /&lt;script&gt;/);
  assert.match(card, /status-filed/);
  assert.doesNotMatch(card, /onclick="decide|onclick="removeInvoice|View PDF/);
  assert.match(card, /History/);
  const search = page.run('searchCard(invoice)');
  assert.match(search, /invoice-expand/);
  assert.doesNotMatch(search, /View PDF/);
});

test('tab navigation loads secondary data only on demand', () => {
  const page = client();
  page.run(`window.loads = [];
    loadAdmin = () => window.loads.push('admin');
    loadSignature = () => window.loads.push('signature');`);
  page.run("showTab('submit'); showTab('mine')");
  assert.deepEqual([...page.context.window.loads], []);
  page.run("showTab('admin'); showTab('signature')");
  assert.deepEqual([...page.context.window.loads], ['admin', 'signature']);
  page.run("adminLoaded = true; signatureLoaded = true; showTab('admin'); showTab('signature')");
  assert.equal(page.context.window.loads.length, 2);
});

test('signature lazy loading coalesces requests and permits retry after failure', async () => {
  const page = client();
  page.context.fetchSignature = () => Promise.reject(new Error('Signature unavailable'));
  page.context.request = () => page.context.fetchSignature();
  const first = page.run('loadSignature()');
  assert.equal(page.run('loadSignature()'), first);
  await first;
  assert.match(page.node('#signatureMessage').textContent, /Signature unavailable/);
  assert.equal(page.run('signatureLoaded'), false);
  assert.equal(page.node('#saveSignature').disabled, true);
  page.context.fetchSignature = () => Promise.resolve('data:image/png;base64,abc');
  await page.run('loadSignature()');
  assert.equal(page.run('signatureLoaded'), true);
  assert.equal(page.node('#saveSignature').disabled, false);
});

test('admin lazy loading blocks edits until loaded and permits retry', async () => {
  const page = client();
  page.context.fetchAdmin = () => Promise.reject(new Error('Admin unavailable'));
  page.context.request = () => page.context.fetchAdmin();
  page.run('applyAdmin = data => { window.adminData = data; }');
  const first = page.run('loadAdmin()');
  assert.equal(page.run('loadAdmin()'), first);
  assert.equal(page.node('#adminControls').disabled, true);
  await first;
  assert.match(page.node('#adminLoadMessage').textContent, /Admin unavailable/);
  assert.equal(page.run('adminLoaded'), false);
  page.context.fetchAdmin = () => Promise.resolve({ settings: {} });
  await page.run('loadAdmin()');
  assert.equal(page.run('adminLoaded'), true);
  assert.equal(page.node('#adminControls').disabled, false);
  assert.equal(page.node('#adminLoadMessage').textContent, '');
});

test('editing an approver displays the separate notification address', () => {
  const page = client();
  page.node('#approverForm').scrollIntoView = () => {};
  page.context.window.adminApprovers = [{
    name: 'Alice', email: 'alice@x.edu', notificationEmail: 'alice@example.com', title: '', active: true,
  }];
  page.run("editApprover('alice@x.edu')");
  assert.equal(page.node('#approverForm.email').value, 'alice@x.edu');
  assert.equal(page.node('#approverForm.email').readOnly, true);
  assert.equal(page.node('#approverForm.notificationEmail').value, 'alice@example.com');
});

test('brand logo is embedded locally with descriptive alternative text', () => {
  const brand = fs.readFileSync(`${__dirname}/Brand.html`, 'utf8');
  assert.match(html, /HtmlService.createHtmlOutputFromFile\('Brand'\)/);
  assert.match(brand, /alt="IEDRC/);
  const bytes = Buffer.from(brand.match(/data:image\/png;base64,([^"]+)/)[1], 'base64');
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(Math.abs(width / height - 2000 / 733) < .01);
  assert.match(html, /--navy: #1a2c57; --orange: #f06937; --light-blue: #bfd4db; --brown: #c05b28/);
});
