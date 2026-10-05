# Audit of the existing Airtable base

Rechecked the live base on 6 October 2026 (Australia/Sydney). Claude’s six new Shift Requests fields and both select choices are present. The application’s read-only metadata check passes with `ok: true` and no issues using the checked-in mappings. The actual Request Source option is **Client Portal** (capital P); the application mapping now matches it exactly. No Airtable records, fields, options or automations were modified in this recovery session. No participant records were imported.

The connector also verified the existing automation configurations. **1:1 event support request from RSVP** is deployed and still creates Shift Requests. Claude’s **MTM — RSVP ready for support**, **MTM — RSVP attendance changed**, and **MTM — Event details changed** drafts are all undeployed, with placeholder scripts, blank portal URLs, and webhook-secret setup still required. Preserve these drafts; do not create duplicate automations. At cutover, disable the old request creator before enabling the tested portal drafts. Until then, leave the current workflow intact.

The base already has most of the required structure. Reuse the existing **Participants**, **Events**, **RSVPs**, **Shift Requests** and **Staff** tables. There is no reason to duplicate these tables or delete existing fields. Existing formulas, billing fields, Connecteam fields and source links may be dependencies of current automations.

## What can be reused

| Table          | Existing fields                                    | Portal use                                                                                                                                 |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Participants   | `Full Name`                                        | Read the existing text formula for the participant's name. Do not overwrite it.                                                            |
| Participants   | `1:1 Support`                                      | Existing choices: None, Events only, General only, Both, Recommended.                                                                      |
| Shift Requests | `Participant`, `Event`                             | Existing correct links for participant identity and event matching.                                                                        |
| Shift Requests | `Requested Start`, `Requested End`                 | Existing date/time fields; the portal sends approved times here. Proposed edits stay in Pending change until staff approve them.           |
| Shift Requests | `Request Notes`                                    | Support description shown to the client. Review existing notes before making them client-visible.                                          |
| Shift Requests | `Worker Gender Preference`                         | Existing Male/Female/No preference choices match the portal.                                                                               |
| Shift Requests | `Support Type`                                     | General Support and Event Support already exist.                                                                                           |
| Shift Requests | `Request Status`                                   | New, Organised, Cancelled and Declined are all present.                                                    |
| Shift Requests | `Request Source`                                   | Office, Circle RSVP and Client Portal are present; preserve Fillout Form for its existing use.                              |
| Shift Requests | `Assigned Staff`                                   | Existing link to Staff; use record identity. Read names from Staff's `Name` formula. `Requested Staff` is a preference, not an assignment. |
| Events         | `Name`, `Start`, `End`, `Address`, `Stage`         | Event title, time range, location and explicit event cancellation.                                                                         |
| RSVPs          | `Participant`, `Event`, `Circle RSVP`, `Cancelled` | Existing participant/event links, Active/Dropped attendance state and cancellation timestamp.                                              |

The participant support policy confirmed by the owner is **Recommended stays hidden until support is approved**. Map it to `none` in the portal: no automatic event request, hidden by default, available through Include hidden for an ad hoc request. Staff can select General/Events/Both once support is approved. This does not alter the existing Airtable choice or record.

## Additions now verified

All six fields below already exist in **Shift Requests** with compatible types. Do not recreate or rename them.

| Verified field            | Type                                                 | Purpose                                                                                                           |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Portal request ID`  | Single-line text                                     | Stable unique portal identifier for idempotent retries. Keep the existing primary `Request` title field separate. |
| `Location`           | Single-line text                                     | Shift-specific meeting or pickup location.                                                                        |
| `Driving preference` | Single select: Required, Not required, No preference | Preserve all three client choices. Participant `1:1 Requirements` is a different, multi-select preference field.  |
| `Portal notes`       | Long text                                            | Client-visible request notes. Existing `Office Notes` may contain internal material and must remain separate.     |
| `Pending change`     | Long text                                            | Proposed edits/cancellations awaiting staff approval.                                                             |
| `Portal updated at`  | Date with time                                       | Timestamp of the latest portal update. Do not reuse Created time `Requested On`, which is not writable.           |

The **Declined** option in `Request Status` and **Client Portal** option in `Request Source` are also verified. Keep all existing options. The application does not create choices automatically and will not collapse distinct client preferences to make a write succeed.

## Copyable configuration after field review

Set these nonsecret environment variables on the hosted portal, alongside the PAT supplied securely:

```dotenv
AIRTABLE_PARTICIPANTS_TABLE=Participants
AIRTABLE_SHIFTS_TABLE=Shift Requests
AIRTABLE_EVENTS_TABLE=Events
AIRTABLE_RSVPS_TABLE=RSVPs
AIRTABLE_SUPPORT_TYPE_MAP={"Recommended":"none"}
AIRTABLE_RSVP_STATUS_MAP={"Active":"attending","Dropped":"cancelled"}
AIRTABLE_SYNC_ENABLED=false
```

Set `AIRTABLE_FIELD_MAP` to the JSON in [airtable-field-map.json](airtable-field-map.json), and `AIRTABLE_SHIFT_VALUE_MAP` to [airtable-shift-value-map.json](airtable-shift-value-map.json). The value map preserves existing board labels for both imports and writes. The support label General only is supported directly. Optional `AIRTABLE_STAFF_NAME_FIELD` defaults to Name.

The map deliberately excludes **Office Notes**, participant core notes, billing data, health documents and event Planning Notes from client-visible fields. Initial imports request only mapped fields. Assigned worker name lookups request only Name and only the workers linked to imported shifts; they do not import the entire Staff record.

## RSVP automation and duplicate ownership

Use the prepared [Airtable RSVP script](../automation/airtable-rsvp.js) once the hosted portal has a public HTTPS address. The shared secret goes in each Run a script action as `portalWebhookSecret`, and the same value goes on the hosted app as `RSVP_WEBHOOK_SECRET`. It is not a PAT and must not be a visible field or hard-coded script value.

`Circle RSVP = Active` means attending; `Dropped` means cancelled. An explicit `Cancelled` timestamp or `Events.Stage = Cancelled` takes precedence over Active. Do not map the formula **RSVP Status** to attendance: its Draft/Live/short-notice labels are part of the billing/reporting workflow, and some short-notice states also represent missing attendance reports. An invoice Status Override alone does not cancel a support booking. Use the actual Cancelled field for a cancelled RSVP.

The existing `Needs 1:1` formula already identifies active event-support eligibility. Do not use it as the only trigger condition: when an RSVP drops or is cancelled, it becomes false, but an existing confirmed support booking still needs a cancellation proposal delivered to the portal.

The existing `Source RSVP`, `Event`, `Request Source = Circle RSVP`, and Connecteam fields indicate a booking/integration workflow may already exist. The deployed **1:1 event support request from RSVP** automation is a confirmed second creator. Switch it off only at the tested portal cutover. Any external Zapier jobs still need checking. Choose one creator for event support. The portal deduplicates its retries and existing imported event/participant pairs, but cannot stop an unrelated automation creating a new row independently.

The portal currently synchronises participant support changes locally; it does not write Participants.`1:1 Support` back to Airtable. Keep the portal as the authority for request eligibility after import and send all attendance changes to it. Existing Airtable automation using Needs 1:1 must not remain a second request creator. `Source RSVP` is retained as an existing field but is not overwritten by the portal; deduplication uses the imported Event + Participant pair and Portal request ID.

## Remaining validation

Before launch, rerun the schema check, review source data and import with sync paused. Blank support labels safely map to none. Metadata alone cannot prove there are no draft events without times, duplicate event/participant requests, or ambiguous multiple staff assignments. These stop the import with a safe diagnostic rather than guessing. Existing text in Request Notes must be suitable for the linked participant or representative to see. The same applies to existing times and approval statuses before treating Organised as confirmed.

Map real client logins to explicit participant records; an Airtable import does not grant portal access. Test one participant through request, approval, change, cancellation, one eligible event RSVP, duplicate delivery, event reschedule, event cancellation and a participant without event support. Enable outgoing writes only after this check and after resolving duplicate automation ownership.

Current participant requirements (Drives, First Aid, WWCC, Male worker, Female worker), preferred/excluded staff, target hours/days, recurrence and Connecteam sync are useful existing fields, but are not automatically enforced by this first portal. Do not delete them. Staff credential checking and recurring-shift generation need their own implementation before relying on them automatically.
