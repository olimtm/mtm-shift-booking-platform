import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Participant, StaffMember, Shift, SupportEvent, User } from '../shared/types.js';

export interface StoredUser extends User {
  passwordHash: string;
  disabled?: boolean;
}
export interface EventRecord extends SupportEvent {
  airtableId?: string;
}
type Entities = {
  participants: Participant;
  staff: StaffMember;
  shifts: Shift;
  events: EventRecord;
};
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,participant_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY,data TEXT NOT NULL,airtable_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,data TEXT NOT NULL,airtable_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS shifts (id TEXT PRIMARY KEY,data TEXT NOT NULL,airtable_id TEXT UNIQUE,event_id TEXT,participant_id TEXT NOT NULL,UNIQUE(event_id,participant_id));
      CREATE TABLE IF NOT EXISTS rsvps (id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),participant_id TEXT NOT NULL REFERENCES participants(id),status TEXT NOT NULL,shift_id TEXT REFERENCES shifts(id),external_id TEXT UNIQUE,UNIQUE(event_id,participant_id));
      CREATE TABLE IF NOT EXISTS outbox (shift_id TEXT PRIMARY KEY REFERENCES shifts(id),version TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,next_attempt INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
      CREATE TABLE IF NOT EXISTS account_links (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_links_user ON account_links(user_id);
    `);
    const columns = this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'disabled'))
      this.db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
    if (!columns.some((column) => column.name === 'worker_id'))
      this.db.exec('ALTER TABLE users ADD COLUMN worker_id TEXT REFERENCES staff(id)');
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_worker_identity ON users(worker_id) WHERE worker_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS shift_updates (
        shift_id TEXT PRIMARY KEY REFERENCES shifts(id), version INTEGER NOT NULL,
        author_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shift_update_versions (
        shift_id TEXT NOT NULL REFERENCES shifts(id), version INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(shift_id,version)
      );
    `);
  }
  get<K extends keyof Entities>(table: K, id: string): Entities[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Entities[K]) : undefined;
  }
  all<K extends keyof Entities>(table: K): Entities[K][] {
    return (this.db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]).map(
      (row) => JSON.parse(row.data) as Entities[K],
    );
  }
  put<K extends keyof Entities>(table: K, entity: Entities[K]) {
    if (table === 'shifts') {
      const shift = entity as Shift;
      this.db
        .prepare(
          'INSERT INTO shifts(id,data,event_id,participant_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,event_id=excluded.event_id,participant_id=excluded.participant_id',
        )
        .run(shift.id, JSON.stringify(shift), shift.eventId, shift.participantId);
    } else if (table === 'participants' || table === 'events') {
      const linked = entity as Participant | EventRecord;
      this.db
        .prepare(
          `INSERT INTO ${table}(id,data,airtable_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,airtable_id=excluded.airtable_id`,
        )
        .run(entity.id, JSON.stringify(entity), linked.airtableId ?? null);
    } else {
      this.db
        .prepare(
          'INSERT INTO staff(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(entity.id, JSON.stringify(entity));
    }
  }
  byAirtable<K extends 'participants' | 'events'>(
    table: K,
    airtableId: string,
  ): Entities[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE airtable_id=?`).get(airtableId) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Entities[K]) : undefined;
  }
  getUser(id: string): StoredUser | undefined {
    return this.userFromRow(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
  }
  findUser(email: string): StoredUser | undefined {
    return this.userFromRow(this.db.prepare('SELECT * FROM users WHERE email=?').get(email));
  }
  private userFromRow(row: unknown): StoredUser | undefined {
    if (!row) return undefined;
    const r = row as Record<string, string>;
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role as User['role'],
      passwordHash: r.password_hash,
      participantIds: JSON.parse(r.participant_ids),
      ...(r.worker_id ? { workerId: r.worker_id } : {}),
      disabled: Boolean(r.disabled),
    };
  }
  putUser(user: StoredUser) {
    this.db
      .prepare(
        'INSERT INTO users(id,email,name,role,password_hash,participant_ids,disabled,worker_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,role=excluded.role,password_hash=excluded.password_hash,participant_ids=excluded.participant_ids,disabled=excluded.disabled,worker_id=excluded.worker_id',
      )
      .run(
        user.id,
        user.email,
        user.name,
        user.role,
        user.passwordHash,
        JSON.stringify(user.participantIds),
        user.disabled ? 1 : 0,
        user.workerId ?? null,
      );
  }
  meta(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
