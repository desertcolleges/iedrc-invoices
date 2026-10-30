const SHEETS = {
  invoices: 'Invoices',
  approvals: 'Approvals',
  audit: 'Audit',
  approvers: 'Approvers',
  admins: 'Admins',
  settings: 'Settings',
  routing: 'Routing',
};

// New columns are only ever appended so existing sheets can be upgraded in place.
const HEADERS = {
  Invoices: [
    'ID', 'Status', 'SubmitterEmail', 'Vendor', 'PO', 'InvoiceNo',
    'InvoiceDate', 'Amount', 'Notes', 'Approver1', 'Approver2',
    'OriginalFileId', 'FinalFileId', 'Version', 'CreatedAt', 'UpdatedAt',
    'PackageFileId', 'PackageStatus',
  ],
  Approvals: [
    'InvoiceID', 'Version', 'Order', 'ApproverEmail', 'Decision',
    'SignedAt', 'Note', 'Signature', 'RemindedAt', 'EscalatedAt',
  ],
  Audit: ['Timestamp', 'InvoiceID', 'Actor', 'Action', 'Details'],
  Approvers: ['Name', 'Email', 'Title', 'Active', 'SignatureFileId'],
  Admins: ['Email'],
  Settings: ['Key', 'Value'],
  Routing: ['MinAmount', 'Approver1', 'Approver2', 'Active'],
};

const SETTING_DEFAULTS = {
  AP_EMAIL: '',
  DEFAULT_APPROVER: '',
  ESCALATION_EMAIL: '',
  MAX_UPLOAD_MB: '8',
  REMINDER_DAYS: '2',
  ESCALATION_DAYS: '5',
  DUPLICATE_MODE: 'warn',
};

const MAX_SIGNATURE_BYTES = 500000;

// Sheet reads are memoized per execution and cleared by every write helper.
const memo_ = {};
function clearMemo_() {
  Object.keys(memo_).forEach(key => delete memo_[key]);
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('IEDRC Invoice Approval');
}

function configuredAdmins_() {
  return (PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '')
    .split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
}

function ensureHeaders_(sheet, headers) {
  const lastColumn = sheet.getLastColumn();
  const existing = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
  if (!existing.every((name, index) => name === headers[index])) {
    throw new Error(`The ${sheet.getName()} sheet has unexpected headers. Fix row 1 before upgrading.`);
  }
  if (existing.length < headers.length) {
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    sheet.getRange(1, existing.length + 1, 1, headers.length - existing.length)
      .setValues([headers.slice(existing.length)]);
  }
  sheet.setFrozenRows(1);
}

function initializeSheets() {
  const user = requireUser_();
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Set SPREADSHEET_ID in Script Properties first.');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const admins = configuredAdmins_();
  if (!admins.includes(user.email) && !isAdmin_(spreadsheet, user.email)) {
    throw new Error('Only a configured administrator can initialize the app.');
  }
  Object.keys(HEADERS).forEach(name => {
    const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
    ensureHeaders_(sheet, HEADERS[name]);
  });
  const adminSheet = spreadsheet.getSheetByName(SHEETS.admins);
  if (adminSheet.getLastRow() < 2) {
    admins.forEach(email => adminSheet.appendRow([email]));
  }
  clearMemo_();
  return 'Sheets initialized.';
}

function schemaStatus_(db) {
  const initialized = Object.values(SHEETS).every(name => db.getSheetByName(name));
  if (!initialized) return { initialized: false, upgradeNeeded: true };
  const upgradeNeeded = Object.keys(HEADERS).some(name => {
    const width = HEADERS[name].length;
    const sheet = db.getSheetByName(name);
    if (sheet.getLastColumn() < width) return true;
    return sheet.getRange(1, 1, 1, width).getValues()[0].some((value, index) => value !== HEADERS[name][index]);
  });
  return { initialized: true, upgradeNeeded };
}

function getSettings_(db) {
  if (memo_.settings) return memo_.settings;
  const props = PropertiesService.getScriptProperties();
  const settings = { ...SETTING_DEFAULTS };
  settings.AP_EMAIL = props.getProperty('AP_EMAIL') || '';
  settings.DEFAULT_APPROVER = props.getProperty('DEFAULT_APPROVER') || '';
  const legacyBytes = Number(props.getProperty('MAX_UPLOAD_BYTES'));
  if (legacyBytes > 0) settings.MAX_UPLOAD_MB = String(legacyBytes / 1000000);
  getRows_(db, SHEETS.settings).forEach(row => {
    if (Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, row.Key) && String(row.Value).trim() !== '') {
      settings[row.Key] = String(row.Value).trim();
    }
  });
  memo_.settings = settings;
  return settings;
}

function isValidEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));
}

function isActive_(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function validateSettings_(input) {
  const result = {};
  const errors = [];
  Object.keys(SETTING_DEFAULTS).forEach(key => {
    const value = String(input && input[key] !== undefined ? input[key] : '').trim();
    switch (key) {
      case 'AP_EMAIL':
        if (!isValidEmail_(value)) errors.push('Enter a valid AP email address.');
        break;
      case 'DEFAULT_APPROVER':
      case 'ESCALATION_EMAIL':
        if (value && !isValidEmail_(value)) errors.push(`Enter a valid email for ${key}.`);
        break;
      case 'MAX_UPLOAD_MB':
        if (!(Number(value) >= 1 && Number(value) <= 10)) errors.push('Upload limit must be between 1 and 10 MB.');
        break;
      case 'REMINDER_DAYS':
      case 'ESCALATION_DAYS':
        if (!/^\d+$/.test(value) || Number(value) > 60) errors.push(`${key} must be a whole number from 0 to 60 (0 disables).`);
        break;
      case 'DUPLICATE_MODE':
        if (!['off', 'warn', 'block'].includes(value)) errors.push('Duplicate detection must be off, warn, or block.');
        break;
    }
    result[key] = isValidEmail_(value) ? value.toLowerCase() : value;
  });
  if (errors.length) throw new Error(errors.join('\n'));
  return result;
}

function suggestRoute_(rules, amount) {
  const matches = (rules || []).filter(rule =>
    String(rule.Active).toLowerCase() === 'true' && Number(rule.MinAmount) <= Number(amount));
  if (!matches.length) return null;
  const best = matches.reduce((a, b) => Number(b.MinAmount) > Number(a.MinAmount) ? b : a);
  return { approver1: String(best.Approver1 || '').toLowerCase(), approver2: String(best.Approver2 || '').toLowerCase() };
}

function findDuplicate_(invoices, input, excludeId) {
  const vendor = String(input.vendor).trim().toLowerCase();
  const number = String(input.invoiceNo).trim().toLowerCase();
  return invoices.find(row => row.ID !== excludeId &&
    String(row.Vendor).trim().toLowerCase() === vendor &&
    String(row.InvoiceNo).trim().toLowerCase() === number) || null;
}

function checkDuplicates_(db, input, excludeId, settings) {
  const mode = settings.DUPLICATE_MODE;
  if (mode === 'off') return;
  const duplicate = findDuplicate_(getInvoices_(db), input, excludeId);
  if (!duplicate) return;
  const message = `An invoice from ${duplicate.Vendor} with invoice number ${duplicate.InvoiceNo} already exists (${duplicate.Status}).`;
  if (mode === 'block') throw new Error(message);
  if (!input.confirmDuplicate) throw new Error(`DUPLICATE: ${message}`);
}

// Returns the next reminder/escalation action for a pending approval, or ''.
function reminderAction_(approval, invoice, nowMs, settings) {
  const reminderDays = Number(settings.REMINDER_DAYS);
  const escalationDays = Number(settings.ESCALATION_DAYS);
  const waitedDays = (nowMs - new Date(invoice.UpdatedAt).getTime()) / 86400000;
  if (!(waitedDays >= 0)) return '';
  if (escalationDays > 0 && settings.ESCALATION_EMAIL && !approval.EscalatedAt && waitedDays >= escalationDays) {
    return 'escalate';
  }
  if (reminderDays > 0 && waitedDays >= reminderDays) {
    const last = approval.RemindedAt ? new Date(approval.RemindedAt).getTime() : 0;
    if (!last || (nowMs - last) / 86400000 >= reminderDays) return 'remind';
  }
  return '';
}

function getSetupInfo() {
  const user = requireUser_();
  const db = getDb_();
  const schema = schemaStatus_(db);
  const admin = isAdmin_(db, user.email);
  if (!schema.initialized || schema.upgradeNeeded) {
    return { user: user.email, admin, approvers: [], defaultApprover: '', routing: [], ...schema };
  }
  const settings = getSettings_(db);
  const allApprovers = getRows_(db, SHEETS.approvers);
  const approvers = allApprovers
    .filter(row => isActive_(row.Active))
    .map(row => ({ name: row.Name, email: String(row.Email).toLowerCase(), title: row.Title }));
  const me = allApprovers.find(row => String(row.Email).trim().toLowerCase() === user.email);
  return {
    user: user.email,
    admin,
    approvers,
    defaultApprover: settings.DEFAULT_APPROVER,
    routing: getRows_(db, SHEETS.routing)
      .filter(row => String(row.Active).toLowerCase() === 'true')
      .map(row => ({ min: Number(row.MinAmount), approver1: String(row.Approver1).toLowerCase(), approver2: String(row.Approver2).toLowerCase() })),
    isApprover: Boolean(me),
    hasSignature: Boolean(me && me.SignatureFileId),
    maxUploadMb: Number(settings.MAX_UPLOAD_MB),
    ...schema,
  };
}

function invoiceView_(row, user, admin, pendingByInvoice) {
  const ready = row.PackageStatus === 'Ready';
  const pendingStatus = String(row.Status).startsWith('Pending');
  return {
    id: row.ID,
    status: row.Status,
    vendor: row.Vendor,
    invoiceNo: row.InvoiceNo,
    invoiceDate: row.InvoiceDate instanceof Date ? row.InvoiceDate.toISOString().slice(0, 10) : String(row.InvoiceDate),
    amount: Number(row.Amount),
    submitter: row.SubmitterEmail,
    createdAt: row.CreatedAt,
    canApprove: pendingByInvoice.has(row.ID) && ready,
    awaitingPackage: pendingByInvoice.has(row.ID) && !ready,
    canRebuild: pendingStatus && !ready && (admin || row.SubmitterEmail === user.email),
    canRevise: row.Status === 'Needs Revision' && row.SubmitterEmail === user.email,
    canRetry: row.Status === 'Finalization failed' && admin,
    hasPackage: Boolean(row.PackageFileId || row.FinalFileId),
    po: row.PO,
    notes: row.Notes,
    approver1: row.Approver1,
    approver2: row.Approver2,
  };
}

function accessibleInvoices_(db, user) {
  const admin = isAdmin_(db, user.email);
  const pendingByInvoice = new Set();
  const involved = new Set();
  getApprovals_(db).forEach(row => {
    if (row.ApproverEmail !== user.email) return;
    involved.add(row.InvoiceID);
    if (row.Decision === 'Pending') pendingByInvoice.add(row.InvoiceID);
  });
  return getInvoices_(db)
    .filter(row => admin || row.SubmitterEmail === user.email || involved.has(row.ID))
    .map(row => invoiceView_(row, user, admin, pendingByInvoice))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Active work only: invoices still moving through the workflow or needing action.
function getDashboard() {
  const user = requireUser_();
  const db = getDb_();
  return accessibleInvoices_(db, user).filter(item => item.status !== 'Filed');
}

function matchesCriteria_(item, criteria) {
  const c = criteria || {};
  const text = String(c.text || '').trim().toLowerCase();
  if (text && ![item.vendor, item.invoiceNo, item.po, item.notes]
    .some(value => String(value || '').toLowerCase().includes(text))) return false;
  if (c.status && item.status !== c.status) return false;
  const person = String(c.person || '').trim().toLowerCase();
  if (person && ![item.submitter, item.approver1, item.approver2]
    .some(value => String(value || '').toLowerCase().includes(person))) return false;
  if (c.dateFrom && item.invoiceDate < c.dateFrom) return false;
  if (c.dateTo && item.invoiceDate > c.dateTo) return false;
  if (c.minAmount !== undefined && c.minAmount !== '' && item.amount < Number(c.minAmount)) return false;
  if (c.maxAmount !== undefined && c.maxAmount !== '' && item.amount > Number(c.maxAmount)) return false;
  return true;
}

const SEARCH_LIMIT = 200;

function searchInvoices(criteria) {
  const user = requireUser_();
  const db = getDb_();
  const matches = accessibleInvoices_(db, user).filter(item => matchesCriteria_(item, criteria));
  return { total: matches.length, results: matches.slice(0, SEARCH_LIMIT), limit: SEARCH_LIMIT };
}

function resolveApprovers_(db, user, input, settings) {
  const approvers = getRows_(db, SHEETS.approvers)
    .filter(row => isActive_(row.Active))
    .map(row => String(row.Email).trim().toLowerCase());
  const approver1 = String(input.approver1 || settings.DEFAULT_APPROVER).trim().toLowerCase();
  const approver2 = String(input.approver2 || '').trim().toLowerCase();
  if (!approvers.includes(approver1) || (approver2 && !approvers.includes(approver2))) {
    throw new Error('Select active approvers from the list.');
  }
  if (approver1 === approver2 || approver1 === user.email || approver2 === user.email) {
    throw new Error('You cannot approve your own invoice or select the same approver twice.');
  }
  return { approver1, approver2 };
}

function approvalRows_(invoiceId, version, approver1, approver2) {
  const rows = [{
    InvoiceID: invoiceId, Version: version, Order: 1, ApproverEmail: approver1,
    Decision: 'Pending', SignedAt: '', Note: '', Signature: '',
  }];
  if (approver2) {
    rows.push({
      InvoiceID: invoiceId, Version: version, Order: 2, ApproverEmail: approver2,
      Decision: 'Queued', SignedAt: '', Note: '', Signature: '',
    });
  }
  return rows;
}

function submitInvoice(input) {
  const user = requireUser_();
  const db = getDb_();
  const settings = getSettings_(db);
  validateSubmission_(input, settings, true);
  const config = getConfig_();
  const { approver1, approver2 } = resolveApprovers_(db, user, input, settings);
  checkDuplicates_(db, input, '', settings);

  const blob = Utilities.newBlob(Utilities.base64Decode(input.file.data), 'application/pdf', safeName_(input.file.name));
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
    PackageFileId: '', PackageStatus: 'Building',
  };

  withLock_(() => {
    invoice._row = appendObject_(db.getSheetByName(SHEETS.invoices), invoice);
    approvalRows_(id, 1, approver1, approver2).forEach(row => appendObject_(db.getSheetByName(SHEETS.approvals), row));
    audit_(db, id, user.email, 'Submitted', { vendor: invoice.Vendor });
  });
  const ready = preparePackage_(db, invoice, user.email, approver1,
    `Invoice ${invoice.InvoiceNo} from ${invoice.Vendor} (${formatAmount_(invoice.Amount)}) is ready for your review.`);
  return { id, status: invoice.Status, packageReady: ready };
}

function resubmitInvoice(input) {
  const user = requireUser_();
  const db = getDb_();
  const settings = getSettings_(db);
  validateSubmission_(input, settings, Boolean(input && input.file && input.file.data));
  const config = getConfig_();
  const { approver1, approver2 } = resolveApprovers_(db, user, input, settings);
  checkDuplicates_(db, input, input.invoiceId, settings);

  const current = getInvoices_(db).find(row => row.ID === input.invoiceId);
  if (!current || current.SubmitterEmail !== user.email || current.Status !== 'Needs Revision') {
    throw new Error('This invoice is not available for revision.');
  }
  const nextVersion = Number(current.Version) + 1;
  let replacement = null;
  if (input.file && input.file.data) {
    const folder = DriveApp.getFileById(current.OriginalFileId).getParents().next();
    replacement = folder.createFile(
      Utilities.newBlob(Utilities.base64Decode(input.file.data), 'application/pdf', `invoice-v${nextVersion}.pdf`));
  }

  let updated;
  try {
    withLock_(() => {
      const invoice = getInvoices_(db).find(row => row.ID === input.invoiceId);
      if (!invoice || invoice.Status !== 'Needs Revision' || Number(invoice.Version) !== Number(current.Version)) {
        throw new Error('This invoice is not available for revision.');
      }
      updated = {
        ...invoice,
        Status: 'Pending Approver 1',
        Vendor: String(input.vendor).trim(),
        PO: String(input.po).trim(),
        InvoiceNo: String(input.invoiceNo).trim(),
        InvoiceDate: String(input.invoiceDate),
        Amount: Number(input.amount),
        Notes: String(input.notes || '').trim(),
        Approver1: approver1,
        Approver2: approver2,
        OriginalFileId: replacement ? replacement.getId() : invoice.OriginalFileId,
        FinalFileId: '',
        Version: nextVersion,
        PackageStatus: 'Building',
      };
      updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, updated);
      approvalRows_(invoice.ID, nextVersion, approver1, approver2)
        .forEach(row => appendObject_(db.getSheetByName(SHEETS.approvals), row));
      audit_(db, invoice.ID, user.email, 'Resubmitted', { version: nextVersion, priorFileId: invoice.OriginalFileId });
    });
  } catch (error) {
    if (replacement) replacement.setTrashed(true);
    throw error;
  }
  // Superseded versions are deleted; the audit sheet keeps the history.
  if (replacement) trashFile_(current.OriginalFileId);
  const ready = preparePackage_(db, updated, user.email, approver1,
    `Revised invoice ${updated.InvoiceNo} from ${updated.Vendor} (${formatAmount_(updated.Amount)}) is ready for your review.`);
  return { id: updated.ID, status: 'Pending Approver 1', packageReady: ready };
}

function rebuildPackage(id) {
  const user = requireUser_();
  const db = getDb_();
  const admin = isAdmin_(db, user.email);
  let invoice;
  withLock_(() => {
    invoice = getInvoices_(db).find(row => row.ID === id);
    if (!invoice || !String(invoice.Status).startsWith('Pending') || invoice.PackageStatus === 'Ready') {
      throw new Error('This invoice does not need a package rebuild.');
    }
    if (!admin && invoice.SubmitterEmail !== user.email) throw new Error('Only the submitter or an admin can rebuild the package.');
  });
  const pending = getApprovals_(db).find(row => row.InvoiceID === id &&
    Number(row.Version) === Number(invoice.Version) && row.Decision === 'Pending');
  const ready = preparePackage_(db, invoice, user.email, pending ? pending.ApproverEmail : '',
    `Invoice ${invoice.InvoiceNo} from ${invoice.Vendor} (${formatAmount_(invoice.Amount)}) is ready for your review.`);
  if (!ready) throw new Error('The package could not be built. See the Audit sheet for details.');
  return { ok: true };
}

function decideInvoice(input) {
  const user = requireUser_();
  if (!input || !input.id || !['approve', 'reject'].includes(input.action)) {
    throw new Error('Invalid approval action.');
  }
  const note = String(input.note || '').trim();
  if (input.action === 'reject' && !note) throw new Error('A reason is required to reject an invoice.');
  if (note.length > 500) throw new Error('Notes must be 500 characters or fewer.');

  const db = getDb_();
  let signatureFileId = '';
  if (input.action === 'approve') {
    const me = getRows_(db, SHEETS.approvers).find(row => String(row.Email).trim().toLowerCase() === user.email);
    signatureFileId = me ? String(me.SignatureFileId || '') : '';
    if (!signatureFileId) throw new Error('Save your signature under "My signature" before approving.');
  }

  let nextApprover = '';
  let completed = false;
  let invoice;
  withLock_(() => {
    invoice = getInvoices_(db).find(row => row.ID === input.id);
    if (!invoice) throw new Error('Invoice not found.');
    const approvals = getApprovals_(db).filter(row => row.InvoiceID === input.id &&
      Number(row.Version) === Number(invoice.Version));
    const pending = approvals.find(row => row.Decision === 'Pending');
    if (!pending || pending.ApproverEmail !== user.email) throw new Error('This invoice is not awaiting your approval.');
    if (input.action === 'approve' && invoice.PackageStatus !== 'Ready') {
      throw new Error('The review package is not ready yet.');
    }
    const invoiceSheet = db.getSheetByName(SHEETS.invoices);
    const approve = input.action === 'approve';
    updateApproval_(db, pending, {
      Decision: approve ? 'Signed' : 'Rejected',
      SignedAt: new Date().toISOString(),
      Note: note,
      Signature: approve ? `file:${signatureFileId}` : '',
    });
    if (!approve) {
      updateInvoice_(invoiceSheet, invoice, { Status: 'Needs Revision' });
      audit_(db, invoice.ID, user.email, 'Rejected', { reason: note });
      return;
    }
    const queued = approvals.find(row => row.Decision === 'Queued');
    if (queued) {
      nextApprover = queued.ApproverEmail;
      updateApproval_(db, queued, { Decision: 'Pending' });
      updateInvoice_(invoiceSheet, invoice, { Status: 'Pending Approver 2', PackageStatus: 'Building' });
      audit_(db, invoice.ID, user.email, 'Approved', { nextApprover });
    } else {
      updateInvoice_(invoiceSheet, invoice, { Status: 'Processing final PDF' });
      audit_(db, invoice.ID, user.email, 'Approved', {});
      completed = true;
    }
  });

  const fresh = () => getInvoices_(db).find(row => row.ID === input.id);
  if (input.action === 'reject') {
    sendNotice_(invoice.SubmitterEmail, 'Invoice needs revision', `Invoice ${invoice.InvoiceNo} was returned: ${note}`);
  } else if (nextApprover) {
    // The next approver is only notified once the package shows the first signature.
    preparePackage_(db, fresh(), user.email, nextApprover,
      `Invoice ${invoice.InvoiceNo} from ${invoice.Vendor} (${formatAmount_(invoice.Amount)}) is ready for your review.`);
  } else if (completed) {
    finalizeInvoice_(db, fresh(), user.email);
  }
  return { ok: true };
}

function retryFinalization(id) {
  const user = requireUser_();
  const db = getDb_();
  if (!isAdmin_(db, user.email)) throw new Error('Only an admin can retry finalization.');
  let invoice;
  withLock_(() => {
    invoice = getInvoices_(db).find(row => row.ID === id);
    if (!invoice || invoice.Status !== 'Finalization failed') {
      throw new Error('This invoice is not awaiting finalization retry.');
    }
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, { Status: 'Processing final PDF' });
    audit_(db, invoice.ID, user.email, 'Retried finalization', {});
  });
  finalizeInvoice_(db, getInvoices_(db).find(row => row.ID === id), user.email);
  return { ok: true };
}

// Builds the review package (topsheet with payment details + invoice) and optionally notifies an approver.
function preparePackage_(db, invoice, actor, notifyEmail, notice) {
  try {
    const blob = buildPackage_(db, invoice);
    const file = savePackage_(invoice, blob);
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, { PackageFileId: file.getId(), PackageStatus: 'Ready' });
    audit_(db, invoice.ID, actor, 'Package built', { version: Number(invoice.Version), fileId: file.getId() });
  } catch (error) {
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, { PackageStatus: 'Failed' });
    audit_(db, invoice.ID, actor, 'Package build failed', { message: String(error.message || error) });
    sendNotice_(invoice.SubmitterEmail, 'Invoice package could not be built',
      `The review package for invoice ${invoice.InvoiceNo} could not be built. Open the app and choose "Rebuild package".`);
    return false;
  }
  if (notifyEmail) sendNotice_(notifyEmail, 'Invoice approval requested', notice);
  return true;
}

function buildPackage_(db, invoice) {
  const config = getConfig_();
  const approvers = getRows_(db, SHEETS.approvers);
  const rows = getApprovals_(db)
    .filter(row => row.InvoiceID === invoice.ID && Number(row.Version) === Number(invoice.Version))
    .sort((a, b) => Number(a.Order) - Number(b.Order));
  const approvals = rows.map(row => {
    const person = approvers.find(item => String(item.Email).trim().toLowerCase() === String(row.ApproverEmail).toLowerCase());
    const entry = {
      order: Number(row.Order),
      name: person ? person.Name : row.ApproverEmail,
      title: person ? person.Title : '',
    };
    if (row.Decision === 'Signed') {
      const fileId = String(row.Signature).replace(/^file:/, '');
      if (!fileId) throw new Error(`Missing stored signature for approver ${row.Order}.`);
      entry.signature = Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
      entry.date = Utilities.formatDate(new Date(row.SignedAt), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a');
      entry.note = row.Note;
    }
    return entry;
  });
  const original = DriveApp.getFileById(invoice.OriginalFileId).getBlob();
  const response = UrlFetchApp.fetch(config.pdfServiceUrl.replace(/\/merge\/?$/, '/package'), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Service-Token': config.pdfServiceToken },
    payload: JSON.stringify({
      invoice: Utilities.base64Encode(original.getBytes()),
      topsheet: {
        vendor: invoice.Vendor, po: invoice.PO, invoiceNo: invoice.InvoiceNo,
        invoiceDate: invoice.InvoiceDate, amount: formatAmount_(invoice.Amount),
        notes: invoice.Notes, submitter: invoice.SubmitterEmail, approvals,
      },
    }),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error(`PDF service failed (${response.getResponseCode()}).`);
  }
  const result = JSON.parse(response.getContentText());
  if (!result.pdf) throw new Error('PDF service returned no PDF.');
  return Utilities.newBlob(Utilities.base64Decode(result.pdf), MimeType.PDF, 'package.pdf');
}

function savePackage_(invoice, blob) {
  const folder = DriveApp.getFileById(invoice.OriginalFileId).getParents().next();
  const file = folder.createFile(blob.setName(`package-v${invoice.Version}-${Date.now()}.pdf`));
  if (invoice.PackageFileId) trashFile_(invoice.PackageFileId);
  return file;
}

function trashFile_(fileId) {
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (error) {
    // Already deleted or inaccessible; nothing more to clean up.
  }
}

function finalizeInvoice_(db, invoice, actor) {
  const config = getConfig_();
  const settings = getSettings_(db);
  try {
    const merged = buildPackage_(db, invoice);
    const vendorFolder = getOrCreateFolder_(DriveApp.getFolderById(config.archiveFolderId), safeName_(invoice.Vendor));
    const filename = [
      safeName_(invoice.Vendor), safeName_(invoice.InvoiceNo),
      formatAmount_(invoice.Amount), safeName_(invoice.PO),
      Utilities.formatDate(new Date(`${invoice.InvoiceDate}T00:00:00`), Session.getScriptTimeZone(), 'MM-dd-yy'),
    ].join(', ') + '.pdf';
    const finalFile = vendorFolder.createFile(merged.setName(filename));
    if (settings.AP_EMAIL) {
      MailApp.sendEmail({
        to: settings.AP_EMAIL,
        subject: `Approved invoice: ${invoice.Vendor} - ${invoice.InvoiceNo}`,
        body: `Approved invoice attached. Submitted by ${invoice.SubmitterEmail}.`,
        attachments: [finalFile.getBlob()],
      });
    }
    const workingPackageId = invoice.PackageFileId;
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, {
      Status: 'Filed', FinalFileId: finalFile.getId(), PackageFileId: '', PackageStatus: 'Filed',
    });
    if (workingPackageId) trashFile_(workingPackageId);
    audit_(db, invoice.ID, actor, 'Filed and sent to AP', { finalFileId: finalFile.getId() });
    sendNotice_(invoice.SubmitterEmail, 'Invoice approved and filed', `Invoice ${invoice.InvoiceNo} has been approved and filed.`);
  } catch (error) {
    updateInvoice_(db.getSheetByName(SHEETS.invoices), invoice, { Status: 'Finalization failed' });
    audit_(db, invoice.ID, actor, 'Finalization failed', { message: String(error.message || error) });
    throw error;
  }
}

function getPackage(id) {
  const user = requireUser_();
  const db = getDb_();
  const invoice = getInvoices_(db).find(row => row.ID === id);
  if (!invoice) throw new Error('Invoice not found.');
  const allowed = isAdmin_(db, user.email) || invoice.SubmitterEmail === user.email ||
    getApprovals_(db).some(row => row.InvoiceID === id && row.ApproverEmail === user.email);
  if (!allowed) throw new Error('You do not have access to this invoice.');
  const fileId = invoice.Status === 'Filed' ? invoice.FinalFileId : invoice.PackageFileId;
  if (!fileId) throw new Error('The review package is not available yet.');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { name: `${safeName_(invoice.Vendor)} ${safeName_(invoice.InvoiceNo)}.pdf`, data: Utilities.base64Encode(blob.getBytes()) };
}

// --- Saved signatures ---

function getSignatureFolder_() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('SIGNATURES_FOLDER_ID');
  if (existing) return DriveApp.getFolderById(existing);
  const folder = getOrCreateFolder_(DriveApp.getFolderById(getConfig_().workingFolderId), '_signatures');
  props.setProperty('SIGNATURES_FOLDER_ID', folder.getId());
  return folder;
}

function findApprover_(db, email) {
  return getRows_(db, SHEETS.approvers).find(row => String(row.Email).trim().toLowerCase() === email);
}

function getMySignature() {
  const user = requireUser_();
  const approver = findApprover_(getDb_(), user.email);
  if (!approver || !approver.SignatureFileId) return '';
  const bytes = DriveApp.getFileById(String(approver.SignatureFileId)).getBlob().getBytes();
  return `data:image/png;base64,${Utilities.base64Encode(bytes)}`;
}

function saveSignature(dataUrl) {
  const user = requireUser_();
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('Provide the signature as a PNG image.');
  const bytes = Utilities.base64Decode(match[1]);
  const pngMagic = [-119, 80, 78, 71];
  if (bytes.length > MAX_SIGNATURE_BYTES || !pngMagic.every((value, index) => bytes[index] === value)) {
    throw new Error('The signature image is invalid or too large.');
  }
  const db = getDb_();
  const approver = findApprover_(db, user.email);
  if (!approver) throw new Error('Only listed approvers can save a signature.');
  const file = getSignatureFolder_().createFile(
    Utilities.newBlob(bytes, 'image/png', `${safeName_(user.email)}-${Date.now()}.png`));
  // Older signature files are kept: in-flight invoices may reference them.
  withLock_(() => {
    setCell_(db, SHEETS.approvers, findApprover_(db, user.email)._row, 'SignatureFileId', file.getId());
    audit_(db, '', user.email, 'Signature saved', {});
  });
  return { ok: true };
}

// --- Admin ---

function requireAdmin_() {
  const user = requireUser_();
  const db = getDb_();
  if (!isAdmin_(db, user.email)) throw new Error('Only an admin can do this.');
  return { user, db };
}

function getAdminData() {
  const { db } = requireAdmin_();
  const settings = getSettings_(db);
  return {
    settings,
    approvers: getRows_(db, SHEETS.approvers).map(row => ({
      name: row.Name, email: String(row.Email).toLowerCase(), title: row.Title,
      active: String(row.Active).toLowerCase() === 'true', hasSignature: Boolean(row.SignatureFileId),
    })),
    routing: getRows_(db, SHEETS.routing).map(row => ({
      min: Number(row.MinAmount), approver1: row.Approver1, approver2: row.Approver2,
      active: String(row.Active).toLowerCase() === 'true',
    })),
    remindersScheduled: ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'sendReminders'),
  };
}

function saveSettings(input) {
  const { user, db } = requireAdmin_();
  const settings = validateSettings_(input);
  if (settings.DEFAULT_APPROVER && !getRows_(db, SHEETS.approvers).some(row =>
    isActive_(row.Active) && String(row.Email).trim().toLowerCase() === settings.DEFAULT_APPROVER)) {
    throw new Error('Choose a default approver from the active approver list.');
  }
  withLock_(() => {
    const sheet = db.getSheetByName(SHEETS.settings);
    if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).clearContent();
    const rows = Object.keys(settings).map(key => [key, settings[key]]);
    sheet.getRange(2, 1, rows.length, 2).setValues(rows);
    audit_(db, '', user.email, 'Settings changed', settings);
  });
  return { ok: true };
}

function saveApprover(input) {
  const { user, db } = requireAdmin_();
  const email = String(input && input.email || '').trim().toLowerCase();
  const name = String(input && input.name || '').trim();
  if (!isValidEmail_(email) || !name) throw new Error('Enter a name and valid email.');
  const domain = String(PropertiesService.getScriptProperties().getProperty('ALLOWED_DOMAIN') || '').toLowerCase();
  if (email.split('@')[1] !== domain) throw new Error('Approvers must be in the allowed domain.');
  withLock_(() => {
    const existing = findApprover_(db, email);
    const values = {
      Name: name,
      Email: email,
      Title: String(input.title || '').trim(),
      Active: isActive_(input.active),
    };
    if (existing) {
      Object.keys(values).forEach(key => setCell_(db, SHEETS.approvers, existing._row, key, values[key]));
    } else {
      appendObject_(db.getSheetByName(SHEETS.approvers), values);
    }
    audit_(db, '', user.email, 'Approver saved', { email, active: values.Active });
  });
  return { ok: true };
}

function resetSignature(email) {
  const { user, db } = requireAdmin_();
  const target = String(email || '').trim().toLowerCase();
  withLock_(() => {
    const approver = findApprover_(db, target);
    if (!approver) throw new Error('Approver not found.');
    setCell_(db, SHEETS.approvers, approver._row, 'SignatureFileId', '');
    audit_(db, '', user.email, 'Signature reset', { email: target });
  });
  return { ok: true };
}

function saveRouting(rules) {
  const { user, db } = requireAdmin_();
  if (!Array.isArray(rules) || rules.length > 50) throw new Error('Provide up to 50 routing rules.');
  const known = getRows_(db, SHEETS.approvers).map(row => String(row.Email).trim().toLowerCase());
  const rows = rules.map(rule => {
    const approver1 = String(rule.approver1 || '').trim().toLowerCase();
    const approver2 = String(rule.approver2 || '').trim().toLowerCase();
    if (!(Number(rule.min) >= 0) || !known.includes(approver1) || (approver2 && !known.includes(approver2)) ||
        approver1 === approver2) {
      throw new Error('Each rule needs a minimum amount and distinct listed approvers.');
    }
    return [Number(rule.min), approver1, approver2, Boolean(rule.active)];
  });
  withLock_(() => {
    const sheet = db.getSheetByName(SHEETS.routing);
    if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).clearContent();
    if (rows.length) sheet.getRange(2, 1, rows.length, 4).setValues(rows);
    audit_(db, '', user.email, 'Routing changed', { rules: rows.length });
  });
  return { ok: true };
}

function installReminderTrigger() {
  requireAdmin_();
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'sendReminders')) {
    ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(8).create();
  }
  return { ok: true };
}

// Runs from a daily time-driven trigger.
function sendReminders() {
  const db = getDb_();
  const settings = getSettings_(db);
  const invoices = {};
  getInvoices_(db).forEach(row => { invoices[row.ID] = row; });
  const now = Date.now();
  const due = [];
  getApprovals_(db).filter(row => row.Decision === 'Pending').forEach(approval => {
    const invoice = invoices[approval.InvoiceID];
    if (!invoice || Number(invoice.Version) !== Number(approval.Version) || invoice.PackageStatus !== 'Ready') return;
    const action = reminderAction_(approval, invoice, now, settings);
    if (action) due.push({ approval, invoice, action });
  });
  due.forEach(({ approval, invoice, action }) => {
    const summary = `Invoice ${invoice.InvoiceNo} from ${invoice.Vendor} (${formatAmount_(invoice.Amount)})`;
    if (action === 'escalate') {
      sendNotice_(settings.ESCALATION_EMAIL, 'Invoice approval overdue', `${summary} has been waiting on ${approval.ApproverEmail}.`);
    } else {
      sendNotice_(approval.ApproverEmail, 'Reminder: invoice awaiting your approval', `${summary} is still awaiting your approval.`);
    }
  });
  if (due.length) {
    withLock_(() => {
      due.forEach(({ approval, action }) => {
        setCell_(db, SHEETS.approvals, approval._row, action === 'escalate' ? 'EscalatedAt' : 'RemindedAt', new Date().toISOString());
      });
    });
  }
  return due.length;
}

// --- Validation and helpers ---

function validateSubmission_(input, settings, requireFile) {
  if (requireFile) {
    if (!input || !input.file || typeof input.file.data !== 'string' ||
        typeof input.file.name !== 'string' || !input.file.data || !input.file.name) {
      throw new Error('Attach an invoice PDF.');
    }
    if (!/\.pdf$/i.test(input.file.name) || input.file.data.length > 14000000) {
      throw new Error('Upload a PDF within the supported size limit.');
    }
    const bytes = Utilities.base64Decode(input.file.data);
    const maxUploadBytes = Number(settings.MAX_UPLOAD_MB) * 1000000;
    if (!(maxUploadBytes > 0) || bytes.length > maxUploadBytes ||
        Utilities.newBlob(bytes).getDataAsString().slice(0, 5) !== '%PDF-') {
      throw new Error('Upload a valid PDF within the configured size limit.');
    }
  } else if (!input) {
    throw new Error('Invalid submission.');
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

function requireUser_() {
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const domain = String(PropertiesService.getScriptProperties().getProperty('ALLOWED_DOMAIN') || '').toLowerCase();
  if (!domain) throw new Error('Configure ALLOWED_DOMAIN.');
  if (!email || email.split('@')[1] !== domain) throw new Error('Your account is not authorized for this application.');
  return { email };
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    spreadsheetId: props.getProperty('SPREADSHEET_ID'),
    workingFolderId: props.getProperty('WORKING_FOLDER_ID'),
    archiveFolderId: props.getProperty('ARCHIVE_FOLDER_ID'),
    pdfServiceUrl: props.getProperty('PDF_SERVICE_URL'),
    pdfServiceToken: props.getProperty('PDF_SERVICE_TOKEN'),
  };
  const missing = Object.keys(config).filter(key => !config[key]);
  if (missing.length) throw new Error(`Configure required Script Properties: ${missing.join(', ')}.`);
  return config;
}

function getDb_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Set SPREADSHEET_ID in Script Properties.');
  return SpreadsheetApp.openById(id);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    clearMemo_();
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getRows_(spreadsheet, sheetName) {
  if (memo_[sheetName]) return memo_[sheetName];
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1).map((row, index) => {
    const object = {};
    values[0].forEach((key, col) => { object[key] = row[col]; });
    object._row = index + 2;
    return object;
  });
  memo_[sheetName] = rows;
  return rows;
}

function getInvoices_(db) { return getRows_(db, SHEETS.invoices); }
function getApprovals_(db) { return getRows_(db, SHEETS.approvals); }
function isAdmin_(db, email) {
  return configuredAdmins_().includes(email) ||
    getRows_(db, SHEETS.admins).some(row => String(row.Email).trim().toLowerCase() === email);
}

// Appends one row and returns its sheet row number. Call inside the script lock.
function appendObject_(sheet, object) {
  const headers = HEADERS[sheet.getName()];
  sheet.appendRow(headers.map(key => object[key] === undefined ? '' : object[key]));
  clearMemo_();
  return sheet.getLastRow();
}

function updateInvoice_(sheet, invoice, changes) {
  const updated = { ...invoice, ...changes, UpdatedAt: new Date().toISOString() };
  const headers = HEADERS.Invoices;
  sheet.getRange(invoice._row, 1, 1, headers.length)
    .setValues([headers.map(key => updated[key] === undefined ? '' : updated[key])]);
  Object.assign(invoice, updated);
  clearMemo_();
}

function updateApproval_(db, approval, changes) {
  const updated = { ...approval, ...changes };
  const headers = HEADERS.Approvals;
  db.getSheetByName(SHEETS.approvals).getRange(approval._row, 1, 1, headers.length)
    .setValues([headers.map(key => updated[key] === undefined ? '' : updated[key])]);
  clearMemo_();
}

function setCell_(db, sheetName, rowNumber, header, value) {
  const column = HEADERS[sheetName].indexOf(header) + 1;
  db.getSheetByName(sheetName).getRange(rowNumber, column).setValue(value);
  clearMemo_();
}

function audit_(db, id, actor, action, details) {
  appendObject_(db.getSheetByName(SHEETS.audit), {
    Timestamp: new Date().toISOString(), InvoiceID: id, Actor: actor,
    Action: action, Details: JSON.stringify(details || {}),
  });
}

function sendNotice_(email, subject, body) {
  if (!email) return;
  try {
    const appUrl = ScriptApp.getService().getUrl();
    const message = appUrl ? `${body}\n\nOpen the invoice approval app: ${appUrl}` : body;
    MailApp.sendEmail(email, subject, message);
  } catch (error) {
    // A failed notice (for example, mail quota) must not undo a completed workflow step.
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
