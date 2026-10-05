import type { Participant, Shift, StaffMember, SupportType } from '../shared/types.ts';
import { outboundDispatcher } from './network.ts';

/** The PAT and all Airtable requests stay on the server. No configuration writes occur here. */
type Environment = Record<string, string | undefined>;
type TableKey = 'participants' | 'shifts' | 'events' | 'rsvps';
type FieldMap = Record<TableKey, Record<string, string | null>>;
type FieldValue = string | number | boolean | string[] | null;
type ShiftLabels = {
  [K in 'status' | 'driving' | 'gender' | 'kind' | 'source']: Record<Shift[K], string>;
};
const DEFAULT_SHIFT_LABELS: ShiftLabels = {
  status: {
    requested: 'Requested',
    confirmed: 'Confirmed',
    declined: 'Declined',
    cancelled: 'Cancelled',
  },
  driving: { required: 'Required', not_required: 'Not required', no_preference: 'No preference' },
  gender: { female: 'Female', male: 'Male', no_preference: 'No preference' },
  kind: { general: 'General', event: 'Event' },
  source: { client: 'Client', staff: 'Staff', event: 'Event' },
};

const DEFAULT_FIELDS: FieldMap = {
  participants: { name: 'Name', supportType: 'Support type' },
  shifts: {
    portalId: 'Portal request ID',
    participant: 'Participant',
    start: 'Start',
    end: 'End',
    description: 'Support description',
    location: 'Location',
    driving: 'Driving preference',
    gender: 'Gender preference',
    notes: 'Notes',
    kind: 'Support kind',
    status: 'Status',
    source: 'Source',
    event: 'Event',
    staffName: 'Staff name',
    staff: null,
    pendingChange: 'Pending change',
    updatedAt: 'Portal updated at',
  },
  events: {
    name: 'Name',
    start: 'Start',
    end: 'End',
    location: 'Location',
    description: null,
    status: null,
  },
  rsvps: { participant: 'Participant', event: 'Event', status: 'Status', cancelledAt: null },
};
const REQUIRED_FIELDS: Record<TableKey, string[]> = {
  participants: ['name', 'supportType'],
  shifts: ['portalId', 'participant', 'start', 'end', 'description', 'status'],
  events: ['name', 'start', 'end'],
  rsvps: ['participant', 'event', 'status'],
};
const TEXT_TYPES = ['singleLineText', 'multilineText', 'richText'];
const SELECT_TYPES = ['singleSelect', 'singleLineText'];
const EXPECTED_TYPES: Record<TableKey, Record<string, string[]>> = {
  participants: { name: TEXT_TYPES, supportType: SELECT_TYPES },
  shifts: {
    portalId: ['singleLineText'],
    participant: ['multipleRecordLinks'],
    start: ['dateTime'],
    end: ['dateTime'],
    description: TEXT_TYPES,
    location: TEXT_TYPES,
    driving: SELECT_TYPES,
    gender: SELECT_TYPES,
    notes: TEXT_TYPES,
    kind: SELECT_TYPES,
    status: SELECT_TYPES,
    source: SELECT_TYPES,
    event: ['multipleRecordLinks'],
    staffName: TEXT_TYPES,
    staff: ['multipleRecordLinks'],
    pendingChange: TEXT_TYPES,
    updatedAt: ['dateTime'],
  },
  events: {
    name: TEXT_TYPES,
    start: ['dateTime'],
    end: ['dateTime'],
    location: TEXT_TYPES,
    description: TEXT_TYPES,
    status: SELECT_TYPES,
  },
  rsvps: {
    participant: ['multipleRecordLinks'],
    event: ['multipleRecordLinks'],
    status: SELECT_TYPES,
    cancelledAt: ['dateTime'],
  },
};

interface AirtableConfig {
  token: string;
  baseId: string;
  tables: Record<TableKey, string>;
  fields: FieldMap;
  staffRecords: Record<string, string>;
  supportValues: Record<string, SupportType>;
  rsvpValues: Record<string, 'attending' | 'cancelled'>;
  shiftStatusValues: Record<string, Shift['status']>;
  shiftLabels: ShiftLabels;
}
export interface AirtableStatus {
  configured: boolean;
  missing: string[];
  problems: string[];
  tables: Record<TableKey, string>;
}
export interface SchemaIssue {
  severity: 'error' | 'warning';
  table: TableKey;
  field?: string;
  message: string;
}
export interface SchemaReport {
  ok: boolean;
  checkedAt: string;
  tables: Array<{ key: TableKey; name: string; id?: string; found: boolean }>;
  issues: SchemaIssue[];
}

/** The outbox should honor retryAfterMs when scheduling the next attempt. */
export class AirtableRequestError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AirtableRequestError';
  }
}

function configuration(env: Environment): { config: AirtableConfig; status: AirtableStatus } {
  const missing = ['AIRTABLE_PAT', 'AIRTABLE_BASE_ID', 'AIRTABLE_PARTICIPANTS_TABLE'].filter(
    (key) => !env[key]?.trim(),
  );
  const problems: string[] = [];
  const tables = {
    participants: env.AIRTABLE_PARTICIPANTS_TABLE?.trim() || '',
    shifts: env.AIRTABLE_SHIFTS_TABLE?.trim() || 'Shift Requests',
    events: env.AIRTABLE_EVENTS_TABLE?.trim() || 'Events',
    rsvps: env.AIRTABLE_RSVPS_TABLE?.trim() || 'RSVPs',
  };
  const fields: FieldMap = structuredClone(DEFAULT_FIELDS);
  if (env.AIRTABLE_FIELD_MAP) {
    try {
      const override: unknown = JSON.parse(env.AIRTABLE_FIELD_MAP);
      if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error();
      for (const [table, mapping] of Object.entries(override)) {
        if (
          !Object.hasOwn(fields, table) ||
          !mapping ||
          typeof mapping !== 'object' ||
          Array.isArray(mapping)
        )
          throw new Error();
        for (const [key, value] of Object.entries(mapping)) {
          if (!Object.hasOwn(fields[table as TableKey], key)) throw new Error();
          if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error();
          if (value === null && REQUIRED_FIELDS[table as TableKey].includes(key)) throw new Error();
          fields[table as TableKey][key] = typeof value === 'string' ? value.trim() : null;
        }
      }
      for (const mapping of Object.values(fields)) {
        const names = Object.values(mapping).filter((value) => value !== null);
        if (new Set(names).size !== names.length) throw new Error();
      }
    } catch {
      problems.push(
        'AIRTABLE_FIELD_MAP must map known semantic keys to distinct field names or IDs; required fields cannot be disabled.',
      );
    }
  }
  let staffRecords: Record<string, string> = {};
  if (env.AIRTABLE_STAFF_RECORD_MAP) {
    try {
      const parsed: unknown = JSON.parse(env.AIRTABLE_STAFF_RECORD_MAP);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      if (Object.values(parsed).some((id) => typeof id !== 'string' || !isRecordId(id)))
        throw new Error();
      if (new Set(Object.values(parsed)).size !== Object.values(parsed).length) throw new Error();
      staffRecords = parsed as Record<string, string>;
    } catch {
      problems.push('AIRTABLE_STAFF_RECORD_MAP must map portal staff IDs to Airtable record IDs.');
    }
  }
  const baseId = env.AIRTABLE_BASE_ID?.trim() || '';
  if (baseId && !/^app[A-Za-z0-9]+$/.test(baseId))
    problems.push('AIRTABLE_BASE_ID must be an Airtable base ID, beginning with app.');
  const supportValues: Record<string, SupportType> = {
    general: 'general',
    'general support': 'general',
    'general only': 'general',
    event: 'events',
    events: 'events',
    'event only': 'events',
    'events only': 'events',
    'event support': 'events',
    'event support only': 'events',
    both: 'both',
    'general and events': 'both',
    'general and event support': 'both',
    '': 'none', // An unset master switch never grants automatic support.
    none: 'none',
    'no support': 'none',
  };
  const rsvpValues: Record<string, 'attending' | 'cancelled'> = {
    attending: 'attending',
    confirmed: 'attending',
    yes: 'attending',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    declined: 'cancelled',
    no: 'cancelled',
  };
  const shiftStatusValues: Record<string, Shift['status']> = {
    requested: 'requested',
    pending: 'requested',
    'pending approval': 'requested',
    'awaiting approval': 'requested',
    confirmed: 'confirmed',
    approved: 'confirmed',
    booked: 'confirmed',
    declined: 'declined',
    rejected: 'declined',
    cancelled: 'cancelled',
    canceled: 'cancelled',
  };
  const shiftLabels: ShiftLabels = structuredClone(DEFAULT_SHIFT_LABELS);
  if (env.AIRTABLE_SHIFT_VALUE_MAP) {
    try {
      const parsed: unknown = JSON.parse(env.AIRTABLE_SHIFT_VALUE_MAP);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      for (const [semantic, mapping] of Object.entries(parsed)) {
        if (
          !Object.hasOwn(shiftLabels, semantic) ||
          !mapping ||
          typeof mapping !== 'object' ||
          Array.isArray(mapping)
        )
          throw new Error();
        const labels = shiftLabels[semantic as keyof ShiftLabels] as Record<string, string>;
        for (const [value, label] of Object.entries(mapping)) {
          if (
            !Object.hasOwn(labels, value) ||
            typeof label !== 'string' ||
            !label.trim() ||
            label.trim().length > 200
          )
            throw new Error();
          labels[value] = label.trim();
        }
        // Different portal choices must remain distinct in the existing board.
        if (new Set(Object.values(labels).map(normalizeLabel)).size !== Object.keys(labels).length)
          throw new Error();
      }
    } catch {
      problems.push(
        'AIRTABLE_SHIFT_VALUE_MAP must map known portal status/preference/kind/source values to distinct Airtable labels.',
      );
    }
  }
  for (const [value, label] of Object.entries(shiftLabels.status))
    shiftStatusValues[normalizeLabel(label)] = value as Shift['status'];
  for (const [variable, target, allowed] of [
    ['AIRTABLE_SUPPORT_TYPE_MAP', supportValues, ['general', 'events', 'both', 'none']],
    ['AIRTABLE_RSVP_STATUS_MAP', rsvpValues, ['attending', 'cancelled']],
    [
      'AIRTABLE_SHIFT_STATUS_MAP',
      shiftStatusValues,
      ['requested', 'confirmed', 'declined', 'cancelled'],
    ],
  ] as const) {
    if (!env[variable]) continue;
    try {
      const parsed: unknown = JSON.parse(env[variable]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      for (const [label, value] of Object.entries(parsed)) {
        if (
          !label.trim() ||
          typeof value !== 'string' ||
          !(allowed as readonly string[]).includes(value)
        )
          throw new Error();
        (target as Record<string, string>)[normalizeLabel(label)] = value;
      }
    } catch {
      problems.push(`${variable} must map existing labels to supported portal values.`);
    }
  }
  const status = {
    configured: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    tables,
  };
  return {
    config: {
      token: env.AIRTABLE_PAT?.trim() || '',
      baseId,
      tables,
      fields,
      staffRecords,
      supportValues,
      rsvpValues,
      shiftStatusValues,
      shiftLabels,
    },
    status,
  };
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function getAirtableStatus(env: Environment = process.env): AirtableStatus {
  return configuration(env).status;
}

function requireConfiguration(env: Environment = process.env): AirtableConfig {
  const { config, status } = configuration(env);
  if (!status.configured)
    throw new Error(
      `Airtable is not configured. ${status.missing.length ? `Missing: ${status.missing.join(', ')}. ` : ''}${status.problems.join(' ')}`,
    );
  return config;
}

function isRecordId(id: string): boolean {
  return /^rec[A-Za-z0-9]{14}$/.test(id);
}
function linkedRecord(id: string | undefined, label: string): string[] {
  if (!id || !isRecordId(id))
    throw new Error(
      `${label} needs a valid linked Airtable record ID before this request can sync.`,
    );
  return [id];
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    const millis = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(millis)) return Math.max(0, millis);
  }
  return response.status === 429 ? 30_000 : 500 * 2 ** attempt;
}

async function request<T>(
  config: AirtableConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      const options = {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(15_000),
        dispatcher: outboundDispatcher(),
      };
      response = await fetch(`https://api.airtable.com/v0/${path}`, options);
    } catch {
      throw new AirtableRequestError(
        'Could not connect to Airtable, or the connection timed out. Check the hosting service network connection and retry.',
      );
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const delay = retryDelay(response, attempt);
      // Do not retry sooner than Airtable permits; a long backoff belongs in the durable outbox.
      if (delay > 60_000) {
        await response.body?.cancel();
        throw new AirtableRequestError(
          'Airtable requested a longer retry delay. Retry this queued request later.',
          delay,
        );
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    if (!response.ok) {
      const guidance: Record<number, string> = {
        401: 'Airtable rejected the personal access token. Check AIRTABLE_PAT in Render contains the complete, current token value, without quotes.',
        403: 'Check the token has access to the Mates That Matter base and the required scopes: schema.bases:read for field checks, data.records:read for imports, and data.records:write for synchronization. Also verify AIRTABLE_BASE_ID in Render.',
        404: 'Check the configured base, table and record IDs.',
        422: 'Check field mappings, writable field types, select options and linked record IDs.',
        429: 'Airtable is rate limiting requests; retry the queued request later.',
      };
      // Do not forward external response bodies: they can contain participant data or secrets.
      throw new AirtableRequestError(
        `Airtable returned HTTP ${response.status}. ${guidance[response.status] || 'Retry the queued request later.'}`,
        response.status === 429 || response.status >= 500
          ? retryDelay(response, attempt)
          : undefined,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('Airtable returned an unreadable response.');
    }
  }
  throw new Error('Airtable is temporarily unavailable.');
}

interface MetadataField {
  id: string;
  name: string;
  type: string;
  options?: {
    linkedTableId?: string;
    choices?: Array<{ name: string }>;
    result?: { type?: string };
  };
}
interface MetadataTable {
  id: string;
  name: string;
  fields: MetadataField[];
}

/** Read-only schema audit. Never creates tables, fields, select options, or records. */
export async function inspectAirtableSchema(env: Environment = process.env): Promise<SchemaReport> {
  const config = requireConfiguration(env);
  const metadata = await request<{ tables: MetadataTable[] }>(
    config,
    `meta/bases/${encodeURIComponent(config.baseId)}/tables`,
  );
  if (!Array.isArray(metadata.tables))
    throw new Error('Airtable returned an invalid schema response.');
  const issues: SchemaIssue[] = [];
  const resolved = {} as Record<TableKey, MetadataTable | undefined>;
  const tables = (Object.keys(config.tables) as TableKey[]).map((key) => {
    const table = metadata.tables.find(
      (candidate) => candidate.name === config.tables[key] || candidate.id === config.tables[key],
    );
    resolved[key] = table;
    if (!table)
      issues.push({
        severity: 'error',
        table: key,
        message: 'Configured table was not found in this base.',
      });
    return { key, name: table?.name || config.tables[key], id: table?.id, found: Boolean(table) };
  });
  const relations: Partial<Record<TableKey, Record<string, TableKey>>> = {
    shifts: { participant: 'participants', event: 'events' },
    rsvps: { participant: 'participants', event: 'events' },
  };
  const choices: Partial<Record<TableKey, Record<string, string[]>>> = {
    shifts: Object.fromEntries(
      Object.entries(config.shiftLabels).map(([key, labels]) => [key, Object.values(labels)]),
    ),
  };
  for (const key of Object.keys(config.tables) as TableKey[]) {
    const table = resolved[key];
    if (!table) continue;
    for (const [semantic, mapped] of Object.entries(config.fields[key])) {
      if (!mapped) continue;
      const field = table.fields.find(
        (candidate) => candidate.name === mapped || candidate.id === mapped,
      );
      if (!field) {
        issues.push({
          severity:
            key === 'shifts' || REQUIRED_FIELDS[key].includes(semantic) ? 'error' : 'warning',
          table: key,
          field: mapped,
          message:
            'Mapped field was not found. Reuse an existing compatible field by updating AIRTABLE_FIELD_MAP, or add the proposed field.',
        });
        continue;
      }
      const types = EXPECTED_TYPES[key][semantic];
      // The portal only writes Shift Requests. Scalar formula results elsewhere are safe to read.
      const compatibleFormula =
        key !== 'shifts' &&
        field.type === 'formula' &&
        field.options?.result?.type &&
        types?.includes(field.options.result.type);
      if (types && !types.includes(field.type) && !compatibleFormula)
        issues.push({
          severity: 'error',
          table: key,
          field: field.name,
          message: `Expected ${types.join(' or ')}; found ${field.type}. ${key === 'shifts' ? 'Formula, lookup and rollup fields cannot receive portal updates.' : 'Only compatible scalar formula results can be read; linked arrays cannot substitute for scalar values.'}`,
        });
      const target = relations[key]?.[semantic];
      if (
        target &&
        field.type === 'multipleRecordLinks' &&
        resolved[target] &&
        field.options?.linkedTableId !== resolved[target]!.id
      ) {
        issues.push({
          severity: 'error',
          table: key,
          field: field.name,
          message: `Linked-record field must point to the configured ${target} table.`,
        });
      }
      const expectedChoices = choices[key]?.[semantic];
      if (field.type === 'singleSelect' && expectedChoices) {
        const existing = new Set(field.options?.choices?.map((choice) => choice.name));
        const missingChoices = expectedChoices.filter((choice) => !existing.has(choice));
        if (missingChoices.length)
          issues.push({
            severity: 'error',
            table: key,
            field: field.name,
            message: `Missing select options used by the portal: ${missingChoices.join(', ')}.`,
          });
      }
      const incomingLabels =
        key === 'participants' && semantic === 'supportType'
          ? config.supportValues
          : key === 'rsvps' && semantic === 'status'
            ? config.rsvpValues
            : undefined;
      if (field.type === 'singleSelect' && incomingLabels) {
        const unmapped =
          field.options?.choices
            ?.filter((choice) => !Object.hasOwn(incomingLabels, normalizeLabel(choice.name)))
            .map((choice) => choice.name) || [];
        if (unmapped.length)
          issues.push({
            severity: 'error',
            table: key,
            field: field.name,
            message: `Existing select choices need an explicit portal mapping before import: ${unmapped.join(', ')}.`,
          });
      }
    }
  }
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    checkedAt: new Date().toISOString(),
    tables,
    issues,
  };
}

export interface ShiftSyncInput {
  shift: Shift;
  participant: Participant;
  staff: StaffMember | null;
  /** Existing external mapping; never treat a local portal ID as an Airtable record ID. */
  recordId?: string;
  eventAirtableId?: string;
}

/** Called by the durable outbox. Upsert key prevents retries creating duplicate requests. */
export async function syncShiftToAirtable(
  input: ShiftSyncInput,
  env: Environment = process.env,
): Promise<{ recordId: string }> {
  const config = requireConfiguration(env);
  const { shift, participant, staff } = input;
  if (shift.participantId !== participant.id)
    throw new Error('Shift participant mapping does not match.');
  if (shift.staffId !== (staff?.id ?? null)) throw new Error('Shift staff mapping does not match.');
  const fields: Record<string, FieldValue> = {};
  const set = (semantic: string, value: FieldValue) => {
    const field = config.fields.shifts[semantic];
    if (field) fields[field] = value;
  };
  set('portalId', shift.id);
  set('participant', linkedRecord(participant.airtableId, 'Participant'));
  set('start', shift.start);
  set('end', shift.end);
  set('description', shift.description);
  set('location', shift.location);
  set('notes', shift.notes);
  for (const key of ['driving', 'gender', 'kind', 'status', 'source'] as const)
    set(key, (config.shiftLabels[key] as Record<string, string>)[shift[key]]);
  set('staffName', staff?.name || shift.staffDisplayName || '');
  // An imported text-only assignment is not an instruction to erase an existing linked worker.
  if (config.fields.shifts.staff && (staff || !shift.staffDisplayName)) {
    set(
      'staff',
      staff ? linkedRecord(staff.airtableId || config.staffRecords[staff.id], 'Staff member') : [],
    );
  }
  if (config.fields.shifts.event)
    set('event', shift.eventId ? linkedRecord(input.eventAirtableId, 'Event') : []);
  // Pending changes are visible in Airtable without applying their proposed times/status before staff approval.
  set('pendingChange', shift.pendingChange ? JSON.stringify(shift.pendingChange) : '');
  set('updatedAt', shift.updatedAt);
  if (input.recordId && !isRecordId(input.recordId))
    throw new Error('Saved Airtable request record ID is invalid.');
  const payload = {
    performUpsert: { fieldsToMergeOn: [config.fields.shifts.portalId!] },
    records: [{ ...(input.recordId ? { id: input.recordId } : {}), fields }],
    typecast: false,
  };
  const result = await request<{ records: Array<{ id: string }> }>(
    config,
    `${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.tables.shifts)}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  );
  const recordId = result.records?.[0]?.id;
  if (!recordId || !isRecordId(recordId))
    throw new Error('Airtable did not return a valid request record ID.');
  return { recordId };
}

/** Read-only import primitive; callers must validate field mappings and control who can import. */
export async function readAirtableRecords(
  table: TableKey,
  env: Environment = process.env,
  selectedFields?: string[],
): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const config = requireConfiguration(env);
  const records: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({ pageSize: '100' });
    // Initial import only needs mapped fields, not the base's billing, health or contact details.
    for (const field of selectedFields || []) query.append('fields[]', field);
    if (offset) query.set('offset', offset);
    const page = await request<{
      records: Array<{ id: string; fields: Record<string, unknown> }>;
      offset?: string;
    }>(
      config,
      `${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.tables[table])}?${query}`,
    );
    if (!Array.isArray(page.records))
      throw new Error('Airtable returned an invalid records response.');
    records.push(...page.records);
    offset = page.offset;
    if (offset && seen.has(offset))
      throw new Error('Airtable returned a repeated pagination cursor.');
    if (offset) seen.add(offset);
    if (records.length > 100_000)
      throw new Error(
        'Airtable import exceeded the configured safety limit. Import a narrower dataset.',
      );
  } while (offset);
  return records;
}

export interface AirtableSnapshot {
  participants: Array<{ airtableId: string; name: string; supportType: SupportType }>;
  events: Array<{
    airtableId: string;
    title: string;
    start: string;
    end: string;
    location: string;
    description: string;
  }>;
  /** Multiple linked participants are expanded. The caller uses RSVP ID + participant ID as external identity. */
  rsvps: Array<{
    airtableId: string;
    eventAirtableId: string;
    participantAirtableId: string;
    status: 'attending' | 'cancelled';
  }>;
  shifts: Array<
    Pick<
      Shift,
      | 'start'
      | 'end'
      | 'description'
      | 'location'
      | 'driving'
      | 'gender'
      | 'notes'
      | 'kind'
      | 'status'
      | 'source'
    > & {
      airtableId: string;
      portalId?: string;
      participantAirtableId: string;
      eventAirtableId: string | null;
      staffName: string;
      staffAirtableId?: string;
      staffPortalId?: string;
    }
  >;
}

/** Fully validates a read-only initial import before its caller changes the local database. */
export async function readAirtableSnapshot(
  env: Environment = process.env,
): Promise<AirtableSnapshot> {
  const config = requireConfiguration(env);
  const metadata = await request<{ tables: MetadataTable[] }>(
    config,
    `meta/bases/${encodeURIComponent(config.baseId)}/tables`,
  );
  if (!Array.isArray(metadata.tables))
    throw new Error('Airtable returned an invalid schema response.');
  const resolvedFields: Partial<Record<TableKey, Record<string, string | null>>> = {};
  for (const key of ['participants', 'events', 'rsvps', 'shifts'] as const) {
    const table = metadata.tables.find(
      (candidate) => candidate.name === config.tables[key] || candidate.id === config.tables[key],
    );
    if (!table)
      throw new Error(
        `Initial import could not find the configured ${key} table. Check its mapping.`,
      );
    const names: Record<string, string | null> = {};
    for (const [semantic, mapped] of Object.entries(config.fields[key])) {
      const field = mapped
        ? table.fields.find((candidate) => candidate.name === mapped || candidate.id === mapped)
        : undefined;
      // Legacy board rows may predate the portal identifier; the caller saves their existing record IDs.
      if (
        !field &&
        (REQUIRED_FIELDS[key].includes(semantic) ||
          (Boolean(mapped) &&
            ((key === 'events' && semantic === 'status') ||
              (key === 'rsvps' && semantic === 'cancelledAt')))) &&
        !(key === 'shifts' && semantic === 'portalId')
      )
        throw new Error(
          `Initial import could not find a required ${key}.${semantic} field. Check AIRTABLE_FIELD_MAP.`,
        );
      names[semantic] = field?.name || null;
    }
    resolvedFields[key] = names;
  }
  const [people, events, rsvps, shifts] = await Promise.all([
    ...(['participants', 'events', 'rsvps', 'shifts'] as const).map((table) =>
      readAirtableRecords(
        table,
        env,
        Object.values(resolvedFields[table]!).filter((field): field is string => field !== null),
      ),
    ),
  ]);
  function invalid(table: string, index: number, requirement: string): never {
    // Report the position and field purpose, not the record values or participant names.
    throw new Error(
      `Initial import stopped: ${table} row ${index + 1} ${requirement}. No local changes have been applied.`,
    );
  }
  function value(
    table: TableKey,
    record: { fields: Record<string, unknown> },
    semantic: string,
  ): unknown {
    const name = resolvedFields[table]?.[semantic];
    return name ? record.fields[name] : undefined;
  }
  function text(
    table: TableKey,
    record: { fields: Record<string, unknown> },
    semantic: string,
    index: number,
    max: number,
    required = true,
  ): string {
    const raw = value(table, record, semantic);
    if (!required && (raw === undefined || raw === null || raw === '')) return '';
    if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > max)
      invalid(table, index, `needs a valid ${semantic} text value (maximum ${max} characters)`);
    return raw.trim();
  }
  const snapshot: AirtableSnapshot = { participants: [], events: [], rsvps: [], shifts: [] };
  const cancelledEvents = new Set<string>();
  for (const [index, record] of people.entries()) {
    if (!isRecordId(record.id)) invalid('participants', index, 'has an invalid Airtable record ID');
    const name = text('participants', record, 'name', index, 150);
    const label = normalizeLabel(text('participants', record, 'supportType', index, 200, false));
    const supportType = Object.hasOwn(config.supportValues, label)
      ? config.supportValues[label]
      : undefined;
    if (!supportType)
      invalid(
        'participants',
        index,
        'has an unmapped support type; configure AIRTABLE_SUPPORT_TYPE_MAP',
      );
    snapshot.participants.push({ airtableId: record.id, name, supportType });
  }
  for (const [index, record] of events.entries()) {
    if (!isRecordId(record.id)) invalid('events', index, 'has an invalid Airtable record ID');
    const title = text('events', record, 'name', index, 180);
    const startValue = text('events', record, 'start', index, 100);
    const endValue = text('events', record, 'end', index, 100);
    const startTime = Date.parse(startValue),
      endTime = Date.parse(endValue);
    if (
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime) ||
      endTime <= startTime ||
      endTime - startTime > 47 * 60 * 60 * 1000
    ) {
      invalid('events', index, 'needs valid start/end times with a duration of at most 47 hours');
    }
    const eventStatus = normalizeLabel(text('events', record, 'status', index, 200, false));
    if (eventStatus === 'cancelled' || eventStatus === 'canceled') cancelledEvents.add(record.id);
    snapshot.events.push({
      airtableId: record.id,
      title,
      start: new Date(startTime).toISOString(),
      end: new Date(endTime).toISOString(),
      location: text('events', record, 'location', index, 300, false),
      description: text('events', record, 'description', index, 3000, false),
    });
  }
  const participantIds = new Set(
    snapshot.participants.map((participant) => participant.airtableId),
  );
  const eventIds = new Set(snapshot.events.map((event) => event.airtableId));
  function links(
    record: { fields: Record<string, unknown> },
    semantic: string,
    index: number,
    table: TableKey = 'rsvps',
    required = true,
  ): string[] {
    const raw = value(table, record, semantic);
    if (
      !required &&
      (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0))
    )
      return [];
    if (
      !Array.isArray(raw) ||
      !raw.length ||
      raw.some((id) => typeof id !== 'string' || !isRecordId(id))
    )
      invalid(table, index, `needs linked ${semantic} record IDs`);
    return [...new Set(raw as string[])];
  }
  for (const [index, record] of rsvps.entries()) {
    if (!isRecordId(record.id)) invalid('rsvps', index, 'has an invalid Airtable record ID');
    const eventLinks = links(record, 'event', index);
    const participantLinks = links(record, 'participant', index);
    if (eventLinks.length !== 1 || !eventIds.has(eventLinks[0]))
      invalid('rsvps', index, 'must link exactly one event present in the imported Events table');
    if (participantLinks.some((id) => !participantIds.has(id)))
      invalid('rsvps', index, 'links a participant missing from the imported participants table');
    const cancelledAt = text('rsvps', record, 'cancelledAt', index, 100, false);
    if (cancelledAt && !Number.isFinite(Date.parse(cancelledAt)))
      invalid('rsvps', index, 'needs a valid cancellation timestamp');
    const label = normalizeLabel(text('rsvps', record, 'status', index, 200, false));
    const status =
      cancelledAt || cancelledEvents.has(eventLinks[0])
        ? 'cancelled'
        : Object.hasOwn(config.rsvpValues, label)
          ? config.rsvpValues[label]
          : undefined;
    if (!status)
      invalid(
        'rsvps',
        index,
        'has an unmapped attendance status; configure AIRTABLE_RSVP_STATUS_MAP',
      );
    for (const participantAirtableId of participantLinks)
      snapshot.rsvps.push({
        airtableId: record.id,
        eventAirtableId: eventLinks[0],
        participantAirtableId,
        status,
      });
  }
  // Duplicate RSVP rows can represent one pair, but contradictory attendance is not safely inferable.
  const pairStates = new Map<string, string>();
  for (const rsvp of snapshot.rsvps) {
    const pair = `${rsvp.eventAirtableId}:${rsvp.participantAirtableId}`;
    if (pairStates.has(pair) && pairStates.get(pair) !== rsvp.status)
      throw new Error(
        'Initial import stopped: duplicate RSVPs contain conflicting attendance for the same event and participant. Resolve them before importing. No local changes have been applied.',
      );
    pairStates.set(pair, rsvp.status);
  }
  const portalIds = new Set<string>();
  const shiftPairs = new Set<string>();
  function select<T extends string>(
    record: { fields: Record<string, unknown> },
    semantic: string,
    index: number,
    choices: Record<string, T>,
    fallback?: T,
  ): T {
    const label = normalizeLabel(
      text('shifts', record, semantic, index, 200, fallback === undefined),
    );
    if (!label && fallback !== undefined) return fallback;
    const configuredLabels: Record<string, string> = Object.hasOwn(config.shiftLabels, semantic)
      ? config.shiftLabels[semantic as keyof ShiftLabels]
      : {};
    const configuredValue = Object.entries(configuredLabels).find(
      ([, existing]) => normalizeLabel(existing) === label,
    )?.[0];
    const result =
      semantic === 'status'
        ? Object.hasOwn(choices, label)
          ? choices[label]
          : undefined
        : ((configuredValue as T | undefined) ??
          (Object.hasOwn(choices, label) ? choices[label] : undefined));
    if (result === undefined)
      invalid(
        'shifts',
        index,
        `has an unsupported ${semantic} value${semantic === 'status' ? '; configure AIRTABLE_SHIFT_STATUS_MAP' : ''}`,
      );
    return result;
  }
  for (const [index, record] of shifts.entries()) {
    if (!isRecordId(record.id)) invalid('shifts', index, 'has an invalid Airtable record ID');
    const participantLinks = links(record, 'participant', index, 'shifts');
    const eventLinks = links(record, 'event', index, 'shifts', false);
    const staffLinks = links(record, 'staff', index, 'shifts', false);
    if (participantLinks.length !== 1 || !participantIds.has(participantLinks[0]))
      invalid(
        'shifts',
        index,
        'must link exactly one participant present in the imported participants table',
      );
    if (eventLinks.length > 1 || (eventLinks[0] && !eventIds.has(eventLinks[0])))
      invalid('shifts', index, 'must link at most one event present in the imported Events table');
    if (staffLinks.length > 1)
      invalid('shifts', index, 'must link at most one assigned staff record');
    const portalId = text('shifts', record, 'portalId', index, 100, false) || undefined;
    if (portalId && portalIds.has(portalId))
      invalid('shifts', index, 'duplicates another Portal request ID');
    if (portalId) portalIds.add(portalId);
    const start = text('shifts', record, 'start', index, 100);
    const end = text('shifts', record, 'end', index, 100);
    const startTime = Date.parse(start),
      endTime = Date.parse(end);
    if (
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime) ||
      endTime <= startTime ||
      endTime - startTime > 48 * 60 * 60 * 1000
    )
      invalid('shifts', index, 'needs valid start/end times with a duration of at most 48 hours');
    const eventAirtableId = eventLinks[0] || null;
    const kind = select<Shift['kind']>(
      record,
      'kind',
      index,
      {
        general: 'general',
        'general support': 'general',
        event: 'event',
        'event support': 'event',
      },
      eventAirtableId ? 'event' : 'general',
    );
    if (kind === 'event' && !eventAirtableId)
      invalid('shifts', index, 'needs an Event link for event support');
    if (kind === 'general' && eventAirtableId)
      invalid('shifts', index, 'has a General support kind with an Event link');
    if (eventAirtableId) {
      const pair = `${eventAirtableId}:${participantLinks[0]}`;
      if (shiftPairs.has(pair))
        invalid(
          'shifts',
          index,
          'duplicates another existing shift for the same event and participant; reconcile these rows before importing',
        );
      shiftPairs.add(pair);
    }
    snapshot.shifts.push({
      airtableId: record.id,
      portalId,
      participantAirtableId: participantLinks[0],
      eventAirtableId,
      staffName: text('shifts', record, 'staffName', index, 150, false),
      staffAirtableId: staffLinks[0],
      staffPortalId: staffLinks[0]
        ? Object.entries(config.staffRecords).find(
            ([, externalId]) => externalId === staffLinks[0],
          )?.[0]
        : undefined,
      start: new Date(startTime).toISOString(),
      end: new Date(endTime).toISOString(),
      description: text('shifts', record, 'description', index, 3000),
      location: text('shifts', record, 'location', index, 300, false),
      notes: text('shifts', record, 'notes', index, 3000, false),
      kind,
      status: select(record, 'status', index, config.shiftStatusValues),
      source: select<Shift['source']>(
        record,
        'source',
        index,
        {
          client: 'client',
          participant: 'client',
          'fillout form': 'client',
          staff: 'staff',
          office: 'staff',
          event: 'event',
          'circle rsvp': 'event',
          automation: 'event',
        },
        'staff',
      ),
      driving: select<Shift['driving']>(
        record,
        'driving',
        index,
        {
          required: 'required',
          'driving required': 'required',
          yes: 'required',
          'not required': 'not_required',
          'non driving': 'not_required',
          no: 'not_required',
          'no preference': 'no_preference',
          any: 'no_preference',
        },
        'no_preference',
      ),
      gender: select<Shift['gender']>(
        record,
        'gender',
        index,
        { female: 'female', male: 'male', 'no preference': 'no_preference', any: 'no_preference' },
        'no_preference',
      ),
    });
  }
  const assignedIds = [
    ...new Set(
      snapshot.shifts.flatMap((entry) => (entry.staffAirtableId ? [entry.staffAirtableId] : [])),
    ),
  ];
  if (assignedIds.length && config.fields.shifts.staff) {
    const shiftTable = metadata.tables.find(
      (table) => table.id === config.tables.shifts || table.name === config.tables.shifts,
    );
    const assignmentField = shiftTable?.fields.find(
      (field) =>
        field.id === config.fields.shifts.staff || field.name === config.fields.shifts.staff,
    );
    const staffTable = metadata.tables.find(
      (table) => table.id === assignmentField?.options?.linkedTableId,
    );
    const mappedName = env.AIRTABLE_STAFF_NAME_FIELD?.trim() || 'Name';
    const nameField = staffTable?.fields.find(
      (field) => field.name === mappedName || field.id === mappedName,
    );
    if (staffTable && nameField) {
      const nameType =
        nameField.type === 'formula' ? nameField.options?.result?.type : nameField.type;
      if (!nameType || !TEXT_TYPES.includes(nameType))
        throw new Error('Assigned staff name must be a text field or a scalar text formula.');
      const names = new Map<string, string>();
      for (let start = 0; start < assignedIds.length; start += 50) {
        const batch = assignedIds.slice(start, start + 50);
        const query = new URLSearchParams({
          pageSize: '100',
          filterByFormula: `OR(${batch.map((id) => `RECORD_ID()='${id}'`).join(',')})`,
        });
        query.append('fields[]', nameField.name);
        const result = await request<{
          records: Array<{ id: string; fields: Record<string, unknown> }>;
        }>(
          config,
          `${encodeURIComponent(config.baseId)}/${encodeURIComponent(staffTable.id)}?${query}`,
        );
        if (!Array.isArray(result.records))
          throw new Error('Airtable returned an invalid staff names response.');
        for (const record of result.records) {
          if (!batch.includes(record.id)) continue;
          const name = record.fields[nameField.name];
          if (typeof name === 'string' && name.trim() && name.trim().length <= 150)
            names.set(record.id, name.trim());
        }
      }
      for (const entry of snapshot.shifts)
        if (entry.staffAirtableId && names.has(entry.staffAirtableId))
          entry.staffName = names.get(entry.staffAirtableId)!;
    }
  }
  return snapshot;
}
