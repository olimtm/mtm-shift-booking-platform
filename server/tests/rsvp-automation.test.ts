import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { once } from 'node:events';
import { LOCATION_MAX_LENGTH } from '../../shared/limits.js';

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
    responseError?: string;
    deliver?: (body: string, headers: Record<string, string>) => Promise<Response>;
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
          if (options.deliver) return options.deliver(request.body, request.headers);
          const status = options.responseStatus ?? 200;
          return {
            status,
            ok: status >= 200 && status < 300,
            json: async () => ({ error: options.responseError }),
          };
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

test('script identifies invalid event fields before sending rejected requests', async () => {
  for (const [event, error] of [
    [{ Name: '' }, /Events > Name/],
    [{ Name: ' ' }, /Events > Name/],
    [{ Name: 'x'.repeat(201) }, /Events > Name/],
    [{ Address: 'x'.repeat(LOCATION_MAX_LENGTH + 1) }, /Events > Address/],
    [{ End: '2026-10-13T12:00:00+11:00' }, /span more than 47 hours/],
  ] as const) {
    const f = fixture({ event });
    await assert.rejects(f.run(), error);
    assert.equal(f.requests.length, 0);
  }
});

test('script translates known server validation without exposing response data', async () => {
  for (const [responseError, expected] of [
    ['event.title: private participant data', /Check Events > Name/],
    ['event.location: private participant data', /Check Events > Address/],
    ['event.start: private participant data', /valid dates and times/],
    ['End must be after start, with a duration of at most 47 hours.', /no more than 47 hours/],
    [
      'Participant is not linked. Link the Airtable participant record in the portal first.',
      /Import or link/,
    ],
    ['private participant data and secret token', /No response contents were logged/],
  ] as const) {
    const f = fixture({ responseStatus: 400, responseError });
    await assert.rejects(f.run(), (error: Error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private participant|secret token/);
      return true;
    });
  }
});

test('actual Airtable script delivers to the actual portal and retries one buffered request', async () => {
  const { createApp } = await import('../app.js');
  const secret = 'FictionalWebhookSecret-2026-TestOnly-42';
  const location =
    'Community centre, main entrance. '.repeat(70).slice(0, LOCATION_MAX_LENGTH - 1) + '.';
  const app = createApp({
    databasePath: ':memory:',
    demoMode: false,
    enableSync: false,
    webhookSecret: secret,
  });
  app.store.put('participants', {
    id: 'p-test',
    airtableId: 'recPerson',
    name: 'Fictional Participant',
    initials: 'FP',
    color: 'green',
    supportType: 'events',
    notes: '',
  });
  const server = app.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const f = fixture({
      secret,
      event: { Address: location },
      deliver: (body, headers) =>
        fetch(`http://127.0.0.1:${address.port}/api/webhooks/rsvp`, {
          method: 'POST',
          headers,
          body,
        }),
    });
    await f.run();
    await f.run();
    const shifts = app.store.all('shifts');
    assert.equal(shifts.length, 1);
    assert.equal(shifts[0].start, '2026-10-09T22:30:00.000Z');
    assert.equal(shifts[0].end, '2026-10-10T01:30:00.000Z');
    assert.equal(shifts[0].status, 'requested');
    assert.equal(shifts[0].location, location);
    assert.equal(app.store.all('events')[0].location, location);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});
