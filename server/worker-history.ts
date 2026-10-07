import type { Participant, Shift, StaffMember } from '../shared/types.ts';
import { AirtableImportError, AirtableRequestError, readAirtableWorkHistory } from './airtable.ts';
import { Store } from './db.ts';
import { HttpError } from './domain.ts';

export interface WorkHistoryRecord {
  id: string;
  participantAirtableId: string;
  workerAirtableId: string;
  start: string;
  end: string;
}

/** Count each recorded session, excluding a portal booking when a delivered
 * log for the same identities overlaps it. Names are never used as identities. */
export function workTogetherCounts(
  participants: Participant[],
  workers: StaffMember[],
  shifts: Shift[],
  history: WorkHistoryRecord[],
  now = Date.now(),
  excludeShiftId?: string,
): Record<string, Record<string, number>> {
  const people = new Map(
    participants.filter((p) => p.airtableId).map((p) => [p.airtableId!, p.id]),
  );
  const staff = new Map(workers.filter((w) => w.airtableId).map((w) => [w.airtableId!, w.id]));
  const counts: Record<string, Record<string, number>> = {};
  const sessions = new Map<string, Array<{ start: number; end: number }>>();
  const seen = new Set<string>();
  const key = (p: string, w: string) => JSON.stringify([p, w]);
  const add = (p: string, w: string) => {
    counts[p] ??= {};
    counts[p][w] = (counts[p][w] ?? 0) + 1;
  };
  for (const item of history) {
    const p = people.get(item.participantAirtableId),
      w = staff.get(item.workerAirtableId);
    const start = Date.parse(item.start),
      end = Date.parse(item.end);
    if (!p || !w || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now)
      continue;
    const identity = JSON.stringify([p, w, start, end]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const group = key(p, w);
    sessions.set(group, [...(sessions.get(group) ?? []), { start, end }]);
    add(p, w);
  }
  const portalIds = new Set<string>();
  for (const shift of shifts) {
    const start = Date.parse(shift.start),
      end = Date.parse(shift.end);
    if (
      shift.id === excludeShiftId ||
      portalIds.has(shift.id) ||
      shift.status !== 'confirmed' ||
      !shift.staffId ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end > now
    )
      continue;
    portalIds.add(shift.id);
    if (
      sessions
        .get(key(shift.participantId, shift.staffId))
        ?.some((s) => s.start < end && s.end > start)
    )
      continue;
    add(shift.participantId, shift.staffId);
  }
  return counts;
}

export function savedWorkHistory(store: Store): WorkHistoryRecord[] {
  return JSON.parse(store.meta('worker_history_records') || '[]');
}

export function createWorkHistorySync(store: Store, enabled: () => boolean) {
  let inFlight: Promise<void> | null = null;
  let attemptedAt = 0;
  return async function refreshWorkHistory(force = false): Promise<void> {
    if (!enabled()) return;
    if (inFlight) return inFlight;
    if (!force && Date.now() - attemptedAt < 5 * 60_000) return;
    attemptedAt = Date.now();
    inFlight = (async () => {
      try {
        const snapshot = await readAirtableWorkHistory();
        store.transaction(() => {
          store.setMeta('worker_history_records', JSON.stringify(snapshot.records));
          store.setMeta('worker_history_omitted', String(snapshot.omitted));
          store.setMeta('worker_history_checked', new Date().toISOString());
          store.setMeta('worker_history_error', '');
        });
      } catch (error) {
        const message =
          error instanceof AirtableRequestError || error instanceof AirtableImportError
            ? error.message
            : 'Could not refresh work history from Airtable. Previous counts are retained.';
        store.setMeta('worker_history_error', message);
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
