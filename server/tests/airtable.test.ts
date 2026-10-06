import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AirtableRequestError,
  getAirtableStatus,
  inspectAirtableSchema,
  readAirtableRecords,
  readAirtableSnapshot,
  syncShiftToAirtable,
} from '../airtable.ts';
import type { Participant, Shift } from '../../shared/types.ts';

const env = {
  AIRTABLE_PAT: 'private-token-never-show',
  AIRTABLE_BASE_ID: 'app12345678901234',
  AIRTABLE_PARTICIPANTS_TABLE: 'People',
};
const participant: Participant = {
  id: 'p1',
  name: 'Test person',
  initials: 'TP',
  color: '#000',
  supportType: 'both',
  notes: '',
  airtableId: 'rec12345678901234',
};
const shift: Shift = {
  id: 'portal-shift-1',
  participantId: 'p1',
  start: '2026-10-05T00:00:00.000Z',
  end: '2026-10-05T02:00:00.000Z',
  description: 'Community activity',
  location: 'Library',
  driving: 'required',
  gender: 'no_preference',
  notes: '',
  kind: 'general',
  status: 'confirmed',
  staffId: null,
  source: 'client',
  eventId: null,
  pendingChange: null,
  syncStatus: 'pending',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

test('configuration reveals missing variable names, never the PAT', () => {
  const status = getAirtableStatus({ AIRTABLE_PAT: env.AIRTABLE_PAT });
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, ['AIRTABLE_BASE_ID', 'AIRTABLE_PARTICIPANTS_TABLE']);
  assert.equal(JSON.stringify(status).includes(env.AIRTABLE_PAT), false);
  assert.equal(getAirtableStatus(env).configured, true);
  assert.equal(
    getAirtableStatus({ ...env, AIRTABLE_FIELD_MAP: '{"shifts":{"portalId":null}}' }).configured,
    false,
  );
  assert.equal(
    getAirtableStatus({ ...env, AIRTABLE_FIELD_MAP: '{"shifts":{"start":"End"}}' }).configured,
    false,
  );
});

test('upsert retains approved values and publishes pending changes separately', async (t) => {
  let payload: Record<string, any> = {};
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.airtable.com/v0/app12345678901234/Shift%20Requests');
    assert.equal(init.method, 'PATCH');
    payload = JSON.parse(String(init.body));
    return Response.json({ records: [{ id: 'rec98765432109876' }] });
  });
  const edited: Shift = {
    ...shift,
    pendingChange: { type: 'cancel', reason: 'Unavailable', requestedAt: shift.updatedAt },
  };
  const result = await syncShiftToAirtable({ shift: edited, participant, staff: null }, env);
  assert.equal(result.recordId, 'rec98765432109876');
  assert.deepEqual(payload.performUpsert.fieldsToMergeOn, ['Portal request ID']);
  assert.equal(payload.typecast, false);
  assert.equal(payload.records[0].fields.Status, 'Confirmed');
  assert.equal(payload.records[0].fields.Start, shift.start);
  assert.deepEqual(payload.records[0].fields.Participant, [participant.airtableId]);
  assert.deepEqual(payload.records[0].fields.Event, []);
  assert.equal(JSON.parse(payload.records[0].fields['Pending change']).type, 'cancel');
});

test('unresolved linked records cannot silently become names or local IDs', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not call');
  });
  await assert.rejects(
    syncShiftToAirtable(
      { shift, participant: { ...participant, airtableId: undefined }, staff: null },
      env,
    ),
    /Participant needs a valid/,
  );
  await assert.rejects(
    syncShiftToAirtable(
      { shift: { ...shift, kind: 'event', eventId: 'local-event' }, participant, staff: null },
      env,
    ),
    /Event needs a valid/,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test('mapped linked staff and event fields use record ID arrays', async (t) => {
  let payload: Record<string, any> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    payload = JSON.parse(String(init.body));
    return Response.json({ records: [{ id: 'rec98765432109876' }] });
  });
  await syncShiftToAirtable(
    {
      shift: { ...shift, staffId: 's1', kind: 'event', eventId: 'e1' },
      participant,
      staff: { id: 's1', name: 'Worker', initials: 'W', color: '#000' },
      eventAirtableId: 'rec11111111111111',
    },
    {
      ...env,
      AIRTABLE_FIELD_MAP: '{"shifts":{"staff":"Assigned worker","staffName":null}}',
      AIRTABLE_STAFF_RECORD_MAP: '{"s1":"rec22222222222222"}',
    },
  );
  assert.deepEqual(payload.records[0].fields.Event, ['rec11111111111111']);
  assert.deepEqual(payload.records[0].fields['Assigned worker'], ['rec22222222222222']);
  assert.equal(payload.records[0].fields['Staff name'], undefined);
});

test('read-only schema inspection identifies incompatible writable fields and links', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    return Response.json({
      tables: [
        {
          id: 'tblPeople',
          name: 'People',
          fields: [
            { id: 'fldName', name: 'Name', type: 'singleLineText' },
            { id: 'fldSupport', name: 'Support type', type: 'singleSelect' },
          ],
        },
        {
          id: 'tblShifts',
          name: 'Shift Requests',
          fields: [
            { id: 'fldID', name: 'Portal request ID', type: 'formula' },
            {
              id: 'fldParticipant',
              name: 'Participant',
              type: 'multipleRecordLinks',
              options: { linkedTableId: 'tblWrong' },
            },
          ],
        },
        { id: 'tblEvents', name: 'Events', fields: [] },
        { id: 'tblRsvps', name: 'RSVPs', fields: [] },
      ],
    });
  });
  const report = await inspectAirtableSchema(env);
  assert.equal(report.ok, false);
  assert.ok(
    report.issues.some(
      (issue) => issue.field === 'Portal request ID' && issue.message.includes('formula'),
    ),
  );
  assert.ok(
    report.issues.some(
      (issue) => issue.field === 'Participant' && issue.message.includes('configured participants'),
    ),
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test('HTTP failures cannot leak Airtable response data or credentials', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: `sensitive participant details ${env.AIRTABLE_PAT}` }), {
        status: 422,
      }),
  );
  await assert.rejects(
    syncShiftToAirtable({ shift, participant, staff: null }, env),
    (error: Error) => {
      assert.match(error.message, /HTTP 422/);
      assert.doesNotMatch(error.message, /private-token|sensitive participant/);
      return true;
    },
  );
});

test('read pagination respects retry-after and follows each cursor', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url);
    if (urls.length === 1)
      return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
    if (urls.length === 2)
      return Response.json({
        records: [{ id: 'rec12345678901234', fields: {} }],
        offset: 'next cursor',
      });
    return Response.json({ records: [{ id: 'rec98765432109876', fields: {} }] });
  });
  const records = await readAirtableRecords('participants', env);
  assert.equal(records.length, 2);
  assert.equal(urls.length, 3);
  assert.ok(urls[2].includes('offset=next+cursor'));
});

test('long Retry-After is handed to the durable outbox without retrying early', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
  );
  await assert.rejects(readAirtableRecords('participants', env), (error: Error) => {
    assert.ok(error instanceof AirtableRequestError);
    assert.equal(error.retryAfterMs, 120_000);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

function importFixture() {
  const table = (name: string, names: string[]) => ({
    id: `tbl${name}`,
    name,
    fields: names.map((field, i) => ({
      id: `fld${name}${i}`,
      name: field,
      type: 'singleLineText',
    })),
  });
  return {
    schema: {
      tables: [
        table('People', ['Name', 'Support type']),
        table('Events', ['Name', 'Start', 'End', 'Location']),
        table('RSVPs', ['Participant', 'Event', 'Status']),
        table('Shift Requests', [
          'Participant',
          'Start',
          'End',
          'Support description',
          'Status',
          'Event',
          'Portal request ID',
          'Driving preference',
          'Gender preference',
          'Staff name',
          'Assigned staff',
        ]),
      ],
    },
    people: {
      records: [
        {
          id: 'rec11111111111111',
          fields: { Name: 'Person A', 'Support type': 'Event support only' },
        },
        { id: 'rec22222222222222', fields: { Name: 'Person B', 'Support type': 'NO SUPPORT' } },
      ],
    },
    events: {
      records: [
        {
          id: 'rec33333333333333',
          fields: {
            Name: 'Activity',
            Start: '2026-10-10T10:00:00+11:00',
            End: '2026-10-10T12:00:00+11:00',
            Location: 'Venue',
          },
        },
      ],
    },
    rsvps: {
      records: [
        {
          id: 'rec44444444444444',
          fields: {
            Participant: ['rec11111111111111', 'rec22222222222222'],
            Event: ['rec33333333333333'],
            Status: 'CONFIRMED',
          },
        },
      ],
    },
    shifts: { records: [] as Array<{ id: string; fields: Record<string, unknown> }> },
  };
}

test('initial import resolves field IDs and expands grouped RSVPs without any writes', async (t) => {
  const fixture = importFixture();
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined, 'initial import uses only read operations');
    requests.push(url);
    if (url.includes('/meta/')) return Response.json(fixture.schema);
    if (url.includes('/People?')) return Response.json(fixture.people);
    if (url.includes('/Events?')) return Response.json(fixture.events);
    if (url.includes('/RSVPs?')) return Response.json(fixture.rsvps);
    if (url.includes('/Shift%20Requests?')) return Response.json(fixture.shifts);
    throw new Error('Unexpected endpoint');
  });
  const snapshot = await readAirtableSnapshot({
    ...env,
    AIRTABLE_FIELD_MAP: '{"participants":{"name":"fldPeople0"}}',
  });
  assert.equal(snapshot.participants[0].supportType, 'events');
  assert.equal(snapshot.participants[1].supportType, 'none');
  assert.equal(snapshot.events[0].start, '2026-10-09T23:00:00.000Z');
  assert.equal(snapshot.events[0].description, '');
  assert.deepEqual(
    snapshot.rsvps.map((rsvp) => rsvp.participantAirtableId),
    ['rec11111111111111', 'rec22222222222222'],
  );
  assert.equal(snapshot.rsvps[0].status, 'attending');
  assert.equal(requests.length, 5);
});

test('initial import refuses unknown support labels and accepts explicit mappings', async (t) => {
  const fixture = importFixture();
  fixture.people.records[0].fields['Support type'] = 'social outings';
  fixture.rsvps.records[0].fields.Status = 'going';
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(
      url.includes('/meta/')
        ? fixture.schema
        : url.includes('/People?')
          ? fixture.people
          : url.includes('/Events?')
            ? fixture.events
            : url.includes('/Shift%20Requests?')
              ? fixture.shifts
              : fixture.rsvps,
    ),
  );
  await assert.rejects(readAirtableSnapshot(env), (error: Error) => {
    assert.match(error.message, /AIRTABLE_SUPPORT_TYPE_MAP/);
    assert.doesNotMatch(error.message, /Person A|social outings/);
    return true;
  });
  const snapshot = await readAirtableSnapshot({
    ...env,
    AIRTABLE_SUPPORT_TYPE_MAP: '{"social outings":"events"}',
    AIRTABLE_RSVP_STATUS_MAP: '{"going":"attending"}',
  });
  assert.equal(snapshot.participants[0].supportType, 'events');
  assert.equal(snapshot.rsvps[0].status, 'attending');
});

test('initial import rejects ambiguous links, invalid durations and contradictory RSVP states', async (t) => {
  let fixture = importFixture();
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(
      url.includes('/meta/')
        ? fixture.schema
        : url.includes('/People?')
          ? fixture.people
          : url.includes('/Events?')
            ? fixture.events
            : url.includes('/Shift%20Requests?')
              ? fixture.shifts
              : fixture.rsvps,
    ),
  );
  fixture.rsvps.records[0].fields.Event.push('rec55555555555555');
  await assert.rejects(readAirtableSnapshot(env), /exactly one event/);
  fixture = importFixture();
  fixture.events.records[0].fields.End = '2026-10-12T12:00:00+11:00';
  await assert.rejects(readAirtableSnapshot(env), /at most 47 hours/);
  fixture = importFixture();
  fixture.rsvps.records.push({
    ...fixture.rsvps.records[0],
    id: 'rec55555555555555',
    fields: { ...fixture.rsvps.records[0].fields, Status: 'Cancelled' },
  });
  await assert.rejects(readAirtableSnapshot(env), /conflicting attendance/);
});

test('existing shifts retain external identity, approved times, preferences and explicit worker mapping', async (t) => {
  const fixture = importFixture();
  fixture.shifts.records.push({
    id: 'rec55555555555555',
    fields: {
      Participant: ['rec11111111111111'],
      Event: ['rec33333333333333'],
      Start: '2026-10-10T09:30:00+11:00',
      End: '2026-10-10T12:30:00+11:00',
      'Support description': 'Existing approved support',
      Status: 'Approved',
      'Driving preference': 'Required',
      'Gender preference': 'Female',
      'Staff name': 'Worker A',
      'Assigned staff': ['rec66666666666666'],
    },
  });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    return Response.json(
      url.includes('/meta/')
        ? fixture.schema
        : url.includes('/People?')
          ? fixture.people
          : url.includes('/Events?')
            ? fixture.events
            : url.includes('/Shift%20Requests?')
              ? fixture.shifts
              : fixture.rsvps,
    );
  });
  const result = await readAirtableSnapshot({
    ...env,
    AIRTABLE_FIELD_MAP: '{"shifts":{"staff":"Assigned staff"}}',
    AIRTABLE_STAFF_RECORD_MAP: '{"staff-a":"rec66666666666666"}',
  });
  assert.equal(result.shifts[0].airtableId, 'rec55555555555555');
  assert.equal(result.shifts[0].portalId, undefined);
  assert.equal(result.shifts[0].status, 'confirmed');
  assert.equal(result.shifts[0].start, '2026-10-09T22:30:00.000Z');
  assert.equal(result.shifts[0].kind, 'event');
  assert.equal(result.shifts[0].driving, 'required');
  assert.equal(result.shifts[0].gender, 'female');
  assert.equal(result.shifts[0].source, 'staff');
  assert.equal(result.shifts[0].staffName, 'Worker A');
  assert.equal(result.shifts[0].staffAirtableId, 'rec66666666666666');
  assert.equal(result.shifts[0].staffPortalId, 'staff-a');
});

test('existing shifts reject unknown status, duplicate event bookings and duplicate portal IDs', async (t) => {
  const fixture = importFixture();
  const existing = {
    id: 'rec55555555555555',
    fields: {
      Participant: ['rec11111111111111'],
      Event: ['rec33333333333333'],
      Start: '2026-10-10T09:30:00+11:00',
      End: '2026-10-10T12:30:00+11:00',
      'Support description': 'Existing support',
      Status: 'Ready for roster',
    },
  };
  fixture.shifts.records.push(existing);
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(
      url.includes('/meta/')
        ? fixture.schema
        : url.includes('/People?')
          ? fixture.people
          : url.includes('/Events?')
            ? fixture.events
            : url.includes('/Shift%20Requests?')
              ? fixture.shifts
              : fixture.rsvps,
    ),
  );
  await assert.rejects(readAirtableSnapshot(env), /AIRTABLE_SHIFT_STATUS_MAP/);
  const mapped = { ...env, AIRTABLE_SHIFT_STATUS_MAP: '{"Ready for roster":"requested"}' };
  assert.equal((await readAirtableSnapshot(mapped)).shifts[0].status, 'requested');
  fixture.shifts.records.push({ ...existing, id: 'rec77777777777777' });
  await assert.rejects(readAirtableSnapshot(mapped), /same event and participant/);
  fixture.shifts.records[0].fields.Event = [];
  fixture.shifts.records[1].fields = { ...existing.fields, Event: [] };
  fixture.shifts.records[0].fields['Portal request ID'] = 'portal-duplicate';
  fixture.shifts.records[1].fields['Portal request ID'] = 'portal-duplicate';
  await assert.rejects(readAirtableSnapshot(mapped), /duplicates another Portal request ID/);
});

test('text-only imported worker assignment survives sync without clearing linked Airtable staff', async (t) => {
  let payload: Record<string, any> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    payload = JSON.parse(String(init.body));
    return Response.json({ records: [{ id: 'rec98765432109876' }] });
  });
  await syncShiftToAirtable(
    { shift: { ...shift, staffDisplayName: 'Imported worker' }, participant, staff: null },
    { ...env, AIRTABLE_FIELD_MAP: '{"shifts":{"staff":"Assigned staff"}}' },
  );
  assert.equal(payload.records[0].fields['Staff name'], 'Imported worker');
  assert.equal(Object.hasOwn(payload.records[0].fields, 'Assigned staff'), false);
});

test('existing board labels preserve approval states and all preference distinctions', async (t) => {
  const payloads: Record<string, any>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    payloads.push(JSON.parse(String(init.body)));
    return Response.json({ records: [{ id: 'rec98765432109876' }] });
  });
  const mapped = {
    ...env,
    AIRTABLE_SHIFT_VALUE_MAP: JSON.stringify({
      status: { requested: 'New', confirmed: 'Organised' },
      kind: { general: 'General Support', event: 'Event Support' },
      source: { client: 'Client portal', staff: 'Office', event: 'Circle RSVP' },
      driving: { required: 'Drives', not_required: 'Non-driving' },
    }),
  };
  for (const driving of ['required', 'not_required', 'no_preference'] as const)
    await syncShiftToAirtable({ shift: { ...shift, driving }, participant, staff: null }, mapped);
  assert.equal(payloads[0].records[0].fields.Status, 'Organised');
  assert.equal(payloads[0].records[0].fields['Support kind'], 'General Support');
  assert.equal(payloads[0].records[0].fields.Source, 'Client portal');
  assert.deepEqual(
    payloads.map((payload) => payload.records[0].fields['Driving preference']),
    ['Drives', 'Non-driving', 'No preference'],
  );
  assert.equal(
    getAirtableStatus({
      ...env,
      AIRTABLE_SHIFT_VALUE_MAP: '{"driving":{"required":"No preference"}}',
    }).configured,
    false,
  );
  assert.equal(
    getAirtableStatus({ ...env, AIRTABLE_SHIFT_VALUE_MAP: '{"status":{"unrecognised":"New"}}' })
      .configured,
    false,
  );
});

test('read-only formula names pass audit and existing choices use explicit label mappings', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      tables: [
        {
          id: 'tblPeople',
          name: 'People',
          fields: [
            {
              id: 'fldName',
              name: 'Name',
              type: 'formula',
              options: { result: { type: 'singleLineText' } },
            },
            {
              id: 'fldSupport',
              name: 'Support type',
              type: 'singleSelect',
              options: { choices: [{ name: 'General only' }, { name: 'Recommended' }] },
            },
          ],
        },
        {
          id: 'tblShift',
          name: 'Shift Requests',
          fields: [
            {
              id: 'fldStatus',
              name: 'Status',
              type: 'singleSelect',
              options: {
                choices: ['New', 'Organised', 'Declined', 'Cancelled'].map((name) => ({ name })),
              },
            },
          ],
        },
        { id: 'tblEvent', name: 'Events', fields: [] },
        { id: 'tblRsvp', name: 'RSVPs', fields: [] },
      ],
    }),
  );
  const report = await inspectAirtableSchema({
    ...env,
    AIRTABLE_SUPPORT_TYPE_MAP: '{"Recommended":"none"}',
    AIRTABLE_SHIFT_VALUE_MAP: '{"status":{"requested":"New","confirmed":"Organised"}}',
  });
  assert.ok(
    !report.issues.some(
      (issue) =>
        (issue.table === 'participants' &&
          (issue.field === 'Name' || issue.field === 'Support type')) ||
        (issue.table === 'shifts' && issue.field === 'Status'),
    ),
  );
  const unmapped = await inspectAirtableSchema(env);
  assert.ok(
    unmapped.issues.some(
      (issue) => issue.field === 'Support type' && issue.message.includes('Recommended'),
    ),
  );
  assert.ok(
    unmapped.issues.some(
      (issue) => issue.field === 'Status' && issue.message.includes('Requested'),
    ),
  );
});

test('explicit cancellation and cancelled events override active Circle RSVPs during import', async (t) => {
  const fixture = importFixture();
  fixture.schema.tables
    .find((table) => table.name === 'Events')!
    .fields.push({ id: 'fldStage', name: 'Stage', type: 'singleSelect' });
  fixture.schema.tables
    .find((table) => table.name === 'RSVPs')!
    .fields.push({ id: 'fldCancelled', name: 'Cancelled', type: 'dateTime' });
  const eventFields = fixture.events.records[0].fields as Record<string, unknown>;
  const rsvpFields = fixture.rsvps.records[0].fields as Record<string, unknown>;
  rsvpFields.Status = 'Active';
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(
      url.includes('/meta/')
        ? fixture.schema
        : url.includes('/People?')
          ? fixture.people
          : url.includes('/Events?')
            ? fixture.events
            : url.includes('/Shift%20Requests?')
              ? fixture.shifts
              : fixture.rsvps,
    ),
  );
  const mapped = {
    ...env,
    AIRTABLE_FIELD_MAP: '{"events":{"status":"Stage"},"rsvps":{"cancelledAt":"Cancelled"}}',
    AIRTABLE_RSVP_STATUS_MAP: '{"Active":"attending","Dropped":"cancelled"}',
  };
  assert.equal((await readAirtableSnapshot(mapped)).rsvps[0].status, 'attending');
  rsvpFields.Cancelled = '2026-10-01T00:00:00.000Z';
  assert.equal((await readAirtableSnapshot(mapped)).rsvps[0].status, 'cancelled');
  delete rsvpFields.Cancelled;
  eventFields.Stage = 'Cancelled';
  assert.equal((await readAirtableSnapshot(mapped)).rsvps[0].status, 'cancelled');
  eventFields.Stage = 'Live';
  rsvpFields.Status = 'Dropped';
  assert.equal((await readAirtableSnapshot(mapped)).rsvps[0].status, 'cancelled');
  rsvpFields.Cancelled = 'invalid-date';
  await assert.rejects(readAirtableSnapshot(mapped), /valid cancellation timestamp/);
  fixture.schema.tables.find((table) => table.name === 'RSVPs')!.fields.pop();
  await assert.rejects(readAirtableSnapshot(mapped), /rsvps.cancelledAt/);
});

test('import requests only mapped data and resolves assigned staff with names-only scoped reads', async (t) => {
  const fixture = importFixture();
  fixture.schema.tables.push({
    id: 'tblStaff',
    name: 'Staff',
    fields: [
      {
        id: 'fldWorker',
        name: 'Name',
        type: 'formula',
        options: { result: { type: 'singleLineText' } },
      } as any,
    ],
  });
  const assigned = fixture.schema.tables
    .find((table) => table.name === 'Shift Requests')!
    .fields.find((field) => field.name === 'Assigned staff')!;
  Object.assign(assigned, { type: 'multipleRecordLinks', options: { linkedTableId: 'tblStaff' } });
  fixture.shifts.records.push({
    id: 'rec55555555555555',
    fields: {
      Participant: ['rec11111111111111'],
      Start: shift.start,
      End: shift.end,
      'Support description': 'Support',
      Status: 'Organised',
      'Assigned staff': ['rec66666666666666'],
    },
  });
  let staffReads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    if (url.includes('/meta/')) return Response.json(fixture.schema);
    const params = new URL(url).searchParams;
    assert.ok(params.getAll('fields[]').length > 0);
    if (url.includes('/tblStaff?')) {
      staffReads++;
      assert.deepEqual(params.getAll('fields[]'), ['Name']);
      assert.equal(params.get('filterByFormula'), "OR(RECORD_ID()='rec66666666666666')");
      return Response.json({
        records: [{ id: 'rec66666666666666', fields: { Name: 'Assigned worker' } }],
      });
    }
    return Response.json(
      url.includes('/People?')
        ? fixture.people
        : url.includes('/Events?')
          ? fixture.events
          : url.includes('/Shift%20Requests?')
            ? fixture.shifts
            : fixture.rsvps,
    );
  });
  const snapshot = await readAirtableSnapshot({
    ...env,
    AIRTABLE_FIELD_MAP: '{"shifts":{"staff":"Assigned staff"}}',
    AIRTABLE_SHIFT_VALUE_MAP: '{"status":{"requested":"New","confirmed":"Organised"}}',
  });
  assert.equal(snapshot.shifts[0].status, 'confirmed');
  assert.equal(snapshot.shifts[0].staffName, 'Assigned worker');
  assert.equal(snapshot.shifts[0].staffAirtableId, 'rec66666666666666');
  assert.equal(staffReads, 1);
});

test('blank support switches stay hidden and Recommended requires the explicit no-support mapping', async (t) => {
  const fixture = importFixture();
  fixture.people.records[0].fields['Support type'] = '';
  fixture.people.records[1].fields['Support type'] = 'Recommended';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    return Response.json(
      url.includes('/meta/')
        ? fixture.schema
        : url.includes('/People?')
          ? fixture.people
          : url.includes('/Events?')
            ? fixture.events
            : url.includes('/RSVPs?')
              ? fixture.rsvps
              : fixture.shifts,
    );
  });
  const snapshot = await readAirtableSnapshot({
    ...env,
    AIRTABLE_SUPPORT_TYPE_MAP: '{"Recommended":"none"}',
  });
  assert.deepEqual(
    snapshot.participants.map((p) => p.supportType),
    ['none', 'none'],
  );
});

test('initial import preserves extended event and existing shift locations and rejects over-limit data', async (t) => {
  const { LOCATION_MAX_LENGTH } = await import('../../shared/limits.js');
  const fixture = importFixture();
  const location =
    'Community venue, meeting instructions. '.repeat(60).slice(0, LOCATION_MAX_LENGTH - 1) + '.';
  fixture.events.records[0].fields.Location = location;
  fixture.schema.tables
    .find((table) => table.name === 'Shift Requests')!
    .fields.push({ id: 'fldLocation', name: 'Location', type: 'singleLineText' });
  fixture.shifts.records.push({
    id: 'rec55555555555555',
    fields: {
      Participant: ['rec11111111111111'],
      Start: '2026-10-10T09:30:00+11:00',
      End: '2026-10-10T12:30:00+11:00',
      'Support description': 'Existing approved support',
      Status: 'Approved',
      Location: location,
    },
  });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined, 'import must remain read only');
    return Response.json(
      url.includes('/meta/')
        ? fixture.schema
        : url.includes('/People?')
          ? fixture.people
          : url.includes('/Events?')
            ? fixture.events
            : url.includes('/Shift%20Requests?')
              ? fixture.shifts
              : fixture.rsvps,
    );
  });
  const snapshot = await readAirtableSnapshot(env);
  assert.equal(snapshot.events[0].location, location);
  assert.equal(snapshot.shifts[0].location, location);
  fixture.events.records[0].fields.Location = location + 'x';
  await assert.rejects(readAirtableSnapshot(env), /valid location text value/);
  fixture.events.records[0].fields.Location = location;
  fixture.shifts.records[0].fields.Location = location + 'x';
  await assert.rejects(readAirtableSnapshot(env), /valid location text value/);
});
