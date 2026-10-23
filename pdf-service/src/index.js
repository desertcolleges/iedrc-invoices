const crypto = require('node:crypto');
const express = require('express');
const { PDFDocument } = require('pdf-lib');

const app = express();
const maxPdfBytes = Number(process.env.MAX_PDF_BYTES || 8_000_000);
app.use(express.json({ limit: '24mb' }));

app.get('/health', (_request, response) => response.json({ ok: true }));

app.post('/merge', async (request, response) => {
  const expected = process.env.PDF_SERVICE_TOKEN || '';
  const provided = request.get('X-Service-Token') || '';
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length < 32 || providedBytes.length !== expectedBytes.length ||
      !crypto.timingSafeEqual(providedBytes, expectedBytes)) {
    return response.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const topsheet = decodePdf(request.body?.topsheet, 'topsheet');
    const invoice = decodePdf(request.body?.invoice, 'invoice');
    if (topsheet.length > maxPdfBytes || invoice.length > maxPdfBytes) {
      return response.status(413).json({ error: 'PDF exceeds the service size limit.' });
    }
    const skip = Number(request.body?.topsheetSkipPages ?? 0);
    if (!Number.isInteger(skip) || skip < 0 || skip > 5) throw new Error('Invalid topsheetSkipPages.');
    const output = await PDFDocument.create();
    for (const [bytes, skipPages] of [[topsheet, skip], [invoice, 0]]) {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      if (skipPages >= source.getPageCount()) throw new Error('Topsheet has no pages left after skipping.');
      const pages = await output.copyPages(source, source.getPageIndices().slice(skipPages));
      pages.forEach(page => output.addPage(page));
    }
    const pdf = await output.save();
    response.json({ pdf: Buffer.from(pdf).toString('base64') });
  } catch (error) {
    response.status(400).json({ error: `Unable to merge PDFs: ${error.message}` });
  }
});

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
