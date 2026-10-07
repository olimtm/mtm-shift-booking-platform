import {
  ConnecteamError,
  readConnecteamData,
  readConnecteamSchedulers,
  selectConnecteamScheduler,
  type ConnecteamScheduler,
} from './connecteam.ts';

// Covers the scheduler's full practical history and scheduled future, not just upcoming shifts.
export const ROSTER_FROM = 0;
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
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams({
      startTime: String(ROSTER_FROM),
      endTime: String(ROSTER_THROUGH),
      limit: '500',
      offset: String(offset),
      sort: 'created_at',
      order: 'asc',
    });
    const body = (await readConnecteamData(
      `/scheduler/v1/schedulers/${scheduler.schedulerId}/shifts?${params}`,
      env,
    )) as { data?: { shifts?: unknown }; paging?: { offset?: unknown } };
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
        seen.has(row.id) ||
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
      seen.add(row.id);
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
      shifts.push({
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
      });
    }
    const next = body.paging?.offset;
    if (!rows.length || (rows.length < 500 && next == null))
      return {
        scheduler,
        checkedAt: new Date().toISOString(),
        from: ROSTER_FROM,
        through: ROSTER_THROUGH,
        shifts,
      };
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
