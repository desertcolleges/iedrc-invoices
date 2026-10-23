# IEDRC Invoice Approval

This repository contains the first deployable MVP of the internal invoice workflow:

- A Google Apps Script web app for invoice submission, sequential approvals, revision/resubmission, and admin retry after a PDF-processing failure.
- Google Sheets for invoice, approval, approver, admin, and audit records.
- Google Drive for working files and filed PDFs; Gmail for approval and AP notices.
- A Node.js PDF service that prepends the generated topsheet to the submitted invoice.

This is **not a GitHub Pages app**. GitHub Pages is public static hosting and cannot securely provide the private Google Workspace workflow. The app runs in your Google Workspace; this repository is the source code.

The initial signature is a typed name with a timestamp and audit record. It is not a certificate-based or third-party legally validated e-signature.

## Google Workspace preparation

1. Create a Google Cloud project in the organization and enable billing. Enable Cloud Run, Cloud Build, Artifact Registry, Secret Manager, and the Google Apps Script API. Your Workspace administrator may need to approve the Apps Script OAuth scopes.
2. Create a Google Sheet for app data. Create two Shared Drive folders: one for working files and one for completed invoices. Give the Apps Script deployer/owner access to the Sheet, folders, and topsheet template. App users should not receive direct access to the database Sheet or invoice folders; the app enforces their access.
3. Create a Google Docs topsheet template. Use these exact placeholders where the corresponding data should appear:

   `{{VENDOR}}`, `{{PO}}`, `{{INVOICE_NO}}`, `{{INVOICE_DATE}}`, `{{AMOUNT}}`, `{{NOTES}}`, and for each approver 1 and 2: `{{APPROVER1_NAME}}`, `{{APPROVER1_SIG}}`, `{{APPROVER1_DATE}}`, `{{APPROVER1_NOTES}}` (substitute `2` for the second approver).
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
     --no-allow-unauthenticated \
     --set-secrets PDF_SERVICE_TOKEN=iedrc-pdf-service-token:latest
   ```

   Grant the Cloud Run runtime service account Secret Manager access to `iedrc-pdf-service-token`. Grant `roles/run.invoker` on this service to the Apps Script deployer/owner account. Do not make the service public. Copy its service URL and append `/merge` for `PDF_SERVICE_URL`.
5. Create a Google OAuth client ID of type **Web application** for Google Identity Services. Configure its authorized JavaScript origins for the deployed Apps Script HtmlService page, and limit it to the organization's OAuth consent audience. Use a test account to confirm that Google sign-in works on the deployed app.
6. Create an Apps Script project, add `apps-script/Code.gs` and `apps-script/Index.html`, and set the project manifest from `apps-script/appsscript.json`. Set the following **Script Properties** (IDs are the strings from each Google URL):

   | Property | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | OAuth Web client ID from step 5 |
   | `SPREADSHEET_ID` | ID of the app data Sheet |
   | `WORKING_FOLDER_ID` | ID of the working Shared Drive folder |
   | `ARCHIVE_FOLDER_ID` | ID of the completed-invoices Shared Drive folder |
   | `TEMPLATE_DOC_ID` | ID of the Docs topsheet template |
   | `PDF_SERVICE_URL` | Cloud Run service URL ending in `/merge` |
   | `PDF_SERVICE_TOKEN` | Same random token stored in Secret Manager |
   | `ADMIN_EMAILS` | Comma-separated initial admin email addresses |
   | `ALLOWED_DOMAIN` | Workspace email domain, without `@` |
   | `DEFAULT_APPROVER` | Default first approver's email |
   | `AP_EMAIL` | Accounts Payable mailbox |
   | `MAX_UPLOAD_BYTES` | Optional; default is 8,000,000 bytes |

7. Deploy the Apps Script as a **Web app**, executing as **you (the deployer/owner)**, with access limited to your Workspace domain. The owner account runs Drive, Sheets, Docs, Gmail, and Cloud Run calls; app users do not need direct access to those resources.
8. Sign in to the deployed app with an address listed in `ADMIN_EMAILS` and select **Initialize sheets**. In the generated `Approvers` sheet, add approvers with `Name`, `Email`, `Title`, and `Active` set to `TRUE`. Confirm the `Admins` sheet lists the intended administrators.

The app uses Google Identity Services to sign users in and verifies the ID token's audience, email verification, and hosted Workspace domain on every server request. Keep the Apps Script project editor list restricted to trusted administrators: project editors can access its Script Properties, including the PDF service token. Never commit the token or other credentials to this repository.

## PDF service local checks

Requires Node.js 20 or newer.

```sh
node --test apps-script/Code.test.js
cd pdf-service
npm ci
npm test
npm start
```

The service requires the `PDF_SERVICE_TOKEN` environment variable and checks the `X-Service-Token` request header. In production, Cloud Run IAM authentication must also remain enabled (`--no-allow-unauthenticated`).

## MVP limitations

- The initial release supports PDF uploads only and limits each upload to 8 MB by default.
- Approvals are sequential; the second approver is optional.
- A rejected invoice can be revised and resubmitted as a new version; prior files and approval records are retained.
- Admins can retry finalization if PDF merging, AP email delivery, or filing fails.
- This release does not include external e-signature integration, OCR, reminders, duplicate detection, or administrative UI for maintaining approvers.
