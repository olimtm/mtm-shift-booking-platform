import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../db.ts';
import { newShift, saveShift } from '../domain.ts';
import {
  createConnecteamImport,
  planConnecteamImport,
  type ImportSnapshot,
} from '../connecteam-import.ts';
import {
  readConnecteamRoster,
  readConnecteamJobNames,
  ROSTER_FROM,
  ROSTER_THROUGH,
  type ConnecteamRosterShift,
} from '../connecteam-roster.ts';
import type { Shift } from '../../shared/types.ts';

const now = Date.parse('2026-10-07T00:00:00Z');
const start = Date.parse('2026-09-03T02:00:00Z') / 1000;
const remote = (
  id: string,
  changes: Partial<ConnecteamRosterShift> = {},
): ConnecteamRosterShift => ({
  id,
  jobId: 'job-a',
  title: 'Support from Connecteam',
  startTime: start,
  endTime: start + 3600,
  assignedUserIds: [77],
  isPublished: true,
  isOpenShift: false,
  location: 'Connecteam venue',
  rejectedUserIds: [],
  ...changes,
});
const snapshot = (shifts: ConnecteamRosterShift[]): ImportSnapshot => ({
  roster: {
    scheduler: { schedulerId: 123, name: 'NSW', isArchived: false },
    checkedAt: new Date(now).toISOString(),
    from: ROSTER_FROM,
    through: ROSTER_THROUGH,
    shifts,
  },
  mappings: {
    participants: { recPerson: 'job-a' },
    workers: { recWorker: 77, recFormerWorker: 88 },
    shifts: {},
    issues: [],
  },
  workers: {
    staffRecords: {},
    workers: [
      { airtableId: 'recWorker', name: 'Current worker', active: true },
      { airtableId: 'recFormerWorker', name: 'Former worker', active: false },
    ],
  },
});
function seed(store: Store) {
  store.put('participants', {
    id: 'p',
    airtableId: 'recPerson',
    name: 'Person',
    initials: 'P',
    color: 'blue',
    active: true,
    supportType: 'both',
    notes: 'Private coordinator information',
  });
  store.put('staff', {
    id: 'w',
    airtableId: 'recWorker',
    name: 'Current worker',
    initials: 'CW',
    color: 'blue',
    active: true,
  });
}
const booking = (id: string, changes: Partial<Shift> = {}) =>
  newShift(
    {
      participantId: 'p',
      start: new Date(start * 1000).toISOString(),
      end: new Date((start + 3600) * 1000).toISOString(),
      description: 'Old portal booking',
      location: 'Old location',
      notes: 'Preserve family booking notes',
      driving: 'required',
      gender: 'female',
      kind: 'general',
    },
    'staff',
    false,
    { id, staffId: 'w', status: 'confirmed', ...changes },
  );
const env = { CONNECTEAM_API_KEY: 'fictional-private-key' };
const apiRow = (id: string) => ({
  ...remote(id),
  locationData: { gps: { address: 'A venue' } },
  statuses: [],
  notes: [{ html: 'PRIVATE STAFF NOTE' }],
});

test('reads every roster page over the full date range using GET only and never includes private staff notes', async (t) => {
  const offsets: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, 'GET');
    if (!url.includes('/shifts?'))
      return Response.json({
        data: { schedulers: [{ schedulerId: 123, name: 'NSW', isArchived: false }] },
      });
    const query = new URL(url).searchParams;
    assert.equal(query.get('startTime'), String(ROSTER_FROM));
    assert.equal(query.get('endTime'), String(ROSTER_THROUGH));
    assert.equal(query.has('isPublished'), false);
    const offset = query.get('offset')!;
    offsets.push(offset);
    return Response.json(
      offset === '0'
        ? {
            data: { shifts: Array.from({ length: 500 }, (_, i) => apiRow('r' + i)) },
            paging: { offset: 500 },
          }
        : { data: { shifts: [apiRow('r500')] } },
    );
  });
  const result = await readConnecteamRoster(env);
  assert.equal(result.shifts.length, 501);
  assert.deepEqual(offsets, ['0', '500']);
  assert(!JSON.stringify(result).includes('PRIVATE STAFF NOTE'));
  assert.equal(result.shifts[0].location, 'A venue');
});

test('fails closed on repeated pages, malformed records and API failures without exposing the response', async (t) => {
  let scenario = 'duplicate';
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.includes('/shifts?'))
      return Response.json({
        data: { schedulers: [{ schedulerId: 123, name: 'NSW', isArchived: false }] },
      });
    if (scenario === 'failure') return new Response('PRIVATE API VALUE', { status: 401 });
    if (scenario === 'date')
      return Response.json({ data: { shifts: [{ ...apiRow('r'), endTime: 10 }] } });
    if (scenario === 'offset')
      return Response.json({ data: { shifts: [apiRow('r')] }, paging: { offset: 0 } });
    return Response.json({ data: { shifts: [apiRow('r'), apiRow('r')] } });
  });
  await assert.rejects(readConnecteamRoster(env), /repeated shift/);
  scenario = 'date';
  await assert.rejects(readConnecteamRoster(env), /invalid/);
  scenario = 'offset';
  await assert.rejects(readConnecteamRoster(env), /pagination/);
  scenario = 'failure';
  await assert.rejects(
    readConnecteamRoster(env),
    (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes('PRIVATE'),
  );
});

test('date-range limits split the scan into complete adjacent windows without duplicating overnight shifts', async (t) => {
  const begin = Date.parse('2098-12-31T13:00:00Z') / 1000;
  const boundary = begin + (ROSTER_THROUGH - begin) / 4;
  const shift = { ...apiRow('overnight'), startTime: boundary - 3600, endTime: boundary + 3600 };
  const windows: Array<[number, number]> = [];
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((
    callback: (...args: unknown[]) => void,
    _ms: number,
    ...args: unknown[]
  ) => timeout(callback, 0, ...args)) as typeof setTimeout);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.includes('/shifts?'))
      return Response.json({
        data: { schedulers: [{ schedulerId: 123, name: 'NSW', isArchived: false }] },
      });
    const query = new URL(url).searchParams;
    const from = Number(query.get('startTime')),
      through = Number(query.get('endTime'));
    if (through - from > 180 * 86400)
      return Response.json(
        { detail: 'Maximum date range is 180 days. PRIVATE MESSAGE fictional-private-key' },
        { status: 400 },
      );
    windows.push([from, through]);
    return Response.json({
      data: { shifts: shift.startTime < through && shift.endTime > from ? [shift] : [] },
    });
  });
  const result = await readConnecteamRoster({ ...env, CONNECTEAM_IMPORT_START_DATE: '2099-01-01' });
  assert.equal(result.shifts.length, 1);
  assert.equal(windows.length, 4);
  assert.equal(windows[0][0], begin);
  assert.equal(windows.at(-1)![1], ROSTER_THROUGH);
  windows.slice(1).forEach((window, i) => assert.equal(window[0], windows[i][1]));
});

test('starts the import at Sydney midnight, including early morning shifts on the first day', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.includes('/shifts?'))
      return Response.json({
        data: { schedulers: [{ schedulerId: 123, name: 'NSW', isArchived: false }] },
      });
    assert.equal(
      new URL(url).searchParams.get('startTime'),
      String(Date.parse('2026-01-31T13:00:00Z') / 1000),
    );
    return Response.json({ data: { shifts: [] } });
  });
  await readConnecteamRoster({ ...env, CONNECTEAM_IMPORT_START_DATE: '2026-02-01' });
  await assert.rejects(
    readConnecteamRoster({ ...env, CONNECTEAM_IMPORT_START_DATE: '2026-02-30' }),
    /valid YYYY-MM-DD/,
  );
});

test('Connecteam wins matched dates, worker, title, location and status while retaining booking preferences, notes and event identity', () => {
  const store = new Store(':memory:');
  seed(store);
  const old = booking('old', {
    eventId: 'event',
    kind: 'event',
    pendingChange: {
      type: 'cancel',
      reason: 'Old request',
      requestedAt: new Date(now).toISOString(),
    },
  });
  store.put('shifts', old);
  store.db.prepare('UPDATE shifts SET airtable_id=? WHERE id=?').run('recOld', old.id);
  const input = snapshot([
    remote('r', { startTime: start + 86400, endTime: start + 90000, assignedUserIds: [88] }),
  ]);
  input.mappings.shifts.recOld = 'r';
  const plan = planConnecteamImport(store, input, 'run', now);
  assert.equal(plan.report.updated, 1);
  assert.equal(plan.report.created, 0);
  const after = plan.changes[0].after;
  assert.equal(after.id, old.id);
  assert.equal(after.start, new Date((start + 86400) * 1000).toISOString());
  assert.equal(after.description, 'Support from Connecteam');
  assert.equal(after.location, 'Connecteam venue');
  assert.equal(after.pendingChange, null);
  assert.equal(after.eventId, 'event');
  assert.equal(after.notes, old.notes);
  assert.equal(after.driving, 'required');
  assert.equal(after.gender, 'female');
  assert.equal(plan.workers[0].active, false);
  assert.equal(after.staffId, plan.workers[0].id);
  assert.deepEqual(store.get('shifts', 'old'), old, 'planning must not mutate the portal');
  store.close();
});

test('matches exact/overlapping shifts independently of assignment, favours stronger matches, and reports genuine ambiguity', () => {
  const store = new Store(':memory:');
  seed(store);
  store.put('shifts', booking('old', { staffId: null, status: 'requested' }));
  let plan = planConnecteamImport(
    store,
    snapshot([
      remote('exact'),
      remote('later', { startTime: start + 7200, endTime: start + 10800 }),
    ]),
    'run',
    now,
  );
  assert.equal(plan.report.updated, 1);
  assert.equal(plan.report.created, 1);
  assert.equal(plan.report.issues.length, 0);
  plan = planConnecteamImport(
    store,
    snapshot([remote('overlap', { startTime: start + 600, endTime: start + 4200 })]),
    'run',
    now,
  );
  assert.equal(plan.report.updated, 1);
  plan = planConnecteamImport(store, snapshot([remote('same1'), remote('same2')]), 'run', now);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.report.issues.length, 2);
  assert.equal(plan.report.unmatchedPortal.length, 1);
  store.close();
});

test('reports unmapped jobs and multiple workers, while retaining rejected assignments as requests needing review', () => {
  const store = new Store(':memory:');
  seed(store);
  const plan = planConnecteamImport(
    store,
    snapshot([
      remote('other', { jobId: 'not-a-participant' }),
      remote('unknown-worker', { assignedUserIds: [999] }),
      remote('group', { assignedUserIds: [77, 88] }),
      remote('rejected', { rejectedUserIds: [77] }),
      remote('draft', { isPublished: false, assignedUserIds: [] }),
    ]),
    'run',
    now,
  );
  assert.equal(plan.report.created, 2);
  assert.equal(plan.report.issues.length, 4);
  assert.equal(plan.report.assignmentReviews, 1);
  assert.equal(plan.report.issues.filter((issue) => issue.imported).length, 1);
  assert.equal(
    plan.changes.find((change) => change.remote?.id === 'rejected')?.after.status,
    'requested',
  );
  assert.equal(plan.changes.find((change) => change.remote?.id === 'draft')?.after.staffId, null);
  const input = snapshot([]);
  input.mappings.participants.recOther = 'job-a';
  assert.throws(() => planConnecteamImport(store, input, 'run'), /Duplicate/);
  store.close();
});

test('job lookup reads deleted jobs and sub-jobs for report labels without using names to link participants', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET');
    assert.equal(new URL(url).searchParams.get('includeDeleted'), 'true');
    return Response.json({
      data: {
        jobs: [
          {
            jobId: 'events',
            title: 'NSW Events',
            subJobs: [{ jobId: 'admin', title: 'Office admin' }],
          },
        ],
      },
    });
  });
  const labels = await readConnecteamJobNames(123, env);
  assert.deepEqual(labels, { events: 'NSW Events', admin: 'Office admin' });
  const store = new Store(':memory:');
  seed(store);
  const input = snapshot([remote('r', { jobId: 'events' }), remote('a', { jobId: 'admin' })]);
  input.jobNames = labels;
  const plan = planConnecteamImport(store, input, 'run', now);
  assert.equal(plan.changes.length, 0);
  assert.match(plan.report.issues[0].reason, /event\/group/);
  assert.match(plan.report.issues[1].reason, /admin\/training/);
  store.close();
});

test('only cancels definitely linked shifts absent from the complete roster, preserving portal-only requests', () => {
  const store = new Store(':memory:');
  seed(store);
  for (const id of ['linked', 'local', 'other-scheduler']) store.put('shifts', booking(id));
  store.db
    .prepare('INSERT INTO connecteam_shift_links VALUES(?,?,?,?,?)')
    .run(123, 'gone', 'linked', '{}', 'before');
  store.db
    .prepare('INSERT INTO connecteam_shift_links VALUES(?,?,?,?,?)')
    .run(456, 'other', 'other-scheduler', '{}', 'before');
  const plan = planConnecteamImport(store, snapshot([]), 'run', now);
  assert.equal(plan.report.cancelled, 1);
  assert.equal(plan.changes[0].after.status, 'cancelled');
  assert.deepEqual(plan.report.unmatchedPortal.map((s) => s.id).sort(), [
    'local',
    'other-scheduler',
  ]);
  store.close();
});

test('applying backs up the WAL database, preserves audit/outbox evidence, saves stable links and never repeats after restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mtm-ct-import-'));
  const path = join(folder, 'portal.sqlite');
  let store = new Store(path);
  seed(store);
  const old = booking('old');
  saveShift(store, old, true);
  const input = snapshot([
    remote('r'),
    remote('history', { startTime: start - 86400, endTime: start - 82800, assignedUserIds: [88] }),
  ]);
  let reads = 0;
  const importer = createConnecteamImport(store, {
    databasePath: path,
    enabled: () => true,
    read: async () => {
      reads++;
      return input;
    },
  });
  try {
    const preview = await importer.run('preview', 'oneoff');
    assert.equal(preview?.state, 'preview');
    assert.equal(store.all('shifts').length, 1);
    const result = await importer.run('apply', 'oneoff');
    assert.equal(result?.created, 1);
    assert.equal(result?.updated, 1);
    assert.equal(result?.state, 'completed');
    assert.equal(store.all('shifts').length, 2);
    assert.equal(store.all('staff').length, 2);
    assert.equal(store.get('shifts', 'old')?.syncStatus, 'imported');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM connecteam_shift_links').get()!.n, 2);
    const audit = JSON.parse(store.meta('connecteam_import_audit:oneoff')!);
    assert.equal(audit.audit[0].before.description, old.description);
    assert.equal(audit.audit[0].outbox.shift_id, 'old');
    const backup = new Store(join(folder, 'backups', readdirSync(join(folder, 'backups'))[0]));
    assert.equal(backup.get('shifts', 'old')?.description, old.description);
    assert.equal(backup.all('shifts').length, 1);
    backup.close();
    store.close();
    store = new Store(path);
    await createConnecteamImport(store, {
      databasePath: path,
      enabled: () => true,
      read: async () => {
        throw new Error('must not read on restart');
      },
    }).run('apply', 'oneoff');
    assert.equal(reads, 2);
    assert.equal(store.all('shifts').length, 2);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('failed backup or concurrent edits cannot partially overwrite portal records', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mtm-ct-failure-'));
  const store = new Store(join(folder, 'portal.sqlite'));
  seed(store);
  const old = booking('old');
  store.put('shifts', old);
  try {
    const input = snapshot([remote('r')]);
    const first = createConnecteamImport(store, {
      databasePath: join(folder, 'portal.sqlite'),
      enabled: () => true,
      read: async () => input,
      backup: async () => {
        throw new Error('disk failed');
      },
    });
    await assert.rejects(first.run('apply', 'failure'), /No shift changes/);
    assert.deepEqual(store.get('shifts', 'old'), old);
    assert.equal(store.meta('connecteam_import_completed'), undefined);
    const second = createConnecteamImport(store, {
      databasePath: join(folder, 'portal.sqlite'),
      enabled: () => true,
      read: async () => input,
      backup: async () => {
        store.put('shifts', { ...old, notes: 'A concurrent edit' });
      },
    });
    await assert.rejects(second.run('apply', 'concurrent'), /changed during the backup/);
    assert.equal(store.get('shifts', 'old')?.notes, 'A concurrent edit');
    assert.equal(store.get('shifts', 'old')?.description, old.description);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM connecteam_shift_links').get()!.n, 0);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('transaction failure rolls back every imported row and leaves no completion marker', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'mtm-ct-rollback-'));
  const store = new Store(join(folder, 'portal.sqlite'));
  seed(store);
  const old = booking('old');
  store.put('shifts', old);
  const original = store.put.bind(store);
  let calls = 0;
  t.mock.method(store, 'put', ((table: string, entity: never) => {
    if (++calls === 2) throw new Error('injected database failure');
    return original(table as 'shifts', entity);
  }) as typeof store.put);
  try {
    const input = snapshot([
      remote('r'),
      remote('other', { startTime: start - 86400, endTime: start - 82800 }),
    ]);
    const importer = createConnecteamImport(store, {
      databasePath: join(folder, 'portal.sqlite'),
      enabled: () => true,
      read: async () => input,
    });
    await assert.rejects(importer.run('apply', 'rollback'), /No shift changes/);
    assert.deepEqual(store.all('shifts'), [old]);
    assert.equal(store.meta('connecteam_import_completed'), undefined);
    assert.equal(store.meta('connecteam_import_audit:rollback'), undefined);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
