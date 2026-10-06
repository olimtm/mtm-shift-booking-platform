# Booking workflow

The requested default is staff approval for new requests, changes, and cancellations. Client accounts may represent one or several linked participants. The server enforces that scope independently of the interface.

## Request lifecycle

1. A client or coordinator submits the participant, start/end times, support description, meeting location, driving preference, worker gender preference, and notes.
2. The request appears in the staff review queue. A coordinator approves or declines; an approved shift can have a named support worker or await assignment.
3. A client requests an edit or cancellation. The existing booked details remain in force, with a separate pending proposal.
4. A coordinator approves the proposal or keeps the original booking. Assignments reject overlaps with that worker's other confirmed shifts.
5. Each request and decision enters the durable Airtable outbox. A failed sync leaves the local booking intact and remains visible for retry.

The current form captures preferences; it does not certify a worker's driving capability or gender. A coordinator is responsible for matching those preferences. Recurring shifts, billing, client notification delivery, and staff availability calendars are not implemented in this version.

### Worker roster

With Airtable connected, the portal refreshes the Staff roster at startup and every five minutes. **Active** and **Active - Volunteer** staff appear as assignable workers unless **Archived** is checked. Coordinators can use **Support workers → Refresh workers** to refresh immediately. Airtable controls worker names and activity; the portal controls assignments and approvals. Sync never grants a login.

Inactive, archived or deleted Airtable staff are excluded from new assignments. Existing bookings retain their worker and status until a coordinator changes them. Returning workers reuse their existing portal identity. Existing local workers remain available; matching names are never merged automatically. A failed refresh keeps the previous complete roster and displays an error on Support workers.

## Participant support settings

| Setting | Default staff roster   | Manual requests | Automatic event support |
| ------- | ---------------------- | --------------- | ----------------------- |
| General | Visible                | Available       | No                      |
| Events  | Visible                | Available       | Yes                     |
| Both    | Visible                | Available       | Yes                     |
| None    | Hidden; toggle to show | Available       | No                      |

Changing an existing participant to Events or Both checks their future attending RSVPs and creates missing support requests. Changing away from event support does not silently cancel existing requests or confirmed bookings: review those explicitly. Default roster hiding never removes an existing request from the approval queue.

## Event support

An attending RSVP for an eligible participant creates a Requested shift from event start minus 30 minutes to event end plus 30 minutes. A 10:00–12:00 event therefore creates 09:30–12:30 support. The event/participant pair is unique even if an automation retries or there are duplicate RSVP rows.

- A repeated RSVP preserves staff approvals and declines.
- Event reschedules update an unconfirmed request. Confirmed bookings keep their original details and receive a pending change.
- RSVP cancellation cancels an unconfirmed automatic request. A confirmed booking receives a cancellation proposal for staff review.
- Re-attending after cancellation reopens the same request for review, rather than creating a second booking.
- Replaying a request is safe; globally ordering conflicting old/new event snapshots is not yet implemented. The documented automation re-reads current Airtable records before delivery.

Local event creation and RSVP entry are available for demonstration and intentional manual work. They are not written back to Airtable Events/RSVPs. In a connected workspace, continue using the established Airtable event/RSVP source and the webhook. A local-only participant or event needs a real Airtable record mapping before linked shift sync can succeed; the adapter fails safely instead of writing an invalid link.

## Time and access

All visible calendar/form times use `Australia/Sydney`. UTC timestamps and actual elapsed durations handle daylight-saving transitions; nonexistent spring-forward times are rejected. Changing the operating timezone requires an explicit application configuration change in this initial version.

Coordinators can view all participants, including those with no regular support. Clients can view only their linked participants, related shifts, related events/RSVPs, assigned worker names and shared post-shift updates. Coordinator participant notes, internal post-shift notes, the full worker roster, and integration statistics are not exposed to client accounts.

Workers have a separate account role linked to one active support-worker record. They see only their assigned confirmed/cancelled shifts and cannot change bookings or manage people. Post-shift reports include activities, participant feedback and goal progress, and publish immediately to linked client accounts. Internal handover notes and coordinator follow-up remain private. See [Worker access and post-shift updates](POST-SHIFT-UPDATES.md) for setup and editing rules.

Demo accounts and data are deliberately isolated. Real client and worker access is granted by a coordinator through **People & access** after importing or creating the relevant records. Public registration is not offered.
