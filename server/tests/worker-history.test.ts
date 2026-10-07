import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAirtableWorkHistory } from '../airtable.ts';
import {
  workTogetherCounts,
  createWorkHistorySync,
  savedWorkHistory,
  type WorkHistoryRecord,
} from '../worker-history.ts';
import { Store } from '../db.ts';
import { newShift } from '../domain.ts';
import { rankedWorkers } from '../../shared/views.ts';
import type { Participant, StaffMember } from '../../shared/types.ts';

const p: Participant = {
  id: 'p',
  airtableId: 'rec11111111111111',
  name: 'Participant',
  initials: 'P',
  color: 'blue',
  supportType: 'both',
  notes: '',
};
const workers: StaffMember[] = [
  {
    id: 'z',
    airtableId: 'rec22222222222222',
    name: 'Zara',
    initials: 'Z',
    color: 'blue',
    active: true,
  },
  {
    id: 'b',
    airtableId: 'rec33333333333333',
    name: 'Bella',
    initials: 'B',
    color: 'blue',
    active: true,
  },
  { id: 'a', name: 'amy', initials: 'A', color: 'blue', active: true },
  { id: 'inactive', name: 'Absent', initials: 'A', color: 'blue', active: false },
];
const now = Date.parse('2026-10-07T00:00:00Z');
const start = '2026-10-05T01:00:00Z',
  end = '2026-10-05T03:00:00Z';
const booking = (id: string, worker = 'z', overrides = {}) =>
  newShift(
    {
      participantId: 'p',
      start,
      end,
      description: 'Support',
      location: '',
      notes: '',
      kind: 'general',
      driving: 'no_preference',
      gender: 'no_preference',
    },
    'staff',
    false,
    { id, status: 'confirmed', staffId: worker, ...overrides },
  );
const log: WorkHistoryRecord = {
  id: 'rec44444444444444',
  participantAirtableId: p.airtableId!,
  workerAirtableId: workers[0].airtableId!,
  start: '2026-10-05T01:04:00Z',
  end: '2026-10-05T03:12:00Z',
};
const env = {
  AIRTABLE_PAT: 'fake-token',
  AIRTABLE_BASE_ID: 'app12345678901234',
  AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
};
const schema = () => ({
  tables: [
    { id: 'tblPeople', name: 'Participants', fields: [] },
    { id: 'tblStaff', name: 'Staff', fields: [] },
    {
      id: 'tblLog',
      name: '1:1 Log',
      fields: [
        { name: 'Start', type: 'dateTime' },
        { name: 'End', type: 'dateTime' },
        {
          name: 'Progress Facilitator',
          type: 'multipleRecordLinks',
          options: { linkedTableId: 'tblStaff' },
        },
        {
          name: 'Participant',
          type: 'multipleRecordLinks',
          options: { linkedTableId: 'tblPeople' },
        },
        { name: 'Status', type: 'singleSelect' },
        { name: 'Is Live Shift', type: 'formula' },
      ],
    },
  ],
});
const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `rec${String(n).padStart(14, '0')}`,
  fields: {
    Start: start,
    End: end,
    'Progress Facilitator': [workers[0].airtableId],
    Participant: [p.airtableId],
    'Is Live Shift': 1,
    ...overrides,
  },
});

test('work-together counts combine delivered logs and past bookings without overlapping or exact duplicate copies', () => {
  const shifts = [
    booking('matching'),
    booking('other-day', 'z', { start: '2026-10-04T01:00:00Z', end: '2026-10-04T03:00:00Z' }),
    booking('future', 'z', { start: '2026-10-09T01:00:00Z', end: '2026-10-09T03:00:00Z' }),
    booking('cancelled', 'z', { status: 'cancelled' }),
    booking('requested', 'z', { status: 'requested' }),
    booking('declined', 'z', { status: 'declined' }),
    booking('unassigned', 'z', { staffId: null }),
    booking('in-progress', 'z', { start: '2026-10-06T23:00:00Z', end: '2026-10-07T01:00:00Z' }),
    booking('different-person', 'b', { participantId: 'someone-else' }),
    booking('tie', 'a'),
    booking('tie-two', 'b'),
  ];
  const counts = workTogetherCounts(
    [p],
    workers,
    shifts,
    [
      log,
      { ...log, id: 'rec55555555555555' },
      { ...log, participantAirtableId: 'rec99999999999999' },
    ],
    now,
  );
  assert.deepEqual(counts.p, { z: 2, a: 1, b: 1 });
  assert.deepEqual(
    rankedWorkers(workers, counts.p).map((r) => [r.worker.name, r.count]),
    [
      ['Zara', 2],
      ['amy', 1],
      ['Bella', 1],
    ],
  );
  assert.deepEqual(
    rankedWorkers(workers, {}).map((r) => r.worker.name),
    ['amy', 'Bella', 'Zara'],
  );
  assert.equal(workTogetherCounts([p], workers, shifts, [log], now, 'other-day').p.z, 1);
  const sameName = { ...workers[0], id: 'unlinked', airtableId: undefined };
  assert.equal(
    workTogetherCounts([p], [sameName], [], [log], now).p,
    undefined,
    'equal names never match records',
  );
});

test('history reader is read-only, paginated and omits incomplete and non-delivered records', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, undefined);
    calls.push(url);
    if (url.includes('/meta/')) return Response.json(schema());
    const query = new URL(url).searchParams;
    assert.deepEqual(query.getAll('fields[]'), [
      'Start',
      'End',
      'Progress Facilitator',
      'Participant',
      'Status',
      'Is Live Shift',
    ]);
    return Response.json(
      query.has('offset')
        ? { records: [row(6, { Status: 'Completed' }), row(7, { Participant: [] })] }
        : {
            records: [
              row(1),
              row(2, { Status: 'Cancelled' }),
              row(3, { Status: 'Requested' }),
              row(4, { 'Is Live Shift': 0 }),
              row(5, { End: '' }),
            ],
            offset: 'next',
          },
    );
  });
  const result = await readAirtableWorkHistory(env);
  assert.equal(result.records.length, 2);
  assert.equal(result.omitted, 2);
  assert.equal(calls.length, 3);
  assert.equal(result.records[0].workerAirtableId, workers[0].airtableId);
});

test('history refresh preserves the last snapshot on a later page failure and survives database reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-history-'));
  const path = join(directory, 'history.sqlite');
  let store = new Store(path),
    fail = false;
  const previous = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('AIRTABLE_')),
  );
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (key.startsWith('AIRTABLE_')) delete process.env[key];
    Object.assign(process.env, previous);
  });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/meta/')) return Response.json(schema());
    if (url.includes('offset=')) return new Response('private payload fake-token', { status: 401 });
    return Response.json({ records: [row(1)], ...(fail ? { offset: 'next' } : {}) });
  });
  const refresh = createWorkHistorySync(store, () => true);
  await refresh();
  const original = savedWorkHistory(store),
    checked = store.meta('worker_history_checked');
  fail = true;
  await assert.rejects(refresh(true), /rejected the personal access token/);
  assert.deepEqual(savedWorkHistory(store), original);
  assert.equal(store.meta('worker_history_checked'), checked);
  assert(!store.meta('worker_history_error')?.includes('private payload'));
  store.close();
  store = new Store(path);
  assert.deepEqual(savedWorkHistory(store), original);
  fail = false;
  await createWorkHistorySync(store, () => true)(true);
  assert.equal(store.meta('worker_history_error'), '');
});

test('history schema and repeated pagination errors do not silently produce empty history', async (t) => {
  const metadata = schema();
  metadata.tables[2].fields[2].options = { linkedTableId: 'wrong' };
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(url.includes('/meta/') ? metadata : { records: [], offset: 'same' }),
  );
  await assert.rejects(readAirtableWorkHistory(env), /history fields/);
  metadata.tables[2].fields[2].options = { linkedTableId: 'tblStaff' };
  await assert.rejects(readAirtableWorkHistory(env), /repeated pagination/);
});
