import type { Participant, Shift, StaffMember, SupportEvent } from './types';

export const DEFAULT_WORKER_STATUSES = [
  'Active',
  'Active - Volunteer',
  'Pending Superannuation Xero Input',
];

export function rankedWorkers(workers: StaffMember[], counts: Record<string, number> = {}) {
  return workers
    .filter(isActiveWorker)
    .map((worker) => ({ worker, count: counts[worker.id] ?? 0 }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.worker.name.localeCompare(b.worker.name, 'en-AU', { sensitivity: 'base' }) ||
        a.worker.id.localeCompare(b.worker.id),
    );
}

// Keep legacy/local workers usable until their first successful roster refresh.
export function isActiveWorker(worker: StaffMember): boolean {
  return worker.active !== false;
}

// Keep inactive identities in the database so historical bookings retain their names.
export function isActiveParticipant(person: Participant): boolean {
  return person.airtableId ? person.active === true : person.active !== false;
}
export function isPastSupport(shift: Shift, now = Date.now()): boolean {
  return (
    Date.parse(shift.end) <= now || shift.status === 'cancelled' || shift.status === 'declined'
  );
}
export function shiftTitle(shift: Shift, events: SupportEvent[]): string {
  return (
    events.find((event) => event.id === shift.eventId)?.title ||
    shift.description ||
    (shift.kind === 'event' ? 'Event support — event not linked' : 'General support')
  );
}
