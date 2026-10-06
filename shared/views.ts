import type { Participant, Shift, StaffMember, SupportEvent } from './types';

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
