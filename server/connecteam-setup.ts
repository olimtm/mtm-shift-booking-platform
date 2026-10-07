import { Store } from './db.ts';
import {
  ConnecteamError,
  readConnecteamSchedulers,
  selectConnecteamScheduler,
} from './connecteam.ts';
import {
  AirtableImportError,
  AirtableRequestError,
  readAirtableConnecteamMappings,
} from './airtable.ts';
import { HttpError } from './domain.ts';
import type { ConnecteamSetupStatus } from '../shared/types.ts';

export function createConnecteamSetup(store: Store, enabled: () => boolean) {
  let checking: Promise<ConnecteamSetupStatus> | null = null;
  const configured = () => enabled() && Boolean(process.env.CONNECTEAM_API_KEY?.trim());
  const status = (): ConnecteamSetupStatus => ({
    configured: configured(),
    publishingEnabled: false,
    report: JSON.parse(store.meta('connecteam_setup_report') || 'null'),
    error: store.meta('connecteam_setup_error') || null,
    importReport: JSON.parse(store.meta('connecteam_import_report') || 'null'),
    importError: store.meta('connecteam_import_error') || null,
  });
  async function check(): Promise<ConnecteamSetupStatus> {
    if (!configured())
      throw new HttpError(
        409,
        'Add the Connecteam API key privately in Render before checking the connection.',
      );
    if (checking) return checking;
    checking = (async () => {
      try {
        const scheduler = selectConnecteamScheduler(await readConnecteamSchedulers());
        const mappings = await readAirtableConnecteamMappings();
        const report = {
          checkedAt: new Date().toISOString(),
          scheduler,
          mappedWorkers: Object.keys(mappings.workers).length,
          mappedParticipants: Object.keys(mappings.participants).length,
          existingShiftLinks: Object.keys(mappings.shifts).length,
          issues: mappings.issues,
        };
        store.transaction(() => {
          store.setMeta('connecteam_identity_mappings', JSON.stringify(mappings));
          store.setMeta('connecteam_setup_report', JSON.stringify(report));
          store.setMeta('connecteam_setup_error', '');
        });
        console.log(
          `Connecteam read-only check completed: scheduler ${scheduler.schedulerId}; ${mappings.issues.length} mapping issues; publishing off.`,
        );
        return status();
      } catch (error) {
        const message =
          error instanceof ConnecteamError ||
          error instanceof AirtableImportError ||
          error instanceof AirtableRequestError
            ? error.message
            : 'Could not check the Connecteam connection. No shifts were changed.';
        store.setMeta('connecteam_setup_error', message);
        throw new HttpError(502, message);
      }
    })();
    try {
      return await checking;
    } finally {
      checking = null;
    }
  }
  return { configured, status, check };
}
