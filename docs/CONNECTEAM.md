# Connecteam: portal to NSW scheduler

## Release status

This release provides a coordinator-only **Connected tools → Connecteam** screen and a read-only connection/identity check. It saves the verified Airtable-to-Connecteam mappings in the portal database. **Automatic creation, publication, updates and cancellation of Connecteam shifts are not implemented or enabled yet.** The API key and existing-roster reconciliation are the next setup steps.

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

The 31 existing Shift Requests had no Connecteam Shift ID at the audit. A blank field does **not** prove the shift is absent from Connecteam; a manually created roster entry may already exist. Before publishing, compare the NSW roster and link existing shifts instead of creating copies. Do not blindly backfill all historical or future bookings.

The Airtable automations **Push Shift Request to Connecteam** and **Delete cancelled Shift Request from Connecteam** were both undeployed at the audit. Leave them off when the portal becomes the publisher. Any separate Zapier/other scheduler writer still needs to be identified at cutover.

## Publishing requirements for the next stage

- Only confirmed, assigned bookings with valid worker/job mappings should go live. Requested/declined bookings and pending edits must not change the roster.
- Workers and participant jobs must be available in the NSW scheduler. A published, non-open Connecteam shift needs an assigned worker.
- Reuse the returned remote shift ID for approved changes and cancellation. Persist operations and IDs so retries, restarts and lost responses cannot create duplicate shifts. An ambiguous create outcome requires reconciliation before a retry.
- Send booked times, participant job, assigned worker, event/booking title and the agreed booking brief. Do not send internal post-shift notes or unrelated participant information.
- Use `Australia/Sydney`, convert timestamps to seconds, and enforce Connecteam's 24-hour shift maximum before publishing. The portal currently accepts bookings up to 48 hours, so longer bookings need review/splitting rather than silent truncation.
- Test create, retry, reassignment, approved edits, cancellation, missing IDs, conflicts, rate limits and restart recovery against the selected scheduler before enabling automatic publishing. Decide worker notification behaviour as part of that test.

References: [scheduler lookup](https://developer.connecteam.com/docs/scheduler-get-schedulers), [create shifts](https://developer.connecteam.com/docs/scheduler-create-shifts), [update shifts](https://developer.connecteam.com/docs/scheduler-update-shifts).
