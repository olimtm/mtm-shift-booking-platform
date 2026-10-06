import { LOCATION_MAX_LENGTH } from '../shared/limits.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  DashboardData,
  Participant,
  Shift,
  ShiftInput,
  SupportType,
  User,
} from '../shared/types.js';
import { Store, type StoredUser } from './db.js';
import { hashPassword, isConfiguredSecret, publicUser, tokenHash, verifyPassword } from './auth.js';
import { installAccountRoutes, setupRequired } from './accounts.js';
import { seedDemo } from './seed.js';
import {
  allRsvps,
  assertStaffAvailable,
  fail,
  HttpError,
  id,
  newShift,
  saveShift,
  upsertRsvp,
} from './domain.js';
import {
  AirtableImportError,
  AirtableRequestError,
  getAirtableStatus,
  inspectAirtableSchema,
  readAirtableSnapshot,
  readParticipantActivity,
  syncShiftToAirtable,
} from './airtable.js';

const timezone = 'Australia/Sydney';
const supportType = z.enum(['general', 'events', 'both', 'none']);
const timestamp = z.iso.datetime({ offset: true });
const shiftInputSchema = z
  .object({
    participantId: z.string().min(1).max(100),
    start: timestamp,
    end: timestamp,
    description: z.string().trim().min(3).max(3000),
    location: z.string().trim().max(LOCATION_MAX_LENGTH).default(''),
    driving: z.enum(['required', 'not_required', 'no_preference']),
    gender: z.enum(['female', 'male', 'no_preference']),
    notes: z.string().trim().max(3000).default(''),
    kind: z.enum(['general', 'event']),
    eventId: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();
const eventSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    start: timestamp,
    end: timestamp,
    location: z.string().trim().max(LOCATION_MAX_LENGTH).default(''),
    description: z.string().trim().max(3000).default(''),
  })
  .strict();
const dummyHash = hashPassword('Nonexistent-account-password');
const cookieName = 'mtm_session';
interface AppOptions {
  databasePath?: string;
  demoMode?: boolean;
  publicOrigin?: string;
  webhookSecret?: string;
  setupSecret?: string;
  enableSync?: boolean;
}
function validRange(start: string, end: string, maxHours = 48) {
  const duration = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxHours * 3_600_000)
    fail(400, `End must be after start, with a duration of at most ${maxHours} hours.`);
}
function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    fail(
      400,
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'Request'}: ${issue.message}`)
        .slice(0, 3)
        .join('; '),
    );
  return result.data;
}
export function createApp(options: AppOptions = {}) {
  const production = process.env.NODE_ENV === 'production';
  const demoMode = options.demoMode ?? process.env.DEMO_MODE === 'true';
  if (production && demoMode) throw new Error('DEMO_MODE cannot be enabled in production.');
  const configuredOrigin =
    options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL;
  let origin: string | undefined;
  if (configuredOrigin) {
    const url = new URL(configuredOrigin);
    if (url.origin !== configuredOrigin || !['https:', 'http:'].includes(url.protocol))
      throw new Error('PUBLIC_ORIGIN must be an exact origin without a path or trailing slash.');
    origin = url.origin;
  }
  if (production && (!origin || !origin.startsWith('https://')))
    throw new Error(
      'Production requires PUBLIC_ORIGIN or RENDER_EXTERNAL_URL with an HTTPS origin.',
    );
  const allowedOrigins = new Set(
    origin
      ? [new URL(origin).origin]
      : [
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:3001',
          'http://127.0.0.1:3001',
        ],
  );
  const store = new Store(
    options.databasePath ??
      process.env.DATABASE_PATH ??
      (demoMode ? '.local/demo.sqlite' : '.local/support.sqlite'),
  );
  if (!demoMode && store.meta('demoDatabase')) {
    store.close();
    throw new Error(
      'Demo data cannot be used with DEMO_MODE disabled. Use a separate DATABASE_PATH.',
    );
  }
  if (
    demoMode &&
    !store.meta('demoDatabase') &&
    store.db
      .prepare(
        'SELECT id FROM users UNION ALL SELECT id FROM participants UNION ALL SELECT id FROM staff UNION ALL SELECT id FROM events UNION ALL SELECT id FROM shifts LIMIT 1',
      )
      .get()
  ) {
    store.close();
    throw new Error(
      'DEMO_MODE cannot open an existing live workspace. Use a separate empty DATABASE_PATH.',
    );
  }
  if (demoMode) seedDemo(store);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  const webhookSecret = options.webhookSecret ?? process.env.RSVP_WEBHOOK_SECRET;
  const enableSync =
    (options.enableSync ?? process.env.AIRTABLE_SYNC_ENABLED === 'true') && !demoMode;
  const configured = () => !demoMode && getAirtableStatus().configured;
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/webhooks/rsvp') {
      if (!req.headers.origin || !allowedOrigins.has(req.headers.origin))
        return res.status(403).json({ error: 'This request must come from the support portal.' });
    }
    const token = req.cookies?.[cookieName];
    if (typeof token === 'string' && token.length === 64) {
      const session = store.db
        .prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires>?')
        .get(tokenHash(token), Date.now()) as { user_id: string } | undefined;
      if (session) {
        const user = store.getUser(session.user_id);
        if (user && !user.disabled) res.locals.user = user;
      }
    }
    next();
  });
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.user) return res.status(401).json({ error: 'Please sign in to continue.' });
    next();
  };
  const staff = (req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.user) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (res.locals.user.role !== 'staff')
      return res.status(403).json({ error: 'Staff access is required.' });
    next();
  };
  const scoped = (user: User, participantId: string) => {
    if (user.role !== 'staff' && !user.participantIds.includes(participantId))
      fail(403, 'You do not have access to this participant.');
    if (!store.get('participants', participantId)) fail(404, 'Participant not found.');
  };
  const asyncRoute =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const rateLimited = (key: string, maximum = 12) => {
    const entry = loginAttempts.get(key);
    if (entry && entry.until > Date.now()) return entry.count >= maximum;
    loginAttempts.delete(key);
    return false;
  };
  const failedAttempt = (key: string) => {
    const previous = loginAttempts.get(key);
    loginAttempts.set(key, {
      count: (previous?.until && previous.until > Date.now() ? previous.count : 0) + 1,
      until:
        previous?.until && previous.until > Date.now() ? previous.until : Date.now() + 15 * 60_000,
    });
  };
  const startSession = (req: Request, res: Response, user: StoredUser) => {
    const previous = req.cookies?.[cookieName];
    if (typeof previous === 'string')
      store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(previous));
    store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    store.db
      .prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)')
      .run(tokenHash(token), user.id, Date.now() + 12 * 60 * 60_000);
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60_000,
    });
  };
  installAccountRoutes({
    app,
    store,
    demoMode,
    origin,
    staff,
    startSession,
    setupSecret: options.setupSecret ?? process.env.MTM_SETUP_SECRET,
  });
  app.get('/api/config', (_req, res) =>
    res.json({ demoMode, timezone, setupRequired: setupRequired(store, demoMode) }),
  );
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.post('/api/auth/login', (req, res) => {
    const body = parsed(
      z.object({ email: z.email().max(254), password: z.string().min(1).max(256) }).strict(),
      req.body,
    );
    const email = body.email.toLowerCase().trim();
    const address = req.ip ?? 'unknown';
    // Hosting proxies may present one socket IP for many clients. Keep the strict
    // account limit while allowing a larger aggregate budget for that shared IP.
    if (rateLimited(`ip:${address}`, 120) || rateLimited(`email:${email}`)) {
      res.set('Retry-After', '900');
      return res
        .status(429)
        .json({ error: 'Too many sign-in attempts. Please try again in 15 minutes.' });
    }
    const user = store.findUser(email);
    if (!verifyPassword(body.password, user?.passwordHash || dummyHash) || !user || user.disabled) {
      failedAttempt(`ip:${address}`);
      failedAttempt(`email:${email}`);
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    loginAttempts.delete(`email:${email}`);
    startSession(req, res, user);
    res.json({ user: publicUser(user) });
  });
  app.get('/api/auth/me', auth, (_req, res) => res.json({ user: publicUser(res.locals.user) }));
  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[cookieName];
    if (typeof token === 'string')
      store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    res.clearCookie(cookieName, { httpOnly: true, secure: production, sameSite: 'lax', path: '/' });
    res.json({ ok: true });
  });
  function integrationStatus() {
    const outbox = store.db
      .prepare(
        'SELECT COUNT(*) AS pending,SUM(CASE WHEN attempts>0 THEN 1 ELSE 0 END) AS failed FROM outbox',
      )
      .get() as { pending: number; failed: number | null };
    return {
      configured: configured(),
      pending: outbox.pending,
      failed: outbox.failed ?? 0,
      synced: store.all('shifts').filter((s) => s.syncStatus === 'synced').length,
      lastSync: store.meta('lastSync') ?? null,
      message: demoMode
        ? 'Demo workspace. Airtable writes are disabled.'
        : !configured()
          ? 'Airtable is not connected. Requests are safely stored in this portal.'
          : enableSync
            ? 'Airtable connected. Changes are queued for synchronisation.'
            : 'Airtable configured. Enable synchronisation after reviewing your field mappings.',
    };
  }
  app.get('/api/dashboard', auth, (_req, res) => {
    const user = publicUser(res.locals.user as StoredUser);
    const isStaff = user.role === 'staff';
    const participants = store
      .all('participants')
      .filter((p) => isStaff || user.participantIds.includes(p.id))
      .map((p) => (isStaff ? p : { ...p, notes: '' }));
    const shifts = store
      .all('shifts')
      .filter((s) => isStaff || user.participantIds.includes(s.participantId))
      .sort((a, b) => a.start.localeCompare(b.start));
    const rsvps = allRsvps(store).filter(
      (r) => isStaff || user.participantIds.includes(r.participantId),
    );
    const events = store
      .all('events')
      .filter(
        (e) =>
          isStaff ||
          rsvps.some((r) => r.eventId === e.id) ||
          shifts.some((s) => s.eventId === e.id),
      )
      .map((e) => {
        const { airtableId: _airtableId, ...event } = e;
        return {
          ...event,
          rsvpCount: rsvps.filter((r) => r.eventId === e.id && r.status === 'attending').length,
          supportCount: shifts.filter(
            (s) => s.eventId === e.id && !['declined', 'cancelled'].includes(s.status),
          ).length,
        };
      });
    const members = store
      .all('staff')
      .filter((member) => isStaff || shifts.some((shift) => shift.staffId === member.id));
    const dashboard: DashboardData = {
      ...(isStaff
        ? {
            participantActivity: {
              checkedAt: store.meta('participant_activity_checked') || null,
              error: store.meta('participant_activity_error') || null,
            },
          }
        : {}),
      user,
      participants,
      staff: members,
      shifts,
      events,
      rsvps,
      integration: isStaff
        ? integrationStatus()
        : {
            configured: false,
            pending: 0,
            failed: 0,
            synced: 0,
            lastSync: null,
            message: 'Your requests are securely saved for the support team.',
          },
      timezone,
      demoMode,
    };
    res.json(dashboard);
  });
  app.post('/api/shifts', auth, (req, res) => {
    const user = res.locals.user as StoredUser;
    const schema =
      user.role === 'staff'
        ? shiftInputSchema.extend({
            staffId: z.string().max(100).nullable().optional(),
            status: z.enum(['requested', 'confirmed']).optional(),
          })
        : shiftInputSchema;
    const body = parsed(schema, req.body) as ShiftInput & {
      staffId?: string | null;
      status?: 'requested' | 'confirmed';
    };
    validRange(body.start, body.end);
    scoped(user, body.participantId);
    if (body.eventId) {
      if (body.kind !== 'event') fail(400, 'An event link requires event support.');
      const event = store.get('events', body.eventId);
      if (
        !event ||
        (user.role !== 'staff' &&
          !allRsvps(store).some(
            (r) => r.eventId === body.eventId && r.participantId === body.participantId,
          ))
      )
        fail(404, 'Event not found for this participant.');
      if (
        store
          .all('shifts')
          .some((s) => s.eventId === body.eventId && s.participantId === body.participantId)
      )
        fail(
          409,
          'This participant already has a support request for this event. Open the existing request.',
        );
    }
    const { staffId, status, ...input } = body;
    const shift = newShift(
      {
        ...input,
        start: new Date(input.start).toISOString(),
        end: new Date(input.end).toISOString(),
      },
      user.role === 'staff' ? 'staff' : 'client',
      configured(),
      { staffId: staffId ?? null, status: status ?? 'requested', eventId: body.eventId ?? null },
    );
    if (shift.staffId && !store.get('staff', shift.staffId))
      fail(400, 'Select an existing staff member.');
    if (shift.status === 'confirmed') assertStaffAvailable(store, shift, shift.staffId);
    store.transaction(() => saveShift(store, shift, configured()));
    res.status(201).json({ shift });
  });
  app.patch('/api/shifts/:id', auth, (req, res) => {
    const original = store.get('shifts', String(req.params.id));
    if (!original) fail(404, 'Shift not found.');
    const user = res.locals.user as StoredUser;
    scoped(user, original.participantId);
    let shift = { ...original };
    if (user.role === 'client' || req.body?.action === 'edit') {
      const body = parsed(
        z.discriminatedUnion('action', [
          z.object({ action: z.literal('edit'), values: shiftInputSchema }).strict(),
          z
            .object({
              action: z.literal('cancel'),
              reason: z.string().trim().max(1000).default('Cancellation requested by participant.'),
            })
            .strict(),
        ]),
        req.body,
      );
      if (!['requested', 'confirmed'].includes(shift.status))
        fail(409, 'Only active shifts can be changed.');
      if (body.action === 'edit') {
        if (
          (body.values.eventId !== undefined && body.values.eventId !== shift.eventId) ||
          (shift.eventId && body.values.kind !== 'event')
        )
          fail(400, 'An existing request cannot be moved to another event.');
        if (body.values.participantId !== shift.participantId)
          fail(403, 'A shift cannot be moved to another participant.');
        validRange(body.values.start, body.values.end);
        shift.pendingChange = {
          type: 'edit',
          values: {
            ...body.values,
            start: new Date(body.values.start).toISOString(),
            end: new Date(body.values.end).toISOString(),
          },
          requestedAt: new Date().toISOString(),
        };
      } else
        shift.pendingChange = {
          type: 'cancel',
          reason: body.reason,
          requestedAt: new Date().toISOString(),
        };
    } else {
      const body = parsed(
        z
          .object({
            action: z.enum([
              'approve',
              'decline',
              'approve_change',
              'reject_change',
              'assign',
              'cancel',
            ]),
            staffId: z.string().max(100).nullable().optional(),
            reason: z.string().trim().max(1000).optional(),
          })
          .strict(),
        req.body,
      );
      if (body.action === 'approve') {
        if (shift.status !== 'requested') fail(409, 'Only new requests can be approved.');
        if (shift.pendingChange)
          fail(409, 'Review the pending change before approving this request.');
        shift.status = 'confirmed';
        if (body.staffId !== undefined) {
          shift.staffId = body.staffId;
          shift.staffDisplayName = undefined;
        }
        assertStaffAvailable(store, shift, shift.staffId);
      } else if (body.action === 'decline') {
        if (shift.status !== 'requested') fail(409, 'Only new requests can be declined.');
        shift.status = 'declined';
        shift.pendingChange = null;
      } else if (body.action === 'approve_change') {
        if (!shift.pendingChange) fail(409, 'There is no change awaiting review.');
        if (shift.pendingChange.type === 'cancel') {
          shift.status = 'cancelled';
          if (shift.pendingChange.reason)
            shift.notes = [shift.notes, `Cancellation reason: ${shift.pendingChange.reason}`]
              .filter(Boolean)
              .join('\n');
        } else if (shift.pendingChange.values) {
          shift = { ...shift, ...shift.pendingChange.values };
          if (shift.status === 'confirmed') assertStaffAvailable(store, shift, shift.staffId);
        }
        shift.pendingChange = null;
      } else if (body.action === 'reject_change') {
        if (!shift.pendingChange) fail(409, 'There is no change awaiting review.');
        shift.pendingChange = null;
      } else if (body.action === 'assign') {
        if (!['requested', 'confirmed'].includes(shift.status))
          fail(409, 'Only active shifts can be assigned.');
        if (body.staffId === undefined) fail(400, 'Choose a staff member or clear the assignment.');
        shift.staffId = body.staffId;
        shift.staffDisplayName = undefined;
        if (shift.staffId && !store.get('staff', shift.staffId))
          fail(400, 'Select an existing staff member.');
        if (shift.status === 'confirmed') assertStaffAvailable(store, shift, shift.staffId);
      } else {
        if (!['requested', 'confirmed'].includes(shift.status))
          fail(409, 'This shift is already inactive.');
        shift.status = 'cancelled';
        shift.pendingChange = null;
        if (body.reason)
          shift.notes = [shift.notes, `Cancellation reason: ${body.reason}`]
            .filter(Boolean)
            .join('\n');
      }
    }
    store.transaction(() => saveShift(store, shift, configured()));
    res.json({ shift });
  });
  // Worker roster membership never grants coordinator login access.
  const workerSchema = z
    .object({
      name: z.string().trim().min(2).max(150),
      airtableId: z
        .string()
        .regex(/^rec[a-zA-Z0-9]{14}$/)
        .optional(),
    })
    .strict();
  for (const method of ['post', 'patch'] as const) {
    app[method](method === 'post' ? '/api/workers' : '/api/workers/:id', staff, (req, res) => {
      const body = parsed(workerSchema, req.body);
      const current = method === 'patch' ? store.get('staff', String(req.params.id)) : undefined;
      if (method === 'patch' && !current) fail(404, 'Worker not found.');
      if (
        body.airtableId &&
        store
          .all('staff')
          .some((worker) => worker.id !== current?.id && worker.airtableId === body.airtableId)
      )
        fail(409, 'This Airtable worker is already linked.');
      // A linked record is the worker's identity; keep it stable for existing bookings.
      if (current?.airtableId && current.airtableId !== body.airtableId)
        fail(
          409,
          'An existing Airtable worker link cannot be replaced. Add a separate worker instead.',
        );
      const worker = {
        ...body,
        id: current?.id ?? id('s'),
        initials: body.name
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase(),
        color: current?.color ?? 'green',
      };
      store.transaction(() => {
        store.put('staff', worker);
        for (const shift of store.all('shifts').filter((shift) => shift.staffId === worker.id))
          saveShift(store, shift, configured());
      });
      res.status(method === 'post' ? 201 : 200).json({ worker });
    });
  }
  app.post('/api/participants', staff, (req, res) => {
    const body = parsed(
      z
        .object({
          name: z.string().trim().min(2).max(150),
          supportType,
          notes: z.string().trim().max(3000).default(''),
          airtableId: z
            .string()
            .regex(/^rec[a-zA-Z0-9]+$/)
            .optional(),
        })
        .strict(),
      req.body,
    );
    if (body.airtableId && store.byAirtable('participants', body.airtableId))
      fail(409, 'This Airtable participant is already linked.');
    const participant: Participant = {
      ...body,
      id: id('p'),
      initials: body.name
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase(),
      color: ['violet', 'blue', 'green', 'peach', 'pink'][store.all('participants').length % 5],
    };
    store.put('participants', participant);
    res.status(201).json({ participant });
  });
  app.patch('/api/participants/:id', staff, (req, res) => {
    const participant = store.get('participants', String(req.params.id));
    if (!participant) fail(404, 'Participant not found.');
    const body = parsed(
      z
        .object({
          supportType: supportType.optional(),
          airtableId: z
            .string()
            .regex(/^rec[a-zA-Z0-9]+$/)
            .optional(),
        })
        .strict()
        .refine(
          (v) => v.supportType !== undefined || v.airtableId !== undefined,
          'Provide a support type or Airtable record identifier.',
        ),
      req.body,
    );
    if (body.airtableId) {
      const linked = store.byAirtable('participants', body.airtableId);
      if (linked && linked.id !== participant.id)
        fail(409, 'This Airtable participant is already linked.');
    }
    const updated = { ...participant, ...body };
    store.transaction(() => {
      store.put('participants', updated);
      if (body.supportType === 'events' || body.supportType === 'both')
        for (const rsvp of allRsvps(store).filter(
          (r) => r.participantId === participant.id && r.status === 'attending',
        )) {
          const event = store.get('events', rsvp.eventId);
          if (event && Date.parse(event.end) > Date.now())
            upsertRsvp(store, event, updated, 'attending', configured());
        }
    });
    res.json({ participant: updated });
  });
  app.post('/api/events', staff, (req, res) => {
    const body = parsed(eventSchema, req.body);
    validRange(body.start, body.end, 47);
    const event = {
      ...body,
      id: id('event'),
      start: new Date(body.start).toISOString(),
      end: new Date(body.end).toISOString(),
      rsvpCount: 0,
      supportCount: 0,
    };
    store.put('events', event);
    res.status(201).json({ event });
  });
  app.post('/api/events/:id/rsvps', staff, (req, res) => {
    const body = parsed(
      z
        .object({ participantId: z.string().max(100), status: z.enum(['attending', 'cancelled']) })
        .strict(),
      req.body,
    );
    const event = store.get('events', String(req.params.id));
    if (!event) fail(404, 'Event not found.');
    const participant = store.get('participants', body.participantId);
    if (!participant) fail(404, 'Participant not found.');
    const result = store.transaction(() =>
      upsertRsvp(store, event, participant, body.status, configured()),
    );
    res.json(result);
  });
  app.post('/api/webhooks/rsvp', (req, res) => {
    if (!isConfiguredSecret(webhookSecret, production ? 32 : 16))
      fail(
        503,
        'RSVP webhook is not configured. Use a random secret of at least 32 characters in hosting settings.',
      );
    const supplied = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : '';
    const expected = Buffer.from(webhookSecret);
    const actual = Buffer.from(supplied ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      fail(401, 'Webhook authentication failed.');
    const body = parsed(
      z
        .object({
          rsvpId: z.string().min(1).max(100),
          eventId: z.string().min(1).max(100),
          participantId: z.string().min(1).max(100),
          status: z.enum(['attending', 'cancelled']),
          event: eventSchema.optional(),
        })
        .strict(),
      req.body,
    );
    const participant =
      store.get('participants', body.participantId) ??
      store.byAirtable('participants', body.participantId);
    if (!participant)
      fail(
        422,
        'Participant is not linked. Link the Airtable participant record in the portal first.',
      );
    let event = store.get('events', body.eventId) ?? store.byAirtable('events', body.eventId);
    if (!event && !body.event)
      fail(422, 'Event is not linked. Include the event details in this webhook.');
    if (body.event) validRange(body.event.start, body.event.end, 47);
    const eventChanged = Boolean(
      event &&
      body.event &&
      (['title', 'start', 'end', 'location', 'description'] as const).some((key) => {
        const value = body.event![key];
        return (
          event![key] !== (key === 'start' || key === 'end' ? new Date(value).toISOString() : value)
        );
      }),
    );
    const result = store.transaction(() => {
      if (body.event) {
        event = {
          ...body.event,
          id: event?.id ?? id('event'),
          airtableId: body.eventId.startsWith('rec') ? body.eventId : event?.airtableId,
          start: new Date(body.event.start).toISOString(),
          end: new Date(body.event.end).toISOString(),
          rsvpCount: 0,
          supportCount: 0,
        };
        store.put('events', event);
      }
      if (!event) fail(422, 'Event not found.');
      // An event update rechecks all attendees; confirmed bookings keep their old times until approval.
      for (const existing of allRsvps(store).filter(
        (r) =>
          eventChanged &&
          r.eventId === event!.id &&
          r.status === 'attending' &&
          r.participantId !== participant.id,
      )) {
        const other = store.get('participants', existing.participantId);
        if (other) upsertRsvp(store, event, other, 'attending', configured(), undefined, true);
      }
      return upsertRsvp(
        store,
        event,
        participant,
        body.status,
        configured(),
        body.rsvpId,
        eventChanged,
      );
    });
    res.json(result);
  });
  let syncRunning = false;
  let lastAirtableWrite = 0;
  async function drainOutbox() {
    if (syncRunning) return { synced: 0, failed: 0, message: 'A sync is already running.' };
    if (!configured() || !enableSync)
      return { synced: 0, failed: 0, message: integrationStatus().message };
    syncRunning = true;
    let synced = 0;
    let failed = 0;
    try {
      const jobs = store.db
        .prepare('SELECT shift_id,version,attempts FROM outbox WHERE next_attempt<=? LIMIT 50')
        .all(Date.now()) as { shift_id: string; version: string; attempts: number }[];
      for (const job of jobs) {
        const shift = store.get('shifts', job.shift_id);
        if (!shift) continue;
        const participant = store.get('participants', shift.participantId);
        if (!participant) continue;
        const staffMember = shift.staffId ? store.get('staff', shift.staffId) : null;
        const recordId = (
          store.db.prepare('SELECT airtable_id FROM shifts WHERE id=?').get(shift.id) as {
            airtable_id: string | null;
          }
        ).airtable_id;
        try {
          const event = shift.eventId ? store.get('events', shift.eventId) : undefined;
          const paceDelay = Math.max(0, 220 - (Date.now() - lastAirtableWrite));
          if (paceDelay) await new Promise((resolve) => setTimeout(resolve, paceDelay));
          lastAirtableWrite = Date.now();
          const result = await syncShiftToAirtable({
            shift,
            participant,
            staff: staffMember ?? null,
            recordId: recordId ?? undefined,
            eventAirtableId: event?.airtableId,
          });
          store.transaction(() => {
            store.db
              .prepare('UPDATE shifts SET airtable_id=? WHERE id=?')
              .run(result.recordId, shift.id);
            const latest = store.get('shifts', shift.id)!;
            if (latest.updatedAt === job.version) {
              store.put('shifts', { ...latest, syncStatus: 'synced' });
              store.db
                .prepare('DELETE FROM outbox WHERE shift_id=? AND version=?')
                .run(shift.id, job.version);
            }
            store.setMeta('lastSync', new Date().toISOString());
          });
          synced++;
        } catch (error) {
          const retryDelay = Math.max(
            Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts, 7)),
            error instanceof AirtableRequestError ? (error.retryAfterMs ?? 0) : 0,
          );
          store.transaction(() => {
            store.db
              .prepare(
                'UPDATE outbox SET attempts=attempts+1,last_error=?,next_attempt=? WHERE shift_id=? AND version=?',
              )
              .run(
                'Airtable sync failed. Check record links, mappings, and access in environment settings.',
                Date.now() + retryDelay,
                shift.id,
                job.version,
              );
            const latest = store.get('shifts', shift.id);
            if (latest?.updatedAt === job.version)
              store.put('shifts', { ...latest, syncStatus: 'failed' });
          });
          failed++;
        }
      }
    } finally {
      syncRunning = false;
    }
    return {
      synced,
      failed,
      message: failed
        ? 'Some changes could not be synced. Check Airtable mappings and access.'
        : `${synced} change${synced === 1 ? '' : 's'} synced.`,
    };
  }
  app.get(
    '/api/integrations/airtable/schema',
    staff,
    asyncRoute(async (_req, res) => {
      if (!configured())
        fail(409, 'Configure Airtable access and table mappings in environment settings first.');
      try {
        res.json(await inspectAirtableSchema());
      } catch (error) {
        if (error instanceof AirtableRequestError)
          fail(502, `${error.message} No Airtable data was changed.`);
        fail(
          502,
          'Could not inspect Airtable. Check the configured base, token permissions, and table names.',
        );
      }
    }),
  );
  app.post(
    '/api/integrations/airtable/import',
    staff,
    asyncRoute(async (req, res) => {
      const options = z
        .object({ omitInvalidRsvps: z.boolean().default(false) })
        .parse(req.body ?? {});
      if (!configured())
        fail(409, 'Configure Airtable access and table mappings before importing.');
      let snapshot: Awaited<ReturnType<typeof readAirtableSnapshot>>;
      try {
        snapshot = await readAirtableSnapshot(process.env, options);
      } catch (error) {
        if (error instanceof AirtableImportError) fail(422, error.message);
        if (error instanceof AirtableRequestError)
          fail(502, `${error.message} No portal records were changed.`);
        fail(
          502,
          'Could not import Airtable data. Check table mappings, linked records, dates, and support or RSVP status values. No portal records were changed.',
        );
      }
      const counts = { participants: 0, events: 0, shifts: 0, rsvps: 0, requests: 0, preserved: 0 };
      store.transaction(() => {
        for (const record of snapshot.participants) {
          const existing = store.byAirtable('participants', record.airtableId);
          if (existing) {
            if (record.active !== undefined)
              store.put('participants', { ...existing, active: record.active });
            counts.preserved++;
            continue;
          }
          const participant: Participant = {
            id: id('p'),
            name: record.name,
            initials: record.name
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0])
              .join('')
              .toUpperCase(),
            color: ['violet', 'blue', 'green', 'peach', 'pink'][counts.participants % 5],
            supportType: record.supportType,
            notes: '',
            airtableId: record.airtableId,
            ...(record.active !== undefined ? { active: record.active } : {}),
          };
          store.put('participants', participant);
          counts.participants++;
        }
        for (const record of snapshot.events) {
          if (store.byAirtable('events', record.airtableId)) {
            counts.preserved++;
            continue;
          }
          store.put('events', { ...record, id: id('event'), rsvpCount: 0, supportCount: 0 });
          counts.events++;
        }
        for (const record of snapshot.shifts) {
          const existingExternal = store.db
            .prepare('SELECT id FROM shifts WHERE airtable_id=?')
            .get(record.airtableId) as { id: string } | undefined;
          if (existingExternal) {
            counts.preserved++;
            continue;
          }
          const participant = store.byAirtable('participants', record.participantAirtableId);
          const event = record.eventAirtableId
            ? store.byAirtable('events', record.eventAirtableId)
            : undefined;
          if (!participant || (record.eventAirtableId && !event))
            fail(
              422,
              'An imported shift has an unresolved participant or event link. No portal records were changed.',
            );
          const existingPortal = record.portalId ? store.get('shifts', record.portalId) : undefined;
          if (existingPortal) {
            const mapping = store.db
              .prepare('SELECT airtable_id FROM shifts WHERE id=?')
              .get(existingPortal.id) as { airtable_id: string | null };
            if (
              existingPortal.participantId !== participant.id ||
              existingPortal.eventId !== (event?.id ?? null) ||
              mapping.airtable_id
            )
              fail(
                409,
                'An Airtable Portal request ID conflicts with an existing portal shift. Resolve the mapping before importing. No portal records were changed.',
              );
            store.db
              .prepare('UPDATE shifts SET airtable_id=? WHERE id=?')
              .run(record.airtableId, existingPortal.id);
            counts.preserved++;
            continue;
          }
          if (
            event &&
            store.db
              .prepare('SELECT id FROM shifts WHERE event_id=? AND participant_id=?')
              .get(event.id, participant.id)
          )
            fail(
              409,
              'An imported event request conflicts with an existing portal shift. Link its Portal request ID before importing. No portal records were changed.',
            );
          let staffId: string | null = null;
          if (record.staffAirtableId) {
            const externalMember = store
              .all('staff')
              .find((candidate) => candidate.airtableId === record.staffAirtableId);
            if (
              record.staffPortalId &&
              externalMember &&
              externalMember.id !== record.staffPortalId
            )
              fail(
                409,
                'An imported staff record is already linked to a different portal identity. Resolve the staff mapping before importing. No portal records were changed.',
              );
            let member = record.staffPortalId
              ? store.get('staff', record.staffPortalId)
              : externalMember;
            if (member?.airtableId && member.airtableId !== record.staffAirtableId)
              fail(
                409,
                'An imported staff identity conflicts with its portal mapping. No portal records were changed.',
              );
            if (!member) {
              const name = record.staffName || 'Imported support worker';
              member = {
                id: record.staffPortalId ?? id('s'),
                name,
                initials: name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join('')
                  .toUpperCase(),
                color: 'green',
                airtableId: record.staffAirtableId,
              };
            } else member = { ...member, airtableId: record.staffAirtableId };
            store.put('staff', member);
            staffId = member.id;
          }
          const input: ShiftInput = {
            participantId: participant.id,
            start: record.start,
            end: record.end,
            description: record.description,
            location: record.location,
            driving: record.driving,
            gender: record.gender,
            notes: record.notes,
            kind: record.kind,
          };
          const shift = newShift(input, record.source, configured(), {
            id: record.portalId ?? id('shift'),
            eventId: event?.id ?? null,
            status: record.status,
            staffId,
            staffDisplayName: !staffId && record.staffName ? record.staffName : undefined,
            syncStatus: 'synced',
          });
          store.put('shifts', shift);
          store.db
            .prepare('UPDATE shifts SET airtable_id=? WHERE id=?')
            .run(record.airtableId, shift.id);
          if (event)
            store.db
              .prepare(
                'UPDATE rsvps SET shift_id=? WHERE event_id=? AND participant_id=? AND shift_id IS NULL',
              )
              .run(shift.id, event.id, participant.id);
          counts.shifts++;
        }
        for (const record of snapshot.rsvps) {
          const participant = store.byAirtable('participants', record.participantAirtableId);
          const event = store.byAirtable('events', record.eventAirtableId);
          if (!participant || !event)
            fail(
              422,
              'An imported RSVP has an unresolved participant or event link. No portal records were changed.',
            );
          if (
            store.db
              .prepare('SELECT id FROM rsvps WHERE event_id=? AND participant_id=?')
              .get(event.id, participant.id)
          ) {
            counts.preserved++;
            continue;
          }
          const externalId = `${record.airtableId}:${record.participantAirtableId}`;
          const booked = store.db
            .prepare('SELECT id FROM shifts WHERE event_id=? AND participant_id=?')
            .get(event.id, participant.id) as { id: string } | undefined;
          if (booked) {
            // Import links existing attendance to its booked support without rewriting approved values.
            store.db
              .prepare(
                'INSERT INTO rsvps(id,event_id,participant_id,status,shift_id,external_id) VALUES(?,?,?,?,?,?)',
              )
              .run(id('rsvp'), event.id, participant.id, record.status, booked.id, externalId);
          } else if (Date.parse(event.end) > Date.now()) {
            const result = upsertRsvp(
              store,
              event,
              participant,
              record.status,
              configured(),
              externalId,
            );
            if (result.shift) counts.requests++;
          } else {
            // Historical attendance is useful context; it must not generate backdated support requests.
            store.db
              .prepare(
                'INSERT INTO rsvps(id,event_id,participant_id,status,shift_id,external_id) VALUES(?,?,?,?,NULL,?)',
              )
              .run(id('rsvp'), event.id, participant.id, record.status, externalId);
          }
          counts.rsvps++;
        }
      });
      res.json({
        ...counts,
        omittedRsvps: snapshot.omittedRsvps,
        message: `Imported ${counts.participants} participants, ${counts.events} events, ${counts.shifts} existing shifts and ${counts.rsvps} RSVPs. ${counts.requests} upcoming support requests created; existing portal records were preserved. ${snapshot.omittedRsvps.length} RSVP records had attendance omitted; see the report. Airtable records were not changed by this import.`,
      });
    }),
  );
  app.post(
    '/api/integrations/airtable/sync',
    staff,
    asyncRoute(async (_req, res) => {
      if (!enableSync || !configured()) fail(409, integrationStatus().message);
      res.json(await drainOutbox());
    }),
  );
  let activityRefresh: Promise<void> | null = null;
  let activityAttempt = 0;
  async function refreshParticipantActivity(force = false): Promise<void> {
    if (demoMode || !configured()) return;
    if (activityRefresh) return activityRefresh;
    if (!force && Date.now() - activityAttempt < 5 * 60_000) return;
    activityAttempt = Date.now();
    activityRefresh = (async () => {
      try {
        const statuses = new Map(
          (await readParticipantActivity()).map((row) => [row.airtableId, row.active]),
        );
        store.transaction(() => {
          for (const participant of store.all('participants')) {
            if (participant.airtableId)
              store.put('participants', {
                ...participant,
                active: statuses.get(participant.airtableId) ?? false,
              });
          }
          store.setMeta('participant_activity_checked', new Date().toISOString());
          store.setMeta('participant_activity_error', '');
        });
      } catch (error) {
        const message =
          error instanceof AirtableRequestError || error instanceof AirtableImportError
            ? error.message
            : 'Could not refresh participant statuses. The previous list is preserved.';
        store.setMeta('participant_activity_error', message);
        throw new HttpError(502, message);
      }
    })();
    try {
      await activityRefresh;
    } finally {
      activityRefresh = null;
    }
  }
  app.post(
    '/api/integrations/airtable/participants',
    staff,
    asyncRoute(async (_req, res) => {
      if (!configured() || demoMode)
        fail(409, 'Configure Airtable before refreshing participant statuses.');
      await refreshParticipantActivity(true);
      res.json({ message: 'Participant statuses refreshed.' });
    }),
  );
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (typeof error === 'object' && error && 'type' in error && error.type === 'entity.too.large')
      return res.status(413).json({ error: 'The request is too large.' });
    console.error('Portal request failed:', error instanceof Error ? error.name : 'Unknown error');
    res.status(500).json({ error: 'We could not save this change. Please try again.' });
  });
  return { app, store, drainOutbox, refreshParticipantActivity, close: () => store.close() };
}
