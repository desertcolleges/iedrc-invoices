const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const MAX_SIGNATURE_BYTES = 500_000;

// Standard fonts only encode WinAnsi; replace anything else so drawing never throws.
function clean(value) {
  return String(value ?? '').replace(/[\r\t]+/g, ' ').replace(/[^\n\x20-\x7e\xa0-\xff]/g, '?');
}

function wrap(text, font, size, width) {
  const lines = [];
  for (const paragraph of clean(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

async function buildTopsheet(data) {
  if (!data || typeof data !== 'object') throw new Error('Missing topsheet data.');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  const left = 54;
  const width = 504;
  let y = 740;
  const text = (value, x, size = 11, face = font, color = rgb(0.1, 0.1, 0.1)) =>
    page.drawText(clean(value), { x, y, size, font: face, color });

  text('Invoice Approval Topsheet', left, 20, bold);
  y -= 16;
  page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 1, color: rgb(0.2, 0.3, 0.4) });
  y -= 26;

  const fields = [
    ['Vendor', data.vendor], ['PO number', data.po], ['Invoice number', data.invoiceNo],
    ['Invoice date', data.invoiceDate], ['Amount', data.amount], ['Submitted by', data.submitter],
  ];
  for (const [label, value] of fields) {
    text(`${label}:`, left, 11, bold);
    text(value, left + 120, 11);
    y -= 20;
  }
  if (data.notes) {
    y -= 4;
    text('Notes:', left, 11, bold);
    y -= 16;
    for (const line of wrap(data.notes, font, 10, width).slice(0, 8)) {
      text(line, left, 10);
      y -= 13;
    }
  }

  y -= 20;
  text('Approvals', left, 14, bold);
  y -= 10;
  for (const approval of Array.isArray(data.approvals) ? data.approvals : []) {
    y -= 12;
    page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    y -= 18;
    const title = approval.title ? `, ${approval.title}` : '';
    text(`Approver ${approval.order}: ${approval.name || ''}${title}`, left, 11, bold);
    y -= 56;
    if (approval.signature) {
      const bytes = Buffer.from(approval.signature, 'base64');
      if (bytes.length > MAX_SIGNATURE_BYTES) throw new Error('Signature image is too large.');
      const image = await doc.embedPng(bytes);
      const scale = Math.min(180 / image.width, 50 / image.height, 1);
      page.drawImage(image, { x: left, y, width: image.width * scale, height: image.height * scale });
      page.drawLine({ start: { x: left, y: y - 2 }, end: { x: left + 200, y: y - 2 }, thickness: 0.5, color: rgb(0.3, 0.3, 0.3) });
      y -= 16;
      text(`Signed ${approval.date || ''}`, left, 9, font, rgb(0.3, 0.3, 0.3));
    } else {
      page.drawLine({ start: { x: left, y: y + 6 }, end: { x: left + 200, y: y + 6 }, thickness: 0.5, color: rgb(0.3, 0.3, 0.3) });
      y -= 10;
      text('Awaiting signature', left, 9, font, rgb(0.55, 0.3, 0.1));
    }
    if (approval.note) {
      y -= 14;
      for (const line of wrap(`Note: ${approval.note}`, font, 9, width).slice(0, 4)) {
        text(line, left, 9);
        y -= 12;
      }
    }
    y -= 6;
    if (y < 120) break;
  }
  return doc.save();
}

module.exports = { buildTopsheet, wrap, clean };
