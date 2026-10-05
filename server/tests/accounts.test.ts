import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../app.ts';
import { hashPassword, tokenHash } from '../auth.ts';
import { Store } from '../db.ts';

const origin = 'http://localhost:5173';
const setupSecret = '7ea342188e3a0503d8da11d081e64f72c84e0b77aca76c25';
const password = 'Test-support-password!2026';

async function fixture(options: Parameters<typeof createApp>[0] = {}) {
  const runtime = createApp({
    databasePath: ':memory:',
    demoMode: false,
    publicOrigin: origin,
    setupSecret,
    ...options,
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function session() {
    let cookie = '';
    return async (
      method: string,
      path: string,
      body?: unknown,
      requestOrigin = origin,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          Origin: requestOrigin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const nextCookie = response.headers.getSetCookie();
      if (nextCookie.length) cookie = nextCookie.map((value) => value.split(';')[0]).join('; ');
      return { status: response.status, body: await response.json(), response };
    };
  }
  return {
    ...runtime,
    session,
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      runtime.close();
    },
  };
}
type Session = ReturnType<Awaited<ReturnType<typeof fixture>>['session']>;
async function bootstrap(session: Session) {
  const response = await session('POST', '/api/setup', {
    setupSecret,
    name: 'First Coordinator',
    email: 'Coordinator@Example.test',
    password,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.user.id as string;
}
function addParticipants(store: Store) {
  for (const id of ['p-one', 'p-two'])
    store.put('participants', {
      id,
      name: id,
      initials: 'P',
      color: 'green',
      supportType: 'both',
      notes: 'Private coordinator note',
    });
}
async function invite(session: Session, email = 'client@example.test', role = 'client') {
  const result = await session('POST', '/api/accounts/invitations', {
    name: 'Test Account',
    email,
    role,
    participantIds: role === 'client' ? ['p-one'] : [],
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(new URL(result.body.url).search, '');
  assert.equal(new URL(result.body.url).pathname, '/');
  const token = new URL(result.body.url).hash.replace('#invite=', '');
  assert.match(token, /^[a-f0-9]{64}$/);
  return { ...result.body, token };
}

test('first coordinator setup requires configured key, same origin, and only creates one account', async () => {
  const app = await fixture();
  try {
    const a = app.session();
    const b = app.session();
    assert.equal((await a('GET', '/api/config')).body.setupRequired, true);
    const data = {
      setupSecret,
      name: 'First Coordinator',
      email: 'coordinator@example.test',
      password,
    };
    assert.equal((await a('POST', '/api/setup', data, 'https://attacker.example')).status, 403);
    assert.equal(
      (await a('POST', '/api/setup', { ...data, setupSecret: 'incorrect' })).status,
      403,
    );
    assert.equal((await a('POST', '/api/setup', { ...data, password: 'short' })).status, 400);
    assert.equal(
      (app.store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
        .count,
      0,
    );
    const concurrent = await Promise.all([
      a('POST', '/api/setup', data),
      b('POST', '/api/setup', { ...data, email: 'another@example.test' }),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      (app.store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
        .count,
      1,
    );
    assert.equal(app.store.all('staff').length, 1);
    assert.equal((await a('GET', '/api/config')).body.setupRequired, false);
    const accepted = concurrent.find((r) => r.status === 201)!;
    assert.ok(accepted.response.headers.get('set-cookie')?.includes('HttpOnly'));
    assert.ok(!('passwordHash' in accepted.body.user));
    assert.ok(!('disabled' in accepted.body.user));
  } finally {
    await app.stop();
  }
});

test('setup is locked with missing or placeholder key and bad attempts are limited', async () => {
  for (const badSecret of ['', 'replace-with-a-random-webhook-secret']) {
    const app = await fixture({ setupSecret: badSecret });
    try {
      assert.equal((await app.session()('POST', '/api/setup', {})).status, 503);
      assert.equal(
        (app.store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
          .count,
        0,
      );
    } finally {
      await app.stop();
    }
  }
  const app = await fixture();
  try {
    const session = app.session();
    for (let attempt = 0; attempt < 12; attempt++)
      assert.equal(
        (
          await session('POST', '/api/setup', {
            setupSecret: 'wrong',
            name: 'Test Person',
            email: 'test@example.test',
            password,
          })
        ).status,
        403,
      );
    assert.equal(
      (
        await session('POST', '/api/setup', {
          setupSecret,
          name: 'Test Person',
          email: 'test@example.test',
          password,
        })
      ).status,
      429,
    );
  } finally {
    await app.stop();
  }
});

test('invites are staff-only, scoped to known participants, hashed, expiring, and one use', async () => {
  const app = await fixture();
  try {
    addParticipants(app.store);
    const staff = app.session();
    await bootstrap(staff);
    const anonymous = app.session();
    assert.equal((await anonymous('GET', '/api/accounts')).status, 401);
    assert.equal((await anonymous('POST', '/api/accounts/invitations', {})).status, 401);
    assert.equal(
      (
        await staff('POST', '/api/accounts/invitations', {
          name: 'Missing Participant',
          email: 'missing@example.test',
          role: 'client',
          participantIds: ['does-not-exist'],
        })
      ).status,
      400,
    );
    const link = await invite(staff);
    const row = app.store.db.prepare('SELECT token_hash,expires FROM account_links').get() as {
      token_hash: string;
      expires: number;
    };
    assert.equal(row.token_hash, tokenHash(link.token));
    assert.notEqual(row.token_hash, link.token);
    assert.ok(Math.abs(row.expires - Date.now() - 48 * 60 * 60_000) < 10_000);
    const inspected = await anonymous('POST', '/api/auth/invitations/inspect', {
      token: link.token,
    });
    assert.equal(inspected.body.kind, 'invite');
    assert.equal(inspected.body.email, 'client@example.test');
    assert.equal(
      (
        await anonymous('POST', '/api/auth/invitations/accept', {
          token: link.token,
          password: 'tiny',
        })
      ).status,
      400,
    );
    assert.equal(
      (await anonymous('POST', '/api/auth/invitations/accept', { token: link.token, password }))
        .status,
      200,
    );
    assert.equal((await anonymous('GET', '/api/auth/me')).body.user.role, 'client');
    assert.equal((await anonymous('GET', '/api/accounts')).status, 403);
    assert.equal((await anonymous('POST', '/api/accounts/invitations', {})).status, 403);
    assert.deepEqual(
      (await anonymous('GET', '/api/dashboard')).body.participants.map((p: { id: string }) => p.id),
      ['p-one'],
    );
    assert.equal(
      (await app.session()('POST', '/api/auth/invitations/accept', { token: link.token, password }))
        .status,
      400,
    );
    assert.equal(
      (
        await staff('POST', '/api/accounts/invitations', {
          name: 'Duplicate',
          email: 'CLIENT@example.test',
          role: 'client',
          participantIds: ['p-two'],
        })
      ).status,
      409,
    );
    const expired = await invite(staff, 'expired@example.test');
    app.store.db
      .prepare('UPDATE account_links SET expires=? WHERE token_hash=?')
      .run(Date.now() - 1, tokenHash(expired.token));
    assert.equal(
      (await app.session()('POST', '/api/auth/invitations/inspect', { token: expired.token }))
        .status,
      400,
    );
    assert.equal(
      (
        await app.session()('POST', '/api/auth/invitations/accept', {
          token: expired.token,
          password,
        })
      ).status,
      400,
    );
  } finally {
    await app.stop();
  }
});

test('replacement and reset links invalidate old links; accepting a reset revokes old sessions and old password', async () => {
  const app = await fixture();
  try {
    addParticipants(app.store);
    const staff = app.session();
    await bootstrap(staff);
    const initial = await invite(staff);
    const pending = app.store.findUser('client@example.test')!;
    const replacement = await staff('POST', `/api/accounts/${pending.id}/reset`, {});
    assert.equal(replacement.status, 201);
    assert.equal(
      (
        await app.session()('POST', '/api/auth/invitations/accept', {
          token: initial.token,
          password,
        })
      ).status,
      400,
    );
    const token = new URL(replacement.body.url).hash.replace('#invite=', '');
    const client = app.session();
    assert.equal(
      (await client('POST', '/api/auth/invitations/accept', { token, password })).status,
      200,
    );
    const reset = await staff('POST', `/api/accounts/${pending.id}/reset`, {});
    const resetToken = new URL(reset.body.url).hash.replace('#invite=', '');
    assert.equal(
      (await client('GET', '/api/auth/me')).status,
      200,
      'Issuing a reset does not interrupt the existing account',
    );
    const recipient = app.session();
    assert.equal(
      (await recipient('POST', '/api/auth/invitations/inspect', { token: resetToken })).body.kind,
      'reset',
    );
    assert.equal(
      (
        await recipient('POST', '/api/auth/invitations/accept', {
          token: resetToken,
          password: `${password}-new`,
        })
      ).status,
      200,
    );
    assert.equal((await client('GET', '/api/auth/me')).status, 401);
    assert.equal(
      (await app.session()('POST', '/api/auth/login', { email: pending.email, password })).status,
      401,
    );
    assert.equal(
      (
        await app.session()('POST', '/api/auth/login', {
          email: pending.email,
          password: `${password}-new`,
        })
      ).status,
      200,
    );
    assert.equal(
      (await recipient('POST', '/api/auth/invitations/accept', { token: resetToken, password }))
        .status,
      400,
    );
  } finally {
    await app.stop();
  }
});

test('reassignment and disabling revoke access, protect staff accounts, and keep participants separated', async () => {
  const app = await fixture();
  try {
    addParticipants(app.store);
    const staff = app.session();
    const staffId = await bootstrap(staff);
    const link = await invite(staff);
    const client = app.session();
    const accepted = await client('POST', '/api/auth/invitations/accept', {
      token: link.token,
      password,
    });
    const userId = accepted.body.user.id;
    assert.equal(
      (await client('PATCH', `/api/accounts/${staffId}`, { disabled: true })).status,
      403,
    );
    assert.equal(
      (await staff('PATCH', `/api/accounts/${staffId}`, { disabled: true })).status,
      409,
    );
    assert.equal(
      (await staff('PATCH', `/api/accounts/${userId}`, { participantIds: ['p-two'] })).status,
      200,
    );
    assert.equal((await client('GET', '/api/dashboard')).status, 401);
    assert.equal(
      (await client('POST', '/api/auth/login', { email: 'client@example.test', password })).status,
      200,
    );
    assert.deepEqual(
      (await client('GET', '/api/dashboard')).body.participants.map((p: { id: string }) => p.id),
      ['p-two'],
    );
    const reset = await staff('POST', `/api/accounts/${userId}/reset`, {});
    assert.equal((await staff('PATCH', `/api/accounts/${userId}`, { disabled: true })).status, 200);
    assert.equal((await client('GET', '/api/auth/me')).status, 401);
    assert.equal(
      (await client('POST', '/api/auth/login', { email: 'client@example.test', password })).status,
      401,
    );
    assert.equal(
      (
        await client('POST', '/api/auth/invitations/accept', {
          token: new URL(reset.body.url).hash.replace('#invite=', ''),
          password,
        })
      ).status,
      400,
    );
    const listed = (await staff('GET', '/api/accounts')).body.accounts;
    assert.equal(listed.find((u: { id: string }) => u.id === userId).disabled, true);
    assert.ok(!JSON.stringify(listed).includes('passwordHash'));
    assert.ok(!JSON.stringify(listed).includes(link.token));
    assert.equal(
      (await staff('PATCH', `/api/accounts/${userId}`, { disabled: false })).status,
      200,
    );
    assert.equal(
      (await client('POST', '/api/auth/login', { email: 'client@example.test', password })).status,
      200,
    );
  } finally {
    await app.stop();
  }
});

test('legacy databases migrate disabled status idempotently without changing existing account access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtm-accounts-migration-'));
  const path = join(dir, 'support.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(
      'CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,participant_ids TEXT NOT NULL)',
    );
    legacy
      .prepare('INSERT INTO users VALUES(?,?,?,?,?,?)')
      .run(
        'u-legacy',
        'legacy@example.test',
        'Legacy Coordinator',
        'staff',
        hashPassword(password),
        '[]',
      );
    legacy.close();
    for (let run = 0; run < 2; run++) {
      const store = new Store(path);
      assert.equal(store.getUser('u-legacy')?.disabled, false);
      assert.equal(store.getUser('u-legacy')?.name, 'Legacy Coordinator');
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production can use Render HTTPS origin and refuses placeholder webhook secrets', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL,
  };
  let app: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_ORIGIN;
    process.env.RENDER_EXTERNAL_URL = 'https://mtm-example.onrender.com';
    app = await fixture({
      publicOrigin: undefined,
      webhookSecret: 'replace-with-a-random-webhook-secret',
    });
    const req = app.session();
    const setup = await req(
      'POST',
      '/api/setup',
      { setupSecret, name: 'Live Coordinator', email: 'live@example.test', password },
      'https://mtm-example.onrender.com',
    );
    assert.equal(setup.status, 201);
    assert.ok(setup.response.headers.get('set-cookie')?.includes('Secure'));
    assert.equal((await req('POST', '/api/webhooks/rsvp', {})).status, 503);
    assert.throws(
      () =>
        createApp({
          databasePath: ':memory:',
          publicOrigin: 'https://mtm-example.onrender.com/path',
        }),
      /exact origin/,
    );
    assert.throws(
      () => createApp({ databasePath: ':memory:', publicOrigin: 'http://example.test' }),
      /HTTPS/,
    );
  } finally {
    if (app) await app.stop();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('distinct invitation recipients sharing a proxy IP retain access while repeated token attempts are limited', async () => {
  const app = await fixture();
  try {
    addParticipants(app.store);
    const staff = app.session();
    await bootstrap(staff);
    const invalidToken = 'f'.repeat(64);
    const visitor = app.session();
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.equal(
        (await visitor('POST', '/api/auth/invitations/accept', { token: invalidToken, password }))
          .status,
        400,
      );
    }
    const limited = await visitor(
      'POST',
      '/api/auth/invitations/accept',
      { token: invalidToken, password },
      origin,
      { 'X-Forwarded-For': '203.0.113.22' },
    );
    assert.equal(limited.status, 429, 'Forwarding headers cannot bypass a token limit');
    assert.ok(limited.response.headers.get('retry-after'));
    for (let index = 0; index < 13; index++) {
      const invitation = await invite(staff, `recipient-${index}@example.test`);
      const recipient = app.session();
      assert.equal(
        (await recipient('POST', '/api/auth/invitations/inspect', { token: invitation.token }))
          .status,
        200,
      );
      assert.equal(
        (
          await recipient('POST', '/api/auth/invitations/accept', {
            token: invitation.token,
            password,
          })
        ).status,
        200,
        'Each recipient has a separate token budget behind the shared proxy',
      );
    }
  } finally {
    await app.stop();
  }
});

test('shared proxy ceiling bounds attempts with changing tokens and ignores forged forwarding headers', async () => {
  const app = await fixture();
  try {
    const visitor = app.session();
    for (let index = 0; index < 600; index++) {
      const token = index.toString(16).padStart(64, '0');
      assert.equal((await visitor('POST', '/api/auth/invitations/inspect', { token })).status, 400);
    }
    const result = await visitor(
      'POST',
      '/api/auth/invitations/inspect',
      { token: 'f'.repeat(64) },
      origin,
      { 'X-Forwarded-For': '203.0.113.23' },
    );
    assert.equal(result.status, 429);
    assert.ok(result.response.headers.get('retry-after'));
  } finally {
    await app.stop();
  }
});

test('failed sign-ins lock the targeted email without locking other accounts behind the same proxy', async () => {
  const app = await fixture();
  try {
    const staff = app.session();
    await bootstrap(staff);
    const visitor = app.session();
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.equal(
        (await visitor('POST', '/api/auth/login', { email: 'target@example.test', password }))
          .status,
        401,
      );
    }
    const blocked = await visitor(
      'POST',
      '/api/auth/login',
      { email: 'target@example.test', password },
      origin,
      { 'X-Forwarded-For': '203.0.113.24' },
    );
    assert.equal(blocked.status, 429);
    assert.equal(
      (await visitor('POST', '/api/auth/login', { email: 'coordinator@example.test', password }))
        .status,
      200,
    );
  } finally {
    await app.stop();
  }
});
