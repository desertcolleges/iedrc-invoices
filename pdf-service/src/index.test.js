const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { app, decodePdf } = require('./index');

let server;
let endpoint;

test.before(async () => {
  process.env.PDF_SERVICE_TOKEN = 'test-token-that-is-at-least-32-characters';
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/merge`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('decodePdf accepts PDF data', () => {
  const data = Buffer.from('%PDF-1.7').toString('base64');
  assert.equal(decodePdf(data, 'invoice').subarray(0, 5).toString(), '%PDF-');
});

test('decodePdf rejects missing or non-PDF data', () => {
  assert.throws(() => decodePdf('', 'invoice'), /Missing invoice PDF/);
  assert.throws(() => decodePdf(Buffer.from('not a PDF').toString('base64'), 'invoice'), /Invalid invoice PDF/);
});

test('merge endpoint requires its service token', async () => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
});

test('merge endpoint prepends the topsheet pages to the invoice pages', async () => {
  const documents = [];
  for (let pageCount of [1, 2]) {
    const document = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) document.addPage();
    documents.push(Buffer.from(await document.save()).toString('base64'));
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.PDF_SERVICE_TOKEN },
    body: JSON.stringify({ topsheet: documents[0], invoice: documents[1] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  const merged = await PDFDocument.load(Buffer.from(result.pdf, 'base64'));
  assert.equal(merged.getPageCount(), 3);
});

test('package endpoint builds a topsheet with a stamped signature ahead of the invoice', async () => {
  const invoice = await PDFDocument.create();
  invoice.addPage();
  invoice.addPage();
  // 1x1 transparent PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const response = await fetch(endpoint.replace('/merge', '/package'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.PDF_SERVICE_TOKEN },
    body: JSON.stringify({
      invoice: Buffer.from(await invoice.save()).toString('base64'),
      topsheet: {
        vendor: 'Acme “Ltd” \u2603', po: 'PO-1', invoiceNo: '42', invoiceDate: '2026-01-02',
        amount: '$10.00', submitter: 'a@example.edu', notes: 'line\n'.repeat(30),
        approvals: [
          { order: 1, name: 'Pat', title: 'Director', signature: png, date: '2026-01-03', note: 'ok' },
          { order: 2, name: 'Sam' },
        ],
      },
    }),
  });
  assert.equal(response.status, 200);
  const merged = await PDFDocument.load(Buffer.from((await response.json()).pdf, 'base64'));
  assert.equal(merged.getPageCount(), 3);
});

test('package endpoint requires its service token', async () => {
  const response = await fetch(endpoint.replace('/merge', '/package'), { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(response.status, 401);
});

test('topsheet renders a legacy typed signature', async () => {
  const { buildTopsheet } = require('./topsheet');
  const bytes = await buildTopsheet({
    vendor: 'Acme', po: '1', invoiceNo: '2', invoiceDate: '2026-01-01', amount: '$1.00',
    approvals: [{ order: 1, name: 'Jane Doe', signatureText: 'Jane Doe', date: 'Jan 1, 2026' }],
  });
  assert.ok(Buffer.from(bytes).subarray(0, 5).toString() === '%PDF-');
});
