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
| Carer | `carer@example.invalid carer "Carer Name" Preston STAFF_ID` |

Create the carer’s staff record in HR before provisioning their login. Run `node homecare/server.mjs list-staff` on the trusted host to find the staff ID. To reset a password, pipe the new password to `node homecare/server.mjs reset-password EMAIL`. To revoke an account, run `node homecare/server.mjs disable-user EMAIL`. Both commands revoke existing sessions.

## Hosting

Use a Node host with a persistent, private volume for the SQLite database. Set `AAA_DB` to a path on that volume, `AAA_ORIGIN` to the exact HTTPS origin, and `PORT` and `AAA_HOST` to match the host or reverse proxy. HTTP is restricted to loopback development. Run one application instance and arrange encrypted backups and a tested restore procedure before using live records. The static preview has no server or shared database.

The backend checks branch scope and role on every write and returns filtered records on reads. Cross-branch cover requests can be approved by the carer’s home branch manager. Head Office Admin can authorise urgent cover. Account provisioning is currently an operator command. The workflow records basic onboarding checks and visit activity. It does not store HR documents or implement formal care plans.

Do not commit databases, backups, credentials or real staff/client details to GitHub.
