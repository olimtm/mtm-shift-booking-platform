import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ConnecteamImportReport, Shift, StaffMember } from '../shared/types.ts';
import { LOCATION_MAX_LENGTH } from '../shared/limits.ts';
import { Store } from './db.ts';
import { backupDatabase } from './backup.ts';
import { id, newShift, HttpError } from './domain.ts';
import {
  readAirtableConnecteamMappings,
  readAirtableStaff,
  AirtableImportError,
  AirtableRequestError,
  type ConnecteamMappings,
  type AirtableStaffSnapshot,
} from './airtable.ts';
import { ConnecteamError } from './connecteam.ts';
import {
  readConnecteamRoster,
  readConnecteamJobNames,
  type ConnecteamRoster,
  type ConnecteamRosterShift,
} from './connecteam-roster.ts';

export interface ImportSnapshot {
  jobNames?: Record<string, string>;
  roster: ConnecteamRoster;
  mappings: ConnecteamMappings;
  workers: AirtableStaffSnapshot;
}
interface Link {
  scheduler_id: number;
  remote_id: string;
  shift_id: string;
}
interface Change {
  before?: Shift;
  after: Shift;
  remote?: ConnecteamRosterShift;
}
export interface ImportPlan {
  report: ConnecteamImportReport;
  changes: Change[];
  workers: StaffMember[];
}
const day = (time: number) =>
  new Date(time).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const equivalent = (a: Shift, b: Shift) =>
  [
    'participantId',
    'staffId',
    'start',
    'end',
    'description',
    'location',
    'status',
    'pendingChange',
    'staffDisplayName',
  ].every((key) => JSON.stringify(a[key as keyof Shift]) === JSON.stringify(b[key as keyof Shift]));

/** Pure reconciliation plan: no writes, name matching, remote publishing or partial commits. */
export function planConnecteamImport(
  store: Store,
  snapshot: ImportSnapshot,
  runId: string,
  now = Date.now(),
): ImportPlan {
  const { roster, mappings } = snapshot;
  if (mappings.issues.length)
    throw new ConnecteamError(
      'Resolve the Airtable identity mapping issues before importing shifts.',
    );
  const originals = store.all('shifts');
  const workers = store.all('staff');
  const participants = store.all('participants');
  const report: ConnecteamImportReport = {
    runId,
    state: 'preview',
    checkedAt: new Date(now).toISOString(),
    scheduler: roster.scheduler.name,
    schedulerId: roster.scheduler.schedulerId,
    total: roster.shifts.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    cancelled: 0,
    past: 0,
    upcoming: 0,
    restoredWorkers: 0,
    assignmentReviews: 0,
    earliest: null,
    latest: null,
    issues: [],
    unmatchedPortal: [],
  };
  const links = store.db
    .prepare('SELECT scheduler_id,remote_id,shift_id FROM connecteam_shift_links')
    .all() as unknown as Link[];
  const bound = new Map<string, string>();
  const linkedPortal = new Set<string>();
  for (const link of links) {
    linkedPortal.add(link.shift_id);
    if (link.scheduler_id === roster.scheduler.schedulerId)
      bound.set(link.remote_id, link.shift_id);
  }
  // Existing Airtable shift links are explicit identities, even when times or workers differ.
  const airtableLinks = store.db
    .prepare('SELECT id,airtable_id FROM shifts WHERE airtable_id IS NOT NULL')
    .all() as { id: string; airtable_id: string }[];
  for (const link of airtableLinks) {
    const remote = mappings.shifts[link.airtable_id];
    if (!remote) continue;
    if (
      (bound.has(remote) && bound.get(remote) !== link.id) ||
      links.some(
        (r) =>
          r.shift_id === link.id &&
          (r.remote_id !== remote || r.scheduler_id !== roster.scheduler.schedulerId),
      )
    )
      throw new ConnecteamError(
        'A saved Connecteam shift link conflicts with an Airtable shift link. No shifts were imported.',
      );
    bound.set(remote, link.id);
    linkedPortal.add(link.id);
  }
  const issues = (remote: ConnecteamRosterShift, reason: string) =>
    report.issues.push({
      remoteId: remote.id,
      title:
        remote.title || (remote.jobId ? snapshot.jobNames?.[remote.jobId] : undefined) || remote.id,
      start: new Date(remote.startTime * 1000).toISOString(),
      reason,
    });
  const stagedWorkers = new Map<string, StaffMember>();
  const candidates: Array<{
    remote: ConnecteamRosterShift;
    participantId: string;
    worker: StaffMember | null;
    options: Shift[];
    rank: number;
  }> = [];
  const inverse = (values: Record<string, string | number>) => {
    const result = new Map<string, string>();
    for (const [external, value] of Object.entries(values)) {
      if (result.has(String(value)))
        throw new ConnecteamError(
          'Duplicate Connecteam identities must be resolved before import.',
        );
      result.set(String(value), external);
    }
    return result;
  };
  const peopleIds = inverse(mappings.participants),
    workerIds = inverse(mappings.workers);
  for (const remote of roster.shifts) {
    const participantAirtableId = remote.jobId ? peopleIds.get(remote.jobId) : undefined;
    const matchingPeople = participants.filter(
      (p) => p.airtableId === participantAirtableId && participantAirtableId,
    );
    if (matchingPeople.length !== 1) {
      const jobName = remote.jobId ? snapshot.jobNames?.[remote.jobId] || '' : '';
      const reason = /\bevents?\b|\bgroup\b/i.test(jobName)
        ? 'Unlinked event/group job; no individual participant identified.'
        : /\badmin\b|\btraining\b|\bmeeting\b|\boffice\b|\bleave\b/i.test(jobName)
          ? 'Unlinked admin/training/office job; no individual participant identified.'
          : !remote.jobId
            ? 'No participant job ID on the Connecteam shift.'
            : 'Job is not linked to an Airtable participant (may be an event, admin or other job).';
      issues(
        remote,
        participantAirtableId ? 'Participant is not uniquely linked in the portal.' : reason,
      );
      continue;
    }
    const person = matchingPeople[0];
    if (remote.assignedUserIds.length > 1) {
      issues(remote, 'More than one assigned worker; this portal booking supports one worker.');
      continue;
    }
    if (remote.title.length > 3000 || remote.location.length > LOCATION_MAX_LENGTH) {
      issues(remote, 'Title or location exceeds the portal field limit.');
      continue;
    }
    let worker: StaffMember | null = null;
    if (remote.assignedUserIds.length) {
      const workerExternal = workerIds.get(String(remote.assignedUserIds[0]));
      const current = workers.filter((w) => w.airtableId === workerExternal && workerExternal);
      const source = snapshot.workers.workers.find((w) => w.airtableId === workerExternal);
      if (!workerExternal || current.length > 1 || (!current.length && !source?.name)) {
        issues(remote, 'Assigned worker is not uniquely linked to an Airtable staff record.');
        continue;
      }
      worker = current[0] ||
        stagedWorkers.get(workerExternal) || {
          id:
            (snapshot.workers.staffRecords &&
              Object.entries(snapshot.workers.staffRecords).find(
                ([, external]) => external === workerExternal,
              )?.[0]) ||
            id('s'),
          airtableId: workerExternal,
          airtableManaged: true,
          active: source!.active,
          name: source!.name,
          initials: source!.name
            .split(/\s+/)
            .slice(0, 2)
            .map((s) => s[0])
            .join('')
            .toUpperCase(),
          color: 'blue',
        };
      if (!current.length) {
        if (workers.some((w) => w.id === worker!.id))
          throw new ConnecteamError(
            'A historical worker identity conflicts with an existing portal worker.',
          );
        stagedWorkers.set(workerExternal, worker);
      }
    }
    const explicitId = bound.get(remote.id);
    let options: Shift[] = [];
    let rank = 0;
    if (explicitId) {
      const old = originals.find((s) => s.id === explicitId);
      if (!old)
        throw new ConnecteamError('A saved Connecteam link refers to a missing portal shift.');
      if (old.participantId !== person.id) {
        issues(
          remote,
          'Saved shift link belongs to a different participant; review to protect linked RSVPs and family reports.',
        );
        continue;
      }
      options = [old];
    } else {
      rank = 1;
      const eligible = originals.filter(
        (s) => s.participantId === person.id && !linkedPortal.has(s.id),
      );
      options = eligible.filter(
        (s) =>
          Date.parse(s.start) === remote.startTime * 1000 &&
          Date.parse(s.end) === remote.endTime * 1000,
      );
      if (!options.length) {
        rank = 2;
        options = eligible.filter(
          (s) =>
            Date.parse(s.start) < remote.endTime * 1000 &&
            Date.parse(s.end) > remote.startTime * 1000,
        );
      }
      if (!options.length) {
        rank = 3;
        options = eligible.filter(
          (s) =>
            day(Date.parse(s.start)) === day(remote.startTime * 1000) &&
            (s.description.trim().toLowerCase() === remote.title.toLowerCase() ||
              Boolean(worker && s.staffId === worker.id)),
        );
      }
    }
    candidates.push({
      remote,
      participantId: person.id,
      worker,
      options,
      rank,
    });
  }
  // Do not let iteration order decide which of two shifts consumes an old booking.
  const bestRank = new Map<string, number>();
  for (const row of candidates)
    for (const old of row.options)
      bestRank.set(old.id, Math.min(bestRank.get(old.id) ?? Infinity, row.rank));
  for (const row of candidates)
    row.options = row.options.filter((old) => bestRank.get(old.id) === row.rank);
  const uses = new Map<string, number>();
  for (const row of candidates)
    for (const old of row.options) uses.set(old.id, (uses.get(old.id) || 0) + 1);
  const changes: Change[] = [];
  const consumed = new Set<string>();
  const usedWorkers = new Set<string>();
  for (const row of candidates) {
    if (row.options.length > 1 || row.options.some((s) => uses.get(s.id)! > 1)) {
      issues(
        row.remote,
        'Multiple possible matches with portal bookings; no automatic merge was made.',
      );
      continue;
    }
    const before = row.options[0];
    const assignmentReview = row.remote.rejectedUserIds.some((user) =>
      row.remote.assignedUserIds.includes(user),
    );
    if (assignmentReview) {
      report.assignmentReviews++;
      report.issues.push({
        remoteId: row.remote.id,
        title: row.remote.title,
        start: new Date(row.remote.startTime * 1000).toISOString(),
        imported: true,
        reason:
          'Imported as requested: the worker rejected or unclaimed the Connecteam assignment. Review before confirming.',
      });
    }
    const title = row.remote.title || before?.description || '1:1 support';
    const after = {
      ...(before ||
        newShift(
          {
            participantId: row.participantId,
            start: '',
            end: '',
            description: title,
            location: '',
            driving: 'no_preference',
            gender: 'no_preference',
            notes: '',
            kind: 'general',
          },
          'staff',
          false,
        )),
      start: new Date(row.remote.startTime * 1000).toISOString(),
      end: new Date(row.remote.endTime * 1000).toISOString(),
      description: title,
      location: row.remote.location,
      staffId: row.worker?.id || null,
      staffDisplayName: undefined,
      status:
        row.remote.isPublished && !assignmentReview
          ? ('confirmed' as const)
          : ('requested' as const),
      pendingChange: null,
      syncStatus: 'imported' as const,
      updatedAt: new Date(
        Math.max(now, before ? Date.parse(before.updatedAt) + 1 : now),
      ).toISOString(),
    };
    if (before) {
      consumed.add(before.id);
      if (equivalent(before, after)) report.unchanged++;
      else report.updated++;
    } else report.created++;
    if (row.worker) usedWorkers.add(row.worker.id);
    if (row.remote.endTime * 1000 <= now) report.past++;
    else report.upcoming++;
    if (!report.earliest || after.start < report.earliest) report.earliest = after.start;
    if (!report.latest || after.end > report.latest) report.latest = after.end;
    changes.push({ before, after, remote: row.remote });
  }
  const remoteIds = new Set(roster.shifts.map((s) => s.id));
  for (const [remoteId, portalId] of bound) {
    if (remoteIds.has(remoteId)) continue;
    const before = originals.find((s) => s.id === portalId)!;
    if (
      !before ||
      Date.parse(before.start) < roster.from * 1000 ||
      Date.parse(before.end) > roster.through * 1000
    )
      continue;
    consumed.add(before.id);
    if (before.status === 'cancelled' && !before.pendingChange) continue;
    changes.push({
      before,
      after: {
        ...before,
        status: 'cancelled',
        pendingChange: null,
        syncStatus: 'imported',
        updatedAt: new Date(Math.max(now, Date.parse(before.updatedAt) + 1)).toISOString(),
      },
    });
    report.cancelled++;
  }
  report.unmatchedPortal = originals
    .filter((s) => !consumed.has(s.id) && !['cancelled', 'declined'].includes(s.status))
    .map((s) => ({ id: s.id, description: s.description, start: s.start }));
  const restoredWorkers = [...stagedWorkers.values()].filter((w) => usedWorkers.has(w.id));
  report.restoredWorkers = restoredWorkers.length;
  return { report, changes, workers: restoredWorkers };
}

function portalFingerprint(store: Store) {
  const tables = [
    'participants',
    'staff',
    'shifts',
    'rsvps',
    'outbox',
    'shift_updates',
    'connecteam_shift_links',
  ];
  const snapshot = tables.map((table) =>
    store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
async function readSnapshot(): Promise<ImportSnapshot> {
  const roster = await readConnecteamRoster();
  const mappings = await readAirtableConnecteamMappings();
  const workers = await readAirtableStaff();
  const jobNames = await readConnecteamJobNames(roster.scheduler.schedulerId);
  return { roster, mappings, workers, jobNames };
}

export function createConnecteamImport(
  store: Store,
  options: {
    databasePath: string;
    enabled: () => boolean;
    read?: () => Promise<ImportSnapshot>;
    backup?: (destination: string) => Promise<void>;
  },
) {
  let running = false;
  const status = (): ConnecteamImportReport | null =>
    JSON.parse(store.meta('connecteam_import_report') || 'null');
  async function run(mode: 'preview' | 'apply', runId: string) {
    if (!options.enabled())
      throw new HttpError(409, 'Connecteam import is unavailable in this workspace.');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId))
      throw new HttpError(400, 'Choose a valid one-off import run ID.');
    if (store.meta('connecteam_import_completed')) return status();
    if (running) throw new HttpError(409, 'The one-off Connecteam import is already running.');
    running = true;
    try {
      const snapshot = await (options.read || readSnapshot)();
      const plan = planConnecteamImport(store, snapshot, runId);
      if (mode === 'preview') {
        store.setMeta('connecteam_import_report', JSON.stringify(plan.report));
        store.setMeta('connecteam_import_preview', JSON.stringify(snapshot));
        store.setMeta('connecteam_import_error', '');
        return plan.report;
      }
      // A full on-disk backup and per-row audit are both required before any imported edits.
      const fingerprint = portalFingerprint(store);
      const backupDir = join(dirname(options.databasePath), 'backups');
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const backupPath = join(backupDir, `before-connecteam-${runId}-${id('backup')}.sqlite`);
      if (options.backup) await options.backup(backupPath);
      else {
        if (options.databasePath === ':memory:')
          throw new ConnecteamError(
            'A persistent database backup is required before applying an import.',
          );
        await backupDatabase(options.databasePath, backupPath);
      }
      if (portalFingerprint(store) !== fingerprint)
        throw new ConnecteamError(
          'Portal records changed during the backup. Retry the import using the latest data.',
        );
      store.transaction(() => {
        const audit = plan.changes.map((change) => ({
          ...change,
          outbox:
            store.db.prepare('SELECT * FROM outbox WHERE shift_id=?').get(change.after.id) || null,
        }));
        store.setMeta(
          `connecteam_import_audit:${runId}`,
          JSON.stringify({ backupPath, snapshot, audit, workers: plan.workers }),
        );
        for (const worker of plan.workers) store.put('staff', worker);
        for (const change of plan.changes) {
          store.put('shifts', change.after);
          store.db.prepare('DELETE FROM outbox WHERE shift_id=?').run(change.after.id);
          if (change.remote)
            store.db
              .prepare(
                `INSERT INTO connecteam_shift_links(scheduler_id,remote_id,shift_id,source_json,imported_at) VALUES(?,?,?,?,?) ON CONFLICT(scheduler_id,remote_id) DO UPDATE SET source_json=excluded.source_json,imported_at=excluded.imported_at`,
              )
              .run(
                snapshot.roster.scheduler.schedulerId,
                change.remote.id,
                change.after.id,
                JSON.stringify(change.remote),
                plan.report.checkedAt,
              );
        }
        plan.report.state = 'completed';
        store.setMeta('connecteam_import_report', JSON.stringify(plan.report));
        store.setMeta('connecteam_import_completed', runId);
        store.setMeta('connecteam_import_error', '');
      });
      return plan.report;
    } catch (error) {
      const message =
        error instanceof ConnecteamError ||
        error instanceof AirtableImportError ||
        error instanceof AirtableRequestError ||
        error instanceof HttpError
          ? error.message
          : 'Connecteam import failed. No shift changes were committed; the previous portal records are retained.';
      store.setMeta('connecteam_import_error', message);
      throw new HttpError(502, message);
    } finally {
      running = false;
    }
  }
  return { run, status, isRunning: () => running };
}
