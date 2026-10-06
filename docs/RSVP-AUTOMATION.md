# Complete the existing RSVP automation drafts in Airtable

**Verified 6 October 2026:** Claude created all three portal drafts described below; they remain disabled and contain placeholder scripts. Edit those existing drafts, preserving their triggers and conditions. The old **1:1 event support request from RSVP** automation remains enabled; disable it at the tested cutover before enabling these drafts. The script is prepared in [automation/airtable-rsvp.js](../automation/airtable-rsvp.js). It uses field names checked against your live base. It sends attendance to the portal, which creates and manages the support request and its approval.

First put the portal online using [the hosting guide](DO-IT-YOURSELF.md), finish its field mappings, and import participants and existing bookings. The portal must have a reachable HTTPS address; a development preview is not sufficient. Use a designated test participant before enabling automations for live records. Your Airtable plan needs the **Run a script** automation action.

## Exactly where the secret goes

There are two places for the **same** random value:

| Where                                                                                 | Setting name          | Value                                                     |
| ------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| Render → your portal service → Environment                                            | `RSVP_WEBHOOK_SECRET` | The random value generated when you deploy the Blueprint. |
| Airtable → Automations → each **Run a script** action → script's **Secrets** settings | `portalWebhookSecret` | Copy that same Render value here privately.               |

The script reads it using `input.secret('portalWebhookSecret')`. Add it using the script editor's secret control, not the ordinary input-variable list or a field in a table. Airtable's secret editor may also let you reuse a secret already added to the base; grant access to each script that needs it.

Your Airtable PAT is a separate credential, used by the server to read/write Airtable. It does **not** go into `portalWebhookSecret`. Replace explanatory text such as “replace-with-a-random-webhook-secret” with the generated value before testing. Changing a setting in Codex does not automatically change Render or Airtable.

## Set up the shared script action

For each automation below:

1. Open the base's **Automations** tab and select the existing draft with the name shown below. Do not create a duplicate. Leave it switched off during setup.
2. Configure and test the trigger with a designated test record.
3. Open the existing **Run a script** action and replace its placeholder with the contents of [airtable-rsvp.js](../automation/airtable-rsvp.js) into the editor.
4. Add an ordinary input variable named **portalUrl** with your actual HTTPS `.onrender.com` address from Render. Use the root address, not a login/invitation link.
5. Add the record-ID input specified below. Use the trigger's **Airtable record ID** dynamic value, not the participant's name, event name, or URL.
6. Add the secret **portalWebhookSecret** as described above. Save the script. Test the action only with the intended test record: a successful test really sends the update to the portal.

Use exactly one record-ID input for each script: `rsvpRecordId` **or** `eventRecordId`. Do not supply both.

## Automation 1: “MTM — RSVP ready for support”

- **Trigger:** When record matches conditions.
- **Table:** RSVPs.
- **Conditions:** Participant is not empty **and** Event is not empty **and** any of: Circle RSVP is Active, Circle RSVP is Dropped, or Cancelled is not empty.
- **Script input:** `rsvpRecordId` = the trigger record's Airtable record ID.

This waits for a new RSVP to have its links and attendance information, rather than firing on an incomplete newly created row. Existing records that already satisfy the conditions will not all fire when the automation is enabled; the portal's initial import handles those.

## Automation 2: “MTM — RSVP attendance changed”

- **Trigger:** When record updated.
- **Table:** RSVPs.
- **Fields to watch:** Circle RSVP, Cancelled, Participant, Event.
- **Conditional action group:** Run the script only when the record has the same complete-record/attendance conditions described for Automation 1.
- **Script input:** `rsvpRecordId` = the trigger record's Airtable record ID.

The first automation alone is insufficient: changing Active to Dropped can leave a row matching the conditions throughout. This second automation delivers those later changes and cancellations. Both automations can sometimes deliver the same RSVP; the portal prevents duplicate requests.

Keep the original participant/event pair on a delivered RSVP. To move someone to a different event or correct the participant, cancel the original RSVP and create a new one after the cancellation succeeds. Deleting rows or removing participant links does not send the old identity, so it cannot reliably cancel an existing booking.

## Automation 3: “MTM — Event details changed”

- **Trigger:** When record updated.
- **Table:** Events.
- **Fields to watch:** Name, Start, End, Address, Stage.
- **Script input:** `eventRecordId` = the trigger record's Airtable record ID.

This finds RSVPs linked to that event and sends the latest values. Changing Stage to Cancelled sends cancellation for its linked RSVPs. Existing confirmed support needs staff review; the automation must not silently remove it. Events must retain valid Start/End times even when cancelled.

## Attendance and support rules used by the script

The live base's **Circle RSVP** field uses **Active** and **Dropped**. The script maps these to attending/cancelled. A populated RSVP **Cancelled** date or an event whose **Stage** is **Cancelled** takes precedence and sends cancellation. Other states stop the run for review; the script does not guess.

Do not substitute **RSVP Status** or **Is Cancelled RSVP** for attendance: those formulas also express billing/short-notice rules in this base. When cancelling an RSVP, populate the explicit **Cancelled** date or change **Circle RSVP** to **Dropped**; changing an invoice/status override alone is not an attendance update for this script. Confirm the intended cancellation workflow before enabling these triggers. If the business uses another field as its authoritative cancellation signal, adapt the mapping first.

The portal checks whether the participant has **Events** or **Both** support enabled and adds **30 minutes before and after** an eligible attending event. General/None participants do not receive automatic event requests. Do not add a trigger condition on **Needs 1:1** or support type: cancellation updates must still arrive when a participant's support setting changes. Portal support settings are authoritative after import.

## Test before turning them on

1. With outgoing sync still paused, use a designated test participant with event support enabled. Send an Active RSVP. Check one pending portal request with the correct event times plus both buffers.
2. Run the same test again. There should still be one request for that event/participant.
3. Approve the request in the portal. Change the event time and test the event automation. Confirm the approved times stay in place while staff review the proposed change.
4. Set Circle RSVP to Dropped or populate Cancelled and test the RSVP automation. Confirm a confirmed booking receives a cancellation for staff review.
5. Check a participant with General or None support does not gain a new automatic event request. Restore test settings deliberately, then review pending changes before allowing outbound synchronization.
6. After field mappings and existing bookings are reconciled, enable portal-to-Airtable sync and verify the same single Shift Requests record is updated. Then turn the three Airtable automations on.

No Zapier automation is needed when these RSVPs already reach Airtable. Check the base's existing automations before turning these on: Shift Requests already contains event/RSVP links, so there may already be a request-creation automation. The connector confirmed the legacy request creator is deployed. No automation was changed during the recovery session; external Zapier jobs have not been inspected. Disable or reconcile any existing automation that creates the same event support shifts; the portal can prevent duplicate webhook requests but cannot prevent an independent Airtable automation from creating its own duplicate record.

For an event with many RSVPs, the event script may exceed Airtable's execution or fetch limits. Check your plan's limits and test a representative event; batch delivery would need to be added if those limits are exceeded. A failed run can have delivered some records before failing; retries use stable identities, but always resolve the reported cause first. The script rereads current events, although simultaneous automation runs are not a globally ordered change stream.

## Event address validation

The portal, initial import, forms and current automation script accept event addresses and meeting instructions up to **2,000 characters**. Earlier releases limited these to 300, which rejected existing event addresses. Deploy the latest portal code in Render and replace the script in all three Airtable actions when updating from that release. Preserve the existing record-ID inputs, portal URL and secret. Addresses are not silently shortened. Event names must still contain 2–200 characters, and Start/End must span no more than 47 hours.
