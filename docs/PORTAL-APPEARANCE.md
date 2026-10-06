# Portal appearance and views

The portal uses the exact MTM palette supplied in the gameshow setup: primary blue `#73cbe9`, primary pink `#f877b0`, navy/text `#0e2647`, white `#ffffff`, and black `#000000` (navy is preferred for portal text). All UI colours come from the tokens at the top of `client/styles.css`; the page surface and shadows are mixtures of those tokens. No green, amber, purple or grey status palette remains. Original Drive logo images are preserved without recolouring.

The visual theme uses white cards, a near-white navy-tinted canvas, and soft blue/pink fills. Primary colours remain exact at the token level; backgrounds, dividers, muted text and shadows mix those colours with white or transparency. Strong accents are limited to small details and navy primary actions. Event cards use compact date chips instead of large decorative banners.

Type follows a hierarchy: 15–16px body text, 13–14px secondary labels and status pills, and 28–32px page headings. Regular and medium weights replace blanket bold styling. Mobile text inputs stay at 16px to avoid browser zoom. Rendered text retains at least 4.5:1 contrast, and keyboard focus remains distinct. Status labels and icons stay visible, with fine dashed outlines for pending calendar items. Calendar columns scroll within their panel and retain sufficient width for overlapping bookings. Promotional slogans stay removed.

`npm run test:appearance` checks brand colours and their white tints, prevents large solid blue/pink panels, and verifies rendered contrast, text sizes, mobile inputs, calendar lanes and responsive overflow across staff/client views, request dialogs and account access screens.

Asset sources:

- `public/brand/mtm-mark.png`: [Logo Transparent.png](https://drive.google.com/file/d/1cqtO7ytNcriBWDC4PU2Qqv9ebwWVbLeV/view)
- `public/brand/mtm-logo.png`: [web main logo.png](https://drive.google.com/file/d/1aQgOE0tN6bAoZIWmIacb9XrN8cm2W7_d/view)

Requests default to Upcoming. Ended shifts, declined requests and cancelled requests appear under Past / completed, newest first. Ongoing support stays upcoming until its end time. Awaiting review and search operate within the selected period. Event support has the same period tabs, using the event end time. Times remain Australia/Sydney.

Linked event titles appear in request lists, calendar entries and shift details, and can be searched. New manual event requests can select an event and prefill the 30-minute buffers. Event/participant duplicate protection also applies to manual requests; existing event identity cannot be changed through an edit. Legacy unlinked requests are not assigned to a guessed event.

The participant directory and new-booking selectors use Participants > Status = Active. This is separate from the General/events/both/none support setting. Active participants with no regular support remain available for manual requests. Inactive identities and all historical records remain stored so bookings keep their participant names. Local, unlinked participants remain available.

Participant status refresh runs at startup and every five minutes, even when outbound shift sync is disabled. Staff can also use Refresh participants. It reads only the Airtable status field and updates local activity flags; it never writes to Airtable or replaces portal support settings, approvals, assignments or account grants. A failed refresh preserves the last complete result and displays an error. Previously imported linked participants with an unknown activity status stay out of the directory until refresh succeeds. The default status field is `Status`; an explicit `participants.status` entry in AIRTABLE_FIELD_MAP can override it. Existing Render mappings need no change.
