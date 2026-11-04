# IEDRC Invoice Approval

This repository contains the first deployable MVP of the internal invoice workflow:

- A Google Apps Script web app for invoice submission, sequential approvals, revision/resubmission, and admin retry after a PDF-processing failure.
- Google Sheets for invoice, approval, approver, admin, and audit records.
- Google Drive for working files and filed PDFs; Gmail for approval and AP notices.
- A Node.js PDF service that prepends the generated topsheet to the submitted invoice.

This is **not a GitHub Pages app**. GitHub Pages is public static hosting and cannot securely provide the private Google Workspace workflow. The app runs in your Google Workspace; this repository is the source code.

Approvers draw a signature once under **My signature**; it is stamped on the topsheet each time they approve. This is an in-app signature with a timestamp and audit record. It is not a certificate-based or third-party legally validated e-signature.

The review package (topsheet with payment details + invoice PDF) is built when an invoice is submitted or resubmitted, so approvers can view it before approving. It is rebuilt after each signature, and superseded files are deleted.

## Google Workspace preparation

1. Create a Google Cloud project in the organization and enable billing. Enable Cloud Run, Cloud Build, Artifact Registry, Secret Manager, and the Google Apps Script API. Your Workspace administrator may need to approve the Apps Script OAuth scopes.
2. Create a Google Sheet for app data. Create two Shared Drive folders: one for working files and one for completed invoices. Give the Apps Script deployer/owner access to the Sheet and folders. App users should not receive direct access to the database Sheet or invoice folders; the app enforces their access.
3. Optional: create a Google Docs topsheet template and share it with the deployer. It may contain `{{VENDOR}}`, `{{PO}}`, `{{INVOICE_NO}}`, `{{INVOICE_DATE}}`, `{{AMOUNT}}`, `{{NOTES}}`, `{{SUBMITTER}}` and, for approvers 1 and 2, `{{APPROVER1_NAME}}`, `{{APPROVER1_TITLE}}`, `{{APPROVER1_SIG}}`, `{{APPROVER1_DATE}}`, `{{APPROVER1_NOTES}}` (same for `APPROVER2`). Put each `{{APPROVERn_SIG}}` alone in its own paragraph. Set its ID as the `TEMPLATE_DOC_ID` Script Property.
4. Generate a random token of at least 32 characters and keep it available for both Secret Manager and Apps Script Script Properties. Create the Cloud Run secret and deploy the PDF service. From the repository root:

   ```sh
   openssl rand -hex 32
   # Save the output securely, then paste it at the hidden prompt:
   read -rs -p 'Paste generated token: ' PDF_SERVICE_TOKEN
   printf '\n'
   printf '%s' "$PDF_SERVICE_TOKEN" | gcloud secrets create iedrc-pdf-service-token --data-file=-
   unset PDF_SERVICE_TOKEN
   gcloud run deploy iedrc-invoice-pdf \
     --source pdf-service \
     --region YOUR_REGION \
     --allow-unauthenticated \
     --min-instances 1 \
     --set-secrets PDF_SERVICE_TOKEN=iedrc-pdf-service-token:latest
   ```

   Grant the Cloud Run runtime service account Secret Manager access to `iedrc-pdf-service-token`. The service is publicly reachable because Apps Script cannot obtain the Google ID token a private Cloud Run service requires; every request must carry the secret `X-Service-Token`, so keep that token private and rotate it if exposed. Copy its service URL and append `/merge` for `PDF_SERVICE_URL`.
5. Create an Apps Script project, add `apps-script/Code.gs`, `apps-script/Index.html`, and `apps-script/Brand.html` (HTML files named `Index` and `Brand`), and set the project manifest from `apps-script/appsscript.json`. Set the following **Script Properties** (IDs are the strings from each Google URL):

   | Property | Value |
   |---|---|
   | `SPREADSHEET_ID` | ID of the app data Sheet |
   | `WORKING_FOLDER_ID` | ID of the working Shared Drive folder |
   | `ARCHIVE_FOLDER_ID` | ID of the completed-invoices Shared Drive folder |
   | `PDF_SERVICE_URL` | Cloud Run service URL ending in `/merge` (the app derives `/package` from it) |
   | `TEMPLATE_DOC_ID` | Optional; ID of the topsheet Google Doc template |
   | `PDF_SERVICE_TOKEN` | Same random token stored in Secret Manager |
   | `ADMIN_EMAILS` | Comma-separated initial admin email addresses |
   | `ALLOWED_DOMAIN` | Workspace email domain, without `@` |
   | `DEFAULT_APPROVER`, `AP_EMAIL`, `MAX_UPLOAD_BYTES` | Optional starting values; admins manage these in the app's **Admin settings**, which override the properties |
   | `SIGNATURES_FOLDER_ID` | Optional; created automatically under the working folder if absent |

7. Deploy the Apps Script as a **Web app**, executing as **you (the deployer/owner)**, with access limited to your Workspace domain. The owner account runs Drive, Sheets, Docs, Gmail, and Cloud Run calls; app users do not need direct access to those resources.
8. Sign in to the deployed app with an address listed in `ADMIN_EMAILS` and select **Initialize / upgrade sheets** (safe to re-run; it adds new tabs and columns without touching data). Add approvers in **Admin settings**, ask each approver to save a signature, and select **Enable daily reminders**. The reminder trigger runs as the admin who enables it, so use the owner/shared account.

Upgrading an existing deployment: redeploy `Code.gs`, `Index.html`, `Brand.html`, and `appsscript.json` (a new `script.scriptapp` scope needs re-authorization), redeploy the PDF service, then run **Initialize / upgrade sheets**. Set `TEMPLATE_DOC_ID` to your topsheet Google Doc to use it for the topsheet (see below); without it the PDF service draws a plain topsheet.

The web app runs as its owner and identifies each user with `Session.getActiveUser()`, which Google supplies for users in the owner's Workspace domain. The server rejects anyone outside `ALLOWED_DOMAIN` on every request. Keep the Apps Script project editor list restricted to trusted administrators: project editors can access its Script Properties, including the PDF service token. Never commit the token or other credentials to this repository.

## Interface and startup

Invoice lists use compact vendor/PO, status, and amount summaries. Expand **Details** or **Review & approve** for metadata and approval controls; **View PDF** opens the review package, and **Actions** groups history, revision, withdrawal, rebuild, retry, and deletion according to the user's permissions. Expansion and approval notes survive background refreshes of the same invoice version; loaded history is retained only while the invoice is unchanged.

The May 2024 IEDRC brand guide supplies navy `#1A2C57`, orange `#F06937`, light blue `#BFD4DB`, and brown `#C05B28`. The supplied horizontal logo is embedded in `Brand.html`, proportionally resized without recoloring, with clear space on a white header. Typography uses locally available Univers LT Std with Arial/Calibri fallbacks; no licensed font files or external logo hosting are required.

Initial loading fetches setup, invoices, and vendor suggestions together. Signature images and admin settings load only when their tabs are opened and are retained for the page session; mutations reload the relevant settings. Failed loads show an error and can be retried by reopening the tab. PDFs and history remain on demand.

## Approved migration direction (not yet deployed)

The target architecture is a static frontend, Supabase PostgreSQL/Auth for workflow data and Workspace sign-in, Resend for notifications, and Google Shared Drive for original and generated PDFs. Drive file IDs belong in the database; invoice lists should not fetch Drive metadata or PDFs. Keep backend credentials private and check domain, role, and invoice access on every operation.

Use indexed, paginated database queries, durable background PDF/email jobs with idempotent retries, and daily database/audit exports to Drive. Store PDFs in Drive immediately rather than introduce a daily Supabase-to-Drive file cache. Preserve existing approval ordering, signatures, permissions, audit history, and final PDF email attachments during the cutover.

This checkout still runs on Apps Script and Sheets. Cutover requires a provisioned Supabase project, Google OAuth configuration, backend access to the Shared Drive, a verified Resend sender, hosting configuration, and a verified import of existing records and file references. Do not disable the existing app until that replacement has been deployed and verified.

## PDF service local checks

Requires Node.js 20 or newer.

```sh
node --test apps-script/
cd pdf-service
npm ci
npm test
npm start
```

The service requires the `PDF_SERVICE_TOKEN` environment variable and checks the `X-Service-Token` request header. Requests without a matching token are rejected with 401.

## MVP limitations

- PDF uploads only; the limit defaults to 8 MB (admin-configurable, up to 10 MB).
- Approvals are sequential; the second approver is optional.
- A rejected invoice can be revised and resubmitted as a new version. Superseded invoice and package files are deleted; the Audit sheet keeps the history.
- Admins can retry finalization; submitters or admins can rebuild a failed review package.
- Package builds and filing run in the background (a one-off `processQueue` trigger), so submitting and approving return immediately and the page updates itself. Admins can run `processQueue` from the editor if work is ever stuck.
- Submitters or admins can withdraw an invoice; a withdrawn invoice can be revised and resubmitted. Each invoice card has a History timeline (error details are admin-only).
- Emails link directly to the invoice (`?invoice=ID`). The invoices tab has an "Awaiting my approval" view, and approvers see the rejection reason on returned invoices.
- **View invoices** supports status and date filters and CSV export. The submit form remembers vendors, their recent POs and last-used approvers.
- Reminders, escalation, duplicate detection, amount-based approver routing, and approver/signature management are configured in **Admin settings**.
- Not included: external e-signature integration (Adobe Sign API access was unavailable), OCR, and approver delegation.
