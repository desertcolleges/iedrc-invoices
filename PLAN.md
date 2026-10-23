# IEDRC Invoice Approval System – Plan

## 1. Summary
Submitter uploads an invoice PDF + data (vendor, PO #, invoice #, invoice date, amount, notes) and picks up to two approvers
(from an admin-managed list; approver 1 defaults to the configured default). The system builds a PDF **topsheet**, prepends it
to the invoice, collects both approvers' e-signatures, then emails the final PDF to Accounts Payable (AP) and files it in a
Shared Drive under the vendor's folder. Approvers can reject; the submitter revises and resubmits. Everything is audited.

## 2. Recommended stack (mirrors swpr-budget style: Google Apps Script web app)
| Need | Choice | Why |
|---|---|---|
| Hosting / UI | Apps Script web app (HtmlService) + Google Sheet as DB | Same as swpr-budget; no servers, SSO is built in (`Session.getActiveUser()`), Workspace-domain only |
| Auth | Google SSO via Apps Script "execute as user accessing" / or OAuth if moved to Cloud Run | Domain restriction + role lookup from Admin sheet |
| Storage | Shared Drive (Drive Advanced Service, `supportsAllDrives`) | Vendor folders, move/rename, permissions |
| Topsheet | Google Docs template with `{{placeholders}}` → copy → replace → export PDF | Editable by staff without code; satisfies "topsheet saved in Drive with placeholders" |
| PDF merge | `pdf-lib` (needs Cloud Run/Cloud Function; Apps Script cannot merge PDFs natively) | See §6 |
| E-signature | Phase 1: in-app signature (typed/drawn) stamped into topsheet by pdf-lib, with audit record. Phase 2 option: Dropbox Sign / DocuSign API if legal requires | Keeps cost 0 and flow in one place |
| Email | GmailApp/MailApp (or Gmail API) | Notifications, AP delivery with PDF attachment |
| Audit | `AuditLog` sheet, append-only | Who/what/when/IP-less, status changes, field diffs |

Feasibility note: pure Apps Script is fastest to build but cannot merge/stamp PDFs. Recommended hybrid: Apps Script UI/workflow
+ one small Cloud Run service (Node, pdf-lib) called via authenticated `UrlFetchApp`. Alternative: whole app on Cloud Run
(Node/Express + Google OAuth + Sheets/Firestore) if you prefer a single codebase.

## 3. Data model (Sheets tabs)
- **Invoices**: ID, Status, SubmitterEmail, Vendor, PO, InvoiceNo, InvoiceDate, Amount, Notes, Approver1, Approver2, DriveFileId (original), TopsheetFileId, FinalFileId, Version, CreatedAt, UpdatedAt
- **Approvals**: InvoiceID, Version, Order(1/2), ApproverEmail, Decision(Pending/Signed/Rejected), SignedAt, Note, SignatureRef
- **Audit**: Timestamp, InvoiceID, Actor, Action, Before/After JSON
- **Settings**: Key/Value (AP email, CC list, default approver 1, Shared Drive ID, template Doc ID, root folder, reminder days)
- **Approvers**: Name, Email, Title, Active
- **Admins**: Email

## 4. Workflow / statuses
`Draft → Pending Approver 1 → Pending Approver 2 → Approved/Sent to AP → Filed`; `Rejected` (from either approver, with required reason) → `Needs Revision` → resubmit (version+1, approvals reset).
Decision to confirm: sequential (A1 then A2; recommended, simpler rejection handling) vs parallel (faster).
Each step emails the next party with a deep link; reminders via time trigger (e.g., after 2 business days); submitter can withdraw.

## 5. Web interface
- **Submit**: form with validation, PDF upload (size/type check), approver dropdowns (A1 default from settings, A2 required if desired; block same person twice and block submitter self-approval).
- **My invoices / Approver inbox**: status filters, search by vendor/PO/invoice #.
- **Invoice detail**: PDF preview (Drive preview iframe), topsheet, audit timeline, approve-and-sign / reject (reason required), edit & resubmit when rejected.
- **Admin** (Admins sheet only): approver list, AP email, CC emails, default approver, Shared Drive/template IDs, reminder cadence, vendor-name aliases, view all invoices + audit, manual resend to AP.

## 6. PDF handling and modification cases
- Topsheet generation: copy Docs template, fill placeholders (`{{VENDOR}}`, `{{PO}}`, `{{INVOICE_NO}}`, `{{INVOICE_DATE}}`, `{{AMOUNT}}`, `{{NOTES}}`, `{{APPROVER1_NAME}}`, `{{APPROVER1_SIG}}`, `{{APPROVER1_DATE}}`, `{{APPROVER1_NOTES}}`, same for 2), export PDF, merge topsheet + invoice (+ backup).
- Signature stamping: after each signature regenerate the topsheet (or stamp with pdf-lib) with name, signature image/typed text, timestamp, notes, then re-merge; keep each version in Drive. Flatten final PDF.
- **Missing backup / corrections**: allow submitter (while Needs Revision) and approvers (as a reject reason) to attach *additional* PDFs/images; the service appends them after the invoice. Never edit the original; keep originals as `v1, v2…` in an `_Archive`/`Working` folder.
- Useful extras: auto-convert images (JPG/PNG/HEIC) to PDF; allow re-ordering/removing pages before submit; reject encrypted/corrupt PDFs with clear message; page-count and size limits; optional "Add pages" step in Admin for fixes after signing (creates new version and requires re-approval).
- Optional: OCR/text extraction (Document AI or Drive OCR) to prefill vendor, invoice #, amount, date and flag mismatches between entered data and PDF. Nice-to-have, later phase.

## 7. Filing and naming rules
- Working files: `Working/<InvoiceID>/` in the Shared Drive; on completion move (`Drive.Files.update` with `addParents/removeParents`) to `Invoices/<Vendor Name>/`.
- Vendor folder: normalize name (trim, collapse spaces, strip `/ \ : * ? " < > |`), case-insensitive lookup, create if missing; admin alias table to avoid duplicates ("Acme Inc" vs "ACME, Inc."). Use a lock (`LockService`) to avoid duplicate-folder races.
- File name: `Vendor Name, Invoice Number, Amount, PO Number, Invoice Date.pdf`
  - Amount: `$#,##0.00` (e.g. `$1,234.50`; note "$0,000.00" is interpreted as thousands-separated currency).
  - Date: `MM-dd-yy` (e.g. `10-23-26`).
  - Duplicate handling: detect same vendor + invoice # (flag as possible duplicate before submit); if the filename exists, append ` (2)` and warn. Zero-pad rules and commas in vendor names need AP confirmation since commas are the delimiter.
```js
const fmtAmount = n => '$' + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtDate = d => Utilities.formatDate(d, tz, 'MM-dd-yy');
const fileName = i => [i.vendor, i.invoiceNo, fmtAmount(i.amount), i.po, fmtDate(i.date)].join(', ') + '.pdf';
```

## 8. Security and controls
Domain-restricted SSO; server-side role checks on every call (never trust client); approver can only act on invoices assigned to them and only when pending on them; signed PDFs/versions immutable; audit append-only (protect sheet); Drive permissions limited to service/group; secrets in Script Properties; input validation/escaping for HTML and file names; amount/date validation.

## 9. Suggestions and open questions
1. Is a typed/drawn in-app signature with audit trail acceptable, or do you need a legally formal e-signature vendor?
2. Sequential or parallel approval? Delegation/out-of-office reassignment by admin?
3. Approver limits (e.g., approval by dollar threshold, second approver only above $X)?
4. Should AP reply/payment status be tracked (Paid, date, check #)? Easy add: AP link/button.
5. Duplicate-invoice detection and PO validation against a PO list.
6. Vendor master list (dropdown with "add new") to keep folder names consistent.
7. Retention policy and who can view the Shared Drive archive.
8. Mobile-friendly approvals (approve from the email link).

## 10. Phased delivery
1. **MVP**: Sheet DB, SSO, submit form, topsheet from Docs template, PDF merge service, sequential approval with in-app signature, reject/resubmit, AP email, vendor folder filing + naming, audit log.
2. Admin console, reminders, additional attachments, duplicate detection.
3. OCR prefill, dashboards/reports, payment status tracking, optional external e-sign provider.
