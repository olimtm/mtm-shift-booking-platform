# Portal appearance and views

The portal uses the original MTM blue mark from the supplied Google Drive website assets, without recolouring it. The bright blue accent is `#6dc3de` from the supplied main logo; dark blue buttons and charcoal text keep controls readable. Green, amber and red remain reserved for meaningful status indicators. Promotional slogans have been removed from login, navigation, headings, forms and footers.

Asset sources:
- `public/brand/mtm-mark.png`: [Logo Transparent.png](https://drive.google.com/file/d/1cqtO7ytNcriBWDC4PU2Qqv9ebwWVbLeV/view)
- `public/brand/mtm-logo.png`: [web main logo.png](https://drive.google.com/file/d/1aQgOE0tN6bAoZIWmIacb9XrN8cm2W7_d/view)

Requests default to Upcoming. Ended shifts, declined requests and cancelled requests appear under Past / completed, newest first. Ongoing support stays upcoming until its end time. Awaiting review and search operate within the selected period. Event support has the same period tabs, using the event end time. Times remain Australia/Sydney.

Linked event titles appear in request lists, calendar entries and shift details, and can be searched. New manual event requests can select an event and prefill the 30-minute buffers. Event/participant duplicate protection also applies to manual requests; existing event identity cannot be changed through an edit. Legacy unlinked requests are not assigned to a guessed event.

The participant directory and new-booking selectors use Participants > Status = Active. This is separate from the General/events/both/none support setting. Active participants with no regular support remain available for manual requests. Inactive identities and all historical records remain stored so bookings keep their participant names. Local, unlinked participants remain available.

Participant status refresh runs at startup and every five minutes, even when outbound shift sync is disabled. Staff can also use Refresh participants. It reads only the Airtable status field and updates local activity flags; it never writes to Airtable or replaces portal support settings, approvals, assignments or account grants. A failed refresh preserves the last complete result and displays an error. Previously imported linked participants with an unknown activity status stay out of the directory until refresh succeeds. The default status field is `Status`; an explicit `participants.status` entry in AIRTABLE_FIELD_MAP can override it. Existing Render mappings need no change.
