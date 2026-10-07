import { outboundDispatcher } from './network.ts';

export interface ConnecteamScheduler {
  schedulerId: number;
  name: string;
  isArchived: boolean;
  timezone?: string;
}
export class ConnecteamError extends Error {}

/** Fixed-origin GET requests only. Importing must never change the remote roster. */
export async function readConnecteamData(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<unknown> {
  if (!path.startsWith('/scheduler/v1/schedulers'))
    throw new ConnecteamError('Unsupported Connecteam read endpoint.');
  const key = env.CONNECTEAM_API_KEY?.trim();
  if (!key || /^["']|["']$/.test(key))
    throw new ConnecteamError(
      'Set CONNECTEAM_API_KEY privately in Render using the complete API key, without quotes.',
    );
  let response: Response;
  try {
    response = await fetch(`https://api.connecteam.com${path}`, {
      method: 'GET',
      headers: { 'X-API-KEY': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      ...{ dispatcher: outboundDispatcher() },
    });
  } catch {
    throw new ConnecteamError(
      'Could not reach Connecteam. Check the connection and retry. No shifts were changed.',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConnecteamError(
      response.status === 401
        ? 'Connecteam rejected the API key (HTTP 401). No shifts were changed.'
        : response.status === 403
          ? 'Connecteam denied scheduler access (HTTP 403). Check API access for the Operations hub. No shifts were changed.'
          : `Connecteam returned HTTP ${response.status}. Retry the read-only check later. No shifts were changed.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConnecteamError('Connecteam returned an invalid JSON response.');
  }
  return body;
}

export async function readConnecteamSchedulers(
  env: Record<string, string | undefined> = process.env,
): Promise<ConnecteamScheduler[]> {
  const body = await readConnecteamData('/scheduler/v1/schedulers', env);
  const rows = (body as { data?: { schedulers?: unknown } })?.data?.schedulers;
  if (
    !Array.isArray(rows) ||
    rows.some(
      (r) =>
        !r ||
        !Number.isSafeInteger(r.schedulerId) ||
        r.schedulerId <= 0 ||
        typeof r.name !== 'string' ||
        typeof r.isArchived !== 'boolean',
    )
  )
    throw new ConnecteamError('Connecteam returned an invalid scheduler list.');
  return rows.map((r) => ({
    schedulerId: r.schedulerId,
    name: r.name,
    isArchived: r.isArchived,
    ...(typeof r.timezone === 'string' ? { timezone: r.timezone } : {}),
  }));
}

export function selectConnecteamScheduler(
  rows: ConnecteamScheduler[],
  env: Record<string, string | undefined> = process.env,
): ConnecteamScheduler {
  const requestedId = env.CONNECTEAM_SCHEDULER_ID?.trim();
  const name = env.CONNECTEAM_SCHEDULER_NAME?.trim() || 'NSW';
  if (requestedId && !/^[1-9]\d*$/.test(requestedId))
    throw new ConnecteamError('CONNECTEAM_SCHEDULER_ID must be a positive numeric scheduler ID.');
  const matches = rows.filter((r) =>
    requestedId
      ? String(r.schedulerId) === requestedId
      : r.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (matches.length !== 1)
    throw new ConnecteamError(
      'The selected Connecteam scheduler is missing or ambiguous. Set CONNECTEAM_SCHEDULER_ID to the intended scheduler.',
    );
  if (matches[0].isArchived)
    throw new ConnecteamError(
      'The selected Connecteam scheduler is archived. Choose an active scheduler.',
    );
  return matches[0];
}
