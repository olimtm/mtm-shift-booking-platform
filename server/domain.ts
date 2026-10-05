import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import type { Shift, ShiftInput, Rsvp, SupportEvent, Participant } from '../shared/types.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export function saveShift(store: Store, shift: Shift, configured: boolean): Shift {
  const old = store.get('shifts', shift.id);
  shift.updatedAt = new Date(
    Math.max(Date.now(), old ? Date.parse(old.updatedAt) + 1 : 0),
  ).toISOString();
  shift.syncStatus = configured ? 'pending' : 'not_configured';
  store.put('shifts', shift);
  store.db
    .prepare(
      'INSERT INTO outbox(shift_id,version) VALUES(?,?) ON CONFLICT(shift_id) DO UPDATE SET version=excluded.version,attempts=0,last_error=NULL,next_attempt=0',
    )
    .run(shift.id, shift.updatedAt);
  return shift;
}
export function newShift(
  input: ShiftInput,
  source: Shift['source'],
  configured: boolean,
  options: Partial<Shift> = {},
): Shift {
  const now = new Date().toISOString();
  return {
    ...input,
    id: id('shift'),
    status: 'requested',
    staffId: null,
    source,
    eventId: null,
    pendingChange: null,
    syncStatus: configured ? 'pending' : 'not_configured',
    createdAt: now,
    updatedAt: now,
    ...options,
  };
}
interface RsvpRow {
  id: string;
  event_id: string;
  participant_id: string;
  status: Rsvp['status'];
  shift_id: string | null;
  external_id: string | null;
}
export function allRsvps(store: Store): Rsvp[] {
  return (store.db.prepare('SELECT * FROM rsvps').all() as unknown as RsvpRow[]).map((r) => ({
    id: r.id,
    eventId: r.event_id,
    participantId: r.participant_id,
    status: r.status,
    shiftId: r.shift_id,
  }));
}
export function eventShiftInput(event: SupportEvent, participant: Participant): ShiftInput {
  return {
    participantId: participant.id,
    start: new Date(Date.parse(event.start) - 30 * 60_000).toISOString(),
    end: new Date(Date.parse(event.end) + 30 * 60_000).toISOString(),
    description: `Support for ${event.title}`,
    location: event.location,
    driving: 'no_preference',
    gender: 'no_preference',
    notes: 'Includes 30 minutes of support before and after the event.',
    kind: 'event',
  };
}
export function upsertRsvp(
  store: Store,
  event: SupportEvent,
  participant: Participant,
  status: Rsvp['status'],
  configured: boolean,
  externalId?: string,
  eventChanged = false,
): { rsvp: Rsvp; shift: Shift | null } {
  const prior = store.db
    .prepare('SELECT * FROM rsvps WHERE event_id=? AND participant_id=?')
    .get(event.id, participant.id) as unknown as RsvpRow | undefined;
  if (externalId) {
    const mapped = store.db
      .prepare('SELECT event_id,participant_id FROM rsvps WHERE external_id=?')
      .get(externalId) as { event_id: string; participant_id: string } | undefined;
    if (mapped && (mapped.event_id !== event.id || mapped.participant_id !== participant.id))
      fail(409, 'This RSVP identifier is already linked to another participant or event.');
  }
  const existingPair = store.db
    .prepare('SELECT id FROM shifts WHERE event_id=? AND participant_id=?')
    .get(event.id, participant.id) as { id: string } | undefined;
  let shift = prior?.shift_id
    ? store.get('shifts', prior.shift_id)
    : existingPair
      ? store.get('shifts', existingPair.id)
      : undefined;
  const eligible = participant.supportType === 'events' || participant.supportType === 'both';
  if (
    status === 'attending' &&
    eligible &&
    (prior?.status === 'cancelled' || !shift || eventChanged)
  ) {
    const input = eventShiftInput(event, participant);
    if (!shift)
      shift = saveShift(
        store,
        newShift(input, 'event', configured, { eventId: event.id }),
        configured,
      );
    else if (
      (shift.status === 'cancelled' || shift.status === 'declined') &&
      prior?.status === 'cancelled'
    ) {
      shift = saveShift(
        store,
        {
          ...shift,
          ...input,
          status: 'requested',
          staffId: null,
          staffDisplayName: undefined,
          pendingChange: null,
        },
        configured,
      );
    } else if (shift.status === 'confirmed') {
      const timeChanged = ['start', 'end', 'description', 'location'].some(
        (key) => shift![key as keyof Shift] !== input[key as keyof ShiftInput],
      );
      if (timeChanged) {
        const values: ShiftInput = {
          ...input,
          driving: shift.driving,
          gender: shift.gender,
          notes: shift.notes,
        };
        if (
          shift.pendingChange?.type !== 'edit' ||
          JSON.stringify(shift.pendingChange.values) !== JSON.stringify(values)
        )
          shift = saveShift(
            store,
            {
              ...shift,
              pendingChange: { type: 'edit', values, requestedAt: new Date().toISOString() },
            },
            configured,
          );
      } else if (
        prior?.status === 'cancelled' &&
        shift.pendingChange?.type === 'cancel' &&
        shift.pendingChange.reason === 'Event RSVP cancelled.'
      )
        shift = saveShift(store, { ...shift, pendingChange: null }, configured);
    } else if (shift.status === 'requested') {
      const changed = ['start', 'end', 'description', 'location'].some(
        (key) => shift![key as keyof Shift] !== input[key as keyof ShiftInput],
      );
      if (changed || shift.pendingChange?.type === 'cancel')
        shift = saveShift(store, { ...shift, ...input, pendingChange: null }, configured);
    }
  } else if (
    status === 'cancelled' &&
    prior?.status !== 'cancelled' &&
    shift &&
    shift.status !== 'cancelled' &&
    shift.status !== 'declined'
  ) {
    if (shift.status === 'confirmed') {
      if (shift.pendingChange?.type !== 'cancel')
        shift = saveShift(
          store,
          {
            ...shift,
            pendingChange: {
              type: 'cancel',
              reason: 'Event RSVP cancelled.',
              requestedAt: new Date().toISOString(),
            },
          },
          configured,
        );
    } else
      shift = saveShift(store, { ...shift, status: 'cancelled', pendingChange: null }, configured);
  }
  const rsvp: Rsvp = {
    id: prior?.id ?? id('rsvp'),
    eventId: event.id,
    participantId: participant.id,
    status,
    shiftId: shift?.id ?? null,
  };
  store.db
    .prepare(
      'INSERT INTO rsvps(id,event_id,participant_id,status,shift_id,external_id) VALUES(?,?,?,?,?,?) ON CONFLICT(event_id,participant_id) DO UPDATE SET status=excluded.status,shift_id=excluded.shift_id,external_id=COALESCE(excluded.external_id,rsvps.external_id)',
    )
    .run(rsvp.id, rsvp.eventId, rsvp.participantId, rsvp.status, rsvp.shiftId, externalId ?? null);
  return { rsvp, shift: shift ?? null };
}
export function assertStaffAvailable(store: Store, shift: Shift, staffId: string | null) {
  if (!staffId) return;
  if (!store.get('staff', staffId)) fail(400, 'Select an existing staff member.');
  const conflict = store
    .all('shifts')
    .some(
      (other) =>
        other.id !== shift.id &&
        other.status === 'confirmed' &&
        other.staffId === staffId &&
        Date.parse(other.start) < Date.parse(shift.end) &&
        Date.parse(other.end) > Date.parse(shift.start),
    );
  if (conflict) fail(409, 'This staff member already has a confirmed shift at that time.');
}
