// Paste into Airtable Automations -> Run a script (not the scripting extension).
// Instructions: docs/RSVP-AUTOMATION.md. This file does not create an automation.
// Field names match the inspected base. No credentials belong in this file.
const { portalUrl, rsvpRecordId, eventRecordId } = input.config();
const secret = input.secret('portalWebhookSecret');
const target = new URL('/api/webhooks/rsvp', portalUrl);
if (target.protocol !== 'https:' || target.username || target.password) {
  throw new Error('Use the public HTTPS portal URL without embedded credentials.');
}
if (typeof secret !== 'string' || secret.length < 32) {
  throw new Error('Add the generated portalWebhookSecret in the script secret settings.');
}
if (Boolean(rsvpRecordId) === Boolean(eventRecordId)) {
  throw new Error('Supply exactly one RSVP or event record ID.');
}
const F = {
  participant: 'Participant',
  event: 'Event',
  attendance: 'Circle RSVP',
  cancelledAt: 'Cancelled',
  title: 'Name',
  start: 'Start',
  end: 'End',
  location: 'Address',
  stage: 'Stage',
};
const rsvpTable = base.getTable('RSVPs');
const eventTable = base.getTable('Events');
let records;
if (rsvpRecordId) {
  const record = await rsvpTable.selectRecordAsync(rsvpRecordId);
  if (!record) throw new Error('RSVP is missing. Use cancellation status before deleting.');
  records = [record];
} else {
  const query = await rsvpTable.selectRecordsAsync({
    fields: [F.participant, F.event, F.attendance, F.cancelledAt],
  });
  records = query.records.filter((record) =>
    (record.getCellValue(F.event) || []).some((link) => link.id === eventRecordId),
  );
}
let delivered = 0;
for (const rsvp of records) {
  const links = rsvp.getCellValue(F.event) || [];
  const people = rsvp.getCellValue(F.participant) || [];
  if (links.length !== 1 || !people.length) {
    throw new Error('Each RSVP must link exactly one event and at least one participant.');
  }
  // Read the latest event rather than the values captured when the trigger fired.
  const event = await eventTable.selectRecordAsync(links[0].id);
  if (!event) throw new Error('Linked event was not found.');
  const attendance = rsvp.getCellValueAsString(F.attendance).trim().toLowerCase();
  const eventCancelled = event.getCellValueAsString(F.stage).trim().toLowerCase() === 'cancelled';
  const cancelled =
    Boolean(rsvp.getCellValue(F.cancelledAt)) || eventCancelled || attendance === 'dropped';
  const status = cancelled ? 'cancelled' : attendance === 'active' ? 'attending' : null;
  // RSVP Status / Is Cancelled RSVP include billing rules and are not attendance.
  if (!status)
    throw new Error('RSVP needs Circle RSVP Active/Dropped or an explicit cancellation.');
  const start = event.getCellValue(F.start);
  const end = event.getCellValue(F.end);
  if (!start || !end || !(Date.parse(end) > Date.parse(start))) {
    throw new Error('Event requires a valid start and end date/time.');
  }
  // Match the portal's event validation before sending, with field-specific messages.
  // Never include participant data, record values or secrets in an error.
  const title = event.getCellValueAsString(F.title).trim();
  const location = event.getCellValueAsString(F.location).trim();
  if (title.length < 2 || title.length > 200) {
    throw new Error(
      'Events > Name must contain between 2 and 200 characters. Check the Name field on the linked event, not just its primary display label.',
    );
  }
  if (location.length > 300) {
    throw new Error('Events > Address must contain at most 300 characters.');
  }
  if (Date.parse(end) - Date.parse(start) > 47 * 60 * 60 * 1000) {
    throw new Error(
      'Events > Start and End span more than 47 hours. Check both dates as well as times; the portal supports one event of at most 47 hours plus the support buffers.',
    );
  }
  const eventDetails = {
    title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    location,
    description: '',
  };
  for (const person of people) {
    const response = await fetch(target.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        rsvpId: `${rsvp.id}:${person.id}`,
        eventId: event.id,
        participantId: person.id,
        status,
        event: eventDetails,
      }),
    });
    if (!response.ok) {
      // Translate only known failures into fixed guidance; never log a response body.
      let detail = '';
      try {
        const body = await response.json();
        if (typeof body?.error === 'string') {
          if (body.error.startsWith('event.title:'))
            detail = 'Check Events > Name: it must contain between 2 and 200 characters.';
          else if (body.error.startsWith('event.location:'))
            detail = 'Check Events > Address: it must contain at most 300 characters.';
          else if (body.error.startsWith('event.start:') || body.error.startsWith('event.end:'))
            detail = 'Check that Events > Start and End are valid dates and times.';
          else if (body.error === 'End must be after start, with a duration of at most 47 hours.')
            detail =
              'Check Events > Start and End: end must be later and no more than 47 hours after start.';
          else if (
            body.error ===
            'Participant is not linked. Link the Airtable participant record in the portal first.'
          )
            detail = 'Import or link this RSVP participant in the portal before testing again.';
        }
      } catch {
        /* A proxy or older server may return a non-JSON error. */
      }
      if (!detail && response.status === 401)
        detail = 'The script secret portalWebhookSecret must match RSVP_WEBHOOK_SECRET in Render.';
      throw new Error(
        `Portal webhook returned HTTP ${response.status}. ${detail || 'Confirm portalUrl is the correct hosted portal root address and use the current repository script. No response contents were logged.'}`,
      );
    }
    delivered += 1;
  }
}
output.set('delivered', delivered);
