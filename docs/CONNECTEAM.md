# Connecteam: portal to NSW scheduler

## Release status

This release provides a coordinator-only **Connected tools → Connecteam** screen, connection/identity checks, and a backed-up **one-off NSW roster import**. **Automatic creation, publication, updates and cancellation of Connecteam shifts are not implemented or enabled yet.** The import reads Connecteam and Airtable and updates only the portal database.

## One-off import before publishing

The user authorised a one-off import of past and upcoming NSW shifts on 7 October 2026, with Connecteam taking precedence. This is an initial reconciliation, not an ongoing reverse sync.

- The user confirmed that MTM started using Connecteam on **1 February 2026**. Set `CONNECTEAM_IMPORT_START_DATE=2026-02-01`; the reader includes that date through 1 January 2100 and follows all pages. If Connecteam rejects a date range, it splits the scan into smaller adjacent windows and deduplicates unchanged shifts crossing a window boundary. Invalid records, changing/repeated IDs or broken pagination abort the run before changing bookings.
- Participant jobs and staff are matched by their existing Airtable Connecteam IDs. Other jobs, missing identities, multiple-worker rows, rejected assignments and ambiguous matches appear in the exceptions report. Names are never used as identity keys.
- Existing Connecteam shift IDs take precedence over time matching. Otherwise the importer uses a unique participant/time match, or a same-day match with the same worker or description. Exact-time matches take precedence over weaker matches. Conflicting candidates are left for review.
- Connecteam wins times, assigned worker, title, location and published/draft status. Published shifts become confirmed; unpublished shifts become requested. Portal notes, driving/gender preferences, event/RSVP identities and post-shift feedback are preserved. Connecteam staff notes are not copied into family-visible fields.
- Historical inactive staff can be restored as inactive identities, without new login accounts or assignment eligibility. Shifts from unknown participants/workers are reported, never attached by guessed names.
- A definitely linked shift absent from the complete remote roster is cancelled in the portal. Unlinked portal requests are preserved and listed; absence alone does not prove they were cancelled in Connecteam.
- Before applying, an exclusive SQLite online backup is saved under the database directory's `backups/` folder on the persistent disk. A transaction saves the before/after audit, worker identities, remote shift links and completion marker together. An error rolls back the whole batch. Concurrent changes during backup abort the application.
- Imported bookings are marked **Imported from Connecteam · Saved in portal only**. Superseded queued Airtable writes are removed only for imported bookings, with their prior state retained in the backup/audit. No Connecteam or Airtable writes are made by the import.
- Set `CONNECTEAM_IMPORT_MODE=preview` and a unique `CONNECTEAM_IMPORT_RUN_ID` to inspect the plan at startup. After reviewing that plan, set the mode to `apply`. The saved completion marker prevents any later restart or repeated command from reimporting the roster. Set the mode to `off` after completion. Do not clear the completion marker to repeat an import without a separately reviewed migration.
- The coordinator screen shows counts and exceptions, with a download of the full report. The server logs only aggregate counts/reasons; source records and backup locations remain private in the database audit.

The intended direction is portal → Connecteam. Portal approvals, approved time changes, worker assignments and approved cancellations will control the corresponding roster entries. Connecteam edits will not be imported as booking decisions. Post-shift reports, internal notes, payroll, kilometres and reimbursements are outside this connection.

## What to provide

1. An owner creates a key in **Connecteam → General Settings → API keys → Add API key**. Give it a recognisable name such as `MTM booking portal`.
2. Save the complete key privately in **Render → mtm-support-bookings → Environment** as `CONNECTEAM_API_KEY`. Do not use a key ID, surround the value with quotes, commit it to GitHub, put it in WordPress or paste it into chat.
3. The selected scheduler is **NSW**. `CONNECTEAM_SCHEDULER_NAME` defaults to `NSW`; an exact, unique name is resolved using the API. If more than one scheduler has this name, set its numeric `CONNECTEAM_SCHEDULER_ID` after checking which one is intended. The checker refuses archived schedulers.
4. After the next deploy, open **Connected tools → Connecteam → Check Connecteam connection**. This only reads Connecteam and Airtable; it does not publish or modify shifts. A check also runs at startup when a key is configured. The equivalent server-only command is `npm run check:connecteam`.

Current [Connecteam developer documentation](https://developer.connecteam.com/docs/api-access) says API access is available on Expert or higher for eligible hubs; Jobs and Scheduler belong to Operations. Some older accounts have grandfathered access. A 403 result needs an account/plan access check, not a different Airtable token. The [key setup guide](https://help.connecteam.com/en/articles/8231826-job-scheduler-api-application-programming-interface) explains the owner-only key screen; its older plan wording differs from the current developer reference.

## Existing Airtable mappings

Audited read-only on 7 October 2026 (Sydney). No Airtable schema or records were changed.

| Airtable field                       | Meaning                                      |
| ------------------------------------ | -------------------------------------------- |
| Staff → Connecteam ID                | Numeric Connecteam user ID                   |
| Participants → Connecteam Job ID     | The participant's existing Connecteam job ID |
| Shift Requests → Connecteam Shift ID | Existing remote shift identity, when linked  |

The checker keys these mappings by Airtable record IDs, never display names. Missing worker/job IDs must be resolved for the shifts being published, and duplicate external IDs are reported for review. Portal workers and participants already carry their Airtable record IDs.

The 31 existing Airtable Shift Requests had no Connecteam Shift ID at the initial audit. A blank Airtable field does **not** prove the shift is absent from Connecteam. The one-off import saves verified remote shift IDs in the portal's `connecteam_shift_links` table; a future publisher must reuse these links rather than create copies.

The Airtable automations **Push Shift Request to Connecteam** and **Delete cancelled Shift Request from Connecteam** were both undeployed at the audit. Leave them off when the portal becomes the publisher. Any separate Zapier/other scheduler writer still needs to be identified at cutover.

## Publishing requirements for the next stage

- Only confirmed, assigned bookings with valid worker/job mappings should go live. Requested/declined bookings and pending edits must not change the roster.
- Workers and participant jobs must be available in the NSW scheduler. A published, non-open Connecteam shift needs an assigned worker.
- Reuse the returned remote shift ID for approved changes and cancellation. Persist operations and IDs so retries, restarts and lost responses cannot create duplicate shifts. An ambiguous create outcome requires reconciliation before a retry.
- Send booked times, participant job, assigned worker, event/booking title and the agreed booking brief. Do not send internal post-shift notes or unrelated participant information.
- Use `Australia/Sydney`, convert timestamps to seconds, and enforce Connecteam's 24-hour shift maximum before publishing. The portal currently accepts bookings up to 48 hours, so longer bookings need review/splitting rather than silent truncation.
- Test create, retry, reassignment, approved edits, cancellation, missing IDs, conflicts, rate limits and restart recovery against the selected scheduler before enabling automatic publishing. Decide worker notification behaviour as part of that test.

References: [scheduler lookup](https://developer.connecteam.com/docs/scheduler-get-schedulers), [create shifts](https://developer.connecteam.com/docs/scheduler-create-shifts), [update shifts](https://developer.connecteam.com/docs/scheduler-update-shifts).
