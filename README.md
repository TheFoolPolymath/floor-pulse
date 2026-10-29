# Floor Pulse

One place to see the whole telecalling floor: attendance, logins (cases) and their stage, calls and talk time, rupees disbursed, efficiency scores, and team rankings. Admins see the whole branch. Team leaders see their own team.

Sign-in is with Google. Admins decide which Gmail address sees what.

## What changed in this version

- **Period: Today.** Every page has a **Today** choice next to 7d, 30d, 60d and All. Opening the Admin or Team leader view starts on Today.
- **Menu.** The sidebar opens one group at a time. Opening a group closes the others.
- **Phone.** A slim sticky header, with the Refresh, Admin / Team leader, Theme and sign-out controls in the menu. Tables show the main numbers only. The laptop shows every column.
- **Cases.** The loan-type (Product) column and field are no longer shown. The database column is kept, but nothing new is written to it.
- **Look.** Softer cards, pill-style period selector and clearer hover states on the laptop.
- **Database for the app's own data.** Staff, access, directory, targets, remarks, cases, case notes, devices and settings now live in **TiDB or MySQL**. Maintenance is standard SQL, backups and the database console.
- **Google Sheets keeps four tables only:** `Attendance`, `KPI_MIS` (logins), `Calls_MIS` (calls), `Efficiency_Log`, and `Audit_Log`. Those are the tables people already read and filter there.
- **Faster refresh.** The server keeps a short-lived copy of the sheet tables (45 seconds by default), sends responses gzipped, and reads from the database rather than the sheet.
- **Calls and talk time** are shown as `h:m:s`, for example `2h:25m:40s`. Totals are added up in seconds and then formatted, so they are correct.
- **Team-wise reports for admins:** a **Calls report** (every telecaller, grouped by team) and a **Logins** report (the same, for logins).
- **Desktop:** grouped sidebar with sub-pages; collapses to icons and remembers that choice.
- **Phone:** the team-leader pages no longer scroll sideways. Tables become label and value cards. Admin navigation opens from a menu button.
- **Server:** a small Node.js server (`server/`) replaces the Google Apps Script backend. The website is served by the same server.

The Apps Script version is kept for reference in `legacy/`. It is no longer used.

## TV display (a slide show for a big screen)

An admin opens **Staff and access**, clicks **Make a TV link**, and opens that link on the TV's browser (the page is also at `/tv`). The screen is a slide show that moves on by itself, one topic per slide (18 to 20 slides, depending on how many people are on the board):

- at a glance: logins, calls, branch score and how many are logged in today, with trend lines for the last 7 working days;
- team race (today and last 7 days), top three telecallers, and the telecaller board in pages;
- one slide per team, logged-in counts by team, team scores over 7 days, calls and logins per day, and week highlights.

The layout sizes itself to the screen, so it works on a 16:9 TV, a 4:3 screen, an ultrawide or a portrait screen. Each slide stays for 15 seconds (`?s=20` for 20 seconds). Keys: arrows to move, Space to pause, F for full screen.

Demo: `npm run tv:data` rebuilds `public/data/tv.json` from `public/data/mock.json`, using the same code as the live server. Open `tv.html?demo` to see it. `npm run tv:preview` starts a local server with made-up staff and prints both a live link and the demo link.

It shows **no** rupee amounts, disbursed amounts, customer cases, remarks, directory, devices or attendance detail (only counts of people logged in). It needs no sign-in, so the link is the only protection: anyone who has it can see the board. Use **Make a new link** or **Switch the TV off** to cut it off at once. The link key is stored in `app_state` under `TV_KEY`.

Files: `public/tv.html` (page), `public/tv.css` (look and sizes), `public/tv-slides.js` (the slides), `public/tv.js` (rotation, data, keys).

## How it fits together

```
Browser (public/)  ──POST /api──▶  Node server (server/)  ──▶  TiDB / MySQL   (staff, access, directory, targets, remarks, cases, notes, devices, settings)
                                        │
                                        └──── Google Sheets API ──▶  Attendance · KPI_MIS · Calls_MIS · Efficiency_Log · Audit_Log
                                                                     Backend team's sheet (read-only, cases and logins)
```

- **Access rules.** Every request checks the signed-in email against the access list. Revoking access takes effect on the next request.
- **Team leaders** see only their own team's telecallers, plus team totals. They cannot open the directory or change targets, remarks or staff.
- **Directory secrets.** PAN, Aadhaar and bank account numbers are encrypted in the database with `DATA_KEY` (AES-256-GCM). Admins see them in the directory; they are never in the normal data call.
- **Backend sync.** Every 10 minutes (configurable) the server reads the backend team's sheet, matches each row to a telecaller by Employee ID, then by name, and writes the cases to the database. Case IDs are stable, so the same customer keeps the same record and stage dates across syncs. It never writes to the backend team's sheet.

## Requirements

- Node.js 22.9 or newer
- A TiDB or MySQL 8 database
- A Google Cloud project (for sign-in and the Sheets service account)
- A Google Sheet for the four sheet tables

## Setup

### 1. Install

```
npm install
cp .env.example .env
```

### 2. Database

Create a database (for example `floor_pulse`) and a user with rights on it. On TiDB Cloud, copy the connection string. Put it in `.env` as `DATABASE_URL`. TLS is on by default; leave `DB_SSL=true` for TiDB.

```
npm run db:migrate
```

This creates or updates the tables. It is safe to run again.

### 3. Google sign-in

1. Go to https://console.cloud.google.com, create a project called **Floor Pulse**.
2. **APIs & Services > OAuth consent screen**: choose **External** (or **Internal** for a Google Workspace). Add the app name and your email. **Publish the app**, otherwise only test users can sign in.
3. **Credentials > Create credentials > OAuth client ID > Web application.** Add your website's address (for example `https://floor.example.com`) under *Authorised JavaScript origins*.
4. Copy the client ID into `GOOGLE_CLIENT_ID`.

### 4. Google Sheets service account

The server reads and writes the sheets through a service account, so you do not need to be signed in for it to work.

1. In the same Google Cloud project, enable the **Google Sheets API**.
2. **IAM & Admin > Service accounts > Create**. Name it `floor-pulse`. No roles are needed.
3. Open it, go to **Keys > Add key > JSON**. Download the file.
4. Put the file's contents in `GOOGLE_SERVICE_ACCOUNT_JSON` (one line), or point `GOOGLE_SERVICE_ACCOUNT_FILE` at it. Keep this file out of Git.
5. **Share the Floor Pulse sheet with the service account's email as Editor.** The email looks like `floor-pulse@<project>.iam.gserviceaccount.com`.
6. If the backend team's sheet is used, share it with the same email as **Viewer**. The backend team does not need any access to the app.

### 5. Secrets

- `SESSION_SECRET`: at least 32 random characters. Generate with `openssl rand -hex 32`.
- `DATA_KEY`: 32 random bytes in base64. Generate with `openssl rand -base64 32`.

**Back up `DATA_KEY` in a password manager.** Without it the directory's PAN, Aadhaar and account numbers cannot be read. It is not stored anywhere else.

### 6. Sheet tabs

```
npm run setup:sheets
```

Creates any missing tabs and columns in the sheet. Existing data is not changed.

### 7. Check

```
npm run check
```

Tells you what is missing before you go live. It checks the settings, the database connection and the sheet access.

### 8. Start

```
npm start
```

Open http://localhost:8787 (or your `PORT`). Sign in with an admin Gmail address.

## Moving the old data across

Run this once, after `npm run db:migrate`.

```
npm run migrate:sheets            # dry run: shows what would be copied, changes nothing
npm run migrate:sheets -- --apply # copies it
```

What it does:

- Copies Employees, Access, Config, Name_Map, Directory, Targets, Remarks, Cases, Case_Notes and Devices from the **old** spreadsheet into the database.
- Encrypts the directory's PAN, Aadhaar and account numbers with `DATA_KEY` on the way in.
- **Never changes the old spreadsheet.** Its tabs stay where they are, so you can compare or go back.
- Only fills a table that is **empty**. A table that already has rows is skipped, so running it again cannot overwrite newer data.
- Does not copy `Import_Issues`, which is rebuilt by each backend sync, or the four tables that stay in the sheet.

After you have checked the new app, you can delete the old tabs by hand. The app no longer reads them.

## Backend team's sheet

The backend team types in their own sheet. The app needs these columns (the header names are matched loosely, so small spelling differences are fine):

| Column | Example |
|---|---|
| Date | `2026-10-29` or `29/10/2026` |
| TL Name | `Asha Rao` |
| TC Emp ID | `EMP001` (preferred) |
| TC Name | `Rahul Verma` |
| Customer Name | `Sunil Jadhav` |
| RM | `RM1` |
| Stage | `Disbursed`, `Approved`, `Rejected`, `NI`, `Document pending`, `Login` |
| Amount | `150000` (a number). Words here are read as the rejection reason. |
| Bank Name | `HDFC Bank` |
| Location | `Pune` |

Rows the app cannot use (unknown Emp ID, impossible date, future date, missing customer) are listed in the **Staff and access** page with the reason, so they can be fixed in the sheet.

The old *Telecallers* helper tab and its drop-down checks were made by the Apps Script in `legacy/apps-script/BackendSync.gs` (`createBackendTemplate`). That step is **not yet ported** to the Node server. Until it is, the backend team's sheet has to be set up by hand, or that old script run once from its Apps Script project.

## Deploying

Any host that runs Node 22.9+ and keeps a process running works (a VM, Render, Railway, Google Cloud Run with an always-on instance, and so on). Set the environment variables from `.env.example` on the host. Then:

```
npm install --omit=dev
npm run db:migrate
npm start
```

Put the site behind HTTPS, and add its address to the Google OAuth client's *Authorised JavaScript origins*.

The website is served by the same server, so `ALLOWED_ORIGINS` can stay empty. Set it only if you host the website on another domain.

`wrangler.jsonc` is kept for hosting `public/` as static files on Cloudflare. In that setup, the API address goes in `public/config.js` and `ALLOWED_ORIGINS` must include the website's address.

## Day-to-day

- **Staff.** Add, move or remove telecallers in **Staff and access**. Leaving a telecaller is set to `LEFT`, not deleted, so history stays.
- **Access.** Admins add team leaders and admins by Gmail address. Revoking takes effect on their next request.
- **Targets.** Set monthly targets per telecaller or team in **Targets**.
- **Audit.** Every change is written to the `Audit_Log` sheet tab.
- **Efficiency log.** Written every 10 minutes during the shift. Old rows are removed each night (14 days kept).

## Tests

```
npm test
```

Runs 4 suites against an in-memory SQLite database and an in-memory copy of the sheets, with a fake Google sign-in:

- `test/unit.test.js`: fingerprints (checked against the old Apps Script values), backend parsing, scoring, dates, sessions, encryption.
- `test/api.test.js`: sign-in, team scoping, admin-only actions, directory encryption, cases, remarks, targets.
- `test/sync.test.js`: backend sync end to end, stable case IDs, the efficiency log.
- `test/migrate.test.js`: the one-time copy from the old sheet: dry run, encryption, idempotence, and the old sheet left untouched.

For the front end:

```
npm run test:ui
```

Runs the desktop and phone browser tests (needs Playwright installed).

### What is verified and what is not

- **Verified here:** all of the above, on SQLite for the database and an in-memory sheet.
- **Not verified here:** the MySQL / TiDB SQL itself, the live Google Sheets API calls, and the Google sign-in flow with real accounts. These were written to the documented APIs but could not be run in the build environment. Run `npm run check` and sign in once with a real admin account before relying on it.

## Troubleshooting

- **"DATABASE_URL is not set" or the server exits at start:** check `.env` against `.env.example`. The server prints each problem.
- **"The Google service account is not set":** set `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`.
- **The sheet cannot be reached (`npm run check` shows FAIL on sheet):** share the sheet with the service account's email as Editor.
- **The backend sheet cannot be opened:** share the backend sheet with the service account's email as Viewer, and check BACKEND_SHEET_ID.
- **"The Google account … has not been given access":** add the Gmail address in **App users** (admins only).
- **Directory fields show as unreadable:** `DATA_KEY` does not match the key that saved them. Restore the original key.
