const crypto = require('node:crypto');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const { buildTopsheet } = require('./topsheet');

const app = express();
const maxPdfBytes = Number(process.env.MAX_PDF_BYTES || 8_000_000);
app.use(express.json({ limit: '24mb' }));

app.get('/health', (_request, response) => response.json({ ok: true }));

function authorized(request) {
  const expected = process.env.PDF_SERVICE_TOKEN || '';
  const provided = request.get('X-Service-Token') || '';
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length >= 32 && providedBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(providedBytes, expectedBytes);
}

app.post('/package', async (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'Unauthorized' });
  try {
    const invoice = decodePdf(request.body?.invoice, 'invoice');
    if (invoice.length > maxPdfBytes) {
      return response.status(413).json({ error: 'PDF exceeds the service size limit.' });
    }
    const topsheet = await buildTopsheet(request.body?.topsheet);
    const pdf = await mergeAll([topsheet, invoice]);
    response.json({ pdf: Buffer.from(pdf).toString('base64') });
  } catch (error) {
    response.status(400).json({ error: `Unable to build package: ${error.message}` });
  }
});

app.post('/merge', async (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'Unauthorized' });
  try {
    const topsheet = decodePdf(request.body?.topsheet, 'topsheet');
    const invoice = decodePdf(request.body?.invoice, 'invoice');
    if (topsheet.length > maxPdfBytes || invoice.length > maxPdfBytes) {
      return response.status(413).json({ error: 'PDF exceeds the service size limit.' });
    }
    const pdf = await mergeAll([topsheet, invoice]);
    response.json({ pdf: Buffer.from(pdf).toString('base64') });
  } catch (error) {
    response.status(400).json({ error: `Unable to merge PDFs: ${error.message}` });
  }
});

async function mergeAll(documents) {
  const output = await PDFDocument.create();
  for (const bytes of documents) {
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach(page => output.addPage(page));
  }
  return output.save();
}

function decodePdf(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name} PDF.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 5 || bytes.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error(`Invalid ${name} PDF.`);
  }
  return bytes;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => console.log(`PDF service listening on ${port}`));
}

module.exports = { app, decodePdf };
