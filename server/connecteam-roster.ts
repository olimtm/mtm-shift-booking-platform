import {
  ConnecteamError,
  readConnecteamData,
  readConnecteamSchedulers,
  selectConnecteamScheduler,
  type ConnecteamScheduler,
} from './connecteam.ts';

// Covers the scheduler's full practical history and scheduled future, not just upcoming shifts.
export const ROSTER_FROM = 1;
export const ROSTER_THROUGH = 4102444800; // 1 January 2100 UTC
export interface ConnecteamRosterShift {
  id: string;
  title: string;
  jobId: string | null;
  startTime: number;
  endTime: number;
  assignedUserIds: number[];
  isPublished: boolean;
  isOpenShift: boolean;
  location: string;
  rejectedUserIds: number[];
}
export interface ConnecteamRoster {
  scheduler: ConnecteamScheduler;
  checkedAt: string;
  from: number;
  through: number;
  shifts: ConnecteamRosterShift[];
}

export async function readConnecteamRoster(
  env: Record<string, string | undefined> = process.env,
): Promise<ConnecteamRoster> {
  const scheduler = selectConnecteamScheduler(await readConnecteamSchedulers(env), env);
  const shifts: ConnecteamRosterShift[] = [];
  const seen = new Map<string, ConnecteamRosterShift>();
  const configuredStart = env.CONNECTEAM_IMPORT_START_DATE;
  const from = configuredStart ? Date.parse(`${configuredStart}T00:00:00Z`) / 1000 : ROSTER_FROM;
  if (
    !Number.isSafeInteger(from) ||
    from < ROSTER_FROM ||
    from >= ROSTER_THROUGH ||
    (configuredStart && !/^\d{4}-\d{2}-\d{2}$/.test(configuredStart))
  )
    throw new ConnecteamError('CONNECTEAM_IMPORT_START_DATE must be a valid YYYY-MM-DD date.');
  let windowFrom = from;
  let windowSize = ROSTER_THROUGH - from;
  let offset = 0;
  let windows = 0;
  const seenInWindow = new Set<string>();
  for (let page = 0; page < 2000; page++) {
    const windowThrough = Math.min(ROSTER_THROUGH, windowFrom + windowSize);
    const params = new URLSearchParams({
      startTime: String(windowFrom),
      endTime: String(windowThrough),
      limit: '500',
      offset: String(offset),
      sort: 'created_at',
      order: 'asc',
    });
    let body: { data?: { shifts?: unknown }; paging?: { offset?: unknown } };
    try {
      body = (await readConnecteamData(
        `/scheduler/v1/schedulers/${scheduler.schedulerId}/shifts?${params}`,
        env,
      )) as typeof body;
    } catch (error) {
      if (
        offset === 0 &&
        error instanceof ConnecteamError &&
        error.dateRangeRejected &&
        windowSize > 86400
      ) {
        windowSize = Math.floor(windowSize / 2);
        continue;
      }
      throw error;
    }
    const rows = body?.data?.shifts;
    if (!Array.isArray(rows) || rows.length > 500)
      throw new ConnecteamError(
        'Connecteam returned an invalid roster page. No shifts were imported.',
      );
    for (const row of rows) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !row.id ||
        row.id.length > 200 ||
        seenInWindow.has(row.id) ||
        !(row.title == null || typeof row.title === 'string') ||
        !(row.jobId == null || typeof row.jobId === 'string') ||
        !Number.isSafeInteger(row.startTime) ||
        !Number.isSafeInteger(row.endTime) ||
        row.startTime < 0 ||
        row.endTime <= row.startTime ||
        row.endTime > ROSTER_THROUGH ||
        !Array.isArray(row.assignedUserIds) ||
        row.assignedUserIds.some((v: unknown) => !Number.isSafeInteger(v) || Number(v) <= 0) ||
        new Set(row.assignedUserIds).size !== row.assignedUserIds.length ||
        typeof row.isPublished !== 'boolean' ||
        typeof row.isOpenShift !== 'boolean'
      )
        throw new ConnecteamError(
          'Connecteam returned an invalid or repeated shift. No shifts were imported.',
        );
      seenInWindow.add(row.id);
      const address = row.locationData?.gps?.address;
      if (address != null && typeof address !== 'string')
        throw new ConnecteamError(
          'Connecteam returned an invalid shift location. No shifts were imported.',
        );
      // Statuses are user actions, not a booking cancellation flag. Keep rejection visible for review.
      const latest = new Map<number, { time: number; status: string }>();
      if (row.statuses != null && !Array.isArray(row.statuses))
        throw new ConnecteamError(
          'Connecteam returned invalid shift statuses. No shifts were imported.',
        );
      for (const status of row.statuses || []) {
        if (
          !status ||
          !Number.isSafeInteger(status.assignedUserId) ||
          typeof status.status !== 'string'
        )
          continue;
        const time = Number(status.updateTime ?? status.creationTime ?? 0);
        if (!Number.isFinite(time)) continue;
        if (!latest.has(status.assignedUserId) || latest.get(status.assignedUserId)!.time <= time)
          latest.set(status.assignedUserId, { time, status: status.status });
      }
      const parsed: ConnecteamRosterShift = {
        id: row.id,
        title: row.title?.trim() || '',
        jobId: row.jobId?.trim() || null,
        startTime: row.startTime,
        endTime: row.endTime,
        assignedUserIds: row.assignedUserIds,
        isPublished: row.isPublished,
        isOpenShift: row.isOpenShift,
        location: address?.trim() || '',
        rejectedUserIds: [...latest]
          .filter(([, v]) => v.status === 'rejected' || v.status === 'unclaimed')
          .map(([user]) => user),
      };
      // The same overnight shift can overlap adjacent windows. It must remain identical.
      if (seen.has(parsed.id)) {
        if (JSON.stringify(seen.get(parsed.id)) !== JSON.stringify(parsed))
          throw new ConnecteamError(
            'The Connecteam roster changed during the scan. Retry before importing.',
          );
      } else {
        shifts.push(parsed);
        seen.set(parsed.id, parsed);
      }
    }
    const next = body.paging?.offset;
    if (!rows.length || (rows.length < 500 && next == null)) {
      windows++;
      if (windowThrough === ROSTER_THROUGH)
        return {
          scheduler,
          checkedAt: new Date().toISOString(),
          from,
          through: ROSTER_THROUGH,
          shifts,
        };
      windowFrom = windowThrough;
      offset = 0;
      seenInWindow.clear();
      if (windows % 10 === 0)
        console.log(
          `Connecteam roster scan: ${windows} date windows checked; ${shifts.length} shifts read.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if (!Number.isSafeInteger(next) || Number(next) <= offset)
      throw new ConnecteamError(
        'Connecteam roster pagination did not advance. No shifts were imported.',
      );
    offset = Number(next);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new ConnecteamError(
    'Connecteam roster exceeded the import page limit. No shifts were imported.',
  );
}
