import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readAirtableStaff } from '../airtable.ts';
import { createApp } from '../app.ts';
import { newShift } from '../domain.ts';

const staffId = (n: number) => `rec${String(n).padStart(14, '0')}`;
const row = (n: number, name: string, status: string, archived = false) => ({
  id: staffId(n),
  fields: { Name: name, Status: status, Archived: archived },
});
const schema = () => ({
  tables: [
    {
      id: 'tblStaff',
      name: 'Staff',
      fields: [
        {
          id: 'fldName',
          name: 'Name',
          type: 'formula',
          options: { result: { type: 'singleLineText' } },
        },
        {
          id: 'fldStatus',
          name: 'Status',
          type: 'singleSelect',
          options: {
            choices: [
              'Active',
              'Active - Volunteer',
              'Pending Superannuation Xero Input',
              'Inactive',
            ].map((name) => ({ name })),
          },
        },
        { id: 'fldArchived', name: 'Archived', type: 'checkbox' },
      ],
    },
    {
      id: 'tblShifts',
      name: 'Shift Requests',
      fields: [
        {
          id: 'fldStaff',
          name: 'Assigned Staff',
          type: 'multipleRecordLinks',
          options: { linkedTableId: 'tblStaff' },
        },
      ],
    },
  ],
});
const env = {
  AIRTABLE_PAT: 'fake-worker-token',
  AIRTABLE_BASE_ID: 'app12345678901234',
  AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
  AIRTABLE_SHIFTS_TABLE: 'Shift Requests',
  AIRTABLE_SYNC_ENABLED: 'false',
  AIRTABLE_FIELD_MAP: JSON.stringify({ shifts: { staff: 'Assigned Staff', staffName: null } }),
};
function configure(t: TestContext) {
  const previous = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('AIRTABLE_')),
  );
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (key.startsWith('AIRTABLE_')) delete process.env[key];
    Object.assign(process.env, previous);
  });
}

test('staff reader uses the verified linked table, reads only roster fields and includes active volunteers across pages', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined, 'roster synchronization is read-only');
    calls.push(url);
    if (url.includes('/meta/')) return Response.json(schema());
    const request = new URL(url);
    assert.equal(request.pathname, '/v0/app12345678901234/tblStaff');
    assert.deepEqual(request.searchParams.getAll('fields[]'), ['Name', 'Status', 'Archived']);
    assert.equal(
      request.searchParams.has('filterByFormula'),
      false,
      'read all statuses to detect departures',
    );
    return Response.json(
      request.searchParams.has('offset')
        ? {
            records: [
              row(4, 'Archived Active', 'Active', true),
              row(5, 'Applicant', 'Pending Interview'),
            ],
          }
        : {
            records: [
              row(1, 'Active Worker', 'Active'),
              row(2, 'Volunteer Worker', 'Active - Volunteer'),
              row(3, 'Past Worker', 'Inactive'),
            ],
            offset: 'page-two',
          },
    );
  });
  const result = await readAirtableStaff({
    ...env,
    AIRTABLE_STAFF_TABLE: 'tblStaff',
    AIRTABLE_STAFF_NAME_FIELD: 'fldName',
    AIRTABLE_STAFF_STATUS_FIELD: 'fldStatus',
    AIRTABLE_STAFF_ARCHIVED_FIELD: 'fldArchived',
  });
  assert.deepEqual(
    result.workers.map((w) => w.active),
    [true, true, false, false, false],
  );
  assert.equal(calls.length, 3);
});

test('invalid staff schema, records and pagination cannot produce a partial roster', async (t) => {
  let metadata = schema();
  let records: unknown[] = [row(1, 'Worker', 'Active')];
  let offset: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(url.includes('/meta/') ? metadata : { records, offset }),
  );
  const assignment = metadata.tables[1].fields[0];
  assignment.options = { linkedTableId: 'tblWrong' };
  await assert.rejects(readAirtableStaff(env), /must link to the configured Staff table/);
  metadata = schema();
  metadata.tables[0].fields[0].type = 'multipleLookupValues';
  await assert.rejects(readAirtableStaff(env), /Map Staff > Name/);
  metadata = schema();
  await assert.rejects(
    readAirtableStaff({ ...env, AIRTABLE_STAFF_ACTIVE_STATUSES: '["Activ"]' }),
    /status is missing/,
  );
  await assert.rejects(
    readAirtableStaff({ ...env, AIRTABLE_STAFF_ACTIVE_STATUSES: '{}' }),
    /JSON list/,
  );
  for (const invalid of [
    [row(1, '', 'Active')],
    [row(1, 'Volunteer', 'Active - Volunteer', false), row(1, 'Duplicate', 'Active')],
    [{ id: staffId(1) }],
    [{ id: staffId(1), fields: { Name: 'Worker', Status: ['Active'] } }],
    [{ id: staffId(1), fields: { Name: 'Worker', Status: 'Active', Archived: 'yes' } }],
  ]) {
    records = invalid;
    await assert.rejects(readAirtableStaff(env), /previous worker list is preserved/);
  }
  records = [row(1, 'Worker', 'Active')];
  offset = 'repeated';
  await assert.rejects(readAirtableStaff(env), /repeated pagination/);
  offset = false;
  await assert.rejects(readAirtableStaff(env), /invalid pagination/);
});

test('approved superannuation-pending status is assignable but interview, suspended and archived staff remain excluded', async (t) => {
  const records = [
    row(1, 'Payroll Pending', 'Pending Superannuation Xero Input'),
    row(2, 'Suspended', 'Suspended'),
    row(3, 'Applicant', 'Pending Interview'),
    row(4, 'Archived', 'Pending Superannuation Xero Input', true),
  ];
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(url.includes('/meta/') ? schema() : { records }),
  );
  assert.deepEqual(
    (await readAirtableStaff(env)).workers.map((w) => w.active),
    [true, false, false, false],
  );
  assert.deepEqual(
    (
      await readAirtableStaff({
        ...env,
        AIRTABLE_STAFF_ACTIVE_STATUSES: '["Active","Active - Volunteer"]',
      })
    ).workers.map((w) => w.active),
    [false, false, false, false],
  );
});

test('automatic worker refresh preserves booking identities, local workers and permissions through rename, removal and reactivation', async (t) => {
  configure(t);
  const runtime = createApp({ databasePath: ':memory:', demoMode: false, enableSync: false });
  t.after(() => runtime.close());
  const existing = {
    id: 'existing-worker',
    name: 'Old name',
    initials: 'ON',
    color: 'blue',
    airtableId: staffId(1),
  };
  runtime.store.put('staff', existing);
  runtime.store.put('staff', { id: 'local', name: 'Same Name', initials: 'SN', color: 'blue' });
  const shift = newShift(
    {
      participantId: 'participant',
      start: '2027-01-01T01:00:00Z',
      end: '2027-01-01T02:00:00Z',
      description: 'Support',
      notes: '',
      location: '',
      kind: 'general',
      driving: 'no_preference',
      gender: 'no_preference',
    },
    'staff',
    false,
    { staffId: existing.id, status: 'confirmed' },
  );
  runtime.store.put('shifts', shift);
  let records = [
    row(1, 'Renamed Worker', 'Active'),
    row(2, 'Same Name', 'Active - Volunteer'),
    row(3, 'Archived', 'Active', true),
    row(4, 'Inactive', 'Inactive'),
  ];
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    if (url.includes('/meta/')) return Response.json(schema());
    reads++;
    return Response.json({ records });
  });
  await Promise.all([runtime.refreshWorkers(), runtime.refreshWorkers(true)]);
  assert.equal(reads, 1, 'concurrent startup and manual checks share one request');
  const first = runtime.store.all('staff');
  assert.equal(first.length, 3);
  assert.equal(runtime.store.get('staff', existing.id)?.name, 'Renamed Worker');
  assert.equal(runtime.store.get('staff', existing.id)?.active, true);
  const volunteer = first.find((w) => w.airtableId === staffId(2))!;
  assert(volunteer);
  assert.notEqual(volunteer.id, 'local', 'identical display names are never merged');
  await runtime.refreshWorkers();
  assert.equal(reads, 1, 'background polling is throttled to five minutes');
  await runtime.refreshWorkers(true);
  assert.deepEqual(
    runtime.store.all('staff'),
    first,
    'repeated snapshots do not duplicate workers',
  );
  records = [row(2, 'Same Name', 'Active - Volunteer', true)];
  await runtime.refreshWorkers(true);
  assert.equal(
    runtime.store.get('staff', existing.id)?.active,
    false,
    'missing linked worker is retained as inactive',
  );
  assert.equal(
    runtime.store.get('staff', volunteer.id)?.active,
    false,
    'archived volunteer is not assignable',
  );
  assert.equal(runtime.store.get('staff', 'local')?.active, undefined);
  records = [row(1, 'Returned Worker', 'Active'), row(2, 'Same Name', 'Active - Volunteer')];
  await runtime.refreshWorkers(true);
  assert.equal(runtime.store.all('staff').length, 3);
  assert.equal(runtime.store.get('staff', existing.id)?.active, true);
  assert.equal(runtime.store.get('staff', volunteer.id)?.active, true);
  assert.deepEqual(
    runtime.store.get('shifts', shift.id),
    shift,
    'approvals and assignments remain portal-owned',
  );
  assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n, 0);
  assert.equal(
    runtime.store.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n,
    0,
    'sync grants no login access',
  );
  assert(runtime.store.meta('worker_sync_checked'));
});

test('a failed later page or identity conflict preserves the last complete roster and reports a safe error', async (t) => {
  configure(t);
  const runtime = createApp({ databasePath: ':memory:', demoMode: false, enableSync: false });
  t.after(() => runtime.close());
  let failPage = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/meta/')) return Response.json(schema());
    if (new URL(url).searchParams.has('offset'))
      return new Response('private staff data fake-worker-token', { status: 401 });
    return Response.json({
      records: [row(1, failPage ? 'Changed Name' : 'Worker', 'Active')],
      ...(failPage ? { offset: 'second-page' } : {}),
    });
  });
  await runtime.refreshWorkers();
  const snapshot = runtime.store.all('staff');
  const checked = runtime.store.meta('worker_sync_checked');
  failPage = true;
  await assert.rejects(runtime.refreshWorkers(true), /rejected the personal access token/);
  assert.deepEqual(runtime.store.all('staff'), snapshot);
  assert.equal(runtime.store.meta('worker_sync_checked'), checked);
  assert(!runtime.store.meta('worker_sync_error')?.includes('private staff'));
  assert(!runtime.store.meta('worker_sync_error')?.includes('fake-worker-token'));
  failPage = false;
  process.env.AIRTABLE_STAFF_RECORD_MAP = JSON.stringify({ 'different-identity': staffId(1) });
  await assert.rejects(runtime.refreshWorkers(true), /identity mapping/);
  assert.deepEqual(runtime.store.all('staff'), snapshot);
  delete process.env.AIRTABLE_STAFF_RECORD_MAP;
  runtime.store.put('staff', { ...snapshot[0], id: 'duplicate' });
  await assert.rejects(runtime.refreshWorkers(true), /multiple portal workers/);
  runtime.store.db.prepare('DELETE FROM staff WHERE id=?').run('duplicate');
  await runtime.refreshWorkers(true);
  assert.equal(runtime.store.meta('worker_sync_error'), '');
});

test('explicit staff migration mappings keep existing worker and booking IDs', async (t) => {
  configure(t);
  process.env.AIRTABLE_STAFF_RECORD_MAP = JSON.stringify({ 'legacy-worker': staffId(1) });
  const runtime = createApp({ databasePath: ':memory:', demoMode: false, enableSync: false });
  t.after(() => runtime.close());
  runtime.store.put('staff', {
    id: 'legacy-worker',
    name: 'Legacy name',
    initials: 'LN',
    color: 'blue',
  });
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(
      url.includes('/meta/') ? schema() : { records: [row(1, 'Current Name', 'Active')] },
    ),
  );
  await runtime.refreshWorkers();
  assert.equal(runtime.store.all('staff').length, 1);
  assert.equal(runtime.store.get('staff', 'legacy-worker')?.airtableId, staffId(1));
  assert.equal(runtime.store.get('staff', 'legacy-worker')?.name, 'Current Name');
});
