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
  const eventDetails = {
    title: event.getCellValueAsString(F.title),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    location: event.getCellValueAsString(F.location),
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
      // Keep response bodies, secret values and participant data out of logs.
      throw new Error(`Portal webhook returned HTTP ${response.status}; check mappings and retry.`);
    }
    delivered += 1;
  }
}
output.set('delivered', delivered);
