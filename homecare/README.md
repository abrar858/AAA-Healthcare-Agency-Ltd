# AAA Homecare workspace

The authenticated workspace runs on Node.js 24 with SQLite. Open `index.html` directly for the fictional browser-only demo. Start `server.mjs` for shared state and server-enforced permissions. The server starts with an empty workspace and has no default accounts.

## Start locally

From the repository root, select a development database. Keep it outside the checkout.

```bash
export AAA_DB="$HOME/.aaa-homecare/dev.sqlite"
read -rsp "Admin password: " AAA_SETUP_PASSWORD
printf '%s\n' "$AAA_SETUP_PASSWORD" | node homecare/server.mjs add-user admin@example.invalid admin "Head Office Admin"
unset AAA_SETUP_PASSWORD
node homecare/server.mjs
```

Open http://127.0.0.1:4174 and sign in with the account you created. Create branches from **Branch setup**. When setting up a manager or other branch account, use the exact branch name. Read a unique password of at least 14 characters from a password manager or a hidden shell prompt and pass it over standard input as above.

| Account | Arguments after `add-user` |
| --- | --- |
| Branch manager | `manager@example.invalid manager "Preston Manager" Preston` |
| Branch HR | `hr@example.invalid hr "Preston HR" Preston` |
| Head Office HR | `headhr@example.invalid hr "Head Office HR"` |
| Branch rota | `rota@example.invalid rota "Preston Rota" Preston` |
| Branch accounts | `accounts@example.invalid accounts "Preston Accounts" Preston` |
| Team Leader | `leader@example.invalid team_leader "Preston Team Leader" Preston` |

Carer sign-in is paused. Carer staff records and their visit assignments are retained for future access. Run `node homecare/server.mjs list-staff` on the trusted host to find the staff ID. To reset a password, pipe the new password to `node homecare/server.mjs reset-password EMAIL`. To revoke an account, run `node homecare/server.mjs disable-user EMAIL`. Both commands revoke existing sessions.

## Hosting

Use a Node host with a persistent, private volume for the SQLite database. Set `AAA_DB` to a path on that volume, `AAA_ORIGIN` to the exact HTTPS origin, and `PORT` and `AAA_HOST` to match the host or reverse proxy. HTTP is restricted to loopback development. Run one application instance and arrange encrypted backups and a tested restore procedure before using live records. The static preview has no server or shared database.

The backend checks branch scope and role on every write and returns filtered records on reads. Cross-branch cover requests can be approved by the carer’s home branch manager. Head Office Admin can authorise urgent cover. Account provisioning is currently an operator command. The workflow records basic onboarding checks and visit activity. It does not store HR documents or implement formal care plans.

Do not commit databases, backups, credentials or real staff/client details to GitHub.

## Compliance registers

Client and carer compliance are the first screens for accounts with access. Create the client or staff record, then open their register. Each person starts with a checklist. Conditional items can be marked **Not applicable** with a reason. The dashboard uses the review due date to flag overdue items and items due within 30 days. A recorded status means evidence was entered and reviewed. It does not certify that the service meets all requirements.

Attach a PDF of up to 5 MB or enter a reference to a document in the organisation's existing records. Changes are saved as separate history entries. Files from prior versions remain available through History. Client files are available to their branch manager and Head Office Admin. Branch HR can manage their carers' records, and the branch manager can manage operational items such as training, competency and supervision. Restricted recruitment records are available to authorised HR and Head Office Admin. Downloads require an authenticated account with access to the underlying checklist item.

The included checklist is a starting point for AAA to confirm against its policies, commissioner instructions, each care package and staff role. Review intervals are entered per item. The register tracks MAR evidence and its review. It does not provide a live medication administration workflow. Use references to existing records where the original is in another format.

Run the HTTP integration checks with `node --test homecare/server.test.mjs`.

### Hosted Sites edition

The hosted edition uses the same compliance and branch rules and runs behind Sites sign-in. The hosting audience remains private. Hosting configuration sets `AAA_OWNER_EMAIL` as a secret and `AAA_ORIGIN` to the exact deployed origin. The owner is Head Office Admin. Other users need both a private-site viewer invitation and an enabled **Staff access** entry with the same sign-in email, role and branch. The first successful app sign-in binds the entry to that Site identity. Carer sign-in is paused in the hosted edition. Use **Revoke** to stop access at the app layer and remove their invitation in site sharing as needed. It stores the workspace in D1 and evidence files in a private R2 binding. The hosted edition has a 1 MB workspace metadata limit for the initial rollout. PDFs are stored separately. The Node password-provisioning commands above apply to the Node edition only.

The Sites checkout uses a Worker manifest with `d1: "DB"` and `r2: "BUCKET"`, and the migration files in `homecare/sites/drizzle` at the checkout root under `drizzle/`. From that checkout, run `node homecare/sites/build.mjs .` before packaging.

## Assessments

Head Office Admin can create templates for all branches or a selected branch. Branch managers can create templates for their own branch. Only Head Office Admin can archive or restore templates. Team leaders can start and complete client and carer assessments in their branch. Managers can view those records. Head Office Admin can complete assessments across branches. Team leaders are added through Staff access using the same two-step private invitation process as other staff.

Starter templates cover initial homecare, risks, care reviews, competency, supervision and observed practice. Add your own questions with text, date, number and choice fields. Drafts can be reopened. Once completed, records are locked and can be downloaded as a self-contained HTML document or opened in **View / Print** to print or save as PDF using the browser.

## Client and carer diaries

Head Office Admin, managers and team leaders can open **Diary**, select clients or carers, and filter by person or category. Managers can also open a person’s diary from the staff or client list. Each entry records the event date, optional time, notes, who logged it and when. Use **Add follow-up** on an entry to link an update or correction while retaining the original. Managers and team leaders are restricted to their own branch.

## Shared calendar

Head Office Admin, branch managers and team leaders can add appointments, assessments due, reviews and reminders. A personal event is visible only to its creator. Branch events are shared with the authorised calendar users in that branch. The creator can edit their events, and the branch manager or Head Office Admin can manage branch-shared events. The creator can see earlier versions in **History**. Use **Cancelled** to keep a record of an appointment that will no longer happen.

Reminder times use UK local time. Due reminders appear inside the calendar while an event is scheduled. A branch event can store a separate summary for future carer sharing. Carer sign-in is paused and the summary is internal in this release.


## Branch creation and removal

Head Office Admin creates branches and assigns manager and team leader logins through Staff access. Managers can add clients, patches, carer profiles and operational records in their own branch. A carer added by a manager starts without clearance. HR or Head Office Admin must review and clear that carer before rota allocation.

Only Head Office Admin can archive or restore clients, carers and form templates. Archived people are removed from active lists and new work. Existing evidence, completed assessments, diary and rota history are retained. Today’s and future outstanding visits must be resolved before archiving the person. Restored carers require clearance again.


## Branch action list

The list gathers missing evidence, overdue reviews, competencies due within 30 days and assessment drafts. Staff see items only if they can access the source. Automatic items disappear when the underlying record is resolved. New missing-evidence actions default to seven days after first appearing, with the branch manager's queue as owner. Restricted evidence defaults to Head Office Admin. You can assign a named authorised owner and adjust the due date.

Use **Create follow-up action** on a diary entry to assign a callback or other task. Use **Open source** from the action card to return to that diary entry, assessment or checklist item. Diary actions can be marked completed and reviewed through the status filter.

## Backups and recovery

Head Office Admin can open **Backups & recovery** to create, verify and download backups. A snapshot reads all six application tables in one database transaction, then copies every referenced PDF, including previous versions. It is listed only after all files have been read back and checked. Backups are encrypted in the hosted bucket, under a separate prefix in the same bucket as the portal's PDFs. Download a copy to an approved encrypted location that does not depend on that bucket. Downloaded TAR files contain readable care records and must be protected.

For an isolated restore, run this from a trusted computer with Node.js 24:

```bash
node homecare/sites/restore-backup.mjs /path/to/AAA-Homecare-backup.tar /path/to/new-private-restore-folder
```

The command checks file hashes and database-to-PDF references, refuses to overwrite an existing folder, and restores `aaa-homecare.sqlite` and `documents/compliance/` together. It applies the hosted schema and runs SQLite integrity checks. This does not change the live portal. In a real incident, validate an isolated recovery before an authorised operator reimports the tables and PDFs into the original hosting environment. Upload each recovered PDF under its original object key, for example `compliance/<id>` without the local file extension. A different Site uses different sign-in identities and needs an access and calendar ownership migration before cutover.

The private backup job at `POST /api/backup-job` accepts the current Sites service credential in the dispatch and backup headers. It returns only a verification summary and reuses a successful scheduled copy for that UTC day. Store the service credential and encryption key as runtime secrets. A change to the encryption key requires a backup migration or prior portable exports. No automatic retention deletion is configured.


### Compliance dates in the calendar

The calendar shows the latest due date for every active compliance item the viewer is allowed to read. These entries appear under the combined or branch calendar views, are marked **From compliance**, and link to the checklist item. Change or clear the date in that item to move or remove the entry automatically. Reviews due today or earlier also appear in **Reminders due**. These are in-portal reminders.


### Client and carer profiles

Open **People** on a phone or desktop, search by name or branch, and choose **Open profile**. Documents, assessments, diary entries, appointments and open actions are grouped on one page. Team leaders can read operational compliance evidence for their own branch through these profiles; checklist editing and restricted recruitment evidence keep their existing permissions. Personal calendar events remain visible to their creator. When creating or editing a calendar appointment, select **Linked person** to show it on that profile. Older appointments are not linked automatically.


### Weekly branch review

Managers and Head Office Admin can use **Weekly branch review** to see current open work, who owns it, and which items are overdue. Select any date in the week to see that Monday–Sunday period’s completed assessments, diary follow-ups that were closed and remain closed, and evidence updates. The report keeps evidence updates separate from completed work. Older diary actions that predate the recorded closure timestamp have no dated completion history. Managers see their own branch; Head Office Admin can use the branch selector or compare all branches.
