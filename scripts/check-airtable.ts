import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { AirtableRequestError, inspectAirtableSchema } from '../server/airtable.js';

// Read metadata only. Never import participant data or modify Airtable.
const env = {
  ...process.env,
  AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
  AIRTABLE_EVENTS_TABLE: 'Events',
  AIRTABLE_RSVPS_TABLE: 'RSVPs',
  AIRTABLE_SHIFTS_TABLE: 'Shift Requests',
  AIRTABLE_FIELD_MAP: readFileSync(
    new URL('../docs/airtable-field-map.json', import.meta.url),
    'utf8',
  ),
  AIRTABLE_SHIFT_VALUE_MAP: readFileSync(
    new URL('../docs/airtable-shift-value-map.json', import.meta.url),
    'utf8',
  ),
  AIRTABLE_SUPPORT_TYPE_MAP: '{"Recommended":"none"}',
  AIRTABLE_RSVP_STATUS_MAP: '{"Active":"attending","Dropped":"cancelled"}',
};
try {
  const report = await inspectAirtableSchema(env);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof AirtableRequestError
      ? error.message
      : 'Read-only schema check failed. Check Airtable access and environment configuration. No Airtable data was changed.',
  );
  process.exitCode = 1;
}
