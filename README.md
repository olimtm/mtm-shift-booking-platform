# MTM support bookings

A working first version of a 1:1 support booking portal: React + TypeScript, Express, and persistent SQLite on Node 24. Includes a client portal, staff workspace, approval workflows, and configurable Airtable integration.

Recovery and validation details: [docs/RECOVERY.md](docs/RECOVERY.md). The original application and release archive were recovered and preserved.

## Run the demo

```sh
npm ci
npm run demo
```

Vite serves the interface on port 5173 and proxies `/api` to Express on port 3001. On the sign-in screen, select **Staff workspace** or **Client portal** to explore fictional records. Demo account emails are `coordinator@mtm.demo` and `alex@mtm.demo`; both use `DemoSupport!2026`. The client represents two participants, demonstrating scoped access.

Demo data is retained in `.local/demo.sqlite`. Real data defaults to a separate `.local/support.sqlite`. Demo mode never writes to Airtable; production refuses demo mode and demo databases. To start a fresh demonstration, run `DEMO_MODE=true DATABASE_PATH=.local/fresh-demo.sqlite npm run dev` with a new ignored path rather than deleting an existing database. `npm run demo` always uses its dedicated demo path.

## What works

- Email/password sign-in with password hashing, persistent expiring server sessions, HTTP-only cookies, login throttling, and role/participant access checks.
- Client calendar and list views; shift details including support worker, times, location, description, and preferences; new requests, edits, and cancellation requests.
- Staff calendar, participant filter, approval queue, support worker assignment, and overlapping staff assignment checks.
- Participant settings: general support, events, both, or none. None is hidden from the default roster but remains available for manual requests.
- Browser-based first coordinator setup and People & access administration: invite clients/coordinators, grant one or more participants, issue single-use password links, and disable access. Creating a participant does not create a login.
- Event RSVPs create one request per eligible event/participant pair, with 30 minutes before and after. Retries preserve approvals; event changes and confirmed-shift cancellations require review.
- Staff-only read-only Airtable schema audit and initial participant/event/shift/RSVP import. Outbound requests use a durable retry queue and stable upsert identifier.
- Sydney time display and input, including daylight-saving handling; timestamps stored as UTC.

## Use an empty real workspace

Create an ignored `.env` from `.env.example`, configure `DATABASE_PATH`, leave `DEMO_MODE=false`, and supply a random `MTM_SETUP_SECRET` of at least 32 characters securely in the process environment. Start `npm run dev`, open the app, and complete **Make this your workspace** using that key. The first account is a coordinator; setup closes once that account exists. Render's deployment recipe generates the key automatically.

Create or import participants, then open **People & access → Invite someone**. Choose Client and select exactly whose records the person may access, or choose Coordinator for full workspace access. Send the generated private link yourself; the app does not send email. Links expire after 48 hours and work once. Coordinators can issue replacement/password reset links and revoke access on the same screen. Keep a second trusted coordinator account for recovery.

The optional developer CLI remains available:

```sh
npm run create-user -- --email coordinator@example.com --name "Coordinator Name" --role staff
```

It prompts for a password without echo. Do not put passwords in command arguments or source control. It also accepts `--password-stdin` or a securely injected `CREATE_USER_PASSWORD`. Existing users are never overwritten. Coordinator accounts appear as assignable support workers; the **Support workers** screen also lets you add workers without coordinator access and link existing Airtable Staff record IDs.

## Airtable

The live base metadata was rechecked read-only on 6 October 2026 (Sydney). Reuse **Participants**, **Events**, **RSVPs**, **Shift Requests**, and **Staff**. [The audit](docs/AIRTABLE-AUDIT.md) confirms Claude’s six new fields and two select choices. The exact `Client Portal` mapping is corrected and the application schema check passes with no issues. No live records, fields, or automations were changed. Recommended support remains hidden until approved.

See [docs/AIRTABLE.md](docs/AIRTABLE.md) for access and import steps, the audited JSON mappings, and [the RSVP automation guide](docs/RSVP-AUTOMATION.md) for the prepared script and exact trigger setup. The staff integration screen includes a read-only schema check and deliberate initial import. Reuse existing compatible fields; the app does not delete fields or change the base schema.

Keep `AIRTABLE_SYNC_ENABLED=false` until mappings and existing shifts are reconciled. Initial import reads Participants, Events, existing Shift Requests, and RSVPs. Existing bookings are imported before RSVPs so their approved times and record IDs are preserved without creating duplicate event support. The portal owns approvals and assignments and syncs those changes out to Airtable. Direct Airtable shift edits are not currently imported back. Use the authenticated webhook for subsequent event/RSVP updates. The team has confirmed that approvals and assignments belong in the new portal. Review imported records and any mapping warnings before enabling outbound writes.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

GitHub Actions runs these checks and both browser suites on pushes and pull requests, using fictional data and no Airtable credentials.

The API tests use isolated temporary SQLite databases and mocked Airtable responses. They exercise authentication and account scope, staff decisions, conflicts, RSVP padding/idempotency, reschedules/cancellations, persistent sessions and retry queues, and read-only import. They do not validate access to a live Airtable base.

The browser smoke test in `scripts/browser-smoke.ts` uses the running demo and makes fictional test requests. Run it with `npm run test:browser` while `npm run demo` is running. It uses a system Chromium when available, or an installed Playwright Chromium. Use a separate demo database for automated checks if you want to preserve your demonstration records.

After building, `npx tsx scripts/browser-accounts.ts` checks initial setup, invitations, scoped client access, resets and disabling accounts in desktop/mobile browsers. It starts its own server with a temporary database, excludes Airtable credentials, and removes its test database when finished. It requires Chromium and uses port 3012 by default (`ACCOUNT_BROWSER_PORT` can override it).

## Deploy it yourself

Follow [the do-it-yourself guide](docs/DO-IT-YOURSELF.md) to host this app in your own Render account using [render.yaml](render.yaml). It provisions one paid Node 24 web service and a persistent disk, generates setup/webhook secrets, and uses Render's HTTPS address without DNS changes. Code must be on GitHub first; creating this recipe does not deploy or purchase hosting. Add [a WordPress button](docs/WORDPRESS-PAGE.md) once the hosted portal is tested.

For other hosts:

```sh
npm ci --include=dev
npm run build
NODE_ENV=production npm start
```

Production requires an exact HTTPS origin in `PUBLIC_ORIGIN` (or Render's supplied `RENDER_EXTERNAL_URL`) and `DEMO_MODE=false`. Retain `DATABASE_PATH` on a persistent volume, serve the app and webhook at the same origin, and use one running instance with this SQLite database. The runtime needs Node 24 and `tsx`, which is included in production dependencies. Use the tested [online database backup and recovery procedure](docs/BACKUPS.md) before real bookings; a persistent disk alone is not a backup process. Never copy the demo database into production.

## Decisions still needed

- Complete the existing three disabled portal automation drafts and retire the active legacy RSVP request creator at cutover. External Zapier jobs still need checking.
- Current rule: every attending RSVP for Events/Both support creates one request, with 30 minutes on either side.
- Cancellation notice periods, recurring shifts, notifications, and whether worker preferences are hard requirements.
- Purchase hosting, configure backups, choose coordinators, and complete the live import/round-trip check before client invitations.

See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the approval and event lifecycle rules implemented now.
