import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth.ts';
import { newShift } from '../domain.ts';
import { Store } from '../db.ts';
import type { DashboardData, Shift, ShiftUpdate } from '../../shared/types.ts';

const password = 'Worker-test-password!2026';
const origin = 'http://localhost:5173';
const content = () => ({
  version: 0,
  activities: 'Visited the library.',
  howItWent: 'Chose books independently.',
  feedbackProvided: true,
  participantFeedback: 'I would like to go again.',
  goals: [
    {
      goal: 'Independent choices',
      progress: 'progress',
      evidence: 'Selected two books with one prompt.',
    },
  ],
  noGoalWork: false,
  noGoalReason: '',
  nextTime: 'Allow more browsing time.',
  internal: {
    notes: 'PRIVATE_HANDOVER',
    followUpRequired: true,
    followUpNotes: 'PRIVATE_FOLLOWUP',
    incidentReference: 'PRIVATE_INCIDENT',
  },
});

test('post-shift form accepts bounded Unicode content and rejects oversized bodies', async () => {
  const f = await fixture();
  try {
    const worker = await f.login('worker');
    const report = content();
    report.activities = '本'.repeat(3000);
    report.howItWent = '本'.repeat(3000);
    report.participantFeedback = '本'.repeat(2000);
    report.goals = Array.from({ length: 8 }, () => ({
      goal: '本'.repeat(200),
      progress: 'practised',
      evidence: '本'.repeat(1500),
    }));
    report.nextTime = '本'.repeat(2000);
    report.internal.notes = '本'.repeat(3000);
    report.internal.followUpNotes = '本'.repeat(2000);
    assert(Buffer.byteLength(JSON.stringify(report)) > 32 * 1024);
    assert.equal((await worker('PUT', '/api/shifts/finished/update', report)).status, 201);
    assert.equal(
      (
        await worker('PUT', '/api/shifts/finished/update', {
          ...report,
          version: 1,
          activities: 'x'.repeat(270000),
        })
      ).status,
      413,
    );
    assert.equal((await worker('POST', '/api/shifts', { notes: 'x'.repeat(33000) })).status, 413);
  } finally {
    await f.stop();
  }
});
async function fixture(databasePath = ':memory:') {
  const runtime = createApp({
    databasePath,
    demoMode: false,
    enableSync: false,
    publicOrigin: origin,
  });
  for (const id of ['one', 'two']) {
    runtime.store.put('staff', {
      id: `worker-${id}`,
      name: `Worker ${id}`,
      initials: 'W',
      color: 'blue',
      active: true,
    });
    runtime.store.put('participants', {
      id: `p-${id}`,
      name: `Participant ${id}`,
      initials: 'P',
      color: 'blue',
      notes: 'PRIVATE_PARTICIPANT',
      supportType: 'both',
    });
  }
  const hash = hashPassword(password);
  for (const user of [
    { id: 'coordinator', name: 'Coordinator', role: 'staff' as const, participantIds: [] },
    {
      id: 'worker',
      name: 'Worker One',
      role: 'worker' as const,
      participantIds: [],
      workerId: 'worker-one',
    },
    {
      id: 'other-worker',
      name: 'Worker Two',
      role: 'worker' as const,
      participantIds: [],
      workerId: 'worker-two',
    },
    { id: 'parent', name: 'Parent', role: 'client' as const, participantIds: ['p-one'] },
    {
      id: 'other-parent',
      name: 'Other Parent',
      role: 'client' as const,
      participantIds: ['p-two'],
    },
  ])
    runtime.store.putUser({ ...user, email: `${user.id}@example.test`, passwordHash: hash });
  const ended = Date.now() - 86400000;
  const shift = (
    id: string,
    participantId: string,
    staffId: string,
    status: Shift['status'] = 'confirmed',
    when = ended,
  ) =>
    newShift(
      {
        participantId,
        start: new Date(when - 3600000).toISOString(),
        end: new Date(when).toISOString(),
        description: id,
        location: '',
        notes: '',
        kind: 'general',
        driving: 'no_preference',
        gender: 'no_preference',
      },
      'staff',
      false,
      { id, staffId, status },
    );
  for (const s of [
    shift('finished', 'p-one', 'worker-one'),
    shift('same-participant-other-worker', 'p-one', 'worker-two'),
    shift('other-participant', 'p-two', 'worker-two'),
    shift('future', 'p-one', 'worker-one', 'confirmed', Date.now() + 86400000),
    shift('requested', 'p-one', 'worker-one', 'requested'),
    shift('cancelled', 'p-one', 'worker-one', 'cancelled'),
  ])
    runtime.store.put('shifts', s);
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function session() {
    let cookie = '';
    return async <T = any>(
      method: string,
      path: string,
      body?: unknown,
      requestOrigin = origin,
    ): Promise<{ status: number; body: T }> => {
      const response = await fetch(base + path, {
        method,
        headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const next = response.headers.getSetCookie();
      if (next.length) cookie = next.map((value) => value.split(';')[0]).join('; ');
      return { status: response.status, body: await response.json() };
    };
  }
  async function login(id: string) {
    const request = session();
    const result = await request('POST', '/api/auth/login', {
      email: `${id}@example.test`,
      password,
    });
    assert.equal(result.status, 200);
    return request;
  }
  return {
    ...runtime,
    session,
    login,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
    },
  };
}

test('worker invitations bind one active roster identity and never grant coordinator or participant-wide access', async () => {
  const app = await fixture();
  try {
    const coordinator = await app.login('coordinator');
    app.store.put('staff', {
      id: 'new-worker',
      name: 'New Worker',
      initials: 'NW',
      color: 'blue',
      active: true,
    });
    const invite = {
      name: 'New Worker',
      email: 'new@example.test',
      role: 'worker',
      participantIds: [],
      workerId: 'new-worker',
    };
    assert.equal(
      (await (await app.login('worker'))('POST', '/api/accounts/invitations', invite)).status,
      403,
    );
    assert.equal(
      (await coordinator('POST', '/api/accounts/invitations', { ...invite, workerId: 'missing' }))
        .status,
      400,
    );
    assert.equal(
      (
        await coordinator('POST', '/api/accounts/invitations', {
          ...invite,
          participantIds: ['p-one'],
        })
      ).status,
      400,
    );
    assert.equal(
      (await coordinator('POST', '/api/accounts/invitations', { ...invite, role: 'staff' })).status,
      400,
    );
    const result = await coordinator('POST', '/api/accounts/invitations', invite);
    assert.equal(result.status, 201);
    assert.equal(
      (
        await coordinator('POST', '/api/accounts/invitations', {
          ...invite,
          email: 'duplicate@example.test',
        })
      ).status,
      409,
    );
    const token = new URL(result.body.url).hash.slice('#invite='.length);
    app.store.put('staff', { ...app.store.get('staff', 'new-worker')!, active: false });
    assert.equal(
      (await app.session()('POST', '/api/auth/invitations/accept', { token, password })).status,
      403,
    );
    app.store.put('staff', { ...app.store.get('staff', 'new-worker')!, active: true });
    const worker = app.session();
    assert.equal(
      (await worker('POST', '/api/auth/invitations/accept', { token, password })).status,
      200,
    );
    const dashboard = (await worker<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(dashboard.user.role, 'worker');
    assert.equal(dashboard.user.workerId, 'new-worker');
    assert.deepEqual(dashboard.shifts, []);
    assert.deepEqual(dashboard.participants, []);
    assert.equal(
      app.store.all('staff').length,
      3,
      'activation must not create another roster worker',
    );
    const account = app.store.findUser('new@example.test')!;
    assert.equal(
      (await coordinator('PATCH', `/api/accounts/${account.id}`, { workerId: 'worker-two' }))
        .status,
      400,
    );
    assert.equal(
      (await coordinator('PATCH', `/api/accounts/${account.id}`, { participantIds: ['p-one'] }))
        .status,
      400,
    );
    const reset = await coordinator('POST', `/api/accounts/${account.id}/reset`);
    const newPassword = password + '-reset';
    assert.equal(
      (
        await app.session()('POST', '/api/auth/invitations/accept', {
          token: new URL(reset.body.url).hash.slice('#invite='.length),
          password: newPassword,
        })
      ).status,
      200,
    );
    assert.equal((await worker('GET', '/api/dashboard')).status, 401);
  } finally {
    await app.stop();
  }
});

test('workers see only assigned published shifts and cannot mutate bookings or coordinator settings', async () => {
  const app = await fixture();
  try {
    const worker = await app.login('worker');
    const data = (await worker<DashboardData>('GET', '/api/dashboard')).body;
    assert.deepEqual(
      new Set(data.shifts.map((s) => s.id)),
      new Set(['finished', 'future', 'cancelled']),
    );
    assert.deepEqual(
      data.participants.map((p) => p.id),
      ['p-one'],
    );
    assert(!JSON.stringify(data).includes('PRIVATE_PARTICIPANT'));
    assert.equal(data.workerSync, undefined);
    assert.deepEqual(data.rsvps, []);
    for (const [method, path, body] of [
      ['GET', '/api/accounts', undefined],
      ['POST', '/api/participants', {}],
      ['POST', '/api/events', {}],
      ['POST', '/api/workers', {}],
      ['POST', '/api/integrations/airtable/workers', {}],
      ['POST', '/api/integrations/airtable/sync', {}],
      ['POST', '/api/events/event/rsvps', {}],
      [
        'POST',
        '/api/shifts',
        {
          ...app.store.get('shifts', 'finished')!,
          id: undefined,
          status: undefined,
          staffId: undefined,
          staffDisplayName: undefined,
          source: undefined,
          createdAt: undefined,
          updatedAt: undefined,
          syncStatus: undefined,
          pendingChange: undefined,
        },
      ],
      ...['approve', 'assign', 'cancel', 'decline', 'approve_change'].map((action) => [
        'PATCH',
        '/api/shifts/finished',
        { action },
      ]),
    ] as [string, string, unknown][])
      assert.equal((await worker(method, path, body)).status, 403, path);
    app.store.put('shifts', { ...app.store.get('shifts', 'finished')!, staffId: 'worker-two' });
    assert.equal((await worker('PUT', '/api/shifts/finished/update', content())).status, 404);
    assert(
      !(await worker<DashboardData>('GET', '/api/dashboard')).body.shifts.some(
        (s) => s.id === 'finished',
      ),
    );
    app.store.put('staff', { ...app.store.get('staff', 'worker-one')!, active: false });
    assert.equal((await worker('GET', '/api/dashboard')).status, 401);
    assert.equal(
      (await app.session()('POST', '/api/auth/login', { email: 'worker@example.test', password }))
        .status,
      401,
    );
  } finally {
    await app.stop();
  }
});

test('publishing is immediate, scoped, versioned and never exposes internal notes to families or changes bookings', async () => {
  const app = await fixture();
  try {
    const worker = await app.login('worker'),
      parent = await app.login('parent'),
      otherParent = await app.login('other-parent'),
      otherWorker = await app.login('other-worker'),
      coordinator = await app.login('coordinator');
    const original = app.store.get('shifts', 'finished');
    assert.equal(
      (await app.session()('PUT', '/api/shifts/finished/update', content())).status,
      401,
    );
    assert.equal((await parent('PUT', '/api/shifts/finished/update', content())).status, 403);
    assert.equal((await otherWorker('PUT', '/api/shifts/finished/update', content())).status, 404);
    assert.equal(
      (await worker('PUT', '/api/shifts/finished/update', content(), 'https://evil.example'))
        .status,
      403,
    );
    const published = await worker<{ update: ShiftUpdate }>(
      'PUT',
      '/api/shifts/finished/update',
      content(),
    );
    assert.equal(published.status, 201);
    assert.equal(published.body.update.version, 1);
    assert.equal(
      (await worker('PUT', '/api/shifts/finished/update', content())).status,
      409,
      'a retried submission cannot duplicate or overwrite',
    );
    const family = (await parent<DashboardData>('GET', '/api/dashboard')).body;
    assert.equal(family.shiftUpdates?.length, 1);
    assert.equal(family.shiftUpdates?.[0].goals[0].progress, 'progress');
    assert(!JSON.stringify(family).includes('PRIVATE_'));
    assert.equal(family.shiftUpdates?.[0].internal, undefined);
    assert.equal(
      (await otherParent<DashboardData>('GET', '/api/dashboard')).body.shiftUpdates?.length,
      0,
    );
    assert.equal((await otherParent('GET', '/api/shifts/finished/update/history')).status, 404);
    assert.equal((await otherWorker('GET', '/api/shifts/finished/update/history')).status, 404);
    assert.equal(
      (await coordinator<DashboardData>('GET', '/api/dashboard')).body.shiftUpdates?.[0].internal
        ?.followUpNotes,
      'PRIVATE_FOLLOWUP',
    );
    const amended = { ...content(), version: 1, activities: 'Library and lunch.' };
    assert.equal((await worker('PUT', '/api/shifts/finished/update', amended)).status, 200);
    const history = (
      await parent<{ versions: ShiftUpdate[] }>('GET', '/api/shifts/finished/update/history')
    ).body;
    assert.deepEqual(
      history.versions.map((v) => v.version),
      [2, 1],
    );
    assert.equal(history.versions[1].activities, content().activities);
    assert(!JSON.stringify(history).includes('PRIVATE_'));
    assert(history.versions.every((v) => !('internal' in v)));
    assert.deepEqual(app.store.get('shifts', 'finished'), original);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n, 0);
    assert.equal(
      (await coordinator('PATCH', '/api/accounts/parent', { participantIds: ['p-two'] })).status,
      200,
    );
    assert.equal((await parent('GET', '/api/dashboard')).status, 401);
    assert.equal(
      (await (await app.login('parent'))('GET', '/api/shifts/finished/update/history')).status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test('reports require an ended confirmed shift and meaningful goal/feedback/follow-up responses', async () => {
  const app = await fixture();
  try {
    const worker = await app.login('worker');
    for (const id of ['future', 'cancelled'])
      assert.equal((await worker('PUT', `/api/shifts/${id}/update`, content())).status, 409);
    assert.equal((await worker('PUT', '/api/shifts/requested/update', content())).status, 404);
    for (const patch of [
      { activities: ' ' },
      { goals: [] },
      { feedbackProvided: true, participantFeedback: '' },
      { feedbackProvided: false },
      { noGoalWork: true },
      { goals: [{ goal: 'Goal', progress: 'invented', evidence: 'Evidence' }] },
      { internal: { ...content().internal, followUpNotes: '' } },
      { participantId: 'p-two' },
    ])
      assert.equal(
        (await worker('PUT', '/api/shifts/finished/update', { ...content(), ...patch })).status,
        400,
      );
    assert.equal(
      (
        await worker('PUT', '/api/shifts/finished/update', {
          ...content(),
          goals: [],
          noGoalWork: true,
          noGoalReason: 'Rest and recovery today.',
          feedbackProvided: false,
          participantFeedback: '',
        })
      ).status,
      201,
    );
  } finally {
    await app.stop();
  }
});

test('a replacement worker can read the handover but only the author or coordinator can amend a published report', async () => {
  const app = await fixture();
  try {
    const worker = await app.login('worker'),
      other = await app.login('other-worker'),
      coordinator = await app.login('coordinator');
    await worker('PUT', '/api/shifts/finished/update', content());
    app.store.put('shifts', { ...app.store.get('shifts', 'finished')!, staffId: 'worker-two' });
    assert.equal(
      (await other<DashboardData>('GET', '/api/dashboard')).body.shiftUpdates?.[0].canEdit,
      false,
    );
    assert.equal(
      (await other('PUT', '/api/shifts/finished/update', { ...content(), version: 1 })).status,
      403,
    );
    assert.equal((await worker('GET', '/api/shifts/finished/update/history')).status, 404);
    assert.equal(
      (await coordinator('PUT', '/api/shifts/finished/update', { ...content(), version: 1 }))
        .status,
      200,
    );
  } finally {
    await app.stop();
  }
});

test('worker links and published revisions survive database reopen without changing existing access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtm-shift-updates-'));
  const path = join(directory, 'test.sqlite');
  const app = await fixture(path);
  try {
    const worker = await app.login('worker');
    await worker('PUT', '/api/shifts/finished/update', content());
    await worker('PUT', '/api/shifts/finished/update', {
      ...content(),
      version: 1,
      nextTime: 'New plan',
    });
  } finally {
    await app.stop();
  }
  try {
    const store = new Store(path);
    assert.equal(store.getUser('worker')?.workerId, 'worker-one');
    assert.deepEqual(store.getUser('parent')?.participantIds, ['p-one']);
    assert.equal(
      store.db.prepare('SELECT version FROM shift_updates WHERE shift_id=?').get('finished')
        ?.version,
      2,
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM shift_update_versions').get()?.n, 2);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
