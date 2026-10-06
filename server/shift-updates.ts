import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { Shift, ShiftUpdate, User } from '../shared/types.js';
import { Store } from './db.js';
import { fail } from './domain.js';

const text = (max: number) => z.string().trim().max(max);
const updateSchema = z
  .object({
    version: z.number().int().min(0),
    activities: text(3000).min(3),
    howItWent: text(3000).min(3),
    feedbackProvided: z.boolean(),
    participantFeedback: text(2000),
    goals: z
      .array(
        z
          .object({
            goal: text(200).min(2),
            progress: z.enum(['practised', 'progress', 'maintained', 'needs_support']),
            evidence: text(1500).min(3),
          })
          .strict(),
      )
      .max(8),
    noGoalWork: z.boolean(),
    noGoalReason: text(1500),
    nextTime: text(2000),
    internal: z
      .object({
        notes: text(3000),
        followUpRequired: z.boolean(),
        followUpNotes: text(2000),
        incidentReference: text(200),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (value.feedbackProvided && !value.participantFeedback)
      issue(
        'participantFeedback',
        'Enter the participant’s feedback, or choose no feedback provided.',
      );
    if (!value.feedbackProvided && value.participantFeedback)
      issue('participantFeedback', 'Clear feedback when no feedback was provided.');
    if (
      value.noGoalWork
        ? value.goals.length > 0 || value.noGoalReason.length < 3
        : !value.goals.length || Boolean(value.noGoalReason)
    )
      issue('goals', 'Record goal progress, or explain why goals were not worked on this shift.');
    if (value.internal.followUpRequired && value.internal.followUpNotes.length < 3)
      issue('internal.followUpNotes', 'Describe the follow-up needed.');
    if (!value.internal.followUpRequired && value.internal.followUpNotes)
      issue('internal.followUpNotes', 'Clear follow-up details when no follow-up is required.');
  });

export function canReadShift(user: User, shift: Shift): boolean {
  if (user.role === 'staff') return true;
  if (user.role === 'worker')
    return Boolean(
      user.workerId &&
      shift.staffId === user.workerId &&
      ['confirmed', 'cancelled'].includes(shift.status),
    );
  return user.role === 'client' && user.participantIds.includes(shift.participantId);
}
export function visibleUpdate(update: ShiftUpdate, user: User, authorId?: string): ShiftUpdate {
  if (user.role !== 'client')
    return { ...update, canEdit: user.role === 'staff' || user.id === authorId };
  // Project explicitly so future internal fields cannot leak into family responses.
  return {
    shiftId: update.shiftId,
    version: update.version,
    authorName: update.authorName,
    editedByName: update.editedByName,
    publishedAt: update.publishedAt,
    updatedAt: update.updatedAt,
    activities: update.activities,
    howItWent: update.howItWent,
    feedbackProvided: update.feedbackProvided,
    participantFeedback: update.participantFeedback,
    goals: update.goals,
    noGoalWork: update.noGoalWork,
    noGoalReason: update.noGoalReason,
    nextTime: update.nextTime,
  };
}
export function dashboardUpdates(store: Store, user: User, shifts: Shift[]): ShiftUpdate[] {
  const allowed = new Set(shifts.filter((s) => canReadShift(user, s)).map((s) => s.id));
  const rows = store.db.prepare('SELECT shift_id,data,author_id FROM shift_updates').all() as {
    shift_id: string;
    data: string;
    author_id: string;
  }[];
  return rows
    .filter((row) => allowed.has(row.shift_id))
    .map((row) => visibleUpdate(JSON.parse(row.data), user, row.author_id));
}

export function installShiftUpdateRoutes(app: Express, store: Store, auth: RequestHandler) {
  function accessible(user: User, shiftId: string) {
    const shift = store.get('shifts', shiftId);
    if (!shift || !canReadShift(user, shift)) fail(404, 'Shift not found.');
    return shift;
  }
  app.get('/api/shifts/:id/update/history', auth, (req, res) => {
    const user = res.locals.user as User;
    const shift = accessible(user, String(req.params.id));
    const versions = store.db
      .prepare('SELECT data FROM shift_update_versions WHERE shift_id=? ORDER BY version DESC')
      .all(shift.id) as { data: string }[];
    res.json({ versions: versions.map((row) => visibleUpdate(JSON.parse(row.data), user)) });
  });
  app.put('/api/shifts/:id/update', auth, (req, res) => {
    const user = res.locals.user as User;
    if (!['worker', 'staff'].includes(user.role))
      fail(403, 'Only the assigned worker or a coordinator can publish shift updates.');
    const shift = accessible(user, String(req.params.id));
    if (shift.status !== 'confirmed' || Date.parse(shift.end) > Date.now())
      fail(409, 'Post-shift updates can be submitted after a confirmed shift ends.');
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success)
      fail(
        400,
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    const { version, ...content } = parsed.data;
    const update = store.transaction(() => {
      const row = store.db
        .prepare('SELECT data,author_id FROM shift_updates WHERE shift_id=?')
        .get(shift.id) as { data: string; author_id: string } | undefined;
      const current = row ? (JSON.parse(row.data) as ShiftUpdate) : undefined;
      if (user.role === 'worker' && row && row.author_id !== user.id)
        fail(403, 'A coordinator must edit an update submitted by another person.');
      if (version !== (current?.version ?? 0))
        fail(409, 'This update has changed. Close the form and refresh before editing again.');
      const now = new Date().toISOString();
      const next: ShiftUpdate = {
        ...content,
        shiftId: shift.id,
        version: version + 1,
        authorName: current?.authorName ?? user.name,
        editedByName: user.name,
        publishedAt: current?.publishedAt ?? now,
        updatedAt: now,
      };
      const serialized = JSON.stringify(next);
      store.db
        .prepare(
          'INSERT INTO shift_updates(shift_id,version,author_id,data) VALUES(?,?,?,?) ON CONFLICT(shift_id) DO UPDATE SET version=excluded.version,data=excluded.data',
        )
        .run(shift.id, next.version, row?.author_id ?? user.id, serialized);
      store.db
        .prepare('INSERT INTO shift_update_versions(shift_id,version,data) VALUES(?,?,?)')
        .run(shift.id, next.version, serialized);
      return next;
    });
    res.status(version ? 200 : 201).json({ update: visibleUpdate(update, user, user.id) });
  });
}
