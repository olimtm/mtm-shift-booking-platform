import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.ts';

test('participant activity refresh reads Status only, preserves portal decisions and keeps the last complete result on failure', async (t) => {
  const previous = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('AIRTABLE_')),
  );
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, {
    AIRTABLE_PAT: 'fake-token',
    AIRTABLE_BASE_ID: 'app12345678901234',
    AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
    AIRTABLE_SYNC_ENABLED: 'false',
  });
  const runtime = createApp({
    databasePath: ':memory:',
    demoMode: false,
    publicOrigin: 'http://localhost:5173',
    enableSync: false,
  });
  const one = {
    id: 'p1',
    name: 'Portal name',
    initials: 'PN',
    color: 'blue',
    notes: 'Portal notes',
    supportType: 'both' as const,
    airtableId: 'rec11111111111111',
  };
  runtime.store.put('participants', one);
  runtime.store.put('participants', { ...one, id: 'p2', airtableId: 'rec22222222222222' });
  runtime.store.put('participants', { ...one, id: 'p-local', airtableId: undefined });
  let status = 'Active';
  let fail = false;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined, 'activity sync never writes to Airtable');
    if (url.includes('/meta/'))
      return Response.json({
        tables: [
          {
            id: 'tblParticipants',
            name: 'Participants',
            fields: [{ id: 'fldStatus', name: 'Status', type: 'singleSelect' }],
          },
        ],
      });
    assert.deepEqual(new URL(url).searchParams.getAll('fields[]'), ['Status']);
    reads++;
    if (fail) return Response.json({ error: 'private response must not appear' }, { status: 401 });
    return Response.json({
      records: [
        { id: one.airtableId, fields: { Status: status } },
        { id: 'rec22222222222222', fields: { Status: 'Pending Intro Call' } },
      ],
    });
  });
  try {
    await runtime.refreshParticipantActivity();
    assert.deepEqual(runtime.store.get('participants', 'p1'), { ...one, active: true });
    assert.equal(runtime.store.get('participants', 'p2')?.active, false);
    assert.equal(runtime.store.get('participants', 'p-local')?.active, undefined);
    await runtime.refreshParticipantActivity();
    assert.equal(reads, 1, 'background checks are limited to once per five minutes');
    status = 'Inactive';
    await runtime.refreshParticipantActivity(true);
    assert.deepEqual(runtime.store.get('participants', 'p1'), { ...one, active: false });
    const checked = runtime.store.meta('participant_activity_checked');
    fail = true;
    await assert.rejects(
      runtime.refreshParticipantActivity(true),
      /rejected the personal access token/,
    );
    assert.equal(runtime.store.meta('participant_activity_checked'), checked);
    assert.equal(runtime.store.get('participants', 'p1')?.active, false);
    assert.ok(!runtime.store.meta('participant_activity_error')?.includes('private response'));
    fail = false;
    status = 'Active';
    await runtime.refreshParticipantActivity(true);
    assert.equal(runtime.store.get('participants', 'p1')?.active, true);
    assert.equal(runtime.store.meta('participant_activity_error'), '');
  } finally {
    runtime.close();
    for (const key of Object.keys(process.env))
      if (key.startsWith('AIRTABLE_')) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
