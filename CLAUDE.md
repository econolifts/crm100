# CLAUDE.md

Standing notes for Claude about this project. Claude reads this file at the start of every session.

## About me (the owner)

- I run **Econo Home Lifts**, a home lift (elevator / stairlift) sales and service business.
- I am a **beginner and do not know how to code**. I want to learn while we build.
- When you explain something:
  - Use plain, everyday language. Define any technical word the first time you use it.
  - Tell me **what** you changed, **why**, and **how I can check it** myself.
  - Keep explanations short. Offer to go deeper instead of writing a wall of text.
  - Give me step-by-step instructions when I need to do something (click here, then here).
- Before anything risky or hard to undo (deleting data, changing the live database, changing logins or security rules), stop and ask me first, in plain words.
- When something breaks, help me problem-solve: explain what went wrong and what the options are, and recommend one.

## What the app is

A CRM (customer relationship management) and service-management app for the business, built as a single web page that can be installed on a phone like an app (a "PWA").

Main areas in the app:

- **Login**, with an **Admin Panel** and a **Technician Panel** (different users see different things)
- **Business Overview** dashboard (charts)
- **Ticket Kanban Board** for service jobs
- **Service Calendar**
- **Client Database**
- **Service Contracts**
- **Fault Management**
- CSV import/export and unpaid-invoice tracking

## How it is built

- `index.html`: almost the whole app (layout, styles, and code) lives in this one large file. Make small, targeted edits; do not rewrite or reformat the whole file.
- **Firebase** (by Google) stores the data and files. The app uses Firestore (the database) and Firebase Storage. Firebase settings are inside `index.html`.
- `vendor/`: local copies of the Firebase libraries. Do not edit these.
- **Chart.js** (loaded from a CDN) draws the dashboard charts.
- `manifest.json` and `sw.js`: make the app installable and work offline. If you change files the app loads at startup, bump the cache name in `sw.js` (for example `econo-lifts-v1` to `econo-lifts-v2`) so phones pick up the new version.
- `debug.js` and `test*.js`: automated browser tests that use Playwright.

## Running and testing

1. Install the test tool once: `npm install`
2. Serve the folder on port 8080, for example: `npx http-server -p 8080` (or `python3 -m http.server 8080`)
3. In another terminal, run a test file, for example: `node test.js`
   Other tests: `test-features.js`, `test-mobile.js`, `test-csv.js`, `test-unpaid.js`

Notes for Claude:
- The tests read the Firebase files from `/home/user/crm100/vendor/`. If the repo is somewhere else, adjust that path (or use a path relative to the test file) before running.
- In cloud sessions, Chromium is at `/opt/pw-browsers/chromium`.
- After changing the app, run the relevant tests and tell me in plain words what passed and what failed.

## Working rules

- Work on a new branch and open a pull request. Do not push straight to `main`.
- Never put passwords, private keys or customer personal data in the code or in commit messages.
- Be careful with real customer data in Firebase: test changes without deleting or overwriting real records.
- Keep the app working well on phones; technicians use it in the field.
