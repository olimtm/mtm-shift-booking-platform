import type { Express, Request, RequestHandler, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { User } from '../shared/types.js';
import {
  hashPassword,
  isConfiguredSecret,
  publicUser,
  tokenHash,
  hasActiveWorkerAccess,
} from './auth.js';
import { Store, type StoredUser } from './db.js';
import { fail, id } from './domain.js';

const passwordSchema = z.string().min(12).max(256);
const nameSchema = z.string().trim().min(2).max(100);
const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const participantIdsSchema = z.array(z.string().min(1).max(100)).max(200);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const linkLifetime = 48 * 60 * 60_000;
interface AccountLink {
  user_id: string;
  kind: 'invite' | 'reset';
  expires: number;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
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

export const setupRequired = (store: Store, demoMode: boolean) =>
  !demoMode && !store.db.prepare('SELECT id FROM users LIMIT 1').get();

export function installAccountRoutes(options: {
  app: Express;
  store: Store;
  demoMode: boolean;
  setupSecret?: string;
  origin?: string;
  staff: RequestHandler;
  startSession: (req: Request, res: Response, user: StoredUser) => void;
}) {
  const { app, store, demoMode, setupSecret, origin, staff, startSession } = options;
  const account = (user: StoredUser) => ({ ...publicUser(user), disabled: Boolean(user.disabled) });
  const attempts = new Map<string, { count: number; until: number }>();
  const limited =
    (
      scope: string,
      maximum: number,
      identity?: (req: Request, res: Response) => string,
    ): RequestHandler =>
    (req, res, next) => {
      // Count all attempts, including successful requests, before hashing passwords.
      // A hosting proxy can share its socket IP among every visitor. Use an account
      // or hashed bearer token for the strict limit, with a larger shared ceiling.
      // Never trust client-supplied forwarding headers for this identity.
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const limits = [
        { key: `${scope}:ip:${req.ip ?? 'unknown'}`, maximum: identity ? 600 : maximum },
        ...(identity ? [{ key: `${scope}:identity:${identity(req, res)}`, maximum }] : []),
      ];
      for (const limit of limits) {
        const state = attempts.get(limit.key) ?? { count: 0, until: now + 15 * 60_000 };
        if (state.count >= limit.maximum) {
          res.set('Retry-After', String(Math.ceil((state.until - now) / 1000)));
          return res
            .status(429)
            .json({ error: 'Too many attempts. Please try again in 15 minutes.' });
        }
        state.count++;
        attempts.set(limit.key, state);
      }
      next();
    };
  const coordinatorIdentity = (_req: Request, res: Response) => (res.locals.user as User).id;
  const linkIdentity = (req: Request) => {
    const parsed = tokenSchema.safeParse(req.body?.token);
    return parsed.success ? tokenHash(parsed.data) : 'invalid-token';
  };
  function validateParticipants(role: User['role'], participantIds: string[]) {
    if (new Set(participantIds).size !== participantIds.length)
      fail(400, 'Choose each participant only once.');
    if (role !== 'client' && participantIds.length)
      fail(400, 'Only client accounts can have participant access links.');
    if (role === 'client' && !participantIds.length)
      fail(400, 'Link at least one participant to a client account.');
    for (const participantId of participantIds)
      if (!store.get('participants', participantId))
        fail(400, 'A selected participant does not exist.');
  }
  function validateWorker(role: User['role'], workerId?: string) {
    if (role !== 'worker') {
      if (workerId) fail(400, 'Only worker accounts can be linked to a support worker.');
      return;
    }
    if (!workerId || !hasActiveWorkerAccess(store, { role, workerId }))
      fail(400, 'Choose an active support worker for this account.');
    if (store.db.prepare('SELECT id FROM users WHERE worker_id=?').get(workerId))
      fail(409, 'This worker already has an account. Use its invitation or password reset link.');
  }
  function ensureStaffRecord(user: StoredUser) {
    if (user.role === 'staff' && !store.get('staff', user.id))
      store.put('staff', {
        id: user.id,
        name: user.name,
        initials: user.name
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase(),
        color: 'green',
      });
  }
  function createLink(req: Request, user: StoredUser, kind: AccountLink['kind']) {
    // Origin is configured in production. Development origins are checked by the API's
    // same-origin middleware; never build a secret-bearing URL from a Host header.
    const linkOrigin = origin ?? req.headers.origin;
    if (!linkOrigin) fail(400, 'Open account management from the portal.');
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + linkLifetime;
    store.db
      .prepare('DELETE FROM account_links WHERE user_id=? OR expires<=?')
      .run(user.id, Date.now());
    store.db
      .prepare('INSERT INTO account_links(token_hash,user_id,kind,expires) VALUES(?,?,?,?)')
      .run(tokenHash(token), user.id, kind, expires);
    return {
      url: `${new URL(linkOrigin).origin}/#invite=${token}`,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  function inspectLink(token: string) {
    const link = store.db
      .prepare('SELECT user_id,kind,expires FROM account_links WHERE token_hash=? AND expires>?')
      .get(tokenHash(token), Date.now()) as AccountLink | undefined;
    const user = link && store.getUser(link.user_id);
    if (!link || !user || (link.kind === 'reset' && user.disabled))
      fail(
        400,
        'This invitation or password reset link is invalid or has expired. Ask a coordinator for a new link.',
      );
    if (!hasActiveWorkerAccess(store, user))
      fail(403, 'This worker is inactive. Contact your coordinator about portal access.');
    return { link, user };
  }

  app.post('/api/setup', limited('setup', 12), (req, res) => {
    if (!setupRequired(store, demoMode))
      fail(409, 'Initial setup is already complete. Sign in to continue.');
    if (!isConfiguredSecret(setupSecret))
      fail(
        503,
        'Set MTM_SETUP_SECRET to a random password of at least 32 characters in your hosting settings first.',
      );
    const body = parse(
      z
        .object({
          setupSecret: z.string().min(1).max(1024),
          name: nameSchema,
          email: emailSchema,
          password: passwordSchema,
        })
        .strict(),
      req.body,
    );
    if (
      !timingSafeEqual(
        Buffer.from(tokenHash(body.setupSecret), 'hex'),
        Buffer.from(tokenHash(setupSecret), 'hex'),
      )
    )
      fail(403, 'The setup key is incorrect. Copy MTM_SETUP_SECRET from your hosting settings.');
    const user: StoredUser = {
      id: id('u'),
      name: body.name,
      email: body.email,
      role: 'staff',
      participantIds: [],
      passwordHash: hashPassword(body.password),
      disabled: false,
    };
    store.transaction(() => {
      if (!setupRequired(store, demoMode))
        fail(409, 'Initial setup is already complete. Sign in to continue.');
      store.putUser(user);
      ensureStaffRecord(user);
    });
    startSession(req, res, user);
    res.status(201).json({ user: publicUser(user) });
  });

  app.get('/api/accounts', staff, (_req, res) => {
    const rows = store.db.prepare('SELECT id FROM users ORDER BY name,email').all() as {
      id: string;
    }[];
    res.json({ accounts: rows.map((row) => account(store.getUser(row.id)!)) });
  });
  app.post(
    '/api/accounts/invitations',
    staff,
    limited('create-link', 60, coordinatorIdentity),
    (req, res) => {
      const body = parse(
        z
          .object({
            name: nameSchema,
            email: emailSchema,
            role: z.enum(['staff', 'client', 'worker']),
            participantIds: participantIdsSchema,
            workerId: z.string().min(1).max(100).optional(),
          })
          .strict(),
        req.body,
      );
      validateParticipants(body.role, body.participantIds);
      const user: StoredUser = { ...body, id: id('u'), passwordHash: '', disabled: true };
      const link = store.transaction(() => {
        validateWorker(body.role, body.workerId);
        if (store.findUser(body.email))
          fail(
            409,
            'An account already uses this email. Create a new access link for that account instead.',
          );
        store.putUser(user);
        return createLink(req, user, 'invite');
      });
      res.status(201).json(link);
    },
  );
  app.post(
    '/api/accounts/:id/reset',
    staff,
    limited('create-link', 60, coordinatorIdentity),
    (req, res) => {
      const user = store.getUser(String(req.params.id));
      if (!user) fail(404, 'Account not found.');
      if (user.disabled && user.passwordHash)
        fail(409, 'Enable this account before creating a password reset link.');
      const link = store.transaction(() =>
        createLink(req, user, user.passwordHash ? 'reset' : 'invite'),
      );
      res.status(201).json(link);
    },
  );
  app.patch('/api/accounts/:id', staff, (req, res) => {
    const body = parse(
      z
        .object({
          participantIds: participantIdsSchema.optional(),
          disabled: z.boolean().optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, 'Choose an account setting to change.'),
      req.body,
    );
    const user = store.transaction(() => {
      const current = store.getUser(String(req.params.id));
      if (!current) fail(404, 'Account not found.');
      if (body.participantIds) validateParticipants(current.role, body.participantIds);
      if (body.disabled === false && !current.passwordHash)
        fail(
          409,
          'This account must accept its invitation before it can sign in. Create a new access link if needed.',
        );
      if (body.disabled && current.role === 'staff') {
        if (current.id === (res.locals.user as User).id)
          fail(409, 'You cannot disable your own coordinator account.');
        const active = store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM users WHERE role='staff' AND disabled=0 AND id<>?",
          )
          .get(current.id) as { count: number };
        if (!active.count) fail(409, 'Keep at least one active coordinator account.');
      }
      const updated = { ...current, ...body };
      store.putUser(updated);
      const changedParticipants =
        body.participantIds &&
        JSON.stringify([...body.participantIds].sort()) !==
          JSON.stringify([...current.participantIds].sort());
      if (body.disabled || changedParticipants) {
        store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id);
        store.db.prepare('DELETE FROM account_links WHERE user_id=?').run(current.id);
      }
      return updated;
    });
    res.json({ account: account(user) });
  });

  app.post(
    '/api/auth/invitations/inspect',
    limited('inspect-link', 60, linkIdentity),
    (req, res) => {
      const { token } = parse(z.object({ token: tokenSchema }).strict(), req.body);
      const { link, user } = inspectLink(token);
      res.json({
        name: user.name,
        email: user.email,
        kind: link.kind,
        expiresAt: new Date(link.expires).toISOString(),
      });
    },
  );
  app.post('/api/auth/invitations/accept', limited('accept-link', 12, linkIdentity), (req, res) => {
    const body = parse(
      z.object({ token: tokenSchema, password: passwordSchema }).strict(),
      req.body,
    );
    inspectLink(body.token);
    const passwordHash = hashPassword(body.password);
    const user = store.transaction(() => {
      const { user: current } = inspectLink(body.token);
      const updated = { ...current, passwordHash, disabled: false };
      store.putUser(updated);
      ensureStaffRecord(updated);
      store.db.prepare('DELETE FROM account_links WHERE user_id=?').run(current.id);
      store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id);
      return updated;
    });
    startSession(req, res, user);
    res.json({ user: publicUser(user) });
  });
}
