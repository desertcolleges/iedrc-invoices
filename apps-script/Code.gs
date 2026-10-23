const SHEETS = {
  invoices: 'Invoices',
  approvals: 'Approvals',
  audit: 'Audit',
  approvers: 'Approvers',
  admins: 'Admins',
};

const HEADERS = {
  Invoices: [
    'ID', 'Status', 'SubmitterEmail', 'Vendor', 'PO', 'InvoiceNo',
    'InvoiceDate', 'Amount', 'Notes', 'Approver1', 'Approver2',
    'OriginalFileId', 'FinalFileId', 'Version', 'CreatedAt', 'UpdatedAt',
  ],
  Approvals: [
    'InvoiceID', 'Version', 'Order', 'ApproverEmail', 'Decision',
    'SignedAt', 'Note', 'Signature',
  ],
  Audit: ['Timestamp', 'InvoiceID', 'Actor', 'Action', 'Details'],
  Approvers: ['Name', 'Email', 'Title', 'Active'],
  Admins: ['Email'],
};

function doGet() {
  const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw new Error('Set GOOGLE_CLIENT_ID in Script Properties first.');
  const template = HtmlService.createTemplateFromFile('Index');
  template.clientId = clientId;
  return template.evaluate()
    .setTitle('IEDRC Invoice Approval');
}

function initializeSheets(idToken) {
  const user = requireUser_(idToken);
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Set SPREADSHEET_ID in Script Properties first.');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const configuredAdmins = (props.getProperty('ADMIN_EMAILS') || '')
    .split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!configuredAdmins.includes(user.email) && !isAdmin_(spreadsheet, user.email)) {
    throw new Error('Only a configured administrator can initialize the app.');
  }
  Object.keys(HEADERS).forEach(name => {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
      sheet.setFrozenRows(1);
    }
  });
  const adminSheet = spreadsheet.getSheetByName(SHEETS.admins);
  if (adminSheet.getLastRow() < 2) {
    configuredAdmins.forEach(email => adminSheet.appendRow([email]));
  }
  return 'Sheets initialized.';
}

function getDashboard(idToken) {
  const user = requireUser_(idToken);
  const db = getDb_();
  const admin = isAdmin_(db, user.email);
  const approvals = getApprovals_(db);
  const assigned = new Set(approvals.filter(row =>
    row.ApproverEmail === user.email && row.Decision === 'Pending'
  ).map(row => row.InvoiceID));
  return getInvoices_(db)
    .filter(row => admin || row.SubmitterEmail === user.email || assigned.has(row.ID))
    .map(row => {
      const approval = approvals.find(item =>
        item.InvoiceID === row.ID && item.Decision === 'Pending' &&
        item.ApproverEmail === user.email
      );
      return {
        id: row.ID,
        status: row.Status,
        vendor: row.Vendor,
        invoiceNo: row.InvoiceNo,
        invoiceDate: row.InvoiceDate,
        amount: Number(row.Amount),
        submitter: row.SubmitterEmail,
        createdAt: row.CreatedAt,
        canApprove: Boolean(approval),
        canRevise: row.Status === 'Needs Revision' && row.SubmitterEmail === user.email,
        canRetry: row.Status === 'Finalization failed' && admin,
        po: row.PO,
        notes: row.Notes,
        approver1: row.Approver1,
        approver2: row.Approver2,
      };
    });
}

function getSetupInfo(idToken) {
  const user = requireUser_(idToken);
  const db = getDb_();
  const approvers = getRows_(db, SHEETS.approvers)
    .filter(row => String(row.Active).toLowerCase() === 'true')
    .map(row => ({ name: row.Name, email: String(row.Email).toLowerCase(), title: row.Title }));
  return {
    user: user.email,
    admin: isAdmin_(db, user.email) ||
      (PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '')
        .split(',').map(email => email.trim().toLowerCase()).includes(user.email),
    approvers,
    defaultApprover: PropertiesService.getScriptProperties().getProperty('DEFAULT_APPROVER') || '',
    initialized: Object.values(SHEETS).every(name => db.getSheetByName(name)),
  };
}

function submitInvoice(input, idToken) {
  const user = requireUser_(idToken);
  validateSubmission_(input);
  const config = getConfig_();
  const db = getDb_();
  const approvers = getRows_(db, SHEETS.approvers)
    .filter(row => String(row.Active).toLowerCase() === 'true')
    .map(row => String(row.Email).trim().toLowerCase());
  const approver1 = String(input.approver1 || config.defaultApprover).trim().toLowerCase();
  const approver2 = String(input.approver2 || '').trim().toLowerCase();
  if (!approvers.includes(approver1) || (approver2 && !approvers.includes(approver2))) {
    throw new Error('Select active approvers from the list.');
  }
  if (approver1 === approver2 || approver1 === user.email || approver2 === user.email) {
    throw new Error('You cannot approve your own invoice or select the same approver twice.');
  }

  const bytes = Utilities.base64Decode(input.file.data);
  if (bytes.length > config.maxUploadBytes) throw new Error('The PDF exceeds the configured upload limit.');
  const blob = Utilities.newBlob(bytes, 'application/pdf', safeName_(input.file.name));
  const id = Utilities.getUuid();
  const now = new Date().toISOString();
  const invoiceFolder = DriveApp.getFolderById(config.workingFolderId).createFolder(id);
  const original = invoiceFolder.createFile(blob);
  const invoice = {
    ID: id, Status: 'Pending Approver 1', SubmitterEmail: user.email,
    Vendor: String(input.vendor).trim(), PO: String(input.po).trim(), InvoiceNo: String(input.invoiceNo).trim(),
    InvoiceDate: String(input.invoiceDate), Amount: Number(input.amount), Notes: String(input.notes || '').trim(),
    Approver1: approver1, Approver2: approver2, OriginalFileId: original.getId(),
    FinalFileId: '', Version: 1, CreatedAt: now, UpdatedAt: now,
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    appendObject_(db.getSheetByName(SHEETS.invoices), invoice);
    appendObject_(db.getSheetByName(SHEETS.approvals), {
      InvoiceID: id, Version: 1, Order: 1, ApproverEmail: approver1,
      Decision: 'Pending', SignedAt: '', Note: '', Signature: '',
    });
    if (approver2) {
      appendObject_(db.getSheetByName(SHEETS.approvals), {
        InvoiceID: id, Version: 1, Order: 2, ApproverEmail: approver2,
        Decision: 'Queued', SignedAt: '', Note: '', Signature: '',
      });
    }
    audit_(db, id, user.email, 'Submitted', { vendor: invoice.Vendor });
  } finally {
    lock.releaseLock();
  }
  sendNotice_(approver1, 'Invoice approval requested', `Invoice ${invoice.InvoiceNo} from ${invoice.Vendor} is ready for your review.`);
  return { id, status: invoice.Status };
}

function resubmitInvoice(input, idToken) {
  const user = requireUser_(idToken);
  validateSubmission_(input);
  const config = getConfig_();
  const db = getDb_();
  const approvers = getRows_(db, SHEETS.approvers)
    .filter(row => String(row.Active).toLowerCase() === 'true')
    .map(row => String(row.Email).trim().toLowerCase());
  const approver1 = String(input.approver1 || config.defaultApprover).trim().toLowerCase();
  const approver2 = String(input.approver2 || '').trim().toLowerCase();
  if (!approvers.includes(approver1) || (approver2 && !approvers.includes(approver2))) {
    throw new Error('Select active approvers from the list.');
  }
  if (approver1 === approver2 || approver1 === user.email || approver2 === user.email) {
    throw new Error('You cannot approve your own invoice or select the same approver twice.');
  }
  const dbLock = LockService.getScriptLock();
  dbLock.waitLock(30000);
  try {
    const invoice = getInvoices_(db).find(row => row.ID === input.invoiceId);
    if (!invoice || invoice.SubmitterEmail !== user.email || invoice.Status !== 'Needs Revision') {
      throw new Error('This invoice is not available for revision.');
    }
    const nextVersion = Number(invoice.Version) + 1;
    const bytes = Utilities.base64Decode(input.file.data);
    const folder = DriveApp.getFolderById(config.workingFolderId).getFoldersByName(invoice.ID);
    if (!folder.hasNext()) throw new Error('The invoice working folder is missing.');
    const replacement = folder.next().createFile(
      Utilities.newBlob(bytes, 'application/pdf', `invoice-v${nextVersion}.pdf`)
    );
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, {
      Status: 'Pending Approver 1',
      Vendor: String(input.vendor).trim(),
      PO: String(input.po).trim(),
      InvoiceNo: String(input.invoiceNo).trim(),
      InvoiceDate: String(input.invoiceDate),
      Amount: Number(input.amount),
      Notes: String(input.notes || '').trim(),
      Approver1: approver1,
      Approver2: approver2,
      OriginalFileId: replacement.getId(),
      FinalFileId: '',
      Version: nextVersion,
    });
    appendObject_(db.getSheetByName(SHEETS.approvals), {
      InvoiceID: invoice.ID, Version: nextVersion, Order: 1, ApproverEmail: approver1,
      Decision: 'Pending', SignedAt: '', Note: '', Signature: '',
    });
    if (approver2) {
      appendObject_(db.getSheetByName(SHEETS.approvals), {
        InvoiceID: invoice.ID, Version: nextVersion, Order: 2, ApproverEmail: approver2,
        Decision: 'Queued', SignedAt: '', Note: '', Signature: '',
      });
    }
    audit_(db, invoice.ID, user.email, 'Resubmitted', { version: nextVersion, priorFileId: invoice.OriginalFileId });
    sendNotice_(approver1, 'Invoice approval requested', `Revised invoice ${input.invoiceNo} from ${input.vendor} is ready for your review.`);
    return { id: invoice.ID, status: 'Pending Approver 1' };
  } finally {
    dbLock.releaseLock();
  }
}

function decideInvoice(input, idToken) {
  const user = requireUser_(idToken);
  if (!input || !input.id || !['approve', 'reject'].includes(input.action)) {
    throw new Error('Invalid approval action.');
  }
  const note = String(input.note || '').trim();
  if (input.action === 'reject' && !note) throw new Error('A reason is required to reject an invoice.');
  if (note.length > 500) throw new Error('Notes must be 500 characters or fewer.');
  const signature = String(input.signature || '').trim();
  if (input.action === 'approve' && (!signature || signature.length > 120)) {
    throw new Error('Enter your name as your electronic signature.');
  }

  const db = getDb_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let nextApprover = '';
  let completedInvoice = null;
  try {
    const invoice = getInvoices_(db).find(row => row.ID === input.id);
    if (!invoice) throw new Error('Invoice not found.');
    const approvalSheet = db.getSheetByName(SHEETS.approvals);
    const approvals = getApprovals_(db).filter(row => row.InvoiceID === input.id &&
      Number(row.Version) === Number(invoice.Version));
    const pending = approvals.find(row => row.Decision === 'Pending');
    if (!pending || pending.ApproverEmail !== user.email) throw new Error('This invoice is not awaiting your approval.');
    const rowNumber = pending._row;
    const headers = HEADERS.Approvals;
    const values = headers.map(key => ({
      ...pending,
      Decision: input.action === 'approve' ? 'Signed' : 'Rejected',
      SignedAt: new Date().toISOString(),
      Note: note,
      Signature: input.action === 'approve' ? signature : '',
    })[key]);
    approvalSheet.getRange(rowNumber, 1, 1, headers.length).setValues([values]);

    const invoiceSheet = db.getSheetByName(SHEETS.invoices);
    if (input.action === 'reject') {
      updateInvoice_(invoiceSheet, invoice, { Status: 'Needs Revision' });
      audit_(db, invoice.ID, user.email, 'Rejected', { reason: note });
      sendNotice_(invoice.SubmitterEmail, 'Invoice needs revision', `Invoice ${invoice.InvoiceNo} was returned: ${note}`);
    } else {
      nextApprover = approvals.find(row => row.Decision === 'Queued')?.ApproverEmail || '';
      if (nextApprover) {
        const queued = approvals.find(row => row.Decision === 'Queued');
        const queuedValues = headers.map(key => ({
          ...queued,
          Decision: 'Pending',
        })[key]);
        approvalSheet.getRange(queued._row, 1, 1, headers.length).setValues([queuedValues]);
        updateInvoice_(invoiceSheet, invoice, { Status: 'Pending Approver 2' });
        audit_(db, invoice.ID, user.email, 'Approved', { nextApprover });
      } else {
        updateInvoice_(invoiceSheet, invoice, { Status: 'Processing final PDF' });
        audit_(db, invoice.ID, user.email, 'Approved', {});
        completedInvoice = { ...invoice, Version: Number(invoice.Version) };
      }
    }
  } finally {
    lock.releaseLock();
  }
  if (nextApprover) {
    sendNotice_(nextApprover, 'Invoice approval requested', `Invoice ${input.id} is ready for your review.`);
  }
  if (completedInvoice) finalizeInvoice_(completedInvoice, user.email);
  return { ok: true };
}

function retryFinalization(id, idToken) {
  const user = requireUser_(idToken);
  const db = getDb_();
  if (!isAdmin_(db, user.email)) throw new Error('Only an admin can retry finalization.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let invoice;
  try {
    invoice = getInvoices_(db).find(row => row.ID === id);
    if (!invoice || invoice.Status !== 'Finalization failed') {
      throw new Error('This invoice is not awaiting finalization retry.');
    }
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, { Status: 'Processing final PDF' });
    audit_(db, invoice.ID, user.email, 'Retried finalization', {});
  } finally {
    lock.releaseLock();
  }
  finalizeInvoice_(invoice, user.email);
  return { ok: true };
}

function finalizeInvoice_(invoice, actor) {
  const config = getConfig_();
  const db = getDb_();
  try {
    const approvalRows = getApprovals_(db).filter(row =>
      row.InvoiceID === invoice.ID && Number(row.Version) === Number(invoice.Version) &&
      row.Decision === 'Signed'
    );
    const template = DriveApp.getFileById(config.templateDocId);
    const docCopy = template.makeCopy(`Topsheet ${invoice.ID}`, DriveApp.getFolderById(config.workingFolderId));
    const doc = DocumentApp.openById(docCopy.getId());
    const body = doc.getBody();
    const replacements = {
      VENDOR: invoice.Vendor, PO: invoice.PO, INVOICE_NO: invoice.InvoiceNo,
      INVOICE_DATE: invoice.InvoiceDate, AMOUNT: formatAmount_(invoice.Amount),
      NOTES: invoice.Notes, APPROVER1_NAME: '', APPROVER1_SIG: '',
      APPROVER1_DATE: '', APPROVER1_NOTES: '', APPROVER2_NAME: '',
      APPROVER2_SIG: '', APPROVER2_DATE: '', APPROVER2_NOTES: '',
    };
    approvalRows.forEach(row => {
      const order = Number(row.Order);
      replacements[`APPROVER${order}_NAME`] = getApproverName_(db, row.ApproverEmail);
      replacements[`APPROVER${order}_SIG`] = row.Signature;
      replacements[`APPROVER${order}_DATE`] = row.SignedAt;
      replacements[`APPROVER${order}_NOTES`] = row.Note;
    });
    Object.keys(replacements).forEach(key =>
      body.replaceText(`\\{\\{${key}\\}\\}`, String(replacements[key] || ''))
    );
    doc.saveAndClose();
    const topsheet = DriveApp.getFileById(docCopy.getId()).getAs(MimeType.PDF);
    const original = DriveApp.getFileById(invoice.OriginalFileId).getBlob();
    const merged = mergePdfs_(topsheet, original);
    const vendorFolder = getOrCreateFolder_(DriveApp.getFolderById(config.archiveFolderId), safeName_(invoice.Vendor));
    const filename = [
      safeName_(invoice.Vendor), safeName_(invoice.InvoiceNo),
      formatAmount_(invoice.Amount), safeName_(invoice.PO),
      Utilities.formatDate(new Date(`${invoice.InvoiceDate}T00:00:00`), Session.getScriptTimeZone(), 'MM-dd-yy'),
    ].join(', ') + '.pdf';
    const finalFile = vendorFolder.createFile(merged.setName(filename));
    if (config.apEmail) {
      MailApp.sendEmail({
        to: config.apEmail,
        subject: `Approved invoice: ${invoice.Vendor} - ${invoice.InvoiceNo}`,
        body: `Approved invoice attached. Submitted by ${invoice.SubmitterEmail}.`,
        attachments: [finalFile.getBlob()],
      });
    }
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, {
      Status: 'Filed', FinalFileId: finalFile.getId(),
    });
    audit_(db, invoice.ID, actor, 'Filed and sent to AP', { finalFileId: finalFile.getId() });
    sendNotice_(invoice.SubmitterEmail, 'Invoice approved and filed', `Invoice ${invoice.InvoiceNo} has been approved and filed.`);
  } catch (error) {
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, { Status: 'Finalization failed' });
    audit_(db, invoice.ID, actor, 'Finalization failed', { message: String(error.message || error) });
    throw error;
  }
}

function mergePdfs_(topsheet, original) {
  const config = getConfig_();
  const response = UrlFetchApp.fetch(config.pdfServiceUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      'X-Service-Token': config.pdfServiceToken,
    },
    payload: JSON.stringify({
      topsheet: Utilities.base64Encode(topsheet.getBytes()),
      invoice: Utilities.base64Encode(original.getBytes()),
    }),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error(`PDF merge service failed (${response.getResponseCode()}).`);
  }
  const result = JSON.parse(response.getContentText());
  if (!result.pdf) throw new Error('PDF merge service returned no PDF.');
  return Utilities.newBlob(Utilities.base64Decode(result.pdf), MimeType.PDF, 'invoice.pdf');
}

function validateSubmission_(input) {
  if (!input || !input.file || typeof input.file.data !== 'string' ||
      typeof input.file.name !== 'string' || !input.file.data || !input.file.name) {
    throw new Error('Attach an invoice PDF.');
  }
  if (!/\.pdf$/i.test(input.file.name) || input.file.data.length > 14000000) {
    throw new Error('Upload a PDF within the supported size limit.');
  }
  const bytes = Utilities.base64Decode(input.file.data);
  const maxUploadBytes = Number(PropertiesService.getScriptProperties().getProperty('MAX_UPLOAD_BYTES') || 8000000);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0 ||
      bytes.length > maxUploadBytes || Utilities.newBlob(bytes).getDataAsString().slice(0, 5) !== '%PDF-') {
    throw new Error('Upload a valid PDF within the configured size limit.');
  }
  const required = ['vendor', 'po', 'invoiceNo', 'invoiceDate', 'amount'];
  required.forEach(key => {
    if (input[key] === undefined || String(input[key]).trim() === '') throw new Error(`Enter ${key}.`);
  });
  const parsedDate = new Date(`${input.invoiceDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== input.invoiceDate) throw new Error('Enter a valid invoice date.');
  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) < 0) throw new Error('Enter a valid amount.');
  ['vendor', 'po', 'invoiceNo', 'notes'].forEach(key => {
    if (String(input[key] || '').length > 500) throw new Error(`${key} is too long.`);
  });
}

function requireUser_(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 5000) {
    throw new Error('Sign in with your organization Google account.');
  }
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('GOOGLE_CLIENT_ID');
  const domain = String(props.getProperty('ALLOWED_DOMAIN') || '').toLowerCase();
  if (!clientId || !domain) throw new Error('Configure GOOGLE_CLIENT_ID and ALLOWED_DOMAIN.');
  const response = UrlFetchApp.fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) throw new Error('Your Google sign-in has expired. Sign in again.');
  const claims = JSON.parse(response.getContentText());
  const email = String(claims.email || '').trim().toLowerCase();
  const expiresAt = Number(claims.exp || 0);
  if (claims.aud !== clientId || ![true, 'true'].includes(claims.email_verified) ||
      claims.hd !== domain || email.split('@')[1] !== domain ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) {
    throw new Error('Your Google account is not authorized for this application.');
  }
  return { email };
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    spreadsheetId: props.getProperty('SPREADSHEET_ID'),
    workingFolderId: props.getProperty('WORKING_FOLDER_ID'),
    archiveFolderId: props.getProperty('ARCHIVE_FOLDER_ID'),
    templateDocId: props.getProperty('TEMPLATE_DOC_ID'),
    pdfServiceUrl: props.getProperty('PDF_SERVICE_URL'),
    pdfServiceToken: props.getProperty('PDF_SERVICE_TOKEN'),
    defaultApprover: props.getProperty('DEFAULT_APPROVER') || '',
    apEmail: props.getProperty('AP_EMAIL') || '',
    maxUploadBytes: Number(props.getProperty('MAX_UPLOAD_BYTES') || 8000000),
  };
  const required = ['spreadsheetId', 'workingFolderId', 'archiveFolderId', 'templateDocId', 'pdfServiceUrl', 'pdfServiceToken', 'apEmail'];
  const missing = required.filter(key => !config[key]);
  if (missing.length) throw new Error(`Configure required Script Properties: ${missing.join(', ')}.`);
  return config;
}

function getDb_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Set SPREADSHEET_ID in Script Properties.');
  return SpreadsheetApp.openById(id);
}

function getRows_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  return values.slice(1).map((row, index) => {
    const object = {};
    values[0].forEach((key, col) => object[key] = row[col]);
    object._row = index + 2;
    return object;
  });
}

function getInvoices_(db) { return getRows_(db, SHEETS.invoices); }
function getApprovals_(db) { return getRows_(db, SHEETS.approvals); }
function isAdmin_(db, email) {
  return getRows_(db, SHEETS.admins).some(row => String(row.Email).trim().toLowerCase() === email);
}

function getApproverName_(db, email) {
  const approver = getRows_(db, SHEETS.approvers).find(row =>
    String(row.Email).trim().toLowerCase() === String(email).toLowerCase()
  );
  return approver ? approver.Name : email;
}

function appendObject_(sheet, object) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(headers.map(key => object[key] === undefined ? '' : object[key]));
}

function updateInvoice_(sheet, invoice, changes) {
  const updated = { ...invoice, ...changes, UpdatedAt: new Date().toISOString() };
  const headers = HEADERS.Invoices;
  sheet.getRange(invoice._row, 1, 1, headers.length)
    .setValues([headers.map(key => updated[key] === undefined ? '' : updated[key])]);
}

function audit_(db, id, actor, action, details) {
  appendObject_(db.getSheetByName(SHEETS.audit), {
    Timestamp: new Date().toISOString(), InvoiceID: id, Actor: actor,
    Action: action, Details: JSON.stringify(details || {}),
  });
}

function sendNotice_(email, subject, body) {
  if (email) {
    const appUrl = ScriptApp.getService().getUrl();
    const message = appUrl ? `${body}\n\nOpen the invoice approval app: ${appUrl}` : body;
    MailApp.sendEmail(email, subject, message);
  }
}

function getOrCreateFolder_(parent, name) {
  const matches = parent.getFoldersByName(name);
  return matches.hasNext() ? matches.next() : parent.createFolder(name);
}

function safeName_(value) {
  return String(value).trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 120);
}

function formatAmount_(value) {
  return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
