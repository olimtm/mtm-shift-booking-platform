import type { StaffMember } from '../shared/types.ts';
import { AirtableImportError, AirtableRequestError, readAirtableStaff } from './airtable.ts';
import { Store } from './db.ts';
import { HttpError, id } from './domain.ts';

export function createWorkerSync(store: Store, enabled: () => boolean) {
  let inFlight: Promise<void> | null = null;
  let attemptedAt = 0;
  return async function refreshWorkers(force = false): Promise<void> {
    if (!enabled()) return;
    if (inFlight) return inFlight;
    if (!force && Date.now() - attemptedAt < 5 * 60_000) return;
    attemptedAt = Date.now();
    inFlight = (async () => {
      try {
        const snapshot = await readAirtableStaff();
        store.transaction(() => {
          // Resolve identities only by record ID or an explicit migration map.
          // Equal display names never prove two people are the same worker.
          const bound = new Map<string, StaffMember>();
          const current = store.all('staff');
          for (const member of current) {
            const mapped = snapshot.staffRecords[member.id];
            if (mapped && member.airtableId && mapped !== member.airtableId)
              throw new AirtableImportError(
                'An existing worker link conflicts with AIRTABLE_STAFF_RECORD_MAP. The previous worker list is preserved.',
              );
            const externalId = member.airtableId || mapped;
            if (!externalId) continue;
            if (bound.has(externalId))
              throw new AirtableImportError(
                'An Airtable staff record is linked to multiple portal workers. Resolve the duplicate links before refreshing.',
              );
            bound.set(externalId, member);
          }
          for (const [portalId, externalId] of Object.entries(snapshot.staffRecords)) {
            if (bound.has(externalId) && bound.get(externalId)!.id !== portalId)
              throw new AirtableImportError(
                'An Airtable staff record conflicts with its portal identity mapping. The previous worker list is preserved.',
              );
          }
          const incoming = new Map(snapshot.workers.map((worker) => [worker.airtableId, worker]));
          for (const [externalId, member] of bound) {
            if (!incoming.has(externalId))
              store.put('staff', {
                ...member,
                airtableId: externalId,
                active: false,
                airtableManaged: true,
              });
          }
          for (const incomingWorker of snapshot.workers) {
            const member = bound.get(incomingWorker.airtableId);
            // Do not fill the portal with applicants or past employees who have no bookings.
            if (!incomingWorker.active && !member) continue;
            const explicitId = Object.entries(snapshot.staffRecords).find(
              ([, external]) => external === incomingWorker.airtableId,
            )?.[0];
            const name = incomingWorker.name || member!.name;
            const worker: StaffMember = {
              ...member,
              id: member?.id ?? explicitId ?? id('s'),
              name,
              initials: name
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join('')
                .toUpperCase(),
              color: member?.color ?? 'blue',
              airtableId: incomingWorker.airtableId,
              active: incomingWorker.active,
              airtableManaged: true,
            };
            store.put('staff', worker);
          }
          // No shifts, approvals, outbox entries or login grants are changed here.
          store.setMeta('worker_sync_checked', new Date().toISOString());
          store.setMeta('worker_sync_error', '');
        });
      } catch (error) {
        const message =
          error instanceof AirtableRequestError || error instanceof AirtableImportError
            ? error.message
            : 'Could not refresh workers from Airtable. The previous worker list is preserved.';
        store.setMeta('worker_sync_error', message);
        throw new HttpError(502, message);
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
