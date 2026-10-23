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

test('merge endpoint drops leading topsheet pages when requested', async () => {
  const make = async count => {
    const document = await PDFDocument.create();
    for (let i = 0; i < count; i++) document.addPage();
    return Buffer.from(await document.save()).toString('base64');
  };
  const call = body => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.PDF_SERVICE_TOKEN },
    body: JSON.stringify(body),
  });
  const topsheet = await make(2);
  const invoice = await make(2);
  const ok = await call({ topsheet, invoice, topsheetSkipPages: 1 });
  const merged = await PDFDocument.load(Buffer.from((await ok.json()).pdf, 'base64'));
  assert.equal(merged.getPageCount(), 3);
  const tooMany = await call({ topsheet, invoice, topsheetSkipPages: 2 });
  assert.equal(tooMany.status, 400);
});
