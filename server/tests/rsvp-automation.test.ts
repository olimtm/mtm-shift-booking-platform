import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Run the actual Airtable script with mocked platform globals. No network access.
const source = readFileSync(new URL('../../automation/airtable-rsvp.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('input', 'base', 'fetch', 'output', source);
type Values = Record<string, unknown>;

function record(id: string, values: Values) {
  return {
    id,
    getCellValue(name: string) {
      assert.ok(Object.hasOwn(values, name), `Unexpected field read: ${name}`);
      return values[name];
    },
    getCellValueAsString(name: string) {
      assert.ok(Object.hasOwn(values, name), `Unexpected field read: ${name}`);
      return String(values[name] ?? '');
    },
  };
}

function fixture(
  options: {
    rsvp?: Values;
    event?: Values;
    config?: Values;
    extraRsvp?: Values;
    secret?: string;
    responseStatus?: number;
  } = {},
) {
  const rsvpValues = {
    Participant: [{ id: 'recPerson' }],
    Event: [{ id: 'recEvent' }],
    'Circle RSVP': 'Active',
    Cancelled: null,
    ...options.rsvp,
  };
  const rsvp = record('recRsvp', rsvpValues);
  const event = record('recEvent', {
    Name: 'Test event',
    Start: '2026-10-10T10:00:00+11:00',
    End: '2026-10-10T12:00:00+11:00',
    Address: 'Community centre',
    Stage: 'Live',
    ...options.event,
  });
  const records = options.extraRsvp
    ? [rsvp, record('recOtherRsvp', { ...rsvpValues, ...options.extraRsvp })]
    : [rsvp];
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const outputs = new Map<string, unknown>();
  return {
    requests,
    outputs,
    run: () =>
      execute(
        {
          config: () => ({
            portalUrl: 'https://portal.example.test',
            rsvpRecordId: 'recRsvp',
            ...options.config,
          }),
          secret: (name: string) => {
            assert.equal(name, 'portalWebhookSecret');
            return options.secret ?? 'a'.repeat(43);
          },
        },
        {
          getTable: (name: string) => {
            if (name === 'RSVPs')
              return {
                selectRecordAsync: async (id: string) => records.find((item) => item.id === id),
                selectRecordsAsync: async () => ({ records }),
              };
            assert.equal(name, 'Events');
            return { selectRecordAsync: async (id: string) => (id === event.id ? event : null) };
          },
        },
        async (
          url: string,
          request: { method: string; headers: Record<string, string>; body: string },
        ) => {
          assert.equal(request.method, 'POST');
          requests.push({ url, headers: request.headers, body: JSON.parse(request.body) });
          const status = options.responseStatus ?? 200;
          return { status, ok: status >= 200 && status < 300 };
        },
        { set: (name: string, value: unknown) => outputs.set(name, value) },
      ),
  };
}

test('Airtable script sends live schema attendance and actual event times for portal buffering', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://portal.example.test/api/webhooks/rsvp');
  assert.equal(f.requests[0].headers.Authorization, `Bearer ${'a'.repeat(43)}`);
  assert.deepEqual(f.requests[0].body, {
    rsvpId: 'recRsvp:recPerson',
    eventId: 'recEvent',
    participantId: 'recPerson',
    status: 'attending',
    event: {
      title: 'Test event',
      start: '2026-10-09T23:00:00.000Z',
      end: '2026-10-10T01:00:00.000Z',
      location: 'Community centre',
      description: '',
    },
  });
  assert.equal(f.outputs.get('delivered'), 1);
});

test('Airtable script maps Dropped, explicit cancellation and cancelled events to cancellation', async () => {
  for (const options of [
    { rsvp: { 'Circle RSVP': 'Dropped' } },
    { rsvp: { Cancelled: '2026-10-01T00:00:00.000Z' } },
    { event: { Stage: 'Cancelled' } },
    { rsvp: { 'Circle RSVP': '' }, event: { Stage: 'Cancelled' } },
  ]) {
    const f = fixture(options);
    await f.run();
    assert.equal(f.requests[0].body.status, 'cancelled');
  }
});

test('Airtable script does not interpret billing status or support eligibility as attendance', async () => {
  const f = fixture({
    rsvp: { 'RSVP Status': 'Live SNC', 'Is Cancelled RSVP': 1, 'Needs 1:1': false },
  });
  await f.run();
  assert.equal(f.requests[0].body.status, 'attending');
});

test('Airtable script rejects unrecognized attendance instead of creating a request', async () => {
  const f = fixture({ rsvp: { 'Circle RSVP': 'Maybe' } });
  await assert.rejects(f.run(), /Active\/Dropped/);
  assert.equal(f.requests.length, 0);
});

test('Airtable script fans out multiple participants with stable separate RSVP identities', async () => {
  const f = fixture({ rsvp: { Participant: [{ id: 'recPerson' }, { id: 'recOtherPerson' }] } });
  await f.run();
  await f.run();
  assert.deepEqual(
    f.requests.map((item) => item.body.rsvpId),
    ['recRsvp:recPerson', 'recRsvp:recOtherPerson', 'recRsvp:recPerson', 'recRsvp:recOtherPerson'],
  );
});

test('Airtable event automation finds only linked RSVPs and sends latest event fields', async () => {
  const f = fixture({
    config: { rsvpRecordId: undefined, eventRecordId: 'recEvent' },
    extraRsvp: { Event: [{ id: 'recUnrelatedEvent' }] },
    event: { Address: 'Updated address' },
  });
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.event.location, 'Updated address');
});

test('Airtable script rejects missing secrets, ambiguous trigger IDs and invalid event dates', async () => {
  for (const options of [
    { secret: 'placeholder' },
    { config: { eventRecordId: 'recEvent' } },
    { config: { portalUrl: 'http://portal.example.test' } },
    { event: { End: '2026-10-09T00:00:00Z' } },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(f.requests.length, 0);
  }
});

test('Airtable script surfaces failed delivery without logging response contents', async () => {
  const f = fixture({ responseStatus: 401 });
  await assert.rejects(f.run(), /HTTP 401/);
  assert.equal(f.outputs.has('delivered'), false);
});
