import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../db.js';
import { backupDatabase } from '../backup.js';
import { hashPassword, tokenHash } from '../auth.js';
import { newShift, saveShift } from '../domain.js';

test('online backup restores users, explicit grants, sessions and pending sync from an open WAL database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtm-backup-'));
  const source = join(dir, 'source.sqlite'),
    target = join(dir, 'backup.sqlite');
  const db = new Store(source);
  let restored: Store | undefined;
  try {
    db.put('participants', {
      id: 'p',
      name: 'Fictional Person',
      supportType: 'both',
      initials: 'FP',
      color: 'green',
      notes: '',
    });
    db.putUser({
      id: 'u',
      email: 'client@example.test',
      name: 'Client',
      role: 'client',
      participantIds: ['p'],
      passwordHash: hashPassword('FictionalPassword!42'),
    });
    db.db
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(tokenHash('session'), 'u', Date.now() + 60_000);
    const shift = newShift(
      {
        participantId: 'p',
        start: '2026-11-01T00:00:00Z',
        end: '2026-11-01T02:00:00Z',
        description: 'Community support',
        location: '',
        notes: '',
        kind: 'general',
        driving: 'required',
        gender: 'no_preference',
      },
      'client',
      true,
    );
    db.transaction(() => saveShift(db, shift, true));
    await backupDatabase(source, target);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    restored = new Store(target);
    assert.deepEqual(restored.getUser('u')?.participantIds, ['p']);
    assert.equal(restored.get('shifts', shift.id)?.syncStatus, 'pending');
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n, 1);
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n, 1);
    restored.close();
    restored = undefined;
    const before = readFileSync(target);
    await assert.rejects(backupDatabase(source, target), /EEXIST/);
    assert.deepEqual(readFileSync(target), before);
    await assert.rejects(backupDatabase(source, source), /different backup path/);
  } finally {
    restored?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
