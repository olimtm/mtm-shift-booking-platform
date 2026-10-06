# Airtable integration and proposed schema

**The live base's schema has now been inspected read-only.** See [the actual base audit](AIRTABLE-AUDIT.md) for confirmed field names, compatible mappings, and Claude’s six completed fields and two select choices. No Airtable fields, records or automations have been changed. The generic defaults below document the adapter; use the audited maps in this repository for this base. The separate Airtable connector confirmed one active legacy request creator and three disabled portal drafts; see the audit for the cutover plan.

## Connection and current scope

The portal keeps login accounts and participant access permissions in its own database. Representatives can be linked to multiple participants; possession of an Airtable record ID never grants portal access. The Airtable token stays on the server. Do not put a token in browser code, a `VITE_` variable, source control, screenshots, or chat.

Set these variables through secure environment settings or a local ignored `.env`:

| Variable                      | Purpose                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIRTABLE_PAT`                | Personal access token scoped to this base. Needs `data.records:write` for outgoing requests, `schema.bases:read` for the schema audit, and `data.records:read` for any intentional record import. |
| `AIRTABLE_BASE_ID`            | The `app…` base ID from the base URL.                                                                                                                                                             |
| `AIRTABLE_PARTICIPANTS_TABLE` | Existing participant table name or `tbl…` ID. This must be supplied; the app does not guess.                                                                                                      |
| `AIRTABLE_SHIFTS_TABLE`       | Optional; defaults to `Shift Requests`.                                                                                                                                                           |
| `AIRTABLE_EVENTS_TABLE`       | Optional; defaults to `Events`.                                                                                                                                                                   |
| `AIRTABLE_RSVPS_TABLE`        | Optional; defaults to `RSVPs`.                                                                                                                                                                    |
| `AIRTABLE_FIELD_MAP`          | Optional JSON object mapping the semantic keys below to existing field names or IDs.                                                                                                              |
| `AIRTABLE_SUPPORT_TYPE_MAP`   | Optional JSON mapping existing participant support labels to `general`, `events`, `both`, or `none`, used during initial import.                                                                  |
| `AIRTABLE_RSVP_STATUS_MAP`    | Optional JSON mapping existing RSVP labels to `attending` or `cancelled`, used during initial import.                                                                                             |
| `AIRTABLE_SHIFT_STATUS_MAP`   | Optional JSON mapping existing Shift Requests labels to `requested`, `confirmed`, `declined`, or `cancelled`, used during initial import.                                                         |
| `AIRTABLE_STAFF_RECORD_MAP`   | Optional JSON object mapping portal staff IDs to existing Airtable staff `rec…` IDs, if using a staff linked-record field.                                                                        |
| `AIRTABLE_SYNC_ENABLED`       | Set to `true` after validating mappings to enable the outgoing outbox worker. Demo mode always disables Airtable writes.                                                                          |
| `RSVP_WEBHOOK_SECRET`         | Separate random secret used by the RSVP automation. Supply securely; never reuse the PAT or a login password.                                                                                     |

The adapter performs a **read-only** metadata audit against `GET /v0/meta/bases/{baseId}/tables`. Signed-in staff can invoke it through `GET /api/integrations/airtable/schema` or the integration screen. It reports missing tables/fields, incompatible types, wrong linked-table targets, and missing select choices used by outgoing requests. It does not add fields or select options. Configuration presence does not prove the PAT, mapping, or base access works: run the audit before enabling production synchronization.

Shift changes enter a durable local outbox. The adapter uses Airtable `performUpsert` on `Portal request ID` to make retries match the same shift. Keep this field writable and unique for all portal-generated requests; Airtable does not enforce uniqueness automatically. The application stores the returned Airtable record ID. Do not replace an existing Airtable-generated identifier field—add or reuse a separate portal identifier. A single application worker should own a shared database/outbox; SQLite is intended for one running app instance here.

HTTP 429 responses honor `Retry-After`, and API errors are sanitized before reaching the portal. Network timeouts and failed writes remain retryable. This is an outgoing portal-to-Airtable request integration plus an incoming event/RSVP webhook; it is **not a general bidirectional synchronization of every Airtable edit**. Staff approval and assignment should be performed in the portal until an explicit inbound approvals workflow and conflict policy are added. Do not allow a second automation to overwrite approvals independently.

## Reuse existing fields before adding anything

The default names below are configurable proposals. Match existing compatible fields first. Never delete a field just because the portal does not use it: formulas, interfaces, views, billing, reporting, and existing automations may depend on it. A live audit must also review those dependencies before recommending removals.

### Participants

| Semantic key  | Default field  | Type / use                                                                                                                    |
| ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `Name`         | Name text; use the existing participant name field.                                                                           |
| `supportType` | `Support type` | Single select or text. Suggested choices: General, Events, Both, None. Portal values are `general`, `events`, `both`, `none`. |

An Airtable participant record ID must be associated with each portal participant before that participant's shifts can sync. Signed-in staff can import initial records as described below, supply `airtableId` when creating a participant with `POST /api/participants`, or link an existing participant with `PATCH /api/participants/:id` and `{ "airtableId": "rec…" }`. A first-time RSVP webhook can create/map an event when it includes the event details, but never silently creates a participant or grants client access. Do not join people by display name or expose a roster to all client accounts. Account-to-participant permissions belong in the portal, not in a publicly accessible Airtable view. Participants marked None remain available for intentional manual requests but are hidden from the default support roster. Preferences used by automatic requests come from the participant record in the portal; after initial import, update preferences in the portal. Repeat imports preserve existing portal records and do not overwrite them from Airtable.

### Shift Requests

| Semantic key    | Default field         | Type / values                                                                                                                                                                                                     |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portalId`      | `Portal request ID`   | **Required**, single-line text; unique stable portal shift ID; merge key.                                                                                                                                         |
| `participant`   | `Participant`         | **Required**, linked records to the configured participants table. Exactly one participant per request.                                                                                                           |
| `start` / `end` | `Start` / `End`       | **Required**, date with time; send ISO timestamps with an offset/UTC.                                                                                                                                             |
| `description`   | `Support description` | **Required**, text / long text.                                                                                                                                                                                   |
| `status`        | `Status`              | **Required**, single select or text: Requested, Confirmed, Declined, Cancelled.                                                                                                                                   |
| `location`      | `Location`            | Text.                                                                                                                                                                                                             |
| `driving`       | `Driving preference`  | Single select or text: Required, Not required, No preference.                                                                                                                                                     |
| `gender`        | `Gender preference`   | Single select or text: Female, Male, No preference.                                                                                                                                                               |
| `notes`         | `Notes`               | Long text; use only necessary support information.                                                                                                                                                                |
| `kind`          | `Support kind`        | Single select or text: General, Event.                                                                                                                                                                            |
| `source`        | `Source`              | Single select or text: Client, Staff, Event.                                                                                                                                                                      |
| `event`         | `Event`               | Linked records to Events. Empty for general support. Needed to keep event relationships.                                                                                                                          |
| `staffName`     | `Staff name`          | Text snapshot of assigned staff; default until the existing staff table is identified.                                                                                                                            |
| `staff`         | Disabled by default   | Optional linked records to your existing staff table. Configure this field to retain imported linked staff IDs; use `AIRTABLE_STAFF_RECORD_MAP` to associate existing portal workers with external staff records. |
| `pendingChange` | `Pending change`      | Long text containing the proposed edit/cancellation. Current approved times/status remain unchanged until approval.                                                                                               |
| `updatedAt`     | `Portal updated at`   | Date with time for the last portal update.                                                                                                                                                                        |

All enabled mappings must exist for writes to succeed. Optional fields may be disabled with JSON `null`; retain fields needed by your workflows. `portalId`, `participant`, `start`, `end`, `description`, and `status` cannot be disabled. The initial read-only import tolerates an absent or blank legacy `Portal request ID`; it saves the existing Airtable record ID so future changes update that row. Add/map the portal identifier field before enabling writes. Linked fields always receive arrays of Airtable record IDs, not names or portal IDs. Formula, lookup, and rollup fields cannot receive writes. Select options are never created automatically (`typecast: false`).

Example mapping to **existing** field names; replace the examples after the read-only audit:

```json
{
  "participants": { "name": "Participant name", "supportType": "Support category" },
  "shifts": {
    "participant": "Client",
    "start": "Start time",
    "end": "End time",
    "description": "Support details",
    "staffName": null,
    "staff": "Assigned staff"
  }
}
```

Do not map two semantic keys to the same field. For example, do not map both approved times and proposed change times to `Start`.

### Events and RSVPs

| Table  | Semantic key    | Proposed existing field | Type / use                                                                             |
| ------ | --------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| Events | `name`          | `Name`                  | Event title text.                                                                      |
| Events | `start` / `end` | `Start` / `End`         | Event's actual date/time range.                                                        |
| Events | `location`      | `Location`              | Optional text.                                                                         |
| Events | `description`   | Disabled by default     | Optional existing description text; map it explicitly to include it in initial import. |
| RSVPs  | `participant`   | `Participant`           | Link to one participant record.                                                        |
| RSVPs  | `event`         | `Event`                 | Link to one Events record.                                                             |
| RSVPs  | `status`        | `Status`                | Existing attendance status; translate to `attending` or `cancelled` in the automation. |

If RSVPs can link multiple participants, fan out one webhook operation per participant using a composite `rsvpId` of RSVP record ID plus participant record ID. Do not silently pick the first link. The event + participant pair is the stable booking identity; repeated automation deliveries or duplicate RSVP rows must not create duplicate support shifts. To move an RSVP to a different participant/event, cancel its original pair first, then create a new RSVP record. Reusing an external RSVP identity for a different pair is rejected to protect existing bookings.

## Initial import

Signed-in staff can invoke `POST /api/integrations/airtable/import` from the integration screen. It reads Participants, Events, RSVPs, and existing Shift Requests using the configured names and field mappings, following Airtable pagination. The read adapter makes no Airtable writes. Importing creates missing local records and external record-ID mappings, without creating login access. Existing portal participants, events, shifts, and RSVP pairs are preserved on repeat imports. Existing shift records are imported before RSVPs, so an event RSVP reuses its existing support request. The portal becomes the source of truth for support preferences and approvals; use the webhook for subsequent event/attendance updates.

The entire snapshot is validated before any local changes are applied. Unknown support labels, shift statuses or attendance states, invalid dates, missing linked records, multiple events on one RSVP, duplicate portal request IDs, duplicate existing shifts for one event/participant pair, and contradictory duplicate RSVP states stop the import with a sanitized diagnostic. Resolve the mapping or source inconsistency, then retry. Event duration is limited to 47 hours so its support request fits the 48-hour shift limit after adding both buffers. Existing shifts allow up to 48 hours and retain their recorded start/end times without adding the event buffer a second time. Multi-participant RSVP links are expanded into one local pair per participant.

Default support labels are case-insensitive: General/General support; Event/Events/Event support/Event support only; Both/General and events/General and event support; None/No support. Default attending labels are Attending/Confirmed/Yes; cancellation labels are Cancelled/Canceled/Declined/No. For a base with different labels, configure explicit mappings instead of rewriting its records:

```dotenv
AIRTABLE_SUPPORT_TYPE_MAP={"Social outings":"events","Regular and events":"both"}
AIRTABLE_RSVP_STATUS_MAP={"Going":"attending","Withdrawn":"cancelled"}
AIRTABLE_SHIFT_STATUS_MAP={"Ready for roster":"requested","Allocated":"confirmed"}
```

Default shift status aliases are Requested/Pending/Pending approval/Awaiting approval, Confirmed/Approved/Booked, Declined/Rejected, and Cancelled/Canceled. Custom status maps affect incoming import only; outgoing requests still use the exact select options listed in the schema table. Missing optional driving/gender preferences default to No preference; missing source defaults to Staff, and support kind is inferred from an Event link. Unrecognized non-empty preference values fail validation instead of being guessed.

Existing worker links are imported only when `shifts.staff` is explicitly mapped. Their Airtable record IDs preserve worker identity; an explicit `AIRTABLE_STAFF_RECORD_MAP` can associate them with an existing portal worker. Text-only staff assignments remain display names, without joining potentially different workers who share a name. They must be mapped to a real staff record before availability/conflict checks can identify the worker. Subsequent sync preserves the display assignment and does not erase a linked Airtable worker merely because the portal has only a name.

Importing eligible attending RSVPs with no existing event support request may create local support requests for staff review; those new requests use the normal durable outbox. Existing imported Shift Requests retain their record IDs and do not generate a write until a portal mutation occurs. Keep `AIRTABLE_SYNC_ENABLED` unset/false while reviewing an initial import if outgoing Airtable writes should remain paused. Configure it only after checking that imported participants, timings, staff identities, and select mappings match expectations. The importer never infers login permissions from participants.

## Event automation

Use **Airtable Automations** as the primary integration if RSVPs already land in Airtable. It avoids a second system for the same record lifecycle. Use Zapier only if the current RSVP source needs its connector or the Airtable plan lacks the required automation capability. Enable one owner for each trigger; running both can generate conflicting updates even when duplicate request creation is prevented.

Create triggers for:

1. An RSVP created or its attendance status changed: resolve linked records and send current values to the webhook. Handle participant/event changes as cancellation plus a new RSVP, as above.
2. Event Start, End, or Location changed: find all associated RSVPs and send the latest event values for each attendance record. This updates event metadata and proposes changes to existing support requests.
3. RSVP cancellation: send a cancellation state instead of deleting the RSVP row. A deletion trigger cannot reliably recover deleted links; use a status field or an explicit before-delete workflow.

For Events/Both participants, an attending RSVP creates a **Requested** shift from event start minus 30 minutes to event end plus 30 minutes. General/None participants do not automatically receive event shifts. Manual requests remain available. Staff must approve requests and proposed changes/cancellations; a cancelled RSVP must not silently erase a confirmed booking. Reschedules must retain the current approved booking until staff decide on the pending change. Repeated deliveries should preserve an existing approval and any unrelated client proposal. A retry of an old event snapshot must not revert a newer reschedule: read current linked records immediately before sending, serialize automation delivery where possible, and reconcile after failed automation runs. This initial webhook does not implement a globally ordered Airtable change stream.

The webhook must be reachable at a stable HTTPS app URL. A browser-only preview or a private localhost server is not sufficient. Store the webhook secret as an Airtable Automation secret, using `input.secret('portalWebhookSecret')`; never put it in a visible record field or hard-code it. `POST /api/webhooks/rsvp` requires `Authorization: Bearer <secret>`, with the same secret (at least 16 characters; use 32+ random characters) supplied as `RSVP_WEBHOOK_SECRET` on the server. It is separate from interactive cookie-based logins.

```json
{
  "rsvpId": "recRSVP_RECORD_ID:recPARTICIPANT_ID",
  "eventId": "recEVENT_RECORD_ID",
  "participantId": "recPARTICIPANT_ID",
  "status": "attending",
  "event": {
    "title": "Community activity",
    "start": "2026-10-10T10:00:00+11:00",
    "end": "2026-10-10T12:00:00+11:00",
    "location": "Community centre",
    "description": "Event description"
  }
}
```

Use the prepared [automation/airtable-rsvp.js](../automation/airtable-rsvp.js), which matches the audited base's real field names, and follow [the step-by-step automation guide](RSVP-AUTOMATION.md). It explains the three triggers and the exact **portalWebhookSecret** secret setting. The script uses Circle RSVP Active/Dropped, with a Cancelled timestamp or cancelled event taking precedence; billing status formulas are not treated as attendance.

No automation has been created in Airtable. Check existing automations and Zapier Zaps for another event-support request creator before enabling this integration. The portal enforces eligibility and idempotency; the automation forwards attendance and cancellation for all linked participants so a now-ineligible participant can still have an existing booking cancelled.

For large events, batch deliveries to stay within your Airtable plan's automation runtime and fetch limits. Retry failed batches using the same identities. Prefer explicit cancellation statuses; removing a participant from a multi-participant link requires delivering cancellation for the removed participant first. This script deliberately does not create Airtable support requests itself—the portal owns the approval policy and outbox writes.

## Live connection checklist

1. Supply the base URL/ID, participant table name, and existing RSVP source; configure the PAT securely.
2. Run the schema audit and map compatible existing fields. Review necessary additions with the base owner, including exact select options. No automated field deletion is proposed.
3. Import or explicitly create participant/event mappings. Keep representative permissions separate from the import. Merely configuring a token does not start an import; staff invoke it explicitly. Reconcile existing Shift Requests before enabling outgoing writes.
4. Exercise one test participant: create a request, approve it, propose an edit, reject/approve it, and request cancellation. Verify the corresponding single Airtable record and pending-change field.
5. Exercise one eligible event RSVP, duplicate delivery, cancellation, and reschedule; verify the 30-minute buffer and staff approval policy. Verify a None/General participant does not auto-create an event shift.
6. Check failed automation runs/outbox entries and retry only after resolving their cause. Confirm local database backups and persistent storage before real bookings.

Outstanding policy questions for launch include the timezone, booking notice/cancellation windows, recurring support, travel/billing treatment of the buffer, the staff assignment source, participant notifications, and how to resolve conflicting updates from Airtable and the portal. These do not block the local interface, but must be agreed before enabling independent production writers.

### Importing an existing base with incomplete RSVPs

In Connected tools, select **Import valid records and report incomplete or conflicting RSVPs** before importing if legacy attendance is incomplete. This is opt-in: the default import still stops on invalid data. The option omits only invalid RSVP attendance, including every contradictory status for an event/participant pair; it never guesses attendance or skips existing shift requests. Other participants on a grouped RSVP can still import if their attendance is unambiguous. Existing shift requests may have blank notes, which remain blank. All participants, events and existing shifts must pass validation before the transaction writes anything.

Review the result and download the import report directly from the portal. It lists omitted RSVP record IDs, reasons and Airtable links, without names or record contents. Omitted records remain unchanged in Airtable. Correct attendance there when needed and repeat the import; existing portal approvals, assignments and links are preserved. Keep outbound sync and the legacy request-creation automation disabled during cutover testing. Import existing shifts before testing webhooks to preserve duplicate prevention.
