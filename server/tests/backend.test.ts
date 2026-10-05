import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DashboardData, Rsvp, Shift, ShiftInput, SupportEvent } from '../../shared/types.ts';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth.ts';
import { Store } from '../db.ts';

const origin = 'http://localhost:5173';
const password = 'DemoSupport!2026';

async function fixture(
  options: {
    databasePath?: string;
    demoMode?: boolean;
    publicOrigin?: string;
    enableSync?: boolean;
  } = {},
) {
  const runtime = createApp({
    databasePath: ':memory:',
    demoMode: true,
    publicOrigin: origin,
    webhookSecret: 'test-rsvp-secret-long',
    ...options,
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function session(initialCookie = '') {
    let cookie = initialCookie;
    return async function request<T = Record<string, unknown>>(
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; body: T; response: Response }> {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          Origin: options.publicOrigin ?? origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const nextCookie = response.headers.getSetCookie();
      if (nextCookie.length) cookie = nextCookie.map((value) => value.split(';')[0]).join('; ');
      const raw = await response.text();
      return { status: response.status, body: raw ? (JSON.parse(raw) as T) : ({} as T), response };
    };
  }

  return {
    session,
    store: runtime.store,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      runtime.close();
    },
  };
}

type Request = ReturnType<Awaited<ReturnType<typeof fixture>>['session']>;

async function login(request: Request, role: 'staff' | 'client') {
  const result = await request('POST', '/api/auth/login', {
    email: role === 'staff' ? 'coordinator@mtm.demo' : 'alex@mtm.demo',
    password,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

function input(participantId: string, overrides: Partial<ShiftInput> = {}): ShiftInput {
  const start = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  start.setUTCHours(0, 0, 0, 0);
  return {
    participantId,
    start: start.toISOString(),
    end: new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    description: 'Community access and grocery shopping',
    location: 'Participant home',
    driving: 'required',
    gender: 'no_preference',
    notes: 'Please bring the shopping list.',
    kind: 'general',
    ...overrides,
  };
}

function shiftImportFields() {
  return [
    ['Portal request ID', 'singleLineText'],
    ['Participant', 'multipleRecordLinks'],
    ['Start', 'dateTime'],
    ['End', 'dateTime'],
    ['Support description', 'multilineText'],
    ['Location', 'singleLineText'],
    ['Driving preference', 'singleSelect'],
    ['Gender preference', 'singleSelect'],
    ['Notes', 'multilineText'],
    ['Support kind', 'singleSelect'],
    ['Status', 'singleSelect'],
    ['Source', 'singleSelect'],
    ['Event', 'multipleRecordLinks'],
    ['Staff name', 'singleLineText'],
    ['Assigned staff', 'multipleRecordLinks'],
    ['Pending change', 'multilineText'],
    ['Portal updated at', 'dateTime'],
  ].map(([name, type], index) => ({ id: `fldShift${index}`, name, type }));
}

test('email/password sessions gate access, reject invalid credentials, and expire on logout', async () => {
  const app = await fixture();
  try {
    const client = app.session();
    assert.equal((await client('GET', '/api/dashboard')).status, 401);
    assert.equal(
      (
        await client('POST', '/api/auth/login', {
          email: 'alex@mtm.demo',
          password: 'incorrect-password',
        })
      ).status,
      401,
    );
    assert.equal((await client('GET', '/api/dashboard')).status, 401);

    await login(client, 'client');
    const dashboard = await client<DashboardData>('GET', '/api/dashboard');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.user.role, 'client');
    assert.deepEqual(new Set(dashboard.body.user.participantIds), new Set(['p-alex', 'p-jamie']));
    assert.equal((await client('POST', '/api/auth/logout')).status, 200);
    assert.equal((await client('GET', '/api/dashboard')).status, 401);
  } finally {
    await app.close();
  }
});

test('client dashboards contain only linked participants and their support records', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    const client = app.session();
    await login(staff, 'staff');
    await login(client, 'client');
    const all = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    const own = (await client<DashboardData>('GET', '/api/dashboard')).body;
    const allowed = new Set(['p-alex', 'p-jamie']);

    assert.ok(all.participants.some((participant) => !allowed.has(participant.id)));
    assert.equal(own.participants.length, allowed.size);
    assert.ok(own.participants.every((participant) => allowed.has(participant.id)));
    assert.ok(own.shifts.length > 0);
    assert.ok(own.shifts.every((shift) => allowed.has(shift.participantId)));
    assert.ok(own.rsvps.every((rsvp) => allowed.has(rsvp.participantId)));
  } finally {
    await app.close();
  }
});

test('a forged browser origin cannot use an authenticated session to mutate support', async () => {
  const app = await fixture();
  try {
    const client = app.session();
    await login(client, 'client');
    const before = (await client<DashboardData>('GET', '/api/dashboard')).body.shifts.length;
    const result = await client('POST', '/api/shifts', input('p-alex'), {
      Origin: 'https://untrusted.example',
    });
    assert.equal(result.status, 403);
    assert.equal((await client<DashboardData>('GET', '/api/dashboard')).body.shifts.length, before);
  } finally {
    await app.close();
  }
});

test('clients cannot request, alter, or approve support outside their linked participants', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    const client = app.session();
    await login(staff, 'staff');
    await login(client, 'client');
    const all = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    const outside = all.shifts.find(
      (shift) => !['p-alex', 'p-jamie'].includes(shift.participantId),
    );
    assert.ok(outside, 'fixture includes support belonging to another participant');
    assert.equal((await client('POST', '/api/shifts', input(outside.participantId))).status, 403);
    assert.equal(
      (
        await client('PATCH', `/api/shifts/${outside.id}`, {
          action: 'edit',
          values: input(outside.participantId),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await client('PATCH', `/api/shifts/${outside.id}`, {
          action: 'cancel',
          reason: 'Not needed',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await client('POST', '/api/participants', {
          name: 'Unauthorized participant',
          supportType: 'both',
          notes: '',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await client('PATCH', `/api/shifts/${outside.id}`, {
          action: 'approve',
          staffId: 's-emma',
        })
      ).status,
      403,
    );
    const own = all.shifts.find((shift) => shift.participantId === 'p-alex');
    assert.ok(own);
    assert.equal(
      (
        await client('PATCH', `/api/shifts/${own.id}`, {
          action: 'edit',
          values: input(outside.participantId),
        })
      ).status,
      403,
    );
    const unchanged = (await staff<DashboardData>('GET', '/api/dashboard')).body.shifts.find(
      (shift) => shift.id === own.id,
    );
    assert.equal(unchanged?.participantId, own.participantId);
  } finally {
    await app.close();
  }
});

test('requests validate their duration and remain pending until a staff member approves', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    const client = app.session();
    await login(staff, 'staff');
    await login(client, 'client');
    const values = input('p-alex');
    assert.equal(
      (await client('POST', '/api/shifts', { ...values, end: values.start })).status,
      400,
    );
    assert.equal(
      (
        await client('POST', '/api/shifts', {
          ...values,
          start: values.end,
          end: values.start,
        })
      ).status,
      400,
    );

    const created = await client<{ shift: Shift }>('POST', '/api/shifts', values);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.shift.status, 'requested');
    assert.equal(created.body.shift.source, 'client');
    assert.equal(created.body.shift.staffId, null);
    assert.equal(
      (
        await client('PATCH', `/api/shifts/${created.body.shift.id}`, {
          action: 'approve',
          staffId: 's-emma',
        })
      ).status,
      400,
    );
    const stillRequested = (await client<DashboardData>('GET', '/api/dashboard')).body.shifts.find(
      (shift) => shift.id === created.body.shift.id,
    );
    assert.equal(stillRequested?.status, 'requested');

    const approved = await staff<{ shift: Shift }>(
      'PATCH',
      `/api/shifts/${created.body.shift.id}`,
      {
        action: 'approve',
        staffId: 's-emma',
      },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.shift.status, 'confirmed');
    assert.equal(approved.body.shift.staffId, 's-emma');
  } finally {
    await app.close();
  }
});

test('confirmed shift edits and cancellations preserve the booking until staff review', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    const client = app.session();
    await login(staff, 'staff');
    await login(client, 'client');
    const original = input('p-alex');
    const created = await client<{ shift: Shift }>('POST', '/api/shifts', original);
    assert.equal(created.status, 201);
    const path = `/api/shifts/${created.body.shift.id}`;
    assert.equal(
      (await staff('PATCH', path, { action: 'approve', staffId: 's-emma' })).status,
      200,
    );

    const revised = input('p-alex', {
      start: new Date(Date.parse(original.start) + 60 * 60 * 1000).toISOString(),
      end: new Date(Date.parse(original.end) + 60 * 60 * 1000).toISOString(),
      description: 'Updated community access request',
    });
    const pendingEdit = await client<{ shift: Shift }>('PATCH', path, {
      action: 'edit',
      values: revised,
    });
    assert.equal(pendingEdit.status, 200, JSON.stringify(pendingEdit.body));
    assert.equal(pendingEdit.body.shift.start, original.start);
    assert.equal(pendingEdit.body.shift.description, original.description);
    assert.equal(pendingEdit.body.shift.status, 'confirmed');
    assert.equal(pendingEdit.body.shift.pendingChange?.type, 'edit');
    assert.equal(pendingEdit.body.shift.pendingChange?.values?.start, revised.start);
    assert.equal((await client('PATCH', path, { action: 'approve_change' })).status, 400);

    const edited = await staff<{ shift: Shift }>('PATCH', path, { action: 'approve_change' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.shift.start, revised.start);
    assert.equal(edited.body.shift.description, revised.description);
    assert.equal(edited.body.shift.pendingChange, null);

    const pendingCancel = await client<{ shift: Shift }>('PATCH', path, {
      action: 'cancel',
      reason: 'Plans changed',
    });
    assert.equal(pendingCancel.status, 200);
    assert.equal(pendingCancel.body.shift.status, 'confirmed');
    assert.equal(pendingCancel.body.shift.pendingChange?.type, 'cancel');
    const rejected = await staff<{ shift: Shift }>('PATCH', path, { action: 'reject_change' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.shift.status, 'confirmed');
    assert.equal(rejected.body.shift.pendingChange, null);

    assert.equal(
      (await client('PATCH', path, { action: 'cancel', reason: 'Transport no longer required' }))
        .status,
      200,
    );
    const cancelled = await staff<{ shift: Shift }>('PATCH', path, { action: 'approve_change' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.shift.status, 'cancelled');
    assert.equal(cancelled.body.shift.pendingChange, null);
    assert.ok(cancelled.body.shift.notes.includes('Transport no longer required'));
  } finally {
    await app.close();
  }
});

async function createEvent(staff: Request): Promise<SupportEvent> {
  const times = input('p-alex');
  const event = await staff<{ event: SupportEvent }>('POST', '/api/events', {
    title: 'Test community picnic',
    start: times.start,
    end: times.end,
    location: 'Community garden',
    description: 'Bring lunch and a hat',
  });
  assert.equal(event.status, 201, JSON.stringify(event.body));
  return event.body.event;
}

test('event RSVPs generate one padded support request only for eligible participants', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    await login(staff, 'staff');
    const dashboard = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    const eligible = dashboard.participants.find((participant) =>
      ['events', 'both'].includes(participant.supportType),
    );
    const ineligible = dashboard.participants.find(
      (participant) => participant.supportType === 'general',
    );
    assert.ok(eligible);
    assert.ok(ineligible);
    const event = await createEvent(staff);
    const path = `/api/events/${event.id}/rsvps`;
    const result = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, {
      participantId: eligible.id,
      status: 'attending',
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.shift.source, 'event');
    assert.equal(result.body.shift.status, 'requested');
    assert.equal(result.body.shift.eventId, event.id);
    assert.equal(result.body.shift.participantId, eligible.id);
    assert.equal(Date.parse(result.body.shift.start), Date.parse(event.start) - 30 * 60 * 1000);
    assert.equal(Date.parse(result.body.shift.end), Date.parse(event.end) + 30 * 60 * 1000);

    const duplicate = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, {
      participantId: eligible.id,
      status: 'attending',
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.rsvp.id, result.body.rsvp.id);
    assert.equal(duplicate.body.shift.id, result.body.shift.id);
    const noSupport = await staff<{ rsvp: Rsvp; shift: Shift | null }>('POST', path, {
      participantId: ineligible.id,
      status: 'attending',
    });
    assert.equal(noSupport.status, 200);
    assert.equal(noSupport.body.shift, null);
    assert.equal(noSupport.body.rsvp.shiftId, null);
    const updated = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(updated.shifts.filter((shift) => shift.eventId === event.id).length, 1);

    const cancelled = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, {
      participantId: eligible.id,
      status: 'cancelled',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.shift.status, 'cancelled');
  } finally {
    await app.close();
  }
});

test('cancelling an RSVP queues staff review for already confirmed event support', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    await login(staff, 'staff');
    const dashboard = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    const participant = dashboard.participants.find((entry) =>
      ['events', 'both'].includes(entry.supportType),
    );
    assert.ok(participant);
    const event = await createEvent(staff);
    const rsvpPath = `/api/events/${event.id}/rsvps`;
    const registered = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', rsvpPath, {
      participantId: participant.id,
      status: 'attending',
    });
    assert.equal(registered.status, 200);
    const shiftPath = `/api/shifts/${registered.body.shift.id}`;
    assert.equal(
      (await staff('PATCH', shiftPath, { action: 'approve', staffId: 's-emma' })).status,
      200,
    );

    const cancelled = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', rsvpPath, {
      participantId: participant.id,
      status: 'cancelled',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.rsvp.status, 'cancelled');
    assert.equal(cancelled.body.shift.status, 'confirmed');
    assert.equal(cancelled.body.shift.pendingChange?.type, 'cancel');
    const approved = await staff<{ shift: Shift }>('PATCH', shiftPath, {
      action: 'approve_change',
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.shift.status, 'cancelled');
  } finally {
    await app.close();
  }
});

test('authenticated RSVP webhooks link Airtable records and queue confirmed event reschedules without duplicates', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    const webhook = app.session();
    await login(staff, 'staff');
    assert.equal(
      (await staff('PATCH', '/api/participants/p-alex', { airtableId: 'recParticipantAlex0001' }))
        .status,
      200,
    );
    const times = input('p-alex');
    const body = {
      rsvpId: 'recRsvpTest0001',
      participantId: 'recParticipantAlex0001',
      eventId: 'recEventTest0001',
      status: 'attending',
      event: {
        title: 'Airtable community dinner',
        start: times.start,
        end: times.end,
        location: 'Community kitchen',
        description: 'Shared meal and conversation',
      },
    };
    const before = (await staff<DashboardData>('GET', '/api/dashboard')).body.events.length;
    assert.equal((await webhook('POST', '/api/webhooks/rsvp', body)).status, 401);
    assert.equal(
      (
        await webhook('POST', '/api/webhooks/rsvp', body, {
          Authorization: 'Bearer incorrect-secret',
        })
      ).status,
      401,
    );
    assert.equal((await staff<DashboardData>('GET', '/api/dashboard')).body.events.length, before);

    const headers = { Authorization: 'Bearer test-rsvp-secret-long' };
    const created = await webhook<{ rsvp: Rsvp; shift: Shift }>(
      'POST',
      '/api/webhooks/rsvp',
      body,
      headers,
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.shift.participantId, 'p-alex');
    assert.equal(Date.parse(created.body.shift.start), Date.parse(times.start) - 30 * 60 * 1000);
    const repeat = await webhook<{ rsvp: Rsvp; shift: Shift }>(
      'POST',
      '/api/webhooks/rsvp',
      body,
      headers,
    );
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.rsvp.id, created.body.rsvp.id);
    assert.equal(repeat.body.shift.id, created.body.shift.id);

    assert.equal(
      (
        await staff('PATCH', `/api/shifts/${created.body.shift.id}`, {
          action: 'approve',
          staffId: 's-emma',
        })
      ).status,
      200,
    );
    const revised = {
      ...body,
      event: {
        ...body.event,
        start: new Date(Date.parse(body.event.start) + 3 * 60 * 60 * 1000).toISOString(),
        end: new Date(Date.parse(body.event.end) + 3 * 60 * 60 * 1000).toISOString(),
      },
    };
    const rescheduled = await webhook<{ rsvp: Rsvp; shift: Shift }>(
      'POST',
      '/api/webhooks/rsvp',
      revised,
      headers,
    );
    assert.equal(rescheduled.status, 200, JSON.stringify(rescheduled.body));
    assert.equal(rescheduled.body.shift.id, created.body.shift.id);
    assert.equal(rescheduled.body.shift.start, created.body.shift.start);
    assert.equal(rescheduled.body.shift.status, 'confirmed');
    assert.equal(rescheduled.body.shift.pendingChange?.type, 'edit');
    assert.equal(
      Date.parse(rescheduled.body.shift.pendingChange!.values!.start),
      Date.parse(revised.event.start) - 30 * 60 * 1000,
    );
    const after = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(after.events.length, before + 1);
    assert.equal(
      after.shifts.filter((shift) => shift.eventId === created.body.rsvp.eventId).length,
      1,
    );

    const approved = await staff<{ shift: Shift }>(
      'PATCH',
      `/api/shifts/${created.body.shift.id}`,
      { action: 'approve_change' },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.shift.start, rescheduled.body.shift.pendingChange!.values!.start);
    assert.equal(approved.body.shift.pendingChange, null);
  } finally {
    await app.close();
  }
});

test('replayed attending RSVPs preserve a client cancellation awaiting staff approval', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    const client = app.session();
    await login(staff, 'staff');
    await login(client, 'client');
    const event = await createEvent(staff);
    const path = `/api/events/${event.id}/rsvps`;
    const attending = { participantId: 'p-alex', status: 'attending' };
    const registered = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, attending);
    assert.equal(registered.status, 200);
    const shiftPath = `/api/shifts/${registered.body.shift.id}`;
    assert.equal(
      (await staff('PATCH', shiftPath, { action: 'approve', staffId: 's-emma' })).status,
      200,
    );
    const cancelled = await client<{ shift: Shift }>('PATCH', shiftPath, {
      action: 'cancel',
      reason: 'Family will provide support',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.shift.pendingChange?.type, 'cancel');

    const replayed = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, attending);
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.shift.status, 'confirmed');
    assert.deepEqual(replayed.body.shift.pendingChange, cancelled.body.shift.pendingChange);
  } finally {
    await app.close();
  }
});

test('staff cannot confirm overlapping shifts for the same support worker', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    const client = app.session();
    await login(staff, 'staff');
    await login(client, 'client');
    const first = await client<{ shift: Shift }>('POST', '/api/shifts', input('p-alex'));
    const second = await client<{ shift: Shift }>('POST', '/api/shifts', input('p-jamie'));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(
      (
        await staff('PATCH', `/api/shifts/${first.body.shift.id}`, {
          action: 'approve',
          staffId: 's-emma',
        })
      ).status,
      200,
    );
    const conflicting = await staff('PATCH', `/api/shifts/${second.body.shift.id}`, {
      action: 'approve',
      staffId: 's-emma',
    });
    assert.equal(conflicting.status, 409);
    const unchanged = (await staff<DashboardData>('GET', '/api/dashboard')).body.shifts.find(
      (shift) => shift.id === second.body.shift.id,
    );
    assert.equal(unchanged?.status, 'requested');
    assert.equal(unchanged?.staffId, null);
    assert.equal(
      (
        await staff('PATCH', `/api/shifts/${second.body.shift.id}`, {
          action: 'approve',
          staffId: 's-james',
        })
      ).status,
      200,
    );
  } finally {
    await app.close();
  }
});

test('enabling event support picks up an existing RSVP and inactive participants remain available to staff requests', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    await login(staff, 'staff');
    const event = await createEvent(staff);
    const registered = await staff<{ rsvp: Rsvp; shift: Shift | null }>(
      'POST',
      `/api/events/${event.id}/rsvps`,
      {
        participantId: 'p-jamie',
        status: 'attending',
      },
    );
    assert.equal(registered.status, 200);
    assert.equal(registered.body.shift, null);
    assert.equal(
      (await staff('PATCH', '/api/participants/p-jamie', { supportType: 'both' })).status,
      200,
    );
    let dashboard = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    const support = dashboard.shifts.filter(
      (shift) => shift.eventId === event.id && shift.participantId === 'p-jamie',
    );
    assert.equal(support.length, 1);
    assert.equal(support[0].status, 'requested');
    assert.equal(
      (await staff('PATCH', '/api/participants/p-jamie', { supportType: 'both' })).status,
      200,
    );
    dashboard = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(
      dashboard.shifts.filter(
        (shift) => shift.eventId === event.id && shift.participantId === 'p-jamie',
      ).length,
      1,
    );

    const inactive = dashboard.participants.find(
      (participant) => participant.supportType === 'none',
    );
    assert.ok(inactive);
    const manual = await staff<{ shift: Shift }>('POST', '/api/shifts', input(inactive.id));
    assert.equal(manual.status, 201);
    assert.equal(manual.body.shift.participantId, inactive.id);
    assert.equal(manual.body.shift.source, 'staff');
  } finally {
    await app.close();
  }
});

test('replayed RSVPs preserve staff declines while a new attendance transition can request support again', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    await login(staff, 'staff');
    const event = await createEvent(staff);
    const path = `/api/events/${event.id}/rsvps`;
    const attending = { participantId: 'p-alex', status: 'attending' };
    const registered = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, attending);
    assert.equal(registered.status, 200);
    assert.equal(
      (await staff('PATCH', `/api/shifts/${registered.body.shift.id}`, { action: 'decline' }))
        .status,
      200,
    );

    const replay = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, attending);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.shift.id, registered.body.shift.id);
    assert.equal(replay.body.shift.status, 'declined');
    assert.equal((await staff('POST', path, { ...attending, status: 'cancelled' })).status, 200);
    const reattending = await staff<{ rsvp: Rsvp; shift: Shift }>('POST', path, attending);
    assert.equal(reattending.status, 200);
    assert.equal(reattending.body.shift.id, registered.body.shift.id);
    assert.equal(reattending.body.shift.status, 'requested');
    assert.equal(reattending.body.shift.staffId, null);
  } finally {
    await app.close();
  }
});

test('sessions and saved bookings survive a database restart, and logout revokes the saved session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-session-test-'));
  const databasePath = join(directory, 'support.sqlite');
  let app: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    app = await fixture({ databasePath });
    const client = app.session();
    const signedIn = await login(client, 'client');
    const cookie = signedIn.response.headers.getSetCookie()[0].split(';')[0];
    const created = await client<{ shift: Shift }>('POST', '/api/shifts', input('p-alex'));
    assert.equal(created.status, 201);
    await app.close();
    app = undefined;

    app = await fixture({ databasePath });
    const resumed = app.session(cookie);
    const dashboard = await resumed<DashboardData>('GET', '/api/dashboard');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.user.email, 'alex@mtm.demo');
    assert.ok(dashboard.body.shifts.some((shift) => shift.id === created.body.shift.id));
    assert.equal((await resumed('POST', '/api/auth/logout')).status, 200);
    assert.equal(
      (await app.session(cookie)('GET', '/api/dashboard')).status,
      401,
      'a copied cookie must be revoked on the server',
    );

    await app.close();
    app = undefined;
    app = await fixture({ databasePath });
    assert.equal(
      (await app.session(cookie)('GET', '/api/dashboard')).status,
      401,
      'revocation survives another restart',
    );
  } finally {
    if (app) await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session renewal invalidates the previous token and the server rejects expired or forged cookies', async (context) => {
  const app = await fixture();
  try {
    const client = app.session();
    const first = await login(client, 'client');
    const originalCookie = first.response.headers.getSetCookie()[0].split(';')[0];
    const second = await login(client, 'client');
    const freshCookie = second.response.headers.getSetCookie()[0].split(';')[0];
    assert.notEqual(freshCookie, originalCookie);
    assert.equal((await app.session(originalCookie)('GET', '/api/auth/me')).status, 401);
    assert.equal((await app.session(freshCookie)('GET', '/api/auth/me')).status, 200);
    assert.equal(
      (await app.session(`mtm_session=${'a'.repeat(64)}`)('GET', '/api/auth/me')).status,
      401,
    );

    const future = Date.now() + 13 * 60 * 60 * 1000;
    context.mock.method(Date, 'now', () => future);
    assert.equal(
      (await app.session(freshCookie)('GET', '/api/auth/me')).status,
      401,
      'server checks expiry independently of browser cookie storage',
    );
  } finally {
    context.mock.restoreAll();
    await app.close();
  }
});

test('all participant, staff, and integration endpoints require authentication before processing data', async () => {
  const app = await fixture();
  try {
    const anonymous = app.session();
    const endpoints: Array<[string, string, unknown?]> = [
      ['GET', '/api/auth/me'],
      ['GET', '/api/dashboard'],
      ['GET', '/api/integrations/airtable/schema'],
      ['POST', '/api/integrations/airtable/import', {}],
      ['POST', '/api/integrations/airtable/sync', {}],
      ['POST', '/api/shifts', input('p-alex')],
      ['PATCH', '/api/shifts/shift-1', { action: 'cancel' }],
      ['POST', '/api/participants', { name: 'New participant', supportType: 'general' }],
      ['PATCH', '/api/participants/p-alex', { supportType: 'none' }],
      ['POST', '/api/events', {}],
      ['POST', '/api/events/event-1/rsvps', { participantId: 'p-alex', status: 'attending' }],
    ];
    for (const [method, path, body] of endpoints) {
      assert.equal(
        (await anonymous(method, path, body)).status,
        401,
        `${method} ${path} requires a session`,
      );
    }
  } finally {
    await app.close();
  }
});

test('production rejects demo mode and insecure origins and sends a secure, HTTP-only session cookie', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-production-auth-test-'));
  const databasePath = join(directory, 'support.sqlite');
  const previousNodeEnv = process.env.NODE_ENV;
  let app: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(
      () =>
        createApp({
          databasePath: ':memory:',
          demoMode: true,
          publicOrigin: 'https://portal.example.test',
        }),
      /DEMO_MODE cannot be enabled in production/,
    );
    assert.throws(
      () =>
        createApp({
          databasePath: ':memory:',
          demoMode: false,
          publicOrigin: 'http://portal.example.test',
        }),
      /HTTPS/,
    );

    const store = new Store(databasePath);
    try {
      store.putUser({
        id: 'u-production-test',
        name: 'Test Coordinator',
        email: 'coordinator@example.test',
        role: 'staff',
        participantIds: [],
        passwordHash: hashPassword(password),
      });
    } finally {
      store.close();
    }
    app = await fixture({
      databasePath,
      demoMode: false,
      publicOrigin: 'https://portal.example.test',
    });
    const staff = app.session();
    const signedIn = await staff('POST', '/api/auth/login', {
      email: 'coordinator@example.test',
      password,
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const cookie = signedIn.response.headers.getSetCookie()[0];
    assert.match(cookie, /^mtm_session=[a-f0-9]{64};/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; Secure(?:;|$)/);
    assert.match(cookie, /; SameSite=Lax(?:;|$)/);
    assert.match(cookie, /; Path=\/(?:;|$)/);
    assert.equal(signedIn.response.headers.get('cache-control'), 'no-store');
    assert.equal(signedIn.response.headers.get('x-frame-options'), 'DENY');
    const dashboard = await staff<DashboardData>('GET', '/api/dashboard');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.demoMode, false);
    assert.equal(dashboard.body.participants.length, 0);
    assert.equal('passwordHash' in (signedIn.body.user as Record<string, unknown>), false);
  } finally {
    if (app) await app.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('demo databases cannot be reopened as a live workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-demo-isolation-test-'));
  const databasePath = join(directory, 'support.sqlite');
  try {
    const demo = await fixture({ databasePath });
    await demo.close();
    assert.throws(
      () => createApp({ databasePath, demoMode: false, publicOrigin: origin }),
      /Demo data cannot be used/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('demo mode cannot seed demo credentials into a populated live workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-live-isolation-test-'));
  const databasePath = join(directory, 'support.sqlite');
  const existing = {
    id: 'p-live',
    name: 'Existing participant',
    initials: 'EP',
    color: 'blue',
    supportType: 'general' as const,
    notes: 'Retain the existing support record',
  };
  try {
    const original = new Store(databasePath);
    try {
      original.put('participants', existing);
    } finally {
      original.close();
    }
    assert.throws(
      () => createApp({ databasePath, demoMode: true, publicOrigin: origin }),
      /DEMO_MODE cannot open an existing live workspace/,
    );
    const reopened = new Store(databasePath);
    try {
      assert.deepEqual(reopened.all('participants'), [existing]);
      assert.equal(reopened.findUser('coordinator@mtm.demo'), undefined);
      assert.equal(reopened.findUser('alex@mtm.demo'), undefined);
      assert.equal(reopened.meta('demoDatabase'), undefined);
      assert.equal(reopened.meta('demoSeeded'), undefined);
      assert.equal(reopened.all('shifts').length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('initial Airtable import creates upcoming support once, preserves staff decisions, and rejects invalid snapshots atomically', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-import-test-'));
  const databasePath = join(directory, 'support.sqlite');
  const configuration: Record<string, string> = {
    AIRTABLE_PAT: 'local-test-token',
    AIRTABLE_BASE_ID: 'appTestImport001',
    AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
    AIRTABLE_EVENTS_TABLE: 'Events',
    AIRTABLE_RSVPS_TABLE: 'RSVPs',
    AIRTABLE_SHIFTS_TABLE: 'Shift Requests',
    AIRTABLE_FIELD_MAP: '',
    AIRTABLE_STAFF_RECORD_MAP: '',
    AIRTABLE_SUPPORT_TYPE_MAP: '',
    AIRTABLE_RSVP_STATUS_MAP: '',
    AIRTABLE_SYNC_ENABLED: 'false',
  };
  const previous = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  const eligibleId = `rec${'A'.repeat(14)}`;
  const generalId = `rec${'B'.repeat(14)}`;
  const futureEventId = `rec${'C'.repeat(14)}`;
  const pastEventId = `rec${'D'.repeat(14)}`;
  const upcoming = input('unused');
  const pastStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const pastEnd = new Date(Date.parse(pastStart) + 2 * 60 * 60 * 1000).toISOString();
  type ExternalRecord = { id: string; fields: Record<string, unknown> };
  const records: Record<string, ExternalRecord[]> = {
    Participants: [
      { id: eligibleId, fields: { Name: 'Avery Example', 'Support type': 'Both' } },
      { id: generalId, fields: { Name: 'Casey Example', 'Support type': 'General' } },
    ],
    Events: [
      {
        id: futureEventId,
        fields: {
          Name: 'Upcoming picnic',
          Start: upcoming.start,
          End: upcoming.end,
          Location: 'Community park',
        },
      },
      {
        id: pastEventId,
        fields: {
          Name: 'Previous picnic',
          Start: pastStart,
          End: pastEnd,
          Location: 'Community park',
        },
      },
    ],
    RSVPs: [
      {
        id: `rec${'E'.repeat(14)}`,
        fields: {
          Participant: [eligibleId, generalId],
          Event: [futureEventId],
          Status: 'Attending',
        },
      },
      {
        id: `rec${'F'.repeat(14)}`,
        fields: { Participant: [eligibleId], Event: [pastEventId], Status: 'Attending' },
      },
    ],
    'Shift Requests': [],
  };
  const schema = {
    tables: [
      {
        id: 'tblParticipants',
        name: 'Participants',
        fields: [
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldSupport', name: 'Support type', type: 'singleSelect' },
        ],
      },
      {
        id: 'tblEvents',
        name: 'Events',
        fields: [
          { id: 'fldEventName', name: 'Name', type: 'singleLineText' },
          { id: 'fldStart', name: 'Start', type: 'dateTime' },
          { id: 'fldEnd', name: 'End', type: 'dateTime' },
          { id: 'fldLocation', name: 'Location', type: 'singleLineText' },
        ],
      },
      {
        id: 'tblRsvps',
        name: 'RSVPs',
        fields: [
          { id: 'fldParticipant', name: 'Participant', type: 'multipleRecordLinks' },
          { id: 'fldEvent', name: 'Event', type: 'multipleRecordLinks' },
          { id: 'fldStatus', name: 'Status', type: 'singleSelect' },
        ],
      },
      { id: 'tblShifts', name: 'Shift Requests', fields: shiftImportFields() },
    ],
  };
  const fetchOriginal = globalThis.fetch;
  let app: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    Object.assign(process.env, configuration);
    context.mock.method(
      globalThis,
      'fetch',
      async (resource: string | URL | globalThis.Request, init?: RequestInit) => {
        const url = new URL(
          typeof resource === 'string'
            ? resource
            : resource instanceof URL
              ? resource.href
              : resource.url,
        );
        if (url.hostname !== 'api.airtable.com') return fetchOriginal(resource, init);
        assert.equal(init?.method ?? 'GET', 'GET', 'initial import must never write to Airtable');
        if (url.pathname.startsWith('/v0/meta/bases/')) return Response.json(schema);
        const table = decodeURIComponent(url.pathname.split('/').at(-1)!);
        assert.ok(records[table], `unexpected Airtable table: ${table}`);
        return Response.json({ records: records[table] });
      },
    );
    const store = new Store(databasePath);
    try {
      store.putUser({
        id: 'u-import-test',
        name: 'Import Coordinator',
        email: 'coordinator@example.test',
        role: 'staff',
        participantIds: [],
        passwordHash: hashPassword(password),
      });
    } finally {
      store.close();
    }
    app = await fixture({ databasePath, demoMode: false });
    const staff = app.session();
    assert.equal(
      (await staff('POST', '/api/auth/login', { email: 'coordinator@example.test', password }))
        .status,
      200,
    );

    const imported = await staff('POST', '/api/integrations/airtable/import', {});
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    for (const [key, expected] of Object.entries({
      participants: 2,
      events: 2,
      rsvps: 3,
      requests: 1,
      preserved: 0,
    })) {
      assert.equal(imported.body[key], expected, key);
    }
    const first = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(first.shifts.length, 1);
    const participant = first.participants.find((person) => person.airtableId === eligibleId)!;
    const futureEvent = first.events.find((event) => event.title === 'Upcoming picnic')!;
    assert.equal(first.shifts[0].participantId, participant.id);
    assert.equal(first.shifts[0].eventId, futureEvent.id);
    assert.equal(Date.parse(first.shifts[0].start), Date.parse(upcoming.start) - 30 * 60 * 1000);
    assert.equal(
      first.rsvps.filter((rsvp) => rsvp.shiftId === null).length,
      2,
      'general-only and historical attendance do not create support',
    );

    assert.equal(
      (await staff('PATCH', `/api/participants/${participant.id}`, { supportType: 'none' })).status,
      200,
    );
    assert.equal(
      (await staff('PATCH', `/api/shifts/${first.shifts[0].id}`, { action: 'decline' })).status,
      200,
    );
    records.Participants[0].fields.Name = 'External rename should not overwrite';
    records.Events[0].fields.Start = new Date(
      Date.parse(upcoming.start) + 60 * 60 * 1000,
    ).toISOString();
    const repeated = await staff('POST', '/api/integrations/airtable/import', {});
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    for (const key of ['participants', 'events', 'rsvps', 'requests'])
      assert.equal(repeated.body[key], 0, key);
    assert.equal(repeated.body.preserved, 7);
    const preserved = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(
      preserved.participants.find((person) => person.id === participant.id)?.supportType,
      'none',
    );
    assert.equal(
      preserved.participants.find((person) => person.id === participant.id)?.name,
      'Avery Example',
    );
    assert.equal(preserved.shifts[0].status, 'declined');
    assert.equal(
      preserved.events.find((event) => event.id === futureEvent.id)?.start,
      upcoming.start,
    );

    records.Participants.push({
      id: `rec${'G'.repeat(14)}`,
      fields: { Name: 'Invalid import entry', 'Support type': 'Unmapped value' },
    });
    const invalid = await staff('POST', '/api/integrations/airtable/import', {});
    assert.equal(invalid.status, 502);
    const unchanged = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.deepEqual(unchanged.participants, preserved.participants);
    assert.deepEqual(unchanged.events, preserved.events);
    assert.deepEqual(unchanged.rsvps, preserved.rsvps);
    assert.deepEqual(unchanged.shifts, preserved.shifts);
  } finally {
    if (app) await app.close();
    context.mock.restoreAll();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed Airtable writes survive restart, respect retry backoff, and retry the same upsert without exposing external errors', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-outbox-test-'));
  const databasePath = join(directory, 'support.sqlite');
  const configuration: Record<string, string> = {
    AIRTABLE_PAT: 'test-outbox-token',
    AIRTABLE_BASE_ID: 'appTestOutbox001',
    AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
    AIRTABLE_EVENTS_TABLE: 'Events',
    AIRTABLE_RSVPS_TABLE: 'RSVPs',
    AIRTABLE_SHIFTS_TABLE: 'Shift Requests',
    AIRTABLE_FIELD_MAP: '',
    AIRTABLE_STAFF_RECORD_MAP: '',
    AIRTABLE_SUPPORT_TYPE_MAP: '',
    AIRTABLE_RSVP_STATUS_MAP: '',
  };
  const previous = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  const fetchOriginal = globalThis.fetch;
  const writes: Array<{
    performUpsert: { fieldsToMergeOn: string[] };
    records: Array<{ fields: Record<string, unknown> }>;
  }> = [];
  const sensitiveExternalDetail = 'test-secret-and-private-participant-detail';
  let app: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    Object.assign(process.env, configuration);
    context.mock.method(
      globalThis,
      'fetch',
      async (resource: string | URL | globalThis.Request, init?: RequestInit) => {
        const url = new URL(
          typeof resource === 'string'
            ? resource
            : resource instanceof URL
              ? resource.href
              : resource.url,
        );
        if (url.hostname !== 'api.airtable.com') return fetchOriginal(resource, init);
        assert.equal(init?.method, 'PATCH');
        assert.equal(decodeURIComponent(url.pathname), '/v0/appTestOutbox001/Shift Requests');
        writes.push(JSON.parse(String(init?.body)));
        if (writes.length === 1)
          return Response.json({ error: { message: sensitiveExternalDetail } }, { status: 422 });
        return Response.json({ records: [{ id: `rec${'Z'.repeat(14)}` }] });
      },
    );
    const store = new Store(databasePath);
    try {
      store.putUser({
        id: 'u-outbox-test',
        name: 'Sync Coordinator',
        email: 'coordinator@example.test',
        role: 'staff',
        participantIds: [],
        passwordHash: hashPassword(password),
      });
      store.put('participants', {
        id: 'p-outbox-test',
        name: 'Test Participant',
        initials: 'TP',
        color: 'blue',
        supportType: 'general',
        notes: '',
        airtableId: `rec${'P'.repeat(14)}`,
      });
    } finally {
      store.close();
    }
    app = await fixture({ databasePath, demoMode: false, enableSync: true });
    let staff = app.session();
    assert.equal(
      (await staff('POST', '/api/auth/login', { email: 'coordinator@example.test', password }))
        .status,
      200,
    );
    const created = await staff<{ shift: Shift }>('POST', '/api/shifts', input('p-outbox-test'));
    assert.equal(created.status, 201);
    assert.equal(created.body.shift.syncStatus, 'pending');
    const failed = await staff('POST', '/api/integrations/airtable/sync', {});
    assert.equal(failed.status, 200);
    assert.equal(failed.body.failed, 1);
    assert.equal(writes.length, 1);
    assert.ok(!JSON.stringify(failed.body).includes(sensitiveExternalDetail));
    const queued = app.store.db
      .prepare('SELECT attempts,last_error,next_attempt FROM outbox WHERE shift_id=?')
      .get(created.body.shift.id) as { attempts: number; last_error: string; next_attempt: number };
    assert.equal(queued.attempts, 1);
    assert.ok(queued.next_attempt > Date.now());
    assert.ok(!queued.last_error.includes(sensitiveExternalDetail));
    await app.close();
    app = undefined;

    app = await fixture({ databasePath, demoMode: false, enableSync: true });
    staff = app.session();
    assert.equal(
      (await staff('POST', '/api/auth/login', { email: 'coordinator@example.test', password }))
        .status,
      200,
    );
    const persisted = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(persisted.integration.pending, 1);
    assert.equal(persisted.integration.failed, 1);
    assert.equal(persisted.shifts[0].syncStatus, 'failed');
    assert.ok(!JSON.stringify(persisted).includes(sensitiveExternalDetail));
    assert.ok(!JSON.stringify(persisted).includes(configuration.AIRTABLE_PAT));
    const tooSoon = await staff('POST', '/api/integrations/airtable/sync', {});
    assert.equal(tooSoon.status, 200);
    assert.equal(tooSoon.body.synced, 0);
    assert.equal(writes.length, 1, 'manual sync respects the durable retry deadline');

    // Simulate the retry deadline passing after the external configuration is corrected.
    app.store.db
      .prepare('UPDATE outbox SET next_attempt=0 WHERE shift_id=?')
      .run(created.body.shift.id);
    const retried = await staff('POST', '/api/integrations/airtable/sync', {});
    assert.equal(retried.status, 200);
    assert.equal(retried.body.synced, 1);
    assert.equal(retried.body.failed, 0);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].performUpsert, { fieldsToMergeOn: ['Portal request ID'] });
    assert.equal(writes[0].records[0].fields['Portal request ID'], created.body.shift.id);
    assert.equal(writes[1].records[0].fields['Portal request ID'], created.body.shift.id);
    const synced = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(synced.integration.pending, 0);
    assert.equal(synced.integration.failed, 0);
    assert.equal(synced.integration.synced, 1);
    assert.equal(synced.shifts[0].syncStatus, 'synced');
  } finally {
    if (app) await app.close();
    context.mock.restoreAll();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('staff can request a confirmed shift change and retain the reason when cancelling', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    await login(staff, 'staff');
    const original = input('p-alex');
    const created = await staff<{ shift: Shift }>('POST', '/api/shifts', {
      ...original,
      status: 'confirmed',
      staffId: 's-emma',
    });
    assert.equal(created.status, 201);
    const path = `/api/shifts/${created.body.shift.id}`;
    const revised = {
      ...original,
      start: new Date(Date.parse(original.start) + 2 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.parse(original.end) + 2 * 60 * 60 * 1000).toISOString(),
    };
    const pending = await staff<{ shift: Shift }>('PATCH', path, {
      action: 'edit',
      values: revised,
    });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.shift.start, original.start);
    assert.equal(pending.body.shift.pendingChange?.values?.start, revised.start);
    const approved = await staff<{ shift: Shift }>('PATCH', path, { action: 'approve_change' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.shift.start, revised.start);
    assert.equal(approved.body.shift.pendingChange, null);
    const cancelled = await staff<{ shift: Shift }>('PATCH', path, {
      action: 'cancel',
      reason: 'Participant arranged alternative transport',
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.shift.status, 'cancelled');
    assert.ok(cancelled.body.shift.notes.includes('Participant arranged alternative transport'));
  } finally {
    await app.close();
  }
});

test('existing Airtable bookings import before RSVPs, retain assignments, and update their original records without duplicates', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-booking-import-test-'));
  const databasePath = join(directory, 'support.sqlite');
  const configuration: Record<string, string> = {
    AIRTABLE_PAT: 'local-booking-import-token',
    AIRTABLE_BASE_ID: 'appBookingImport001',
    AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
    AIRTABLE_EVENTS_TABLE: 'Events',
    AIRTABLE_RSVPS_TABLE: 'RSVPs',
    AIRTABLE_SHIFTS_TABLE: 'Shift Requests',
    AIRTABLE_FIELD_MAP: JSON.stringify({ shifts: { staff: 'Assigned staff' } }),
    AIRTABLE_STAFF_RECORD_MAP: '',
    AIRTABLE_SUPPORT_TYPE_MAP: '',
    AIRTABLE_RSVP_STATUS_MAP: '',
    AIRTABLE_SHIFT_STATUS_MAP: '',
  };
  const previous = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  const participantId = `rec${'A'.repeat(14)}`;
  const eventId = `rec${'B'.repeat(14)}`;
  const generalRecordId = `rec${'C'.repeat(14)}`;
  const eventRecordId = `rec${'D'.repeat(14)}`;
  const workerId = `rec${'S'.repeat(14)}`;
  const eventTimes = input('unused');
  const generalStart = new Date(Date.parse(eventTimes.start) - 6 * 60 * 60 * 1000).toISOString();
  const generalEnd = new Date(Date.parse(generalStart) + 2 * 60 * 60 * 1000).toISOString();
  const bookedEventStart = new Date(Date.parse(eventTimes.start) - 45 * 60 * 1000).toISOString();
  const bookedEventEnd = new Date(Date.parse(eventTimes.end) + 15 * 60 * 1000).toISOString();
  type ExternalRecord = { id: string; fields: Record<string, unknown> };
  const generalFields: Record<string, unknown> = {
    'Portal request ID': 'shift-board-general',
    Participant: [participantId],
    Start: generalStart,
    End: generalEnd,
    'Support description': 'Existing weekly support',
    Location: 'Home',
    'Driving preference': 'Required',
    'Gender preference': 'Female',
    Notes: 'Bring the shopping list',
    'Support kind': 'General',
    Status: 'Confirmed',
    Source: 'Staff',
    'Assigned staff': [workerId],
    'Staff name': 'Casey Support',
  };
  const eventFields: Record<string, unknown> = {
    'Portal request ID': 'shift-board-event',
    Participant: [participantId],
    Event: [eventId],
    Start: bookedEventStart,
    End: bookedEventEnd,
    'Support description': 'Previously approved picnic support',
    Location: 'Community park',
    'Driving preference': 'Not required',
    'Gender preference': 'No preference',
    Notes: 'Keep the agreed transport times',
    'Support kind': 'Event',
    Status: 'Confirmed',
    Source: 'Event',
    'Assigned staff': [workerId],
    'Staff name': 'Casey Support',
  };
  const nameOnlyFields: Record<string, unknown> = {
    ...generalFields,
    'Portal request ID': '',
    'Assigned staff': [],
    'Staff name': 'Robin Support',
    'Support description': 'Name-only legacy shift',
    Start: new Date(Date.parse(generalStart) - 8 * 60 * 60 * 1000).toISOString(),
    End: new Date(Date.parse(generalEnd) - 8 * 60 * 60 * 1000).toISOString(),
  };
  const records: Record<string, ExternalRecord[]> = {
    Participants: [
      { id: participantId, fields: { Name: 'Avery Example', 'Support type': 'Both' } },
    ],
    Events: [
      {
        id: eventId,
        fields: { Name: 'Upcoming picnic', Start: eventTimes.start, End: eventTimes.end },
      },
    ],
    RSVPs: [
      {
        id: `rec${'R'.repeat(14)}`,
        fields: { Participant: [participantId], Event: [eventId], Status: 'Attending' },
      },
    ],
    'Shift Requests': [
      { id: generalRecordId, fields: generalFields },
      { id: eventRecordId, fields: eventFields },
      { id: `rec${'L'.repeat(14)}`, fields: nameOnlyFields },
    ],
  };
  const schema = {
    tables: [
      {
        id: 'tblParticipants',
        name: 'Participants',
        fields: [
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldSupport', name: 'Support type', type: 'singleSelect' },
        ],
      },
      {
        id: 'tblEvents',
        name: 'Events',
        fields: [
          { id: 'fldEventName', name: 'Name', type: 'singleLineText' },
          { id: 'fldStart', name: 'Start', type: 'dateTime' },
          { id: 'fldEnd', name: 'End', type: 'dateTime' },
        ],
      },
      {
        id: 'tblRsvps',
        name: 'RSVPs',
        fields: [
          { id: 'fldParticipant', name: 'Participant', type: 'multipleRecordLinks' },
          { id: 'fldEvent', name: 'Event', type: 'multipleRecordLinks' },
          { id: 'fldStatus', name: 'Status', type: 'singleSelect' },
        ],
      },
      { id: 'tblShifts', name: 'Shift Requests', fields: shiftImportFields() },
    ],
  };
  const writes: Array<{ records: Array<{ id?: string; fields: Record<string, unknown> }> }> = [];
  const fetchOriginal = globalThis.fetch;
  let app: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    Object.assign(process.env, configuration);
    context.mock.method(
      globalThis,
      'fetch',
      async (resource: string | URL | globalThis.Request, init?: RequestInit) => {
        const url = new URL(
          typeof resource === 'string'
            ? resource
            : resource instanceof URL
              ? resource.href
              : resource.url,
        );
        if (url.hostname !== 'api.airtable.com') return fetchOriginal(resource, init);
        if (init?.method === 'PATCH') {
          const payload = JSON.parse(String(init.body));
          writes.push(payload);
          return Response.json({ records: [{ id: payload.records[0].id }] });
        }
        assert.equal(init?.method ?? 'GET', 'GET');
        if (url.pathname.startsWith('/v0/meta/bases/')) return Response.json(schema);
        const table = decodeURIComponent(url.pathname.split('/').at(-1)!);
        assert.ok(records[table]);
        return Response.json({ records: records[table] });
      },
    );
    const store = new Store(databasePath);
    try {
      store.putUser({
        id: 'u-booking-import-test',
        name: 'Import Coordinator',
        email: 'coordinator@example.test',
        role: 'staff',
        participantIds: [],
        passwordHash: hashPassword(password),
      });
    } finally {
      store.close();
    }
    app = await fixture({ databasePath, demoMode: false, enableSync: true });
    const staff = app.session();
    assert.equal(
      (await staff('POST', '/api/auth/login', { email: 'coordinator@example.test', password }))
        .status,
      200,
    );
    const imported = await staff('POST', '/api/integrations/airtable/import', {});
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.shifts, 3);
    assert.equal(
      imported.body.requests,
      0,
      'existing event support must be reused before processing RSVPs',
    );
    const first = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(first.shifts.length, 3);
    assert.equal(first.rsvps.length, 1);
    const general = first.shifts.find((shift) => shift.description === 'Existing weekly support')!;
    const eventShift = first.shifts.find((shift) => shift.kind === 'event')!;
    const nameOnly = first.shifts.find((shift) => shift.description === 'Name-only legacy shift')!;
    assert.equal(nameOnly.staffId, null);
    assert.equal(nameOnly.staffDisplayName, 'Robin Support');
    assert.equal(general.status, 'confirmed');
    assert.equal(general.driving, 'required');
    assert.equal(general.gender, 'female');
    assert.equal(general.notes, 'Bring the shopping list');
    assert.equal(eventShift.status, 'confirmed');
    assert.equal(eventShift.start, bookedEventStart);
    assert.equal(eventShift.end, bookedEventEnd);
    assert.equal(eventShift.pendingChange, null);
    assert.equal(first.rsvps[0].shiftId, eventShift.id);
    assert.equal(
      first.staff.length,
      1,
      'matching linked staff record IDs identify one support worker',
    );
    assert.equal(first.staff[0].name, 'Casey Support');
    assert.equal(first.staff[0].airtableId, workerId);
    assert.equal(general.staffId, first.staff[0].id);
    assert.equal(eventShift.staffId, first.staff[0].id);
    assert.equal(
      first.integration.pending,
      0,
      'imported records do not immediately queue external writes',
    );
    assert.equal((await staff('POST', '/api/integrations/airtable/sync', {})).body.synced, 0);
    assert.equal(writes.length, 0);

    const revised = input(general.participantId, {
      start: new Date(Date.parse(general.start) - 60 * 60 * 1000).toISOString(),
      end: new Date(Date.parse(general.end) - 60 * 60 * 1000).toISOString(),
      description: 'Coordinator-approved revised support',
    });
    assert.equal(
      (await staff('PATCH', `/api/shifts/${general.id}`, { action: 'edit', values: revised }))
        .status,
      200,
    );
    assert.equal(
      (await staff('PATCH', `/api/shifts/${general.id}`, { action: 'approve_change' })).status,
      200,
    );
    const repeated = await staff('POST', '/api/integrations/airtable/import', {});
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.shifts, 0);
    assert.equal(repeated.body.requests, 0);
    const preserved = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(preserved.shifts.length, 3);
    assert.equal(preserved.shifts.find((shift) => shift.id === general.id)?.start, revised.start);
    assert.equal(
      preserved.shifts.find((shift) => shift.id === general.id)?.description,
      revised.description,
    );
    const synced = await staff('POST', '/api/integrations/airtable/sync', {});
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    assert.equal(synced.body.synced, 1);
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0].records[0].id,
      generalRecordId,
      'editing an imported booking updates its original Airtable row',
    );
    assert.deepEqual(writes[0].records[0].fields['Assigned staff'], [workerId]);
    assert.equal(writes[0].records[0].fields.Start, revised.start);
    const unassigned = await staff<{ shift: Shift }>('PATCH', `/api/shifts/${nameOnly.id}`, {
      action: 'assign',
      staffId: null,
    });
    assert.equal(unassigned.status, 200);
    assert.equal(unassigned.body.shift.staffId, null);
    assert.equal(
      unassigned.body.shift.staffDisplayName,
      undefined,
      'an explicit staff assignment clears the imported display name',
    );

    const beforeInvalid = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    records.Participants.push({
      id: `rec${'N'.repeat(14)}`,
      fields: { Name: 'Must not be partly imported', 'Support type': 'General' },
    });
    records['Shift Requests'].push({
      id: `rec${'X'.repeat(14)}`,
      fields: { ...eventFields, 'Portal request ID': 'shift-duplicate-event' },
    });
    const ambiguous = await staff('POST', '/api/integrations/airtable/import', {});
    assert.ok(
      [409, 422, 502].includes(ambiguous.status),
      `ambiguous event/participant support is rejected, received ${ambiguous.status}`,
    );
    const afterInvalid = (await staff<DashboardData>('GET', '/api/dashboard')).body;
    assert.deepEqual(afterInvalid.participants, beforeInvalid.participants);
    assert.deepEqual(afterInvalid.shifts, beforeInvalid.shifts);
    assert.deepEqual(afterInvalid.rsvps, beforeInvalid.rsvps);
    assert.deepEqual(afterInvalid.staff, beforeInvalid.staff);
  } finally {
    if (app) await app.close();
    context.mock.restoreAll();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('coordinators manage assignable workers without granting login access or replacing linked identities', async () => {
  const app = await fixture();
  try {
    const staff = app.session(),
      client = app.session();
    await login(staff, 'staff');
    await login(client, 'client');
    const values = { name: 'Fictional New Worker', airtableId: 'rec55555555555555' };
    assert.equal((await client('POST', '/api/workers', values)).status, 403);
    assert.equal((await staff('POST', '/api/workers', { ...values, role: 'staff' })).status, 400);
    const count = app.store.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n;
    const result = await staff<{ worker: { id: string } }>('POST', '/api/workers', values);
    assert.equal(result.status, 201);
    const id = result.body.worker.id;
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n, count);
    assert.equal((await staff('POST', '/api/workers', values)).status, 409);
    assert.equal(
      (
        await staff('PATCH', `/api/workers/${id}`, {
          name: values.name,
          airtableId: 'rec66666666666666',
        })
      ).status,
      409,
    );
    const request = await staff<{ shift: Shift }>('POST', '/api/shifts', {
      ...input('p-alex'),
      staffId: id,
      status: 'confirmed',
    });
    assert.equal(request.status, 201);
    assert.equal(request.body.shift.staffId, id);
    assert.equal(
      (await staff('PATCH', `/api/workers/${id}`, { ...values, name: 'Fictional Renamed Worker' }))
        .status,
      200,
    );
    assert.equal(app.store.get('staff', id)?.name, 'Fictional Renamed Worker');
    assert.ok(
      app.store.db
        .prepare('SELECT shift_id FROM outbox WHERE shift_id=?')
        .get(request.body.shift.id),
    );
  } finally {
    await app.close();
  }
});
