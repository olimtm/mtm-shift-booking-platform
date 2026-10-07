import 'dotenv/config';
import {
  readConnecteamSchedulers,
  selectConnecteamScheduler,
  ConnecteamError,
} from '../server/connecteam.ts';
import {
  readAirtableConnecteamMappings,
  AirtableImportError,
  AirtableRequestError,
} from '../server/airtable.ts';

// Server-side, read-only: never send API keys to the browser or create/publish shifts.
try {
  const scheduler = selectConnecteamScheduler(await readConnecteamSchedulers());
  const mappings = await readAirtableConnecteamMappings();
  console.log(
    JSON.stringify(
      {
        ok: mappings.issues.length === 0,
        scheduler,
        mappedWorkers: Object.keys(mappings.workers).length,
        mappedParticipants: Object.keys(mappings.participants).length,
        existingShiftLinks: Object.keys(mappings.shifts).length,
        issues: mappings.issues,
        publishingEnabled: false,
        message:
          'Read-only connection and identity check. Existing Connecteam roster entries must be reconciled before publishing is implemented and enabled.',
      },
      null,
      2,
    ),
  );
  if (mappings.issues.length) process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof ConnecteamError ||
      error instanceof AirtableImportError ||
      error instanceof AirtableRequestError
      ? error.message
      : 'Read-only Connecteam check failed. Check server configuration. No records were changed.',
  );
  process.exitCode = 1;
}
