import assert from 'node:assert/strict';
import test from 'node:test';
import { readConnecteamSchedulers, selectConnecteamScheduler } from '../connecteam.ts';
import { readAirtableConnecteamMappings } from '../airtable.ts';
import { createConnecteamSetup } from '../connecteam-setup.ts';
import { Store } from '../db.ts';

test('Connecteam connection check uses a server-side API key, only reads, and selects the exact NSW scheduler', async (t) => {
  const rows = [
    { schedulerId: 11, name: 'NSW', isArchived: false, timezone: 'Australia/Sydney' },
    { schedulerId: 12, name: 'Other', isArchived: false },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.connecteam.com/scheduler/v1/schedulers');
    assert.equal(options.method, 'GET');
    assert.equal(
      (options.headers as Record<string, string>)['X-API-KEY'],
      'fake-connecteam-secret',
    );
    return Response.json({ data: { schedulers: rows } });
  });
  const result = await readConnecteamSchedulers({ CONNECTEAM_API_KEY: 'fake-connecteam-secret' });
  assert.equal(selectConnecteamScheduler(result, {}).schedulerId, 11);
  assert.equal(
    selectConnecteamScheduler(result, { CONNECTEAM_SCHEDULER_ID: '12' }).schedulerId,
    12,
  );
  assert.throws(() => selectConnecteamScheduler([...result, rows[0]], {}), /ambiguous/);
  assert.throws(
    () => selectConnecteamScheduler([{ ...rows[0], isArchived: true }], {}),
    /archived/,
  );
  assert.throws(
    () => selectConnecteamScheduler(result, { CONNECTEAM_SCHEDULER_ID: 'not-an-id' }),
    /numeric/,
  );
});
test('missing or rejected Connecteam credentials never leak secrets or upstream bodies', async (t) => {
  await assert.rejects(readConnecteamSchedulers({}), /Set CONNECTEAM_API_KEY/);
  await assert.rejects(
    readConnecteamSchedulers({ CONNECTEAM_API_KEY: '"secret"' }),
    /without quotes/,
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('sensitive upstream fake-connecteam-secret', { status: 403 }),
  );
  await assert.rejects(
    readConnecteamSchedulers({ CONNECTEAM_API_KEY: 'fake-connecteam-secret' }),
    (e) =>
      e instanceof Error &&
      e.message.includes('HTTP 403') &&
      !e.message.includes('sensitive') &&
      !e.message.includes('fake-connecteam-secret'),
  );
});
test('Airtable Connecteam mapping check keeps stable record IDs and exposes duplicate IDs for reconciliation', async (t) => {
  const metadata = {
    tables: [
      { id: 'tblStaff', name: 'Staff', fields: [{ name: 'Connecteam ID', type: 'number' }] },
      {
        id: 'tblPeople',
        name: 'Participants',
        fields: [{ name: 'Connecteam Job ID', type: 'singleLineText' }],
      },
      {
        id: 'tblShifts',
        name: 'Shift Requests',
        fields: [{ name: 'Connecteam Shift ID', type: 'singleLineText' }],
      },
    ],
  };
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, undefined);
    if (url.includes('/meta/')) return Response.json(metadata);
    const table = metadata.tables.find((t) => url.includes(t.id))!;
    const field = table.fields[0].name;
    assert.deepEqual(new URL(url).searchParams.getAll('fields[]'), [field]);
    return Response.json({
      records: [
        {
          id: 'rec11111111111111',
          fields: { [field]: table.id === 'tblStaff' ? 123 : 'existing-id' },
        },
        { id: 'rec22222222222222', fields: { [field]: table.id === 'tblStaff' ? 123 : '' } },
      ],
    });
  });
  const result = await readAirtableConnecteamMappings({
    AIRTABLE_PAT: 'fake',
    AIRTABLE_BASE_ID: 'app12345678901234',
    AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
    AIRTABLE_SHIFTS_TABLE: 'Shift Requests',
  });
  assert.equal(result.workers.rec11111111111111, 123);
  assert.equal(result.participants.rec11111111111111, 'existing-id');
  assert.equal(result.shifts.rec11111111111111, 'existing-id');
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /share the same Connecteam ID/);
});

test('setup checks preserve mapped identities privately, never publish, and retain the last report on failure', async (t) => {
  const store = new Store(':memory:');
  const keys = [
    'CONNECTEAM_API_KEY',
    'CONNECTEAM_SCHEDULER_NAME',
    'CONNECTEAM_SCHEDULER_ID',
    'AIRTABLE_PAT',
    'AIRTABLE_BASE_ID',
    'AIRTABLE_PARTICIPANTS_TABLE',
    'AIRTABLE_SHIFTS_TABLE',
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    CONNECTEAM_API_KEY: 'fake-private-key',
    CONNECTEAM_SCHEDULER_NAME: 'NSW',
    AIRTABLE_PAT: 'fake-airtable-key',
    AIRTABLE_BASE_ID: 'app12345678901234',
    AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
    AIRTABLE_SHIFTS_TABLE: 'Shift Requests',
  });
  delete process.env.CONNECTEAM_SCHEDULER_ID;
  t.after(() => {
    store.close();
    for (const k of keys)
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
  });
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert(['GET', undefined].includes(options.method));
    if (url.includes('api.connecteam.com'))
      return fail
        ? new Response('PRIVATE_API_RESPONSE', { status: 401 })
        : Response.json({
            data: { schedulers: [{ schedulerId: 123, name: 'NSW', isArchived: false }] },
          });
    if (url.includes('/meta/'))
      return Response.json({
        tables: [
          { id: 'tblStaff', name: 'Staff', fields: [{ name: 'Connecteam ID', type: 'number' }] },
          {
            id: 'tblPeople',
            name: 'Participants',
            fields: [{ name: 'Connecteam Job ID', type: 'singleLineText' }],
          },
          {
            id: 'tblShifts',
            name: 'Shift Requests',
            fields: [{ name: 'Connecteam Shift ID', type: 'singleLineText' }],
          },
        ],
      });
    return Response.json({
      records: [
        {
          id: 'rec11111111111111',
          fields: url.includes('tblStaff')
            ? { 'Connecteam ID': 23 }
            : url.includes('tblPeople')
              ? { 'Connecteam Job ID': 'PRIVATE_JOB_ID' }
              : { 'Connecteam Shift ID': 'PRIVATE_SHIFT_ID' },
        },
      ],
    });
  });
  const setup = createConnecteamSetup(store, () => true);
  const status = await setup.check();
  assert.equal(status.report?.scheduler.name, 'NSW');
  assert.equal(status.publishingEnabled, false);
  assert.equal(status.report?.mappedWorkers, 1);
  assert(!JSON.stringify(status).includes('PRIVATE_'));
  assert(!JSON.stringify(status).includes('fake-private-key'));
  assert(
    JSON.parse(store.meta('connecteam_identity_mappings')!).participants.rec11111111111111 ===
      'PRIVATE_JOB_ID',
  );
  fail = true;
  await assert.rejects(setup.check(), /HTTP 401/);
  assert.deepEqual(setup.status().report, status.report);
  assert(!setup.status().error?.includes('PRIVATE_API_RESPONSE'));
  await assert.rejects(
    createConnecteamSetup(store, () => false).check(),
    /Add the Connecteam API key/,
  );
});
